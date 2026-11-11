---
title: Doris 的数据组织：Partition、Tablet、Rowset 分别管什么
---

# Doris 的数据组织：Partition、Tablet、Rowset 分别管什么

看惯了 ClickHouse 的 Partition 和 Part，再看 Doris，容易在 Tablet、Rowset、Segment 这几个名字上绕进去。都是把数据切开存，为什么还要多出这么多层？扩容的时候搬哪一层，Compaction 的时候又合哪一层？

我习惯先拿一批日志顺着写入路径走一遍。下面以 Doris 的普通内部表、固定 Hash 分桶为例，StarRocks 相似的地方放在一起解释，具体实现不同的地方另说。这是机制梳理，示例数字用来说明关系。

## 一批日志怎么落下去

假设日志按天分区，每天 16 个桶，按 `user_id` 做 Hash 分布。导入一批跨了两天的数据，先根据业务时间找到两个 Partition，再根据分桶键把每一行送到对应的 Tablet。

在单个物理索引、固定分桶的模型里，一个分区的一个桶对应一个 Tablet。这里先不算同步物化视图等额外索引，否则 Tablet 数还要增加。

```text
日志表
├── 2026-11-10 分区
│   ├── Bucket 0 → Tablet 1001
│   │   ├── Rowset A
│   │   │   ├── Segment 0
│   │   │   └── Segment 1
│   │   └── Rowset B
│   │       └── Segment 0
│   ├── Bucket 1 → Tablet 1002
│   └── ……共 16 个桶
└── 2026-11-11 分区
    └── ……另外 16 个桶，对应另一组 Tablet
```

BE 收到数据后先写内存中的 MemTable，再 Flush 成 Segment。一次普通导入在一个 Tablet 上产生的文件，归入这次导入对应的 Rowset。一批数据可能命中很多 Tablet，所以一个 Load 并不等于全表只有一个 Rowset。空写入等特殊情况还可能产生不含数据 Segment 的 Rowset，不能把 Rowset 数直接当文件数。[Doris Compaction 原理](https://doris.apache.org/docs/dev/admin-manual/trouble-shooting/compaction-principles/)

下一批数据进来，会继续生成新的 Rowset。Tablet 的身份保持不变，里面的数据集合不断变化。

## Partition 管时间，Bucket 管分布

按天分区，首先是为了查询和删除。查昨天的日志，可以裁掉其他日期；只保留最近一个月，可以按分区清理。一个 Partition 仍然可以分散在多个节点上，它不是某台机器的专属目录。

分桶解决的是分区内部怎么分摊。桶少了，单个 Tablet 大，任务容易集中；桶多了，一次小批写入又可能被切得很碎。假设一批 16 MB 数据均匀命中 16 个 Tablet，每个 Tablet 平均只有约 1 MB；改成 128 个 Tablet，就只剩约 128 KB。这里暂不考虑压缩和行大小差异，但已经能看出文件为什么会变小。

因此，按小时还是按天分区，不能只看日期好不好管理，还要算上分桶的乘数：

```text
基础索引的逻辑 Tablet 数 = 各分区 Bucket 数之和
固定 16 桶、保留 30 个日分区 → 480 个逻辑 Tablet
改成保留 30 天的小时分区   → 11,520 个逻辑 Tablet
```

存算一体下，如果每个 Tablet 有三副本，还要乘三才是物理副本数。副本增加了存储和维护成本，但没有把逻辑分片变成三倍。

分桶键也不能只看基数。一个字段虽然有几百万个不同值，如果一半记录都用同一个默认值，Hash 之后还是会挤在同一个桶里。反过来，分布均匀的键如果很少出现在过滤条件和 Join 条件里，可能又用不上分桶裁剪或 Colocate 的收益。要结合实际查询选。

## 自动建分区，要看是谁在触发

Dynamic Partition 和 Auto Partition 都带“自动”，但触发条件不同。前者跟着当前时间维护滚动窗口，后者跟着写入数据创建需要的分区。

例如按月分区，回灌的数据只有 2 月和 11 月。按数据创建分区，可以只创建这两个月；按当前时间维护的连续窗口，处理的是另一件事。Doris 提供 `AUTO PARTITION`，StarRocks 从 3.0 开始支持 Expression Partitioning。两家的语法不同，不能把建表语句直接互换。[Doris 自动分区](https://doris.apache.org/docs/dev/table-design/data-partitioning/auto-partitioning/)、[StarRocks 表达式分区](https://docs.starrocks.io/docs/table_design/data_distribution/expression_partitioning/)

这里也要把“允许写进去”和“允许保留多久”分开。历史分区即使自动建出来，仍可能被保留策略清掉。回灌之前要核对保留窗口，异常时间值也要在入口处理，否则自动建分区会把脏数据变成一批新分区。

## Tablet 为什么值得单独一层

ClickHouse 的 Part 会随着 Merge 不断生成和消失。Doris 的 Tablet 则提供一个相对稳定的分片身份，控制面可以围绕它维护放置和副本关系。存算一体的副本调度以 Tablet 为基本单位。[Doris 系统架构](https://doris.apache.org/docs/4.x/features-architecture/system-architecture/)

例如 Tablet 1001 原来有一个副本在 BE-A，扩容后需要挪到 BE-D。迁移期间涉及文件复制和版本追平，但 Tablet ID 不需要因为换机器就改变。控制面更新副本放置，查询再根据当前可用副本执行。

这也解释了为什么不能拿 Tablet 直接等同于 ClickHouse Part：

| 对象 | 主要职责 | 写入和合并之后 |
| --- | --- | --- |
| Doris Tablet | 稳定的逻辑分片，承载版本和副本关系 | 通常仍是原来的 Tablet |
| Doris Rowset | 一次导入或合并的文件集合及其元数据 | 产生新 Rowset，旧集合逐步被替换 |
| ClickHouse Part | 不可变的数据片段 | Merge 生成新 Part，旧 Part 延后清理 |

从不可变文件集合的角度看，Rowset 更接近 Part，但两者仍不是一一对应。Doris 的版本和调度围绕 Tablet 展开，经典自建 ClickHouse 的 Shard 则通常由集群配置和写入路由决定。扩 Shard 时，旧数据如何重新分布，需要另外安排。ClickHouse Cloud 的共享存储架构另当别论。

## Rowset 和 Segment 还不能合成一个概念

一次写入可能多次 Flush，也可能有多个 Writer，所以一个 Rowset 可以包含多个 Segment。Segment 保存列式数据页及相应的定位结构；索引是否与数据同文件，要看索引类型和版本，不能笼统说所有索引都在 Segment 里。

Rowset 把这些文件组织成一个可管理的版本输出。以 Doris 的版本区间表示法举例：

```text
合并前：R1 [11-11] + R2 [12-12] + R3 [13-13]
合并后：R4 [11-13]
```

R4 覆盖原来的数据版本区间，业务并没有因此多出一次写入。查询选择的是可见版本所需的文件集合，不是把数据目录里所有文件都扫一遍。老文件还在等待回收，也不意味着同一份数据会返回两遍。

对排障来说，Rowset 和 Segment 的区别很实用：每个 Rowset 都很小，先查提交频率；Rowset 不多、单个里面却有大量 Segment，就去看单批大小、Flush 和写入并发。前者与后者都可能增加文件访问成本，但调整入口不一样。

## 建表时先把这笔账算清楚

我会先按查询范围和删除粒度确定 Partition，再按单分区的数据量、写入批量和并行需求估算 Bucket。目标 Tablet 大小只是估算入口，不能脱离产品版本、表模型和部署模式定一个通用数值。

桶数确定后，还要拿真实批次算一次：一批会命中多少天、多少桶，每个 Tablet 能分到多少数据。如果摊下来只有一点点，后面再加 Compaction 线程也只是持续收拾小文件。表模型同样影响合并工作量，明细追加、聚合和更新去重需要处理的事情并不相同。

这几层最终会落到同一个实际问题上：一批写入切出了多少独立的文件集合，后台又要花多少资源把它们重新合起来。接下来就可以看 Compaction 了。

**相关**：[Doris Compaction：小批写入为什么会拖慢查询](/others/doris/compaction) · [Doris 与 StarRocks 的存算分离](/others/doris/shared-data) · [ClickHouse 为什么不自动 Rebalance](/clickhouse/tooling/why-not-auto-rebalance)
