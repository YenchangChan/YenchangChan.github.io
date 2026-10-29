---
title: ReplacingMergeTree 去重的坑：单机 demo 好使，上集群是另一回事
---

# ReplacingMergeTree 去重的坑：单机 demo 好使，上集群是另一回事

最早用 ReplacingMergeTree 是在单机上。需求很普通：同一个业务 key 会反复写入，查询时只要最新那条。把表引擎换成 ReplacingMergeTree，查询带上 `FINAL`，重复数据没了。当时觉得，去重这事算是解决了。

这个认知在单机上没毛病，demo 跑到这一步也确实可以收工。是后来上了集群，麻烦接二连三地来，才回过味来：单机 demo 里那些默认成立的条件，没有一个是白给的。

## FINAL 不是免费的

`FINAL` 会在查询时把涉及的所有 part 在内存里做一次 merge，等于把后台 merge 的活搬到了查询路径上。数据量小无所谓，单个分区到了上千万、上亿行，一次 `FINAL` 的延迟和资源消耗都会明显上去。

这个代价具体多大、能怎么压，我在 [FINAL 那篇](/clickhouse/deep-dive/final-query)里用 opensky 数据集实测过，这里不重复。要记的是：用了 ReplacingMergeTree，`FINAL` 的开销就是常态，不是偶发。

## 去重认的是 ORDER BY

官方文档里有一句说得很明白：merge 的时候，ReplacingMergeTree 用 `ORDER BY` 列的值当唯一标识来识别重复行（"using the values of the `ORDER BY` columns as a unique identifier"）。

很多人以为去重按 `PRIMARY KEY` 走，其实两者等价只是因为 `PRIMARY KEY` 默认等于 `ORDER BY`。一旦显式把它俩设成不一样，去重跟着 `ORDER BY` 走，`PRIMARY KEY` 只是个索引。

## merge 等不来

单机 demo 里还有一个隐含假设：merge 总会发生，数据总会被去重。

实际上 merge 是后台异步、择优触发的，最后一个 part 可能永远不再参与 merge。官方文档的措辞比「不可靠」严厉得多：它只提供 eventual correctness，不保证行会被去重，you should not rely on it。

所以查询侧的 `FINAL` 不是性能选项，是**正确性需求**。不想加 `FINAL`，就得用 `GROUP BY` 加 `argMax` 之类的写法，自己在查询侧把去重语义实现一遍，反正绕不开。

## 上了集群，条件一个个失效

单机 demo 能把去重做「对」，是因为三个条件同时凑齐了：同一个 key 的所有版本都在一个节点上，在一个分区里，而且 merge 会发生。这三个条件合起来，去重才是完整的。

集群环境里，第一个没的就是「一个节点」。

## 同一个 key 得落在同一个分片

同一个 key 的不同版本写到了不同分片，每个分片各自 merge，两边永远碰不到面，重就永远去不掉。所以 sharding 键只有一条要求：**同一 `ORDER BY` key 的所有写入，必须路由到同一分片**。

## 扩缩容之后要 resharding

分片数一变，路由结果跟着变。不做 resharding 的话，同一个 key 的历史数据留在旧分片，新写入去了新分片，两个分片各存着一份「最新值」，查出来就错乱了。所以用了 ReplacingMergeTree 的集群，扩缩容必须按 `ORDER BY` key 把数据重新分布一遍，这不是可选项。

## 跨分区合并不了

merge 严格在分区内部进行，`FINAL` 也一样，不跨分区。

拿告警数据举例。告警表按天分区，23:58 产生一条告警，写入一条记录；次日 00:08 告警恢复，再写入一条恢复记录。两条记录落在相邻两天的分区里，在 ClickHouse 看来就是两条互不相干的记录，等到天荒地老也合并不了。

那怎么办？

最省事的是改分区键，让同一个 key 天然落在同一个分区：按告警 ID 哈希分区，按告警 ID 加月份分区，或者干脆按月分区。从表结构上让「同一 `ORDER BY` key 进同一分区」成立，比事后补救便宜得多。分区键的设计目标和 sharding 键是一样的，都是把同一个 key 的所有版本圈在去重能生效的范围里。

改不动分区键的，可以向同一分区补写一条更高版本的数据，靠 merge 或 `FINAL` 把旧记录盖掉。前提是这条补写的数据也得正确 sharding，不然又写到别的分片去了；而且要配版本列，「谁赢」才可控，版本列的事下面单独说。

还有一个办法是原地 update，`ALTER ... UPDATE` 走 mutation。这条路能不走就不走：mutation 不是行级更新，它重写整个 part，还是异步执行的。更绕的是 mutation 不改变版本列的值，如果「mutation 改过的旧行」和「新 insert 的行」混着来，merge 按版本比大小，结果可能跟直觉相反。

## 写入走分布式表还是本地表

sharding 键定了，写入怎么落地？两条路都不完美。

写分布式表，在 `Distributed` 引擎的第四个参数里指定 sharding key，让 ClickHouse 自己转发。技术上可行，但代价有三样：写放大，数据先落本地目录，再异步转发到目标分片，网络上多一份传输；延迟可见，异步转发意味着写完不能立刻查到；静默失败，转发失败会不断重试，错误不直接暴露给写入方，监控不到位的话，数据「丢了」都没人知道。

写本地表，客户端自己算分片、自己路由。写放大和延迟可见都没了，但 sharding 策略得自己维护：分片拓扑变化、扩缩容 resharding、写入均衡，全成了应用侧的责任。

第二条路做得完整的开源实现不多。我翻 clickhouse_sinker 源码的时候，发现它的本地表直写方案做得比较完整，值得拆开看看。

先看连接池（`pool/conn.go`），它是按 shard 组织的，不是按节点。配置里的 `Hosts` 是二维数组，每个 shard 一组副本，连接池为每个 shard 维护一条连接，在 shard 内部对多个副本轮询挑健康节点（代码里叫 `NextGoodReplica`）。每个 shard 还带一个健康状态机：写失败就标记不可用，后台每 60 秒探测一次，恢复后自动加回路由。

再看 sharding 键和去重键的对齐（`output/clickhouse.go`），这个是代码强制的，不靠人肉。任务没显式配置 `shardingKey` 的时候，sinker 会查目标表的引擎，发现是 `Replacing*` 系列，就从 `system.columns` 读出所有 `is_in_sorting_key = 1` 的列作为 sorting key，然后自动执行 `ALTER TABLE ... ADD COLUMN __shardingkey Int64`。写入时把 sorting key 各列的值拼起来做 xxhash，写进 `__shardingkey` 列，按它选分片。「同一 `ORDER BY` key 进同一分片」这条不变量，是代码保证的，不是约定。

分片算法本身（`task/sharding.go`）支持两种显式配置：字符串列走 xxhash 取模；数值列支持 stripe 分桶，`(val / stripe) % shards`，同一个 stripe 窗口内的相邻值落在同一分片，适合需要保序或者局部性的场景。另外还有 `__offset__`（Kafka offset）兜底。

最后是故障重路由的边界。`skipUnavailableShards` 这个开关只允许没配 `shardingKey` 的任务，在目标 shard 挂掉时把 batch 重路由到其他健康 shard；带了 `shardingKey` 的任务严格禁止 reroute，宁可原地重试等着，也不把数据写到错误的分片上。这个取舍，是把去重边界放在了可用性前面。

## 副本之间进度也不同步

`ReplicatedReplacingMergeTree` 的各副本独立做 merge，进度不同步。同一时刻查不同副本，去重结果可能不一样。`FINAL` 也只能 merge 当前节点当前已有的 part，副本间的差异它救不了。

所以实践上，写入和查询尽量固定走同一个副本，或者接受短暂的不一致窗口。跨副本的负载均衡读不要做，除非确定业务能容忍。

如果业务就是「写完立刻要读到，而且可能读到任意副本」，可以开 quorum 写入。写侧设 `insert_quorum >= 2`，INSERT 会阻塞到数据成功复制到 quorum 数量的副本才返回；22.9 起还可以设 `insert_quorum = 'auto'`，自动取多数派（副本数除以二再加一）。读侧配 `select_sequential_consistency = 1`，只读 quorum 已确认的数据，查询落到数据不全的副本上直接报异常，不会读到还没复制过来的半提交状态。

这套配置有几个会咬人的地方。

顺序一致读和并行 quorum 写是互斥的，而且没人提醒你。`select_sequential_consistency` 要求关掉 `insert_quorum_parallel` 才生效，而 21.1 起 `insert_quorum_parallel` 默认是开的。也就是说 21.1 之后的版本上只设 `select_sequential_consistency = 1`，它什么都不做，也不报错，设置定义里（`src/Core/Settings.cpp`）的原话是 "does not work"。真把并行关了，就轮到写侧难受：同一张表同时只允许一个 quorum 写入在飞，上一个没完成，下一个 INSERT 直接报异常。

可用性也被副本数反过来绑死。写入时存活副本少于 quorum 值，INSERT 直接失败。两副本的集群配 `insert_quorum = 2`，挂一个副本整张表就写不进去了，比不开 quorum 还脆；`'auto'` 的多数派语义要三副本才有意义，挂一个还能写。

超时和失败语义也得知道。`insert_quorum_timeout` 默认 600000 毫秒，一次 quorum 写入最坏要卡上十分钟才报错。超时算写失败，ClickHouse 会把已经写进部分副本的块删掉，客户端负责重试。重试同一份数据是安全的，副本表按块做插入去重。

最后要分清一层：quorum 解决的是「写完立刻能读到」，不是去重进度。merge 还是各副本各做各的，quorum 管不着。一致性和去重是两层问题。

代价是写吞吐明显下降，每次写入都要等副本间同步。quorum 写入适合一致性敏感、写入量不大的表，不适合高吞吐的日志流。大多数场景的现实选择，还是固定副本读写，接受 merge 进度差。

## 版本列是正确性的另一半

ReplacingMergeTree 可以带一个可选的版本列：

```
ENGINE = ReplacingMergeTree(ver)
```

指定了 `ver`（类型只能是 `UInt*`、`Date`、`DateTime`、`DateTime64`），merge 保留版本最大的行，版本相同保留最后插入的。不指定 `ver`，只保留「最后插入」的行。

单机时代「最后插入」还算靠谱，集群里就完全是另一回事。分布式写入会乱序、会重试，谁后到谁赢，而这个「后到」和业务时间毫无关系，一次重试就能让旧数据把新数据盖掉。所以集群加上乱序、重试的场景，`ver` 列**几乎是必需的**，一般拿业务时间戳当版本，比如告警的更新时间、记录的版本号。有了 `ver`，前面说的「补写同分区数据覆盖」才真正可控。

## 顺带一个删除语义

23.2 起 ReplacingMergeTree 支持第二个可选参数 `is_deleted`（UInt8，1 表示删除），它必须和 `ver` 一起用，而且版本必须一直递增：

```
ENGINE = ReplacingMergeTree(ver, is_deleted)
```

对告警恢复这类有终态的场景，这是更干净的建模方式：恢复时直接写一条 `is_deleted=1` 的更高版本，不用在表里留一行「已恢复」占位。

但「标了删除」不等于「删了」。默认情况下每个 key 的最后一条删除标记也会留在表里，为了压住后到的旧版本数据，只有 cleanup 机制才会真正从盘上删掉。23.3 起可以配 `clean_deleted_rows = 'Always'` 让后台 merge 顺手清掉，或者手动 `OPTIMIZE TABLE ... FINAL CLEANUP`。再往后这个设置被废弃了，现在走实验性的 `allow_experimental_replacing_merge_with_cleanup`，配 `min_age_to_force_merge_seconds` 那一组 force merge 设置自动清，手动清理仍然是 `OPTIMIZE ... FINAL CLEANUP`。当前 master 的 `MergeTreeSettings.cpp` 里，`clean_deleted_rows` 已经标记为 obsolete。

这个功能从 23.2 到现在行为一直在变，用之前在自己的版本上验一遍。

## 最后

ClickHouse 的去重能力不是白送的。选定 ReplacingMergeTree 的那一刻，就同时签下了这些义务：查询必须带 `FINAL`，或者在查询侧自己去重；分区键要保证同一 `ORDER BY` key 落在同一分区；sharding 键要保证同一 key 落在同一分片；版本列要用业务时间戳定义「谁最新」，不能靠插入顺序；扩缩容要按 `ORDER BY` key resharding；副本读写尽量固定，容忍或者绕开 merge 进度差。

这些都要在建表和集群设计之初就想清楚，事后再补任何一条，都是伤筋动骨的改造。去重在 ClickHouse 里从来不是一个引擎参数的事，是一套从分区键、sharding 键到版本列的配套设计。单机 demo 之所以看起来简单，是因为这些配套在单机上全都默认成立。

---

**相关**：[FINAL 查询为什么慢：两种提速办法，各自会把结果改错](/clickhouse/deep-dive/final-query) · [同一条 SQL 每次查出来不一样：先看它是怎么变的](/clickhouse/deep-dive/inconsistent-query-results) · [Too many parts：merge 追不上写入的时候](/clickhouse/deep-dive/too-many-parts)
