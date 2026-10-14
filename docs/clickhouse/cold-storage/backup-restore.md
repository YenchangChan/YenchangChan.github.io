---
title: BACKUP/RESTORE 超冷归档：为什么适合金融政企
---

# BACKUP/RESTORE 超冷归档：为什么适合金融政企

聊 ClickHouse 冷热分层的时候，互联网团队一般默认一个前提：冷数据偶尔还要在线查。

可到了金融、政企、运营商、监管报送这些场景，需求经常是另一回事。数据得留 5 年、7 年、10 年甚至更久；查询可能一年就一两次；审计提了单，几个工作日以后给结果也能接受；方案还得能放进已有的备份体系里；归档的东西要能追溯、能演练、能交接。

这种场景下，S3 Disk 和 Parquet 都不见得是最好的选择，ClickHouse 原生的 `BACKUP/RESTORE` 反而经常被低估。它不解决在线查询的性能，它干的是把那些必须留着、又几乎没人用的数据，从 ClickHouse 的查询主线里剥出去。

## BACKUP 不是冷热分层的替代品

先把边界说清楚。S3 Disk、Parquet、BACKUP 各管各的事：

| 方案 | 主要目标 | 查询方式 | 适合场景 |
|---|---|---|---|
| [S3 Disk](/clickhouse/cold-storage/s3-disk) | 低改造成本在线冷查 | 直接查 MergeTree | 冷数据偶尔在线查 |
| [S3 Engine + Parquet](/clickhouse/cold-storage/parquet) | 开放格式冷数据 | 直接扫 Parquet | 跨引擎、冷明细仍要查 |
| BACKUP/RESTORE | 超冷归档 | 先 RESTORE 再查 | 合规保留、极低频查询 |

BACKUP 的价值是让主集群瘦下来。

一份数据 3 年都没人查，可合规要求留 10 年。要是一直让它待在 MergeTree 里，ClickHouse 的元数据、Keeper 的节点、part 的管理、备份时的扫描、启动和 ATTACH 时的风险，都得跟着它一直耗着。把它 BACKUP 出去，再 `DROP PARTITION`，这些开销才算真正省下来。

## 什么场景适合

可以照着这几个维度对一下：

| 维度 | 适合 BACKUP | 不适合 BACKUP |
|---|---|---|
| 查询频率 | 一年几次 | 每月几次以上 |
| 响应时间 | 接受小时到天级 | 要求秒/分钟级 |
| 保留期 | 5 年以上 | 1 年以内 |
| 主要诉求 | 合规、可追溯、可恢复 | 在线分析 |
| 组织能力 | 有备份体系和演练流程 | 完全依赖查询平台 |
| 使用者 | DBA、审计、监管接口 | 业务分析师、BI 用户 |

从我接触过的金融、政企、运营商项目看，监管报送、风控日志、交易流水、审计留痕这些场景，往往更偏向 BACKUP/RESTORE，而不是 S3 Engine + Parquet。

倒不是 BACKUP 的技术多先进，是这些单位排优先级的方式不一样。官方语法比自己写的导出脚本更容易过审；能 RESTORE 回来比能在线查更要紧；备份链、报表、审批、介质交接本来就是他们现成的流程；查得慢可以忍，数据找不回来不行。

## 基本语法

全量备份到 S3：

```sql
BACKUP TABLE db.t TO S3(
  'https://bucket.s3-internal.example.com/backup/2024-04-27/',
  'access_key',
  'secret_key'
);
```

这里有个坑：别指望在 BACKUP 的 SETTINGS 里用 `s3_storage_class` 把备份直接写成 Glacier 之类的存储类。这个参数在 BACKUP 里是能写的，可实际不生效，对象照样是 STANDARD，见 issue [#78737](https://github.com/ClickHouse/ClickHouse/issues/78737)，到现在还开着。要把备份转到 IA 或者 Glacier，就在 bucket 上配 S3 Lifecycle Rule 自动转，比如 0 天后转 IA、90 天后转 Glacier IR、365 天后转 Deep Archive，比靠 ClickHouse 的参数靠谱得多。

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

生产上最好恢复到临时表或者审计专用的表里，别把原表覆盖了。

## 一个月度归档的流程

比较稳的做法是每个月跑一次：挑出 90 天以前的分区，BACKUP 到 S3，查 `system.backups` 或者 `backup_log` 确认状态，记进外部的备份台账，抽样校验或者定期做 RESTORE 演练，都没问题了再 `DROP PARTITION`，把主集群的数据和元数据释放掉。

脚本的骨架大概是这样：

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

这只是个架子。真上生产，台账、重试、告警、行数记录、权限控制、恢复演练一样都不能少。

## S3 存储类怎么选

常见的几档：Standard-IA，偶尔查，取回快，价格中等；Glacier Instant Retrieval，极少查，但希望秒级取回；Glacier Flexible Retrieval，取回要几分钟到几小时；Glacier Deep Archive，取回要 12 到 48 小时，长期存最便宜。

审计的 SLA 要是「3 个工作日内出数」，Deep Archive 完全够用。业务方要是要求当天恢复、当天能查，那就得用 Glacier IR 或者 Standard-IA。

也别光看每 TB 每月多少钱，取回费用、跨区流量、恢复演练的成本、合规要求留几份副本、备份链的管理成本，都得算进去。

## 最大的硬伤：没有像样的备份台账

ClickHouse 有 `system.backups`、`system.backup_log` 可以看，但它们更像操作日志，算不上长期的备份台账。

2023 年 3 月 15 日那个分区的备份在哪？这个分区备份过几次？哪次备份做过 RESTORE 演练？这个备份路径对应哪个 shard、哪个 replica？原来的节点下线了，该从哪个 S3 路径恢复？这些问题，靠这两张系统表一般是答不上来的。

所以生产上一定要自己建一个外部台账，结构可以是这样：

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

台账里最要紧的是完整的 S3 路径，别只记一个 backup id。backup id 往往跟发起备份的节点、那台机器上的系统表记录绑在一起，原节点一下线，就很容易查不到了。

## 集群级 BACKUP 怎么取舍

`BACKUP TABLE db.t ON CLUSTER xxx` 看着最省事，可在大集群里，出了问题不一定好查。多个节点并发往 S3 写，失败的状态更复杂，任何一个节点失败都可能让整体状态说不清；每个节点系统表里的记录也不完全一样；多副本各备一份，存储和流量都浪费了。

所以很多生产上的做法是每个 shard 挑一个副本出来备份，只备一份本地表的数据。挑哪个副本，可以看 `system.replicas.absolute_delay`、当前的查询负载、是不是业务的主力副本、到 S3 的网络稳不稳。这样多副本的备份成本就从 N 份降到了 1 份。

代价是台账里必须记下 shard 和 replica，恢复的流程里也得写清楚，从哪一份备份恢复到哪里去。

## ch2s3

上面说的这些硬伤，台账缺失、跟节点绑定、按 shard 选副本、md5 校验，真要落地都得写不少胶水代码。我写过一个工具 [ch2s3](https://github.com/YenchangChan/ch2s3) 干这件事，后来整个功能已经完整集成进 [ckman](https://github.com/housepower/ckman) 了，现在直接用 ckman 就行，ch2s3 留着看实现思路。

它每个 shard 只挑一个副本做 BACKUP，避免 N 倍的存储和流量。S3 路径里带上 host 这一维，形如 `{partition}/{database}.{table}/{host}/...`，原节点下线了，别的节点也能准确地接过去恢复。每次备份产出一份独立的报表，有表名、行数、压缩前后大小、耗时、成功失败和失败原因，归档到单独的目录里。ClickHouse 没有 `CHECK BACKUP`，它用 md5 来补完整性校验，不过 multipart 场景下这个代价不小，下一节细说。它按分区滚动备份，配合 TTL 调度，对 cron 很友好，哪个分区失败了单独补跑就行。

整体思路是给 ClickHouse 原生的 `BACKUP TO S3` 做工程上的加固，不是另起炉灶。你要是打算自己写备份工具，路径设计、副本选择、md5 校验这些细节可以拿去参考。

## 没 RESTORE 过的备份不算备份

`status = BACKUP_CREATED` 只能说明备份这个过程顺利结束了，不代表将来一定恢复得回来。

真正靠得住的验证，是定期做 RESTORE：

```sql
RESTORE TABLE db.t AS db.t_verify
FROM S3('s3://bucket/backup/...');

SELECT count() FROM db.t_verify;
SELECT min(event_time), max(event_time) FROM db.t_verify;

DROP TABLE db.t_verify;
```

刚上线的第一周做强校验，稳定以后改成看文件数、大小、行数这种轻校验，每个季度做一次 RESTORE 演练。ClickHouse 升了大版本，或者 S3 后端、备份工具、密钥体系换了，都要重新做一遍强校验和恢复演练。

md5 校验有个经常被忽略的代价。ClickHouse BACKUP 是通过 S3 SDK 上传的，超过 5MB 的对象自动走 multipart upload。multipart 对象的 ETag 并不是整个文件的 md5，而是 `<md5_of_part_md5s>-<part_count>` 这种拼出来的格式，ETag 里带 `-` 就说明是分段上传的，没法直接拿来跟本地文件的 md5 比。

想真正校验 multipart 对象的内容，只能把整个对象 GET 下来重新算 md5。100GB 的备份做一次强校验，就是完整下载 100GB 再在本地算哈希；S3 出口流量翻一倍，上传一份、下载一份，账单也跟着翻倍；校验花的时间也往往和备份差不多。

这在工具层很难绕开。上传是在 ClickHouse 内部做的，工具拿不到上传时每个 part 的 md5，也没法在上传时塞一个 `Content-MD5` 让 S3 服务端去验。

所以长期的做法应该是：前期用强校验建立信任，日常用文件数和大小做轻校验监控，每季度做一次 RESTORE 端到端验证。md5 校验只适合刚开始那段时间集中验一验，长期开着就等于每天把备份做两遍，存储和运维成本都扛不住。

## 更保守的做法：导出 CSV 或 Parquet 到 NAS

有些场景连 ClickHouse 的 BACKUP 格式都不想依赖。比如监管或者审计方就想拿 CSV；企业已经有 NAS、磁带库、备份软件那一套流程；数据十年以后还得能被随便什么工具读出来；恢复的时候不想跟 ClickHouse 版本绑死。

这时候可以定时导出：

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

听着挺原始，但在合规场景里是真有用的。CSV、Parquet 是开放格式，第三方拿过去就能验收，恢复不依赖 ClickHouse 的 RESTORE，也能直接接进现有的备份软件。代价也很明显：schema 得另外管，恢复以后查起来慢，压缩率和类型信息都不如 ClickHouse 自己的格式。

选它的理由是单位要求数据能交接、能长期读、不懂 ClickHouse 的团队也看得懂。

## 落地前要准备什么

真要用 BACKUP/RESTORE 做归档，这些东西事先都得备好：归档分区的规则、S3 路径的命名规范、外部备份台账、每次备份的报表、失败重试策略、DROP PARTITION 之前的校验、RESTORE 演练的 SOP、密钥和 KMS 管理、跨节点恢复演练、备份链的清理策略、Glacier 的取回流程，还有业务提单和审批的流程。

这里面最容易被低估的是 RESTORE 演练。备份脚本跑成功，只是归档的前半截。真碰上审计或者监管要查数据的时候，能不能在约定的时间里恢复出来，才算这套方案成立。

## 最后

BACKUP/RESTORE 不是什么冷数据都适合。用户天天要查冷明细，它太慢；数据要给 Spark、Trino、DuckDB 一起用，它不开放；查询要求分钟级返回，它也不行。

可在必须留着、几乎不查、又要合规可追溯的超冷场景里，它是很实在的选择。真正花工夫的是台账、报表、校验、演练、恢复、介质、权限这一整套东西，写那条 `BACKUP TO S3` 反倒是最简单的一步。对金融、政企、运营商来说，能过审计、能恢复、能交接，往往比在线可查重要得多。
