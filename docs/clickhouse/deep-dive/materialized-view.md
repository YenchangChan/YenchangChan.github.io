---
title: ClickHouse 物化视图：三种机制，以及 100T 表上的 POPULATE
---

# ClickHouse 物化视图：三种机制，以及 100T 表上的 POPULATE

物化视图（Materialized View，下面简称 MV）是 ClickHouse 做预聚合最常用的手段，也是最容易出现「数据对不上」的地方。这篇讲三种 MV 到底差在哪，表到了 100T 这个量级该怎么选，为什么 POPULATE 在这种表上一定会炸，以及上线以后怎么发现问题、怎么修数据、schema 变了怎么跟。

## 三种物化视图

按工作机制，ClickHouse 的 MV 可以分成三类。传统 MV 不指定目标表，ClickHouse 自动建一张 `.inner_id.{uuid}` 的隐藏表来存数据。TO TABLE MV 显式指定一张目标表，MV 自己只负责转换和路由。Refreshable MV 是 23.12 引入的定时刷新型，更像传统数据库里的物化视图。

| 维度 | 传统 MV（inner 表）| TO TABLE MV | Refreshable MV |
| --- | --- | --- | --- |
| 触发机制 | 源表 INSERT 触发增量 | 源表 INSERT 触发增量 | 定时全量重算（cron-like）|
| 底层存储 | `.inner_id.{uuid}` 隐藏表 | 用户显式建的目标表 | 用户显式建的目标表 |
| 本质 | INSERT 触发器 | INSERT 触发器 | 定时调度的 INSERT SELECT |
| 引擎要求 | 通常 AggregatingMergeTree / SummingMergeTree | 任意，目标表自己定 | 任意，目标表自己定 |
| JOIN 支持 | 只对左表（源表）触发，右表不感知 | 同上 | 完全支持，每次全量执行 |
| 历史数据 | POPULATE 或手动 INSERT | 手动 INSERT 回填 | 第一次 refresh 自动覆盖 |
| 适合场景 | 简单预聚合（不推荐生产）| 实时增量聚合主力 | 低频高复杂度、跨表 JOIN |
| 引入版本 | 很早 | 很早 | 23.12 实验，24.10 起不再是实验特性 |

增量型 MV 的 SELECT 看到的只是当前这一次 INSERT 的那个 block，不是全表。后面几乎所有的运维问题，都是从这里来的。

## 传统 MV

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

ClickHouse 在背后建一张 `.inner_id.{uuid}` 的隐藏表，MV 就往这张表里写，查 `mv_uv` 就是查这张隐藏表。每往 `events` 写一个 block，MV 的 SELECT 就在这个 block 上执行一次，结果写进隐藏表。所以这里的 GROUP BY 只是块内聚合，最终的聚合要靠 `AggregatingMergeTree` 后台 merge，再加上查询时的 `uniqMerge` 来完成。

这种写法我不建议在生产上用。DROP 掉 MV，数据跟着一起没了，没有任何兜底；想改 ORDER BY 或者列定义，只能重建，数据全丢；`.inner_id.xxx` 这种隐藏表名也不好管理、不好备份；而且没法让多个 MV 写同一张表。

再说 POPULATE。它看着很方便，建 MV 的时候顺手把历史数据一次灌进去。可它有两个没法接受的问题：POPULATE 执行期间新写进源表的数据会丢，官方文档里是明确警告过的；它也没法断点续传，100T 的表跑到一半挂了，只能从头再来。所以传统 MV 加 POPULATE，生产上碰都别碰。

## TO TABLE MV

生产上我用的基本都是这一种：

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

建的时候用 `-State`，查的时候用 `-Merge`，这种用法一点都不特殊，ClickHouse 几乎所有的聚合函数都能这么用。

数据和逻辑分开了，好处一下就出来了。DROP MV 不会动数据，想改逻辑就 DROP 再 CREATE 一个 MV，目标表原封不动。多个源表的 MV 可以写到同一张聚合表里，相当于做了一个逻辑上的 UNION。MV A 的目标表又可以是 MV B 的源表，串成多级聚合。回填也可控了，用 `INSERT INTO uv_agg SELECT ... FROM events WHERE event_date < T` 自己去补，不会丢实时数据。

回填的标准做法是这样：先建 MV，这时候它只接新数据；记下一个时间点 T0；然后 `INSERT INTO target SELECT ... FROM source WHERE timestamp < T0`；T0 之后的数据自然由 MV 接管。有个新手常踩的坑，INSERT SELECT 的列是按位置对应目标表的，列名叫什么不重要。

## Refreshable MV

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

它跟前两种完全不是一回事。它不是触发器，是 ClickHouse 内部的调度器按时间去执行 `INSERT INTO target SELECT ...`。

所以增量 MV 做不好的事它都能做。JOIN 是真能用的：增量 MV 的 JOIN 只在左表来了新 block 时触发，右表更新了它根本不知道；Refreshable 每次全量跑，就没这个问题。window function、median、精确 quantile 这些没法用 `-State` 表达的聚合，这里也都能用。默认每次刷新是原子地整表替换，加上 `APPEND` 就变成追加，适合做时序快照。可以用 `DEPENDS ON` 声明依赖，等上游的 MV 刷完再刷自己：

```sql
REFRESH EVERY 1 HOUR DEPENDS ON db.mv_upstream
```

`RANDOMIZE` 是用来错峰的，免得一堆 MV 同一秒一起刷。

用的时候注意几点。24.10 之前它还是实验特性，得先 `SET allow_experimental_refreshable_materialized_view = 1`。每次都是全量重算，成本高，大表要慎用，或者在 SELECT 里加上时间窗口。失败重试可以用 `SETTINGS refresh_retries = 3`，手动触发用 `SYSTEM REFRESH VIEW mv_name`，状态在 `system.view_refreshes` 里看。

| 场景 | 推荐 |
| --- | --- |
| 数据量不大但逻辑复杂 | Refreshable |
| 数据量大但逻辑简单可增量 | TO TABLE + AggregatingMergeTree |
| 需要「昨日累计」这种带 JOIN 维表的报表 | Refreshable |
| 实时仪表盘秒级刷新 | TO TABLE |

选之前先看这段逻辑能不能用增量表达，能的话还是用增量 MV，Refreshable 留给表达不了的那些。

## 100T 的大表怎么选

到了 100T 这个量级，答案其实很明确，只能是 TO TABLE 形式的增量 MV。难的是那 100T 的历史数据怎么处理。

| 方案 | 100T 表是否可行 | 原因 |
| --- | --- | --- |
| 传统 MV（inner 表）| 不可行 | 不可管理、不可回滚、不能改 schema |
| 传统 MV + POPULATE | 绝对不可行 | 灾难，几乎必炸 |
| TO TABLE 增量 MV + 手动分批回填 | 可行 | 唯一生产可行解 |
| Refreshable MV（全量）| 不可行 | 每次扫 100T = 自杀 |
| Refreshable MV（带窗口）| 特定场景可行 | 仅适合「最近 N 天」的滚动报表 |
| Projection | 可行，强力候选 | 简单聚合场景可能比 MV 更合适 |

为什么说 POPULATE 在 100T 上必炸？它就是一个超长的查询，100T 全表扫一遍，中间任何一个 part 出问题就全白干了，没有断点续传；这期间写进来的数据会丢；内存、磁盘 IO、merge 线程全被它占满，线上查询直接挂。

推荐的做法是 TO TABLE 加按分区分批回填。

先建目标表，schema 要提前想清楚，分区策略和源表对齐：

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

然后先建 MV，让增量先跑起来：

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

记下这一刻的时间 T0，从现在起，新写入的数据自动进聚合表。

最后分批回填历史：

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

100T 的表假设按月分区，那就一个月一个月地跑，跑完一个算一个。别想着一条 SQL 跑完，用 Python 或者 Shell 写个循环按分区跑，方便断点续传，也方便盯着。放到凌晨跑，避开业务高峰。`WHERE event_date < T0` 务必加上，不然增量和回填会重复计数。`max_threads`、`max_insert_threads` 也别拉满，给线上查询留点资源。

## 历史数据回填

我的建议是，超过 100GB 的回填，都该有一套像样的调度。同一批跑两遍结果要一样，也就是先删掉旧分区的数据再插；哪一批跑完了要落盘记下来，挂了能接着跑；能限速、能暂停；随时知道进度、失败和耗时；先挑一个小分区验证逻辑，再放量。

大致的架构：

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

进度表：

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

调度脚本的骨架：

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

跑的时候盯这几样：

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

几个容易踩的坑。别并行跑好几个 batch，抢资源，merge 跟不上，反而更慢。重跑之前必须 `DROP PARTITION` 清掉旧数据，不然 `sumState`、`countState` 会重复累加。时间边界是 `<` 不是 `<=`，T0 那天的数据已经归 MV 管了。回填会临时多占磁盘，盯好磁盘水位，留三成左右的余量。

## Projection 也是个选择

聚合逻辑比较简单的，比如 PV、UV、SUM 这类，Projection 可能比 MV 更适合 100T 的表。

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

| 维度 | Projection | TO TABLE MV |
| --- | --- | --- |
| 数据位置 | 和源表同 part 内 | 独立表 |
| 一致性 | 强一致（part 级原子）| 最终一致 |
| 查询路由 | 优化器自动选 | 需要业务改 SQL |
| 回填 | `MATERIALIZE PROJECTION`，CH 自管 | 手写 INSERT |
| 多表 JOIN | 不支持 | 不支持（refreshable 可以）|
| 删除/修改 | ALTER 即可 | 复杂 |

Projection 比 MV 轻，它本身就是表的一部分，不用双写，也不用操心两张表同步改 schema，对用户也是透明的，查原表就行，优化器自己决定走不走它。效果上它还是比 MV 稍差一点，这也好理解，Projection 毕竟还是在原表的 part 里，MV 是把数据完全独立出来了，查的时候不用再碰原表。还有一点两者是一样的：不管 MV 还是 Projection，聚合都是以单个 part 为单位做的，要折叠的数据落在不同的 part 里，没合并之前直接查中间结果是不准的，所以查询时还得 `-Merge` 或者再 GROUP BY 一次。

`MATERIALIZE PROJECTION` 在 100T 的表上是一个大型的 mutation，等于把每个 part 都重写一遍，坑不少。

KILL 也没法立刻中断它，KILL 只是发个信号，正在处理的 part 还是会跑完。mutation 期间新旧版本并存，至少要留三四成的额外空间，100T 的表就是至少 30T 空闲。复制表上每个副本各自跑一遍，整个集群的 IO 都被吃掉，副本之间进度不一致是常态。

进度这么看：

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

某个 part 物化失败了，这个 part 就没有 projection，但整个 mutation 可能照样标成完成，查询走到这个 part 时就用不上 projection 的加速。另外优化器也不一定会选 projection，要用 EXPLAIN 确认：

```sql
EXPLAIN indexes = 1
SELECT event_date, count() FROM events
WHERE event_date >= '2024-01-01'
GROUP BY event_date;
```

看输出里有没有 `Projection: proj_daily_agg`。

所以在 100T 的表上做，流程是这样：先在测试环境验证 projection 的定义和查询能不能命中；确认磁盘至少有 30T 空闲；挑业务低峰期，按分区一批一批地触发：

```sql
SET mutations_sync = 0
ALTER TABLE events MATERIALIZE PROJECTION proj_daily_agg
    IN PARTITION '202401';
```

盯着 `system.mutations`，一个分区验证完再做下一个，全部做完再用 EXPLAIN 确认查询命中了。在这种体量的表上，**MATERIALIZE PROJECTION 一定要带 IN PARTITION 分批做**。

简单的单表聚合、只是为了加速查询，用 Projection；聚合复杂、有下游要消费、要跨表的，用 TO TABLE MV。100T 的表上两个都可以考虑，叠在一起用也行。顺带提一句，华为云 ClickHouse 有个 [Adaptive MV](https://support.huaweicloud.com/intl/en-us/eu-west-0-cmpntguide-lts-mrs/mrs_01_24287.html)，做的就是类似 Projection 那种对用户透明的物化视图。

## 怎么发现 MV 出了问题

MV 出故障，最大的特点是不吭声。查询照常返回，只是数字少了或者错了，没有主动去查的机制，就永远发现不了。

| 故障类型 | 表现 | 发现难度 |
| --- | --- | --- |
| MV SQL 执行报错（OOM、超时）| 源表 INSERT 也失败（默认）| ★ |
| 配了 `materialized_views_ignore_errors=1` | 源表 INSERT 成功，MV 静默丢数 | ★★★★ |
| MV 性能退化 | 数据延迟积压 | ★★★ |
| 源表加列，MV SQL 未更新 | 新列在 MV 里没体现 | ★★ |
| Replicated 副本不一致 | 查不同副本结果不同 | ★★★★ |
| 源数据迟到（业务侧补数）| MV 那个块已处理过，迟到数据进不去 | ★★★★★ |
| MV 链路中间一环挂了 | 上游 OK、下游缺数 | ★★★ |

这些都不会自己冒出来，得主动去查。第一道是扫 query_log 里的错误：

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

更精准的是 `query_views_log`，要在 config 里配上这张表才有：

```sql
SELECT event_time, view_name, view_target,
       status, exception
FROM system.query_views_log
WHERE event_time > now() - INTERVAL 1 HOUR
  AND status != 'QueryFinish';
```

第二道是定时对账，按时间窗口把源表和聚合表对一遍。静默丢数只有这个办法能发现。

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

别拿当天的数据对，MV 有延迟，对 T-1 或者 T-2；也别只对 count，关键的 sum、uniq 也要对；再随机抽几个维度组合比一比。

第三道是水位线：

```sql
SELECT
    max(event_date) AS latest_in_mv,
    today() - max(event_date) AS lag_days
FROM events_agg;
```

想更细一点，可以往源表里定时塞心跳记录，看 MV 延迟了多久。

第四道是副本一致性：

```sql
SELECT
    hostName() AS host,
    sum(rows) AS total_rows,
    sum(bytes_on_disk) AS total_bytes
FROM clusterAllReplicas('your_cluster', system.parts)
WHERE database = 'default' AND table = 'events_agg' AND active
GROUP BY host;
```

第五道是系统级的指标：

```sql
-- ReplicatedMergeTree 积压
SELECT database, table, queue_size, inserts_in_queue, future_parts
FROM system.replicas
WHERE queue_size > 100;

-- 错误计数
SELECT name, value FROM system.errors
WHERE value > 0 ORDER BY value DESC;
```

按时间分层排下来，大概是这样：

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

## 修数据没那么简单

假设发现了 2024-03-15 这一天 MV 漏了数，那就删掉重跑。可真动起手来，每一步都有坑。第一个问题是怎么删。

```sql
-- 方案 A：DROP PARTITION
ALTER TABLE events_agg DROP PARTITION '202403';
```

分区是按月的，为了修一天，整个 3 月都没了。

```sql
-- 方案 B：ALTER DELETE（mutation，慢）
ALTER TABLE events_agg DELETE WHERE event_date = '2024-03-15';
```

100T 这个量级，一个 DELETE 可能跑好几个小时。

```sql
-- 方案 C：Lightweight DELETE
DELETE FROM events_agg WHERE event_date = '2024-03-15';
```

轻量删除 22.8 就有了，早期是实验特性。它只是打标记，马上返回，但数据实际还在，等 merge 的时候才真删。

一般的做法是：分区按天的，直接 DROP PARTITION；按月的，用 `ALTER ... DELETE` 慢慢等 mutation；着急止血的，先用轻量删除让查询结果对了，再慢慢清理。

第二个问题，源表的数据可能已经变了。源表要是 `ReplacingMergeTree` 或者 `CollapsingMergeTree`，重跑 INSERT 时读到的源数据，可能已经被后台合并去重过了，也可能还没合并完。而 MV 当初处理的，是 INSERT 那一刻的原始 block，不是合并以后的样子。重跑时可以加 FINAL：

```sql
INSERT INTO events_agg
SELECT ... FROM events FINAL WHERE event_date = '2024-03-15' ...
```

第三个问题，实时数据还在往里流：

```
T1: 你 DROP PARTITION '20240315'
T2: 源表迟到一条 2024-03-15 的数据 → MV 触发 → 写入 events_agg
T3: 你跑回填 INSERT
```

T2 这条得单独处理。生产上的做法是先把 MV 停掉，或者加个排除条件；删数据；回填；把停掉这段时间漏掉的数据追补回来；再恢复 MV。

第四个问题，State 函数重复合并。`uniqState` 合并是幂等的，重复写一遍结果不变；`sumState`、`countState` 就不是了，原来 sum 是 100，重跑一遍就成了 200。所以重跑之前必须把旧数据清干净。

第五个问题，多个 MV 写同一张目标表。fan-in 的架构下，DROP PARTITION 会把所有上游写进来的数据一起删掉，回头只回填了一个上游，就出大事了。解法是目标表加一个 `source` 字段标明来源，按 source 精确地删。

第六个问题，MV 链的下游：

```
events → mv1 → events_agg → mv2 → events_summary
```

修 `events_agg` 的时候，新 INSERT 会触发 `mv2`，下游表里已有的脏数据就重复了。所以链式的 MV 修数据，要从最下游往上游推。

整个流程排一下：

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

## Schema 变了怎么办

业务永远在变，源表的列一直在加、在改，MV 得跟上，还不能断。

```
源表 events ──┐
              │ (列名/类型耦合)
              ▼
        MV 的 SELECT ──┐
                       │ (列位置耦合)
                       ▼
                  目标表 events_agg
```

这里有两处耦合。MV 的 SELECT 引用了源表的列，源表删列、改名，MV 就报错。MV 的 SELECT 输出要和目标表对齐，目标表加列、调顺序，MV 就写不进去。

源表加列：

```sql
ALTER TABLE events ADD COLUMN channel LowCardinality(String) DEFAULT '';
```

MV 没引用 `channel`，不会挂。想用这个新维度，那就是后面加聚合维度的事了。要注意 MV 里要是写了 `SELECT *`，这时候就会挂，所以 MV 里永远显式地把列名列出来。

目标表加一个新指标：

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

`AggregateFunction` 列的 DEFAULT 要写成一个空的 state。`MODIFY QUERY` 只对之后的 INSERT 生效，历史数据还得自己回填。老版本里 `MODIFY QUERY` 还得先开 `allow_experimental_alter_materialized_view_structure`，新版本这个开关已经废弃了。

最痛的是加聚合维度。比如要给 `events_agg` 加一个 `channel` 维度，ORDER BY 跟着要变，这不是 ALTER 能搞定的，只能建影子表切换：

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

更稳的做法是让业务查询都走一层 view，比如 `final_agg_view`，切换的时候只改 view 的定义。

改聚合函数也一样，`uniq` 换成 `uniqExact`，`AggregateFunction` 的类型都变了，不兼容，走影子表。改列类型分两种，兼容的扩展，比如 `String` 换成 `LowCardinality(String)`、`Int32` 换成 `Int64`，可以直接 ALTER，但那是个 mutation，100T 的表上要跑很久；不兼容的，还是走影子表。

删列要注意顺序，先改 MV 去掉引用，再删源表的列：

```sql
-- 1. 先改 MV，去掉引用
ALTER TABLE mv_events MODIFY QUERY SELECT /* 不再引用 deprecated_col */ ...;

-- 2. 再删源表列
ALTER TABLE events DROP COLUMN deprecated_col;
```

关于 `MODIFY QUERY` 再多说几句。它立刻生效，不会重跑历史，只影响之后 INSERT 触发的计算；新的 SELECT 输出列必须和目标表对得上；`.inner` 表的那种 MV，`MODIFY QUERY` 的限制更多。

这方面 Refreshable 就省心多了。它没有历史 state 已经按旧逻辑算过这个包袱，改完 SELECT 等下一次刷新，自动按新逻辑全量重算，加维度、改聚合、改类型都可以 `MODIFY QUERY`。所以业务还在快速迭代的时候，我更建议先用 Refreshable，等口径稳定了，再迁到增量 MV 上。

## 团队规范

最后把上面这些整理成一份能直接贴到团队 wiki 上的规范。

硬性禁止：

1. 禁止使用 `.inner` 隐式目标表的 MV 写法
2. 禁止 `POPULATE` 关键字
3. 禁止 MV 的 SELECT 中使用 `SELECT *`
4. 禁止业务查询直接引用聚合表名（必须经过 view 层）
5. 禁止无对账的 MV 上生产

强制规范：

1. 所有 MV 使用 TO TABLE 形式，目标表显式建在前
2. 目标表 `PARTITION BY` 必须与源表对齐
3. MV 列引用必须显式枚举
4. 超过 100GB 的回填必须有可断点续传的调度程序
5. 生产 MV 必须配置：`query_views_log` + T+1 对账 + 延迟监控

选型：

1. 简单聚合、近实时：增量 MV（TO TABLE + AggregatingMergeTree）
2. 复杂逻辑 / 含 JOIN / 业务迭代期：Refreshable MV（必带时间窗口）
3. 单表查询加速、零业务侵入：Projection（按分区 MATERIALIZE）
4. 大表预聚合，多个查询模式：MV + Projection 组合

变更：

1. Schema 演化优先 `ALTER MODIFY QUERY`，不兼容变更走影子表 + 原子切换
2. 任何 schema 变更前在测试环境跑通完整流程
3. 数据修复从下游往上游、先停写/隔离再操作、修完做对账

## 最后

物化视图很好用，棱角也很锋利。增量 MV 就是一个 INSERT 触发器，它看到的永远只是当前这个 block，JOIN 右表更新了它不知道，迟到的数据它补不上，出了错还不吭声。Refreshable 是定时调度，想算什么都行，代价是每次全量重算。我见过不少 MV 在测试环境跑得好好的，上了生产没几个月数就对不上了，缺的往往不是 MV 本身写得对不对，是对账、延迟监控和一套能断点续传的回填脚本。

---

**相关**：[字典：省掉的 JOIN，多付的内存](/clickhouse/deep-dive/dictionary) · [到底要不要写 UDF](/clickhouse/deep-dive/udf)
