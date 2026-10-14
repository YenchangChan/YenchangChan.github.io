---
title: 从 S3 Disk 到 Parquet：冷数据为什么要脱离主线
---

# 从 S3 Disk 到 Parquet：冷数据为什么要脱离主线

S3 Disk 的思路，是让 ClickHouse 把 S3 当成一块慢盘来用。

这样改造成本是低，可它也把 MergeTree 的一整套机制都搬到了对象存储上：part、merge、mutation、副本、metadata、启动校验，还有 list 和 delete。

冷数据越攒越多，很多团队就会碰上这样的局面：冷数据明明没几个人查，却一直拖累着 ClickHouse 主集群；或者冷数据还要查，可查的方式已经不适合放在 MergeTree 主线里了。

这时候可以换个思路：不让 ClickHouse 管冷数据了，把它导出成 Parquet 放在 S3 上。ClickHouse 照样能通过 S3 Engine 或者 `s3()` 表函数去查它，Spark、Trino、DuckDB、Python 也都能直接读。

这么做不是为了赶什么新概念，是为了把数据从某个引擎的内部格式里放出来。

## S3 Disk 的问题出在哪

S3 Disk 的坑，说到底都是因为 ClickHouse 想把 S3 当本地盘用。

MergeTree 在本地盘上跑得好，是因为本地盘禁得起频繁地建删小文件、做 merge、随机读 mark 和列文件、快速校验 part、在副本之间传 part。S3 完全是另一回事：对象是不可变的，rename 不便宜，list 又慢又容易成瓶颈，小对象一多成本就上去了，每次远端 GET 都要付一个 RTT，它更擅长的是大文件的顺序读写。

所以数据在 S3 Disk 上待得久了，问题就一个个冒出来：S3 上还在 merge，GET、PUT、DELETE 请求数飙升；每个 part 拆成一堆小对象；Keeper 的元数据跟着 part 一起涨；新加一个副本初始化代价很大；S3 不可达还会影响启动；冷查询也越来越难管。

Parquet 方案就是干脆绕开这些机制，S3 就当 S3 用，文件就是文件。

## 三种方案的边界

把 S3 Disk、BACKUP、Parquet 放在一起比一比：

| 维度 | [S3 Disk](/clickhouse/cold-storage/s3-disk) | [BACKUP/RESTORE](/clickhouse/cold-storage/backup-restore) | S3 Engine + Parquet |
|---|---|---|---|
| 数据格式 | ClickHouse part | ClickHouse backup | Parquet |
| 是否在线查 | 可以 | 先 RESTORE | 可以 |
| 跨引擎读取 | 弱 | 弱 | 强 |
| Mutation | 支持但很贵 | 不适用 | 不支持 |
| Merge | 后台自动 | 不适用 | 没有 |
| 元数据压力 | 仍在 ClickHouse 主线 | DROP 后释放 | 脱离主线 |
| 适合场景 | 在线冷查 | 超冷合规归档 | 开放冷数据、跨引擎 |

冷数据偶尔在线查，又不想改架构，先用 S3 Disk；冷数据几乎不查，只为合规留着，用 BACKUP/RESTORE；冷数据还要查，还要给好几个引擎用，再考虑 Parquet。

生产上也可以组合着来：

```text
< 30 天       本地 NVMe
30~90 天      S3 Disk
90 天~1 年    Parquet on S3
> 1~3 年      BACKUP 到 Glacier / Deep Archive
```

每一层用最合适的工具，没必要一套方案用到底。

## 基本架构

流程是这样的：

```text
热表 MergeTree
    ↓ 定时导出
S3 上的 Parquet 文件
    ↓
ClickHouse S3 Engine / s3Cluster 查询
    ↓
Spark / Trino / DuckDB / Python 复用
```

冷数据不归 MergeTree 管了，ClickHouse 只在查询的时候去读 Parquet。

一个典型的视图：

```sql
CREATE OR REPLACE VIEW logs_archive AS
SELECT *
FROM s3Cluster(
    'default',
    'https://bucket.s3-internal.example.com/archive/logs/**/*.parquet',
    'Parquet'
)
SETTINGS use_hive_partitioning = 1;
```

路径如果是 Hive 风格的：

```text
s3://bucket/archive/logs/year=2024/month=04/day=27/part-0001.parquet
```

开着 `use_hive_partitioning = 1`，ClickHouse 能从路径里认出 `_year`、`_month`、`_day` 这些虚拟列（名字前面带下划线），查询带上这些条件，就能少扫很多不相干的 prefix。新版本里这个设置默认就是开的。

## 联合视图，让业务少操心分层

业务方不应该去记「90 天以内查热表，90 天以外查归档表」这种事。可以建一个统一的视图：

```sql
CREATE OR REPLACE VIEW logs AS
SELECT event_time, user_id, event_type, payload
FROM logs_hot
WHERE event_time > today() - 90
UNION ALL
SELECT event_time, user_id, event_type, payload
FROM logs_archive
WHERE event_time <= today() - 90;
```

两个子查询都得写上时间边界，优化器才有机会把不相干的那一支跳过去。

生产上最好再加一层查询网关或者 SQL 模板，强制冷查询带时间条件。不然 `**/*.parquet` 一扫就是一大片 list，Parquet 方案也会被用坏。

## 怎么导出

最简单的是 `INSERT INTO FUNCTION s3()`：

```sql
INSERT INTO FUNCTION s3(
    'https://bucket.s3-internal.example.com/archive/logs/year=2024/month=04/day=27/data_{_partition_id}.parquet',
    'Parquet'
)
SETTINGS
    s3_create_new_file_on_insert = 1,
    output_format_parquet_compression_method = 'zstd',
    output_format_parquet_row_group_size = 1048576
SELECT
    event_time,
    user_id,
    event_type,
    payload
FROM logs_hot
WHERE toDate(event_time) = '2024-04-27'
ORDER BY user_id, event_time;
```

导出前的 `ORDER BY` 很重要。常见的查询要是这样的：

```sql
WHERE user_id = 'xxx'
  AND event_time BETWEEN ... AND ...
```

那导出时就按 `user_id, event_time` 排序，Parquet 每个 row group 的 min/max 范围会更集中，跳过无关 row group 的机会就大。

导出也别直接往正式路径里写。稳一点的做法是先写到 tmp 路径，校验行数、大小，抽几条数据看看，给这一批打上成功的标记，再挪到或者登记到正式路径上，最后校验都过了，才去 DROP 热表的分区。S3 上没有真正便宜的 rename，数据量大的时候，用「写到临时 prefix 再放一个成功标记文件」的办法，别一个个文件去 mv。

## 文件怎么组织，决定了查得快不快

Parquet 方案好不好用，主要看文件是怎么组织的。

路径用 Hive 风格，比如 `archive/logs/year=2024/month=04/day=27/`。单个文件控制在 128MB 到 512MB，太小了 list 慢、对象多，太大了并行度上不去，失败重试也麻烦。row group 可以先从 100 万行左右开始，再按字段宽度和查询方式去调。按常用的过滤字段排序，审计按用户查就按 `user_id, event_time`，日志按服务查就按 `service, event_time`。压缩用 zstd，压缩率和读取性能之间比较平衡，也是 ClickHouse 导出 Parquet 的默认值。还有，别让 `**/*.parquet` 不带条件地全扫，视图是方便了业务，可查询还是得要求带时间范围或者分区条件。

## 查询相关的设置

冷查询可以单独配一个 profile：

```xml
<profiles>
  <archive_query>
    <use_hive_partitioning>1</use_hive_partitioning>
    <input_format_parquet_filter_push_down>1</input_format_parquet_filter_push_down>
    <input_format_parquet_max_block_size>65536</input_format_parquet_max_block_size>

    <s3_max_get_rps>200</s3_max_get_rps>

    <max_threads>8</max_threads>
    <max_memory_usage>10000000000</max_memory_usage>
    <max_bytes_before_external_group_by>5000000000</max_bytes_before_external_group_by>
  </archive_query>
</profiles>
```

`input_format_parquet_filter_push_down` 是关键，它根据 WHERE 条件跳过整个 row group，新版本里默认就开着。以前有人在 profile 里写 `s3_max_connections`，这个设置在新版本里已经标成废弃了，写了也不起作用，我就从上面去掉了。

native Parquet reader 这块还在变。旧的 `input_format_parquet_use_native_reader` 在文档里查得到，但功能一直没做完，新版本实验性的 native reader 走的是带 `_v3` 后缀的设置。生产上别依赖某个版本的 native reader 开关，用哪个版本就去看哪个版本的 release notes。

另外，S3 表引擎在新一些的版本里也能用本地的 filesystem cache，可以按文档开 `enable_filesystem_cache`、`filesystem_cache_name` 这些设置。所以 Parquet 方案也不是完全没缓存，只是它的缓存跟 S3 Disk 的 cache disk 不是一回事。

## 好处

好处很直接。没有 part 的 merge 了，没有 ReplicatedMergeTree 的副本同步了，冷数据也不再拖累 Keeper 的元数据，S3 上的对象数能降下来不少。Spark、Trino、DuckDB、Python 都能读，数据的生命周期也可以交给 S3 Lifecycle 或者数据湖的治理系统去管。

110TB 这个量级的数据，Parquet 加 zstd 往往比多副本的 ClickHouse part 省不少存储。具体省多少要看字段类型、压缩算法、排序方式和副本数，没法一概而论，但省下 30% 到 60% 并不少见。

更要紧的是开放。S3 Disk 里的数据是 ClickHouse 的，Parquet 里的数据才是业务自己的。

## 代价

Parquet 也不是什么都好，它会带来新的工程负担。

首先没有 ACID。导出到一半失败了，可能留下半批文件，所以 tmp 路径、成功标记、批次台账、幂等重跑一样都少不了。

它也不支持 mutation。Parquet 文件一般是按分区整个重写，适合只追加的日志、审计、行为数据，不适合经常 UPDATE、DELETE 的。

schema 演进得有人管。热表加了列，老的 Parquet 文件里没有这列，读取这一层得能接受缺的字段是 NULL，数据字典和 schema 的版本也得记下来。

list S3 照样会慢。路径组织得不好，或者查询不带分区条件，还是会扫一大堆 prefix。

查询也照样得管。Parquet 能少读一些没用的数据，可挡不住用户不带条件地全表扫，冷查询该限流还得限流，该限并发、限时间范围的也一样。

## 从 S3 Disk 迁过来

别一口气切过去，分三步走。

第一步是旁路导出。原来的 S3 Disk 路径不动，加一个定时任务，把每天的冷数据导出成 Parquet。这一步不是为了马上切流，是为了验证：行数对不对得上，schema 兼不兼容，查询结果一不一致，文件大小合不合理，常见的查询有没有变快或者变稳。

第二步是用联合视图灰度。建好 `UNION ALL` 视图，让一部分只读查询走 Parquet。先切审计、离线分析、低频的查询，核心的线上看板放到最后。

第三步才是释放 S3 Disk 上的数据。确认 Parquet 这边能用了，再去清理 S3 Disk 上对应的分区。清理之前，Parquet 的台账要完整，行数要校验过，业务要已经切过来，恢复的路径要清楚，S3 Lifecycle 也要配好。

## 什么时候直接上 Iceberg

S3 Engine 加 Parquet，可以看成一个轻量版的湖仓。

要是已经碰上多个引擎并发写、需要 ACID 的表提交、要做分区演进、要快照和 time travel、要统一的 catalog，或者文件数和小文件合并已经需要系统地管起来了，光靠散落的 Parquet 文件就不够了。这时候该认真考虑 Iceberg、Hudi、Delta Lake 这类开放表格式。

ClickHouse 继续管热数据和高性能的 OLAP 查询，冷数据进 Iceberg，由 Spark、Trino、ClickHouse 这些引擎一起用。

## 最后

S3 Disk 是从本地盘走向对象存储的第一步，它保住了 ClickHouse 的使用体验，也把 MergeTree 的复杂性一起带到了对象存储上。

Parquet 是另一条路，不再把 S3 装成本地盘，就老老实实拿它存大文件、开放格式和长期数据。冷数据还要在线查、要给别的团队用、又不想再给主集群的元数据添压力，S3 Engine 加 Parquet 是条很实在的路。

这么做也不是要替掉 ClickHouse，是让它回去干它最擅长的事：管热数据，扛高性能的查询。冷数据是业务的，没必要一直锁在某个引擎的内部格式里。
