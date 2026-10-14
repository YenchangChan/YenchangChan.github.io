---
title: ClickHouse 集群机房搬迁实战
---

# ClickHouse 集群机房搬迁实战

机房搬迁是 ClickHouse 运维里最重的活之一。技术上其实没多难，难在它同时牵扯好几件事：数据怎么迁、shard 拓扑变不变、物化视图字典这些元数据对象怎么搬、业务怎么双写、迁完怎么对账。哪一环没想到，都可能在切流那天翻车。

这篇讲的是中小客户跨云、跨机房搬迁的场景：单集群几个节点到几十个节点，单表从 GB 到 PB，表从几十张到几千张。头部互联网公司那种极端规模不在里面。灾备也不在里面，灾备看的是 RPO、RTO，跟搬迁是两套东西，混在一起讲反而说不清。文中标的特性版本号（比如 `22.8+`）以社区版为准，动手前请对照自己集群的实际版本。

## 能用的迁移方案

业界常见的做法大概有六种，按侵入程度、停机窗口和数据规模排一下：

| 方案 | 适用规模 | 是否需停写 | 增量同步 | 备注 |
|---|---|---|---|---|
| `INSERT INTO ... SELECT FROM remote()` | < 30 TB | 视情况 | 否 | 最简单 |
| `clickhouse-backup` + S3 | TB ~ 百 TB | 一般可接受短窗口 | 支持 incremental | 社区事实标准 |
| 原生 `BACKUP/RESTORE` 到 S3 | 同上 | 同上 | 支持 incremental | 22.8+，官方推荐 |
| 双写 + 历史回填 | 任意 | 不停写 | 应用侧保证 | 改造成本最高 |
| 加副本到新机房（Replicated） | 任意 | 不停写 | ZK/Keeper 自动 | 跨云不推荐 |
| `FREEZE` + 物理 part 拷贝 + `ATTACH PARTITION` | 任意 | 分区粒度短停 | 增量靠新分区 | 同版本同 schema 才稳 |

`clickhouse-copier` 就别考虑了，24.2 起它已经从安装包里拿掉，挪到了单独的仓库，基本没人维护了。

我的默认选择很简单。数据量能在迁移窗口内一次灌完的（中小客户通常在 30 TB 以内），直接 `INSERT INTO ... SELECT FROM remote()`，别上 `clickhouse-backup`，那是杀鸡用牛刀。表多但量不大的，比如 1000 多张表分在 5 到 10 个库里，用 `BACKUP DATABASE`，一条命令就把编排的事办了。

## 跨云搬迁走双写

跨云搬迁最大的约束是网络，专线带宽不便宜，抖动比同机房厉害得多。所以我倾向于不依赖底层的数据复制，走应用层双写。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-01.light.svg" alt="跨云机房搬迁的推荐路径">
<img class="dfig-d" src="/diagrams/datacenter-migration-01.dark.svg" alt="跨云机房搬迁的推荐路径">
</figure>

有人会问，为什么不直接给新机房加副本？因为跨云共享一套 Keeper 风险太大。RTT 一般在 30 到 50ms，写入吞吐会断崖式下跌，session timeout 也很容易出问题。除非你本来就在跑跨云的 multi-DC Keeper（这很少见），否则别走这条路。

## 四个阶段

<div class="sk sk-phases">
<div class="sk-box"><div class="sk-ph-h"><span class="sk-ph-n">1</span><span class="sk-t">准备</span><span class="sk-ph-when">D-7 ~ D-1</span></div><ul><li>B 集群建好，schema 同步</li><li>全量快照（BACKUP / INSERT SELECT）</li><li>验证全量</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-warm"><div class="sk-ph-h"><span class="sk-ph-n">2</span><span class="sk-t">双写</span><span class="sk-ph-when">D ~ D+N</span></div><ul><li>应用切双写</li><li>增量回填补齐快照之后的数据</li><li>持续对账</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-warm"><div class="sk-ph-h"><span class="sk-ph-n">3</span><span class="sk-t">灰度切读</span><span class="sk-ph-when">D+N+1 ~ D+N+7</span></div><ul><li>读流量灰度切到 B（10% → 50% → 100%）</li><li>观察查询正确性与延迟</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-ok"><div class="sk-ph-h"><span class="sk-ph-n">4</span><span class="sk-t">全量切换</span><span class="sk-ph-when">D+N+8</span></div><ul><li>停 A 集群写入</li><li>保留 A 一周作回退保险</li></ul></div>

</div>

### 两边的配置要一样吗

常听人说两个集群的配置得一模一样，这话不准确。表 schema、`PARTITION BY`、`ORDER BY`、TTL、字段 codec、`storage_policy` 的名字，这些必须一致。`<remote_servers>` 里的集群拓扑、`macros` 里的 `{shard}`/`{replica}`、ZK/Keeper 的路径前缀，这些必须不一样，尤其是路径前缀，两边千万别共用，不然两边的表会被当成同一张 Replicated 表互相拉数据，彻底乱套。副本数、分片数、机器规格、`background_pool_size` 这类性能相关的 server setting，可以不一样。

### 双写怎么做

双写就是让一条数据同时落到两个集群，怎么实现取决于数据从哪来：

| 数据来源 | 双写实现方式 |
|---|---|
| 业务应用直接 INSERT | 应用层改造，封装 DAO 让其同时写两个集群（推荐异步双写 + 失败重试队列） |
| 通过 Kafka 流入 | 在外部消费层（Vector / Kafka Connect / 自研服务）订阅同一 topic，用两个独立的 consumer group 分别写 A 和 B |
| 通过 ETL 批量写入 | ETL job 改造为输出两份，或加一个反向同步 job |

别用 ClickHouse 自带的 Kafka Engine 做双写。它看着简单，可故障恢复、schema 演进、错误处理的运维成本远比看上去高：一个 replica 一个 consumer，replica 挂了消费就停；改 schema 要 detach/attach；错误处理很粗糙；故障恢复时数据可能丢也可能重。生产上我推荐外部消费，再走标准的 INSERT。

应用层双写有几条要守住。写 B 要异步，写 B 失败不能拖住业务，先落到补偿队列里，回头再重试。重试要幂等，ClickHouse 的 `insert_deduplicate`（query setting，默认 1）会对同一个 block 的哈希在去重窗口内自动去重，窗口由 `replicated_deduplication_window` 和 `replicated_deduplication_window_seconds` 控制，默认值各版本改过几次，以你的版本为准，所以重试时要保证发出去的是同一批数据。切流前留够对账的时间，双写至少跑 7 天再切。

### 合并型引擎跨集群 INSERT SELECT 要加 FINAL

源表要是 `ReplacingMergeTree`、`CollapsingMergeTree` 这类合并型引擎，INSERT SELECT 得显式加 FINAL，不加的话拷过去的是未去重的多版本数据：

```sql
-- ❌ 错误：拷过去的是未去重的多版本数据
INSERT INTO b.user_state_distributed
SELECT * FROM remote('a-host', a.user_state_distributed, ...);

-- ✅ 正确：先在源端去重再拷贝
INSERT INTO b.user_state_distributed
SELECT * FROM remote('a-host', a.user_state_distributed, ...) FINAL;
```

不加 FINAL，所有历史版本都会被拷过去。新旧集群的 sharding key 完全一样的话，这倒不影响最终结果，B 集群照样能 FINAL 出正确的数。可只要 sharding key 有一点变化，同一个 key 的多个版本就可能被打散到不同的 shard 上，FINAL 再也合不回来，而且不报任何错。为什么会这样，后面讲 sharding key 时细说。

### 对账

按 sharding key 分桶，每个桶分别算 count 和 hash：

```sql
-- 在 A 集群跑
SELECT
    cityHash64(user_id) % 5 AS new_shard,  -- 按【新】sharding 规则分桶
    count() AS cnt,
    sum(sipHash64(user_id, event_id, event_time)) AS sig
FROM db.events_distributed
WHERE event_date BETWEEN '2026-04-01' AND '2026-04-28'
GROUP BY new_shard
ORDER BY new_shard;
```

`sipHash64` 是 ClickHouse 自己的函数，PG 和 MySQL 里没有。要注意 `sum(hash)` 对重复数据不敏感，`A=B+B` 和 `A+B=B` 它看不出区别，ReplacingMergeTree 这类表还得加上 `count(distinct ...)`。

## 表要分类迁

千万别拿一套流程去套所有的表。表的分区方式，其实已经透露了设计者对数据量的预期，不同的表迁法完全不一样。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-03.light.svg" alt="表的分类与迁移策略匹配">
<img class="dfig-d" src="/diagrams/datacenter-migration-03.dark.svg" alt="表的分类与迁移策略匹配">
</figure>

动手之前先扫一遍：

```sql
SELECT
    database, table,
    sum(bytes_on_disk) / pow(1024, 3) AS gb,
    sum(rows) AS rows,
    countDistinct(partition) AS partitions
FROM system.parts
WHERE active
GROUP BY database, table
ORDER BY gb DESC;
```

再按结果分类：

| 分类 | 特征 | 迁移策略 |
|---|---|---|
| 大表 | 时间分区 + 数据量大（TB+） | 双写 + 增量回填，按分区切片 |
| 中表 | 任意分区 + GB ~ 百 GB | 物理拷贝（FREEZE/clickhouse-backup）一把过 |
| 小表 | 不分区 / 非时间分区，通常 < 100 GB | 一次性 INSERT SELECT 全量灌过去，再开双写 |
| 配置表 | 字典、维度表（MB 级） | 跟着代码走，不需要专门迁移 |

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-04.light.svg" alt="小表先迁后双写">
<img class="dfig-d" src="/diagrams/datacenter-migration-04.dark.svg" alt="小表先迁后双写">
</figure>

小表先迁后双写，省事在于没有增量回填这一步，全量在双写开始之前就同步完了；对账也简单，不用担心快照和双写之间那段时间窗口对不齐；失败了 `TRUNCATE` 重来就行。

很多人担心无分区的表不好迁，其实大可不必。一张表设计的时候不按时间分区，说明设计者认定它不会无限膨胀。真涨到了 TB 级，那是设计出了错，不该让迁移来买这个单。无分区表一般就 GB 到几十 GB，一次 INSERT SELECT 几分钟到几小时就完了。少数用 hash 分区的大表算例外，后面单独讲。

## sharding key 不只是性能优化

讲 reshard 之前，得先把 sharding key 的作用说清楚。最基础的是写入分布，让数据均匀落到各个 shard，别出热点，这个大家都懂，不多说。

第二重最容易翻车：合并型引擎的去重正确性。对 `ReplacingMergeTree`、`CollapsingMergeTree`、`VersionedCollapsingMergeTree`、`SummingMergeTree`、`AggregatingMergeTree` 这些引擎，sharding key 必须是 `ORDER BY` 字段的函数。原因是 FINAL 和后台 merge 都是在单个 shard 内做的，只能合并同一个 shard 里的数据。同一个去重 key 的多个版本要是散到了不同的 shard，FINAL 永远查不出正确的去重结果。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-05.light.svg" alt="合并型引擎的去重正确性">
<img class="dfig-d" src="/diagrams/datacenter-migration-05.dark.svg" alt="合并型引擎的去重正确性">
</figure>

```sql
-- ✅ 正确：sharding key 是 ORDER BY 字段的函数
CREATE TABLE user_state_local (
    user_id UInt64,
    state String,
    updated_at DateTime
)
ENGINE = ReplicatedReplacingMergeTree(updated_at)
ORDER BY user_id;

CREATE TABLE user_state_distributed AS user_state_local
ENGINE = Distributed(cluster, db, user_state_local, cityHash64(user_id));

-- ❌ 错误：用 rand() 打散，FINAL 失效
ENGINE = Distributed(cluster, db, user_state_local, rand());
```

| 引擎 | 去重/合并依据 | sharding key 必须满足 |
|---|---|---|
| `ReplacingMergeTree` | `ORDER BY` 全部字段 | 是 ORDER BY 字段的函数 |
| `CollapsingMergeTree` | `ORDER BY` + `sign` | 是 ORDER BY 字段的函数 |
| `VersionedCollapsingMergeTree` | `ORDER BY` + `sign` + `version` | 是 ORDER BY 字段的函数 |
| `SummingMergeTree` | `ORDER BY` 字段 | 是 ORDER BY 字段的函数 |
| `AggregatingMergeTree` | `ORDER BY` 字段 | 是 ORDER BY 字段的函数 |
| `MergeTree` / `ReplicatedMergeTree` | 不去重 | 任意 |

顺带一个坑：`OPTIMIZE TABLE ... FINAL` 也是在单个 shard 里做的，不会跨 shard 去重。sharding key 错了，源表 OPTIMIZE 多少遍也救不回来。

第三重是 colocate join。两张表用同一个 sharding key，相同 join key 的数据就落在同一个 shard 上，分布式 join 可以变成每个 shard 上的本地 join，性能能差出数量级。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-06.light.svg" alt="Colocate Join">
<img class="dfig-d" src="/diagrams/datacenter-migration-06.dark.svg" alt="Colocate Join">
</figure>

要用本地 join，查询时得显式声明：

```sql
SELECT o.*, i.qty
FROM orders_distributed AS o
JOIN order_items_distributed AS i USING (order_id)
SETTINGS distributed_product_mode = 'local';
```

`distributed_product_mode` 默认是 `deny`，两张分布式表直接 JOIN 会报错。有人图省事改成 `allow`，那每个分片都会再去跑一遍右表的分布式查询，N 个节点就是 N×N 次，读放大得厉害。所以 colocate 要在表设计阶段就规划好。亿级表 JOIN 亿级表，colocate 比广播快 10 到 30 倍，很多人吐槽 ClickHouse JOIN 不行，根子就在没用上 colocate。

colocate 还让 sharding key 被锁得更死。不光每张表自己的 sharding key 不能随便改，一组互相 join 的表还得一起改，改一张就得改所有相关的表；跨集群迁移要 reshard，也得一组表一起 reshard，而且新旧的 sharding key 表达式行为要一致。实际业务里，一个领域常常有 5 到 10 张表共用同一个 sharding key（比如 `cityHash64(user_id)`），reshard 的时候它们是拆不开的一个整体。

好在只要守住两张表用同一个 sharding key 表达式这一条，shard 数从 3 变成 5 并不会破坏 colocate。同一个 user_id 在 B 集群上照样落在同一个 shard，编号会变，表达式不变就行。

麻烦的是 colocate 失效了是没声音的。查询从 2 秒退化到 60 秒，不报错，业务方往往切流几天后才来反馈，到那时已经很难回滚了。所以切流之前，要专门做一轮性能回归，把业务里所有带 JOIN 的查询挑出来，在 A、B 两个集群上各跑一遍比耗时。

三重作用放在一起看：

| 作用 | 影响 | 改错的后果 |
|---|---|---|
| 写入分布 | 数据均匀性 | 性能问题，可观察、可调整 |
| Colocate JOIN | 查询性能 | 静默退化：查询变慢但不报错，需协同变更多张表 |
| 合并型引擎去重 | 数据正确性 | 静默错误：FINAL 返回错误结果 |

从上往下，越来越要紧，也越来越难改。前两个好歹有性能信号能发现，第三个完全没声音，可能迁完几个月，业务方才发现统计数据怎么对不上。

所以表设计的时候一旦选了 `ReplacingMergeTree` 加某个 ORDER BY，sharding key 实际上就被锁死成了 ORDER BY 字段的函数，以后迁移想换 sharding key，只能连去重 key 一起改，那是表语义的变更，不是单纯换个物理分布。反过来，物理拷贝天然保持 shard 数和 sharding key 不变，对合并型引擎来说反倒是最安全的，这一点常被忽略。reshard 也不是一张表的事，是一组表的事，一组 colocate join 的表，要么一起 reshard，要么都别动。

## Reshard 是硬骨头

新旧集群 shard 数不一样，物理拷贝这条路就全废了。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-07.light.svg" alt="Resharding">
<img class="dfig-d" src="/diagrams/datacenter-migration-07.dark.svg" alt="Resharding">
</figure>

shard 2 的 part 文件里只有 `% 3 == 1` 的数据。新集群要是 5 个 shard，正确的归属应该按 `% 5` 算，part 只能重新读出来、重新路由，没有捷径。

走双写的话，reshard 是白送的：

```sql
-- 在 B 集群执行（B 是 5 shard，A 是 3 shard）
INSERT INTO db.events_distributed
SELECT * FROM remoteSecure(
    'a-cluster-distributed-host:9440',
    'db.events_distributed',
    ...
)
WHERE user_id BETWEEN 0 AND 1000000
SETTINGS
    max_execution_time = 0,
    max_insert_threads = 8,
    parallel_distributed_insert_select = 2;  -- query setting，25.7 起默认就是 2
```

写 Distributed 表本来就会按新的 sharding 规则分发，一读一写，reshard 就做完了。

可到了 PB 级就是另一回事了。1 PB 走跨云 10 Gbps 专线，实际传输 15 天起步，再加上 egress 费用、CPU、内存、merge 的压力，这是按季度算的工程。

我建议团队定一条规矩：超过 1 PB 的表，新旧集群的 shard 数必须一致，扩容只能靠加副本或者升级机器规格；表设计的时候就做 5 年的容量规划，保证 shard 数够用；实在要 reshard，单独立项。再细一点可以这么分：

| 表规模 | sharding 变更政策 |
|---|---|
| < 10 TB | 自由 reshard，迁移走 INSERT SELECT 即可 |
| 10 TB ~ 100 TB | reshard 需要架构评审，预留 1~2 周迁移窗口 |
| 100 TB ~ 1 PB | reshard 需要立项，给出 3 年规划 |
| > 1 PB | 默认禁止 reshard，节点数必须一致 |

这样 reshard 的代价是摆在明面上的，什么时候做、做不做都能提前决定，不至于迁移时才发现有笔债要还。再加上前面说的，sharding key 一旦定下，就同时背着几张表的数据正确性和 JOIN 拓扑，这条规矩的理由不只是工程量大。

## 中小客户的 PB 级，其实是 100 TB 级

数据量上，头部互联网公司，比如字节、阿里，ClickHouse 集群是日增 PB 级，总量是流量堆出来的，每天写进来的就很多，热数据本身就是 PB 级，没有缩小问题规模的余地。中小客户完全不一样：

| 业务类型 | 日增量 | 5 年累积 | 典型集群规模 |
|---|---|---|---|
| 中型 SaaS | 10~100 GB/天 | 几十 TB | 3~6 节点 |
| 中型 ToC | 100 GB~1 TB/天 | 几百 TB | 6~12 节点 |
| 大型 ToC | 1~10 TB/天 | PB 级 | 20~50 节点 |

中小客户出现 PB 级的表，几乎都是两三年累积起来的，每天 GB 到 TB 的增量乘上时间堆上去的。总量大，不代表都是活跃数据。

查询上，OLAP 场景里，业务监控、运营大盘查的是最近 24 小时、7 天、30 天；用户行为分析查最近 30 到 90 天；季度同比、年报查最近一年；历史回溯、合规审计才会查一到三年前的数据，频次很低，一个月几次。中小客户的实际系统里，九成以上的查询落在最近 6 到 12 个月的数据上，这部分才是热数据。

sharding key 上，写入分布、合并型引擎去重、colocate join，这三重作用针对的全是被频繁访问的数据。冷数据已经不写了，分布匀不匀没意义；冷数据状态已经稳定，不会再来新版本；冷数据很少参与查询，join 快慢也不敏感。一类查询要是频次极低，比如两年前的历史回溯，那这部分数据用什么 sharding 都无所谓，全表扇出查一次，业务是能接受的。

<div class="sk sk-steps">
<div class="sk-box"><span class="sk-t">中小客户 PB 级表</span><span class="sk-d">数年累积</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">业务自然规律</span></div>
<div class="sk-box"><span class="sk-t">90%+ 查询命中最近 6~12 个月数据</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">sharding key 服务于活跃访问</span></div>
<div class="sk-box"><span class="sk-t">sharding key 的三重作用只对热数据有意义</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">冷数据不需要新 sharding</span></div>
<div class="sk-box"><span class="sk-t">冷数据可以保持旧 sharding，或归档到对象存储</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">问题规模缩小一个数量级</span></div>
<div class="sk-box is-accent"><span class="sk-t">真正参与 reshard 的只有 100 TB 级热数据</span></div>
</div>

所以中小客户的 PB 级迁移，可以分层做：

| 数据分层 | 占比 | 迁移方式 |
|---|---|---|
| 热数据（近 6~12 月） | 10~20% (~100 TB) | 双写 + 全量回填 + 走新 sharding |
| 温数据（6~24 月） | 20~30% (~300 TB) | 物理拷贝（保持旧 sharding）或归档 |
| 冷数据（2 年+） | 50~70% (~600 TB) | 归档到对象存储（Parquet/Iceberg），通过 `s3()` 表函数按需查询 |

前提是业务方能接受冷数据查询走慢路径，从秒级变成十几秒。这是产品上的决定，不是技术能替他做的。业务要是承诺了所有历史数据都秒级响应，这个办法就不成立，只能回到老路上去。

技术上的配套 ClickHouse 都有。TTL 跨盘 22.8 以后就很稳了：

```sql
CREATE TABLE db.events_local (...)
ENGINE = ReplicatedMergeTree(...)
ORDER BY ...
TTL event_date + INTERVAL 6 MONTH TO DISK 'cold_s3',
    event_date + INTERVAL 2 YEAR DELETE;
```

归档以后直接从对象存储查：

```sql
SELECT count() FROM s3(
    'https://archive.oss/events/year=2022/*.parquet', 'Parquet'
) WHERE user_id = 12345;
```

## 不同规模怎么选

### 10 TB 以下：INSERT SELECT 直接推

这个量级别想太多，直接 INSERT SELECT。`clickhouse-backup` 在这儿就是杀鸡用牛刀，部署工具、配 S3、调权限、排查版本兼容，折腾下来不划算。

```sql
INSERT INTO db.events_local
SELECT * FROM remoteSecure('a-host:9440', 'db.events_local', 'user', 'pwd')
SETTINGS max_execution_time=0, max_insert_threads=8;
```

10 TB 大概要多久：

| 网络 | 实际时间 |
|---|---|
| 同机房万兆 | 3.5~4 小时 |
| 跨云千兆专线 | 36~40 小时 |
| 跨云万兆专线 | 3.5~4 小时 |

看的不是数据量本身，是能不能在窗口期内一次灌完。同机房万兆，30 TB 也能从容跑完。

INSERT SELECT 还有几个不太显眼的好处。它走的是 SQL 协议，跨大版本兼容的范围特别宽，19.x 直接推到 24.x 的都见过，物理拷贝那种 part 格式版本不兼容的问题它没有。失败了重试也简单，`TRUNCATE` 重来。写分布式表还能顺手把 reshard 做了。

### 上千张表：BACKUP DATABASE

1000 多张表一般分在 5 到 10 个库里，整个库一把过：

```sql
-- 22.8+ 原生 BACKUP
BACKUP DATABASE app, analytics, ods
TO S3('https://bucket/migrate/full', 'ak', 'sk')
SETTINGS compression_method='zstd';

-- B 集群
RESTORE DATABASE app, analytics, ods
FROM S3('https://bucket/migrate/full', 'ak', 'sk');
```

或者用 `clickhouse-backup`：

```bash
clickhouse-backup create_remote full_$(date +%Y%m%d) \
    --tables="app.*,analytics.*,ods.*"
clickhouse-backup restore_remote full_20260429
```

比起一张张表 INSERT SELECT，按库备份一条命令就完了，不用自己写编排；依赖顺序它自己处理，先普通表，再 MV，再视图；元数据也全，UDF（24.x+）、字典定义都在里面；失败了还能靠增量备份接着传没传完的部分。

它不管的几样得手工弄：ZK 路径要重写；分布式表里的 cluster 名是 server config，不在备份里；users 和 roles，22.8 的原生 BACKUP 不包含，24.x 起 `BACKUP ALL` 才带上；放在 `/etc/` 下的字典 XML 也不在备份里。业务库和测试库混在一个库里的（用 `--tables` 过滤）、跨大版本比如 21.x 到 24.x 的（part 格式不兼容，退回 INSERT SELECT）、需要 reshard 的（走双写），都不适合用它。

千表场景最头疼的是编排和验证。串行跑太慢，并发跑容易把连接打爆，单张表失败了不好定位。最要命的是 schema 漂移，说是「我们就 800 张表」，一扫发现 1247 张，里面一堆死表，还有重启就没的临时表（`Memory`、`Log` 引擎）。所以千表迁移的第一步永远是先扫出表清单，跟业务确认哪些是死表，把 1000 拆小了，再决定是 BACKUP DATABASE 还是逐表调度。

### PB 级还要 reshard：S3 中转 + s3Cluster

PB 级跨云直连做 reshard 不现实，专线打满半个月，egress 费用上百万。用对象存储中转：

<div class="sk sk-steps">
<div class="sk-box"><span class="sk-t">A 集群</span><span class="sk-d">老 sharding</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">① 导出 Native 格式，按 A shard × 时间切片</span></div>
<div class="sk-box"><span class="sk-t">A 云对象存储</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">② 跨云 CRC（对象存储自带）</span></div>
<div class="sk-box"><span class="sk-t">B 云对象存储</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">③ INSERT INTO b.distributed SELECT FROM s3()</span></div>
<div class="sk-box is-accent"><span class="sk-t">B 集群</span><span class="sk-d">新 sharding，reshard 在这一步自动完成</span></div>
<p class="sk-cap">数据不经过任何中转机器，跨云复制由对象存储自己做</p>
</div>

```sql
-- A 集群每个 shard 直接导出本地数据到对象存储
INSERT INTO FUNCTION s3(
    'https://a-bucket.oss/migrate/shard0/events_{_partition_id}.native.zst',
    'ak', 'sk', 'Native'
)
SELECT * FROM db.events_local
WHERE event_date BETWEEN '2026-04-01' AND '2026-04-30';

-- B 集群从 S3 并行读取，写入 distributed 表自动 reshard
INSERT INTO db.events_distributed
SELECT * FROM s3Cluster(
    'b_cluster',
    'https://b-bucket.oss/migrate/*.native.zst',
    'ak', 'sk', 'Native'
)
SETTINGS
    max_insert_threads = 16,
    parallel_distributed_insert_select = 2;
```

`s3Cluster` 22.3 以后都能用；`parallel_distributed_insert_select` 老版本要手动设，25.7 起默认就是 2。

这样做好在三点：跨云流量走对象存储的跨区复制，同账号跨 region 一般比 egress 便宜得多；A 端只读一次，B 端只写一次，CPU 省一半；每个 S3 对象都是独立的，天然就能断点续传。

## 无分区、非时间分区的表

这是搬迁时被问得最多的问题。前面说过，这种表通常本来就不大，GB 到几十 GB，一次全量灌完就行，用不着增量。

真碰上例外，比如多租户场景里用 hash 分区的大表，全量阶段可以按 partition_id 并行：

```bash
for pid in $(clickhouse-client -q "SELECT DISTINCT partition_id FROM system.parts WHERE table='events' AND active FORMAT TSV"); do
    # FREEZE + 拷贝 + ATTACH PARTITION ID '$pid'
done
```

`ATTACH PARTITION ID '<id>'` 用的是 partition_id，不是分区表达式的值，对 hash 分区特别方便。

物理拷贝（FREEZE、rsync、ATTACH）有几个坑一定会踩：rsync 过去以后必须 `chown -R clickhouse:clickhouse`，不然 ATTACH 失败；detached 目录下要是有同名的残留 part，ATTACH 会跳过它；Replicated 表要么用 `ATTACH PARTITION ON CLUSTER`，要么只在一个副本上 ATTACH，让别的副本通过 ZK 自己去 fetch；跨大版本（21 到 24）part 格式差别很大，别用物理拷贝。

增量阶段，`clickhouse-backup create --diff-from-remote=xxx` 比对的是 part 文件级别的差异，跟分区维度没关系。分区哪怕不按时间，它也能做出只包含新 part 的增量备份。这也是为什么表多、数据量中等的场景我推荐 `clickhouse-backup`，它把按分区、按时间增量，变成了按 part 增量。

对账按主键范围分桶：

```sql
SELECT
    intDiv(cityHash64(user_id), pow(2, 56)) AS bucket,  -- 256 个桶
    count() AS cnt,
    sum(sipHash64(user_id, event_id, event_time)) AS sig
FROM db.events
GROUP BY bucket
ORDER BY bucket;
```

## 元数据对象

数据之外，还有一堆不是表的对象要处理。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-10.light.svg" alt="元数据对象的迁移">
<img class="dfig-d" src="/diagrams/datacenter-migration-10.dark.svg" alt="元数据对象的迁移">
</figure>

### 物化视图

物化视图其实是两个对象，一个是 MV 定义，相当于 INSERT 触发器，一个是底下存数据的表。带 `TO` 子句的 MV（推荐的写法），底下是个普通的命名表，按普通表迁就行。不带 `TO` 的老写法，底层表是自动生成的 `.inner_id.xxxx`，没法直接 attach 过去，只能先建好 MV 再重新灌数据。

双写期间物化视图有个大坑。如果 MV 做的是聚合（`SummingMergeTree`、`AggregatingMergeTree`），双写期间 A 和 B 会各自独立累加，切流时新集群 MV 里的数可能跟源表对不上。最稳的办法是切流前把 B 集群 MV 的底层表清空，从源表重新算一遍：

```sql
TRUNCATE TABLE db.events_daily_local;
INSERT INTO db.events_daily_local
SELECT toDate(event_time) AS day, count() FROM db.events GROUP BY day;
```

还有，别用 POPULATE。`CREATE MATERIALIZED VIEW ... POPULATE` 会在创建时把源表全量跑一遍，可 POPULATE 期间源表新写进来的数据会丢，这是官方文档明确警告过的。正确的做法是先把底层 TO 表的数据迁过去，再创建不带 POPULATE 的 MV，让它只管以后的增量。

### 字典

字典的数据在外部源里，怎么迁全看源在哪。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-11.light.svg" alt="字典：源在哪决定迁移方式">
<img class="dfig-d" src="/diagrams/datacenter-migration-11.dark.svg" alt="字典：源在哪决定迁移方式">
</figure>

跨云迁移最常漏的，是字典源在 A 云的内网，B 云连不上，MySQL、PG 源最常见。迁之前一定要在 B 集群的机器上确认网络通（`nc -zv mysql.internal 3306`）。

我推荐用 named_collections（22.12+）：

```sql
SOURCE(MYSQL(NAME 'mysql_app_config'))
```

`mysql_app_config` 定义在 server config 里。迁移时 DDL 不用改，B 集群定义一个同名的 named_collection 就行，环境差异都关在配置里，这是最干净的迁法。

字典定义放在哪，迁法也不一样：

| 方式 | 存放位置 | 迁移 |
|---|---|---|
| `CREATE DICTIONARY` SQL | 系统数据库 | 跟着 schema 走 |
| `*.xml` 配置文件 | `/etc/clickhouse-server/dictionaries.d/` | 必须手动拷贝到 B 集群所有节点 |

XML 方式迁移时容易漏，专门查一下：

```sql
SYSTEM RELOAD DICTIONARIES;
SELECT name, status, last_exception FROM system.dictionaries;
-- status 应该全是 LOADED
```

### 分布式表

cluster 名得改：

```sql
-- A 集群
CREATE TABLE db.events_distributed AS db.events_local
ENGINE = Distributed('a_cluster_3shards', db, events_local, cityHash64(user_id));

-- B 集群（cluster 名要改）
CREATE TABLE db.events_distributed AS db.events_local
ENGINE = Distributed('b_cluster_5shards', db, events_local, cityHash64(user_id));
```

cluster 名在 server config 里，不会自己迁过来。

迁之前确认 A 集群没有积压的异步分发：

```sql
SELECT * FROM system.distribution_queue;  -- 应该是空的
SYSTEM FLUSH DISTRIBUTED db.events_distributed;
```

`SYSTEM FLUSH DISTRIBUTED` 会强制把异步队列里的数据推完，20.5 以后都支持。

### UDF

| 类型 | 迁移内容 | 注意 |
|---|---|---|
| SQL UDF（21.10+） | 纯元数据，`CREATE FUNCTION` 重建 | `/var/lib/clickhouse/user_defined/` 也可直接 rsync |
| Executable UDF（21.11+） | XML 配置 + 可执行脚本 + 依赖 | 部署到 B 集群所有节点；注意架构（x86 / ARM） |

Executable UDF 最容易漏，因为它已经超出 ClickHouse 本身了，脚本部署、依赖安装、CPU 架构兼容都得自己管。

### 迁移顺序

<div class="sk sk-phases">
<div class="sk-box"><div class="sk-ph-h"><span class="sk-ph-n">1</span><span class="sk-t">基础对象</span></div><ul><li>集群拓扑配置（remote_servers）</li><li>named_collections</li><li>users / roles / quotas</li><li>UDF 配置 + 脚本</li><li>字典 XML 配置</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box"><div class="sk-ph-h"><span class="sk-ph-n">2</span><span class="sk-t">表 + 数据</span></div><ul><li>普通表 schema</li><li>MV 底层 TO 表（当作普通表建）</li><li>数据迁移（双写 + 回填）</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-warm"><div class="sk-ph-h"><span class="sk-ph-n">3</span><span class="sk-t">衍生对象</span></div><ul><li>SQL UDF</li><li>字典（CREATE DICTIONARY）</li><li>物化视图（不要 POPULATE）</li><li>普通视图</li><li>分布式表（改 cluster 名）</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-ok"><div class="sk-ph-h"><span class="sk-ph-n">4</span><span class="sk-t">切流前最终检查</span></div><ul><li>SYSTEM RELOAD DICTIONARIES</li><li>SYSTEM RELOAD FUNCTIONS</li><li>字典 status 全部 LOADED</li><li>MV 一致性对账</li><li>分布式表 SELECT 测试</li></ul></div>
<p class="sk-cap">衍生对象依赖基础对象，MV 依赖它的 TO 表</p>
</div>

顺序不能乱：UDF 和字典要在建表之前就位；MV 必须等源表迁完、双写稳定以后再建；分布式表和视图放最后。顺序错了，会一个接一个地失败。

## 怎么选

把表的数量和数据总量放在一起看：

| | 表少（< 50） | 表中等（50~500） | 表多（500+） |
|---|---|---|---|
| 总量小（< 10 TB） | 手写 INSERT SELECT | INSERT SELECT + for 循环 | `BACKUP DATABASE` 一把过 |
| 总量中等（10~100 TB） | INSERT SELECT 切片 | INSERT SELECT + 调度 | `clickhouse-backup` + 双写 |
| 总量大（> 100 TB） | 双写 + 增量回填 | 双写 + 调度 | 双写 + 调度（项目级工程） |

要 reshard 的时候：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-13.light.svg" alt="需要 reshard 时的决策">
<img class="dfig-d" src="/diagrams/datacenter-migration-13.dark.svg" alt="需要 reshard 时的决策">
</figure>

九成的中小客户，最后都会落在 INSERT SELECT 直推或者 BACKUP/RESTORE 上。

回头看，搬迁这件事我最想提醒的有两点。一是数据生命周期管理要放在迁移规划之前做，能把 PB 压到 100 TB，工程难度差一个数量级，比用技术硬扛省事得多。二是 **sharding key 是数据正确性的约束，不只是性能优化**，合并型引擎的 sharding key 必须是 ORDER BY 字段的函数，一组做 colocate join 的表必须共用同一个 sharding key，这两条决定了它一旦定下来，就很难单独改一张表。剩下的，按表的特点分别对待，MV 切流前重算一遍，元数据对象按顺序建，基本就不会在切流那天翻车。

---

**相关**：[扩容之后为什么不自动做数据均衡](/clickhouse/tooling/why-not-auto-rebalance) · [ClickHouse 集群部署拓扑对比：为什么推荐「一机一副本」](/clickhouse/tooling/deployment-topology)
