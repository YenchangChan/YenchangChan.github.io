---
title: 23.8 → 26.3 升级路径评估
---

# 23.8 → 26.3 升级路径评估

> 结论先行：**这次升级必须经过 24.3，而且升完之后不能直接退回 23.8。**
>
> 这不是一次普通的滚动升级。风险单独看都不复杂，困难在于它们**分散在 31 个版本中，并且可能相互影响**。

> **上一跳**：22.8 → 23.8 同样有两组必须提前固定的默认值（merge 算法 + 存储格式），
> 见 [版本升级避坑清单](/clickhouse/upgrade-gotchas#gotcha-22-8-to-23-8)。

## 一、不能直接升：两项独立的兼容性约束

### 约束一：Keeper（25.10）

25.10 对 Keeper 做过一项不兼容变更，发布说明明确要求：

> If you are updating from a version older than **23.9**, you need to either update first to 23.9+ and then to 25.10+.

23.8 正好位于这个兼容边界之前。（如果旧集群没有使用 Keeper，则不受此影响。）

### 约束二：复制格式（25.2）

> Change `format_alter_operations_with_parentheses` default to **true**. This breaks replication with clusters prior to **24.3**. If you are upgrading a cluster using older releases turn off the setting in the server config or upgrade to 24.3 first.

滚动升级期间，新旧版本节点会同时存在。如果旧节点仍是 23.8、新节点采用新默认值，**复制可能受到影响**。

### 同时满足两项约束的路径

```
23.8 LTS  →  24.3 LTS  →  26.3 LTS
```

24.3 既高于 Keeper 要求的 23.9 下限，又满足复制兼容性要求，**并且路径上的三个版本都是 LTS**。

::: warning
项目计划需要按**两次**滚动升级安排演练、验收和故障处置，**不能按一次跨版本升级估算**。
:::

---

## 二、不能直接退：五项存储格式默认值

从 23.8 升到 26.3 后，新版本写出的部分元数据和序列化格式**无法被旧版本读取**。相关默认值分布在多个版本中：

| 版本 | 变更 | 兼容 / 回退下限 |
|---|---|---|
| 25.8 | 默认启用 `write_marks_for_substreams_in_compact_parts` | 25.5 |
| **25.10** | 默认启用 `storage_metadata_write_full_object_key`，**且不可关闭** | **25.x** |
| 25.11 | 默认启用 String 的 `with_size_stream` 序列化 | 25.10 |
| 26.1 | 默认启用 JSON advanced shared data | 25.8 |
| 26.3 | 默认启用 `propagate_types_serialization_versions_to_nested_types` | 26.2 |

其中四项可以在升级期间通过配置暂时关闭，**25.10 的 `storage_metadata_write_full_object_key` 不能关闭**。发布说明给出的兼容范围是：

> this change is **forward compatible only with 25.x releases**. that means that you could downgrade only on any 25.x release in case you have to rollback the new release.

::: danger
即使提前关闭其他四项新格式，**升级到 26.3 后也不能把 23.8 作为直接回退目标**。

回退方案至少需要保留一个兼容的 25.x 版本，并明确各项新格式从何时开始写入。
:::

### 一个容易误解的名字

`propagate_types_serialization_versions_to_nested_types` —— 这里的 **nested 不是专指 `Nested` 数据类型**，而是**容器类型的内部类型**。源码中受该设置影响的类型包括：

```
Array(...)
Map(...)
Nullable(...)
Variant(...)
Dynamic
JSON
```

**即使没有使用 `Nested`，常见的 `Nullable(String)` 和 `Array(String)` 也可能受到影响。**

---

## 三、索引名称变化会进入持久化元数据

text index 在这几个版本中经历了**多次**名称调整：

| 版本 | 变更 | 对已有表的影响 |
|---|---|---|
| 24.5 | `inverted` → `full_text` | 已有索引的表需要**在升级前删除索引**，升级后重建 |
| 25.5 | `full_text` → `gin` | 索引可以加载，但**执行搜索时会抛出异常** |
| 26.4 | tokenizer `unicode_word` → `asciiCJK` | 使用旧名称的表**无法 attach**，常规 SQL 修复也会受阻 |

从 23.8 升到 26.3 会经历**前两项**变更。第三项发生在 26.4，虽然不属于本次升级范围，但**会影响 26.3 上新建的索引**，是下一次升级前需要处理的遗留风险。

> 关于第三项：见笔者提的 [Issue #112711](https://github.com/ClickHouse/ClickHouse/issues/112711)，相关 fix [#113061](https://github.com/ClickHouse/ClickHouse/pull/113061) 已合入 master，**实质受影响版本为 26.4 ～ 26.7**。

### 为什么改名这么麻烦

**索引和 tokenizer 名称不仅存在于代码中，也会写进表定义和复制元数据。** 一旦名称随正式版本发布，它就成为持久化数据的一部分，后续改名必须考虑旧名称的兼容和迁移。

对 ReplicatedMergeTree 表，索引定义可能**同时存在于三处**：

- 各节点本地的元数据文件
- 分片对应的 `<zookeeper_path>/metadata`
- 各副本的 `<replica_path>/metadata`

::: warning
**只修改本地元数据而不更新 Keeper，可能把「tokenizer 不识别」的问题变成「副本元数据不一致」。**

升级前更稳妥的做法，是扫描现有建表语句和 Keeper 元数据，**在旧版本仍能正常加载表时**完成索引迁移。
:::

---

## 四、还需要关注的行为变化

### 去重窗口缩短（25.10）

`replicated_deduplication_window_seconds` 的默认值**从一周缩短到一小时**，目的是减少 Keeper 中保存的 znode 数量。

这个调整降低了 Keeper 压力，也**缩短了重复写入的识别时间**。超过一小时的重试不会再被默认去重。如果上游依赖 ClickHouse 去重来抵御延迟重投，需要根据消息保留时间和最大重试周期**显式设置**去重窗口。

> 注意：这次调整**没有覆盖异步 INSERT 的窗口**，那条仍是 10000 条 + 一周。
> 详见 [126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks)。

### 表引擎权限变化（24.11）

Kafka、NATS 和 RabbitMQ 表引擎被纳入 **SOURCES 权限体系**。升级后，非 default 数据库的用户创建这些表时可能需要额外授权。

::: tip
对于使用 Kafka 表引擎接入日志的集群，应在升级前**用实际业务账号**回放相关建表语句，**不能只用管理员账号验证**。
:::

### 线程调度默认值变化（25.8）

`concurrent_threads_scheduler` 的默认值从 `round_robin` 改为 `fair_round_robin`。

新策略对大量单线程写入通常更友好，但也意味着**升级前后的性能数据不再基于同一套调度行为**。容量评估和性能回归测试需要记录这个设置，避免把调度策略变化误判为版本整体的性能变化。

### LIVE VIEW 被移除（25.11）

发布说明对此**没有保留兼容空间**：

> If you use LIVE VIEW, upgrading to the new version will not be possible.

使用该功能的集群必须在升级前完成替换。与静默改变结果的默认值不同，**这类变更通常能在升级准备阶段通过扫描元数据直接发现**。

---

## 五、发布说明不能替代升级演练

这次核对只覆盖 23.9 至 26.3 各大版本中**明确标注为 Backward Incompatible Change** 的条目，仍有三项边界：

- 标在 **Improvement 或 Bug Fix** 分类下的变更，也可能改变实际行为
- 各版本的 **patch release** 可能包含额外调整
- 一项变更是否影响集群，取决于实际表结构、设置、权限和查询方式

### 升级前至少应完成

1. 在目标版本**回放生产环境的建表语句**，重点检查表引擎、索引、数据类型和权限
2. 对比新旧版本的**典型查询结果**，覆盖包含 `NOT`、`greatest`、`least`、行级权限和 text index 检索的查询
3. 在预发环境**完整演练 23.8 → 24.3 → 26.3**，记录每一跳的耗时、异常和停止条件
4. **分别验证升级后的正向功能和回退方案**，确认回退目标版本能够读取已经写入的数据与元数据
5. 观察 **Keeper 的 znode 数量、写入去重记录和异步写入队列** —— 避免只以「查询和写入是否报错」作为验收标准

---

## 结论

最重要的两个结论：

> **升级需要经过 24.3，升级完成后不能直接回退到 23.8。**

除此之外，还需要处理写入去重与异步写入的叠加影响、索引名称迁移、表引擎权限变化以及线程调度基线变化。

**这次升级不应被视为一次普通的滚动升级。** 更合适的做法是把它拆成两次版本迁移，提前固定关键默认值，并用**真实元数据、真实业务账号和典型查询**完成一次完整演练。

---

**相关**：[版本升级避坑清单](/clickhouse/upgrade-gotchas) · [126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks)
