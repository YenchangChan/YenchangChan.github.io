---
title: znode 爆炸与线程池
---

# znode 爆炸与线程池

> 16 节点 8 分片、400 张表、日增 20TB 的 ClickHouse 23.8 集群。一次 ZK 扩容重启之后，znode 冲到 **2700 万**。
>
> 这篇按事故的真实顺序写，包括**我远程给错的那条建议**。也包括四个月后它换了个地方重新积压 —— 那一次我改对了参数，却改错了地方，三个月后才发现。
>
> 两次的共同点是：**后台线程池满了，CPU 却很闲。** 这不是资源问题，是并发度问题。
>
> 客户信息已脱敏；节点数、表数、数据量、znode 数字和时间线保留。

## 一、起点：一次救火动作引爆了集群

| | |
|---|---|
| 版本 | ClickHouse `23.8.9.54` |
| 规模 | 16 节点、8 分片、400 张表，日增 20TB，128 核机器 |
| 协调服务 | ZooKeeper，3 节点 |
| 上游 | Kafka，**只保留 3 天** |

ZK 早就扛不住了。客户决定把它从 3 节点扩到 5 节点，扩容要重启。

**2024-03-28 晚上重启。** ClickHouse 和 ZK 的会话大面积中断，接着出现了三件事：

- 大量表进入只读（会话丢了，复制表不能写）
- 写入报 Too many parts
- 部分表的 part 数堆到**数十万**

znode 冲到 2700 万，主要涨在各副本的 `/parts` 下。这个路径的含义很直接：**每个副本的每个 active part 在 ZK 里都有一个 znode。** part 堆积多少，znode 就跟着涨多少，再乘上副本数。

那条 Kafka 只保留 3 天的约束从这时候开始计时。

## 二、我远程给的两个建议，一对一错

**2024-03-29 上午**，我远程看了现场，给了两个建议。

**对的那个：掐断上游写入，让 merge 追平。** Too many parts 的本质是 part 的产生速度大于 merge 的消化速度。写入不停，merge 就永远在追；先停写，才有机会把 part 数降下来。数据还在 Kafka 里，停写不丢数据 —— 只要在 3 天内恢复。

**错的那个：对 part 多的表跑 `OPTIMIZE TABLE ... FINAL`。**

我的出发点是「part 太多，那就主动合并」。但我把优化目标搞反了：

- **Too many parts 判定的是 active part 的数量。** 要降的是数量，最快的办法是大量小 merge 并行跑 —— 每个 merge 把几个小 part 合成一个，几十个 merge 同时跑，数量降得最快。
- **`OPTIMIZE ... FINAL` 把一个分区里的所有 part 合成一个。** 在 part 数堆到数十万的表上，这是一个巨型 merge，一跑就是几个小时。
- **它和普通 merge 共用同一个后台池。** 当时 `background_pool_size` 是 16，池子的并发额度有限；几个 FINAL 占住了槽位，大量本可以很快完成的小 merge 反而排不上队。

换句话说，我把「需要高并发、小任务」的问题，变成了「少数几个长任务占满并发」的局面。复制表上的 `OPTIMIZE` 还会写进复制日志，让各副本都去执行这次合并，进一步加重 ZK 负担。

（ClickHouse 官方文档里专门有一句：*OPTIMIZE can't fix the Too many parts error*。我当时没有对照这句话去想为什么。）

**第三重：2024-03-30 晚上，客户等不及，恢复了写入。** 可以理解 —— 从 3-28 晚上算起，Kafka 的 3 天保留期快到了，再不写就要丢数据。数据保住了，但现场更糟了：merge 还没追平，写入又压了上来，池子里还占着 FINAL。

## 三、到现场：把诊断降一维

**2024-03-31 我到了现场。**

客户那边的思路是「ZK 扛不住 → 加强 ZK」，扩容本身就是这个思路的产物。我换了一个方向：**不去加强 ZK，去掐 ZK 的负载来源。**

ZK 上 2700 万 znode 不是 ZK 自己长出来的，是 part 堆积的投影。part 为什么堆积？因为 merge 跟不上。merge 为什么跟不上？看后台池：

- 合并任务数顶在池子上限
- 机器是 128 核，**CPU 很闲**

池子满、CPU 闲 —— 不缺算力，缺的是并发额度。于是把 `background_pool_size` 从 **16 调到 64**。128 核的机器，这个余量是够的。

在 23.8 上，merge / mutation 池实际可调度的任务数是 `background_pool_size × background_merges_mutations_concurrency_ratio`（默认 2），所以这一步把并发额度从 32 提到了 128。

merge 开始追平，part 数下降，`/parts` 下的 znode 跟着下降：**2700 万 → 700 万。** 第一次故障到 2024-04-03 收尾，从重启算起前后 7 天。

## 四、2024 年 8 月：瓶颈挪到了 fetch

第一次收尾四个月后，**2024 年 8 月初**，复制队列开始积压。

这次涨的不是 `/parts`，是 `/queue` —— **副本的复制队列**。每个副本要从别的副本拉取的 part，都会先作为一条任务挂在自己的 queue 下。queue 积压，就是副本同步跟不上。

2024-08-08 查 `system.replication_queue`：

```sql
SELECT create_time, type, num_postponed, postpone_reason
FROM system.replication_queue
WHERE table = '<table>'
ORDER BY create_time;
```

8 月 2 日以来进队的任务几乎全是 `GET_PART`，`num_postponed` 都在 400 以上 —— 每条任务已经被推迟了四百多次。`postpone_reason` 清一色是同一句：

```
Not executing fetch of part <part_name> because 8 fetches already executing, max 8.
```

**fetch 线程池满了，上限是 8。**

这说明第一次只是把瓶颈从 merge 挪到了 fetch。merge 池调到 64 之后，本地 merge 跑得动了，但副本之间拉取 part 的池子还是默认大小；写入量一大，拉取跟不上，queue 就堆了起来。

决策依据和第一次一样：**fetch 池满，CPU 很闲** —— 还是并发度问题。那就调 `background_fetches_pool_size`。

**我按老习惯，把它改在了 `users.xml` 的 profile 里。** 改完没有报错，我也没有回头确认运行中的值。

## 五、2024 年 11 月：改了不生效

**2024-11-05**，znode 涨到了 1600 万，涨的还是 `/queue`。

8 月改过的那个参数，三个月里一直没起作用。

这时候最自然的问题是「为什么改了不生效」。但这是一个开放问题，可以往任何方向挖。我换了一个能查的问题：**它到底生效了没有？**

ClickHouse 的设置散在三张表里 —— `system.settings`、`system.server_settings`、`system.merge_tree_settings`。当时我不确定这个参数归哪张表管，三张都查了。结果是：**运行中的值还是 8。**

翻 changelog、读源码，答案是这个参数的历史：

| 版本 | 变化 |
|---|---|
| 20.12 | 引入 `background_fetches_pool_size`，fetch 从 merge 池中独立出来，默认 3 |
| 21.2 | 默认值改为 8 |
| **22.5** | **从用户级配置（`users.xml` 的 profile）提升为服务端全局配置（`config.xml`）** |
| 23.11 | 默认值改为 16 |

集群是 23.8。profile 里的这个值**不报错，只是不生效**。

改到 `config.xml`，fetch 池扩开，queue 开始消化。**两到三天，znode 从 1600 万降到 300 万。** 第二次故障 2024-11-12 收尾，前后 8 天。

::: warning
**8 月那次改动的问题不只是改错了位置，而是改完没有验证。**

改参数的动作在 8 月就做了，判断也是对的 —— 只差最后一步：去 `system.server_settings` 看一眼运行中的值。
少了这一步，一个本该在 8 月关掉的问题，拖到 11 月涨成了 1600 万。
:::

顺带一句：网上还有资料说用 `replicated_max_parallel_fetches` 控制 fetch 并发。这个参数 21.10 之后已经废弃，能设，没效果 —— 同一类陷阱。

## 六、后来

第三个客户，就是那个 PB 级数据量的大客户，遇到了同样的问题。这次照同样的打法 —— 先看池子满不满、CPU 闲不闲，再看是哪个池子，最后确认参数改在了它真正生效的位置 —— **一晚上就处理完了。**

一次是个案，三次是模式。于是把它做进了 ckman 3.0.10：

- **合并指标**：正在进行的每个 merge —— 表、节点、耗时、进度、内存、参与合并的 part 数、合并前后的 part 名。一个跑了几个小时的 FINAL，在这里一眼就能看到。
- **线程池监控**：每个节点的合并、副本拉取、调度、Move、公共线程池，各自的「已用 / 上限」。fetch 池顶在 `8/8`、merge 池顶满而 CPU 空闲，这些状态不用再去查 `system.metrics`。
- **版本感知的配置规则**：同一个参数在不同版本应该写在 `users.xml` 还是 `config.xml`，由 ckman 按集群版本决定，不再依赖操作者记得。

## 七、一条留给自己的

**如果当时有线程池监控，我不会让那个错误的建议持续那么久。**

`OPTIMIZE FINAL` 的问题，在线程池视图里是一个非常显眼的画面：merge 池被少数几个长任务占满，进度条长时间不动。我当时是远程给的建议，看不到这个画面，只能凭判断 —— 而那个判断是错的。

另外两点：

- **池子满、CPU 闲，就是并发度问题，不是资源问题。** 两次都是这个画面，两次的解法都是扩池子，只是池子不同。
- **改了不生效，先问它生效了没有；更好的是，改完就问。** ClickHouse 的参数会跨版本换位置，改在旧位置不报错。这条后来写进了 [Field Notes](/notes/)。

这起事故和 [126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks) 是同一类现象，机制完全不同：那次是默认值变更让 `async_blocks` 持续生产节点；这次 znode 是 part 积压和复制队列积压的投影 —— **ZK 只是把 ClickHouse 后台池的瓶颈照了出来。**

---

**相关**：[生产排障](/clickhouse/troubleshooting/) · [Too many parts 和 Too many partitions](/clickhouse/troubleshooting/too-many-parts-vs-partitions) · [同一条 SQL 每次查出来不一样](/clickhouse/troubleshooting/inconsistent-query-results)（副本同步延迟一节）
