---
title: Doris 的存储策略：冷数据转 S3 之后，这几件事得先知道
---

# Doris 的存储策略：冷数据转 S3 之后，这几件事得先知道

Doris 也能把冷数据放到对象存储上，热数据留在本地盘，冷数据归档到 HDFS 或者 S3，用来省成本。思路和 ClickHouse 的冷热分层是一回事，但它的抽象多了一层。

ClickHouse 是 disk 和 storage policy 两层，策略直接落在表上。Doris 是三层：先建一个 RESOURCE，相当于一个远程存储介质；再针对这个 resource 建各种策略，比如 7 天转、30 天转、180 天转；最后把策略关联到表上。一个 resource 可以挂多个策略，一个策略可以挂很多张表。

我在测试环境上把这套东西完整跑了一遍，想弄清楚四件事：策略怎么建，建完能不能删，数据到底什么时候转走，以及 S3 挂了会怎么样。结论有几条挺反直觉的，写在这儿。

## 建资源和策略

以 S3 为例，先建一个叫 `remote_s3` 的存储资源：

```sql
CREATE RESOURCE "remote_s3"
PROPERTIES
(
    "type" = "s3",
    "s3.endpoint" = "http://192.168.122.11:9000",
    "s3.region" = "zh-east-1",
    "s3.access_key" = "******",
    "s3.secret_key" = "******",
    "s3.root.path" = "/test",
    "s3.bucket" = "doris-backup"
);
```

建完可以查，除了你填的那几项，Doris 还会补上一堆连接相关的默认值：

```sql
mysql> show resources where name = 'remote_s3';
+-----------+--------------+------------------------------+---------------+
| Name      | ResourceType | Item                         | Value         |
+-----------+--------------+------------------------------+---------------+
| remote_s3 | s3           | id                           | 13055         |
| remote_s3 | s3           | version                      | 0             |
| remote_s3 | s3           | s3.region                    | zh-east-1     |
| remote_s3 | s3           | s3.connection.request.timeout| 3000          |
| remote_s3 | s3           | s3.secret_key                | ******        |
| remote_s3 | s3           | s3.bucket                    | doris-backup  |
| remote_s3 | s3           | s3.connection.timeout        | 1000          |
| remote_s3 | s3           | type                         | s3            |
| remote_s3 | s3           | s3.root.path                 | /test         |
| remote_s3 | s3           | s3.endpoint                  | http://192... |
| remote_s3 | s3           | s3.access_key                | ******        |
| remote_s3 | s3           | s3.connection.maximum        | 50            |
+-----------+--------------+------------------------------+---------------+
12 rows in set (0.00 sec)
```

然后基于这个资源建两个策略，一个 1 小时转走，一个 10 天转走：

```sql
CREATE STORAGE POLICY archive_s3_1h
PROPERTIES(
    "storage_resource" = "remote_s3",
    "cooldown_ttl" = "1h"
);

CREATE STORAGE POLICY archive_s3_10d
PROPERTIES(
    "storage_resource" = "remote_s3",
    "cooldown_ttl" = "10d"
);
```

```sql
mysql> show storage policy;
+----------------+-------+---------+---------+-----------------+---------------+
| PolicyName     | Id    | Version | Type    | StorageResource | CooldownDatetime |
+----------------+-------+---------+---------+-----------------+---------------+
| archive_s3_10d | 13074 | 0       | STORAGE | remote_s3       | -1            |
| archive_s3_1h  | 13076 | 0       | STORAGE | remote_s3       | -1            |
+----------------+-------+---------+---------+-----------------+---------------+
2 rows in set (0.00 sec)
```

挂到表上。我手里有一张 `test_shanghai`，按小时分区：

```sql
ALTER TABLE test_shanghai set ("storage_policy" = "archive_s3_10d");
```

到这儿都很顺。

## 策略建了就删不掉

这张表是当天刚建的，按 10 天的策略，肯定还没有数据转到 S3 上去，所以我觉得这个策略虽然挂上了，但等于没用过，应该可以摘掉。结果：

```sql
mysql> ALTER TABLE test_shanghai set ("storage_policy" = "");
ERROR 1105 (HY000): errCode = 2, detailMessage = Do not support alter table's s...
```

报错说只有表是空的时候才支持删，哪怕 S3 上一个字节都没存。

先验证一下这句话。建一张空表试试：

```sql
mysql> select count(1) from test_empty;
+----------+
| count(1) |
+----------+
|        0 |
+----------+

mysql> ALTER TABLE test_empty set ("storage_policy" = "archive_s3_10d");
Query OK, 0 rows affected (0.01 sec)

mysql> ALTER TABLE test_empty set ("storage_policy" = "");
Query OK, 0 rows affected (0.01 sec)
```

确实是这样，空表可以随便摘。可生产上不可能专门留一张空表来操作存储策略，有数据的表难道就改不了了？

能改。删不行，改成另一个策略是可以的：

```sql
mysql> ALTER TABLE test_shanghai set ("storage_policy" = "archive_s3_1h");
Query OK, 0 rows affected (0.01 sec)
```

那就好办了，建一个永远不会到期的策略，拿它当删除用：

```sql
CREATE STORAGE POLICY empty_none
PROPERTIES(
    "storage_resource" = "remote_s3",
    "cooldown_datetime" = "2099-12-31 23:59:59"
);
```

以后想清掉某张表的存储策略，把它设成 `empty_none` 就行，算是一个软删除。

顺带验证了另一个问题：如果数据已经转到 S3 上了，这时候把时间拉长，比如原来 1 天转，改成 7 天转，那之前已经转走的数据（T-2 到 T-6 那部分）会怎么样？会被删掉？还是迁回本地盘？还是留在 S3？

答案是留在 S3，不动。而本地热盘上的数据，按新策略来，原本今天该转的，现在要等到 7 天后。

## 数据什么时候才转走

研究这个花的时间最多，也最意外。

我观察 `test_shanghai` 的分区：

```sql
mysql> show partitions from test_shanghai;
+-------------+------------------+----------------+---------------------+--------+
| PartitionId | PartitionName    | VisibleVersion | VisibleVersionTime  | State  |
+-------------+------------------+----------------+---------------------+--------+
| 13455       | p20250618120000  | 6              | 2025-06-18 17:12:07 | NORMAL |
| 13479       | p20250618130000  | 2              | 2025-06-18 17:12:07 | NORMAL |
| 13474       | p20250618140000  | 2              | 2025-06-18 17:12:07 | NORMAL |
| 13464       | p20250618150000  | 2              | 2025-06-18 17:12:07 | NORMAL |
| 13469       | p20250618160000  | 3              | 2025-06-18 17:12:21 | NORMAL |
| 13444       | p20250618170000  | 116            | 2025-06-18 17:34:23 | NORMAL |
| 13449       | p20250618180000  | 1              | 2025-06-18 17:08:24 | NORMAL |
+-------------+------------------+----------------+---------------------+--------+
```

最新的分区已经到 `p2025061818` 了，也就是 6 月 18 日 18 点（Doris 会提前创建下一个分区，说明当前时间是 18 日 17 点）。按 1 小时的策略，12 点那个分区早该转走了，可它还在热盘上。

这是产品 BUG 吗？

翻 Doris 的代码才发现，它算 cooldown 时间，根本不是按分区字段 `@timestamp` 算的，用的是一个叫 `VisibleVersionTime` 的东西：

```java
if (policy != null) {
    long latestTime = policy.getCooldownTimestampMs() > 0 ? policy.getCooldow...
    if (policy.getCooldownTtl() > 0) {
        latestTime = Math.min(latestTime, partition.getVisibleVersionTime() ...
    }
    if (latestTime < System.currentTimeMillis() + 20 * 1000) {
        throw new AnalysisException(
            "Cannot cancel storage policy for partition which already be cool..."
                    + " or will be cooldown soon later");
    }
}
```

对照上面的数据，12 点那个分区的 `VisibleVersionTime` 是 `2025-06-18 17:12:07`，离 1 小时还差得远。等到时间真的过了，数据就正常归档到 S3 上去了。

那 `VisibleVersionTime` 到底是什么？Doris 用 MVCC 保证数据写入，每次写入都会生成一个新的版本号，这个字段记的就是最新版本号生成的时间：

```java
protected void setVisibleVersion(long visibleVersion) {
    this.visibleVersion = visibleVersion;
    this.visibleVersionTime = System.currentTimeMillis();  // 取的是当前时间
}
```

也就是说，哪怕你导的是一年前的存量数据，策略设的是超过 3 天转对象存储，只要数据是现在插进去的，那也得等 3 天后才会触发转移。它拿写入时间当存储策略的迁移时间，却拿 `@timestamp` 这个业务时间当分区时间。

我们在 ClickHouse 的存储设计里，TTL 的时间字段是可以自己指定的，而一般都会和分区时间字段保持一致，也就是业务时间，这样从常理上更容易说得通。Doris 为什么要这么设计，说实话我看不大明白。

## 转走了，但你看不出来

还有个挺膈应的地方：Doris 没有哪个地方直接记录数据到底存在哪儿。分区信息里的 `StorageMedium` 字段只记录首次写入时的磁盘介质，所以即使数据已经归档到 S3 了，显示的仍然是 HDD。

只能通过 `DataSize` 来判断。看 tablet 信息，`LocalDataSize` 是 0，`RemoteDataSize` 是 248763，基本就能确定数据已经转到 S3 上了。这一点做得就不如 ClickHouse 直观。

```sql
mysql> show tablets from test_shanghai;
+----------+-----------+-----------+------------+---------+------------------+
| TabletId | ReplicaId | BackendId | SchemaHash | Version | LstSuccessVersion |
+----------+-----------+-----------+------------+---------+------------------+
| 13445    | 13446     | 11142     | 570896234  | 258     | 258              |
| 13445    | 13447     | 11143     | 570896234  | 258     | 258              |
+----------+-----------+-----------+------------+---------+------------------+
```

数据转走了，查询照常：

```sql
mysql> select count(1) from test_shanghai where `@timestamp` < '2025-06-18 14:...
+----------+
| count(1) |
+----------+
|   775586 |
+----------+
1 row in set (0.05 sec)
```

## 想换一个 S3，换不了

设想一下，S3 服务挂了，或者因为某种原因要做改造，得换一个新的 S3 地址，Doris 上已有的存储策略能不能跟着换过去？

我用另一台 S3 服务建了一套新的资源和策略：

```sql
mysql> CREATE RESOURCE "remote_s3_2"
    -> PROPERTIES
    -> (
    ->     "type" = "s3",
    ->     "s3.endpoint" = "http://192.168.122.12:9000",
    ->     "s3.region" = "zh-west-1",
    ->     "s3.access_key" = "******",
    ->     "s3.secret_key" = "******",
    ->     "s3.root.path" = "/test",
    ->     "s3.bucket" = "doris-backup"
    -> );
Query OK, 0 rows affected (0.06 sec)

mysql> CREATE STORAGE POLICY archive_s3_1h_new
    -> PROPERTIES(
    -> "storage_resource" = "remote_s3_2",
    -> "cooldown_ttl" = "1h"
    -> );
Query OK, 0 rows affected (0.00 sec)
```

然后改表的存储策略：

```sql
mysql> ALTER TABLE test_shanghai set ("storage_policy" = "archive_s3_1h_new");
ERROR 1105 (HY000): errCode = 2, detailMessage = Do not support alter table's s...
```

失败了。而在原来那个 s3 上的两个策略之间随意切换，是没问题的：

```sql
mysql> ALTER TABLE test_shanghai set ("storage_policy" = "archive_s3_1h");
Query OK, 0 rows affected (0.09 sec)
```

原因在代码里写得明明白白，改存储策略，仅支持相同的资源：

```java
// If the two policy has one same resource, then it's safe for the table to ...
//     There would only be the cooldown ttl or cooldown time would be ...
if (!Env.getCurrentEnv().getPolicyMgr()
        .checkStoragePolicyIfSameResource(tableStorage Policy, cur...
        && !tableStoragePolicy.isEmpty()) {
    for (Partition partition : olapTable.getAllPartitions()) {
        if (Partition.PARTITION_INIT_VERSION < partition.getVisib...
            throw new DdlException("Do not support alter table's storage policy"
                    + olapTable.getName() + "] has storage policy"
                    + ", the table need to be empty.");
        }
    }
}
```

回过头看，一开始设置存储策略为空会失败，也就说得通了，空策略必然关联不到已有的资源。

那能不能重建一张表关联新策略，再把旧表数据迁过去？试了一下。

```sql
CREATE TABLE IF NOT EXISTS `test_shanghai_new` (
    ...
)
DUPLICATE KEY(`@timestamp`,`@sourcetype`)
AUTO PARTITION BY RANGE(date_trunc(`@timestamp`, 'HOUR')) ()
DISTRIBUTED BY Random BUCKETS 1
PROPERTIES
(
    ...
        "storage_policy"="archive_s3_1h_new"
);
```

```sql
mysql> insert into test_shanghai_new select * from test_shanghai;
Query OK, 883736 rows affected (17.01 sec)
```

插入速度有点慢。把 bucket 数从 1 加到 5 提高并发，速度提升到 7 秒左右，还是不理想。然后停掉写入，把新表名换成旧表名：

```sql
alter table test_shanghai rename test_shanghai_backup;
alter table test_shanghai_new rename test_shanghai;
drop table test_shanghai_backup;
```

技术上这条路确实能换掉 S3 资源，但最大的问题是 `insert into` 的效率。88 万数据花了近 7 秒，要是上亿的数据（实际场景里很常见），那将是一个非常重的操作。相同的数据 ClickHouse 不到 2 秒，这算是降维打击了。

## S3 挂了会怎么样

把 minio 停掉：

```bash
docker stop minio
```

去查，发现数据依然可查。猜测是查询缓存导致的，于是改 `be.conf` 把缓存关掉：

```ini
# 将下面两行注释掉
enable_file_cache = true
file_cache_path = [{"path": "/data01/data/doris/be/file_cache", "total_size":5...
```

重启 be 节点，果然不能查了：

```sql
mysql> select count(1) from test_shanghai where `@timestamp` < '2025-06-19 12:...
ERROR 1105 (HY000): errCode = 2, detailMessage = (192.168.122.101)[CANCELLED]...
```

但是留在本地的数据依然可以查：

```sql
mysql> select count(1) from test_shanghai where `@timestamp` > '2025-06-20 17:...
+----------+
| count(1) |
+----------+
|     1428 |
+----------+
1 row in set (0.06 sec)
```

S3 挂了以后，be 节点和 fe 节点都试着重启了一遍，均可以正常对外提供服务，说明 S3 挂掉并不影响 Doris 集群的健康性。ClickHouse 看什么看，说的就是你。

## 写在后面

存储策略一旦创建，除非表是空的，否则删不掉。但它可以改，所以建一个永不过期的策略，把它当成删除用，效果是一样的。

表关联的策略要是不可用了，比如 S3 服务挂了，会影响到所有关联这个策略的表，但影响范围是有限的：集群健康不受影响，重启依然可用；存储在本地的数据不受影响；只有存到 S3 上的那部分查不了，而且如果开了查询缓存，缓存到本地的那部分其实也不受影响。

目前没有办法把一张表的存储策略从一个 S3 换到另一个 S3。重建表再 `insert into` 理论上可行，但 88 万行就要 7 秒，上亿的表基本不用考虑。

修改存储策略不影响已经转移到远程存储介质上的数据，即使数据不满足新策略，也不会被删除，不会被迁移走，并且仍然可以查。

最后一条最容易踩：存储策略的 cooldown 时间是以 `visibleVersionTime` 为准的，那是数据写入的时间，不是业务数据的时间。导历史数据进来的时候，这一条尤其要留意。

---

**相关**：[2026 年 ClickHouse 和 Doris 怎么选](/clickhouse/comparison/clickhouse-vs-doris) · [S3 Disk：把对象存储当慢盘用，会遇到什么](/clickhouse/cold-storage/s3-disk)
