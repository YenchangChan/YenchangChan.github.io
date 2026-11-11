---
title: Doris Compaction：小批写入为什么会拖慢查询
---

# Doris Compaction：小批写入为什么会拖慢查询

ClickHouse 遇到 Too many parts，要回头看批量写入和后台 Merge。换成 Doris，报错和指标的名字变了，仍然要问一个相似的问题：新文件生成得这么快，后台合得过来吗？

Doris 的普通导入会在 Tablet 上生成 Rowset。批次很小、提交很频繁，即使每秒写入的字节数不大，也可能积出很多文件。查询要访问更多文件和索引，涉及聚合、去重时还会增加归并负担。再往后，版本数量触及上限，导入也会失败。

下面先讲 Doris 的机制，再用 StarRocks Shared-data 的观测方式作对照。Doris 机制参考 4.x 文档；系统表单独标出版本入口。没有部署实测的阈值不当作调参依据。

## 为什么不每次都合成一个大文件

假设一个 Tablet 已经有 100 GB 历史数据，刚写进来 10 MB。每次都把新旧数据完整重写，文件数量当然很少，可这笔 I/O 太贵了。

Doris 用 Cumulative 和 Base 两类合并分担工作。Cumulative 先整理近期的小 Rowset，Base 再处理基线与已经积累起来的数据。Cumulative Point 用来划分相应的版本区域。`size_based` 和 `time_series` 是选择输入和触发合并的策略；Vertical Compaction 改变按列处理的执行方式，Segment Compaction 则处理导入过程中同一 Rowset 内的碎片。这几个名字不处在同一层，不能当成几个互斥开关来选。[Doris Data Compaction](https://doris.apache.org/docs/4.x/key-features/data-compaction/)

表模型还决定合并时要做什么。明细表主要保留记录，聚合表需要按模型聚合；更新表涉及旧行清理以及删除信息、索引等处理。相同的输入字节数，工作量不一定一样。

所以“多开几个合并线程”只能解决其中一部分情况。如果瓶颈已经是磁盘、对象存储或内存，多开的任务会一起排队，还可能拖累查询。

## Score 为什么不等于文件数

Doris 的 Compaction Score 与需要参与归并的路径有关。一个 Rowset 内的 Segment 有序且互不重叠时，可以按一条路径处理；存在重叠时，可能要分别参与归并。官方原理文档给出的例子可以简化成这样：

```text
Rowset A：3 个 Segment，NONOVERLAPPING → 贡献 1
Rowset B：2 个 Segment，OVERLAPPING    → 贡献 2
Rowset C：1 个 Segment，NONOVERLAPPING → 贡献 1

这个例子的 Score 是 4，Segment 数是 6，Rowset 数是 3。
```

实际还要区分 Base/Cumulative 的候选范围和策略。这个例子解释的是计分含义，不能拿它替代所有接口的计算逻辑。[Doris Compaction 原理](https://doris.apache.org/docs/dev/admin-manual/trouble-shooting/compaction-principles/)

StarRocks Shared-data 的 Score 又有自己的口径，会把 Rowset 按大小分组，再考虑候选组中的文件。两家的 Score 都能用来观察合并压力，但数值不能横向比较。Doris 的 100 分和 StarRocks 的 100 分，并不代表相同的积压量。[StarRocks Shared-data Compaction](https://docs.starrocks.io/docs/administration/management/compaction/)

## 先定位到具体 Tablet

Doris 从 3.0.7 加入 `information_schema.backend_tablets`。先确认当前版本字段，再找分数和版本数较高的 Tablet。下面查询的是 BE 报告的信息，存算一体下同一个逻辑 Tablet 的不同副本可能分别出现，统计时要保留 `BE_ID`。[backend_tablets 系统表](https://doris.apache.org/docs/dev/admin-manual/system-tables/information_schema/backend_tablets/)

```sql
DESC information_schema.backend_tablets;

SELECT
    BE_ID,
    TABLET_ID,
    PARTITION_ID,
    VERSION_COUNT,
    SEGMENT_COUNT,
    COMPACTION_SCORE,
    TABLET_LOCAL_SIZE,
    TABLET_REMOTE_SIZE
FROM information_schema.backend_tablets
ORDER BY COMPACTION_SCORE DESC
LIMIT 30;
```

我会把同一张表的 Tablet 放在一起看。只有少数 Tablet 高，先检查热点键、数据量倾斜，以及所在 BE 的任务和资源。大多数都在升，才更像整体写入与合并能力不匹配。一次快照只能找对象，连续采样才能判断是否持续恶化。

`VERSION_COUNT` 是数量，不是最新业务版本号。业务版本号一直增长很正常，不能因为这个数字越来越大就认定有积压。`TABLET_REMOTE_SIZE` 也不能直接当作缓存未命中率，数据存放在哪里和查询从哪里读，是两个问题。

## 看任务卡在哪一段

StarRocks Shared-data 提供了比较直观的任务观察入口。下面针对其 4.1 文档展示的接口，其他版本先检查字段：

```sql
DESC information_schema.partitions_meta;

SELECT
    DB_NAME,
    TABLE_NAME,
    PARTITION_NAME,
    AVG_CS,
    P50_CS,
    MAX_CS
FROM information_schema.partitions_meta
ORDER BY MAX_CS DESC
LIMIT 30;

SHOW PROC '/compactions';
```

任务中的 `CommitTime` 为空，说明尚未提交；有提交时间、`FinishTime` 仍为空，说明还没完成发布。前一种情况继续看 CN 的执行、排队和读写，后一种情况要检查 Publish 路径。已完成任务的 Profile 中，`in_queue_sec`、`read_remote_mb`、`write_remote_sec` 等字段能帮助判断时间花在哪里。不同字段可能是多个子任务累计值，不能直接拿累计秒数当任务墙钟耗时。[任务字段说明](https://docs.starrocks.io/docs/administration/management/compaction/)

这些字段不是 Doris 的通用接口，但排查顺序可以借鉴：先判断是在等任务，还是读、合并、写出慢，最后再看提交和可见性。不能看到 Score 高，就把所有阶段都归到“Compaction 线程不足”。

| 观察到的现象 | 下一步检查 |
| --- | --- |
| Rowset 很多，每个只有很少 Segment | 提交频率、每批数据量、每批命中的 Tablet 数 |
| 单个 Rowset 有很多 Segment | Flush、Writer 并发、单批规模和内存压力 |
| 少数 Tablet 长期明显高于其他 Tablet | 分桶键倾斜、Tablet 大小、所在节点资源 |
| 排队时间高，执行时间相对稳定 | 并发额度、长任务占用、调度限制 |
| 任务执行时间变长 | CPU、磁盘延迟、网络、远端读写 |
| 已提交但迟迟不能发布 | 事务和元数据发布路径 |

## 把新增量和消除量放到一起

假设某个 Tablet 一分钟新增 100 个 Rowset，后台一分钟完成两次合并，每次把 20 个输入合成一个输出。那后台每分钟净消除的是 `2 × (20 - 1) = 38` 个，积压仍然会增长。这是演示数字，不是线上案例。

要比较的是同一范围、同一时间窗口的新增量和净消除量，不能拿任务次数去比 Rowset 数。还要同时看字节数：把二十个小 Rowset 合起来，与重写几十 GB 的历史基线，都是一次任务，但资源消耗完全不同。

合并本来就会让指标上下波动。更有用的观察是业务低峰能不能把积压消化掉。如果每轮低点都比上一轮高，即使暂时没报错，也应该调整。

## 先改写入，再决定要不要加并发

先看每次导入到底有多大。上游可以攒批的，适当扩大批量、减少提交次数；Doris 的 Group Commit 也可以作为候选，但要结合导入方式和可见延迟要求验证。不能为了凑大批次，直接把业务需要的实时性丢掉。

然后看同一批是否散到了太多分区和桶。日志回灌混着几个月的数据，每批都切成很多小份，增加总批量未必足够，还可以按时间范围组织回灌。分桶调整则是表设计变更，需要安排数据迁移或重建，不能当成临时救火参数。

入口和布局合理了，再看合并的服务能力。CPU 有余量、任务主要在排队时，增加并发才比较有依据。存储带宽已经满了，应该先减少竞争或补足带宽。宽表出现内存峰值，要关注执行方式和单任务规模；存算分离大量远端读取，要看缓存容量和任务落点。

每次调整后，我更关心三个结果：积压是否回落、写入可见延迟是否符合要求、查询 P95/P99 是否恶化。只把 Score 压下来，却让前台查询慢了一倍，这样的调整很难说成功。

**相关**：[Doris 的数据组织](/others/doris/data-layout) · [Doris 与 StarRocks 的存算分离](/others/doris/shared-data) · [ClickHouse Too many parts](/clickhouse/deep-dive/too-many-parts)
