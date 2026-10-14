---
title: FINAL 查询为什么慢：两种提速办法，各自会把结果改错
---

# FINAL 查询为什么慢：两种提速办法，各自会把结果改错

## 查询时为什么要加 FINAL

用 ClickHouse 存数据，通常会有一些去重的需求，这时候可以用 `ReplacingMergeTree` 引擎。这个引擎允许你存重复数据，但是在 merge 的时候会根据 ORDER BY 的字段进行去重，去重逻辑是用新数据覆盖旧数据。

但是很多时候，merge 并不是实时的，可能在数据插入后几分钟甚至十几分钟后才会进行，而我们对数据的查询却往往是实时的。这个时候就必然出现一个问题：那些还没来得及 merge 的数据，查出来会有重复。这与我们期望的效果是背道而驰的。

事实上，即便是 merge 发生了，我们也不能保证数据一定没有重复。举个简单的例子：

```
p1(id=1,2)  p2(id=2,2)  p3(id=1,3)  p4(id=2,4)      p5(id=2,3)
     └────┬─────┘            └────┬─────┘            ← 新插入
       p1_2(1,2)              p3_4(1,2,3,4)
            └──────────┬──────────┘
                  p1_4(1,2,3,4)
```

p1 到 p4 是四个原始 part，发生合并之后数据进行了去重，最终合并成了 p1_4，对 id 去重之后有四个值，分别为 1、2、3、4。假设此时又有一个新 part p5 插入，此时去查询，仍然能搜到两条 id 为 2 和 3 的数据。

所以即使发生了合并，我们也不能保证数据就一定是唯一的。

ClickHouse 为了解决这个问题，提供了 FINAL 语法，从字面意义上理解，就是返回 merge 最终态的数据结果，它的效果与 `OPTIMIZE FINAL` 是一致的。不过 `SELECT FINAL` 仅是在读时合并，并不会实际将底层数据合并，而 `OPTIMIZE FINAL` 则是实实在在地发生合并，这是二者的本质区别。

## FINAL 查询会有什么问题

代价有多大，取决于数据量。

因为 FINAL 相当于在查询时执行一次 `OPTIMIZE FINAL`，而这个操作是把同一个 partition 内的数据合并成一个 part。在数据量不大的情况下还好，这个操作还能很快返回，如果数据集比较大，比如单个分区的数据已经达到了上千万级，甚至上亿级，那么一次 FINAL 可真是要亲命了。

为了直观地感受这种性能差距，拿 ClickHouse 官方提供的 [opensky 数据集](https://clickhouse.com/docs/en/getting-started/example-datasets/opensky#validate-data)举个例子。建表语句如下：

```sql
CREATE TABLE opensky
(
    `callsign` String,
    `number` String,
    `icao24` String,
    `registration` String,
    `typecode` String,
    `origin` String,
    `destination` String,
    `firstseen` DateTime,
    `lastseen` DateTime,
    `day` DateTime,
    `latitude_1` Float64,
    `longitude_1` Float64,
    `altitude_1` Float64,
    `latitude_2` Float64,
    `longitude_2` Float64,
    `altitude_2` Float64
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMMDD(day)
ORDER BY (origin, destination, callsign)
```

把数据导入两遍，这样就一定会得到重复的数据：

```
ck94 :) select count() from opensky;

┌───count()─┐
│ 127132244 │
└───────────┘

1 row in set. Elapsed: 0.007 sec.
```

不加 FINAL 查一下：

```
ck94 :) select avg(altitude_1) from opensky where day >= '2020-10-01 00:00:00' and typecode = 'B737';

┌───avg(altitude_1)─┐
│ 1458.747590785874 │
└───────────────────┘

1 row in set. Elapsed: 0.186 sec. Processed 34.74 million rows, 812.04 MB
Peak memory usage: 14.39 MiB.
```

0.186 秒。加上 FINAL：

```
ck94 :) select avg(altitude_1) from opensky final where day >= '2020-10-01 00:00:00' and typecode = 'B737';

┌───avg(altitude_1)─┐
│ 1336.428016437283 │
└───────────────────┘

1 row in set. Elapsed: 12.784 sec. Processed 48.60 million rows, 3.06 GB
Peak memory usage: 4.16 GiB.
```

12.784 秒，近 70 倍的差距，内存从 14 MiB 涨到了 4.16 GiB。当前这个数据集还不算大，换成生产上的量级，这个耗时基本没法接受。

顺带注意一下两次的结果：不加 FINAL 是 1458.75，加了是 1336.43。两个数不一样，是 FINAL 真的在去重。这张表的 ORDER BY 是 `(origin, destination, callsign)`，同一条航线、同一个呼号的多条记录会被折叠成一条，剩下的只有最后写入的那一条。所以**是否加 FINAL，查出来本来就是两个不同的数**，这一点在后面判断优化手段对不对的时候很关键。

那么，这个问题如此明显，有没有什么好的优化手段呢？下面两种都是我当年用过的，不过它们都有代价，而且这代价在 2024 年我写第一版的时候没看清楚。这次在 26.3.3 上重新验了一遍，补在各自后面。

## 手段一：显式写 PREWHERE

所谓 PREWHERE，就是在查询之前先把数据过滤掉一部分，这样目标数据集的规模小了，执行 FINAL 自然会快。

按官方的说法，如果查询条件里带有主键字段，ClickHouse 会默认使用 PREWHERE 进行优化，提前减少数据集的大小，一来避免过多内存造成 OOM，二来自然是可以加速查询了。然而十分悲催的是，这个优化对加了 FINAL 的查询不会生效。

26.3.3 上我用 `EXPLAIN actions=1` 看了一下，这一点没变：

```
=== 不加 FINAL ===
    ReadFromMergeTree (default.t)
    Prewhere info
      Prewhere filter
      Prewhere filter column: and(greaterOrEquals(day, ...), equals(typecode, 'B737')) (removed)

=== 加 FINAL ===
  Filter ((WHERE + Change column names to column identifiers))
  Filter column: and(greaterOrEquals(day, ...), equals(typecode, 'B737')) (removed)
    ReadFromMergeTree (default.t)
```

不加 FINAL 的那条有 `Prewhere info`，加了 FINAL 的只剩一个普通的 `Filter`，先读后过滤。顺带说一句，老版本用 `EXPLAIN SYNTAX` 能直接看到优化器把 WHERE 改写成了 PREWHERE，新版本的分析器把这一步挪到了更后面，`EXPLAIN SYNTAX` 已经看不到了，得用 `EXPLAIN actions=1`。

那就自己写上：

```
ck94 :) select avg(altitude_1) from opensky final prewhere day >= '2020-10-01 00:00:00' and typecode = 'B737';

┌────avg(altitude_1)─┐
│ 1424.1051732278174 │
└────────────────────┘

1 row in set. Elapsed: 1.429 sec. Processed 48.60 million rows, 3.06 GB
Peak memory usage: 1.19 GiB.
```

从 12.784 秒降到 1.429 秒，差不多 9 倍的提升，内存也从 4.16 GiB 降到了 1.19 GiB。

### 代价：它会把被覆盖的旧数据捞回来

但是看结果，1424.11。前面加 FINAL 是 1336.43，不加是 1458.75。三个数两两不同，说明这个写法既不等于去重后的结果，也不等于不去重的结果，它是第三个东西。

当年我没管这个数，只看了耗时。这次在 26.3.3 上造了个最小的例子：

```sql
CREATE TABLE t (origin String, destination String, callsign String,
                day DateTime, typecode String, altitude_1 Float64)
ENGINE = ReplacingMergeTree PARTITION BY toYYYYMMDD(day)
ORDER BY (origin, destination, callsign);

SYSTEM STOP MERGES t;
-- 同一个 key，旧版本 typecode 是 B737，新版本被改成了 A320
INSERT INTO t VALUES ('A','B','C1','2020-10-01 00:00:00','B737', 1000);
INSERT INTO t VALUES ('A','B','C1','2020-10-01 00:00:00','A320', 2000);

SELECT 'FINAL + WHERE   ', count(), sum(altitude_1) FROM t FINAL WHERE typecode = 'B737';
SELECT 'FINAL + PREWHERE', count(), sum(altitude_1) FROM t FINAL PREWHERE typecode = 'B737';
```

```
FINAL + WHERE       0    0
FINAL + PREWHERE    1    1000
```

正确答案是 0 行。这个 key 的最新版本 typecode 已经是 A320 了，按 B737 过滤本来就不该有数据。可 PREWHERE 在去重之前就把 A320 那行滤掉了，剩下的 B737 旧行没有了竞争对手，于是它成了「最新版本」，被当成有效数据返回了。

说白了，PREWHERE 和 FINAL 的执行顺序是反的。FINAL 要求先把同 key 的多个版本凑齐、选出最新的那个，再做过滤；PREWHERE 的全部意义就是尽早过滤、少读数据。两件事天生打架。只要过滤条件涉及的列不是 ORDER BY 的一部分，就有可能出这种事。

所以这个手段能不能用，取决于过滤条件。只按主键字段过滤是安全的，同一个 key 的所有版本要么全进要么全不进，不会出现一部分被滤掉的情况。像上面 `typecode` 这种非主键字段，就不能放进 PREWHERE。

## 手段二：禁止 FINAL 查询跨分区 merge

ClickHouse 本身是允许跨分区进行数据替换的，这无疑复杂化了 FINAL 查询的逻辑。但事实上，只要我们的数据分区合理，这种情况完全可以规避掉。这时候可以用 `do_not_merge_across_partitions_select_final=1` 来禁止 FINAL 查询时的跨分区合并，这意味着 ClickHouse 仅在本分区内进行 merge 去重。

```
ck94 :) select avg(altitude_1) from opensky final where day >= '2020-10-01 00:00:00' and typecode = 'B737'
        settings do_not_merge_across_partitions_select_final = 1;

┌────avg(altitude_1)─┐
│ 1458.6043678101414 │
└────────────────────┘

1 row in set. Elapsed: 0.732 sec. Processed 34.74 million rows, 2.18 GB
Peak memory usage: 2.86 GiB.
```

0.732 秒。

### 代价：同一个 key 跨了分区就漏去重

这里的前提是「数据分区合理」，但什么叫合理，当年我没说清楚。

这张表 `PARTITION BY toYYYYMMDD(day)`，`ORDER BY (origin, destination, callsign)`，`day` 根本不在 ORDER BY 里。也就是说同一条航线、同一个呼号的两条记录，完全可以落在两个不同的日期分区里。这时候禁止跨分区 merge，就是直接漏掉去重。

```sql
SYSTEM STOP MERGES t;
INSERT INTO t VALUES ('A','B','C1','2020-10-01 00:00:00','B737', 1000);
INSERT INTO t VALUES ('A','B','C1','2020-10-02 00:00:00','B737', 2000);

SELECT 'FINAL 默认          ', count(), sum(altitude_1) FROM t FINAL;
SELECT 'FINAL 不跨分区 merge', count(), sum(altitude_1) FROM t FINAL
  SETTINGS do_not_merge_across_partitions_select_final = 1;
```

```
FINAL 默认             1    2000
FINAL 不跨分区 merge   2    3000
```

默认情况下 FINAL 把两行折叠成了一行，开了这个设置之后变回两行。上面那个 1458.60 的结果比去重后的 1336.43 大了一截，原因就在这。

安全的前提是：分区键用到的所有列，都得包含在主键里。这样同一个 key 的数据物理上一定落在同一个分区，不跨分区 merge 才不会丢东西。

好消息是 26.2 起 ClickHouse 把这个判断自动化了。`enable_automatic_decision_for_merging_across_partitions_for_final` 默认就是开的，官方的描述是，当分区键表达式是确定性的、并且分区键用到的列全都包含在主键里时，自动启用这个优化。浮点列被排除在外，因为 FINAL 的比较逻辑比值相等更粗，`-0.0` 和 `0.0` 相等，所有 NaN 之间也相等，而分区表达式能把它们分开。

所以在 26.2 及以后的版本上，这个优化不用自己去开，该用的时候 ClickHouse 自己会用。反过来说，手动把 `do_not_merge_across_partitions_select_final` 设成 1，恰恰是绕过了这个安全检查。要用它，先确认分区键的列都在主键里；如果满足，那你本来就不用设它。

## 还有一种写法，但它压根没在去重

当年我还试过第三种写法，用子查询先命中 PREWHERE，再套一层 FINAL：

```sql
select avg(altitude_1) from opensky
where (origin, destination, callsign) in (
    select origin, destination, callsign from opensky
    where day >= '2020-10-01 00:00:00' and typecode = 'B737'
) and day >= '2020-10-01 00:00:00' and typecode = 'B737'
```

0.768 秒，几乎追平不加 FINAL 的裸查询。当时我挺得意的。

可回头看这条 SQL，外层根本没有 FINAL。它返回的 1458.7475907858748，和不加 FINAL 的 1458.7475907858743 对到了小数点后十几位，快的原因是压根没在去重。我也在 26.3.3 上确认了，外层不带 FINAL 的这个写法，结果和裸查询完全一致。

子查询这个思路本身没错，让内层那个不带 FINAL 的查询去吃 PREWHERE 优化，把候选集缩小，外层再对小数据集做 FINAL。但外层那个 FINAL 不能丢。我手上没有当年那套 127M 行的环境，所以带 FINAL 的版本到底能提速多少，我没有数，不好乱写。要用这个思路的话，自己压一下，顺便对一下结果是不是等于普通 FINAL 的那个数。

## 怎么选

能不用 FINAL 就不用。写入侧能保证不重复的话，这一整篇都不用看。

真要用，先看过滤条件。只按主键字段过滤的，显式 PREWHERE 是安全的，这是收益最大、代价最小的一条。过滤条件带非主键字段，PREWHERE 就别用了，它会把被覆盖的旧数据捞回来，而且不报错。

跨分区那个设置，26.2 以后交给 ClickHouse 自己判断，别手动设。老版本上要设，先确认分区键用到的列全都在主键里。

最后是验证的办法。这几种优化判断对不对，不要只看耗时，要对结果。随便挑一个聚合值，拿普通 FINAL 的结果当基准，优化之后的数必须和它一模一样。对不上就说明优化动了语义，不管它快多少都不能用。上面三种写法，当年我只看了秒数，三个数都不一样，我一个都没发现。

---

**相关**：[同一条 SQL 每次查出来不一样](/clickhouse/deep-dive/inconsistent-query-results) · [Too many parts：merge 追不上写入的时候](/clickhouse/deep-dive/too-many-parts) · [物化视图：三种机制，以及 100T 表上的 POPULATE](/clickhouse/deep-dive/materialized-view)
