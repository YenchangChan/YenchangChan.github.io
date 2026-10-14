---
title: 冷数据上的 ALTER TABLE：三种方案各会发生什么
---

# 冷数据上的 ALTER TABLE：三种方案各会发生什么

冷热分层是一次性的架构选择，schema 变更却是天天要面对的运维。业务隔几个月就要加列、改类型、删列，再正常不过了。可冷数据到了 100T 这个量级，一句普通的 `ALTER TABLE ADD COLUMN`，可能一眨眼就完了，也可能折腾好几个星期，差别就在于你走的是哪种存储方案、用的是哪种 ALTER。

这篇是 [冷热分层](/clickhouse/cold-storage/) 这一栏的补充。不再讨论该选哪种方案，只讨论方案选好以后，schema 怎么改才不出事。说的是三种常见的冷数据方案：S3 Disk，ClickHouse 原生的冷热分层，part 还是 ClickHouse 的 part，ClickHouse 全权管着；BACKUP/RESTORE，专门做合规归档，backup 是脱离了线上表的自描述快照；S3 Engine 加 Parquet，走湖仓化的路子，数据用 Parquet 这种开放格式存。

## ALTER 在内部走哪条路

ALTER 在内部走两条路，后面三个场景的结论都是从这儿来的。

一条是只改元数据的路：

```sql
ALTER TABLE t ADD COLUMN foo String DEFAULT '';
ALTER TABLE t ADD COLUMN bar Nullable(Int64);
ALTER TABLE t RENAME COLUMN old_name TO new_name;
```

它改的是 schema 的元数据（`metadata/<db>/<t>.sql`），通过 ZK 通知所有副本，一个 part 文件都不动。老 part 里没有这一列，查询用到的时候，按 DEFAULT 表达式现算出来，开销也就是算一次表达式，可以忽略不计。100T 的数据加一列，毫秒级完成，S3 上一点 IO 都没有。

另一条是 mutation：

```sql
ALTER TABLE t MATERIALIZE COLUMN foo;          -- 显式
ALTER TABLE t MODIFY COLUMN x Int64;            -- 改类型
ALTER TABLE t UPDATE col = v WHERE ...;         -- 数据变更
```

每个 part 都要跑一遍 mutation，产出一个新 part，老 part 标记删除，后台异步清掉。要重写多少，看是哪种 ALTER：MATERIALIZE 只写新列，改类型要重写整列，UPDATE 可能重写好几列。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/alter-01.light.svg" alt="ALTER 的两条执行路径：只改元数据的瞬时路径，和逐个 part 重写的 mutation 路径">
<img class="dfig-d" src="/diagrams/alter-01.dark.svg" alt="ALTER 的两条执行路径：只改元数据的瞬时路径，和逐个 part 重写的 mutation 路径">
</figure>

后面三个场景，说来说去都是在看你的 ALTER 落在了哪一条路上。

## 先看全貌

三种常见的 ALTER 放在三种方案上，代价大概是这样：

| ALTER 类型 | S3 Disk（在线） | BACKUP（已归档） | Parquet（已写入 S3） |
|---|---|---|---|
| `ADD COLUMN` 默认（不 MATERIALIZE）| 瞬时，零 IO | 不影响 backup | 老 Parquet 缺列，读时返回 DEFAULT |
| `ADD COLUMN` + `MATERIALIZE COLUMN` | 全 part mutation，几天到几周 | 不影响 backup（线上表的 mutation 不写 backup） | 不适用（Parquet 由外部生产，没有 ClickHouse mutation） |
| `MODIFY COLUMN type` | 全表 mutation，TB 级 IO | 恢复到新表可以；合并回原表会失败 | 读时只支持有限的类型转换 |
| `DROP COLUMN` | 改元数据，异步清理 | 合并回原表时 schema 对不上 | 老 Parquet 里还有这列，新查询不读 |
| `RENAME COLUMN` | 瞬时（较新版本） | 合并回原表时 schema 对不上 | 列名对不上，老 Parquet 这列读不到 |
| `MODIFY ORDER BY`（追加列） | 瞬时 | 两种恢复方式都麻烦 | 不适用（外部表没有 ORDER BY） |
| `MODIFY TTL` | 默认会对全表跑一次 MATERIALIZE TTL | 不影响 backup | 不适用 |

S3 Disk 上 schema 变更的代价最没谱，同样是 ADD COLUMN，带不带 MATERIALIZE 差了三个数量级。BACKUP 最干净，线上表怎么 ALTER 都碰不到已经归档的 backup，因为 backup 是自描述的快照。Parquet 对 schema 变更最友好，大多数 ALTER 在 Parquet 上都能自动兼容。

## S3 Disk 上的 ALTER

### ADD COLUMN 本身没事，坑在顺手的 MATERIALIZE

不带 MATERIALIZE 的 ADD COLUMN 就是上面那条只改元数据的路，老 part 靠读时现算兜着。

可这条路上有几个地方，很容易一不小心就触发了 MATERIALIZE。一是 DDL 自动化工具，不少团队的发布流水线会在 `ADD COLUMN` 后面跟一句 `MATERIALIZE COLUMN`，当成「同步落盘」的步骤，小表上无所谓，100T 的表上就是灾难。二是 `mutations_sync=2`，它让 ALTER 同步等 mutation 跑完，DDL 里要是不小心带了 MATERIALIZE，这条 ALTER 就能卡好几天，看着像挂了。三是业务团队自己要求 materialize，理由一般是想让老数据也用上新的 codec 压缩，在 100T 上这么干，代价远比收益大。

### MATERIALIZE COLUMN 在 100T S3 上要花多少

假设 part 平均 200MB，那就是 50 万个 part。每个 part 跑一遍 mutation：要算 DEFAULT，如果它依赖别的列，还得先从 S3 把那些列读回来；老列 hard-link 到新 part，在 S3 disk 上就是更新一下本地的 metadata 映射，不复制 S3 对象；新列写到 S3；老 part 标记删除。

S3 写入量要看 DEFAULT 是什么。是常量的话，只写新列，压缩后按每行 10 字节、千亿行算，大约写 1TB；要是像 `DEFAULT user_id % 100` 这种表达式，就得把 user_id 这一列全表从 S3 读一遍，出口流量是几 TB 到几十 TB。

请求数更不显眼。50 万个 part，每个 part 要 PUT 5 到 10 次，新列的 .bin、.mrk，还要更新 columns.txt、checksums.txt、count.txt，加起来几百万次 PUT，按 $0.005 每千次算，也就 $25。钱不多，可容易撞上 S3 的限流（默认每个 prefix 每秒 3500 次 PUT），一拖就是好几天。

最容易被忽略的是 storage policy 漂移。理论上 mutation 的输出会留在原 part 所在的 disk 上，但这跟版本有关。早期有些版本的 mutation 输出会按当前的 storage policy 重新分配，冷 part 的 mutation 结果可能被写到热盘上，几百 GB 的热盘一下子就被几十 TB 的 mutation 输出撑爆了。所以一定要先在影子表上把当前版本的行为验一遍。

还有 ZK。每个 mutation 都会在 ZK 上建节点，50 万个 part 乘上副本数，ZK 的写入量非常大，副本之间的协调很容易卡死，到时候还得 `SYSTEM SYNC REPLICA` 去救。

### 改类型永远要走 mutation

```sql
ALTER TABLE t MODIFY COLUMN x Int64;  -- 原本 Int32
```

改类型没有轻量的路可走，一定是全表 mutation，而且比 MATERIALIZE 还贵，它不光写新列，还得把老列读出来、转换、再写进去。100T 的表全读一遍，出口 100T 流量；转换完写回去，入口又是 100T。时间完全卡在 S3 带宽和 background_pool_size 上，按进出各 1Gbps 算，得好几周。

所以能不改类型就别改。真要改，常见的绕法是这样的：

```sql
-- 1. 加新列(瞬时,不 MATERIALIZE)
ALTER TABLE t ADD COLUMN x_v2 Int64 DEFAULT toInt64(x);

-- 2. 业务双写改造期间写 x_v2

-- 3. 老数据按月分批 materialize(避免一次性扫全表)
ALTER TABLE t MATERIALIZE COLUMN x_v2 IN PARTITION '202401';
ALTER TABLE t MATERIALIZE COLUMN x_v2 IN PARTITION '202402';
-- ... 按月推进

-- 4. 全部 materialize 完后 DROP 老列
ALTER TABLE t DROP COLUMN x;
ALTER TABLE t RENAME COLUMN x_v2 TO x;
```

这样就把一次性重写 100T，拆成了每个月几 TB，每一次的代价都可控，可以排进维护窗口里慢慢做。

### DROP COLUMN 是改元数据加异步清理

DROP COLUMN 会马上更新 schema 元数据，这一列立刻从 `SELECT *` 里消失；然后调度一个 mutation，在后台把这列的 .bin、.mrk 文件物理删掉，不影响业务。

在 S3 上就是元数据一瞬间改完，列文件在后台慢慢删，删完之前它们还在 S3 上占着空间。要是这一列特别大，比如某个 String 列占了 30T，删除期间 S3 用量看着一点没降，运维可能以为没生效。这时候去看 `system.mutations` 的进度，必要的话把 `background_pool_size` 调大，让它清得快一点。

### MODIFY ORDER BY：在线没感觉，坑埋在后面

```sql
ALTER TABLE t ADD COLUMN new_col String, MODIFY ORDER BY (existing_pk_col, new_col);
```

ClickHouse 只允许在排序键的末尾追加列，而且追加的必须是同一条 ALTER 里新加的列，现有的顺序不能改。在线上它只改元数据，老 part 的物理排序不变，新写入的 part 按新的 ORDER BY 排。

看着挺好，可代价挪到了别处。新老 part 的排序不一致，有些查询就用不上主键索引加速了。BACKUP 的兼容性也被破坏了，老 backup 想合并回当前 schema 的线上表会失败，下面 BACKUP 那一节细说。

### MODIFY TTL 会顺手跑一次全表 mutation

```sql
ALTER TABLE t MODIFY TTL event_time + INTERVAL 60 DAY TO VOLUME 'cold';
```

按直觉，改 TTL 只影响以后什么时候往冷盘移。可 `materialize_ttl_after_modify` 默认是开的，MODIFY TTL 以后会自动跑一次 MATERIALIZE TTL，对所有 part 重新评估一遍 TTL，这本身就是一次 mutation。重评估期间，part 可能在热盘和冷盘之间来回搬，又是前面说的 storage policy 漂移。

所以 MODIFY TTL 之前先想清楚要不要对老数据生效。不需要的话，可以在这条 ALTER 上设 `materialize_ttl_after_modify = 0`；要生效，就挑窗口执行，必要时先 `SYSTEM STOP MOVES` 防止漂移，TTL 调完再 `SYSTEM START MOVES`。不同版本的细节还是要在测试集群上验一遍。

## BACKUP/RESTORE 上的 ALTER

### BACKUP 是自描述的快照

BACKUP 出来的东西长这样：

```
backup_2026_01.zip / backup_2026_01/
├── metadata/<db>/<table>.sql        # 当时的 CREATE TABLE 完整定义
├── data/<db>/<table>/<part>/        # 每个 part 目录
│   ├── columns.txt                  # part 自己的列清单
│   ├── checksums.txt
│   └── *.bin / *.mrk2
└── .backup                          # 全局描述
```

每个 part 都自带 `columns.txt`，记着这个 part 物理上存了哪些列；整个 backup 也自带 `<table>.sql`，是当时完整的 schema。所以线上表不管怎么 ALTER，都写不到 backup 里去，backup 写完就是只读的冷数据快照。

### 三种恢复方式，schema 兼容性各不一样

第一种是恢复到一张新表，最安全，总能成功：

```sql
RESTORE TABLE default.events AS default.events_restored
  FROM S3('s3://bucket/backup_2026_01/', '...');
```

ClickHouse 用 backup 里那份老 SQL 建出 `events_restored`，表结构就是老 schema，老数据原样恢复，跟现在的线上表长什么样没关系。合规审计、查历史数据，凡是「我只想看老数据」的场景，都走这条，最稳。

第二种是合并进当前的线上表：

```sql
RESTORE TABLE default.events FROM S3(...)
  SETTINGS allow_non_empty_tables = 1;
```

ClickHouse 会拿 backup 的 schema 跟当前表的 schema 比。差别只是线上表多了几个带 DEFAULT 或者 Nullable 的列，可以通过，老 part 靠读时现算；差别是改了类型、删了列、改了 ORDER BY，就会失败。这种方式用得很少，大多数时候走第一种更稳。

第三种是只恢复结构，再挑着 ATTACH PART：

```sql
RESTORE TABLE default.events_restored
  FROM S3(...)
  SETTINGS structure_only = 1;

ALTER TABLE events_restored ATTACH PART '20260101_1_100_2';
```

这是精细活，适合只要某几个分区的情况，思路跟第一种一样，只是粒度更细。

### 哪些 ALTER 真会影响恢复

恢复到新表这条路，线上表做了什么 ALTER 都不影响，ADD COLUMN、MATERIALIZE COLUMN、DROP COLUMN 都一样，backup 自带 schema，跟线上表是两个世界。

合并回原表这条路，改类型、删列、改列名都会让它失败。

有几种情况两条路都会受影响：表改了名，backup 里的表名和线上对不上，可以手工改元数据，但很麻烦；改了引擎；改了 ORDER BY 以后还想恢复回原表。

### 破坏性 ALTER 之前，重做一次 base BACKUP

合规归档的场景下，backup 文件躺在 S3 上不等于恢复得回来，得靠演练去验。

我建议的节奏是：每次做破坏性的 ALTER（改类型、改 ORDER BY、改引擎）之前，先做一次完整的 base BACKUP，打上「post-alter-X」这样的标记，在测试集群上完整地 RESTORE 演练一遍，演练过了才去生产上执行 ALTER，ALTER 做完再做一次 base BACKUP。这样不管什么时候出事，最近的那份 base BACKUP 都跟当前线上表的 schema 是兼容的。

### Glacier 取回还得多等一阵

如果 backup 已经在 Glacier Deep Archive 上了，真正恢复之前还有 12 到 48 小时的 `restore-object` 等待。这段时间正好拿来做演练和准备。老 backup 的 schema 可能早就跟现在的线上表差得很远了，演练的时候一定要确认好走哪种恢复方式。

## S3 Engine 加 Parquet 上的 ALTER

### ClickHouse 只是来查的，数据不归它管

S3 Engine 加 Parquet 最大的不同是，Parquet 文件不属于 ClickHouse。它们是业务通过 `INSERT INTO FUNCTION s3()`，或者 Spark、Flink、自研管道这些外部工具写出来的，ClickHouse 只是个查询前端。

所以 ClickHouse 这边的 ALTER 基本碰不到 S3 上的 Parquet 文件，ClickHouse 本来就不管这些文件。schema 变更真正靠的，是 Parquet 文件自己。

### Parquet 自描述，按列名对应

Parquet 在文件的 footer 里存了完整的 schema：列名、类型、压缩 codec、统计信息。ClickHouse 读的时候，是按列名去对应表定义里的列和 Parquet 文件里的列的。这是整个 Parquet 方案能平滑演进的关键。

```sql
-- ClickHouse 表定义
CREATE TABLE events_archive (
  event_time DateTime,
  user_id UInt64,
  event_type String,
  new_field String DEFAULT ''   -- 新加的
) ENGINE = S3('s3://bucket/events/*.parquet', 'Parquet')
SETTINGS use_hive_partitioning = 1;
```

读老的 Parquet 文件时，`event_time`、`user_id`、`event_type` 在文件里都有，直接读；`new_field` 老文件里没有，就用 DEFAULT 填，NULL 或者空字符串。这跟 ClickHouse 自己的读时现算是一回事，只不过是在文件格式这一层做的。

### 几种 ALTER 在 Parquet 上的表现

ADD COLUMN：在 ClickHouse 的表上加列只改元数据，瞬时完成；老的 Parquet 文件没有这列，读的时候返回 DEFAULT；新写出来的文件有没有这列，看业务的写入逻辑，一般业务管道会同步加上。完全兼容。

改类型：在 ClickHouse 表上改类型只改元数据，Parquet 文件里的列类型没变，读的时候 ClickHouse 会试着把 Parquet 的类型转成表上声明的类型。整数之间扩位，比如 Int32 转 Int64，是安全的；Int 转 Float、String 转 Int 这种会失败或者截断。所以能转的，比如提高精度、加减 Nullable，交给 ClickHouse 自动转；不能转的，就得在写出端把 Parquet 的列类型也改了，或者干脆另起一列。

DROP COLUMN：在 ClickHouse 表上删列只改元数据，老的 Parquet 里还有这一列的数据，只是 ClickHouse 不读了，新写的文件也不再写这列。老文件里这列的数据会一直占着 S3 的空间，这跟 S3 Disk 不一样，Parquet 没有 ClickHouse 那种异步清理。真想把空间腾出来，得业务自己把老文件重写一遍。

RENAME COLUMN：在 ClickHouse 表上改列名只改元数据，可 Parquet 是按列名对应的，改了名以后老文件里这一列就读不到了。要么让写出端同步改名，新文件用新列名，要么在视图层做个映射。

### 和 Hive 分区配合

开了 `use_hive_partitioning=1`，分区列是从路径里解析出来的：

```
s3://bucket/events/dt=2026-04-29/hour=10/file.parquet
                  ^^^^^^^^^^^^^^^ ^^^^^^^^
                       dt=2026-04-29  hour=10
```

要加分区列、改分区方式的时候，老文件的路径不用动，它们的 dt 照样按老路径解析，新文件按新的路径写就行，不需要重写任何文件。分区演进在 Parquet 上也几乎没有代价，这是它结构上的一个优势。

### Parquet 也有搞不定的

也不是所有 ALTER 都这么顺。`String` 改成 `LowCardinality(String)` 这种 ClickHouse 特有的类型，Parquet 表达不了，只能在 ClickHouse 这边声明。嵌套结构的改造，Parquet 虽然支持 Struct、List，但跨版本演进比平铺的列复杂得多。还有业务那边的改造成本，你想让新写出来的文件带上新列，就得去改业务管道，这个工作量是实打实的，只是它发生在 ClickHouse 之外。

## 三种方案放一起比

<figure class="dfig">
<img class="dfig-l" src="/diagrams/alter-02.light.svg" alt="三种方案对 schema 变更的友好度：Parquet 最友好，BACKUP 次之，S3 Disk 最差">
<img class="dfig-d" src="/diagrams/alter-02.dark.svg" alt="三种方案对 schema 变更的友好度：Parquet 最友好，BACKUP 次之，S3 Disk 最差">
</figure>

排下来是 Parquet 最友好，BACKUP 其次，S3 Disk 最差，不过每种方案都是把代价挪到了不同的地方。

Parquet 最友好，是因为数据文件自描述、按列名读，从架构上就把 schema 演进这件事解决了，ClickHouse 只是个读的人，ALTER 用不着去碰数据。Iceberg、Delta Lake、Hudi 这些湖仓格式之所以会出现，正是为了这个。

BACKUP 其次。backup 是冻住的冷数据快照，跟线上表完全分开。代价不是没有，而是挪到了恢复演练上，你得确保关键时刻有一条路能恢复出来。恢复到新表这条路几乎什么情况都能用，但业务那边得能读老 schema。

S3 Disk 最差。数据还是 ClickHouse 自己的 part，schema 变更得走 ClickHouse 自己的 mutation，在 100T 的 S3 上，带宽、限流、ZK、storage policy 漂移，哪一样都可能出问题，代价大还没准。等于是把业务管道改造的复杂度，换成了运维窗口里调度 mutation 的复杂度。

## 实操上怎么做

加列优先用 Nullable 或者常量 DEFAULT，三种方案下都是只改元数据、老数据读时兜底。100T 的表上，永远别一次性跑 MATERIALIZE COLUMN，要跑就按分区拆开。改类型、改 ORDER BY、改引擎这种结构性的 ALTER，按月排期，评估、演练、维护窗口、重做 backup，一步都不能省，不是想改就改的。

DDL 工具也得管起来。很多团队的 DDL 工具是「加列加立即 MATERIALIZE」一起发的，在冷热分层的场景下必须改：加列只发 `ADD COLUMN`，不带 `MATERIALIZE`；业务真要 materialize（很少见），单独审批，按分区分批跑；DDL 工具上再加一条 lint 规则，100T 以上的表不允许 `MODIFY COLUMN type` 和不限定分区的 `MATERIALIZE COLUMN`，真要做得人工审批。

每次破坏性的 ALTER 之前，先在测试集群上建一张同结构的影子表，灌 1% 的抽样数据，热的冷的都要有，把计划中的 ALTER 跑一遍，看 mutation 的进度、S3 的 IO 模式、storage policy 的行为，估一估放到生产 100T 上要花多少，有 backup 的话再确认一下 RESTORE 的兼容性。

三种方案各自要盯的东西也不一样：

| 方案 | 漂移管理重点 |
|---|---|
| S3 Disk | 控制 mutation 频次，记录历次结构性 ALTER 的版本号 |
| BACKUP | 每次破坏性 ALTER 前后做 base BACKUP，定期演练恢复 |
| Parquet | 业务管道双写期管理，老文件的 schema 元数据归档 |

还有几个零碎的点。加列前后查一下 `SELECT * FROM system.mutations WHERE NOT is_done`，确认没有正在跑的 mutation。改类型用前面那个加新列、双写、按分区 materialize、删老列的办法，别直接改。别定期对冷数据跑 `OPTIMIZE TABLE ... FINAL DEDUPLICATE`，它会把整张表重新 merge 一遍，冷盘上就是全量的 GET 和 PUT。ZK 上 mutations 节点的数量，交给 `finished_mutations_to_keep` 这类表设置去控制，别手工去删 ZK 节点。ALTER 到底是不是真在改数据，`system.mutations` 是唯一靠得住的地方，碰上 ALTER 卡住，先查这张表。

## 最后

schema 变更有多难，取决于老数据放在哪儿。

S3 Disk 把数据留在 ClickHouse 手里，改 schema 就得走 ClickHouse 的 mutation，数据量一大，代价又高又没准。BACKUP 把冷数据冻成自描述的快照，改 schema 跟线上表完全没关系，代价挪到了演练上。Parquet 把数据放在开放格式里，schema 演进是文件格式自带的本事，代价挪到了业务管道的改造上。

冷热分层的成本不只在写入和查询上，三年以后要加一列的时候才最看得出来。选方案之前就该把这件事算进去，100T 数据落了地再想换，代价要大得多。
