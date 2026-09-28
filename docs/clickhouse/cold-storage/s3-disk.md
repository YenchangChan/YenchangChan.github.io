---
title: S3 Disk：把对象存储当慢盘用，会遇到什么
---

# S3 Disk：把对象存储当慢盘用，会遇到什么

> ClickHouse 原生冷热分层的改造成本最低 —— 表还是 MergeTree，SQL 一行不用动，TTL 就能下沉。问题也来自这里：S3 不是慢盘，规模一上来，很多默认行为都会变成坑。
>
> **阅读对象**：正在用或准备用 S3 Disk 做冷热分层，数据量在几十 TB 以上的工程师。

---

## 引言

ClickHouse 做日志、监控、行为分析和审计时，最常见的矛盾是：近期数据要查得快，历史数据又不能删。

全部放本地 NVMe，成本很快失控；全部放对象存储，查询延迟和稳定性又扛不住。于是很多团队会选择 ClickHouse 原生的 S3 Disk，用 storage policy 把数据从热盘逐步下沉到 S3。

S3 Disk 的优势是改造成本低：表仍然是 MergeTree，查询 SQL 基本不变，TTL 规则就能做冷热迁移。

它的问题也来自这里：ClickHouse 试图把 S3 包装成一块「慢盘」。S3 不是本地盘，没有低延迟随机 IO，没有便宜的 rename/list/delete，也不适合频繁 merge。规模一上来，很多默认行为都会变成坑。

本文只讨论 S3 Disk 这条路线：它怎么工作，生产上最容易踩哪些坑，以及应该如何治理。

---

## 一、S3 Disk 是怎么工作的

ClickHouse 的存储抽象有三层：

- **Disk**：物理存储抽象，可以是本地目录、S3、HDFS 等
- **Volume**：一个或多个 Disk 的逻辑组合
- **Storage Policy**：Volume 的有序集合，决定数据在不同层级之间怎么流转

典型冷热分层配置如下：

```xml
<storage_configuration>
  <disks>
    <hot>
      <path>/data/ch/hot/</path>
    </hot>
    <warm>
      <path>/data/ch/warm/</path>
    </warm>
    <s3_cold>
      <type>s3</type>
      <endpoint>https://bucket.s3-internal.example.com/cluster1/</endpoint>
      <metadata_path>/data/ch/s3_meta/</metadata_path>
      <access_key_id>xxx</access_key_id>
      <secret_access_key>xxx</secret_access_key>
    </s3_cold>
    <s3_cached>
      <type>cache</type>
      <disk>s3_cold</disk>
      <path>/data/ch/s3_cache/</path>
      <max_size>500Gi</max_size>
    </s3_cached>
  </disks>

  <policies>
    <tiered>
      <volumes>
        <hot><disk>hot</disk></hot>
        <warm><disk>warm</disk></warm>
        <cold>
          <disk>s3_cached</disk>
          <prefer_not_to_merge>true</prefer_not_to_merge>
        </cold>
      </volumes>
      <move_factor>0.1</move_factor>
    </tiered>
  </policies>
</storage_configuration>
```

表上配置 TTL：

```sql
CREATE TABLE logs (...)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (user_id, event_time)
SETTINGS storage_policy = 'tiered'
TTL
  event_time + INTERVAL 7 DAY  TO VOLUME 'warm',
  event_time + INTERVAL 30 DAY TO VOLUME 'cold',
  event_time + INTERVAL 365 DAY DELETE;
```

S3 Disk 的关键细节是：ClickHouse 的 part 在 S3 上仍然是一组 ClickHouse 文件，包括 `.bin`、`.mrk2`、`.idx`、`checksums.txt`、`columns.txt` 等。`metadata_path` 存在本地，维护「逻辑文件名 -> S3 object key」的映射。

这带来三个直接后果：

- 本地 `metadata_path` 是关键数据，丢了就很难恢复
- part 数量越多，S3 对象数量越多，list/delete/backup 成本越高
- 启动、ATTACH、校验时可能访问 S3 上的 part 自描述文件

生产上通常还会在 S3 Disk 上叠一层 `cache` disk。反复查询同一段冷数据时，cache 命中率基本决定体验；如果只是合规归档、几乎不查，cache 的价值就有限。

整个 Storage Policy 的数据流向如下：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/s3-disk-01.light.svg" alt="一、S3 Disk 是怎么工作的">
<img class="dfig-d" src="/diagrams/s3-disk-01.dark.svg" alt="一、S3 Disk 是怎么工作的">
</figure>

数据按时间逐层下沉，查询按需打到对应层。**冷查询的体验是这套方案能不能用的关键**——如果 cache 命中率低，冷查询就回到了「裸打 S3」的痛苦体验，下面「坑二」会专门展开。

---

## 二、S3 Disk 的甜点区

S3 Disk 适合什么场景？

比较典型的是：

- 数据规模在几十 TB 到 PB 以内
- 热数据仍在本地盘
- 冷数据偶尔回溯，但不是高频交互式查询
- 团队希望尽量保留 MergeTree 查询体验
- 暂时不想引入 Parquet/Iceberg/Trino/Spark 等额外体系

它的典型价值区间大致在 **100TB ~ 1PB**。

低于这个规模也能用，但更多是成本优化，不一定需要完整的工程化体系；高于这个规模，S3 Disk 的 merge、元数据、对象数、冷查询治理会逐步变成主要成本。

不要把这个区间理解成硬边界。真正决定选型的是查询频率、保留期、副本数、对象存储成本、运维团队能力，而不是单纯的数据量。

---

## 三、坑一：历史数据直接落冷盘，在 S3 上 merge

最常见的事故来自历史数据回灌。

业务规定 90 天前的数据进冷盘。新系统接入时，一次性导入一年前的历史数据。因为数据在 INSERT 时已经满足 TTL，ClickHouse 可能直接把它写到 cold volume。

如果写入批次又很小，S3 上会出现大量小 part。随后后台 merge 在 S3 上发生：

```text
GET 多个小 part -> 本地合并 -> PUT 大 part -> DELETE 小 part
```

结果就是 S3 GET/PUT/DELETE、网络带宽、对象数和账单一起上涨。

核心参数是：

```xml
<merge_tree>
  <perform_ttl_move_on_insert>0</perform_ttl_move_on_insert>
</merge_tree>
```

建议：

1. 关闭 insert 阶段直接 TTL move，让所有数据先进入热层
2. cold volume 上设置 `prefer_not_to_merge=true`
3. 历史回灌走专用本地表，先在本地把 part 合并到合理大小，再手动 MOVE 到 S3

冷盘上尽量不要 merge。S3 上的 merge 不是不能做，而是代价很容易失控。

---

## 四、坑二：冷查询打爆带宽和内存

冷数据查询慢，不只是因为 S3 慢，还因为查询模式通常不受控。

一个用户查 7 天历史明细，预估 70GB，看起来只是一次大查询，实际可能带来几个问题：

- S3 出口带宽被打满
- ClickHouse 读取大量远端对象
- 查询带全局 ORDER BY、GROUP BY 或 JOIN 时触发内存暴涨
- 客户端拉取慢，服务端 buffer 堆积
- 影响同集群其他热查询

70GB 扫描本身不一定导致 OOM。真正容易 OOM 的通常是：

- 全量 ORDER BY 没有 spill
- 高基数 GROUP BY 没有 spill
- JOIN 方式不合理
- 查询结果格式或客户端行为导致服务端 buffering
- 用户 profile 没有限制扫描量、内存和并发

治理要分三层。

第一层是 profile 硬限制：

```xml
<profiles>
  <restricted>
    <max_memory_usage>10000000000</max_memory_usage>
    <max_memory_usage_for_user>20000000000</max_memory_usage_for_user>
    <max_bytes_to_read>50000000000</max_bytes_to_read>
    <max_rows_to_read>2000000000</max_rows_to_read>
    <max_bytes_before_external_group_by>5000000000</max_bytes_before_external_group_by>
    <max_bytes_before_external_sort>5000000000</max_bytes_before_external_sort>
    <max_execution_time>1800</max_execution_time>
    <max_concurrent_queries_for_user>2</max_concurrent_queries_for_user>
    <max_threads>4</max_threads>
    <force_index_by_date>1</force_index_by_date>
    <force_primary_key>1</force_primary_key>
    <readonly>1</readonly>

    <constraints>
      <max_memory_usage>
        <max>10000000000</max>
      </max_memory_usage>
      <max_bytes_to_read>
        <max>50000000000</max>
      </max_bytes_to_read>
    </constraints>
  </restricted>
</profiles>
```

`constraints` 很关键，否则用户可能通过 `SETTINGS` 覆盖。

第二层是查询分流：

- 近实时查询走热表
- 趋势查询走预聚合表
- 大范围冷明细走异步导出
- 审计探索类查询走独立 reader 或查询网关

其中「异步导出」是把「用户实时查 100GB 冷数据」转成「批处理任务 + 离线下载」——SLA 从秒级降到小时级，但不影响生产集群。典型工作流：用户提单 → Airflow 跑 `INSERT INTO FUNCTION s3('s3://exports/.../result.parquet.gz', 'Parquet') SELECT ...` → 邮件通知下载链接。**关键设计**：结果流式写 S3 不经过客户端、按天 split 并行跑、`max_threads` 和 `s3_max_get_rps` 限速、输出 Parquet 而不是 CSV。

如果用户需要交互式探索（比如 BI 钻取），异步导出的体验仍然太差，还有第三种思路——**流式查询**：在查询代理层把大查询按时间维度自动拆成多个小查询，依次执行 + 流式拼接返回。7 天明细查询会被拆成 168 个 1 小时子查询，小并发执行；用户感知是「数据持续流入」，首字节秒级返回，可随时中断。

流式查询的适用边界：要求查询有「可分割维度」。`SELECT *` 明细 + 时间过滤、可加性聚合（SUM/COUNT/AVG/MIN/MAX）、`GROUP BY 时间维度`都适合；`DISTINCT count`、`quantile`、复杂 JOIN、全局 `ORDER BY` 拆不了或需要特殊处理。实现层次有 SDK 内嵌、代理网关、BI 工具层等几种，金融/政企倾向「在 chproxy 之外加一层查询拆分网关」统一管理。

三种思路按「用户耐心」和「查询模式」分级搭配：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/s3-disk-02.light.svg" alt="四、坑二：冷查询打爆带宽和内存">
<img class="dfig-d" src="/diagrams/s3-disk-02.dark.svg" alt="四、坑二：冷查询打爆带宽和内存">
</figure>

三种思路并不互斥，可以在不同业务线分别使用——预聚合对趋势分析最优，异步导出对合规批量查询最稳，流式查询对交互式探索体验最好。**关键是不要把「用户实时查冷数据」作为默认假设**，否则迟早撞上「坑二」。

第三层是网络和对象存储隔离：

- ClickHouse 使用专用 bucket、专用 endpoint、专用 IAM
- 冷查询用户单独限流
- S3 GET/PUT RPS 在 ClickHouse 侧和对象存储侧都要有限制

### 一个真实事故

某 110TB 集群发生过这样一起事故：审计本身设计了治理，但其他部门一个用户用普通账号查 7 天历史数据，预计返回 70GB。结果：

- ClickHouse 内存被打爆，触发 OOM
- 占满了 S3 出口带宽（公网，无专线）
- 影响了同机房其他部门访问 S3

事后分析有 4 项缺失：用户级 profile 没设 `max_memory_usage`、`max_bytes_to_read`；S3 走公网而非 VPC endpoint；没有 server 级 `s3_max_get_rps`；没有 `force_index_by_date` 允许全分区扫描。

修复优先级：

| 优先级 | 动作 | 工时 | 效果 |
|---|---|---|---|
| P0 | 给非核心用户加 `restricted` profile | 1 小时 | 立刻防 OOM |
| P0 | 加 server 级 `s3_max_get_rps` | 30 分钟 | 立刻防 S3 打爆 |
| P1 | 改 S3 endpoint 为 VPC endpoint | 半天 | 解决 80% 网络问题 |
| P1 | 加 quota 配额 | 1 小时 | 防止累积打爆 |
| P2 | `force_index_by_date = 1` + row policy | 1 天 | 拦住灾难查询 |
| P2 | 异步导出工具 | 1 周 | 引导大查询走正确路径 |
| P3 | 独立 reader 节点 | 2 周 | 彻底隔离 |

事故的核心教训是：**冷热分层不只是技术方案，更是治理问题**。再好的技术方案也防不住没有边界的用户。

---

## 五、坑三：S3 不可达导致启动卡住

S3 Disk 的一个典型风险是：S3 短暂不可达，本来只应该影响冷数据，结果 ClickHouse 重启时卡在启动阶段，热数据也不可用。

原因是启动过程中不只会做 access check，还可能在 part attach 阶段读取 S3 上的 `checksums.txt`、`columns.txt` 等 part 自描述文件。

应急上不要再依赖「改错 endpoint + `skip_access_check`」这类 22.x 时代的偏方。更稳的优先级是：

1. 23.8+ 提前启用 `async_load_databases=1`
2. 必要时物理移走表 SQL 元数据文件，让 server 先起来
3. S3 恢复后再显式 ATTACH

`skip_access_check` 只应理解为跳过启动时的 S3 access check，不应当作为 S3 完全不可达时的救援手段。

这个话题细节很多，单独放在系列第二篇：[《ClickHouse 启动期 S3 行为变迁与故障救援指南》](/clickhouse/troubleshooting/s3-unreachable-startup)。

---

## 六、坑四：副本各存一份，新增副本很贵

开源 ClickHouse 的 S3 Disk 仍然是 Shared-Nothing 思路。每个副本通常有自己的 S3 路径，ReplicatedMergeTree 的 part 同步仍然通过 Keeper 协调和 interserver HTTP 传输。

这意味着：

- 2 副本就是两份 S3 数据
- 新增副本时可能从源副本下载 part，再上传到新副本的 S3 路径
- 扩副本会消耗大量带宽、时间和对象存储请求

Zero-copy replication 曾经试图解决这个问题（多副本共享 S3 上同一份 part），但因为引用计数 bug，**ClickHouse 22.8+ 已默认禁用**（`allow_remote_fs_zero_copy_replication=0`），24.x 之后官方文档明确标记为「不推荐生产使用」。开源社区已经基本放弃这条路。

生产上更常见的选择是：

- 接受副本各存一份，换稳定性
- 副本数量在集群初始化时定好，避免频繁动态扩容
- 读扩展优先靠 shard、reader 节点、Distributed 查询层，而不是不断加副本
- 真正需要共享存储架构时，考虑 ClickHouse Cloud 的 SharedMergeTree 或其他存算分离系统

---

## 七、S3 Disk 参数清单

### 写入和 TTL

| 参数 | 类型 | 推荐 | 说明 |
|---|---|---|---|
| `perform_ttl_move_on_insert` | MergeTree setting | `0` | 历史数据不要 INSERT 时直接落冷盘 |
| `prefer_not_to_merge` | volume 选项 | `true`（仅冷盘）| 冷盘上不再 merge——见下方注意 |
| `merge_with_ttl_timeout` | MergeTree setting | 适当拉长（默认 14400s = 4h）| 控制 TTL merge 频率 |
| `max_data_part_size_bytes` | volume 选项 | 按业务设定 | 限制该 volume 上单个 part 的最大字节 |

> **关于 `prefer_not_to_merge`**：ClickHouse 官方文档对这个 setting 有明确警告——「You should not use this setting. It disables merging of data parts on this volume (this is harmful and leads to performance degradation).」。但在 **S3 cold volume** 这个特定语境下，社区仍然广泛使用它，因为 S3 上的 merge 代价（GET 旧 part + PUT 新 part + DELETE 旧 part）远高于「不 merge 带来的小文件成本」。使用它的前提是：part 数量本身可控（依赖前面提到的「先在本地合并好再 MOVE 到冷盘」流程）、查询模式不依赖大 part 的顺序扫描、能接受 part list 略多的副作用。**不要在热盘 / 温盘上开这个**。

### S3 限速

```xml
<s3>
  <s3_max_get_rps>500</s3_max_get_rps>
  <s3_max_get_burst>1000</s3_max_get_burst>
  <s3_max_put_rps>200</s3_max_put_rps>
</s3>
```

这是 ClickHouse 客户端侧自律限速。生产上还应配合查询入口限流和对象存储侧隔离。

### 缓存

```xml
<s3_cached>
  <type>cache</type>
  <disk>s3_cold</disk>
  <path>/data/ch/s3_cache/</path>
  <max_size>500Gi</max_size>
  <max_file_segment_size>8Mi</max_file_segment_size>
  <cache_on_write_operations>1</cache_on_write_operations>
  <enable_filesystem_cache_log>1</enable_filesystem_cache_log>
</s3_cached>
```

看命中率：

```sql
SELECT
  sum(hits) / (sum(hits) + sum(misses)) AS hit_ratio
FROM system.filesystem_cache_log
WHERE event_time > now() - INTERVAL 1 HOUR;
```

### 启动

```xml
<merge_tree>
  <async_load_databases>1</async_load_databases>
</merge_tree>
```

`async_load_databases` 是新版本最值得启用的启动优化之一。它不能修好 S3，但能避免某些表 attach 慢或失败时拖住整个 server。

---

## 八、监控要看什么

看哪些查询在拉 S3：

```sql
SELECT user, query_id,
       ProfileEvents['S3GetObject'] AS gets,
       formatReadableSize(ProfileEvents['ReadBufferFromS3Bytes']) AS s3_bytes,
       query_duration_ms / 1000 AS duration_s
FROM system.query_log
WHERE event_time > now() - INTERVAL 1 HOUR
  AND ProfileEvents['S3GetObject'] > 1000
ORDER BY gets DESC
LIMIT 20;
```

看内存压力：

```sql
SELECT user, max(memory_usage), avg(memory_usage)
FROM system.query_log
WHERE event_time > now() - INTERVAL 1 DAY
GROUP BY user
ORDER BY max(memory_usage) DESC;
```

看 S3 错误：

```sql
SELECT name, value, last_error_time, last_error_message
FROM system.errors
WHERE name LIKE 'S3_%';
```

除了 S3 字节数，还要盯住：

- `system.parts` 行数
- 单表 active part 数
- Keeper/ZooKeeper 节点数
- filesystem cache 命中率
- 冷查询用户的扫描量和失败率

---

## 九、什么时候不要继续补 S3 Disk

S3 Disk 能撑很久，但不是终局。

如果出现下面几类信号，就该考虑 BACKUP/RESTORE 或 Parquet/Iceberg 路线：

- 冷数据几乎不查，只是合规保留
- 保留期从 1 年拉到 5 年、7 年、10 年
- Keeper 元数据和 part 数开始成为瓶颈
- 大量数据要给 Spark、Trino、DuckDB 或其他团队使用
- 冷明细查询需要在线查，但 ClickHouse 主集群已经被拖累
- 运维大量时间花在 S3 Disk 的对账、缓存、启动、TTL 调度上

此时有两条常见出路：

- [**BACKUP/RESTORE**](/clickhouse/cold-storage/backup-restore)：适合超冷合规归档
- [**S3 Engine + Parquet**](/clickhouse/cold-storage/parquet)：适合冷数据仍要在线查、跨引擎使用

这两条路线分别放在系列第三篇和第四篇。

---

## 结语

S3 Disk 是一个优秀的过渡方案。它让 ClickHouse 用户用较低成本完成冷热分层，不必立刻引入复杂的数据湖体系。

但它的代价也很清楚：你仍然在用 MergeTree 的工作模型管理 S3 上的数据。merge、mutation、副本、part、metadata、启动校验，这些机制在本地盘上合理，在对象存储上都需要额外治理。

所以 S3 Disk 的正确心态不是「配置一个 storage policy 就结束」，而是把它当成一套需要查询治理、网络隔离、缓存策略、元数据保护和应急流程配合的生产系统。

如果冷数据仍然需要在线查，先把 S3 Disk 治理好；如果冷数据只是合规保留，就不要勉强放在查询主线上；如果冷数据要跨团队、跨引擎使用，就尽早把它转成开放格式。
