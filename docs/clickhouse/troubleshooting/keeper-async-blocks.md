---
title: 126 万 znode 是怎么长出来的
---

# 126 万 znode 是怎么长出来的

> 一个 ClickHouse 26.3 LTS 开发集群的 Keeper znode 在 94 小时内从 77 万涨到 126 万，平均请求延迟升到 165～185 ms。可这个集群的业务表并不多 —— 而我们在 23.8 的老集群上跑着 **4000 张表**，从来没出过这种事。
>
> 这篇记录从「数字反常」到「源码实锤」的完整追查过程：根因是 ClickHouse **26.2 与 26.3 两次默认值变更叠加**，让原本 opt-in 的异步插入去重变成了全局默认行为。最终 znode 降到 105997，**降幅 91.6%**。
>
> 文中主机名、数据库名等业务信息均已脱敏。

## 第一幕：一个不该有百万 znode 的集群

事情从一次例行巡检开始。Keeper 监控面板上，一个开发集群的 znode 数字很扎眼：

- 前一天约 119 万，第二天约 126 万 —— **24 小时涨了 6.9 万**
- Keeper 单节点数据量约 340 MB
- 平均请求延迟约 165～185 ms，**历史最大延迟达到 31.9～40.6 秒**

延迟已经明显不健康了。但真正让人觉得不对劲的是另一件事：**这个集群的业务表并不多。**

按经验，ReplicatedMergeTree 每张表在 Keeper 里的协调节点是有数的 —— `log`、`blocks`、`replicas`、`mutations` 这些加起来，一张表通常在几百到几千的量级。一个表不算多的开发集群，凭什么撑起百万级协调节点？

更关键的是，**它还在涨**。这说明它不是一个已经进入稳态的容量问题，而是有什么东西在**持续生产节点**。

### 先把「还在涨」这件事坐实

直觉不能当证据，先把历史曲线拉出来：

<!-- TODO: 放 znode 增长曲线图 -->

数据把直觉坐实了：**94 小时净增 487212，增幅 62.91%**；最后一个完整 24 小时净增 68544。除后台清理带来的局部小幅回落外，主趋势一路向上。

当时的 120 万绝不是「已经稳定在窗口上限附近」，而是**还在爬坡**。

有了这个判断，接下来的问题就很具体了：**这些节点到底长在哪儿？**

---

## 第二幕：顺着路径挖，90% 都在同一个目录名下

Keeper 的 znode 是树形的，所以定位思路很直接：从顶层目录逐层拆分计数，看哪一枝异常肥大。

第一步先确认在看的是**当前有效的 quorum**：

```bash
for host in keeper-1 keeper-2 keeper-3; do
    echo "== ${host} =="
    printf 'mntr' | nc -w 3 "${host}" 9181 \
      | grep -E 'zk_server_state|zk_znode_count|zk_avg_latency|zk_max_latency|zk_outstanding_requests|zk_synced_followers|zk_approximate_data_size'
done
```

确认三个成员 `zk_znode_count` 最终一致、leader 有两个同步 follower 之后，转到 ClickHouse 侧拿表路径。**不要按表名猜路径**，应以 `system.replicas.zookeeper_path` 为准：

```sql
SELECT database, table, zookeeper_path, replica_name, is_leader, is_readonly
FROM system.replicas
ORDER BY database, table;
```

然后按路径统计。`system.zookeeper` 查的是**指定路径的直接子节点**，在支持 `path IN` 子查询的版本上可以一次扫完本机所有复制表：

```sql
SELECT path, count() AS znodes
FROM system.zookeeper
WHERE path IN (SELECT DISTINCT concat(zookeeper_path, '/async_blocks') FROM system.replicas)
GROUP BY path
ORDER BY znodes DESC;
```

::: warning
如果版本不接受动态 `path IN`，先从 `system.replicas` 导出路径再分批查。**不要图省事直接递归读整个 `/clickhouse` 根目录** —— 那会给已经高负载的 Keeper 再补一刀。
:::

结果一目了然。约 **113 万**个 znode 集中在同一种路径下：

```
/clickhouse/tables/.../async_blocks
```

占整个 Keeper znode 的约 **90%**。展开看：224 条活跃的表分片路径存在非空 `async_blocks`，其中 **69 条已经贴着 10000 这个数字**。按数据库拆分，分布也很集中：

| 脱敏后的数据库 | `async_blocks` 数量 |
|---|---:|
| database_A | 约 53.6 万 |
| database_B | 约 47.4 万 |
| database_C | 约 8 万 |
| database_D | 约 4 万 |

到这里，「哪儿」已经清楚了。但一个陌生的目录名解释不了任何事 —— **`async_blocks` 到底是什么？为什么 ClickHouse 需要它？**

---

## 第三幕：`async_blocks` 是什么，为什么非有不可

要理解这个目录，得先理解异步插入在解决什么问题。

ClickHouse 最怕的写入模式是**高频小 INSERT** —— 每个 INSERT 生成一个 part，part 一多就是 merge 风暴和 Too many parts。`async_insert` 的思路是：服务端先把多个小 INSERT 攒在内存缓冲区里，满足时间、大小或查询数量条件后再统一刷成一个 part。

问题出在「攒」这个动作上。多个 INSERT 合并成一个批次后，ClickHouse 仍然必须知道**批次里每一个原始 INSERT 是否已经执行过**。否则这个场景会要命：

<!-- TODO: 放客户端重试时序图 —— 服务端已写成功，ACK 未返回，客户端重试 -->

服务端明明已经写成功了，客户端却因为没等到 ACK 而重试。如果没有去重记录，第二次 INSERT 会再写一遍 —— 轻则重复行，**重则物化视图目标表、SummingMergeTree 的聚合结果被重复累加**。

所以 ClickHouse 为异步批次里的每一个源 INSERT 计算一个去重标识，写进对应 ReplicatedMergeTree 路径的 `async_blocks` 目录。

<!-- TODO: 放 async_blocks 写入示意图 -->

**这就是 `async_blocks` 的全部职责：让客户端重试具有幂等性。**

它不是业务明细数据，不是待执行的异步队列，也不是 part 本身 —— **删掉它们不会释放一个字节的 ClickHouse 数据盘空间。**

现场抽样，单条 value 只有约 20 字节。看起来微不足道？但 znode 的真实成本远不止 value：Keeper 还要维护节点元数据、内存索引、事务日志、快照以及复制状态。**「每条才几十字节」不等于「一百万条没压力」。**

搞清楚机制后，一个更尖锐的疑问冒出来了：既然 `async_blocks` 是异步插入的产物 —— **谁开的 `async_insert`？**

---

## 第四幕：我没开过异步插入，它凭什么在跑

第一反应是去查设置。结果这一查，掉进了本次排障**最大的一个坑**：

```
name                      value     default   changed
async_insert              1         1         0
async_insert_deduplicate  0         0         0
deduplicate_insert        enable    enable    0
```

两个信息量极大的事实：

1. **`async_insert = 1`，而且 `changed = 0`** —— 没人改过，它就是默认开的
2. **`async_insert_deduplicate = 0`** —— 异步去重看起来是关的

第二条如果信了，追查就会在这里断掉：既然异步去重是关的，那 `async_blocks` 里的百万节点从哪来？是不是清理线程坏了？是不是有别的 bug？

::: danger 这是个陷阱
关键在第三行 —— **`deduplicate_insert = enable`**。

ClickHouse **26.2** 引入了这个统一开关，而官方 PR 说得非常直接：**该设置会覆盖旧的 `insert_deduplicate` 和 `async_insert_deduplicate`。**

也就是说，在 26.2 及之后的版本里，`async_insert_deduplicate=0` 这个显示值**已经不再代表实际行为**了，它只是一个被架空的历史遗留开关。
:::

所以排障时必须**新旧一起查**：

```sql
SELECT name, value, default, changed
FROM system.settings
WHERE name IN ('async_insert', 'wait_for_async_insert', 'deduplicate_insert',
               'insert_deduplicate', 'async_insert_deduplicate')
ORDER BY name;
```

同时还要看 MergeTree 侧**真正生效**的窗口：

```sql
SELECT name, value
FROM system.merge_tree_settings
WHERE name IN ('replicated_deduplication_window_for_async_inserts',
               'replicated_deduplication_window_seconds_for_async_inserts',
               'replicated_deduplication_window',
               'replicated_deduplication_window_seconds',
               'cleanup_delay_period',
               'cleanup_delay_period_random_add')
ORDER BY name;
```

26.3.13 环境的返回值，解释了一切：

```
replicated_deduplication_window_for_async_inserts         = 10000
replicated_deduplication_window_seconds_for_async_inserts = 604800   -- 一周
cleanup_delay_period                                      = 30
cleanup_delay_period_random_add                           = 10
```

**每个 ReplicatedMergeTree 协调路径，最多保留 10000 条异步去重标识，时间窗口一周。**

10000 这个数字乘上「路径数量」，就是百万 znode 的来源。但这里还有个反直觉的点需要澄清 —— **为什么「表不多」的集群路径数会那么多？**

---

## 第五幕：算笔账 —— 为什么表不多也能撑起百万

关键在于：**不能数逻辑表名，要数独立的 Keeper 表分片路径。**

ReplicatedMergeTree 的多个副本通常共享同一个 `zookeeper_path`，所以节点数不是简单乘以副本数；但不同表、不同分片，以及路径设计不同的实例，会各自形成独立的协调路径。把集群摊开数：

| 维度 | 规模 |
|---|---:|
| ClickHouse Server | 4 台 |
| 分片与副本 | 2 分片 × 2 副本 |
| 有效 Keeper quorum | 3 节点 |
| Keeper 数据库命名空间 | 9 个 |
| Keeper 中的逻辑表目录 | 362 个 |
| 具有分片子路径的活跃逻辑表目录 | 303 个 |
| 没有分片子路径的空历史目录 | 59 个 |
| **活跃表分片协调路径** | **606 条** |
| 变更前存在非空 `async_blocks` 的路径 | 224 条 |
| 其中接近 10000 条窗口上限的路径 | 69 条 |

::: tip
这里的「303 张活跃表」是从 `/clickhouse/tables/<cluster>/<database>/<table>/<shard>` 统计出的非空表目录，**包含内部表、物化视图目标表等协调对象**，不能机械等同于用户手工建的业务表。59 个空目录没有 `<shard>` 子节点，不计入活跃表。
:::

按数据库拆分：

| 数据库 | 表目录 | 活跃逻辑表 | 空历史目录 | 表分片路径 |
|---|---:|---:|---:|---:|
| database_A | 129 | 126 | 3 | 252 |
| database_B | 147 | 147 | 0 | 294 |
| database_C | 14 | 14 | 0 | 28 |
| database_D | 2 | 2 | 0 | 4 |
| database_E | 52 | 12 | 40 | 24 |
| database_F | 2 | 2 | 0 | 4 |
| 其他命名空间 | 16 | 0 | 16 | 0 |
| **合计** | **362** | **303** | **59** | **606** |

于是估算公式非常朴素：

```
async_blocks 上限 ≈ 活跃的 ReplicatedMergeTree 表分片路径数 × 10000
```

代进去：

```
全部 606 条活跃路径都产生异步 INSERT：606 × 10000 = 606 万 znode
只算当时已非空的 224 条路径：        224 × 10000 = 224 万 znode
```

实际观测到约 113 万条，相当于这 224 条写入路径理论容量的 **50.4%**。换句话说 —— **当时远没到天花板，后面还会继续涨。** 这和第一幕的曲线完全对得上。

**「表不多」的错觉就是这么产生的：人脑数的是业务表，Keeper 数的是分片路径，中间隔着分片数、内部表和物化视图目标表好几个放大系数。**

到这一步，机制链条闭合了。但还有个疙瘩没解开 —— **我在 23.8 的老集群上跑着 4000 张表，比这个集群多一个数量级，为什么它从来没出过事？**

---

## 第六幕：4000 张表的老集群为什么没事 —— 版本实锤

这个反例太重要了，不能放过。如果 `async_blocks` 是 ReplicatedMergeTree 的**固有机制**，那 23.8.9.54 上 4000 张表早该把 Keeper 撑爆了。既然没有，只有两种可能：要么老版本没这个机制，要么老版本有机制但**默认不启用**。

翻代码和 PR，答案是后者，而且演进路径比想象中曲折。

### 第一站：22.12 —— 机制诞生，但默认关闭

[#43304](https://github.com/ClickHouse/ClickHouse/pull/43304) 首次支持异步 INSERT 去重，[#44223](https://github.com/ClickHouse/ClickHouse/pull/44223) 创建了 `async_blocks` 路径和对应的开关。首个已核实包含该实现的稳定标签是 `v22.12.1.1752-stable`。

**关键在于：`async_insert_deduplicate` 默认关闭，而 `async_insert` 当时也需要显式开启。** 23.8 属于这个区间 —— 机制在代码里躺着，但没人主动开，它就一个节点都不会写。**这就是 4000 张表相安无事的原因。**

### 第二站：26.2 —— 去重默认打开

[#94413](https://github.com/ClickHouse/ClickHouse/pull/94413) 引入 `deduplicate_insert` 统一开关（26.2.1.106），紧接着 [#95970](https://github.com/ClickHouse/ClickHouse/pull/95970) 把默认值改成 `enable`（26.2.1.583）—— 所有 INSERT 默认去重，同步异步一视同仁。

但此时还差一步：`async_insert` 尚未在所有分支默认开启。没有异步插入，就没有异步去重记录。**火药备齐了，还差一根火柴。**

### 第三站：26.3 —— 异步插入默认打开，两个默认值撞在一起

[#97590](https://github.com/ClickHouse/ClickHouse/pull/97590) 让 `async_insert` 默认开启（26.3.1.377），并**回移到了 26.2.4.17**。首个包含该回移的公开稳定标签是 `v26.2.4.23-stable`。

至此，**用户什么都不用做** —— 不用开 `async_insert`，不用开去重 —— 一个全新部署的集群就会持续往 `async_blocks` 里写节点，每条路径 10000 个，保留一周。

**这两个默认值的合流，就是本文这个集群的病根。** 而 26.3.13.31 正落在这个区间里。

### 源码实锤：到底哪个配置在放行

光有版本时间线还不够，得从代码确认闸门在哪。26.3.13 的 `ReplicatedMergeTreeSink` 里，判断逻辑非常直白：

```cpp
async_insert_
    ? replicated_deduplication_window_for_async_inserts != 0
    : replicated_deduplication_window != 0
```

一行代码回答了两个问题：

1. **异步插入走的是独立窗口** —— `replicated_deduplication_window_for_async_inserts`，和普通 INSERT 的窗口完全分家
2. **这个窗口就是总闸** —— 设为 0，异步去重记录直接停止生成

::: tip 澄清一个常见误解
**并不存在一个叫 `async_blocks=0` 的开关**，`async_blocks` 只是 Keeper 上的目录名。想关它，只能动窗口。
:::

那已经堆积的百万节点呢？同版本的清理线程 `ReplicatedMergeTreeCleanupThread` 会把这个窗口传给 `clearOldBlocks`。**窗口一旦为 0，现存记录全部被视为超出保留范围，由后台线程删除。**

### 一周窗口为什么没让它自己消化掉

既然有一周的时间窗口，为什么节点还在无休止地累积？这里有个容易忽略的细节。

26.3 的清理线程确实会同时按数量窗口和时间窗口裁剪 `async_blocks`，但**时间比较参考的是最新去重节点的创建时间，而不是简单地取当前墙上时间**。

这意味着：**如果某条路径停止产生新的去重节点，时间参考也会跟着停住** —— 最后一批记录可能长期滞留，而不是「再等一周就一定归零」。只靠自然过期未必能解决问题。

另一方面，只要持续有写入，单条路径会逐步逼近 10000 的数量窗口然后稳住，不会无限膨胀。但当集群有几百条尚未到达上限的路径时，总量还是会持续爬升很久。现场从 119 万涨到 126 万，正是「**向更高的聚合稳态爬坡**」的过程。

---

## 第七幕：社区早就吵过这一架

有。而且不止一处 —— 只是这些讨论散落在不同的 issue 和 PR review 里，**没有一个标题叫「async_blocks 泄漏」的 bug 单**，所以搜关键词很难一次命中。把它们串起来，是一条相当完整的证据链。

### 线索一：180 万 znode 的用户案例（[#54968](https://github.com/ClickHouse/ClickHouse/issues/54968)）

2023 年的 Issue 里，有用户报告 8 分片、2 副本、800 张复制表产生了约 180 万 znode。社区回复指出，复制表数量和按日分区会持续制造大量协调节点。

严格说，这个 issue 讨论的是复制表和 `block_numbers`，**不是本次 `async_blocks` 的直接根因，不能当成同一个 bug**。但它证明了一件事：「表/分片数量 × 每路径协调节点」把 Keeper 推到百万级，绝非孤例。

### 线索二：有人当场算过这笔账（[#86820](https://github.com/ClickHouse/ClickHouse/pull/86820)）

**这是最关键的一条。** 这个 PR 想把普通复制表的去重数量窗口提高到 10000，review 里，社区贡献者 filimonov 明确提出反对：

> - 100 张复制表乘以 10000 就是一百万 znode
> - 小型 ZooKeeper 在约一百万节点附近经常开始出现明显性能退化
> - Keeper 在节点数很高时也存在类似退化
> - 表很多的集群应该非常谨慎地使用大默认窗口

而 PR 作者的回复更耐人寻味：**`replicated_deduplication_window_for_async_inserts` 从一开始就是 10000。**

也就是说，「每路径 10000 条异步去重记录」这个数字，**早在有人提出百万 znode 警告之前就已经躺在默认值里了。它一直是安全的，仅仅因为异步插入默认不开。**

这段讨论和现场指标高度吻合 —— 本次 Keeper 在约 120 万 znode 时，平均延迟已经到百毫秒量级，历史最大延迟数十秒。**filimonov 预言的性能退化，我们撞了个正着。**

### 线索三：官方修过一次，但漏掉了异步窗口（[#87414](https://github.com/ClickHouse/ClickHouse/pull/87414)）

这个 PR 把普通的 `replicated_deduplication_window_seconds` 从一周降到一小时，给出的理由**恰恰就是减少低写入速率下的 ZooKeeper znode**。方向完全正确。

review 里有人追问：为什么不同时改 `replicated_deduplication_window_seconds_for_async_inserts`？

作者回复说当时没有修改异步 INSERT，但承认同样处理「确实有意义」。

**这一刀没砍下去。** 结果就是 26.3 的异步窗口仍然保留 10000 条 + 一周，**普通窗口的治理完全没有覆盖 `async_blocks`。**

### 线索四：不止我一个人被旧开关坑过（[#91596](https://github.com/ClickHouse/ClickHouse/issues/91596)）

这个 Issue 讨论的正是第四幕那个陷阱。ClickHouse 维护者在里面澄清：

- 老版本中异步去重曾同时受多个设置控制
- 26.2 引入 `deduplicate_insert`
- `deduplicate_insert=enable` 会**覆盖两个旧开关**
- 从 26.2 开始，同步和异步 INSERT 默认都开启去重

看到这条时松了口气 —— **`async_insert_deduplicate=0` 却仍在生成节点，不是我们环境的灵异事件，而是一个有官方确认的认知陷阱。**

---

## 第八幕：官方最终怎么修的，哪些版本要当心

### 26.6：默认切换统一 hash（[#107886](https://github.com/ClickHouse/ClickHouse/pull/107886)）

把 `insert_deduplication_version` 的默认值改为 `new_unified_hash`：异步 INSERT 不再写独立的 `async_blocks`，而是和同步 INSERT 共用 `deduplication_hashes` 目录与普通的一小时窗口。

这不是靠版本号推测的，**源码可以对照**。`v26.5.5.8-stable` 里服务端设置仍是：

```cpp
insert_deduplication_version = COMPATIBLE_DOUBLE_HASHES
```

而 `v26.6.1.1193-stable/src/Core/ServerSettings.cpp` 已经变成：

```cpp
insert_deduplication_version = NEW_UNIFIED_HASHES
```

### 26.7：移除旧写入路径（[#108361](https://github.com/ClickHouse/ClickHouse/pull/108361)）

在 26.7.1.552 中删掉 `old_separate_hashes` 和 `compatible_double_hashes` 的执行路径，只保留统一 hash。同时它仍让 leader 清理旧 `async_blocks`，以处理滚动升级期间旧副本写入的遗留记录。

### 完整的默认值演进时间线

| 代码 / 版本 | 变化 | 对 `async_blocks` 的影响 |
|---|---|---|
| #43304、#44223；`v22.12.1.1752-stable` | 引入异步 INSERT 去重和独立的 `async_blocks` 路径；`async_insert_deduplicate` 默认关闭 | 机制已存在，但默认不会大量写入 |
| **26.2.1.106**，#94413 | 引入 `deduplicate_insert`，覆盖 `insert_deduplicate` 和 `async_insert_deduplicate` | 是否异步去重**不能再只看旧开关** |
| #95409 | 引入 server setting `insert_deduplication_version`，默认 `compatible_double_hashes` | 统一 hash 迁移第一阶段：新旧两份去重记录同时写 |
| **26.2.1.583**，#95970 | `deduplicate_insert` 默认改为 `enable` | 所有 INSERT 默认去重，但 `async_insert` 尚未全分支默认开启 |
| **26.3.1.377**，#97590 | `async_insert` 默认开启，并回移到 26.2.4.17 | **默认异步合批与默认去重开始叠加** |
| `v26.2.4.23-stable` | 首个含回移的公开稳定标签 | 无须用户显式开启，就可能持续创建 `async_blocks` |
| `v26.3.1.896-lts` 及后续 | 延续上述默认值；本次集群为 26.3.13.31 | **本文问题的直接影响版本** |
| #107886；`v26.6.1.1193-stable` | `insert_deduplication_version` 默认切为 `new_unified_hash` | 异步 INSERT 改写 `deduplication_hashes`，不再新建 `async_blocks` |
| **26.7.1.552**，#108361 | 移除旧的独立去重实现 | 从代码上完成旧路径淘汰 |

::: danger 一个容易出现的版本误判
**默认停止写入 `async_blocks` 的首个已核实稳定版本是 `v26.6.1.1193-stable`，不是 26.7。**

截至核对日期 2026-07-19，GitHub 公开的 26.7 tag 只有 `v26.7.1.1-new`；#108361 标注的 26.7.1.552 是**内部版本号**，不能当成「已发布的 26.7 稳定包」。
:::

### 影响版本矩阵

> 以下按公开稳定包和**默认配置**归纳。如果设置过 `compatibility`、显式 profile、查询级参数或表级设置，实际行为可能不同。

| 版本范围 | 默认是否会出现本文问题 | 说明 |
|---|:--:|---|
| `v22.12.1.1752-stable` ～ 26.1.x | 条件触发 | 已存在 `async_blocks`；只有显式开启异步插入和异步去重才受影响（**23.8 的 4000 张表就落在这里**）|
| `v26.2.1.1139-stable` ～ `v26.2.3.2-stable` | 条件触发 | `deduplicate_insert` 默认开启，但 `async_insert` 仍通常需要显式开启 |
| `v26.2.4.23-stable` 及后续 26.2 | **是** | `async_insert` 的默认开启已回移到该分支；**旧维护分支即使发布时间晚于 26.6，也不会自动获得 26.6 的默认变更** |
| **26.3 LTS 全系列** | **是** | 本次 26.3.13.31 现场复现；升级到更新的 26.3 LTS 补丁**不能**消除该默认行为 |
| 26.4.x ～ 26.5.x | **是** | 默认仍为兼容双 hash / 旧异步窗口 |
| `v26.6.1.1193-stable` 及之后 | 默认已修复 | 默认使用 `new_unified_hash`；若显式保留 `compatible_double_hashes`，仍会继续使用 `async_blocks` |
| 26.7.1.552 及以后 | 完整移除旧写入路径 | 升级前必须完成统一 hash 的兼容迁移 |

**一句话总结**：`async_blocks` 机制从 22.12 已存在；默认高风险组合从 `v26.2.4.23-stable` 开始，覆盖仍在维护的 26.2 分支、整个 26.3 LTS、26.4 和 26.5；`v26.6.1.1193-stable` 首次默认改用统一 hash。**旧维护分支不会因为 26.6 发布就自然变安全。**

---

## 第九幕：止血 —— 怎么改，改完怎么验

26.3 集群不可能立刻升到 26.6，得先止血。

### 方案 A：把窗口调小

```xml
<clickhouse>
    <merge_tree>
        <replicated_deduplication_window_for_async_inserts>1000</replicated_deduplication_window_for_async_inserts>
    </merge_tree>
</clickhouse>
```

| 优点 | 缺点 |
|---|---|
| 保留一定范围的异步 INSERT 重试幂等能力 | 仍会保留 `async_blocks` |
| Keeper 节点上限降到原来的十分之一 | 重试超过窗口后仍可能产生重复数据 |
| 适合客户端确实会自动重试的生产链路 | **应根据 INSERT 频率和最大重试时长计算，不要机械照抄 1000** |

### 方案 B：窗口设为 0（本次采用）

```xml
<clickhouse>
    <merge_tree>
        <replicated_deduplication_window_for_async_inserts>0</replicated_deduplication_window_for_async_inserts>
    </merge_tree>
</clickhouse>
```

- 保留 `async_insert=1`，服务端小 INSERT 合批能力不变
- 不再创建新的 `async_blocks` 去重记录
- 现有 `async_blocks` 由后台清理线程回收
- 普通同步 INSERT 的去重窗口不受影响
- **异步 INSERT 的重试幂等保护被关闭**

::: danger 这是数据正确性取舍，不是无成本优化
以下场景要格外谨慎：客户端超时后自动重试 INSERT、消息消费链路是 at-least-once、写入物化视图 / SummingMergeTree / AggregatingMergeTree（重复写会放大结果）、应用层没有唯一键或其他幂等机制。

`wait_for_async_insert=1` 能降低不确定状态出现的概率，但**消除不了网络在 ACK 返回前断开的可能**。
:::

### 方案 C：如果你的客户端本来就攒批，退回旧行为

方案 A 和 B 都在动窗口，代价都落在幂等性上。但如果你的写入方**本来就是大批次写入** —— 比如 clickhouse_sinker、Kafka 引擎表、成熟的 ETL 作业 —— 还有第三条路：**对这类写入方关掉 `async_insert`**。

```xml
<!-- /etc/clickhouse-server/users.d/sinker_profile.xml -->
<clickhouse>
    <profiles>
        <sinker_writer>
            <async_insert>0</async_insert>
        </sinker_writer>
    </profiles>
</clickhouse>
```

要理解为什么这对大批次客户端是最优解，得先算清楚一件事：**服务端攒批和客户端攒批，产生的去重记录数量其实差很多。**

| | 一次刷盘产生的 part | 去重 znode 数 |
|---|:--:|:--:|
| 客户端攒批 1000 行 → 1 个 INSERT | 1 | **1** |
| 服务端合并 1000 个小 INSERT | 1 | **1000** |

因为服务端合批后，ClickHouse 仍必须能分辨批次里每一个源 INSERT 是否已执行过 —— 否则客户端 A 重试时，没法只去掉 A 那份而保留 B、C 的。所以它必须**逐个**记录 hash。

但对 clickhouse_sinker 这类写入方，**一个批次就是一个大 INSERT，源 INSERT 只有 1 个，去重记录也只有 1 条** —— 和同步插入完全一样。放大倍数是 1，服务端攒批一点便宜没占到。

那这类集群的 `async_blocks` 为什么还是能堆到百万？**差异不在数量，在保留期**：

| | 窗口条数 | 时间窗口 |
|---|:--:|---|
| 普通 INSERT 去重（`deduplication_hashes`）| 10000 | **1 小时**（#87414 从一周降下来的）|
| 异步 INSERT 去重（`async_blocks`）| 10000 | **1 周**（#87414 明确跳过了它）|

**同样的写入速率，留存时间差 168 倍。** 一条路径要在一周内堆到 10000 上限，只需要平均 60 条/小时 —— 每分钟一个批次就够了，而这远低于大多数 sinker 的 flush 频率。走普通窗口的话，同样的写入只会留下最近 1 小时的记录，606 条路径加起来也就几万，根本到不了百万。

所以对大批次客户端，关掉 `async_insert` 的收益是：

- **`async_blocks` 彻底不再产生**
- **去重保护还在** —— 走普通的 `deduplication_hashes`，1 小时窗口，**这是方案 A/B 都做不到的**
- 不会引发 Too many parts，因为攒批本来就在客户端做
- 省掉服务端一次内存缓冲和数据拷贝
- 默认 `wait_for_async_insert=1` 时客户端照样阻塞到刷盘完成，**延迟上没有任何损失**
- 批次边界重新回到客户端手里 —— 对 at-least-once 消费链路，「批次写成功 → 提交 offset」的粒度可控

::: warning 两个前提必须确认
1. **这些表是否只有大批次写入方在写。** 如果还有业务直写、临时脚本这类小 INSERT，对它们关掉 `async_insert` 就真会撞上 Too many parts。**务必用 profile / user 粒度，不要全局关。**
2. **客户端有没有在连接串里显式设置 `async_insert`。** 如果带了这个参数，会覆盖 profile 默认值。查 `system.query_log` 里实际生效的 settings 最稳妥。
:::

### 三个方案怎么选

| | 保留合批 | 保留幂等 | `async_blocks` | 适用场景 |
|---|:--:|:--:|:--:|---|
| **A** 调小窗口 | 是 | 部分 | 变少 | 写入方混杂，且确实依赖异步重试幂等 |
| **B** 窗口设为 0 | 是 | **否** | 清零 | 写入方混杂，且能接受失去异步幂等 |
| **C** 关 `async_insert` | 客户端做 | **是**（1h 窗口）| 清零 | **写入方同质、本来就攒大批** |

本次因为写入方情况复杂、需要尽快止血，选了 **B**。但**如果你的集群写入方单一且都是大批次，C 是更优解** —— 它不牺牲任何东西，只是把攒批责任放回它本来就在的地方。

### 一条真正走不通的路

**为什么不能只改 `async_insert_deduplicate=0`？** 第四幕已经说明 —— 在 `deduplicate_insert=enable` 的环境里它会被覆盖，**改了也不生效**。

### 落地：改在哪，怎么确认真的生效了

表一多，逐表 `ALTER TABLE ... MODIFY SETTING` 既容易遗漏又难维护。正确做法是在所有 Server 的 `<merge_tree>` 里设全局默认值：

```xml
<!-- /etc/clickhouse-server/config.d/async_dedup_window.xml -->
<clickhouse>
    <merge_tree>
        <replicated_deduplication_window_for_async_inserts>0</replicated_deduplication_window_for_async_inserts>
    </merge_tree>
</clickhouse>
```

**不要执行完 `SYSTEM RELOAD CONFIG` 就假定生效了**，逐节点查验证：

```sql
SELECT hostName(), name, value
FROM clusterAllReplicas('your_cluster', system.merge_tree_settings)
WHERE name = 'replicated_deduplication_window_for_async_inserts'
ORDER BY hostName();
```

还要检查是否存在**表级显式覆盖**（表级设置优先于全局默认）：

```sql
SELECT database, name, engine
FROM system.tables
WHERE engine LIKE 'Replicated%MergeTree'
  AND positionCaseInsensitive(create_table_query, 'replicated_deduplication_window_for_async_inserts') > 0
ORDER BY database, name;
```

---

## 第十幕：清理本身差点捅出更大的篓子

配置下发、滚动重启完成，节点开始掉 —— 然后 Keeper 就不太好了。

**这是本次操作中最值得吸取的一课。** 窗口从 10000 直接改成 0，等于让几百条表分片路径的 leader **同时**发现大量过期节点。清理不是免费的：它会产生大量 Keeper 删除事务、事务日志写入和 follower 状态复制。

现场观测到：

- leader `zk_outstanding_requests` 瞬时冲到 **20226**
- 一次 `mntr` 请求短暂超时
- `zk_synced_followers` 一度**从 2 掉到 1**
- follower 出现几千个 outstanding
- 数十秒后全部自行恢复，quorum 始终没有真正失去多数派

惊险，但没出事。事后复盘，更稳妥的生产策略应该是：

1. 在低峰期执行
2. 暂停或排空会自动重试的写入队列
3. **滚动重启 ClickHouse Server，不要同时重启 Keeper**
4. 预先增大 `cleanup_delay_period_random_add`，把不同表的清理时间打散
5. 极端情况下分阶段降窗口：10000 → 8000 → 5000 → 2000 → 目标值
6. 全程盯着 leader、同步 follower 数、outstanding 和 ClickHouse 写入错误率

```xml
<clickhouse>
    <merge_tree>
        <replicated_deduplication_window_for_async_inserts>0</replicated_deduplication_window_for_async_inserts>
        <cleanup_delay_period_random_add>3600</cleanup_delay_period_random_add>
    </merge_tree>
</clickhouse>
```

### 战果

| 阶段 | znode 数量 | Keeper 数据量 | leader outstanding | 同步 follower |
|---|---:|---:|---:|:--:|
| 变更前 | 约 126.2 万 | 约 340 MB | 有波动 | 2 |
| 清理中段 | 约 92.4 万 | 持续下降 | 峰值约 20226 | 短暂降至 1 |
| 清理末段 | 约 14.7 万 | 持续下降 | 连续为 0 | 2 |
| **清理完成检查点** | **105997** | **32284899 字节** | **0** | **2** |

- znode 从约 126.2 万降到 105997，**减少约 115.6 万，降幅 91.6%**
- Keeper 数据量从约 340 MB 降到 32.3 MB
- `async_blocks` 在全部 606 条活跃表分片路径上**均已清零**

### 尾巴：为什么它又从 10.6 万涨回了 12 万

105997 是**清理结束时的检查点**，不是承诺 Keeper 总节点永久固定在这个数。

接下来约半小时内总 znode 就回升到约 11.4 万，很快又摸到 12.2 万。第一反应当然是「复发了？」—— 逐一检查 606 条 `async_blocks`，直接子节点总数**仍然是 0**。不是它。

第一次猜测是 `deduplication_hashes`。用 `find_super_nodes` 扫大目录，命中 8 条路径合计约 2.81 万 —— 看起来很像元凶。**但紧接着的增量采样推翻了它**：这 8 条路径在 16 秒内纹丝不动，而总 znode 又涨了 271。

换方法：对全部 606 条路径做**全量分类统计 + 15 秒差分**。

```
category                23:47:51    23:48:06    delta
log                         3465        3494       +29
blocks                       469         469        +0
deduplication_hashes       52599       52599        +0
async_blocks                   0           0        +0
block_numbers                100         100        +0
mutations                    200         200        +0
TOTAL_ZNODE               121723      121832      +109
```

**结论清楚了：在增长的是 `log`（复制日志），去重类目录全部为 +0。** 12 万这个水位全是 ReplicatedMergeTree 正常运转所需的协调节点。

反过来看，变更前的 126.2 万里减去 113 万 `async_blocks`，剩下约 13.2 万非异步基础节点 —— **12 万还略低于它。10.6 万才是异常值**，那是清理刚结束、复制日志和 parts 状态尚未恢复时的瞬时低点。

::: tip 一点保留
15 秒内总量 +109，`log` 只解释了 +29，剩下约 80 个归到 `replicas/.../parts`、表结构和选主节点等常规元数据，**但没有逐项拆解验证**。考虑到这些目录本来就随写入和 merge 持续变动，且去重类目录全部归零，没有继续深挖。
:::

**三条教训：**

1. **验证治理效果要同时看总 znode 和目标目录计数**，不能把两者混为一谈
2. **清理结束的瞬时低点不是稳态水位**，别拿它当基线去做后续告警阈值
3. **猜大户不如做差分** —— `find_super_nodes` 找到的是**存量最大**的目录，未必是**正在增长**的目录，这两个问题需要用不同方法回答

---

## 复盘：四个不要

**不要手工递归删除 `async_blocks`。** 别拿 Keeper 客户端执行 `rmr`。ClickHouse 对这些目录有自己的并发、版本和缓存假设，绕过表引擎清理线程可能与正在进行的 INSERT 或副本操作竞争，而且极易误删相邻协调数据。

**不要因为管理命令超时就重启 Keeper leader。** 只要 quorum 还在、outstanding 能回落、follower 能重新同步，贸然切主或重启，很容易把一次可恢复的压力变成真正的可用性事故。

**不要只看 `zk_avg_latency`。** 它通常是**进程启动以来的累计指标**，经历一次重负载后不会立刻回到原值。

**不要把「符合源码」理解为「生产上合理」。** 每条路径最多 10000 个去重节点是预期行为，后台清理线程也确实存在 —— 但上百条路径累计到百万 znode 后产生的 Keeper 压力，仍然是必须治理的生产问题。

> **「不是内存泄漏」不等于「容量健康」。** 更准确的定性是：这是 26.2.4～26.5 默认组合导致的**生产级容量缺陷 / 运维陷阱**，不是单表无界泄漏。

---

## 尾声

回头看，这次排障真正的价值不在于找到了一个叫 `async_blocks` 的大目录 —— 那只花了半小时。难的是把下面这条链条**一环不缺地钉死**：

```
znode 持续增长（不是稳态容量问题）
  → 路径统计确认约 90% 来自 async_blocks
  → 理解 async_blocks 的职责：异步 INSERT 的重试幂等索引
  → 设置检查踩中陷阱：deduplicate_insert 覆盖了 async_insert_deduplicate
  → 表分片路径数 × 默认窗口，解释了百万量级
  → 23.8 老集群 4000 张表无恙，反证是新版本默认值变了
  → 版本考据 + 源码确认：22.12 有机制、26.2 默认去重、26.3 默认异步，三级叠加
  → 社区讨论佐证：filimonov 早已预警百万 znode
  → 窗口设为 0 同时控制「停止生成」和「后台清理」
  → 变更后节点数下降 91.6%，三副本恢复一致
  → 差分验证回升的 1 万多节点是正常复制元数据，目标目录保持为 0
```

**四句话带走：**

1. `async_blocks` 是**异步 INSERT 的重试去重索引**，不是业务数据，也不是异步队列
2. 百万 znode 可能只是「默认窗口 × 表分片数」的自然结果，但对 Keeper 来说仍是实打实的压力 —— **「符合设计」和「生产健康」是两回事**
3. 治理时要评估**两头**的风险：关闭去重后的重复数据风险，以及百万节点集中清理对 quorum 的冲击
4. **攒批放在哪里是个独立决策** —— 如果客户端本来就攒大批，退回 `async_insert=0` 比动去重窗口更划算

> **最后一点私货**：这次能追到底，靠的是那个「4000 张表的老集群为什么没事」的反例。
>
> **当一个现象在旧环境不成立时，别急着归因于业务差异 —— 先去查默认值变更。近年 ClickHouse 的 breaking change 有相当一部分藏在默认值里，而不是 API 里。**

---

**相关**：[版本升级避坑清单](/clickhouse/upgrade-gotchas) · [23.8 → 26.3 升级路径评估](/clickhouse/upgrade-23-8-to-26-3)
