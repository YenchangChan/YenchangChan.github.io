---
title: Too many parts 和 Too many partitions：一词之差，方向相反
---

# Too many parts 和 Too many partitions：一词之差，方向相反

> 两个报错长得几乎一样，处理方向却正好相反：**parts 要把 batch 调大，partitions 要把 batch 调小。**
>
> 但这篇真正想说的是它们之间的因果：**为了绕过 Too many partitions 而调高的上限，在写入常态化以后，会变成 Too many parts。** 我遇到的那次就是这样 —— 单次 INSERT 写进 180 个分区，不到两小时，表的 part 数涨过了 10 万。
>
> 文中参数默认值以 23.6 之后的版本为准，变化过的地方单独标出。

## 一、先分清是哪一个

```
DB::Exception: Too many parts (300). Parts cleaning are processing significantly slower than inserts
DB::Exception: Too many partitions for single INSERT block (more than 100) ...
```

| | Too many parts | Too many partitions |
|---|---|---|
| 含义 | **merge 跟不上 part 产生的速度** | **单次 INSERT 跨了太多分区** |
| 什么时候报 | 持续写入一段时间之后 | 某一次 INSERT 当场 |
| 性质 | 积压，状态性的 | 单次请求不合理，瞬时的 |
| batch 方向 | **调大** | **调小** |
| 改上限 | 不要改 | 一次性导入时可以临时改 |

一个是「写得太碎、合并追不上」，一个是「一次写得太散」。前者是系统状态的问题，后者是单个请求的问题 —— 所以处理方式反过来，并不矛盾。

## 二、Too many parts：merge 追不上

MergeTree 的每一个 INSERT block，在每个涉及的分区里都会落成一个 part，后台再把同一分区的 part 合并成更大的。part 是磁盘上实打实的目录，part 一多：小文件暴涨压文件系统、merge 次数增加吃 CPU、查询要打开更多 part。所以 ClickHouse 设了三道闸：

| 设置 | 作用范围 | 默认值 | 超过之后 |
|---|---|---|---|
| `parts_to_delay_insert` | 单分区 active part | 1000（23.6 之前 150） | INSERT 被人为放慢 |
| `parts_to_throw_insert` | 单分区 active part | 3000（23.6 之前 300） | 报 Too many parts |
| `max_parts_in_total` | 全表 active part | 100000 | 报 Too many parts |
| `inactive_parts_to_throw_insert` | 单分区 inactive part | 0（不限制） | 报 Too many parts |

报错里的那个数字就是触发的阈值。看到 `(300)` 说明是老版本的分区级上限；23.6 之后同一个错误显示的是 `(3000)`。

### 判断是哪一道闸

```sql
-- 当前阈值（表级 SETTINGS 会覆盖这里的全局值）
SELECT name, value FROM system.merge_tree_settings
WHERE name IN ('parts_to_delay_insert', 'parts_to_throw_insert',
               'max_parts_in_total', 'inactive_parts_to_throw_insert');

-- 全表 active part 数
SELECT count() FROM system.parts
WHERE database = '<db>' AND table = '<table>' AND active;

-- part 最多的分区
SELECT partition, count() AS cnt FROM system.parts
WHERE database = '<db>' AND table = '<table>' AND active
GROUP BY partition ORDER BY cnt DESC LIMIT 10;
```

注意第三条要按 `partition` 分组、按数量**降序**。按 `name`（part 名）分组每组只有一行，什么也看不出来。

### 两条路都走不通

**改大上限。** 官方明确不建议。这个阈值是报警线，不是容量线 —— 它在告诉你「这张表快写不动了」。把它调高，part 照样在堆，只是你晚一点才知道。

**手动 `OPTIMIZE` 强制合并。** 官方文档里专门写了一句：*OPTIMIZE can't fix the Too many parts error*。merge 本来就在跑、本来就追不上，`OPTIMIZE` 只是再往同一个后台池里塞一个更大的任务。而且合并完的旧 part 变成 inactive，要等一段时间才从磁盘删掉 —— 这部分在 `inactive_parts_to_throw_insert` 设了值的时候同样会触发报错；不设（默认 0）也不代表没代价，它们照样占盘、照样压文件系统。

问题的本质是**生产速度 > 消费速度**，解法只能从两头下手。

### 一头：少产生 part

**每个 INSERT block 在每个分区产生一个 part**，所以要看的不是「INSERT 了几次」，而是「产生了几个 block × 涉及几个分区」。

官方建议是 **每批 1~2 秒一次，每批 1 万 ~ 50 万行**。同样 100 万行，10 万一批是 10 个 part，100 条一批是 1 万个。

但「一次 INSERT = 一个 part」并不成立。我从 `query_log` 里捞过一条 17 万行的 INSERT，产生了 8 个 part。一次 INSERT 拆成多个 part，常见有三种原因：

- **数据跨了多个分区** —— 每个分区各落一个 part。最常见，也最容易被忽略
- **客户端把数据切成了多个 block 发送** —— 每个 block 单独成 part；HTTP 写入时还受服务端 `max_insert_block_size` 切分
- **`INSERT ... SELECT` 开了 `max_insert_threads`** —— 每个线程各自产出 part（默认是单线程）

要分清是哪一种，用 `system.part_log` 按 `query_id` 看这次 INSERT 产生的 `NewPart` 事件：

```sql
SELECT partition_id, count() AS parts, sum(rows) AS rows
FROM system.part_log
WHERE query_id = '<query_id>' AND event_type = 'NewPart'
GROUP BY partition_id ORDER BY parts DESC;
```

part 分散在多个 `partition_id` 上，是跨分区；集中在同一个分区里却有多个，是多个 block 或多线程写入。

如果写入端没法攒批（大量小客户端、每条都要实时写），交给服务端攒：`async_insert=1`，由服务端把多个小 INSERT 合成一个 part。

### 另一头：让 merge 跑得动

「CPU 还有空闲，为什么不 merge」—— 因为 merge 是后台池里的任务，**池满了，CPU 再空也排不上**：

```sql
SELECT metric, value FROM system.metrics
WHERE metric LIKE 'BackgroundMergesAndMutationsPool%';

┌─metric──────────────────────────────┬─value─┐
│ BackgroundMergesAndMutationsPoolTask │     0 │
│ BackgroundMergesAndMutationsPoolSize │    64 │
└─────────────────────────────────────┴───────┘
```

`PoolSize` 是池大小（`background_pool_size` × `background_merges_mutations_concurrency_ratio`），`PoolTask` 是正在跑的任务数。两者接近，就是池被占满了。

这个池 **merge 和 mutation 共用**。最典型的占坑者是 `MATERIALIZE TTL`：给存量数据补算 TTL、触发冷热迁移，它作为 mutation 进池，一跑就是几个小时，merge 只能排队。ClickHouse 为此留了一个保护：`number_of_free_entries_in_pool_to_execute_mutation`（默认 20）—— 池里空闲额度低于这个值时，不再启动新的 mutation，把位置留给 merge。

所以 Too many parts 的时候，除了看写入端，还要看 `system.mutations` 里有没有长时间挂着的 mutation，以及 `system.merges` 里是不是有几个巨大的 merge 占着池子。

## 三、Too many partitions：一次写得太散

```
Too many partitions for single INSERT block (more than 100).
```

单个 INSERT block 涉及的分区数超过 `max_partitions_per_insert_block`（默认 100）就报这个错。`throw_on_max_partitions_per_insert_block`（默认 true）决定是直接报错，还是只在日志里告警。

一次 INSERT 跨 100 多个分区，通常只有几种原因：

- **分区键设计不合理**，比如按 ID 分区，分区数没有上界
- **分区键合理，但数据不合理**：按天分区，数据源里却混着几个月甚至几年的存量数据，而且乱序存放
- **临时性造数据**：`INSERT ... SELECT FROM generateRandom(...)`，随机生成的日期天然覆盖大量分区

处理方式三选一：

1. **临时调大 `max_partitions_per_insert_block`** —— 只适用于一次性导入
2. **把 batch 调小**：乱序数据一次拉 10 万条可能覆盖 100 多个分区，一次 1 万条甚至 1000 条，涉及的分区就降下来了
3. **改分区键** —— 根本解法

## 四、两个错误之间的那条线

第三节的第 1 条是很多人的第一反应，也是我想重点说的地方。

**调大 `max_partitions_per_insert_block` 只在导入真的是一次性的时候才安全。** 原因就在第二节：每个 block 在每个分区落一个 part。一次 INSERT 跨 180 个分区，就是一次产生至少 180 个 part。偶尔一次，merge 消化得了；如果这是**常态写入**，part 的产生速度直接乘上了 180。

我遇到的那次就是这样：单次 INSERT 写进 180 个分区，**不到两小时，表的 part 数涨过了 10 万**，撞上 `max_parts_in_total`。默认上限是 100，能写进 180 个分区，说明之前已经有人把这个上限调高了（或者把 `throw_on_max_partitions_per_insert_block` 关掉了）。

```
Too many partitions 报错
      │
      ├─ 改分区键 / 调小 batch      → 根治
      │
      └─ 调高上限，让它写进去
              │
              ├─ 一次性导入   → 没事，merge 慢慢消化
              └─ 常态写入     → 每次 INSERT 产生 N 个 part
                                    │
                                    ▼
                             Too many parts
```

::: warning
**Too many partitions 是在拦一个会导致 Too many parts 的写入模式。**

把它的上限调高，等于把一个当场就能看见的报错，换成一个几小时后才出现、而且更难处理的报错。
:::

所以看到 Too many parts 时，排查清单里要加一项：**查 `system.query_log` / `system.part_log` 里单次 INSERT 产生的 part 数和涉及的分区数。** 如果单次 INSERT 跨的分区很多，问题不在 merge，在写入模式，往前追就是被调高过的那个上限。

## 留给读者的

1. **parts 调大 batch，partitions 调小 batch** —— 一个是积压，一个是单次请求不合理
2. **Too many parts 不要改上限，`OPTIMIZE` 也解决不了** —— 只能少产生 part，或者让 merge 跑得动
3. **一次 INSERT 不等于一个 part** —— 跨分区、多 block、多线程都会拆开；用 `part_log` 按 `query_id` 看
4. **merge 和 mutation 共用一个池** —— 长时间的 `MATERIALIZE TTL` 会把 merge 饿死
5. **调高 `max_partitions_per_insert_block` 只能用于一次性导入** —— 常态写入下它会直接变成 Too many parts

---

**相关**：[生产排障](/clickhouse/troubleshooting/) · [Too many parts — ClickHouse Knowledge Base](https://clickhouse.com/docs/knowledgebase/exception-too-many-parts)
