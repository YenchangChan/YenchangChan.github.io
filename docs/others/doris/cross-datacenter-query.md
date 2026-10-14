---
title: Doris 跨数据中心查询：查视图还是查底表，差别在执行计划里
---

# Doris 跨数据中心查询：查视图还是查底表，差别在执行计划里

给 Doris 的 BE 节点打机房标签，可以解决跨数据中心的写入隔离问题。比如 A 和 C 两个数据中心属于同一个 Doris 集群，给 A 的 BE 打上 `group_a` 标签，给 C 的 BE 打上 `group_c` 标签，建表时用 tag 指定副本的位置，写入的时候 A 的数据就只在 A 的 BE 之间流动，C 的只在 C 的节点之间流动，跨机房的写入流量就没了。

可查询躲不掉。两个中心的数据总是要一起查出来的，尤其是聚合查询，涉及计算，必然要把数据拉到某一个协调节点上去算，跨机房流量不可避免。

那问题就变成了：拉多少。同样一个聚合查询，写法不同，跨机房的数据量能差出好几个数量级。这篇把两种写法的执行计划拆开看。

## 环境

准备了 a 和 c 两个数据中心，节点分布是这样：

| 节点 | 角色 | 机房标签 |
|---|---|---|
| 192.168.122.103 | FE | |
| 192.168.122.101 | BE | group_a |
| 192.168.122.102 | BE | group_b |
| 192.168.122.103 | BE | group_c |

表是这么建的：

| 表名 | | 副本 tag | 说明 |
|---|---|---|---|
| test_group_a | 物理表 | group_a:1 | 存 a 中心的数据 |
| test_group_c | 物理表 | group_c:1 | 存 c 中心的数据 |
| logic_test_all | 普通视图 | | `select * from test_group_a union all select * from test_group_c` |

在这上面跑一个很常规的聚合查询，按 `@path` 求 count。

## 先说怎么读 Doris 的执行计划

后面全靠执行计划说话，先把几个概念过一遍。

FRAGMENT 是执行片段。Doris 是分布式执行引擎，一个完整的执行计划会被切成多个单机的执行片段，一个 FRAGMENT 就是一个完整的单机片段，多个 FRAGMENT 拼起来才是一个完整的 PLAN。每个 FRAGMENT 内部，按缩进层级从下往上看。

RESULT SINK 是向 FE 发送结果数据，第一行标明用的什么协议，现在有 MySQL 协议和 arrow 协议。

EXCHANGE 是数据交换算子，看到这个关键字，就说明数据发生了跨节点传输。EXCHANGE 会指定数据交换到哪个 id，与之对应的接收端用 VEXCHANGE 标识对应关系：

```
  9:VEXCHANGE
--------------
 STREAM DATA SINK
     EXCHANGE ID: 09
```

OlapScanNode 是数据扫描算子，从磁盘上扫数据。

STREAM DATA SINK 是向下一个 Fragment 输出数据，主要看两行：第一行是数据发给哪个下游的 EXCHANGE NODE，第二行是按什么方式发。方式有三种。UNPARTITIONED 是下游每个 instance 都拿到全量数据，一般出现在 broadcast join，或者需要单 instance 计算的逻辑，比如全局的 limit、order by。RANDOM 是下游每个 instance 拿到随机的一组数据，instance 之间不重复。HASH_PARTITIONED 是以后面列出的 slot 为 key 做 hash，同一个 hash 分片的数据发到同一个下游 instance，多用于 partition hash join、两阶段聚合的第二阶段这些算子的上游。

HAS_COLO_PLAN_NODE 表示当前 fragment 里有没有 colocate 算子，也就是本地 join。PARTITION 展示当前 Fragment 的数据分布情况。

AGGREGATE 是聚合算子，分 update 和 merge 两个阶段，update 是本地聚合，merge 是全局聚合。这两个词后面要反复用到。STREAMING 只有多阶段聚合的局部聚合算子才有，表示这个聚合节点可能用 STREAMING 模式，也就是不做实际计算，直接把输入数据透传给下一阶段的聚合算子。cardinality 是优化器预估的扫描行数。

## 方案一：查普通视图

最自然的写法，直接查视图：

```sql
select
  `@path`,
  count(1) as cnt
from
  logic_test_all
where
  `@timestamp` >= '2025-03-10 00:00:00'
  and `@timestamp` < '2025-03-11 00:00:00'
group by
  `@path`
```

执行计划一共 5 个 FRAGMENT，从下往上看。

FRAGMENT4 查 `test_group_a` 表，过滤之后剩一个 partition、10 个 tablet，把查出来的数据发给编号 01 的 VEXCHANGE。

FRAGMENT3 查 `test_group_c` 表，把数据发给编号 03 的 VEXCHANGE，这一步和 FRAGMENT4 同步进行。

FRAGMENT2 是关键。编号 1 和编号 3 的 VEXCHANGE 分别从上面两个 fragment 收到数据之后做 union，然后拿 union 之后的数据做聚合。注意这里是 update，也就是本地聚合，因为数据都已经拉到本地了。聚合完再发给编号 06 的 VEXCHANGE。

FRAGMENT1 收到数据以后做全局聚合，发给编号 08 的 VEXCHANGE。

FRAGMENT0 收到数据，通过 MySQL 协议发给 FE 返回。

看出问题了：两个 Scan 节点扫完数据，**没有在本地做任何聚合，直接把过滤后的全量数据跨中心拉到了同一个节点上**。视图这层 union all 把聚合挡在了外面，只有 where 条件下沉了下去。

```
2:VOlapScanNode(450)
   TABLE: demo.test_group_c(test_group_c), PREAGGREGATION: ON
   PREDICATES: ((@timestamp[#15] >= '2025-03-10 00:00:00') AND (@timestamp[#15] < '2025-03-11 00:00:00'))
   partitions=1/82 (p20250310)
   tablets=10/10, tabletList=77281,77283,77285 ...
   cardinality=236618, avgRowSize=0.0, numNodes=1
```

拉过去的还不是只有 `@path` 一列，是视图里的所有字段。一天的数据 23 万行，字段几十个，这个量全走内网，再多几个这样的查询，带宽就该告警了。

## 方案二：查底表，自己写两层聚合

把 union all 挪到聚合外面，让每张底表先各自聚合一次，外层再 sum 一次：

```sql
select `@path`, sum(cnt) as cnt from
    (select
      `@path`,
      count(1) as cnt
    from
      test_group_a
    where
      `@timestamp` >= '2025-03-10 00:00:00'
      and `@timestamp` < '2025-03-11 00:00:00'
    group by
      `@path`
union all
select
  `@path`,
  count(1) as cnt
from
  test_group_c
where
  `@timestamp` >= '2025-03-10 00:00:00'
  and `@timestamp` < '2025-03-11 00:00:00'
group by
  `@path`) t
group by `@path`
```

同样是 5 个 fragment，但分工完全不同。

FRAGMENT4，`test_group_a` 按时间筛完，做一次本地聚合，把聚合后的数据发给 02。

FRAGMENT3，`test_group_c` 按时间筛完，做一次本地聚合，发给 06，和 FRAGMENT4 同步进行。

FRAGMENT2，02 收到 group_a 聚合后的数据做一次全局聚合（多个 BE 的数据再聚一次，这里只有一个 BE，所以聚完结果一样）；同时 06 收到 group_c 聚合后的数据也做一次全局聚合。两边聚完做 union，再把 union 的结果做一次本地聚合，也就是外层那个 sum，发给 10。

FRAGMENT1 收到 10 的数据做全局聚合，发给 12。

FRAGMENT0 把数据通过 MySQL 协议返回。

这回过滤条件和聚合计算都下沉到了具体的 BE 节点上。从 profile 里能看到两个 Scan 分别落在两台机器上：

```
Fragment  3:
    Pipeline  :0    (host=TNetworkAddress(hostname:192.168.122.103,  port:9050)):
            DATA_STREAM_SINK_OPERATOR  (id=6,dst_id=6):
                STREAMING_AGGREGATION_OPERATOR  (id=5):
                    OLAP_SCAN_OPERATOR  (id=4.  table  name  =  test_group_c(test_group_c)):

Fragment  4:
    Pipeline  :0    (host=TNetworkAddress(hostname:192.168.122.101,  port:9050)):
            DATA_STREAM_SINK_OPERATOR  (id=2,dst_id=2):
                STREAMING_AGGREGATION_OPERATOR  (id=1):
                    OLAP_SCAN_OPERATOR  (id=0.  table  name  =  test_group_a(test_group_a)):
```

两边各自扫 23 万行，本地聚成 19 行（`cardinality=19`），跨机房传的就是这 19 行。

## 这两种写法怎么选

查普通视图，只有过滤条件能下沉，聚合不能下沉，得把过滤后的全量数据，也就是视图里的所有字段，全部跨中心拉到一个节点上去聚合。

查底表再自己写两层聚合，过滤条件和聚合计算都能下沉到具体的 BE 节点。所以如果本地聚合能过滤掉绝大多数数据，这就是当前的最优解。

但这个方案也有不确定的地方。从 profile 看，做二次全局聚合的那个节点，Fragment 2 落在了 103 上，Fragment 1 也落在 103 上，可这是调度决定的，不是你能指定的。本地聚合要是收敛得不明显，比如 group by 的基数很大，那二次聚合这一跳照样要跨机房搬一大堆数据。

还有一点，就算不是聚合查询，简单的明细查询，也没法保证 BE 节点的调度，数据都有可能跨中心流动。所以明细查询一定要做好 limit 限制，不然数据一多，内网带宽就打满了。

---

**相关**：[2026 年 ClickHouse 和 Doris 怎么选](/clickhouse/comparison/clickhouse-vs-doris) · [ClickHouse 集群机房搬迁实战](/clickhouse/tooling/datacenter-migration)
