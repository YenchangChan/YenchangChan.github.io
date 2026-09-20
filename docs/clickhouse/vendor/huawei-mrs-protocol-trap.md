---
title: sinker 在华为 MRS 上内存涨到 60G，最后发现和内存没关系
---

# sinker 在华为 MRS 上内存涨到 60G，最后发现和内存没关系

> 标题里的「内存泄漏」是症状，不是主角 —— 它最后**根本没被修，是被绕过去的**。
>
> 真正的故事是一个被**错误归因了三次**的连接协议问题，而病根藏在一个没有文档的服务端开关里。

## 现象

客户反馈 clickhouse_sinker 运行时内存占用特别高，**运行两小时，内存占到近 60G 以上**。

而客户的日增数据只有 1 亿条左右，这并不是一个很大的量。所以第一判断：**极大可能是内存泄漏。**

## 第一层归因：是不是我们的定制化代码？

客户采购了全套华为 MRS。为了适配 MRS 的 kerberos 安全认证，我们给客户单独定制开发了 sinker 的部分功能。

而 sinker 在其他客户生产环境上都运行稳定 —— 所以怀疑是定制化功能引入的问题。

**为了适配 kerberos，我们改了什么？** ClickHouse 官方文档是这么说的：

> Currently, Kerberos can only be used as an external authenticator for existing users... Those users **may only use HTTP requests** and must be able to authenticate using GSS-SPNEGO mechanism.

简而言之：**仅支持 HTTP 协议**。而我们实际适配时，**通过 TCP 协议连接失败，通过 HTTP 协议则能正常连接**。

所以我们专门适配了 HTTP 协议 —— 在此之前 **sinker 只支持 TCP**。

::: tip 记住这两个事实
1. 官方文档说 kerberos 只支持 HTTP
2. 实测 TCP 确实连不上

**两条都是真的。但它们合起来推出的因果是错的。** 这一点要到最后才会揭晓。
:::

## 第二层归因：是不是 HTTP 协议本身的问题？

既然确定是内存泄漏，直接上 pprof。

<!-- TODO: 放 pprof 火焰图 -->

内存主要占用在 **Int64 和 String 类型的编码**上（`protoColStrEncodeColumn`）。难道真的是 HTTP 协议引起的？

于是在自己的开发环境造了 1 亿条数据，**用 HTTP 协议测试 —— 内存占用自始至终没有超过 200M。**

<!-- TODO: 放本地测试的内存曲线 -->

似乎和 HTTP 协议本身关系也不大。

**唯一的区别是：我测试用的是 Intel x86_64 服务器，而客户环境是华为 KylinV10 aarch64。**

## 排除矩阵

和架构有关？但我们另一个客户，早在几年前就在华为 KylinV10 aarch64 上运行了大量 sinker 实例，一直很稳定，从来没出过问题 —— **唯一的区别是他们没开 kerberos，走的 TCP。**

把三个环境摆一起：

| 架构 | 协议 | kerberos | 结果 |
|---|---|:--:|---|
| x86_64 (Intel) | HTTP | 无 | ✅ 200M |
| aarch64 (KylinV10) | TCP | 无 | ✅ 稳定运行数年 |
| **aarch64 (KylinV10)** | **HTTP** | **有** | 🔴 **两小时 60G** |

**只有「ARM + HTTP」这一格会出问题。**

这也太离谱了 —— 一个在华为系统上、使用 HTTP 协议才会触发的问题？

## 问 AI，得到一个偏底层的推测

把内存图和 clickhouse-go 的相关代码喂给 DeepSeek，它给出的方向是 ARM 架构特性：

> ARM 架构（尤其是华为鲲鹏处理器）有两个特性可能导致问题：第一是**弱内存序模型**（weak memory ordering）需要更严格的内存屏障，第二是**更大的 cache line**（128 字节 vs x86 的 64 字节）导致伪共享（false sharing）风险更高。
>
> 当前的 `append` 操作在 ARM 下可能反复触发全量拷贝，因为 golang 的 slice 扩容策略在 ARM 大 cache line 环境下更容易产生内存碎片。

大意是：**华为 ARM 服务器由于弱内存序和大页的存在，导致 Go 程序 GC 不及时，批量并发写入时内存堆积得不到及时释放 —— 并不是代码缺陷造成的真正内存泄漏。**

优化方向两点：HTTP 连接池、变量复用不要重复申请内存。

::: warning 但这只是推测
到底是不是这么玄乎，咱也吃不准。**所以我没把它当结论**，去社区提了个 issue 问 clickhouse-go 的开发人员。

回复是：**TCP 协议他能确定使用了变量复用，但 HTTP 协议他也不太吃得准。**

见 [clickhouse-go #1637](https://github.com/ClickHouse/clickhouse-go/issues/1637) —— 截至目前仍未解决。
:::

## 三条路，堵了两条

1. **联系华为厂商做硬件层面优化**
2. **关闭 kerberos 认证，使用 TCP 协议**
3. **优化 clickhouse-go 驱动代码**，按大模型给的建议改

**路 3 周期太长。** 改代码、提交社区、等审核合并，火烧眉毛的事等不起。

> 有人问为什么不先改代码、不提交社区？这就不得不提 Go 操蛋的依赖包管理了 —— 从 GitHub 直接拉代码的弊端就是但凡路径变了，module 就得跟着变，**牵一发动全身**。

**路 2 也不通。** 华为那边说，ClickHouse 的 kerberos 认证**不能单独关闭**（Kafka 能单独关，不知道为什么 ClickHouse 不行）。

## 第三层归因：真相在一个没文档的开关里

但在和华为沟通的过程中，得到了一个意外收获：

> **华为 MRS 的 ClickHouse 虽然使用了 kerberos 认证，但仍然可以用 TCP 协议连接。**

话虽如此，进展并不顺利。我们之前明明试过 TCP，结果就是连不上。

华为的同学贴心地给了 Java 版的连接示例代码 —— 但从头到尾**看不到任何和安全认证相关的逻辑**。研究了很久，对接的同学不负责这块开发，也说不清楚。

后来来了一个开发大佬，几句话讲明白了：

::: danger 真正的根因
**华为的 kerberos 认证是在服务端做的，客户端根本没有 kerberos 认证。** 正常情况下，客户端按普通方式连接即可。

那为什么连不上？**因为在较新的 MRS ClickHouse 版本中，修改了连接的协议，使用开源客户端就是连不上 —— TCP 协议不行，HTTP 协议不受影响。**

要让开源客户端能连，只需要**在服务端开启一个开关**，然后重启 ClickHouse 集群。
:::

**这个点太坑了。** 正因为这个原因，我们才误认为「kerberos 认证仅 HTTP 协议才能连接」。

开关打开、集群重启之后，用 TCP 协议连接就没有问题了。问题顺利解决。

至于 clickhouse-go 在 HTTP 协议批量写入的 GC 问题，**只能待后续慢慢优化了**。

---

## 这个故事的三层归因

| 层 | 当时的判断 | 怎么被推翻 |
|---|---|---|
| ① | 是我们为 kerberos 做的定制化代码有问题 | 其他客户跑得好好的 |
| ② | 是 HTTP 协议本身的问题 | x86 上造 1 亿条测 HTTP，内存没超 200M |
| ③ | **kerberos 导致只能走 HTTP** | **kerberos 在服务端，客户端没有认证。TCP 连不上是因为新版 MRS 改了连接协议** |

**第三层才是病根，而它是被两个都为真的事实"合谋"造出来的：** 官方文档说 kerberos 只支持 HTTP，实测 TCP 也确实连不上。两条都对，推出来的因果却错了。

**而真正的原因，藏在一个没有文档的服务端开关里。**

## 留给读者的三条

1. **ARM（鲲鹏 / KylinV10）+ HTTP 协议 + clickhouse-go 批量写入 → 内存堆积。** x86 + HTTP 正常，ARM + TCP 正常，只有这个组合会触发。**规避方式：ARM 环境走 TCP。**
2. **MRS 上 kerberos 不等于只能用 HTTP。** kerberos 在服务端，客户端不需要认证。TCP 连不上是另一个原因。
3. **新版 MRS ClickHouse 改了连接协议，开源客户端 TCP 连不上，需要服务端开关。** 这一条任何文档里都没有。

---

**参考**

- [Kerberos | ClickHouse Docs](https://clickhouse.com/docs/operations/external-authenticators/kerberos)
- [建立 ClickHouse 连接 - 华为云 MRS 开发指南](https://support.huaweicloud.com/devg-lts-mrs/mrs_07_480014.html)
- [配置 ClickHouse 对接开源 ClickHouse - 华为云 MRS](https://support.huaweicloud.com/cmpntguide-lts-mrs/mrs_01_249294.html)

**相关**：[版本升级避坑清单](/clickhouse/upgrade-gotchas) · [托管版差异](/clickhouse/vendor/)
