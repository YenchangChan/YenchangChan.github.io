---
title: 23.8 → 26.3 升级路径评估
---

# 23.8 → 26.3 升级路径评估

从 23.8 升到 26.3，中间隔了 31 个版本。单看每一项风险都不复杂，麻烦在于它们散在这 31 个版本里，还可能互相影响。这篇是我把 23.9 到 26.3 的发布说明过了一遍之后整理出来的评估。

上一跳 22.8 → 23.8 也有两组必须提前固定的默认值，一组管 merge 算法，一组管存储格式，见 [版本升级避坑清单](/clickhouse/upgrade-gotchas#gotcha-22-8-to-23-8)。

## 为什么不能直接升

有两条兼容性约束，彼此独立。

第一条是 Keeper。25.10 对 Keeper 做了一项不兼容的变更，发布说明写得很明白：

> If you are updating from a version older than 23.9, you need to either update first to 23.9+ and then to 25.10+.

23.8 正好卡在这条线的前面。如果老集群没用 Keeper，这一条就不受影响。

第二条是复制格式，25.2 的发布说明：

> Change `format_alter_operations_with_parentheses` default to true. This breaks replication with clusters prior to 24.3. If you are upgrading a cluster using older releases turn off the setting in the server config or upgrade to 24.3 first.

滚动升级的时候，新旧版本的节点会同时存在。旧节点还是 23.8，新节点用了新默认值，复制就可能出问题。

两条都要满足，路径就只能是：

```
23.8 LTS  →  24.3 LTS  →  26.3 LTS
```

24.3 比 Keeper 要求的 23.9 高，也满足复制兼容的要求，而且这条路径上三个版本都是 LTS。所以项目计划要按两次滚动升级来排演练、验收和故障处置，**不能当成一次跨版本升级来估**。

## 为什么不能直接退

从 23.8 升到 26.3 以后，新版本写出来的一部分元数据和序列化格式，旧版本是读不了的。相关的默认值分散在好几个版本里：

| 版本 | 变更 | 兼容 / 回退下限 |
|---|---|---|
| 25.8 | 默认启用 `write_marks_for_substreams_in_compact_parts` | 25.5 |
| 25.10 | 默认启用 `storage_metadata_write_full_object_key`，且不可关闭 | 25.x |
| 25.11 | 默认启用 String 的 `with_size_stream` 序列化 | 25.10 |
| 26.1 | 默认启用 JSON advanced shared data | 25.8 |
| 26.3 | 默认启用 `propagate_types_serialization_versions_to_nested_types` | 26.2 |

其中四项可以在升级期间用配置先关掉，25.10 的 `storage_metadata_write_full_object_key` 关不掉。发布说明给的兼容范围是：

> this change is forward compatible only with 25.x releases. that means that you could downgrade only on any 25.x release in case you have to rollback the new release.

也就是说，哪怕提前把另外四项新格式都关了，升到 26.3 以后，**回退目标也不能是 23.8**。回退方案至少得留一个兼容的 25.x 版本，还要搞清楚每一项新格式是从什么时候开始写入的。

`propagate_types_serialization_versions_to_nested_types` 这个名字容易看错。这里的 nested 不是专指 `Nested` 数据类型，而是容器类型的内部类型。源码里受这个设置影响的类型有：

```
Array(...)
Map(...)
Nullable(...)
Variant(...)
Dynamic
JSON
```

就算没用过 `Nested`，常见的 `Nullable(String)`、`Array(String)` 也可能受影响。

## 索引名改了会写进元数据

text index 在这几个版本里改过好几次名字：

| 版本 | 变更 | 对已有表的影响 |
|---|---|---|
| 24.5 | `inverted` → `full_text` | 已有索引的表需要在升级前删除索引，升级后重建 |
| 25.5 | `full_text` → `gin` | 索引可以加载，但执行搜索时会抛出异常 |
| 26.4 | tokenizer `unicode_word` → `asciiCJK` | 使用旧名称的表无法 attach，常规 SQL 修复也会受阻 |

从 23.8 升到 26.3 会经过前两次。第三次在 26.4，不在这次升级的范围里，可它会影响在 26.3 上新建的索引，下次升级前得处理掉。第三次是我提的 [Issue #112711](https://github.com/ClickHouse/ClickHouse/issues/112711)，修复 [#113061](https://github.com/ClickHouse/ClickHouse/pull/113061) 已经合进 master，实际受影响的是 26.4 到 26.7。

改个名字为什么这么麻烦？因为索引名和 tokenizer 名不光在代码里，还会写进表定义和复制元数据。一个名字一旦随正式版发布，就成了持久化数据的一部分，以后再改名，就得管旧名字的兼容和迁移。

对 ReplicatedMergeTree 表，索引定义可能同时存在三个地方：各节点本地的元数据文件，分片对应的 `<zookeeper_path>/metadata`，以及各副本的 `<replica_path>/metadata`。只改了本地元数据、没更新 Keeper，tokenizer 不认识的问题就会变成副本元数据不一致。稳妥的做法是升级前把现有的建表语句和 Keeper 元数据扫一遍，趁旧版本还能正常加载表，把索引迁移做完。

## 还有几处行为变化

25.10 把 `replicated_deduplication_window_seconds` 的默认值从一周缩到了一小时，为的是减少 Keeper 里存的 znode。Keeper 的压力是小了，可识别重复写入的时间也短了，超过一小时的重试，默认就不会再被去重。如果上游靠 ClickHouse 去重来挡延迟重投，就得按消息保留时间和最长重试周期，显式把去重窗口设上。另外，这次调整没有动异步 INSERT 的窗口，那个还是 10000 条加一周，详见 [126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks)。

24.11 把 Kafka、NATS 和 RabbitMQ 表引擎纳入了 SOURCES 权限体系。升级以后，非 default 数据库的用户建这些表，可能需要额外授权。用 Kafka 表引擎接日志的集群，升级前应该拿实际的业务账号把相关建表语句回放一遍，光用管理员账号验证是看不出来的。

25.8 把 `concurrent_threads_scheduler` 的默认值从 `round_robin` 改成了 `fair_round_robin`。新策略对大量单线程写入一般更友好，可这也意味着升级前后的性能数据不是在同一套调度行为下测的。做容量评估和性能回归的时候要把这个设置记下来，别把调度策略的变化当成了版本整体的性能变化。

25.11 移除了 LIVE VIEW，发布说明没留任何余地：

> If you use LIVE VIEW, upgrading to the new version will not be possible.

用了这个功能的集群，必须在升级前换掉。好在这类变更跟悄悄改结果的默认值不一样，升级准备阶段扫一遍元数据就能发现。

## 发布说明替代不了演练

这次核对只看了 23.9 到 26.3 各大版本里明确标成 Backward Incompatible Change 的条目。标在 Improvement 或 Bug Fix 下面的变更，也可能改变实际行为；各版本的 patch release 也可能有额外的调整；一项变更会不会影响你的集群，还得看实际的表结构、设置、权限和查询方式。

所以升级前我建议至少做这几件事。在目标版本上回放生产环境的建表语句，重点看表引擎、索引、数据类型和权限。对比新旧版本的典型查询结果，覆盖带 `NOT`、`greatest`、`least`、行级权限和 text index 检索的查询。在预发环境把 23.8 → 24.3 → 26.3 完整演练一遍，记下每一跳的耗时、异常和停止条件。升级后的正向功能和回退方案要分别验证，确认回退的目标版本能读出已经写进去的数据和元数据。还要盯着 Keeper 的 znode 数、写入去重记录和异步写入队列，别只拿查询和写入报不报错当验收标准。

## 结论

这次升级得经过 24.3，升完以后不能直接退回 23.8。除此之外，写入去重和异步写入叠在一起的影响、索引名迁移、表引擎权限、线程调度的基线变化，也都得处理。

所以我不会把它当成一次普通的滚动升级。更稳妥的做法是拆成两次版本迁移，提前把关键默认值固定住，再用真实的元数据、真实的业务账号和典型查询，完整演练一遍。

---

**相关**：[版本升级避坑清单](/clickhouse/upgrade-gotchas) · [126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks)
