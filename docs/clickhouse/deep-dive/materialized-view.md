---
title: ClickHouse 物化视图：三种机制，和那个在 100T 上必炸的关键字
---

# ClickHouse 物化视图：三种机制，和那个在 100T 上必炸的关键字

> 传统 MV、TO TABLE、Refreshable 三者的本质区别，大表场景怎么选，以及为什么 POPULATE 在 100T 上一定会炸。
>
> **阅读对象**：维护过写入量大的 ClickHouse 集群，正在设计聚合层，或者被「MV 数据对不上」折磨过的工程师。

---

## 一、三种物化视图概览

ClickHouse 的物化视图（Materialized View，以下简称 MV）按工作机制可以分成三类：

1. **传统 MV（隐式 inner 表）**：CH 自动创建 `.inner_id.{uuid}` 隐藏表作为存储
2. **TO TABLE MV**：显式指定目标表，MV 只承担「转换+路由」角色
3. **Refreshable MV**：23.12 引入的定时刷新型物化视图，更像传统数据库的 MV

它们在触发机制和适用场景上有本质差异：

| 维度 | 传统 MV（inner 表）| TO TABLE MV | Refreshable MV |
| --- | --- | --- | --- |
| 触发机制 | 源表 INSERT 触发增量 | 源表 INSERT 触发增量 | 定时全量重算（cron-like）|
| 底层存储 | `.inner_id.{uuid}` 隐藏表 | 用户显式建的目标表 | 用户显式建的目标表 |
| 本质 | INSERT 触发器 | INSERT 触发器 | 定时调度的 INSERT SELECT |
| 引擎要求 | 通常 AggregatingMergeTree / SummingMergeTree | 任意，目标表自己定 | 任意，目标表自己定 |
| JOIN 支持 | 只对左表（源表）触发，右表不感知 | 同上 | 完全支持，每次全量执行 |
| 历史数据 | POPULATE 或手动 INSERT | 手动 INSERT 回填 | 第一次 refresh 自动覆盖 |
| 适合场景 | 简单预聚合（不推荐生产）| 实时增量聚合主力 | 低频高复杂度、跨表 JOIN |
| 引入版本 | 很早 | 很早 | 23.12 实验，24.x 稳定 |

**理解 MV 的关键认知**：增量型 MV 的 SELECT 看到的是**当前这次 INSERT 的 block**，不是全表。这是后续所有运维问题的理论基础。

---

## 二、传统 MV（隐式 inner 表）

### 写法

```sql
CREATE MATERIALIZED VIEW mv_uv
ENGINE = AggregatingMergeTree()
ORDER BY (event_date, page)
POPULATE
AS SELECT
    event_date,
    page,
    uniqState(user_id) AS uv_state
FROM events
GROUP BY event_date, page;
```

### 工作机制

CH 在背后建一张名为 `.inner_id.{uuid}` 的隐藏表，MV 把它当目标表写。查询 `mv_uv` 就是查这张隐藏表。

每次往 `events` 写一个 block，MV 的 SELECT 就在**这个 block 上**执行（不是全表），结果 INSERT 到隐藏表。GROUP BY 是「块内聚合」，最终聚合靠 `AggregatingMergeTree` 的后台 merge + 查询时 `uniqMerge` 完成。

### 为什么生产不推荐

1. **DROP MV 直接删数据**，没有兜底
2. **修改 schema 困难**：想改 ORDER BY / 列定义要重建，数据全丢
3. **隐藏表名 `.inner_id.xxx` 难管理、难备份**
4. **无法多个 MV 写入同一张表**

### POPULATE 的致命问题

POPULATE 看似方便（创建时一次性灌入历史数据），但有两个不可接受的问题：

1. **POPULATE 期间新写入数据会丢失**：CH 文档明确警告
2. **不可断点续传**：100T 表跑一半挂了得从头来

**结论：生产环境碰都不要碰传统 MV + POPULATE。**

---

## 三、TO TABLE MV：生产主力

### 标准写法

```sql
-- 1. 先建目标表
CREATE TABLE uv_agg (
    event_date Date,
    page String,
    uv_state AggregateFunction(uniq, UInt64)
) ENGINE = AggregatingMergeTree()
ORDER BY (event_date, page);

-- 2. 再建 MV，只是个"转换+路由"规则
CREATE MATERIALIZED VIEW mv_uv TO uv_agg
AS SELECT
    event_date,
    page,
    uniqState(user_id) AS uv_state
FROM events
GROUP BY event_date, page;

-- 3. 查询
SELECT event_date, page, uniqMerge(uv_state) AS uv
FROM uv_agg
GROUP BY event_date, page;
```

### 关键优势

- **解耦**：DROP MV 不动数据；想改逻辑就 DROP + CREATE MV，目标表照旧
- **多 MV fan-in**：多个源表的 MV 都写到同一张聚合表，做「逻辑 UNION」
- **MV 链**：MV A 的目标表又是 MV B 的源表，构建多级聚合管道
- **回填可控**：用 `INSERT INTO uv_agg SELECT ... FROM events WHERE event_date < T` 手动回填，不丢实时数据

### 回填的标准操作（解决 POPULATE 丢数据问题）

1. 先创建 MV（此时只接收新数据）
2. 记一个时间点 T0
3. `INSERT INTO target SELECT ... FROM source WHERE timestamp < T0`
4. MV 自然接管 T0 之后的数据

注意 SELECT 列必须**按位置**匹配目标表，列名不重要（新手常踩的坑）。

---

## 四、Refreshable MV：复杂场景救星

### 写法

```sql
CREATE MATERIALIZED VIEW mv_daily_report
REFRESH EVERY 1 HOUR OFFSET 5 MINUTE
RANDOMIZE FOR 1 MINUTE
APPEND  -- 可选；不加就是全量替换
TO daily_report
AS SELECT
    today() AS report_date,
    country,
    count() AS cnt,
    any(c.name) AS country_name
FROM events e
LEFT JOIN countries c ON e.country_code = c.code
WHERE event_date = today()
GROUP BY country;
```

### 本质完全不同

这不是触发器，是 CH 内部调度器按 cron 执行 `INSERT INTO target SELECT ...`。

### 关键能力

- **JOIN 真正可用**：增量 MV 的 JOIN 只对左表新 block 触发，右表更新不感知；refreshable 每次全量跑，JOIN 没问题
- **复杂聚合**：window function、median、精确 quantile 等无法用 `-State` 表达的，这里都能用
- **APPEND vs Replace**：默认 `EXCHANGE`（原子替换全表），加 `APPEND` 则追加（适合做时序快照）
- **DEPENDS ON**：可以声明依赖，让上游 MV 刷完再刷自己
  ```sql
  REFRESH EVERY 1 HOUR DEPENDS ON db.mv_upstream
  ```
- **RANDOMIZE**：避免一堆 MV 同一秒齐刷，错峰

### 注意点

- 24.x 之前是实验特性，需要 `SET allow_experimental_refreshable_materialized_view = 1`
- 全量重算成本高，大表慎用；或在 SELECT 里加时间窗口约束
- 失败重试用 `SETTINGS refresh_retries = 3`
- 用 `SYSTEM REFRESH VIEW mv_name` 手动触发
- 状态查 `system.view_refreshes`

### 选型判断

| 场景 | 推荐 |
| --- | --- |
| 数据量不大但逻辑复杂 | Refreshable |
| 数据量大但逻辑简单可增量 | TO TABLE + AggregatingMergeTree |
| 需要「昨日累计」这种带 JOIN 维表的报表 | Refreshable |
| 实时仪表盘秒级刷新 | TO TABLE |

**Refreshable 的真正选型标准不是「是否定时」，而是「能不能用增量表达」**。

---

## 五、100T 大表场景如何选型

100T 量级下答案明确：**必须是 TO TABLE 形式的增量 MV**，但关键是怎么处理那 100T 历史数据。

| 方案 | 100T 表是否可行 | 原因 |
| --- | --- | --- |
| 传统 MV（inner 表）| ❌ | 不可管理、不可回滚、不能改 schema |
| 传统 MV + POPULATE | ❌❌❌ | 灾难，几乎必炸 |
| **TO TABLE 增量 MV + 手动分批回填** | ✅ | 唯一生产可行解 |
| Refreshable MV（全量）| ❌ | 每次扫 100T = 自杀 |
| Refreshable MV（带窗口）| ✅（特定场景）| 仅适合「最近 N 天」的滚动报表 |
| **Projection** | ✅（强力候选）| 简单聚合场景可能比 MV 更合适 |

### 为什么 POPULATE 在 100T 必炸

1. **单事务级别的长查询**：100T 全表扫一遍，中间任何 part 出问题就全废，没有断点续传
2. **POPULATE 期间写入丢失**：CH 文档明确警告
3. **资源吃满**：内存、磁盘 IO、merge 线程全被占，线上查询直接挂

### 推荐方案：TO TABLE + 分区分批回填

#### Step 1：建目标表（schema 提前想清楚）

```sql
CREATE TABLE events_agg ON CLUSTER xxx (
    event_date Date,
    dim1 String,
    dim2 LowCardinality(String),
    pv AggregateFunction(count),
    uv AggregateFunction(uniq, UInt64),
    revenue AggregateFunction(sum, Decimal64(2))
)
ENGINE = ReplicatedAggregatingMergeTree(...)
PARTITION BY toYYYYMM(event_date)   -- 和源表分区策略对齐！
ORDER BY (event_date, dim1, dim2)
SETTINGS index_granularity = 8192;
```

#### Step 2：先建 MV，让增量先跑起来

```sql
CREATE MATERIALIZED VIEW mv_events TO events_agg
AS SELECT
    event_date, dim1, dim2,
    countState() AS pv,
    uniqState(user_id) AS uv,
    sumState(amount) AS revenue
FROM events
GROUP BY event_date, dim1, dim2;
```

记录此刻时间 **T0**。从此刻起，新写入数据自动进聚合表。

#### Step 3：分批回填历史

```sql
INSERT INTO events_agg
SELECT
    event_date, dim1, dim2,
    countState(), uniqState(user_id), sumState(amount)
FROM events
WHERE event_date >= '2024-01-01' AND event_date < '2024-02-01'
  AND event_date < toDate('{T0}')   -- 防止和增量重叠
GROUP BY event_date, dim1, dim2
SETTINGS
    max_insert_threads = 8,
    max_threads = 16,
    max_memory_usage = 100000000000,
    max_bytes_before_external_group_by = 50000000000;
```

#### 回填要点

- **分区粒度**：100T 假设按月分区，逐月跑，跑完一个 commit 一个
- **外部脚本驱动**：别一条 SQL 跑完，用 Python/Shell 循环按分区跑，便于断点续传和监控
- **错峰**：放凌晨跑，避开业务高峰
- **重叠保护**：`WHERE event_date < T0` 务必加，否则增量和回填会重复计数
- **限速**：`max_threads`、`max_insert_threads` 别拉满，给线上查询留资源

---

## 六、历史数据回填的标准做法

任何超过 100GB 的回填都必须有完整的调度框架。

### 设计原则

1. **幂等**：同一批跑两遍结果一样（删旧分区数据再插）
2. **断点续传**：哪批跑完了要落盘记录
3. **资源可控**：能限速、能暂停
4. **可观测**：实时知道进度、失败、耗时
5. **预演**：先跑一个小分区验证逻辑，再放量

### 推荐架构

```
┌─────────────────────┐
│  调度脚本 (Python)   │  ← 控制循环、记录状态
└──────────┬──────────┘
           │
           ├── 读取任务清单（哪些分区要跑、跑到哪了）
           ├── 调用 clickhouse-client / HTTP 执行 INSERT
           ├── 监控 system.processes / system.mutations
           ├── 校验行数对账
           └── 写回状态表（progress tracking）

┌─────────────────────┐
│  ClickHouse         │
│  ├─ events (源表)    │
│  ├─ events_agg (目标)│
│  └─ backfill_log    │ ← 进度表
└─────────────────────┘
```

### 进度表

```sql
CREATE TABLE backfill_log (
    batch_id String,
    partition_key String,
    status Enum('pending'=0, 'running'=1, 'done'=2, 'failed'=3),
    src_rows UInt64,
    inserted_rows UInt64,
    started_at DateTime,
    finished_at DateTime,
    error_msg String,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY batch_id;
```

### Python 调度骨架

```python
import clickhouse_connect
import time
from datetime import date, timedelta

client = clickhouse_connect.get_client(host='...', ...)
T0 = '2026-05-26 00:00:00'

def list_batches():
    """按月切分回填任务"""
    start = date(2022, 1, 1)
    end = date(2026, 5, 1)
    cur = start
    batches = []
    while cur < end:
        next_month = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
        batches.append((cur.strftime('%Y-%m'), cur, next_month))
        cur = next_month
    return batches

def run_batch(batch_id, start_date, end_date):
    # 幂等：先删该分区已有数据
    client.command(f"""
        ALTER TABLE events_agg DROP PARTITION '{start_date.strftime("%Y%m")}'
    """)

    sql = f"""
    INSERT INTO events_agg
    SELECT
        event_date, dim1, dim2,
        countState(), uniqState(user_id), sumState(amount)
    FROM events
    WHERE event_date >= '{start_date}' AND event_date < '{end_date}'
      AND event_date < toDate('{T0}')
    GROUP BY event_date, dim1, dim2
    SETTINGS
        max_threads = 16,
        max_insert_threads = 8,
        max_memory_usage = 100000000000,
        max_bytes_before_external_group_by = 50000000000,
        max_execution_time = 7200
    """
    client.command(sql)

def verify(batch_id, start_date, end_date):
    """对账"""
    src = client.query(f"""
        SELECT count() FROM events
        WHERE event_date >= '{start_date}' AND event_date < '{end_date}'
          AND event_date < toDate('{T0}')
    """).result_rows[0][0]

    agg = client.query(f"""
        SELECT sum(countMerge(pv)) FROM events_agg
        WHERE event_date >= '{start_date}' AND event_date < '{end_date}'
    """).result_rows[0][0]

    return src, agg, src == agg

def main():
    for batch_id, start, end in list_batches():
        if get_status(batch_id) == 'done':
            continue
        mark(batch_id, 'running')
        try:
            run_batch(batch_id, start, end)
            src, agg, ok = verify(batch_id, start, end)
            if not ok:
                raise RuntimeError(f"verify failed: src={src} agg={agg}")
            mark(batch_id, 'done')
        except Exception as e:
            mark(batch_id, 'failed', error=str(e))
            break  # 失败立刻停，人工介入
        time.sleep(30)  # 错峰
```

### 监控查询

```sql
-- 当前正在执行的查询
SELECT query_id, elapsed, read_rows,
       formatReadableSize(memory_usage), query
FROM system.processes
WHERE query LIKE '%events_agg%';

-- merge 队列（防止 merge 跟不上写入）
SELECT database, table, elapsed, progress, num_parts
FROM system.merges;

-- 进度
SELECT status, count() FROM backfill_log FINAL GROUP BY status;
```

### 几个容易踩的坑

1. **不要并行跑多个 batch**：会争抢资源，merge 跟不上反而更慢
2. **`DROP PARTITION` 幂等关键**：重跑前必须清旧数据，否则 `sumState`、`countState` 会重复
3. **time 边界**：`<` 不是 `<=`，T0 当天的数据已经被 MV 接管了
4. **磁盘水位**：回填会临时多占空间，监控好 disk usage，留 30% buffer

---

## 七、Projection vs MV：另一个选择

如果聚合逻辑相对简单（PV/UV/SUM 这类），**Projection 可能比 MV 更适合 100T 表**。

### 用法

```sql
ALTER TABLE events ADD PROJECTION proj_daily_agg (
    SELECT
        event_date, dim1,
        count(), uniq(user_id), sum(amount)
    GROUP BY event_date, dim1
);

-- 对存量数据物化
ALTER TABLE events MATERIALIZE PROJECTION proj_daily_agg;
```

### Projection vs MV 对比

| 维度 | Projection | TO TABLE MV |
| --- | --- | --- |
| 数据位置 | 和源表同 part 内 | 独立表 |
| 一致性 | 强一致（part 级原子）| 最终一致 |
| 查询路由 | 优化器自动选 | 需要业务改 SQL |
| 回填 | `MATERIALIZE PROJECTION`，CH 自管 | 手写 INSERT |
| 多表 JOIN | ❌ | ❌（refreshable 可以）|
| 删除/修改 | ALTER 即可 | 复杂 |

### MATERIALIZE PROJECTION 在 100T 表上的坑

`MATERIALIZE` 在 100T 表上是个**大型 mutation 操作**，本质是把每个 part 都重写一遍。

#### 1. Mutation 不可中断式取消

KILL 是发个信号，正在处理的 part 还是会跑完。

#### 2. 磁盘空间需求

mutation 期间新旧版本并存，至少留 **30-40% 额外空间**。100T 表 → 至少 30T 空闲。

#### 3. Replicated 表的复制流量

每个副本各自跑一遍 = 整个集群 IO 都被吃。副本之间进度不一致是常态。

#### 4. 监控查询

```sql
-- 整体进度
SELECT
    database, table, mutation_id,
    parts_to_do, is_done,
    formatReadableTimeDelta(now() - create_time) AS running,
    latest_fail_reason
FROM system.mutations
WHERE table = 'events' AND NOT is_done;

-- 哪些 part 还没处理完
SELECT count(), sum(rows), formatReadableSize(sum(bytes_on_disk))
FROM system.parts
WHERE table = 'events' AND active
  AND NOT has(projections, 'proj_daily_agg');
```

#### 5. Projection 失败的 part

某个 part materialize 失败，projection 不会生成，但 mutation 整体可能标记为完成。查询时这个 part 走不到 projection 优化。

#### 6. 优化器不一定用 projection

```sql
EXPLAIN indexes = 1
SELECT event_date, count() FROM events
WHERE event_date >= '2024-01-01'
GROUP BY event_date;
```
看输出里有没有 `Projection: proj_daily_agg`。

### 100T 表上 MATERIALIZE PROJECTION 的推荐流程

1. 测试环境先验证 projection 定义和查询命中
2. 检查磁盘空间 ≥ 30T 空闲
3. 业务低峰期触发，**按分区分批**：
   ```sql
   SET mutations_sync = 0
   ALTER TABLE events MATERIALIZE PROJECTION proj_daily_agg
       IN PARTITION '202401';
   ```
4. 监控 `system.mutations`
5. 验证后处理下一批分区
6. 全部完成后用 EXPLAIN 验证查询命中

**`IN PARTITION` 是 100T 表上唯一可行的姿势。**

### 选型建议

- 简单单表聚合、加速查询 → **Projection**
- 复杂聚合、下游消费、跨表 → **TO TABLE MV**
- 100T 表两者都要考虑，甚至叠加用

---

## 八、如何发现 MV 出问题

MV 故障的核心特征是**静默失败**——查询照常返回，只是数字少了或错了。没有主动机制就永远发现不了。

### MV 失败的几种姿势

| 故障类型 | 表现 | 发现难度 |
| --- | --- | --- |
| MV SQL 执行报错（OOM、超时）| 源表 INSERT 也失败（默认）| ★ |
| 配了 `materialized_views_ignore_errors=1` | 源表 INSERT 成功，MV 静默丢数 | ★★★★ |
| MV 性能退化 | 数据延迟积压 | ★★★ |
| 源表加列，MV SQL 未更新 | 新列在 MV 里没体现 | ★★ |
| Replicated 副本不一致 | 查不同副本结果不同 | ★★★★ |
| 源数据迟到（业务侧补数）| MV 那个块已处理过，迟到数据进不去 | ★★★★★ |
| MV 链路中间一环挂了 | 上游 OK、下游缺数 | ★★★ |

### 五道防线

#### 防线 1：query_log 扫错误

```sql
-- 最近 1 小时所有 MV 相关的失败
SELECT
    event_time, query_id, exception_code,
    exception, query
FROM system.query_log
WHERE event_time > now() - INTERVAL 1 HOUR
  AND type = 'ExceptionWhileProcessing'
  AND (query LIKE '%INSERT INTO%events%'
       OR has(views, 'default.mv_events'));
```

更精准用 `query_views_log`（默认不开，要在 config 启用）：

```sql
SELECT event_time, view_name, view_target,
       status, exception
FROM system.query_views_log
WHERE event_time > now() - INTERVAL 1 HOUR
  AND status != 'QueryFinish';
```

#### 防线 2：定时对账（最有效）

按时间窗口比源表 vs 聚合表。这是唯一能发现「静默丢数」的方法。

```sql
WITH
    (SELECT count() FROM events
     WHERE event_date = yesterday()) AS src_cnt,
    (SELECT sum(countMerge(pv)) FROM events_agg
     WHERE event_date = yesterday()) AS agg_cnt
SELECT
    yesterday() AS dt,
    src_cnt, agg_cnt,
    src_cnt - agg_cnt AS diff,
    abs(src_cnt - agg_cnt) / src_cnt AS diff_ratio
WHERE diff_ratio > 0.001;
```

对账要点：
- **不能比当天**：MV 有延迟，比 T-1 或 T-2
- **不要只比 count**：还要比关键 metric（sum、uniq）
- **抽样维度比对**：随机抽几个 dim 组合

#### 防线 3：水位线 / 心跳

```sql
SELECT
    max(event_date) AS latest_in_mv,
    today() - max(event_date) AS lag_days
FROM events_agg;
```

更精细可在源表塞 heartbeat 记录，看 MV 延迟。

#### 防线 4：Replicated 副本一致性

```sql
SELECT
    hostName() AS host,
    sum(rows) AS total_rows,
    sum(bytes_on_disk) AS total_bytes
FROM clusterAllReplicas('your_cluster', system.parts)
WHERE database = 'default' AND table = 'events_agg' AND active
GROUP BY host;
```

#### 防线 5：系统级指标

```sql
-- ReplicatedMergeTree 积压
SELECT database, table, queue_size, inserts_in_queue, future_parts
FROM system.replicas
WHERE queue_size > 100;

-- 错误计数
SELECT name, value FROM system.errors
WHERE value > 0 ORDER BY value DESC;
```

### 推荐的发现体系

```
T+0 实时层：
  ├─ query_views_log 监控（每 5 分钟扫错误）
  └─ Prometheus 抓 system.errors / system.replicas 指标

T+1 对账层：
  ├─ 凌晨跑昨日数据对账（count + 关键 metric）
  ├─ 抽样维度组合对账
  └─ 心跳记录延迟检测

T+7 周对账：
  └─ 长周期数据漂移检测
```

---

## 九、数据修复：不是「删了重来」那么简单

发现问题后假设是「2024-03-15 这天 MV 漏数了」。来看几个让你头大的问题。

### 坑 1：怎么「删」？

```sql
-- 方案 A：DROP PARTITION
ALTER TABLE events_agg DROP PARTITION '202403';
```
分区粒度是月，你为了修一天，**把整个 3 月都干掉了**。

```sql
-- 方案 B：ALTER DELETE（mutation，慢）
ALTER TABLE events_agg DELETE WHERE event_date = '2024-03-15';
```
100T 量级，单个 DELETE 可能跑几小时。

```sql
-- 方案 C：Lightweight DELETE（22.8+）
DELETE FROM events_agg WHERE event_date = '2024-03-15';
```
轻量删除是标记删除，立刻返回。但**实际数据还在**，merge 时才真删。

常见做法：
- 分区按天 → DROP PARTITION
- 分区按月 → 用 `ALTER ... DELETE`，等 mutation
- 紧急止血 → Lightweight DELETE 先让数据正确，再慢慢清理

### 坑 2：源表数据可能已经变了

源表是 `ReplacingMergeTree` 或 `CollapsingMergeTree` 时，重跑 INSERT 看到的源数据可能已经被后台合并去重过——也可能没合并完。**MV 当初处理的是 INSERT 时的原始 block，不是合并后的最终视图**。

应对：
```sql
INSERT INTO events_agg
SELECT ... FROM events FINAL WHERE event_date = '2024-03-15' ...
```

### 坑 3：实时数据还在流

```
T1: 你 DROP PARTITION '20240315'
T2: 源表迟到一条 2024-03-15 的数据 → MV 触发 → 写入 events_agg
T3: 你跑回填 INSERT
```

T2 这条数据要单独处理。生产做法：
1. 先**暂停 MV**（或加排除条件）
2. 删数据
3. 回填
4. **追补暂停期间漏的数据**
5. 恢复 MV

### 坑 4：State 函数的「重复合并」陷阱

- `uniqState` 合并幂等 ✅
- `sumState`、`countState` **不是幂等的**：原本 sum=100，重跑后变 200

**重跑前必须确保旧数据彻底清掉。**

### 坑 5：多个 MV 写入同一目标表

fan-in 架构下，DROP PARTITION 会把所有上游数据都干掉，然后只回填一个上游就出大事。

应对：目标表加 `source` 字段标识来源，按 source 精确 DELETE。

### 坑 6：MV 链路下游

```
events → mv1 → events_agg → mv2 → events_summary
```

修 `events_agg` 时 `mv2` 会被新 INSERT 触发，下游表已有的脏数据会重复。

**链式 MV 修数据要从最下游往上游推。**

### 修数据的标准操作流程

```
1. 确认范围
   ├─ 哪个时间窗口
   ├─ 哪个维度子集
   └─ 涉及哪些 MV 和目标表（含下游链路）

2. 准备
   ├─ 验证回填 SQL 在小窗口上正确
   ├─ 确认磁盘空间
   └─ 通知业务方

3. 执行（从最下游开始）
   For each 目标表 in reverse(链路):
     ├─ DELETE 旧数据
     ├─ 等待删除生效（查询验证 = 0）
     ├─ INSERT 回填
     └─ 验证 count 和关键 metric

4. 实时数据追补
   └─ 修复窗口期间源表实际新写入的数据

5. 对账
   └─ 跑一遍标准对账脚本确认
```

---

## 十、Schema 演化

业务永远在变，源表的列在加在改，MV 必须跟上但不能中断。

### MV 跟 Schema 的耦合关系

```
源表 events ──┐
              │ (列名/类型耦合)
              ▼
        MV 的 SELECT ──┐
                       │ (列位置耦合)
                       ▼
                  目标表 events_agg
```

两条耦合：
- **MV SELECT 引用源表的列**：源表删列 / 改名 → MV 报错
- **MV SELECT 的输出列对齐目标表**：目标表加列 / 改顺序 → MV 写入失败

### 典型场景

#### 场景 1：源表加列

```sql
ALTER TABLE events ADD COLUMN channel LowCardinality(String) DEFAULT '';
```

MV 不会挂（没引用 channel）。想用新维度则进入场景 3。

**坑**：MV 用 `SELECT *` 会挂。**MV 永远显式列出列名。**

#### 场景 2：目标表加列（加新指标）

```sql
-- 1. 目标表加列（带默认值）
ALTER TABLE events_agg
    ADD COLUMN revenue AggregateFunction(sum, Decimal64(2))
    DEFAULT sumState(toDecimal64(0, 2));

-- 2. 改 MV SELECT
ALTER TABLE mv_events MODIFY QUERY
SELECT
    event_date, dim1, dim2,
    countState() AS pv,
    uniqState(user_id) AS uv,
    sumState(amount) AS revenue
FROM events
GROUP BY event_date, dim1, dim2;
```

**关键**：`AggregateFunction` 列的 DEFAULT 要写一个「空 state」。`MODIFY QUERY` 只对之后的 INSERT 生效，历史要回填。

#### 场景 3：加聚合维度（最痛）

要在 `events_agg` 增加 `channel` 维度，ORDER BY 要变，**这不是 ALTER 能搞定的**。

**零停机切换范式**：

```sql
-- Step 1: 建影子表
CREATE TABLE events_agg_v2 (
    event_date Date, dim1 String, dim2 LowCardinality(String),
    channel LowCardinality(String),  -- 新维度
    pv AggregateFunction(count),
    uv AggregateFunction(uniq, UInt64),
    revenue AggregateFunction(sum, Decimal64(2))
)
ENGINE = ReplicatedAggregatingMergeTree(...)
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, dim1, dim2, channel);

-- Step 2: 建新 MV（新旧并行）
CREATE MATERIALIZED VIEW mv_events_v2 TO events_agg_v2
AS SELECT
    event_date, dim1, dim2, channel,
    countState() AS pv,
    uniqState(user_id) AS uv,
    sumState(amount) AS revenue
FROM events
GROUP BY event_date, dim1, dim2, channel;

-- 记录此刻 T0

-- Step 3: 回填历史（分批，event_date < T0）

-- Step 4: 对账
SELECT
    (SELECT sum(countMerge(pv)) FROM events_agg) AS v1_pv,
    (SELECT sum(countMerge(pv)) FROM events_agg_v2) AS v2_pv;

-- Step 5: 原子切换
EXCHANGE TABLES events_agg AND events_agg_v2;

-- Step 6: 观察后清理
DROP TABLE events_agg_v2;  -- 现在指向原 v1
DROP VIEW mv_events;
```

更稳的做法：业务查询走 view 层 `final_agg_view`，切换时只改 view 定义。

#### 场景 4：改聚合函数 / 算法

`uniq` → `uniqExact` 是不兼容变更（AggregateFunction 类型不同）。走场景 3 的影子表范式。

#### 场景 5：改列类型

兼容扩展（String → LowCardinality(String)、Int32 → Int64）可以 ALTER，但是 mutation，100T 表上跑很久。

不兼容变更走影子表。

#### 场景 6：删列

正确顺序：
```sql
-- 1. 先改 MV，去掉引用
ALTER TABLE mv_events MODIFY QUERY SELECT /* 不再引用 deprecated_col */ ...;

-- 2. 再删源表列
ALTER TABLE events DROP COLUMN deprecated_col;
```

### MODIFY QUERY 的细节

- 立刻生效，**不重跑历史**
- 只影响之后 INSERT 触发的 MV 计算
- 新 SELECT 输出列必须和目标表对齐
- 对 `.inner` 表 MV，`MODIFY QUERY` 受限更多

### Refreshable MV 的演化优势

- 没有「历史 state 已按旧逻辑算过」的负担
- 改完 SELECT 等下次 refresh，自动按新逻辑全量重算
- 加维度、改聚合、改类型都可以 `MODIFY QUERY`

**业务在快速迭代期，refreshable 比增量 MV 香得多。等口径稳定了再迁移到增量。**

---

## 十一、生产规范总结

把所有结论沉淀成可以贴 wiki 的团队规范。

### 硬性禁止

1. 禁止使用 `.inner` 隐式目标表的 MV 写法
2. 禁止 `POPULATE` 关键字
3. 禁止 MV 的 SELECT 中使用 `SELECT *`
4. 禁止业务查询直接引用聚合表名（必须经过 view 层）
5. 禁止无对账的 MV 上生产

### 强制规范

6. 所有 MV 使用 TO TABLE 形式，目标表显式建在前
7. 目标表 `PARTITION BY` 必须与源表对齐
8. MV 列引用必须显式枚举
9. 超过 100GB 的回填必须有可断点续传的调度程序
10. 生产 MV 必须配置：`query_views_log` + T+1 对账 + 延迟监控

### 选型决策

11. 简单聚合、近实时 → 增量 MV（TO TABLE + AggregatingMergeTree）
12. 复杂逻辑 / 含 JOIN / 业务迭代期 → Refreshable MV（必带时间窗口）
13. 单表查询加速、零业务侵入 → Projection（分区粒度 MATERIALIZE）
14. 大表预聚合，多个查询模式 → MV + Projection 组合

### 变更流程

15. Schema 演化优先 `ALTER MODIFY QUERY`，不兼容变更走影子表 + 原子 rename
16. 任何 schema 变更前在测试环境跑通完整流程
17. 数据修复从下游往上游、先停写/隔离再操作、修完做对账

---

## 一句话总结

> **传统 MV 和 POPULATE 永远不用，实时增量走 TO TABLE，复杂或迭代期走 Refreshable，历史回填必须脚本化，对账必须常态化。**

ClickHouse 物化视图是个强大但有锐利棱角的工具。理解它的本质（INSERT 触发器 vs 定时调度），尊重它的边界（增量 MV 看到的是 block 不是全表），建立基础的运维设施（对账、监控、回填脚本），就能让它在生产环境稳定地承担实时数仓最核心的预聚合职责。
