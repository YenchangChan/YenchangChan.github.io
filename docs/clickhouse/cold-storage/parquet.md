---
title: 从 S3 Disk 到 Parquet：冷数据为什么要脱离主线
---

# 从 S3 Disk 到 Parquet：冷数据为什么要脱离主线

> S3 Disk 的思路是让 ClickHouse 把 S3 当一块慢盘，代价是把 MergeTree 的整套机制都带到了对象存储上：part、merge、mutation、副本、启动校验。换个思路 —— 不让 ClickHouse 管冷数据。
>
> **阅读对象**：冷数据规模还在涨、已经开始拖累主集群，或者冷数据需要被 ClickHouse 以外的引擎读取的团队。

---

## 引言

S3 Disk 的核心思路是：让 ClickHouse 把 S3 当成一块慢盘。

这个思路改造成本低，但也把 MergeTree 的一整套机制带到了对象存储上：part、merge、mutation、副本、metadata、启动校验、list/delete。

当冷数据规模继续增长，很多团队会遇到一个问题：冷数据明明很少查，却还在拖累 ClickHouse 主集群；或者冷数据仍然要查，但查询模式已经不适合 MergeTree 主线。

这时可以换一个思路：**不要让 ClickHouse 管理冷数据，把冷数据导出成 Parquet 放在 S3 上。**

ClickHouse 仍然可以通过 S3 Engine 或 `s3()` 表函数查询它；Spark、Trino、DuckDB、Python 也可以直接读它。

这不是为了追求新概念，而是为了把数据从某个引擎的内部格式里释放出来。

---

## 一、S3 Disk 的问题从哪里来

S3 Disk 的几乎所有坑，都来自一句话：

> ClickHouse 试图把 S3 当本地盘用。

MergeTree 在本地盘上工作得很好，因为本地盘适合：

- 频繁创建和删除小文件
- merge part
- 随机读 mark 和列文件
- 快速校验 part
- 副本之间传输 part

S3 的模型完全不同：

- 对象是不可变语义
- rename 不便宜
- list 慢且容易成为瓶颈
- 小对象多了成本很高
- 每次远端 GET 都有 RTT
- 对象存储更适合大文件顺序读写

所以当数据长期留在 S3 Disk 上时，常见问题会逐步出现：

- S3 上继续 merge，GET/PUT/DELETE 飙升
- 每个 part 拆成大量小对象
- Keeper/ZooKeeper 元数据随 part 增长
- 新副本初始化成本很高
- S3 不可达影响启动
- 冷查询治理越来越复杂

Parquet 方案的本质是绕开这些机制：S3 就是 S3，文件就是文件。

---

## 二、三种方案的边界

先把 S3 Disk、BACKUP、Parquet 放在一张表里（前两个方案分别在系列第一、第三篇展开）：

| 维度 | [S3 Disk](/clickhouse/cold-storage/s3-disk) | [BACKUP/RESTORE](/clickhouse/cold-storage/backup-restore) | S3 Engine + Parquet |
|---|---|---|---|
| 数据格式 | ClickHouse part | ClickHouse backup | Parquet |
| 是否在线查 | 可以 | 先 RESTORE | 可以 |
| 跨引擎读取 | 弱 | 弱 | 强 |
| Mutation | 支持但很贵 | 不适用 | 不支持 |
| Merge | 后台自动 | 不适用 | 没有 |
| 元数据压力 | 仍在 ClickHouse 主线 | DROP 后释放 | 脱离主线 |
| 适合场景 | 在线冷查 | 超冷合规归档 | 开放冷数据、跨引擎 |

简单判断：

- 冷数据偶尔在线查，且不想改架构：先用 S3 Disk
- 冷数据几乎不查，只为合规保留：用 BACKUP/RESTORE
- 冷数据仍要查，还要给多引擎使用：考虑 Parquet

生产里也可以组合：

```text
< 30 天       本地 NVMe
30~90 天      S3 Disk
90 天~1 年    Parquet on S3
> 1~3 年      BACKUP 到 Glacier / Deep Archive
```

每层用最合适的工具，而不是一套方案打到底。

---

## 三、Parquet 方案的基本架构

核心流程：

```text
热表 MergeTree
    ↓ 定时导出
S3 上的 Parquet 文件
    ↓
ClickHouse S3 Engine / s3Cluster 查询
    ↓
Spark / Trino / DuckDB / Python 复用
```

冷数据不再由 MergeTree 管理。ClickHouse 只在查询时读取 Parquet。

一个典型视图：

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

如果路径是 Hive 风格：

```text
s3://bucket/archive/logs/year=2024/month=04/day=27/part-0001.parquet
```

配合 `use_hive_partitioning = 1`，ClickHouse 可以从路径里识别 `year`、`month`、`day` 等虚拟列，从而减少无关 prefix 的扫描。

---

## 四、联合视图：让业务少感知分层

业务不应该记住「90 天内查热表，90 天外查归档表」。

可以建一个统一视图：

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

关键是两个子查询都写上时间边界。这样查询优化器有机会跳过不相关分支。

实际生产里建议再加查询网关或 SQL 模板，强制冷查询带时间条件。否则 `**/*.parquet` 会触发大范围 list，Parquet 方案也会被用坏。

---

## 五、如何导出 Parquet

最简单的方式是 `INSERT INTO FUNCTION s3()`：

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

导出前 `ORDER BY` 很重要。

如果常见查询是：

```sql
WHERE user_id = 'xxx'
  AND event_time BETWEEN ... AND ...
```

那么导出时按 `user_id, event_time` 排序，可以让 Parquet row group 的 min/max 范围更集中，提升跳过无关 row group 的概率。

导出流程不要直接写正式路径。更稳的做法是：

```text
1. 写入 tmp 路径
2. 校验行数、大小、抽样数据
3. 标记本批次成功
4. 再移动或注册到正式路径
5. 校验通过后再 DROP 热表分区
```

S3 上没有真正便宜的 rename，大规模场景可以用「写临时 prefix + 成功标记文件」的方式，而不是逐文件 mv。

---

## 六、文件组织决定查询性能

Parquet 方案好不好用，主要取决于文件组织。

推荐规则：

1. **Hive 风格路径**

```text
archive/logs/year=2024/month=04/day=27/
```

2. **单文件大小 128MB ~ 512MB**

太小会 list 慢、对象数多；太大并行度低，也不利于失败重试。

3. **Row group 大小按查询模式调整**

可以从 100 万行左右开始，根据字段宽度和查询模式调优。

4. **按常见过滤字段排序**

审计按用户查，就按 `user_id, event_time`；日志按服务查，就按 `service, event_time`。

5. **压缩用 zstd**

zstd 通常能在压缩率和读取性能之间取得较好平衡。

6. **避免全局 `**/*.parquet` 无条件扫描**

视图可以方便业务，但查询治理仍然必须要求时间范围或分区条件。

---

## 七、查询优化设置

冷查询 profile 可以单独配置：

```xml
<profiles>
  <archive_query>
    <use_hive_partitioning>1</use_hive_partitioning>
    <input_format_parquet_filter_push_down>1</input_format_parquet_filter_push_down>
    <input_format_parquet_max_block_size>65536</input_format_parquet_max_block_size>

    <s3_max_get_rps>200</s3_max_get_rps>
    <s3_max_connections>32</s3_max_connections>

    <max_threads>8</max_threads>
    <max_memory_usage>10000000000</max_memory_usage>
    <max_bytes_before_external_group_by>5000000000</max_bytes_before_external_group_by>
  </archive_query>
</profiles>
```

> 关于 native Parquet reader：旧的 `input_format_parquet_use_native_reader` 这个名字虽然能在文档里查到，但实际功能并未完成，新版本中实验性 native reader 走的是 `_v3` 后缀的 setting（25.x 起）。生产中**不要依赖某个特定版本的 native reader 开关**——版本演进还在进行，按当前 ClickHouse 版本的 release notes 确认。

`input_format_parquet_filter_push_down` 是关键，它让 WHERE 条件尽量下推到 Parquet 读取层。

另外，S3 表引擎在较新版本中也支持本地 filesystem cache 相关能力，可以按版本文档启用 `enable_filesystem_cache`、`filesystem_cache_name` 等配置。不要把 Parquet 方案简单理解成「完全无缓存」，只是它的缓存和 S3 Disk 的 cache disk 不是同一个心智模型。

---

## 八、优势

Parquet 方案的优势很直接：

- 不再有 ClickHouse part merge
- 不再有 ReplicatedMergeTree 副本同步
- 冷数据不再拖累 Keeper 元数据
- S3 对象数可以显著下降
- Spark、Trino、DuckDB、Python 都能读
- 数据生命周期可以交给 S3 Lifecycle 或数据湖治理系统

对 110TB 级别的数据，Parquet + zstd 往往能比多副本 ClickHouse part 节省不少存储。具体比例取决于字段类型、压缩算法、排序方式和副本数，不能一概而论，但 30%~60% 的存储改善并不少见。

更重要的是开放性。

S3 Disk 里的数据属于 ClickHouse；Parquet 里的数据属于业务。

---

## 九、代价

Parquet 不是银弹。

它会带来新的工程负担：

### 没有 ACID

导出过程中失败，可能留下半批文件。必须有 tmp 路径、成功标记、批次台账和幂等重跑。

### 不支持 mutation

Parquet 文件通常按分区整体重写。适合 append-only 日志、审计、行为数据，不适合频繁 UPDATE/DELETE。

### Schema 演进要管

热表加列后，老 Parquet 文件没有新列。读取层要能接受缺失字段为 NULL，数据字典和 schema 版本也要记录。

### List S3 仍然会慢

路径组织不好，或者查询不带分区条件，仍然会扫大量 prefix。

### 查询治理仍然必要

Parquet 可以减少不必要读取，但挡不住用户无条件全表扫。冷查询仍然要限流、限并发、限时间范围。

---

## 十、从 S3 Disk 迁移到 Parquet

不要一次性切换。

推荐三阶段：

### 阶段一：旁路导出

保持原 S3 Disk 路径不变，新增定时任务，把每天的冷数据导出成 Parquet。

目标不是立刻切流，而是验证：

- 行数是否一致
- schema 是否兼容
- 查询结果是否一致
- 文件大小是否合理
- 常见查询是否变快或更稳定

### 阶段二：联合视图灰度

建 `UNION ALL` 视图，让部分只读查询走 Parquet。

先切审计、离线分析、低频查询，不要先切核心线上看板。

### 阶段三：释放 S3 Disk 数据

确认 Parquet 数据可用后，再清理对应 S3 Disk 分区。

清理前要确认：

- Parquet 台账完整
- 行数校验通过
- 业务已经切流
- 恢复路径明确
- S3 Lifecycle 已配置

---

## 十一、什么时候直接上 Iceberg

S3 Engine + Parquet 可以理解成轻量版湖仓。

如果你已经遇到下面的问题，单纯散文件 Parquet 可能不够：

- 多引擎并发写入
- 需要 ACID 表提交
- 需要分区演进
- 需要快照和 time travel
- 需要统一 catalog
- 文件数量和小文件合并需要系统治理

这时应该认真考虑 Iceberg、Hudi、Delta Lake 这类开放表格式。

ClickHouse 可以继续负责热数据和高性能 OLAP 查询；冷数据进入 Iceberg，由 Spark/Trino/ClickHouse 等多个引擎共享。

---

## 结语

S3 Disk 是从本地盘走向对象存储的第一步。它保留了 ClickHouse 的使用体验，也继承了 MergeTree 在对象存储上的复杂性。

Parquet 是另一种思路：不再把 S3 伪装成本地盘，而是承认 S3 就适合存大文件、开放格式和长期数据。

如果冷数据仍然要在线查、要跨团队复用、要脱离 ClickHouse 主集群的元数据压力，S3 Engine + Parquet 是一条务实的路线。

它不是为了替代 ClickHouse，而是为了让 ClickHouse 回到自己最擅长的位置：管理热数据、服务高性能查询。

冷数据应该属于业务，不应该永久锁在某个引擎的内部格式里。
