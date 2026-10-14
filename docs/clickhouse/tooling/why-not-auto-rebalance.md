---
title: 扩容之后为什么不自动做数据均衡
---

# 扩容之后为什么不自动做数据均衡

「ClickHouse 扩容不会自动均衡数据，Doris 会，所以 Doris 更成熟。」这话我听过不止一次。前半句是事实，后半句我不太同意。

ClickHouse 扩容以后，老数据确实不会自己搬到新节点上。新写入的数据按新的分片规则走，老数据原地不动，集群就一直这么斜着。Doris 扩容以后，BE 之间会自动迁移 tablet，最后收敛到均衡。这两句都没毛病。可要从这里推出「Doris 更成熟」，就把两者设计上的一个根本差别给忽略了：sharding 规则到底归谁管。

## sharding 规则归谁管

Doris 的分桶规则是引擎自己管的。建表时写 `DISTRIBUTED BY HASH(k) BUCKETS n`，引擎知道 hash 函数，知道分桶数，知道每一行属于哪个 bucket。它搬数据是安全的，因为它算得出搬完以后每一行还在正确的位置上。

ClickHouse 的 sharding，很多时候是业务在写入端自己定的。拿我维护的 [clickhouse_sinker](https://github.com/housepower/clickhouse_sinker) 来说，路由规则是写入侧的配置：

```go
// 未指定 shardingKey：按 Kafka offset 均摊
shard = int(msg.Offset >> offShift) % shards

// shardingKey 是数值类型
shard = int((val64 / policy.stripe) % uint64(policy.shards))

// shardingKey 是其他类型
shard = int(xxhash64(val64) % uint64(policy.shards))
```

这三条公式都跑在 ClickHouse 外面。ClickHouse 服务端从头到尾不知道有这些规则，它只看到一批批数据落进了本地表，根本没法反推出「这一行为什么在这个节点上」。

说白了，Doris 把 sharding 收进了引擎，ClickHouse 把它留给了使用者。自动均衡能不能做，是这个选择的直接后果，跟成熟不成熟没什么关系。

## 搬了，数据就错了

最直接的例子是去重。

`ReplicatedReplacingMergeTree` 的去重只在单个分片内生效：同一个 key 的多行，只有落在同一个分片上才会被 merge 掉，分散在不同分片上的重复行，它永远不会去掉。所以用这个引擎的表，写入侧必须把去重字段设成 sharding key，保证同一个 key 永远路由到同一个节点。我在 [同一条 SQL 每次查出来不一样](/clickhouse/deep-dive/inconsistent-query-results) 里也提过这条。

现在让存储层按容量自动搬 part，同一个 key 的数据就被拆到了两个分片上，去重从此失效。同样的还有按业务 id 分片让聚合在本地完成、按 join key 分片把分布式 join 变成本地 join，搬完之后这些前提全都不成立了。

更要命的是，它错得悄无声息。搬迁不报错，写入不失败，查询照常返回。`count()` 多了一点，可谁会天天盯着 count 看？聚合结果偏了一点，可你手里也没有一个正确答案可以对。等到哪天有人发现数对不上，要回头查的是哪次扩容、搬了哪些 part、影响了哪些 key、错了多久，而一次自动完成的搬迁，通常不会给你留下这些记录。

那能不能让存储层聪明一点，先判断这张表能不能搬？做不到。存储层看得见 part、分片、磁盘占用、行数，看不见这张表的 sharding 有没有业务含义。判断要用的信息根本不在它手里，它能做的只有猜，猜错了，代价由使用者来扛。Doris 能自动做，恰恰是因为它把 sharding 规则收进了引擎，做决定要用的信息就在它自己手里。

## 能搬的，我也不自动搬

也有些表的 sharding 没有业务含义，比如 sinker 默认按 offset 均摊的那种，理论上搬它们是安全的。

我还是不把它做成自动的。数据搬迁是不可逆的，搬完没有 undo。真出了问题，运维得能说清楚搬了什么、搬到了哪、搬之前是什么样，而自动化的设计目标恰恰是让人不用知道这些。我们的客户很多是金融行业，改变数据分布的每一步操作都得可审计、可追溯，出了事得有东西可查。

还有一个很实际的问题：均衡是整个分区整个分区地搬，搬的过程中，一个分区可能已经在老节点上 detach 了，还没来得及在新节点上 attach，这时候去查，结果就会不准。所以均衡期间最好别有查询，这也是为什么它适合挑个时间由人来触发，而不是在后台随时自己跑起来。

## ckman 是怎么做的

ckman 里有数据均衡功能，扩容之后确实需要它，但它是由人触发的，不会自己跑。

它按表选策略。默认是按分区搬，整个分区作为搬迁单位，用贪心每次从占用最大的 host 往最小的 host 搬，每个 host 最新的那个分区跳过不搬，因为它还在接收写入，大小一直在变，搬它一定出问题。复制表靠 `FETCH PARTITION` 从 ZooKeeper 上拉，非复制表只能 `DETACH` 之后用 rsync 传过去再 `ATTACH`，这需要节点之间配好免密 SSH。如果当初的 sharding key 就选歪了，按分区搬只是把不均衡挪个地方，那就得用第二种策略，按分片键把每一行重新算一遍归属，这本身就是个很重的操作。具体流程我在 [2026 年 ClickHouse 和 Doris 怎么选](/clickhouse/comparison/clickhouse-vs-doris) 的数据均衡一节里写过。

两种策略都能只算不做：先告诉你这次要搬哪些分区、多少行、多少字节，你看清楚了再点执行，中途点停止也真能停下来。

这样做，决定权留在人手里。ckman 负责把做决定要用的信息摆到人面前，而人恰好知道存储层不知道的那件事：这张表的 sharding 有没有业务含义。

所以 ClickHouse 不自动均衡，我不觉得是它不成熟。一个决定所需的信息不在做决定的那一层，硬要那一层自动去做，就只能靠猜，猜错了还不报错。与其把自动化做得更聪明，不如把信息交给真正能判断的人，让他来按这个按钮。

---

**相关**：[2026 年 ClickHouse 和 Doris 怎么选](/clickhouse/comparison/clickhouse-vs-doris) · [ckman](https://github.com/housepower/ckman)
