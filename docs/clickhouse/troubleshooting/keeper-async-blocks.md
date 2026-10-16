---
title: 126 万 znode 是怎么长出来的
---

# 126 万 znode 是怎么长出来的

事情从一次例行巡检开始。一个 ClickHouse 26.3 LTS 开发集群，Keeper 监控面板上的 znode 数字很扎眼：前一天约 119 万，第二天约 126 万，24 小时涨了 6.9 万。Keeper 单节点数据量约 340 MB，平均请求延迟 165～185 ms，历史最大延迟到了 31.9～40.6 秒。

延迟已经明显不健康了。可真正让我觉得不对劲的是另一件事：这个集群的业务表并不多，从哪冒出来这么多的znode？

ReplicatedMergeTree 每张表在 Keeper 里的协调节点是有数的，`log`、`blocks`、`replicas`、`mutations` 这些加起来，一张表通常在几百到几千的量级。一个表不多的开发集群，凭什么撑起百万级的节点？要知道我们在一个 23.8 的老集群上跑着 4000 张表，从来没出过这种事。

## 先确认它真的在涨

从历史曲线来看，94 小时净增 487212，增幅 62.91%；最后一个完整 24 小时净增 68544。除了后台清理带来的一点小回落，主趋势一路向上。也就是说，当时的 120 万并没有停在某个上限附近，它还在爬坡。

那么问题来了，这些节点到底长在哪儿？

## 顺着路径挖

我首先排查了之前经常碰到的重灾区：`parts`和`/queue`， 显示都很正常，并没有特别扎眼的地方。那么，只能全面扫一遍了。

Keeper 的 znode 是树形的，思路很直接：从顶层目录一层层拆开计数，看哪一枝特别肥。

先确认看的是当前有效的 quorum：

```bash
for host in keeper-1 keeper-2 keeper-3; do
    echo "== ${host} =="
    printf 'mntr' | nc -w 3 "${host}" 9181 \
      | grep -E 'zk_server_state|zk_znode_count|zk_avg_latency|zk_max_latency|zk_outstanding_requests|zk_synced_followers|zk_approximate_data_size'
done
```

三个成员的 `zk_znode_count` 最终一致，leader 有两个同步的 follower，没问题。然后转到 ClickHouse 这边拿表路径。路径别按表名去猜，以 `system.replicas.zookeeper_path` 为准：

```sql
SELECT database, table, zookeeper_path, replica_name, is_leader, is_readonly
FROM system.replicas
ORDER BY database, table;
```

再按路径统计。`system.zookeeper` 查的是指定路径的直接子节点，版本支持 `path IN` 子查询的话，可以一次扫完本机所有复制表：

```sql
SELECT path, count() AS znodes
FROM system.zookeeper
WHERE path IN (SELECT DISTINCT concat(zookeeper_path, '/async_blocks') FROM system.replicas)
GROUP BY path
ORDER BY znodes DESC;
```

版本不接受动态 `path IN` 的，就先从 `system.replicas` 把路径导出来分批查。千万别图省事直接递归读整个 `/clickhouse` 根目录，Keeper 已经够累了，再补一刀就真趴了。

结果一目了然，约 113 万个 znode 集中在同一种路径下：

```
/clickhouse/tables/.../async_blocks
```

占了整个 Keeper 的九成左右。展开看，224 条活跃的表分片路径下 `async_blocks` 不为空，其中 69 条已经贴着 10000 这个数了。按库拆开，也很集中：

| 脱敏后的数据库 | `async_blocks` 数量 |
|---|---:|
| database_A | 约 53.6 万 |
| database_B | 约 47.4 万 |
| database_C | 约 8 万 |
| database_D | 约 4 万 |

在哪儿是找到了，可 `async_blocks` 这个目录是干嘛的？

## async_blocks 是干嘛的

这得从异步插入说起。

ClickHouse 最怕高频小 INSERT，每个 INSERT 生成一个 part，part 一多就是 merge 风暴和 Too many parts。`async_insert` 的思路是服务端先把一堆小 INSERT 攒在内存里，到了时间、大小或者条数的阈值，再统一刷成一个 part。

问题出在攒这个动作上。多个 INSERT 合成一批以后，ClickHouse 还得知道批里每一个原始 INSERT 到底执行过没有。不然就会出这种事：服务端明明已经写成功了，ACK 还没回到客户端，网络断了，客户端以为失败了，重试。没有去重记录的话，第二次 INSERT 会再写一遍，轻则多出重复行，重则物化视图的目标表、SummingMergeTree 的聚合结果被重复累加。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/async-blocks-01.light.svg" alt="客户端重试时序：服务端已写成功，ACK 未返回，客户端重试导致重复写入">
<img class="dfig-d" src="/diagrams/async-blocks-01.dark.svg" alt="客户端重试时序：服务端已写成功，ACK 未返回，客户端重试导致重复写入">
</figure>

所以 ClickHouse 给异步批次里的每一个源 INSERT 算一个去重标识，写进对应 ReplicatedMergeTree 路径下的 `async_blocks`。说白了，它就是让客户端重试变得幂等的一份索引。它不是业务数据，不是待执行的队列，也不是 part，删掉它们不会释放数据盘上一个字节。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/async-blocks-02.light.svg" alt="async_blocks 写入路径：小 INSERT 攒批成 1 个 part，每个源 INSERT 在 Keeper 写一条去重 hash">
<img class="dfig-d" src="/diagrams/async-blocks-02.dark.svg" alt="async_blocks 写入路径：小 INSERT 攒批成 1 个 part，每个源 INSERT 在 Keeper 写一条去重 hash">
</figure>

现场抽了几条看，单条 value 只有 20 字节左右。可 znode 的成本远不止 value，Keeper 还得维护节点元数据、内存索引、事务日志、快照和复制状态。每条几十字节，一百万条照样压得动 Keeper。

机制搞清楚了，新的疑问也来了：`async_blocks` 是异步插入的产物，可谁开的 `async_insert`？

## 我没开过异步插入

第一反应当然是去查设置。这一查，掉进了这次排障最大的一个坑：

```
name                      value     default   changed
async_insert              1         1         0
async_insert_deduplicate  0         0         0
deduplicate_insert        enable    enable    0
```

`async_insert = 1`，而且 `changed = 0`，没人改过，它就是默认开的。这个已经够意外了。再往下看，`async_insert_deduplicate = 0`，异步去重是关着的。

异步去重明明关着，那百万个节点从哪来的？清理线程坏了？有别的 bug？

关键在第三行 `deduplicate_insert = enable`。这是 26.2 引入的统一开关，官方 PR 写得很直白，它会覆盖旧的 `insert_deduplicate` 和 `async_insert_deduplicate`。也就是说，26.2 以后 `async_insert_deduplicate=0` 这个值已经不代表实际行为了，它就是个被架空的老开关，看着是关的，其实不管事。

所以查的时候新旧要一起查：

```sql
SELECT name, value, default, changed
FROM system.settings
WHERE name IN ('async_insert', 'wait_for_async_insert', 'deduplicate_insert',
               'insert_deduplicate', 'async_insert_deduplicate')
ORDER BY name;
```

还得看 MergeTree 这边实际生效的窗口：

```sql
SELECT name, value
FROM system.merge_tree_settings
WHERE name IN ('replicated_deduplication_window_for_async_inserts',
               'replicated_deduplication_window_seconds_for_async_inserts',
               'replicated_deduplication_window',
               'replicated_deduplication_window_seconds',
               'cleanup_delay_period',
               'cleanup_delay_period_random_add')
ORDER BY name;
```

26.3.13 上返回的是：

```
replicated_deduplication_window_for_async_inserts         = 10000
replicated_deduplication_window_seconds_for_async_inserts = 604800   -- 一周
cleanup_delay_period                                      = 30
cleanup_delay_period_random_add                           = 10
```

每个 ReplicatedMergeTree 路径最多留 10000 条异步去重记录，时间窗口一周。10000 乘上路径数，就是百万 znode 的来源。

## 表不多，路径可不少

可这个集群表不多啊，路径数怎么会这么大？

同一张表的多个副本共用一个 `zookeeper_path`，所以不用乘副本数；但不同的表、不同的分片，各自是一条独立的路径。把这个集群逐个数一遍：

| 维度 | 规模 |
|---|---:|
| ClickHouse Server | 4 台 |
| 分片与副本 | 2 分片 × 2 副本 |
| 有效 Keeper quorum | 3 节点 |
| Keeper 数据库命名空间 | 9 个 |
| Keeper 中的逻辑表目录 | 362 个 |
| 具有分片子路径的活跃逻辑表目录 | 303 个 |
| 没有分片子路径的空历史目录 | 59 个 |
| 活跃表分片协调路径 | 606 条 |
| 变更前存在非空 `async_blocks` 的路径 | 224 条 |
| 其中接近 10000 条窗口上限的路径 | 69 条 |

这里的 303 张活跃表，是从 `/clickhouse/tables/<cluster>/<database>/<table>/<shard>` 统计出来的非空表目录，里面包括内部表、物化视图的目标表这些，并不全是手工建的业务表。59 个空目录下面没有 `<shard>` 子节点，没算进去。按库拆开：

| 数据库 | 表目录 | 活跃逻辑表 | 空历史目录 | 表分片路径 |
|---|---:|---:|---:|---:|
| database_A | 129 | 126 | 3 | 252 |
| database_B | 147 | 147 | 0 | 294 |
| database_C | 14 | 14 | 0 | 28 |
| database_D | 2 | 2 | 0 | 4 |
| database_E | 52 | 12 | 40 | 24 |
| database_F | 2 | 2 | 0 | 4 |
| 其他命名空间 | 16 | 0 | 16 | 0 |
| 合计 | 362 | 303 | 59 | 606 |

账就很好算了：

```
async_blocks 上限 ≈ 活跃的 ReplicatedMergeTree 表分片路径数 × 10000

全部 606 条活跃路径都有异步 INSERT：606 × 10000 = 606 万 znode
只算当时已非空的 224 条路径：        224 × 10000 = 224 万 znode
```

实际观测到约 113 万，只有这 224 条路径理论容量的 50.4%。离天花板还远着呢，后面还得接着涨，和前面那条曲线对得上。表不多的错觉就是这么来的：业务表到 Keeper 路径之间，隔着分片数、内部表、物化视图目标表好几层放大。

到这里机制是通了，可还有个疙瘩没解开：23.8 上那 4000 张表，比这个集群多一个数量级，凭什么没事？

## 4000 张表的老集群为什么没事

如果 `async_blocks` 是 ReplicatedMergeTree 一直就有的机制，23.8.9.54 上 4000 张表早该把 Keeper 撑爆了。既然没有，只剩两种可能：要么老版本没这个机制，要么有，但默认不启用。

翻了一圈代码和 PR，答案是后者，而且来龙去脉比我想的曲折。

机制是 22.12 就有的。[#43304](https://github.com/ClickHouse/ClickHouse/pull/43304) 首次支持异步 INSERT 去重，[#44223](https://github.com/ClickHouse/ClickHouse/pull/44223) 建了 `async_blocks` 路径和对应的开关，我核实过的第一个包含它的稳定标签是 `v22.12.1.1752-stable`。可那时候 `async_insert_deduplicate` 默认关，`async_insert` 也得手动开。23.8 就落在这个区间里，代码躺在那儿，没人去开，就一个节点都不会写。4000 张表相安无事，原因就在这。

到了 26.2，[#94413](https://github.com/ClickHouse/ClickHouse/pull/94413) 引入了 `deduplicate_insert` 统一开关（26.2.1.106），紧接着 [#95970](https://github.com/ClickHouse/ClickHouse/pull/95970) 把它的默认值改成 `enable`（26.2.1.583），所有 INSERT 默认去重，同步异步一视同仁。不过这时候 `async_insert` 还没在所有分支默认打开，没有异步插入，也就没有异步去重记录。

最后一步是 [#97590](https://github.com/ClickHouse/ClickHouse/pull/97590)，`async_insert` 默认开启（26.3.1.377），还回移到了 26.2.4.17，第一个包含这次回移的公开稳定标签是 `v26.2.4.23-stable`。到这一步，用户什么都不用做，不用开异步插入，也不用开去重，一个新部署的集群就会不停地往 `async_blocks` 里写节点，每条路径 10000 个，留一周。

两个默认值撞在一起，就是这个集群的病根。26.3.13.31 正好落在这个区间。

### 源码里的闸门

光有时间线还不够，我想确认到底是哪个配置在放行。26.3.13 的 `ReplicatedMergeTreeSink` 里，判断写得很直白：

```cpp
async_insert_
    ? replicated_deduplication_window_for_async_inserts != 0
    : replicated_deduplication_window != 0
```

异步插入走的是独立的窗口 `replicated_deduplication_window_for_async_inserts`，跟普通 INSERT 的窗口是分开的；这个窗口就是总闸，设成 0，异步去重记录就不再生成。顺带一提，并没有一个叫 `async_blocks=0` 的开关，`async_blocks` 只是 Keeper 上的目录名，想关它只能动窗口。

那已经堆起来的呢？同版本的清理线程 `ReplicatedMergeTreeCleanupThread` 会把这个窗口传给 `clearOldBlocks`，窗口一旦是 0，现有的记录全被当成超出保留范围，由后台线程删掉。

### 一周的窗口为什么没把它消化掉

既然有一周的时间窗口，为什么还在无休止地累积？

26.3 的清理线程确实会同时按条数和时间裁剪 `async_blocks`，但时间比较的参照是最新那个去重节点的创建时间，而不是当前的墙上时间。所以一条路径要是不再产生新的去重节点，参照时间也就跟着停了，最后那一批记录可能一直赖着不走，并不是再等一周就一定清零。

反过来，只要一直有写入，单条路径会慢慢逼近 10000 然后稳住，不会无限涨。可集群里有几百条还没到上限的路径，总量就会持续往上爬很久。现场从 119 万涨到 126 万，就是这么一个爬坡的过程。

## 社区早就吵过这一架

2023 年的 [#54968](https://github.com/ClickHouse/ClickHouse/issues/54968) 里，有用户报告 8 分片 2 副本、800 张复制表，Keeper 里约 180 万 znode，社区回复说复制表多加上按天分区，会持续制造大量协调节点。严格说这个 issue 讲的是 `block_numbers`，跟这次的 `async_blocks` 不是一个 bug，但它说明表和分片多了以后把 Keeper 推到百万级，早就不是个例。

最关键的一条是 [#86820](https://github.com/ClickHouse/ClickHouse/pull/86820)。这个 PR 想把普通复制表的去重条数窗口也提到 10000，review 里社区贡献者 filimonov 明确反对，大意是：

> - 100 张复制表乘以 10000 就是一百万 znode
> - 小型 ZooKeeper 在约一百万节点附近经常开始出现明显性能退化
> - Keeper 在节点数很高时也存在类似退化
> - 表很多的集群应该非常谨慎地使用大默认窗口

PR 作者的回复更有意思：`replicated_deduplication_window_for_async_inserts` 从一开始就是 10000。也就是说，每条路径 10000 条异步去重记录这个数，在有人提出百万 znode 警告之前就已经躺在默认值里了。它一直没出事，只是因为异步插入默认不开。我们这次在约 120 万 znode 的时候，平均延迟到了百毫秒级，最大延迟几十秒，filimonov 说的退化，算是让我们撞了个正着。

[#87414](https://github.com/ClickHouse/ClickHouse/pull/87414) 把普通的 `replicated_deduplication_window_seconds` 从一周降到一小时，理由正是减少低写入速率下的 ZooKeeper znode，方向完全对。review 里有人问，为什么不把 `replicated_deduplication_window_seconds_for_async_inserts` 一起改了？作者说这次没动异步 INSERT，但承认一起改确实有道理。可惜这一刀最后没砍下去，26.3 的异步窗口仍然是 10000 条加一周。

还有 [#91596](https://github.com/ClickHouse/ClickHouse/issues/91596)，讨论的正好就是前面那个旧开关的坑。维护者在里面讲清楚了：老版本里异步去重同时受好几个设置控制；26.2 引入 `deduplicate_insert`；`deduplicate_insert=enable` 会覆盖两个旧开关；从 26.2 开始，同步和异步 INSERT 默认都去重。由此可以实锤了，`async_insert_deduplicate=0` 还在生成节点，不是我们环境里闹鬼，确系官方新版本的BUG导致。

## 官方后来怎么修的

26.6 里，[#107886](https://github.com/ClickHouse/ClickHouse/pull/107886) 把 `insert_deduplication_version` 的默认值改成了 `new_unified_hash`，异步 INSERT 不再写单独的 `async_blocks`，而是和同步 INSERT 共用 `deduplication_hashes` 目录和那个一小时的普通窗口。`v26.5.5.8-stable` 里服务端设置还是：

```cpp
insert_deduplication_version = COMPATIBLE_DOUBLE_HASHES
```

`v26.6.1.1193-stable/src/Core/ServerSettings.cpp` 里已经变成：

```cpp
insert_deduplication_version = NEW_UNIFIED_HASHES
```

26.7 的 [#108361](https://github.com/ClickHouse/ClickHouse/pull/108361)（26.7.1.552）删掉了 `old_separate_hashes` 和 `compatible_double_hashes` 的执行路径，只留统一 hash，同时仍让 leader 清理旧的 `async_blocks`，照顾滚动升级期间老副本写下的遗留记录。

把这一串默认值的变化排一下：

| 代码 / 版本 | 变化 | 对 `async_blocks` 的影响 |
|---|---|---|
| #43304、#44223；`v22.12.1.1752-stable` | 引入异步 INSERT 去重和独立的 `async_blocks` 路径；`async_insert_deduplicate` 默认关闭 | 机制已存在，但默认不会大量写入 |
| 26.2.1.106，#94413 | 引入 `deduplicate_insert`，覆盖 `insert_deduplicate` 和 `async_insert_deduplicate` | 是否异步去重不能再只看旧开关 |
| #95409 | 引入 server setting `insert_deduplication_version`，默认 `compatible_double_hashes` | 统一 hash 迁移第一阶段：新旧两份去重记录同时写 |
| 26.2.1.583，#95970 | `deduplicate_insert` 默认改为 `enable` | 所有 INSERT 默认去重，但 `async_insert` 尚未全分支默认开启 |
| 26.3.1.377，#97590 | `async_insert` 默认开启，并回移到 26.2.4.17 | 默认异步合批与默认去重开始叠加 |
| `v26.2.4.23-stable` | 首个含回移的公开稳定标签 | 无须用户显式开启，就可能持续创建 `async_blocks` |
| `v26.3.1.896-lts` 及后续 | 延续上述默认值；本次集群为 26.3.13.31 | 本文问题的直接影响版本 |
| #107886；`v26.6.1.1193-stable` | `insert_deduplication_version` 默认切为 `new_unified_hash` | 异步 INSERT 改写 `deduplication_hashes`，不再新建 `async_blocks` |
| 26.7.1.552，#108361 | 移除旧的独立去重实现 | 从代码上完成旧路径淘汰 |

按公开的稳定包和默认配置，哪些版本会碰上：

| 版本范围 | 默认是否会出现本文问题 | 说明 |
|---|:--:|---|
| `v22.12.1.1752-stable` ～ 26.1.x | 条件触发 | 已存在 `async_blocks`；只有显式开启异步插入和异步去重才受影响（23.8 的 4000 张表就落在这里）|
| `v26.2.1.1139-stable` ～ `v26.2.3.2-stable` | 条件触发 | `deduplicate_insert` 默认开启，但 `async_insert` 仍通常需要显式开启 |
| `v26.2.4.23-stable` 及后续 26.2 | 是 | `async_insert` 的默认开启已回移到该分支 |
| 26.3 LTS 全系列 | 是 | 本次 26.3.13.31 现场复现 |
| 26.4.x ～ 26.5.x | 是 | 默认仍为兼容双 hash / 旧异步窗口 |
| `v26.6.1.1193-stable` 及之后 | 默认已修复 | 默认使用 `new_unified_hash`；若显式保留 `compatible_double_hashes`，仍会继续使用 `async_blocks` |
| 26.7.1.552 及以后 | 完整移除旧写入路径 | 升级前必须完成统一 hash 的兼容迁移 |

## 先止血

26.3 的集群不可能马上升到 26.6，得先止血。办法有三个。

第一个是把窗口调小：

```xml
<clickhouse>
    <merge_tree>
        <replicated_deduplication_window_for_async_inserts>1000</replicated_deduplication_window_for_async_inserts>
    </merge_tree>
</clickhouse>
```

还留着一部分异步 INSERT 的重试幂等，Keeper 节点上限降到原来的十分之一，适合客户端确实会自动重试的链路。但 `async_blocks` 还在，重试要是超出了窗口，照样可能写重。

第二个是窗口直接设成 0，这次我们用的就是这个：

```xml
<clickhouse>
    <merge_tree>
        <replicated_deduplication_window_for_async_inserts>0</replicated_deduplication_window_for_async_inserts>
    </merge_tree>
</clickhouse>
```

`async_insert=1` 保留，服务端小 INSERT 合批照常；新的 `async_blocks` 不再生成，现有的由后台清理线程回收；普通同步 INSERT 的去重窗口不受影响。代价是异步 INSERT 的重试幂等保护没了。客户端超时会自动重试的、消费链路是 at-least-once 的、写进物化视图或者 SummingMergeTree、AggregatingMergeTree 的（重复写会把结果放大）、应用层又没有唯一键兜底的，都得掂量掂量。`wait_for_async_insert=1` 能让这种不确定的状态少出现一些，但网络在 ACK 返回之前断掉的可能，它消除不了。

第三个，如果写入方本来就是大批次写，比如 clickhouse_sinker、Kafka 引擎表、成熟的 ETL 作业，那还有条路：对这些写入方把 `async_insert` 关了。

```xml
<!-- /etc/clickhouse-server/users.d/sinker_profile.xml -->
<clickhouse>
    <profiles>
        <sinker_writer>
            <async_insert>0</async_insert>
        </sinker_writer>
    </profiles>
</clickhouse>
```

为什么这对大批次客户端最划算？得先算清楚一件事：客户端攒批和服务端攒批，留下的去重记录数差得很远。客户端攒 1000 行发一个 INSERT，生成 1 个 part，去重记录 1 条；服务端把 1000 个小 INSERT 合成一批，也是 1 个 part，去重记录却是 1000 条。因为合批以后，ClickHouse 还得分得清批里每个源 INSERT 有没有执行过，不然客户端 A 重试时，它没法只去掉 A 的那份、留下 B 和 C 的，所以只能一个一个记 hash。

可对 sinker 这种写法，一个批次就是一个大 INSERT，源 INSERT 只有一个，去重记录也只有一条，跟同步插入一模一样，服务端攒批一点便宜都没占到。

那这种集群的 `async_blocks` 怎么还能堆到百万？差别不在条数，在保留期。普通 INSERT 的去重（`deduplication_hashes`）是 10000 条加 1 小时，这个一小时是 [#87414](https://github.com/ClickHouse/ClickHouse/pull/87414)  从一周降下来的；异步 INSERT 的去重（`async_blocks`）是 10000 条加 1 周，[#87414](https://github.com/ClickHouse/ClickHouse/pull/87414)  恰好跳过了它。同样的写入速率，留存时间差了 168 倍。一条路径要在一周内攒满 10000 条，平均每小时 60 条就够了，也就是每分钟一个批次，这比绝大多数 sinker 的 flush 频率都低。要是走普通窗口，同样的写入只留最近一小时，606 条路径加起来也就几万条，到不了百万。

所以对大批次客户端，关掉 `async_insert` 以后，`async_blocks` 不再产生，去重保护却还在，走的是普通的 `deduplication_hashes`，一小时窗口，这一点前两个办法都做不到。攒批本来就在客户端做，不会引出 Too many parts，还省了服务端一次内存缓冲和数据拷贝。默认 `wait_for_async_insert=1` 时客户端本来也要等到刷盘完成，延迟上没有损失。批次边界也回到了客户端手里，对 at-least-once 的消费链路来说，「批次写成功再提交 offset」的粒度是自己可控的。

三个办法放一起比：

| | 保留合批 | 保留幂等 | `async_blocks` | 适用场景 |
|---|:--:|:--:|:--:|---|
| 调小窗口 | 是 | 部分 | 变少 | 写入方混杂，且确实依赖异步重试幂等 |
| 窗口设为 0 | 是 | 否 | 清零 | 写入方混杂，且能接受失去异步幂等 |
| 关 `async_insert` | 客户端做 | 是（1h 窗口）| 清零 | 写入方同质、本来就攒大批 |

这次是因为写入方情况复杂，又要尽快止血，所以选了设成 0。如果你的集群写入方单一，又都是大批次，关 `async_insert` 更好，它什么都不牺牲，只是把攒批这件事还给了本来就在做它的客户端。

至于只把 `async_insert_deduplicate` 改成 0，前面说过了，在 `deduplicate_insert=enable` 的环境里它会被覆盖，改了也白改。

### 改在哪，怎么确认生效

表一多，逐表 `ALTER TABLE ... MODIFY SETTING` 既容易漏又难维护，直接在所有 Server 的 `<merge_tree>` 里设全局默认值：

```xml
<!-- /etc/clickhouse-server/config.d/async_dedup_window.xml -->
<clickhouse>
    <merge_tree>
        <replicated_deduplication_window_for_async_inserts>0</replicated_deduplication_window_for_async_inserts>
    </merge_tree>
</clickhouse>
```

别执行完 `SYSTEM RELOAD CONFIG` 就当生效了，逐个节点查一遍：

```sql
SELECT hostName(), name, value
FROM clusterAllReplicas('your_cluster', system.merge_tree_settings)
WHERE name = 'replicated_deduplication_window_for_async_inserts'
ORDER BY hostName();
```

表级设置优先于全局默认，所以还得看看有没有表单独设过：

```sql
SELECT database, name, engine
FROM system.tables
WHERE engine LIKE 'Replicated%MergeTree'
  AND positionCaseInsensitive(create_table_query, 'replicated_deduplication_window_for_async_inserts') > 0
ORDER BY database, name;
```

## 清理差点捅出更大的篓子

配置下发、滚动重启完，节点开始往下掉，然后 Keeper 就不太好了。

窗口从 10000 一下改成 0，等于几百条表分片路径的 leader 同时发现一大堆过期节点。清理不是免费的，它会产生大量 Keeper 删除事务、事务日志写入和 follower 的状态复制。现场看到 leader 的 `zk_outstanding_requests` 瞬间冲到 20226，有一次 `mntr` 请求短暂超时，`zk_synced_followers` 一度从 2 掉到 1，follower 也有几千个 outstanding。几十秒后全部自己恢复了，quorum 始终没丢多数派。

有惊无险。事后回头看，生产上应该更稳一点：挑低峰期做；先暂停或者排空会自动重试的写入队列；滚动重启 ClickHouse Server，别同时去重启 Keeper；提前把 `cleanup_delay_period_random_add` 调大，把不同表的清理时间打散；实在不放心就分几步降窗口，10000、8000、5000、2000，再到目标值；整个过程盯着 leader、同步 follower 数、outstanding 和 ClickHouse 的写入错误率。

```xml
<clickhouse>
    <merge_tree>
        <replicated_deduplication_window_for_async_inserts>0</replicated_deduplication_window_for_async_inserts>
        <cleanup_delay_period_random_add>3600</cleanup_delay_period_random_add>
    </merge_tree>
</clickhouse>
```

清理前后的数字：

| 阶段 | znode 数量 | Keeper 数据量 | leader outstanding | 同步 follower |
|---|---:|---:|---:|:--:|
| 变更前 | 约 126.2 万 | 约 340 MB | 有波动 | 2 |
| 清理中段 | 约 92.4 万 | 持续下降 | 峰值约 20226 | 短暂降至 1 |
| 清理末段 | 约 14.7 万 | 持续下降 | 连续为 0 | 2 |
| 清理完成检查点 | 105997 | 32284899 字节 | 0 | 2 |

znode 从约 126.2 万降到 105997，少了约 115.6 万，降了 91.6%；Keeper 数据量从约 340 MB 降到 32.3 MB；606 条活跃表分片路径下的 `async_blocks` 全部清零。

## 几件不要做的事

别手工递归删 `async_blocks`，别拿 Keeper 客户端去 `rmr`。ClickHouse 对这些目录有自己的并发、版本和缓存假设，绕开表引擎的清理线程去删，可能和正在进行的 INSERT 或者副本操作打架，也很容易误删旁边的协调数据。

别因为管理命令超时就去重启 Keeper leader。只要 quorum 还在，outstanding 能降下来，follower 能重新同步上，就别动它。贸然切主或者重启，很容易把一次能自己恢复的压力，变成真正的可用性事故。

别只看 `zk_avg_latency`。它通常是进程启动以来的累计值，扛过一次重负载以后不会马上回到原来的水平。

也别觉得符合源码设计就没问题。每条路径最多 10000 个去重节点是预期行为，后台清理线程也确实在干活，可几百条路径加起来堆到百万 znode，Keeper 的压力是实打实的。它不是内存泄漏，也不是单表无限增长，准确地说，是 26.2.4 到 26.5 这段版本的默认值组合埋下的一个容量陷阱。

## 最后

回过头看，找到 `async_blocks` 这个大目录其实只花了半小时。费劲的是后面那些：搞明白它是干嘛的，踩过旧开关的坑，算清楚为什么表不多也能堆出百万，再从版本和源码上确认是两个默认值撞在了一起，最后还差点在清理时把 Keeper 搞挂。

这次能一路追到底，靠的是那个 4000 张表的老集群。同样的东西在老环境里没事，我第一反应不是去怀疑业务有什么不一样，而是去翻默认值改了什么。这几年 ClickHouse 的不兼容变更，有不少是藏在默认值里的，API 倒没怎么变。升级的时候，**新旧版本的默认值最好逐项对一遍**。

---

**相关**：[版本升级避坑清单](/clickhouse/upgrade-gotchas) · [23.8 → 26.3 升级路径评估](/clickhouse/upgrade-23-8-to-26-3)
