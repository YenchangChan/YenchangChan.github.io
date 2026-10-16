---
title: 副本表 readonly：什么时候等它自愈，什么时候该重建元数据
---

# 副本表 readonly：什么时候等它自愈，什么时候该重建元数据

INSERT 忽然报 `Table is in readonly mode`，这是 ReplicatedMergeTree 家族最常见的故障之一。副本和 ZooKeeper/Keeper 的协调状态一失效，表就进入 readonly：不再接受任何改动本地数据的操作，查询不受影响。

线上搜一圈，出来的文章大同小异：先 `SYSTEM RESTART REPLICA`，不行就 `SYSTEM RESTORE REPLICA`，再不行 `SYSTEM DROP REPLICA`。三个命令都教了，什么时候用哪个、用错的代价是什么，说得清楚的没几篇。照着这个顺序蒙行不行？多数时候行，蒙错的那次代价不小。

所以这篇把整个链路摊开讲一遍。机制性的结论我都去源码里核实过，关键位置标了文件和行号（master 分支，行号随版本漂移，认逻辑别认数字）。

## readonly 卡住的到底是什么

SELECT 照常。`StorageReplicatedMergeTree::read()` 里没有对 `is_readonly` 的任何检查（`src/Storages/StorageReplicatedMergeTree.cpp:6191`）。有个例外：开了 `select_sequential_consistency` 的查询要去 ZK 上核对，Keeper 不可用时一样报错，不过那是另一回事，跟 readonly 这个机制无关。

INSERT 直接抛 `TABLE_IS_READ_ONLY`（`StorageReplicatedMergeTree.cpp:6421`、`ReplicatedMergeTreeSink.cpp:872`）。ALTER、OPTIMIZE、TRUNCATE、DROP/ATTACH PARTITION、KILL MUTATION 这些写型 DDL 统一走 `assertNotReadonly()`（`StorageReplicatedMergeTree.cpp:6390`）。其他表不受影响，readonly 是表级状态，不牵连同库的其他表，更不牵连其他库。

后台这边动静更大：merge、mutation、队列更新全停，leader 身份也退掉（`StorageReplicatedMergeTree.cpp:6027-6056`、`6004`）。所以 readonly 的副本不光写不进去，也不再干活，合并压力会转嫁到集群其他副本上。表长期 readonly，不能只看查询还正常。

还有一点容易忽略：readonly 多数时候会自己好。session 重连之后，restarting thread 会自动重试启动，成功就清除 readonly（`ReplicatedMergeTreeRestartingThread.cpp:150-186`）。副本「时好时坏」不是玄学，它本身就是个诊断信号，根子在 session 的稳定性，不在单表。

## 什么情况下会被置上

`is_readonly` 这个字段初始就是 true，副本成功启动之后才清掉（`StorageReplicatedMergeTree.h:427`）。运行期重新置回来，原因有这么几类。

最常见的是 ZK/Keeper session 过期（`ReplicatedMergeTreeRestartingThread.cpp:140-143`）：session 一过期，先 partialShutdown，再 setReadonly(true)。关键是所有 ReplicatedMergeTree 表默认共享同一个 ZK session（`StorageReplicatedMergeTree.cpp:336-346`），session 出了问题就不是一张表的事，是成片的事。

其次是表启动失败：从 ZK 加载元数据出异常、撞到 `REPLICA_IS_ALREADY_ACTIVE` 之类，tryStartup 返回 false，表就保持 readonly（`ReplicatedMergeTreeRestartingThread.cpp:190-272`）。

还有一种，元数据在 ZK 上丢了。attach 时发现 `/metadata`、`/replicas/<name>` 这些节点不在，置上 has_metadata_in_zookeeper=false，保持 readonly（`ReplicatedMergeTreeAttachThread.cpp:157-184`）。这种一般是单表或者少数几张表，不成片。配了 auxiliary zookeeper 的表走独立 session，出问题也只波及它自己。

`system.replicas.is_readonly` 查到的就是这个字段，直出（`StorageSystemReplicas.cpp:415`）。

## 先定范围，再决定动不动手

碰到副本 readonly，第一件事永远是定范围。范围不对，后面修哪儿都是白修。

所有表一起 readonly，不用怀疑，Keeper 集群挂了，或者 ClickHouse 到 Keeper 的网络断了。依据就是前面说的共享 session（`Context.cpp:5688`），session 过期通过全局事件广播到每一张表。这种时候**去修 Keeper、修网络，表一张都不要碰**，Keeper 恢复后各表自己脱离 readonly（`ReplicatedMergeTreeRestartingThread.cpp:171`）。等得太久不耐烦，可以对个别表执行 `SYSTEM RESTART REPLICA` 催一下，仅此而已。

大批量表 readonly，偶尔能自己恢复，还换着表轮流来，这就是危险信号了：Keeper 快扛不住了。超时、选举抖动、快照压力、连接数打满，都能让 session 频繁过期。机制上也说得通：过期，成片 readonly，重连成功，恢复，再过期，换个时间片轮到另一批表。这种去查 Keeper 的日志和监控，看 session 超时率、延迟、leader 切换频率。千万不要逐表修复，修好了还会再坏，白费劲。

少数几张表 readonly，一直不自愈，这才轮到元数据修复。典型成因是表路径在 ZK 上被误删、部分节点丢失、双副本元数据互相污染。下面整个流程针对的就是这一种。

## 恢复的顺序

先把问题缩到节点和张表。readonly 是副本级状态，不一定是每个节点都有问题：

```sql
SELECT hostname(), database, table, is_readonly, is_session_expired,
       zookeeper_path, replica_name, absolute_delay
FROM clusterAllReplicas('{cluster}', system.replicas)
WHERE is_readonly = 1;
```

对照 `is_session_expired` 看：`is_session_expired=1` 的根子偏 session，回到前两类场景去；`is_session_expired=0` 又长期不自愈的，才是元数据真丢了。

第一招 `SYSTEM RESTART REPLICA`：

```sql
SYSTEM RESTART REPLICA db.table;
```

实现是把表正常 shutdown、detach，拿本地 metadata 里的 CREATE 语句重新 attach、startup（`InterpreterSystemQuery.cpp:1409-1592`）。readonly 的表可以执行，这里没有 readonly 检查。queue 不是清空，是从 ZK 重新加载（`ReplicatedMergeTreeRestartingThread.cpp:205-211`）。之前只是 session 抖动这类临时问题，到这一步就结束；元数据真丢了的，restart 完还是 readonly，走下一步。

第二招 `SYSTEM RESTORE REPLICA`：

```sql
SYSTEM RESTORE REPLICA db.table;
```

它在 ZK 上重建表级节点和本副本节点，把本地 part 重新挂上（`StorageReplicatedMergeTree.cpp:7229-7341`）。硬前置有两个（`7238-7245`）：表必须处于 readonly，否则报 `Replica must be readonly`；ZK 上该副本的 replica path 必须不存在，否则报：

```
Replica path is present at {} - nothing to restore. ... then use SYSTEM DROP REPLICA query first.
```

报错文案本身就指了路：先 drop，再 restore。

第三招 `SYSTEM DROP REPLICA`，删掉坏副本在 ZK 上的路径：

```sql
SYSTEM DROP REPLICA '坏副本名' FROM ZKPATH '/clickhouse/tables/xx/db/table';
```

前提是集群里还有另一个好副本，数据完整、元数据完整。这个操作只删 ZK 上的 replica 路径，不动坏副本磁盘上的数据（`StorageReplicatedMergeTree.cpp:1507-1630`）。删完回坏节点，restart、restore 再各做一遍。它自带保护：坏副本的 `/is_active` 节点还在，说明人还活着，拒绝删；本地副本自己也不让删（`InterpreterSystemQuery.cpp:1737-1781`）。坏副本还在跑的话，先停掉它，或者等它自己 readonly。

最后一招是兜底，直接登 Keeper 手动删：

```bash
rmr /clickhouse/tables/xx/db/table/replicas/<坏副本名>
```

跟 DROP REPLICA 等价，但所有保护都没了，is_active 不查、路径形态不查、误删不防。只在连不上 ClickHouse、DROP REPLICA 执行不了的时候才用。

整个判断过程就是一棵决策树：

```
表 readonly
  ├─ 所有表？        → 修 Keeper/网络，表会自愈，勿动表
  ├─ 大批表轮换着来？ → Keeper 快扛不住了，去查 Keeper（超时/选举/负载）
  └─ 少数表不自愈？  → clusterAllReplicas 定位节点
                       ├─ SYSTEM RESTART REPLICA ← 先试，临时问题到此为止
                       ├─ 仍 readonly → SYSTEM RESTORE REPLICA
                       │     ├─ 报 Replica path is present → 先 DROP 坏副本的 ZK 路径
                       │     │   （兜底：Keeper 里手动 rmr，无保护，慎用）
                       │     └─ 再 restore
                       └─ 动手前确认幸存副本数据完整
```

## restore 是以幸存副本为准的重建

最后这点最要命，也是网上文章最不讲的。

「两个副本都有数据、但数据不一致，ZK 元数据你中有我我中有你」这种状态真实存在。这种时候 restore 的语义必须搞清楚：它不是数据修复，是以幸存副本为准的重建。`cloneReplicaIfNeeded`（`StorageReplicatedMergeTree.cpp:3690-3753`）拿 source replica 当基准，本地多出来的 part，直接删掉或者挪进 detached，日志原文明写着：

```
Source replica does not have part {}. Removing it from working set.
```

所以「有一个副本是好的，动坏的副本」这个前提必须真的成立：幸存副本数据完整、元数据完整，才配当基准。整个流程走完，两边的最终状态就是幸存副本的状态。

反过来，两边各自持有对方没有的数据时，先什么都别 drop。restore 走完之后，坏副本独有的 part 只会躺在 detached 目录里，不会有任何人去合并它。正确顺序是先把这些 part 人工捞回来对齐，ATTACH PARTITION 或者从 detached move 回去，确认数据齐了再重建元数据。

当然，坏副本的数据要是本来就脏，孤儿 part、残缺 part 一堆，restore 以幸存副本为准，恰恰就是我们要的清理效果。

这套命令看着不少，真正需要动手的只有一种情况：少数几张表长期不自愈，而且集群里留着数据完整的好副本。剩下两类场景，根子都在 Keeper，表一张不用动，动了也白动。

restore 更不是能随手敲的。动手之前把幸存副本的数据完整性确认一遍，把两边独有数据的账算清楚。这一步花的时间，远比 restore 之后从 detached 里捞数据要少。

---

**相关**：[znode 爆炸：根子在 ClickHouse 的后台线程池](/clickhouse/troubleshooting/znode-explosion) · [126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks)
