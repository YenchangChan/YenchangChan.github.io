---
title: znode 爆炸：根子在 ClickHouse 的后台线程池
---

# znode 爆炸：根子在 ClickHouse 的后台线程池

这是一个 16 节点、8 分片、400 张表、日增 20TB 的 ClickHouse 23.8 集群。一次 ZooKeeper 扩容重启之后，znode 冲到了 2700 万。这篇按事故的先后顺序写，里面有一条我远程给错的建议。四个月后它换了个地方又积压了一次，那次我参数改对了，地方改错了，三个月后才发现。

客户信息脱敏了，节点数、表数、数据量、znode 数字和时间线都是原样。

## 一次扩容把集群搞崩了

先交代一下环境：ClickHouse `23.8.9.54`，16 节点、8 分片、400 张表，日增 20TB，机器是 128 核；协调服务是 3 节点的 ZooKeeper；上游是 Kafka，只保留 3 天。

ZK 早就扛不住了，客户决定把它从 3 节点扩到 5 节点，扩容得重启。

2024-03-28 晚上重启。ClickHouse 和 ZK 之间的会话大面积断开，紧接着出了三件事：大量表变成只读，因为会话丢了，复制表写不进去；写入报 Too many parts；有些表的 part 堆到了几十万。

znode 冲到 2700 万，主要涨在各个副本的 `/parts` 下面。这个路径的意思很直接，每个副本的每个 active part 在 ZK 里都有一个 znode，part 堆了多少，znode 就跟着涨多少，再乘上副本数。

Kafka 只保留 3 天，这个倒计时也从这会儿开始了。

## 我远程给的两个建议，一对一错

2024-03-29 上午，我远程看了一下现场，给了两个建议。

对的那个是掐断上游写入，让 merge 追平。Too many parts 说到底就是 part 产生得比 merge 消化得快，写入不停，merge 就永远在后面追，先停写，part 数才有机会降下来。数据还在 Kafka 里，停写不丢数据，前提是 3 天之内恢复。

错的那个，是对 part 多的表跑 `OPTIMIZE TABLE ... FINAL`。

我当时的想法是，part 太多，那就主动合并呗。可我把要优化的东西搞反了。Too many parts 看的是 active part 的数量，要降数量，最快的是大量小 merge 并行跑，每个 merge 把几个小 part 合成一个，几十个同时跑，数量掉得最快。`OPTIMIZE ... FINAL` 却是把一个分区里所有的 part 合成一个，在 part 堆到几十万的表上，这就是一个巨型 merge，一跑几个小时。偏偏它和普通 merge 用的是同一个后台池，当时 `background_pool_size` 是 16，并发额度本来就不多，几个 FINAL 把槽位一占，一大堆本来很快就能做完的小 merge 反而排不上队。

等于是把一个需要大量小任务并发去解决的问题，弄成了几个长任务把并发占满的局面。复制表上的 `OPTIMIZE` 还会写进复制日志，让每个副本都去做一遍，ZK 的负担又重了一层。

ClickHouse 官方文档里其实专门有这么一句：*OPTIMIZE can't fix the Too many parts error*。我当时没往这句话上去想。

雪上加霜的是，2024-03-30 晚上，客户等不及，把写入恢复了。这也能理解，从 3-28 晚上算起，Kafka 的 3 天保留期快到了，再不写数据就没了。数据是保住了，现场却更糟了：merge 还没追平，写入又压上来，池子里还占着 FINAL。

## 到了现场

2024-03-31 我到了现场。

客户的思路是 ZK 扛不住就加强 ZK，这次扩容本身就是这么来的。我换了个方向，不去加强 ZK，去掐 ZK 负载的来源。

ZK 上的 2700 万 znode 不是 ZK 自己长出来的，是 part 堆积映射过去的。part 为什么堆积？因为 merge 跟不上。merge 为什么跟不上？去看后台池：合并任务数顶在池子上限，可机器是 128 核，CPU 很闲。

池子满了，CPU 却闲着，那就不是缺算力，是缺并发额度。于是把 `background_pool_size` 从 16 调到 64，128 核的机器，这点余量是够的。23.8 上 merge 和 mutation 池实际能调度的任务数是 `background_pool_size × background_merges_mutations_concurrency_ratio`（默认 2），所以这一下把并发额度从 32 提到了 128。

merge 开始追平，part 数往下走，`/parts` 下的 znode 也跟着往下走，从 2700 万降到 700 万。到 2024-04-03 收尾，从重启那天算起，前后 7 天。

## 四个月后，瓶颈挪到了 fetch

2024 年 8 月初，复制队列开始积压。

这次涨的不是 `/parts`，是 `/queue`，也就是副本的复制队列。每个副本要从别的副本拉的 part，都先作为一条任务挂在自己的 queue 下面。queue 积压，就是副本之间同步跟不上了。

2024-08-08 查了一下 `system.replication_queue`：

```sql
SELECT create_time, type, num_postponed, postpone_reason
FROM system.replication_queue
WHERE table = '<table>'
ORDER BY create_time;
```

8 月 2 日以来进队的几乎全是 `GET_PART`，`num_postponed` 都在 400 以上，每条任务已经被推迟了四百多次。`postpone_reason` 清一色是同一句：

```
Not executing fetch of part <part_name> because 8 fetches already executing, max 8.
```

fetch 线程池满了，上限是 8。

看来第一次只是把瓶颈从 merge 挪到了 fetch。merge 池调到 64 以后，本地 merge 跑得动了，可副本之间拉 part 的池子还是默认大小，写入量一大，拉取跟不上，queue 就堆起来了。

判断的依据和第一次一样，fetch 池满了，CPU 闲着，还是并发度的问题，那就调 `background_fetches_pool_size`。

我按老习惯，把它改在了 `users.xml` 的 profile 里。改完没报错，我也没回头去看运行中的值。

## 三个月后，改了不生效

2024-11-05，znode 涨到了 1600 万，涨的还是 `/queue`。

8 月改的那个参数，三个月里压根没起作用。

这时候最自然的问题是，为什么改了不生效？可这个问题太开放了，往哪个方向挖都行。我换了一个能直接查的问题：它到底生效了没有？

ClickHouse 的设置散在三张表里，`system.settings`、`system.server_settings`、`system.merge_tree_settings`。我当时也不确定这个参数归哪张表管，干脆三张都查了。结果运行中的值还是 8。

翻 changelog、读源码，答案在这个参数的历史里：

| 版本 | 变化 |
|---|---|
| 20.12 | 引入 `background_fetches_pool_size`，fetch 从 merge 池中独立出来，默认 3 |
| 21.2 | 默认值改为 8 |
| 22.5 | 从用户级配置（`users.xml` 的 profile）提升为服务端全局配置（`config.xml`） |
| 23.11 | 默认值改为 16 |

集群是 23.8，写在 profile 里的这个值不报错，就是不生效。

改到 `config.xml` 里，fetch 池放开了，queue 开始消化，两三天时间，znode 从 1600 万降到了 300 万。第二次故障到 2024-11-12 收尾，前后 8 天。

回头看 8 月那次，判断是对的，参数也找对了，问题出在改完没验证。但凡当时去 `system.server_settings` 看一眼运行中的值，这个问题 8 月就该关掉了，也不会拖到 11 月涨成 1600 万。

顺便说一句，网上还有资料说用 `replicated_max_parallel_fetches` 控制 fetch 并发。这个参数 21.10 以后就废弃了，能设，没效果，是同一类坑。

## 后来

再后来，第三个客户，就是那个 PB 级数据量的大客户，碰上了同样的问题。这次照着同样的路子走：先看池子满不满、CPU 闲不闲，再看是哪个池子，最后确认参数改在了真正生效的地方。一晚上就处理完了。

一次是个案，三次就是规律了。于是我们把它做进了 ckman 3.0.10。一是合并指标，正在跑的每个 merge 都列出来，表、节点、耗时、进度、内存、参与合并的 part 数、合并前后的 part 名，一个跑了几个小时的 FINAL，在这儿一眼就能看到。二是线程池监控，每个节点的合并、副本拉取、调度、Move、公共线程池，各自用了多少、上限多少，fetch 池顶在 8/8、merge 池顶满而 CPU 空闲这种状态，不用再自己去查 `system.metrics`。三是按版本决定配置写在哪，同一个参数在这个版本该写 `users.xml` 还是 `config.xml`，由 ckman 按集群版本来定，不再指望操作的人记得住。

## 最后

如果当时有线程池监控，那个错误的建议不会持续那么久。`OPTIMIZE FINAL` 的问题在线程池视图里是个很显眼的画面：merge 池被少数几个长任务占满，进度条半天不动。我那会儿是远程给的建议，看不到这个画面，只能凭判断，而那个判断是错的。

两次都是池子满、CPU 闲，两次的解法都是扩池子，只是扩的池子不一样。另外，改参数不生效的时候，先问它到底生效了没有，更好的是改完马上就去看。ClickHouse 的参数会跨版本搬家，写在老位置不报错，这条后来我也写进了 [Field Notes](/notes/)。

这次和 [126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks) 看着是一类现象，机制却完全不同。那次是默认值变了，`async_blocks` 一直在生产节点；这次的 znode 是 part 积压和复制队列积压在 ZK 上的映射，ZK 上看到的问题，根子在 ClickHouse 的后台线程池。

---

**相关**：[生产排障](/clickhouse/troubleshooting/) · [Too many parts：merge 追不上写入的时候](/clickhouse/deep-dive/too-many-parts) · [同一条 SQL 每次查出来不一样](/clickhouse/deep-dive/inconsistent-query-results)（副本同步延迟一节）
