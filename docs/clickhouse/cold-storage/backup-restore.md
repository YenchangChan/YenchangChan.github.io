---
title: 超冷归档：BACKUP/RESTORE 为什么适合金融政企
---

# 超冷归档：BACKUP/RESTORE 为什么适合金融政企

> 互联网团队默认冷数据还要在线查。但在金融、政企、监管报送场景里，数据要留 7 年、一年查一两次、可以接受提单后 N 个工作日返回 —— 这是完全不同的一道题。
>
> **阅读对象**：有长期合规留存要求、冷数据查询频率极低、方案必须融入既有备份体系的团队。

---

## 引言

讨论 ClickHouse 冷热分层时，互联网团队通常默认一个前提：冷数据偶尔还要在线查。

但在金融、政企、运营商、监管报送等场景里，需求经常完全不同：

- 数据必须保留 5 年、7 年、10 年甚至更久
- 查询频率可能一年只有一两次
- 审计可以接受提单后 N 个工作日返回
- 方案必须能融入已有备份体系
- 归档结果要可追溯、可演练、可交接

在这种场景下，S3 Disk 和 Parquet 不一定是最优解。ClickHouse 原生 `BACKUP/RESTORE` 反而是一个经常被低估的方案。

它不解决在线查询性能问题。它解决的是另一个问题：**把必须保留但几乎不用的数据，从 ClickHouse 查询主线里剥离出去。**

---

## 一、BACKUP 不是冷热分层的替代品

先讲清楚边界。

S3 Disk、Parquet、BACKUP 解决的是不同问题：

| 方案 | 主要目标 | 查询方式 | 适合场景 |
|---|---|---|---|
| [S3 Disk](/clickhouse/cold-storage/s3-disk) | 低改造成本在线冷查 | 直接查 MergeTree | 冷数据偶尔在线查 |
| [S3 Engine + Parquet](/clickhouse/cold-storage/parquet) | 开放格式冷数据 | 直接扫 Parquet | 跨引擎、冷明细仍要查 |
| BACKUP/RESTORE | 超冷归档 | 先 RESTORE 再查 | 合规保留、极低频查询 |

BACKUP 的价值不在「查得快」，而在「让主集群瘦下来」。

如果一份数据 3 年都没人查，但因为合规必须保留 10 年，继续让它留在 MergeTree 主线里，就会长期消耗：

- ClickHouse 元数据
- Keeper/ZooKeeper 节点
- part 管理成本
- 备份扫描成本
- 启动和 ATTACH 风险

把它 BACKUP 出去，再 `DROP PARTITION`，反而更符合生命周期管理。

---

## 二、什么场景适合 BACKUP/RESTORE

可以按下面几个维度判断：

| 维度 | 适合 BACKUP | 不适合 BACKUP |
|---|---|---|
| 查询频率 | 一年几次 | 每月几次以上 |
| 响应时间 | 接受小时到天级 | 要求秒/分钟级 |
| 保留期 | 5 年以上 | 1 年以内 |
| 主要诉求 | 合规、可追溯、可恢复 | 在线分析 |
| 组织能力 | 有备份体系和演练流程 | 完全依赖查询平台 |
| 使用者 | DBA、审计、监管接口 | 业务分析师、BI 用户 |

从我接触过的金融、政企、运营商项目看，监管报送、风控日志、交易流水、审计留痕这类场景，经常更偏向 BACKUP/RESTORE，而不是 S3 Engine + Parquet。

这不是因为 BACKUP 技术更先进，而是因为这些组织的价值排序不同：

- 官方语法比自研导出更容易被接受
- RESTORE 演练比「在线可查」更重要
- 备份链、报表、审批、介质交接都是现有流程
- 查询慢可以接受，数据找不回来不能接受

---

## 三、基本语法

全量备份到 S3：

```sql
BACKUP TABLE db.t TO S3(
  'https://bucket.s3-internal.example.com/backup/2024-04-27/',
  'access_key',
  'secret_key'
);
```

> **注意**：BACKUP 命令的 SETTINGS 里**不要尝试用 `s3_storage_class`** 指定 Glacier 等存储类——根据 GitHub issue [#78737](https://github.com/ClickHouse/ClickHouse/issues/78737)，这个参数在 BACKUP 上下文中存在，但**实际不生效**（对象仍然写入 STANDARD 存储类）。要把备份对象转到 IA / Glacier 类，**用 S3 Lifecycle Rule 在 bucket 层面配置自动转换**——比如 0 天后转 IA、90 天后转 Glacier IR、365 天后转 Deep Archive，比依赖 ClickHouse 的 setting 可靠得多。

增量备份：

```sql
BACKUP TABLE db.t TO S3('s3://bucket/backup/2024-04-28/')
SETTINGS base_backup = S3('s3://bucket/backup/2024-04-27/');
```

按分区备份：

```sql
BACKUP TABLE db.t PARTITIONS '20240115', '20240116'
TO S3('s3://bucket/backup/partitions/...');
```

恢复到新表：

```sql
RESTORE TABLE db.t AS db.t_audit_2024
FROM S3('s3://bucket/backup/2024-04-27/');
```

只恢复某个分区：

```sql
RESTORE TABLE db.t PARTITIONS '20240115'
FROM S3('s3://bucket/backup/...');
```

生产中更推荐恢复到临时表或审计专用表，避免覆盖原表。

---

## 四、典型归档工作流

一个比较稳的月度归档流程如下：

```text
1. 选择 90 天前或更早的分区
2. BACKUP 对应分区到 S3
3. 查询 system.backups 或 backup_log 确认状态
4. 写入外部备份台账
5. 抽样校验或周期性 RESTORE 演练
6. 确认后 DROP PARTITION 释放主集群数据和元数据
```

伪代码：

```bash
#!/bin/bash
set -euo pipefail

ARCHIVE_PARTITION=$(date -d '91 days ago' +%Y%m%d)
BACKUP_PATH="s3://archive-bucket/clickhouse/logs/events/${ARCHIVE_PARTITION}/"

clickhouse-client --query "
  BACKUP TABLE logs.events PARTITIONS '${ARCHIVE_PARTITION}'
  TO S3('${BACKUP_PATH}', 'key', 'secret')
"
# 注：不在 SETTINGS 里指定 s3_storage_class（已知 issue #78737 实际不生效）
# 通过 bucket 层面的 S3 Lifecycle Rule 自动把对象转到 Glacier IR / Deep Archive

STATUS=$(clickhouse-client --query "
  SELECT status
  FROM system.backups
  WHERE name LIKE '%${ARCHIVE_PARTITION}%'
  ORDER BY start_time DESC
  LIMIT 1
")

if [ "$STATUS" = "BACKUP_CREATED" ]; then
  clickhouse-client --query "
    ALTER TABLE logs.events DROP PARTITION '${ARCHIVE_PARTITION}'
  "
else
  echo "Backup status is ${STATUS}, skip drop partition"
  exit 1
fi
```

这只是骨架。生产脚本必须补上台账、重试、告警、行数记录、权限控制和恢复演练。

---

## 五、S3 存储类怎么选

常见选择：

- **Standard-IA**：偶尔查，取回快，价格中等
- **Glacier Instant Retrieval**：极少查但希望秒级取回
- **Glacier Flexible Retrieval**：分钟到小时级取回
- **Glacier Deep Archive**：12 到 48 小时取回，长期保留最便宜

如果审计 SLA 是「3 个工作日内出数」，Deep Archive 可能完全可接受。

如果业务方要求「当天恢复、当天查询」，Glacier IR 或 Standard-IA 更合适。

不要只看每 TB 每月价格，还要算：

- 取回费用
- 跨区流量
- 恢复演练成本
- 合规保留副本数
- 备份链管理成本

---

## 六、最大硬伤：ClickHouse 没有完整备份台账

ClickHouse 有 `system.backups`、`system.backup_log` 这类信息入口，但它们更像「操作日志」，不是完整的长期备份台账。

它们通常不能直接回答这些问题：

- 2023 年 3 月 15 日的分区备份在哪里？
- 这个分区备份过几次？
- 哪次备份通过了 RESTORE 演练？
- 备份路径对应哪个 shard、哪个 replica？
- 原节点下线后，应该从哪个 S3 path 恢复？

生产上必须建外部台账。

示例结构：

```sql
CREATE TABLE backup_catalog (
  table_name String,
  partition_id String,
  backup_path String,
  backup_size UInt64,
  row_count UInt64,
  backup_time DateTime,
  status Enum('success' = 1, 'failed' = 2, 'verified' = 3),
  base_backup_path String,
  checksum String,
  source_shard String,
  source_replica String
) ENGINE = MergeTree
ORDER BY (table_name, partition_id, backup_time);
```

台账里最关键的是完整 S3 path。不要只保存 backup id。backup id 往往和发起节点、系统表记录绑定，原节点下线后很容易查不到。

---

## 七、集群级 BACKUP 的取舍

`BACKUP TABLE db.t ON CLUSTER xxx` 看起来最省事，但大集群里不一定最好排障。

它的问题是：

- 多节点并发写 S3，失败状态更复杂
- 任一节点失败都可能让整体状态难判断
- 每个节点的系统表记录不完全等价
- 多副本各备一份会浪费存储和流量

很多生产做法是：**按 shard 选择一个备份副本**，只备一份本地表数据。

选副本时可以考虑：

- `system.replicas.absolute_delay`
- 当前查询负载
- 是否是业务主力副本
- S3 网络路径是否稳定

这样可以把多副本备份成本从 N 份降到 1 份。

代价是台账必须记录 shard 和 replica，并且恢复 SOP 要清楚「从哪一份备份恢复到哪里」。

---

## 八、工程化参考：开源工具 ch2s3

前面几节提到的硬伤——台账缺失、节点绑定、按 shard 选副本、md5 校验——都需要写不少胶水代码才能落地。已经有开源工具实现了一套相对完整的方案：[ch2s3](https://github.com/YenchangChan/ch2s3)。

它的核心设计正好对应这些硬伤的解法：

- **副本只备份一份**：每个 shard 选一个副本执行 BACKUP，避免 N 倍存储和流量
- **S3 path 编码 host 维度**：`{partition}/{database}.{table}/{host}/...` 这种结构，原节点下线后其他节点能精准接管恢复
- **表格化报表**：每次备份产出独立 reporter（含表名、行数、压缩前后大小、耗时、成功/失败状态、失败原因），归档到独立目录
- **md5 完整性校验**：补 ClickHouse 没有 `CHECK BACKUP` 的能力（multipart 场景的代价见下一节）
- **按分区滚动 + TTL 调度**：cron 友好，支持失败按分区补跑

整体思路是**把 ClickHouse 原生 `BACKUP TO S3` 做工程加固**，而不是重新发明轮子。如果你打算自建 BACKUP 工具，可以从它的 path 设计、副本选择、md5 校验等细节里借鉴——这些坑已经踩过验证过。

---

## 九、校验：没 RESTORE 过的备份不算备份

`status = BACKUP_CREATED` 只能说明备份过程成功结束，不等于未来一定能恢复。

真正可靠的验证是周期性 RESTORE：

```sql
RESTORE TABLE db.t AS db.t_verify
FROM S3('s3://bucket/backup/...');

SELECT count() FROM db.t_verify;
SELECT min(event_time), max(event_time) FROM db.t_verify;

DROP TABLE db.t_verify;
```

建议：

- 试运行第一周做强校验
- 稳定后改成文件数、size、行数等轻校验
- 每季度做一次 RESTORE 演练
- ClickHouse 大版本升级后重新做强校验和恢复演练
- S3 backend、备份工具、密钥体系变更后重新演练

**md5 校验的特殊代价**——这一点经常被忽视：ClickHouse BACKUP 通过 S3 SDK 上传，超过 5MB 的对象自动走 multipart upload。**multipart 对象的 ETag 不是整体文件的 md5**，而是 `<md5_of_part_md5s>-<part_count>` 这种拼接格式（ETag 里出现 `-` 就说明是分段上传），**没法直接和本地文件的 md5 对比**。

想真正校验 multipart 对象的内容一致性，**只能把整个对象 GET 下来重算 md5**：

- 100GB 备份的强校验 = 一次完整 100GB 下载 + 本地哈希计算
- S3 出口流量翻倍（上传一份 + 下载一份），账单同步翻倍
- 校验耗时往往和备份耗时同量级

工具层很难绕过——上传方是 ClickHouse 内部，工具拿不到上传过程中各 part 的 md5，也没法在上传时主动指定 `Content-MD5` 让 S3 服务端代为验证。**这条路上没有「廉价 md5 校验」**。

所以长期策略应该是：早期强校验建立信任，日常轻校验（文件数 + size）做监控，季度 RESTORE 做端到端验证。md5 校验只适合「建立信任阶段的短期密集自我验证」——长期开等于每天把备份做两遍，存储成本和运维成本都会爆炸。

---

## 十、更保守的变体：导出 CSV/Parquet 到 NAS

有些场景甚至不想依赖 ClickHouse BACKUP 格式。

比如：

- 监管或审计方希望拿到 CSV
- 企业已有 NAS/磁带库/备份软件流程
- 数据十年后还要能被任何工具读
- 不希望恢复依赖 ClickHouse 版本

这时可以选择定时导出：

```bash
#!/bin/bash
set -euo pipefail

DATE=$(date -d '91 days ago' +%Y-%m-%d)
NAS_PATH="/mnt/nas/clickhouse-archive/$(date +%Y/%m)"

mkdir -p "$NAS_PATH"

clickhouse-client --query "
  SELECT *
  FROM logs.events
  WHERE toDate(event_time) = '${DATE}'
  FORMAT CSVWithNames
" | gzip > "${NAS_PATH}/events_${DATE}.csv.gz"
```

这种方案听起来原始，但在合规场景里有现实价值：

- CSV/Parquet 是开放格式
- 第三方能直接验收
- 不依赖 ClickHouse RESTORE
- 能接入既有备份软件

代价也明显：schema 需要单独管理，恢复查询性能差，压缩和类型信息不如 ClickHouse 原生格式。

选择它不是因为技术能力弱，而是因为组织要求「可交接、可长期读取、可被非 ClickHouse 团队理解」。

---

## 十一、落地清单

做 BACKUP/RESTORE 归档前，至少准备这些东西：

- 归档分区规则
- S3 path 命名规范
- 外部备份台账
- 每次备份报表
- 失败重试策略
- DROP PARTITION 前置校验
- RESTORE 演练 SOP
- 密钥和 KMS 管理
- 跨节点恢复演练
- 备份链清理策略
- Glacier 取回流程
- 业务提单和审批流程

其中最容易被低估的是 RESTORE 演练。

备份脚本跑成功，只是归档流程的前半段。真正发生审计或监管查询时，能否在约定 SLA 内恢复出来，才是方案是否成立的标准。

---

## 结语

BACKUP/RESTORE 不适合所有冷数据。

如果用户每天都要查冷明细，它太慢；如果数据要给 Spark、Trino、DuckDB 共用，它不开放；如果查询 SLA 是分钟级，它也不合适。

但在「必须保留、几乎不查、要求合规可追溯」的超冷场景里，它非常务实。

它的关键不是写一条 `BACKUP TO S3`，而是建立完整工程体系：台账、报表、校验、演练、恢复、介质和权限。

对金融、政企、运营商这类组织来说，能被审计、能恢复、能交接，往往比「在线可查」更重要。
