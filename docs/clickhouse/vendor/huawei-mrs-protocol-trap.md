---
title: 华为 MRS 的连接协议陷阱：内存涨到 60G，根因不在内存
---

# 华为 MRS 的连接协议陷阱：内存涨到 60G，根因不在内存

最近，有客户在用 clickhouse_sinker 时遇到了一个比较奇怪的内存泄漏现象。

clickhouse_sinker 是一个开源的、把 Kafka 数据写进 ClickHouse 的高性能组件，Go 写的。我们靠它已经帮上百家客户把数据落到了 ClickHouse 里，其中不乏日增数十 TB 的大客户。

这个客户反馈，sinker 运行时内存占用特别高，跑两个小时，内存能占到 60G 以上。可客户的日增数据也就 1 亿条左右，量并不大。所以我们判断，极大可能是出现了内存泄漏。

## 是不是我们的定制代码

客户采购了全套的华为 MRS。为了适配 MRS 的 kerberos 安全认证，我们给客户单独定制开发了 sinker 的部分功能。sinker 在别的客户生产环境上都跑得很稳，所以第一个怀疑对象，就是这些定制的功能。

那为了适配 kerberos，我们改了什么呢？ClickHouse 官方文档关于 kerberos 是这么说的：

> Currently, Kerberos can only be used as an external authenticator for existing users, which are defined in `users.xml` or in local access control paths. Those users may only use HTTP requests and must be able to authenticate using GSS-SPNEGO mechanism.

简而言之，就是只支持 HTTP 协议。我们实际适配的时候也是这样，用 TCP 协议连接失败，用 HTTP 协议能正常连上。所以专门适配了 HTTP 协议，在此之前 sinker 只支持 TCP。

既然确定是内存泄漏，那就直接上手段，pprof 走起。

<!-- TODO: 放 pprof 内存图 -->

内存主要占在 Int64 和 String 类型的编码上（`protoColStrEncodeColumn`）。难道真是 HTTP 协议引起的？

于是我在自己的开发环境造了 1 亿条数据，用 HTTP 协议测，内存从头到尾都没超过 200M。

<!-- TODO: 放本地测试的内存曲线 -->

似乎和 HTTP 协议本身关系也不大？唯一的区别是，我测试用的是 Intel 的 x86_64 服务器，客户环境是华为的 KylinV10 aarch64。

和华为的服务器有关？可我们另一个客户，好几年前就在华为 KylinV10 aarch64 上跑了大量 sinker 实例，一直很稳定，从来没出过问题。唯一的区别是他们没开 kerberos，走的 TCP。

现在似乎进了死胡同。难道说，这是一个在华为系统上、用 HTTP 协议才会触发的问题？

这也太离离原上谱了。

## 遇事不决，AI 解决

好在都 2025 年了，遇事不决，AI 解决。我把内存图和 clickhouse-go 的相关代码喂给了 DeepSeek，它的回答里最关键的是这一段：

> ARM 架构（尤其是华为鲲鹏处理器）有两个特性可能导致问题：第一是弱内存序模型（weak memory ordering）需要更严格的内存屏障，第二是更大的 cache line（128 字节 vs x86 的 64 字节）导致伪共享（false sharing）风险更高。……当前的 append 操作在 ARM 下可能反复触发全量拷贝，因为 golang 的 slice 扩容策略在 ARM 大 cache line 环境下更容易产生内存碎片。

DeepSeek 的解释有点偏底层硬件了。大意是华为 ARM 服务器因为弱内存序和大页，Go 程序 GC 不及时，批量并发写入时内存堆积着释放不掉，并不是代码缺陷导致的真正的内存泄漏。优化方向两点：HTTP 连接池，变量复用别重复申请内存。

但到底是不是它说的这么玄乎，咱也吃不准。为了保险起见，我去社区提了个 [issue](https://github.com/ClickHouse/clickhouse-go/issues/1637) 问 clickhouse-go 的开发人员，很快得到了回复。这老哥的意思是，TCP 协议他能确定用了变量复用，HTTP 协议他也不太吃得准。

得，又是死胡同。

## 三条路，堵了两条

现在摆在面前的路有三条：联系华为厂商做硬件层面的优化；关掉 kerberos 认证，改用 TCP 连接；按大模型给的建议，优化 clickhouse-go 的驱动代码。

可火烧眉毛的事，指望改代码、提交社区、等审核合并，这条路周期太长。有人问为什么不先自己改了用着，不提交社区？这就不得不提 Go 操蛋的依赖包管理了，直接从 GitHub 拉代码的弊端就是，但凡路径变了，module 就得跟着变，牵一发动全身，麻烦得要死。

而华为那边告诉我们，ClickHouse 的 kerberos 认证不能单独关闭（Kafka 能单独关，不知道为啥 ClickHouse 不行），这条路也不通。

## 天无绝人之路

好在天无绝人之路，和华为沟通的过程中，我们竟然得到了一个意外收获：华为 MRS 的 ClickHouse 虽然用了 kerberos 认证，但仍然可以用 TCP 协议连接。

话虽如此，事情进展并不顺利。之前说过，我们用 TCP 连过华为的 ClickHouse，就是连不上。一开始我们以为和安全认证有关，毕竟另一个没开 kerberos 的客户那边，TCP 是能正常连的。

华为的同学甚至贴心地给了一段 Java 连接 ClickHouse 的示例代码（华为 MRS 官网上也能找到类似的）：

```java
public void initConnection() throws IOException {
    Properties properties = new Properties();
    String proPath = System.getProperty("user.dir") + File.separator + "conf"
            + File.separator + "clickhouse-example.properties";
    try {
        properties.load(new FileInputStream(proPath));
    } catch (IOException e) {
        LOG.error("Failed to load properties file.");
        throw e;
    }
    String UriList = properties.getProperty("native.dataSource.ip.List");
    // 是否在初始化连接时检测连接可用
    properties.put("is_check_connection", "true");
    balancedClickhouseDataSource = new BalancedClickhouseDataSource(JDBC_PREFIX + UriList, properties)
            // 后台定时检测连接是否可用，维护一个可用连接的 list，每 30s 检测一次
            .scheduleActualization(30, TimeUnit.SECONDS);
}
```

但是吧。

且不说这段逻辑能不能无缝搬到 Go 的 SDK 上，关键是从头到尾都看不到任何和安全认证相关的代码。我们一起研究了好久，对接的华为同学不负责这块开发，也说不清楚其中的逻辑。

后来来了一位开发大佬，几句话就讲明白了。华为的 kerberos 认证是在服务端做的，客户端根本没有 kerberos 认证，正常连就行。那为什么连不上？因为在较新的版本里，华为 MRS 的 ClickHouse 改了连接协议，用开源的客户端走 TCP 就是连不上，HTTP 不受影响。要让开源客户端能连，得在服务端打开一个对接开源 ClickHouse 的开关（见文末华为的文档），再重启集群。

这一点太坑了。正是因为它，我们才误以为「开了 kerberos 就只能走 HTTP」：官方文档说 kerberos 只支持 HTTP，实测 TCP 也确实连不上，两件事都是真的，凑在一起推出来的因果却是错的。

开关打开、集群重启以后，sinker 改回 TCP 连接，内存就正常了，问题顺利解决。不得不说，华为的同学相当给力，客户协调资源也很积极，才能这么快把问题搞定。

至于 clickhouse-go 用 HTTP 协议批量写入时的内存问题，到现在也没有结论，只能等后续慢慢优化了。在那之前，ARM 环境上用 clickhouse-go 批量写入，我建议走 TCP。

---

**参考**

- [Kerberos | ClickHouse Docs](https://clickhouse.com/docs/operations/external-authenticators/kerberos)
- [建立 ClickHouse 连接 - 华为云 MRS 开发指南](https://support.huaweicloud.com/devg-lts-mrs/mrs_07_480014.html)
- [配置 ClickHouse 对接开源 ClickHouse - 华为云 MRS](https://support.huaweicloud.com/cmpntguide-lts-mrs/mrs_01_249294.html)

**相关**：[版本升级避坑清单](/clickhouse/upgrade-gotchas) · [托管版差异](/clickhouse/vendor/)
