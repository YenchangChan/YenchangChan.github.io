---
title: ClickHouse 字典：省掉的 JOIN，多付的内存
---

# ClickHouse 字典：省掉的 JOIN，多付的内存

在 ClickHouse 里反复 JOIN 小维表的，迟早会有人跟你说：用字典啊，比 JOIN 快多了。这话没错。可字典刷新的时候内存会冲到稳态的两倍多，到了一定规模它就装不下了，这些很少有人一起说。这篇从字典是什么讲起，一直讲到 LAYOUT 怎么选、刷新和删除怎么处理、分布式下怎么省内存，最后是监控和排障。

篇幅很长，建议按右边的目录挑着看。

## 字典是什么

说白了，字典就是一份由 ClickHouse 自己管理、常驻内存的 k-v 查找表，给一个 key，毫秒级甚至微秒级就能拿到对应的一行或者几列。你可以把它想成编程语言里的 `HashMap<Key, Value>`，只不过 value 可以有好几列；也可以想成 Redis 的 Hash，只不过加载和刷新都是 ClickHouse 自己做；或者就是关系库里的维表，只是不用每次 JOIN 都去磁盘上扫一遍。

为什么需要它？假设有一张事实表 `events`，几十亿行，一张维表 `users`，几百万行。传统的 JOIN 每次都要把右表读出来、建一遍 hash 表，哪怕维表根本没变过。换成字典是这样：

```sql
SELECT
    dictGet('users_dict', 'city', user_id) AS city,
    count()
FROM events
WHERE action = 'click'
GROUP BY city;
```

`users_dict` 一次加载、常驻内存，所有查询共享，`dictGet` 就是一次 O(1) 的哈希查找。维表有更新，ClickHouse 按 `LIFETIME` 自己去刷。字典最核心的价值就在这：把反复 JOIN 小维表，变成一次加载、全局共享、O(1) 查找。

## 定义一个字典要回答三个问题

数据从哪里来，是 `SOURCE`，可以是 MySQL、PostgreSQL、ClickHouse 表、HTTP、文件等等；在内存里怎么存，是 `LAYOUT`，哈希表、扁平数组、LRU 缓存、区间结构都有；多久刷新一次，是 `LIFETIME`。再加上 schema，也就是 `PRIMARY KEY` 和属性列，一个字典就齐了。

一个最小的例子：

```sql
-- 源表
CREATE TABLE users_source
(
    user_id   UInt64,
    user_name String,
    city      String,
    vip_level UInt8
)
ENGINE = MergeTree ORDER BY user_id;

-- 字典
CREATE DICTIONARY users_dict
(
    user_id   UInt64,
    user_name String,
    city      String,
    vip_level UInt8
)
PRIMARY KEY user_id
SOURCE(CLICKHOUSE(TABLE 'users_source'))
LAYOUT(HASHED())
LIFETIME(MIN 300 MAX 600);
```

查的时候有两种方式：

```sql
-- A. dictGet 函数（高频生产用法）
SELECT dictGet('users_dict', 'city', toUInt64(1001));
SELECT dictGet('users_dict', ('city', 'vip_level'), toUInt64(1001));

-- B. 字典当表 SELECT(调试用)
SELECT * FROM users_dict WHERE user_id = 1001;
```

`dictGet` 的 key 类型是严格匹配的，经常得写个 `toUInt64(...)` 显式转一下，这个坑很容易踩。

`dictGet` 是一族函数：

| 函数 | 用途 |
|---|---|
| `dictGet` | key 不存在时返回类型默认值（`''`/`0`）|
| `dictGetOrDefault` | key 不存在时返回指定默认值 |
| `dictGetOrNull` | key 不存在时返回 NULL |
| `dictHas` | 判断 key 是否存在 |
| `dictGetHierarchy` | 用于层级字典（取祖先链路）|

## 多大的维表适合做字典

判断适不适合，光看行数不够。行数决定加载要多久；每行多宽，尤其是有几个字符串列，决定内存；多久变一次，决定刷新的成本。

按 LAYOUT 大致的容量参考：

| LAYOUT | 推荐量级 | 说明 |
|---|---|---|
| `flat` | ≤ 几十万，极限 500 万 | 数组大小由最大 key 值决定 |
| `hashed` | 几百万到几千万 | 通用首选 |
| `sparse_hashed` | 千万到亿级 | 省 30% 左右内存 |
| `complex_key_hashed` | 同 hashed，略高 | 复合 key |
| `cache` / `ssd_cache` | 上亿到几十亿 | 必须有热点分布 |
| `direct` | 任意 | 每次直查源，极小众 |

按维表规模的经验做法：

| 维表规模 | 推荐方案 |
|---|---|
| < 10 万行 | `flat` / `hashed`，内存忽略 |
| 10 万 ~ 1000 万 | `hashed` / `sparse_hashed` |
| 1000 万 ~ 1 亿 | `sparse_hashed`，算好预算 |
| 1 亿 ~ 10 亿 | `cache` / `ssd_cache`，要有热点 |
| > 10 亿且无热点 | 不要用字典，改用 JOIN 或表设计 |

碰到下面任何一条，就该停下来重新掂量掂量了：单个字典的内存超过节点物理内存的 10~20%（经验上单字典别超过 8~16 GB）；加载时间超过 LIFETIME 的一半；源库扛不住全量拉取；维表的更新频率到了秒级。

经验上，几十万到几千万行、单个字典内存控制在 4~8 GB 以内，用起来最舒服。

## 字典怎么刷新

### LIFETIME

```sql
LIFETIME(300)                    -- 固定 300 秒
LIFETIME(MIN 300 MAX 600)        -- 300~600 随机
LIFETIME(0)                      -- 永不自动刷新
```

`MIN/MAX` 是干嘛的？看代码，每次刷新完，ClickHouse 在 `[MIN, MAX]` 之间均匀随机挑一个时间作为下一次刷新的时刻（`ExternalLoader::calculateNextUpdateTime`）。它打散的是字典和字典之间的刷新时间，集群里每个节点也各自随机，所以节点之间也错开了，免得所有节点同一时刻一起去打源库。它不是在打散 key，`cache` 是个例外，后面说。我一般建议 `MAX` 取 `MIN` 的 1.2~1.5 倍。刷新出错时，下一次的时间会改走退避逻辑，不再按这个区间算。

### 双缓冲

刷新的过程是这样的：后台线程从 SOURCE 全量（或者增量）拉数据，在内存里另建一个新版本 V2，建好以后原子地切换指针，`dictGet` 立刻指向 V2，再把旧的 V1 释放掉。

所以刷新的时候 `dictGet` 不会阻塞，也不会读到半成品；刷新失败了，旧版本接着服务，数据不会丢，只是在日志里记个错。代价是这段时间里内存瞬间翻倍，下一节专门讲。

### 增量更新

字典大了，增量更新基本是必备的：

```sql
SOURCE(MYSQL(
    ...
    update_field 'updated_at'    -- 增量字段
    update_lag 30                -- 回拉秒数，防时钟漂移漏更新
))
```

实际下发给源库的 SQL 大致是：

```sql
SELECT * FROM users WHERE updated_at >= (T_last - update_lag);
```

增量有两个大坑。一是拿不到删除，源里删掉的行没有更新事件，字典里就一直留着，解法是软删除加定期全量。二是第一次加载还是全量，`update_field` 只管后面的刷新。

### 手动控制

```sql
SYSTEM RELOAD DICTIONARY users_dict;     -- 同步全量刷新
SYSTEM RELOAD DICTIONARIES;              -- 慎用，触发所有
```

### 先记住这张表

```sql
SELECT
    name,
    status,                        -- LOADED / LOADING / FAILED / NOT_LOADED
    element_count,
    bytes_allocated,
    last_successful_update_time,
    loading_duration,
    last_exception
FROM system.dictionaries
WHERE name = 'users_dict';
```

## 内存尖刺

双缓冲意味着刷新时 V1 和 V2 同时在内存里，理论上是两倍，实际一般是 2.2~2.5 倍。多出来的部分有好几个来源：构建过程中流式拉取的临时 Block 缓冲；哈希表 rehash 那一瞬间的翻倍；String 列分配内存带来的碎片，大概 10~20%；还有多个字典同时刷新叠在一起，这个就得靠 `MIN/MAX` 去错开。

拿一个千万级的字典估一下：

```
1000 万行，key 8 字节 + 3 String 列 60 字节 + 数值 8 字节
单行 ≈ 130 字节（含 hash 开销）
稳态 ≈ 1.3 GB
刷新尖刺峰值 ≈ 3 GB，持续 30 秒 ~ 几分钟
```

怎么压这个尖刺？成本最低的是错峰，写 `LIFETIME(MIN 300 MAX 600)`，别写 `LIFETIME(300)`。换 `sparse_hashed`，稳态省三成左右，尖刺的绝对值也跟着降。上增量更新，尖刺的幅度不变，但持续时间很短，撞上 OOM 的概率小很多。换成 `cache` 就没有全量重建了，也就没有尖刺，代价是要回源。实在不行，就老老实实给字典预留三倍的内存。

监控上，稳态看 `system.dictionaries`，真实的尖刺看节点 RSS：

```sql
-- 稳态
SELECT name, formatReadableSize(bytes_allocated) FROM system.dictionaries;

-- 节点 RSS(看真实尖刺)
SELECT metric, formatReadableSize(value)
FROM system.asynchronous_metrics
WHERE metric IN ('MemoryResident', 'MemoryTracking', 'jemalloc.resident');
```

把 `MemoryResident` 的曲线画出来，字典刷新的时刻会是一个个很清楚的锯齿。

## LIFETIME 在不同 LAYOUT 下不是一个意思

很多人以为 `LIFETIME(MIN/MAX)` 是给每个 key 打散过期时间的，其实不是。

| LAYOUT | LIFETIME 控制的是 | 是否打散 key | 会不会一直刷新 | 会不会某些 key 长期不刷 |
|---|---|---|---|---|
| `flat` / `hashed` / `sparse_hashed` / `complex_key_hashed` / `range_hashed` | 整个字典下次刷新的时刻（每轮重新随机） | 否 | 否，有明确间隔 | 否，全量替换，所有 key 同步 |
| `cache` / `ssd_cache` | 每个 cell 独立的过期时间 | 是 | 否，只在 miss 时回源 | 冷门 key 可能长期不刷（但没人查也不算陈旧）|
| `direct` | 无意义 | — | — | — |
| `LIFETIME(0)` | 永不自动刷新 | — | 永远不刷 | 所有 key 永远不刷 |

对 `hashed` 这一家子，整个字典是一个刷新单位，每轮刷完才决定下一轮的时间，有 MIN 兜底，不会一直刷。

对 `cache` 这一家子，LIFETIME 管的是每个 cell，数据进 cell 以后超过 lifetime 就算过期，下次有人查再回源。冷门 key 可能在缓存里挂很久，但只有被查到的时候才会更新。源里查不到的 key 也会被记成一个默认 cell 缓存起来，免得反复回源。

## 字典会不会自己过期

说字典会不会过期，其实可能是三个问题。

第一个，单个 key 会不会自动过期。只有 `cache` 和 `ssd_cache` 会，按 lifetime 加上缓存淘汰；`hashed` 一家是整体快照，没有单 key 过期；`direct` 本来就不缓存。

第二个，整个字典长时间没人用，会不会自己卸载。默认不会。字典加载以后就常驻内存，直到 `DROP DICTIONARY` 或者 `DETACH DICTIONARY`，或者进程重启。新一些的版本还有 `SYSTEM UNLOAD DICTIONARY` 可以手动卸载。懒加载（`dictionaries_lazy_load`）只管第一次什么时候加载，管不了加载以后什么时候释放。

第三个，数据旧了会不会自动刷新，那就是前面的 `LIFETIME` 加 `invalidate_query`，严格说这叫刷新，不叫过期。

所以别为了以防万一建一大堆字典，每个都吃内存，又不会自己释放；用不上的字典主动 `DROP` 掉。

## 全量刷新和删除

先分清全量和增量：

| 刷新类型 | 下发 SQL | 删除能否被感知 |
|---|---|---|
| 全量 | `SELECT * FROM users` | 能，源里没了就没了 |
| 增量 | `SELECT * FROM users WHERE updated_at >= ...` | 不能，删除没有更新事件 |

没配 `update_field`，永远是全量；配了，第一次全量，后面增量；`SYSTEM RELOAD DICTIONARY` 永远是全量。

全量刷新怎么把删除清掉的？双缓冲切换时，V2 是源表最新的快照，V1 里有、V2 里没有的 key，随着 V1 释放就自然没了。

所以生产上我推荐增量加定期全量：

```sql
SOURCE(MYSQL(
    NAME 'mysql_prod'
    table 'users'
    update_field 'updated_at'
    update_lag 30
))
LAYOUT(SPARSE_HASHED())
LIFETIME(MIN 300 MAX 360);
```

再配一个 crontab，每天凌晨低峰执行一次 `SYSTEM RELOAD DICTIONARY users_dict;`。增量管性能，全量管正确。

别的能感知删除的办法也有：

| 方案 | 删除感知延迟 | 复杂度 | 备注 |
|---|---|---|---|
| 纯全量 | 平均 LIFETIME/2 | 低 | 频繁尖刺 |
| 增量 + 每日全量 | 最长 24h | 低 | 推荐 |
| 增量 + 源表软删除 | 几分钟 | 中（改业务）| 字典中过滤 is_deleted |
| 增量 + `invalidate_query` | 看检测查询 | 中 | 行数变化触发全量 |
| Binlog CDC → CH 表 | 秒级 | 高 | 引入 CDC 组件 |
| `cache` + 短 TTL | 平均 TTL/2 | 低 | 自然反映 |

## SOURCE 选哪个

数据库类的：

| SOURCE | 适用 | 注意 |
|---|---|---|
| `CLICKHOUSE` | 同/异集群 CH 表 | 性能最好，本地表可省 host/port |
| `MYSQL` | 业务维表 | N 节点 = N 倍并发到 MySQL，DATETIME 时区坑 |
| `POSTGRESQL` | PG 维表 | 类型映射比 MySQL 干净 |
| `MONGODB` | Mongo 文档 | 类型映射弱，生产少用 |
| `REDIS` | 配合 cache 用 | 只支持 simple / hash_map，schema 受限 |
| `ODBC` | SQL Server / Oracle 等 | 需要 `clickhouse-odbc-bridge` |

文件类的：

| SOURCE | 适用 | 注意 |
|---|---|---|
| `FILE` | 静态码表 | 每个节点都要有文件，推荐打进镜像 |
| `HDFS` / `S3` | T+1 数仓产出 | Parquet 比 CSV 快很多 |

HTTP 的写法是 `SOURCE(HTTP(url '...' format 'CSV'))`，适合配置中心、算法平台这类。接口必须幂等、每次返回全量，数据量到了千万级就别走 HTTP 了，改放 S3。

还有 `EXECUTABLE` 和 `EXECUTABLE_POOL`，复杂度高，安全风险也大，绝大多数团队都不该用，真需要自定义逻辑，部署一个 HTTP 服务更规矩。

几个通用的 SOURCE 参数：`update_field` 开增量，`update_lag` 是增量回拉的秒数，`invalidate_query` 用来感知源有没有变，`where` 过滤部分行，`query` 可以自定义 SELECT，能 JOIN 多张源表，但代价大。

怎么选：

| 场景 | 推荐 |
|---|---|
| MySQL/PG 业务维表 | `MYSQL` / `POSTGRESQL` |
| 维表已落 CH | `CLICKHOUSE`（性能最好）|
| SQL Server / Oracle | `ODBC` |
| 静态码表 | `FILE` 或代码 hardcode |
| T+1 数仓 | `S3` / `HDFS`（Parquet）|
| 配置中心 | `HTTP` |
| 自定义脚本 | 部署 HTTP 服务，不要用 `EXECUTABLE` |

## 启动时什么时候加载

默认是懒加载：

```xml
<dictionaries_lazy_load>true</dictionaries_lazy_load>
```

server 启动时只解析定义，字典第一次被用到时才同步加载。配合 `wait_dictionaries_load_at_startup`（默认 true），一共三种策略：

| 策略 | `lazy_load` | `wait_dictionaries_load_at_startup` | 启动行为 |
|---|---|---|---|
| 完全懒加载（默认）| true | — | 启动极快，首次查询阻塞 |
| 启动时同步预加载 | false | true | 启动阻塞至全部加载完 |
| 启动时异步加载 | false | false | 启动不阻塞，后台并发加载 |

懒加载的成本是藏起来的。千万级的字典，第一次查询可能卡几十秒到几分钟，P99 一下就上去了；高并发的服务一重启，好几个查询同时卡在同一个字典的加载上。

所以我推荐懒加载，再加一个启动后的预热：

```bash
# 健康检查通过后预热关键字典
clickhouse-client -q "SYSTEM RELOAD DICTIONARY users_dict" &
clickhouse-client -q "SYSTEM RELOAD DICTIONARY products_dict" &
wait

# 引流前确认状态
clickhouse-client -q "
    SELECT name FROM system.dictionaries
    WHERE name IN ('users_dict','products_dict') AND status != 'LOADED'
"
# 应该返回空
```

启动后看状态：

```sql
SELECT name, status, formatReadableSize(bytes_allocated) AS mem,
       loading_duration, last_exception
FROM system.dictionaries
ORDER BY status != 'LOADED' DESC, loading_duration DESC;
```

## XML 还是 DDL

XML 的写法：

```xml
<dictionaries>
    <dictionary>
        <name>users_dict</name>
        <source><mysql>...</mysql></source>
        <layout><hashed/></layout>
        <structure>
            <id><name>user_id</name></id>
            <attribute><name>city</name><type>String</type><null_value/></attribute>
        </structure>
        <lifetime><min>300</min><max>600</max></lifetime>
    </dictionary>
</dictionaries>
```

XML 天然是热更新的，后台线程大约每 5 秒检查一次配置文件（`ExternalLoader` 里写死的 `check_period_sec = 5`），改了推上去几秒就生效，不用重启，也不用执行 SQL。推的时候先写临时文件再 `mv` 过去，免得读到写了一半的文件。文件语法写错了会被忽略，旧定义接着用，错误在日志里。

DDL 的写法是 `CREATE OR REPLACE DICTIONARY users_dict ( ... ) ... ;`，执行就生效。没有 `ALTER DICTIONARY`，改只能整体替换。

| 维度 | XML | SQL DDL |
|---|---|---|
| 热更新机制 | 文件扫描，约 5 秒 | 执行 SQL 立即 |
| 集群同步 | 每节点都要有文件 | Replicated DB 自动同步 |
| 版本控制 | XML 进 Git | 管理 migration SQL |
| 权限控制 | 无 | 标准 SQL 权限 |
| 归属数据库 | 无 | 按 db 隔离 |
| 审计 | 文件系统日志 | query log |

我一般建议用 DDL，不用改配置文件，权限、审计、集群同步都更完善，字典还能像表一样用 SELECT 去查，重命名也方便。运维侧自己管的、偏基础设施的字典，用 XML 也没问题，XML 是长期支持的，不用担心哪天被废弃。

## Named Collection

Named Collection 经常和字典放在一起说，可它不是字典，它是一个给连接配置起名字、方便复用的容器，有点像 AWS 的 named profile，或者 K8s 的 Secret 加 ConfigMap。里面存的是 host、port、user、password、bucket、url 这些连接信息。

它解决的是密码到处硬编码的问题：

```sql
-- 没有 NC 时，密码到处硬编码
CREATE DICTIONARY users_dict ...
SOURCE(MYSQL(host '...' port 3306 user '...' password 'SuperSecret!' ...));

-- 有了 NC，密码集中存储
CREATE NAMED COLLECTION mysql_prod AS
    host = 'mysql.prod.internal', port = 3306,
    user = 'ch_reader', password = 'SuperSecret!', db = 'app';

CREATE DICTIONARY users_dict ...
SOURCE(MYSQL(NAME 'mysql_prod' table 'users'));
```

用得上它的地方很多：

| 场景 | 例子 |
|---|---|
| 字典 SOURCE | `SOURCE(MYSQL(NAME 'mysql_prod' table 'users'))` |
| 表函数 | `mysql(mysql_prod, table = 'logs')` |
| 表引擎 | `ENGINE = MySQL(mysql_prod, ...)` |
| 远程 CH | `remote(ch_cluster, ...)` |
| S3 / HDFS | `s3(s3_backup, ...)` |
| BACKUP | `BACKUP ... TO S3(s3_backup, ...)` |
| Kafka | `ENGINE = Kafka(kafka_prod, ...)` |

和字典对比一下：

| 维度 | Named Collection | Dictionary |
|---|---|---|
| 本质 | 配置参数集合 | 内存查找表 |
| 存什么 | 连接信息 | 数据行 |
| 占内存 | 几乎不占 | GB 级 |
| 引用方式 | 名字嵌入 SQL | `dictGet(...)` |
| 周期刷新 | 不刷新（改配置才变） | 按 LIFETIME 刷新 |
| 解决问题 | 配置复用 + 凭证脱敏 | 维表 JOIN 性能 |

简单说，Named Collection 告诉 ClickHouse 怎么连到源，字典告诉它把源里的数据拉进来以后怎么用。

拿它来管地址是正合适的，但别存业务上的地址数据（比如用户收货地址），别拿它做动态服务发现（配置是静态的），也别拿它替代密钥管理系统，写在配置文件里的密码仍然是明文。它的好处在于改密码只改一处；dev、staging、prod 用同名的 NC，SQL 可以一字不改；`query_log` 里看到的是 `NAME 'xxx'` 而不是密码；权限可以用 `GRANT NAMED COLLECTION` 收住。

## 分布式下的分片字典

字典是每个节点本地的资源。10 个分片，每个节点一份 10GB 的字典，集群就是 100GB。可事实表要是按 `cityHash64(user_id)` 分了片，每个分片其实只用得到 1/N 的字典数据。

ClickHouse 没有原生的分片字典语法，但可以在 source 上做文章。

推荐的做法是用本地表做 source：

```sql
-- 1. 本地维表（每个分片只有自己那 1/N）
CREATE TABLE users_local ON CLUSTER my_cluster
( user_id UInt64, user_name String, city String, updated_at DateTime )
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/users', '{replica}')
ORDER BY user_id;

-- 2. Distributed 写入，sharding key 必须和事实表一致
CREATE TABLE users_distributed ON CLUSTER my_cluster AS users_local
ENGINE = Distributed(my_cluster, default, users_local, cityHash64(user_id));

-- 3. 字典 SOURCE 指本地表
CREATE DICTIONARY users_dict ON CLUSTER my_cluster ( ... )
PRIMARY KEY user_id
SOURCE(CLICKHOUSE(host 'localhost' TABLE 'users_local' update_field 'updated_at'))
LAYOUT(SPARSE_HASHED())
LIFETIME(MIN 300 MAX 360);
```

这样每个节点的字典只有 1/N 的数据，整个集群的内存从 N 份降到 1 份。前提是事实表的 sharding key、维表的 sharding key、字典的 key，三者必须一致。

另一种做法是在 source 里用过滤查询配合 macros：

```sql
SOURCE(MYSQL(
    NAME 'mysql_prod'
    query 'SELECT ... FROM users WHERE cityHash64(user_id) % 10 = {shard}'
))
```

每个分片下发不同的 SQL。问题是两边的 hash 函数得字面一致，MySQL 里没有原生的 `cityHash64`；分片数是写死的，一扩容所有定义都得改；`cityHash64(user_id)` 在 MySQL 那边也走不了索引，每次都是全表扫。生产上前一种做法安全得多。

分片字典真正要命的是静默默认值。`dictGet` 查到了不属于本分片的 key，它不报错，直接返回类型默认值，业务那边就是悄悄地算错了。所以 `dictGet` 的 key 必须严格来自 sharding key，测试的时候用 `dictHas` 校验一下。还有几个小问题：事实表里的 `cityHash64(user_id)` 和维表 Distributed 引擎里的表达式要一字不差；同一个分片的两个副本，字典各刷各的，可能有几分钟的版本差，对副本一致性敏感的业务要心里有数；调试的时候 `SELECT * FROM users_dict` 看到的只是本分片那一片。

至于扩容以后要重新均衡数据，那不是分片字典特有的问题，所有按分片组织的数据都一样，这个应该在集群规划层面去解决。

什么时候值得做？集群至少 4 个分片，维表至少一千万行，事实表的 sharding key 正好就是 `dictGet` 的 key，集群拓扑也稳定。反过来，维表的查询 key 五花八门、没有统一的 sharding key，或者维表就几十万行、全量复制也不贵，或者业务上没法严格保证 `dictGet` 的 key 来自哪里，就别折腾了。

有个折中，用 Distributed 表做 source：

```sql
SOURCE(CLICKHOUSE(TABLE 'users_distributed'))
```

等于没优化，每个分片照样拉全量，但不会有静默错误，适合维表小、又怕出错的场景。

## dictGet 的进阶用法

### 多属性用 Tuple

```
dictGet(dict_name, attr_name_or_tuple, key_or_tuple [, default])
```

一次取多个属性，一定要用 Tuple：

```sql
-- 5 次哈希查找
SELECT dictGet(d,'a',k), dictGet(d,'b',k), dictGet(d,'c',k), ...

-- 1 次哈希查找
SELECT dictGet(d, ('a','b','c','d','e'), k)
```

宽字典的查询，能省掉大部分字典访问的开销。

### 默认值的三种语义

```sql
dictGet('users_dict', 'city', toUInt64(99999))                       -- 类型默认值 ''
dictGetOrDefault('users_dict', 'city', toUInt64(99999), 'Unknown')   -- 显式兜底
dictGetOrNull('users_dict', 'city', toUInt64(99999))                 -- 返回 NULL
```

分片字典的场景用 `dictGetOrDefault`，把不在本分片这件事显式地暴露出来；下游需要用 `coalesce` 判断的，用 `dictGetOrNull`。

`dictGetString`、`dictGetUInt64` 这些是老写法，新版本通用的 `dictGet` 已经能自己推导类型了，`dictGetStringOrDefault` 这种带 OrDefault 后缀的还挺常用。

### 辅助函数

| 函数 | 用途 |
|---|---|
| `dictHas(dict, key)` | 判断 key 是否存在 |
| `dictGetChildren(dict, key)` | 层级：直接子节点 |
| `dictGetDescendants(dict, key)` | 层级：所有后代 |
| `dictGetHierarchy(dict, key)` | 层级：祖先链（自己到根）|
| `dictIsIn(dict, child, ancestor)` | 层级：是否在子树下 |

`dictHas` 常见的用法：

```sql
-- 验证分片字典 key 覆盖
SELECT count() FROM events WHERE NOT dictHas('users_dict', user_id);

-- 软 JOIN(过滤掉维表里没有的事实表行)
SELECT * FROM events WHERE dictHas('users_dict', user_id);

-- 避免默认值污染聚合
SELECT dictGet('users_dict', 'city', user_id) AS city, count()
FROM events WHERE dictHas('users_dict', user_id)
GROUP BY city;
```

### 层级字典

`HIERARCHICAL` 把某一列声明成父指针：

```sql
CREATE DICTIONARY dept_dict
(
    id        UInt64,
    parent_id UInt64 HIERARCHICAL,
    name      String
)
PRIMARY KEY id
SOURCE(CLICKHOUSE(TABLE 'departments_src'))
LAYOUT(HASHED())
LIFETIME(MIN 300 MAX 600);
```

最典型的是按任意层级聚合：

```sql
SELECT sum(sales) FROM employees
WHERE dictIsIn('dept_dict', dept_id, toUInt64(2));   -- 整个 R&D 体系
```

比递归 CTE 或者把祖先列表打平，要快一到两个数量级。

### 区间字典

```sql
CREATE DICTIONARY price_dict
( product_id UInt64, start_date Date, end_date Date, price Decimal(10,2) )
PRIMARY KEY product_id
SOURCE(...)
LAYOUT(RANGE_HASHED())
RANGE(MIN start_date MAX end_date)
LIFETIME(MIN 600 MAX 900);

-- 给 (product_id, date)，自动定位有效区间
SELECT dictGet('price_dict', 'price', toUInt64(1001), toDate('2026-06-15'));
```

用来替代按 `start_date <= date < end_date` 去 JOIN 的那种复杂自连接。区间两端类型要一致，是闭区间 `[start, end]`；区间有重叠时，命中哪一个由 `range_lookup_strategy` 决定，后面 LAYOUT 那节说。

### IP 字典

```sql
LAYOUT(IP_TRIE())
PRIMARY KEY prefix

-- IPv4 查询
SELECT dictGet('ip_dict', 'country', tuple(IPv4StringToNum('1.2.3.4')));
```

自动做最长前缀匹配，百万级的 CIDR 查起来也很快。

### 把字典当表用

```sql
-- A. 直接 SELECT(调试)
SELECT * FROM users_dict WHERE user_id = 1001;

-- B. 显式建 Dictionary 引擎表（老 SQL 兼容）
CREATE TABLE users_dict_table ( ... ) ENGINE = Dictionary('users_dict');

-- C. 子查询过滤
SELECT * FROM events
WHERE user_id IN (SELECT user_id FROM users_dict WHERE vip_level > 2);
```

这几种适合调试和过渡，生产上高频用的还是 `dictGet`。

### 字典和 JOIN 怎么取舍

| 场景 | 选择 |
|---|---|
| `dictGet` 取少量属性 + GROUP BY | 字典完胜 JOIN |
| `dictGet` 做过滤 | 字典完胜 |
| 取维表多列做投影 | Tuple 形式 `dictGet` |
| 多对多关系 | JOIN（字典做不到） |
| ANTI / OUTER JOIN 语义 | JOIN 更直观 |
| 维表大于事实表 | JOIN（字典装不下）|

### 几个性能上的坑

别在 JOIN ON 里调 `dictGet`，每一行算一次，哈希 JOIN 也用不上了：

```sql
-- 反例：每行算一次，关闭哈希 JOIN
... JOIN other ON dictGet('xxx', 'col', id) = other.col

-- 正确：先 dictGet 出列再 JOIN
SELECT ... FROM (
    SELECT *, dictGet('xxx','col',id) AS col FROM events
) e JOIN other USING col;
```

能放到 GROUP BY 之后再调字典函数的，就放到后面，先聚合把行数降下来，再去查字典，调用次数会少很多。同一行要取多个属性，用 Tuple，前面说过了。key 类型要严格匹配，养成写 `toUInt64(id)` 的习惯。分布式查询里 `dictGet` 是在每个分片本地执行的，分片字典能成立靠的就是这一点。`dictGet` 本身是向量化批处理的，一次给一万个 key 就返回一万个 value，`cache` miss 的时候也是批量打包回源。

### 嵌套调用和数组属性

```sql
-- 嵌套（每层独立哈希查找，能合表就合）
SELECT dictGet('region_dict', 'region',
               dictGet('users_dict', 'city', user_id));

-- 数组属性
CREATE DICTIONARY user_tags_dict
( user_id UInt64, tags Array(String) )
PRIMARY KEY user_id
SOURCE(...)
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(MIN 300 MAX 600);

SELECT count() FROM events
WHERE has(dictGet('user_tags_dict', 'tags', user_id), 'vip');
```

## LAYOUT 怎么选

LAYOUT 说白了，就是字典在内存里的存储方式。它决定了数据结构、查找复杂度、内存占用、怎么刷新、要不要回源，以及支持什么类型的 key。

### flat

扁平数组，key 直接当下标，`arr[key]` 一次内存访问，是所有 LAYOUT 里最快的。

致命的约束是数组大小由最大的 key 值决定，跟行数无关。key 是 `[1, 2, 3, 99999999]`，数组就得开一亿长，里面全是空洞。key 超过上限会直接报错，默认 `MAX_ARRAY_SIZE` 是 500000，可以调：

```sql
LAYOUT(FLAT(INITIAL_ARRAY_SIZE 50000 MAX_ARRAY_SIZE 5000000))
```

适合小整数枚举，比如国家代码、错误码，几千到几万条；key 是 `UInt64`、很稀疏或者超过一百万行的，就别用了。

### hashed

开放寻址的哈希表，通用首选，几乎所有维表场景都可以先从它开始，几十万到几千万行都行。内存大约是 `(key + attrs) × 1.5 ~ 2.0`，多出来的是哈希表本身的开销。

```sql
LAYOUT(HASHED(
    SHARDS 8                       -- 内部分片并行加载
    SHARD_LOAD_QUEUE_BACKLOG 10000
    MAX_LOAD_FACTOR 0.5            -- 取值 [0.5, 0.99]，默认 0.5
))
```

`SHARDS` 默认是 1，开大了可以并行加载，大字典的加载时间能从几分钟降到几十秒，千万级以上建议开。`MAX_LOAD_FACTOR` 调大更省内存，但查找会变慢。老版本里还有个 `PREALLOCATE` 参数，现在的文档已经不提了，别再往上写。

### sparse_hashed

稀疏哈希表，用 CPU 换内存。经验上比 `hashed` 省三到四成内存，查找和加载慢一些，实际业务里基本感觉不到，刷新尖刺的绝对值也跟着降。它更慢，所以开 `SHARDS` 的收益比 `hashed` 更大。我的建议是字典到了五百万行以上，直接用 `sparse_hashed`。

### complex_key_hashed

复合 key 用的，key 会被序列化成字节串：

```sql
PRIMARY KEY user_id, product_id
LAYOUT(COMPLEX_KEY_HASHED())

SELECT dictGet('d', 'score', tuple(toUInt64(1001), toUInt64(2002)));
```

比单 key 慢一些，内存也要多存序列化的字节串。对应的稀疏版本是 `COMPLEX_KEY_SPARSE_HASHED`。

另外还有 `hashed_array` 和 `complex_key_hashed_array`：每个属性单独存在一个数组里，key 放在哈希表里，value 是属性数组的下标，属性多的时候比较省内存。

### range_hashed

哈希表，每个 key 下挂一串排好序的区间，查的时候二分：

```sql
LAYOUT(RANGE_HASHED(
    range_lookup_strategy 'max'                 -- 多区间命中策略
    convert_null_range_bound_to_open 1          -- NULL 端点 = 无穷
))
RANGE(MIN start_date MAX end_date)
```

`range_lookup_strategy` 默认是 `min`，多个区间同时命中时取 start 最小的那个；设成 `max` 取 start 最大的，也就是取最新生效的版本。复合 key 的版本是 `COMPLEX_KEY_RANGE_HASHED`。

### ip_trie

IP CIDR 专用的前缀树，自动最长前缀匹配，查找复杂度只跟 IP 位数有关，跟数据量无关，GeoIP 场景就选它。

```sql
LAYOUT(IP_TRIE())
PRIMARY KEY prefix
```

为什么不用 `range_hashed`？IP 段没有天然的分组 key，CIDR 又是最长前缀匹配，语义上就不一样。

### polygon

给一个经纬度，查它落在哪个预先定义好的多边形里：

```sql
LAYOUT(POLYGON(STORE_POLYGON_KEY_COLUMN 1))

SELECT dictGet('districts', 'name', tuple(116.40, 39.90));
```

用来替代 ST_Contains 那种 JOIN，快好几个数量级。

### cache

固定容量的缓存，按 cell 存，每个 cell 有自己的过期时间：

```sql
LAYOUT(CACHE(
    SIZE_IN_CELLS 1000000                   -- 缓存容量（cell 数），会向上取整到 2 的幂
    MAX_THREADS_FOR_UPDATES 4               -- 回源并发上限
    ALLOW_READ_EXPIRED_KEYS 1               -- 过期 key 异步刷新而非阻塞
))
LIFETIME(MIN 300 MAX 600)                   -- 单 key TTL
```

命中是微秒级的，miss 就是毫秒到几十毫秒，取决于源库。命中率就是 `cache` 的命。

最怕的是回源风暴：一千个 key 同时 miss，一千个并发 SELECT 打到 MySQL 上，源库直接挂。应对办法是用 `MAX_THREADS_FOR_UPDATES` 限住回源并发；开 `ALLOW_READ_EXPIRED_KEYS 1`，过期了先返回旧值，后台异步去刷；业务侧对查询限流；源库前面再挡一层 ProxySQL 之类的限流。

说实话，`cache` 我是不太愿意推荐的，性能受命中率影响太大，参数也不好调。只有维表大到别的 layout 装不下、访问又有明显热点的时候，才值得用它。

### ssd_cache

内存加 SSD 两层：

```sql
LAYOUT(SSD_CACHE(
    BLOCK_SIZE 4096
    FILE_SIZE 16777216
    READ_BUFFER_SIZE 1048576
    PATH '/var/lib/clickhouse/user_files/test_dict'
))
```

`BLOCK_SIZE` 建议和 SSD 的页大小一致，`FILE_SIZE` 是缓存文件的上限。注意缓存内容是每台机器本地的，server 重启或者换机器以后就没了，别指望它重启后还热着。磁盘 IO 比内存慢两个数量级，P99 不如纯 `cache`。

### direct

每次 `dictGet` 都直接去源里 SELECT，本地什么都不存。只适合源极快、调用极少、合规上不允许缓存这种非常小众的情况，任何高频查询都别用。

### 单 key 和复合 key 的对照

| 单 key | 复合 key |
|---|---|
| `HASHED` | `COMPLEX_KEY_HASHED` |
| `SPARSE_HASHED` | `COMPLEX_KEY_SPARSE_HASHED` |
| `HASHED_ARRAY` | `COMPLEX_KEY_HASHED_ARRAY` |
| `RANGE_HASHED` | `COMPLEX_KEY_RANGE_HASHED` |
| `CACHE` | `COMPLEX_KEY_CACHE` |
| `SSD_CACHE` | `COMPLEX_KEY_SSD_CACHE` |
| `DIRECT` | `COMPLEX_KEY_DIRECT` |

`flat` 和 `ip_trie` 没有复合版本。

### 选型顺序

```
IP 段查找？             → ip_trie
地理多边形？            → polygon
层级树？                → 全量 layout + HIERARCHICAL
(key，时间/范围) 查找？  → range_hashed / complex_key_range_hashed
复合 key?               → complex_key_* 系列
密集小整数 + 行少？     → flat
< 100 万行？             → hashed
100 万 ~ 5 千万？        → hashed 或 sparse_hashed
5 千万 ~ 1 亿？          → sparse_hashed
1 亿 ~ 几十亿 + 有热点？ → cache / ssd_cache
1 亿 ~ 几十亿 + 无热点？ → 重新设计，不要用字典
合规不能缓存？           → direct
其他？                   → 不要用字典，改 JOIN 或物化视图
```

| LAYOUT | 数据结构 | 查找复杂度 | 内存特征 | 刷新模型 | 适用场景 |
|---|---|---|---|---|---|
| `flat` | 扁平数组 | O(1)，最快 | 由 max key 决定 | 全量替换 | 小整数 key 枚举 |
| `hashed` | 哈希表 | O(1) | 行数 × 1.7 | 全量替换 | 通用首选 |
| `sparse_hashed` | 稀疏哈希表 | O(1) 稍慢 | 行数 × 1.2 | 全量替换 | 大字典 |
| `complex_key_hashed` | 哈希表 + 序列化 | O(1) 略慢 | 多存 key 字节串 | 全量替换 | 复合 key |
| `range_hashed` | 哈希表 + 区间列表 | O(log m) | 多存区间字段 | 全量替换 | 时间段 / 数值段 |
| `ip_trie` | 前缀树 | O（IP 位数）| 紧凑前缀压缩 | 全量替换 | CIDR / GeoIP |
| `polygon` | 多边形索引 | O(log n) | 几何顶点存储 | 全量替换 | 地理判定 |
| `cache` | 固定 cell 缓存 | hit O(1) / miss 回源 | 固定 cell 数 | 单 key TTL | 亿级 + 热点 |
| `ssd_cache` | 内存 + SSD | 内存 O(1) / SSD ms | 固定容量 | 单 key TTL | 内存装不下的热点 |
| `direct` | 无 | 完全回源 | 0 | 不缓存 | 合规 / 极低频 |

大部分场景 `hashed` 和 `sparse_hashed` 就够了；时间段、IP 段、地理位置这三种特殊的查找各有专用的 layout；`cache` 只留给亿级、有热点的维表。

## 监控和排障

### 四张系统表

最重要的是 `system.dictionaries`，字典本身的状态全在这：

```sql
SELECT
    database, name, status, type,
    element_count, load_factor, bytes_allocated,
    query_count, found_rate, hit_rate,
    last_successful_update_time, loading_start_time, loading_duration,
    error_count, last_exception, source
FROM system.dictionaries
WHERE database = currentDatabase();
```

`status` 的几个状态：

| status | 含义 | 处置 |
|---|---|---|
| `LOADED` | 已加载，正常服务 | 健康 |
| `LOADING` | 正在加载（首次或刷新）| 等待 |
| `FAILED` | 加载失败，旧版本还在 | 报警，看 `last_exception` |
| `FAILED_AND_RELOADING` | 失败后重试 | 关注 |
| `NOT_LOADED` | 懒加载下未被使用过 | 通常正常 |
| `LOADED_AND_RELOADING` | 已加载，正在刷新 | 健康 |

节点级的看 `system.asynchronous_metrics`：

```sql
SELECT metric, value FROM system.asynchronous_metrics
WHERE metric LIKE '%Dictionar%';
```

这里有两个指标：`DictionaryMaxUpdateDelay` 是所有字典里最大的更新延迟（秒），`DictionaryTotalFailedUpdates` 是所有字典自上次成功加载以来累计的失败次数。字典一共吃了多少内存，直接对 `system.dictionaries` 的 `bytes_allocated` 求和就行。

`cache` 的累计计数在 `system.events` 里：

```sql
SELECT event, value FROM system.events WHERE event LIKE 'Dict%';
```

常看的是 `DictCacheRequests`、`DictCacheKeysRequested`、`DictCacheKeysHit`、`DictCacheKeysRequestedMiss`、`DictCacheKeysExpired`、`DictCacheRequestTimeNs`，命中率就是 `DictCacheKeysHit / DictCacheKeysRequested`。

想知道哪条业务 SQL 卡在字典上、哪个用户在高频用某个字典，翻 `system.query_log`：

```sql
SELECT query_start_time, query_duration_ms, query, user
FROM system.query_log
WHERE query LIKE '%dictGet%' AND event_date = today()
ORDER BY query_duration_ms DESC LIMIT 20;
```

### 指标阈值

| 指标 | 来源 | 健康 | 警戒 | 报警 |
|---|---|---|---|---|
| `status` | dictionaries | LOADED | LOADING > 1min | FAILED |
| `last_exception` | dictionaries | 空 | 非空但 LOADED | FAILED 且非空 |
| `loading_duration` | dictionaries | < LIFETIME.MIN × 0.3 | > × 0.5 | > LIFETIME.MIN |
| `bytes_allocated` | dictionaries | < 节点 5% | > 10% | > 20% |
| `element_count` | dictionaries | 与预期一致 | 突减 > 10% | 突减 > 30% |
| `found_rate`（cache）| dictionaries | > 95% | 80~95% | < 80% |
| `last_successful_update_time` | dictionaries | < LIFETIME × 2 | < × 5 | > × 10 |
| `sum(bytes_allocated)` | dictionaries | < 节点 30% | > 50% | > 70% |
| `MemoryResident` | async_metrics | < max_mem × 70% | > 85% | > 95% |

容易被忽略的有三个：`cache` 的 `found_rate` 掉到 80% 以下，说明回源风暴正在发生；`loading_duration` 接近 LIFETIME.MIN，说明加载已经追不上刷新周期了；`element_count` 突然掉下去，多半是源表的数据被人误删了。

### 常见故障怎么查

`dictGet` 返回空或者默认值：

```sql
-- 字典是否加载
SELECT name, status, last_exception
FROM system.dictionaries WHERE name = 'users_dict';

-- key 是否在字典里
SELECT dictHas('users_dict', toUInt64(1001));

-- 内容是否完整
SELECT count() FROM users_dict;
SELECT count() FROM users_source;
```

一般是字典 FAILED 了、key 类型不匹配、分片字典的 key 路由错了，或者还在 LOADING。

节点 OOM：

```sql
SELECT name, formatReadableSize(bytes_allocated) AS mem
FROM system.dictionaries ORDER BY bytes_allocated DESC LIMIT 10;

SELECT name, lifetime_min, lifetime_max,
       last_successful_update_time, loading_duration
FROM system.dictionaries ORDER BY last_successful_update_time DESC LIMIT 20;
```

原因无非是单个字典太大、几个字典刷新撞到了一起、源表数据暴涨，或者查询和刷新尖刺叠在了一起。临时处置可以先把出问题的字典摘掉：

```sql
DETACH DICTIONARY problematic_dict;
```

新一些的版本也可以用 `SYSTEM UNLOAD DICTIONARY problematic_dict` 先把它从内存里卸掉。

`cache` 回源风暴：

```sql
SELECT name, found_rate, hit_rate, query_count
FROM system.dictionaries WHERE type LIKE '%Cache%'
ORDER BY query_count DESC;
```

常见原因是有大范围扫描的查询、缓存容量太小、没开 `ALLOW_READ_EXPIRED_KEYS`，或者源库本身就慢。处置是把容量和回源并发调起来，打开过期读：

```sql
CREATE OR REPLACE DICTIONARY xxx ...
LAYOUT(CACHE(
    SIZE_IN_CELLS 5000000
    MAX_THREADS_FOR_UPDATES 8
    ALLOW_READ_EXPIRED_KEYS 1
));
```

数据陈旧：

```sql
SELECT name, last_successful_update_time,
       now() - last_successful_update_time AS staleness,
       lifetime_max
FROM system.dictionaries WHERE name = 'users_dict';
```

可能是 LIFETIME 还没到，增量的 `update_lag` 窗口外的数据没拉到，源表的 `update_field` 没跟着更新，刷新失败了，或者干脆就是增量场景下的删除。处置就是 `SYSTEM RELOAD DICTIONARY users_dict;`。

重启后 P99 暴涨：

```sql
SELECT name, status, loading_start_time, loading_duration
FROM system.dictionaries WHERE status = 'LOADING';

SELECT name, loading_duration FROM system.dictionaries
WHERE last_successful_update_time > now() - INTERVAL 1 MINUTE
ORDER BY loading_duration DESC;
```

基本就是懒加载加第一次查询触发了同步加载，用前面说的启动脚本预热，再让健康检查等字典加载完才放流量。

整点 MySQL CPU 飙满：

```sql
SELECT name, lifetime_min, lifetime_max
FROM system.dictionaries WHERE lifetime_min = lifetime_max;
```

好几个字典都写了固定的 `LIFETIME`，到点一起去全量 SELECT。改成 `LIFETIME(MIN X MAX Y)` 错开，再配上 `update_field` 走增量。

### 报警和巡检

报警规则的思路大致是这样，指标名要换成你自己采集出来的名字：

```yaml
- alert: DictionaryFailed
  expr: clickhouse_dictionary_status{status="FAILED"} > 0
  for: 1m
  severity: critical

- alert: DictionaryMemoryHigh
  expr: |
    sum(clickhouse_dictionary_bytes_allocated)
      / clickhouse_max_server_memory_usage > 0.5
  for: 5m
  severity: warning

- alert: DictionaryCacheHitRateLow
  expr: clickhouse_dictionary_found_rate < 0.8
  for: 5m
  severity: critical
  description: "回源风暴风险"

- alert: NodeMemoryPressure
  expr: |
    clickhouse_memory_resident_bytes
      / clickhouse_max_server_memory_usage > 0.85
  for: 3m
  severity: warning
```

每天巡检一次：

```sql
SELECT
    name, status, formatReadableSize(bytes_allocated) AS mem,
    element_count, loading_duration,
    last_successful_update_time, last_exception
FROM system.dictionaries
WHERE
    status != 'LOADED'
    OR last_exception != ''
    OR loading_duration > lifetime_min * 0.5
    OR last_successful_update_time < now() - INTERVAL 2 * lifetime_max SECOND
    OR bytes_allocated > 8 * 1024 * 1024 * 1024
ORDER BY status != 'LOADED' DESC;
```

### 几条调试用的 SQL

字典访问的 Top N：

```sql
SELECT
    extract(query, 'dictGet[a-zA-Z]*\\(''([^'']+)''') AS dict_name,
    count() AS calls,
    avg(query_duration_ms) AS avg_ms
FROM system.query_log
WHERE event_date >= today() - 1 AND query LIKE '%dictGet%'
GROUP BY dict_name ORDER BY calls DESC LIMIT 20;
```

源表多大：

```sql
SELECT table, sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS disk
FROM system.parts
WHERE active AND table = 'users_source'
GROUP BY table;
```

集群里各个副本的字典是不是一致，`element_count` 差得多，就是刷新不同步：

```sql
SELECT hostName(), name, element_count, last_successful_update_time
FROM clusterAllReplicas('my_cluster', system.dictionaries)
WHERE name = 'users_dict';
```

强制刷新一次，看要多久：

```sql
SELECT now();
SYSTEM RELOAD DICTIONARY users_dict;
SELECT now(), loading_duration
FROM system.dictionaries WHERE name = 'users_dict';
```

### 症状对照

| 症状 | 最可能根因 | 一线处置 |
|---|---|---|
| `dictGet` 返回空/默认 | FAILED 或 key 不在 | 看 `last_exception`，检查 key 类型 |
| 节点 OOM | 多字典刷新尖刺叠加 | 错峰 `MIN/MAX` + `sparse_hashed` |
| MySQL CPU 飙满 | cache 回源风暴 / 同点刷新 | 限并发 + `ALLOW_READ_EXPIRED_KEYS` |
| 数据陈旧 | LIFETIME 未到 / 增量没拉到 | `SYSTEM RELOAD DICTIONARY` |
| 重启后 P99 暴涨 | 懒加载首次查询阻塞 | 启动脚本预热 + 健康检查门控 |
| 副本间结果不一致 | 副本刷新时差 | 接受时差或对齐刷新窗口 |
| 字典内存稳态翻倍 | 源表数据爆炸 | 看 `element_count` 历史，源侧治理 |

## 附录：速查

### 选哪个 LAYOUT

| 需求 | 选择 |
|---|---|
| 通用维表 | `hashed` |
| 大维表省内存 | `sparse_hashed` |
| key 是密集整数 | `flat` |
| 复合 key | `complex_key_hashed` |
| 区间查找（年龄段、价格生效期）| `range_hashed` |
| IP 段 | `ip_trie` |
| 地理多边形 | `polygon` |
| 亿级 + 有热点 | `cache` / `ssd_cache` |
| 每次现查 | `direct` |

### 常用 SQL

```sql
-- 字典状态总览
SELECT name, status, formatReadableSize(bytes_allocated) AS mem,
       element_count, loading_duration, last_successful_update_time,
       last_exception
FROM system.dictionaries;

-- 强制刷新
SYSTEM RELOAD DICTIONARY xxx;

-- 调试看数据
SELECT * FROM xxx LIMIT 10;
SELECT dictGet('xxx', 'col', toUInt64(123));
SELECT dictHas('xxx', toUInt64(123));
```

### 生产配置模板

```sql
CREATE DICTIONARY xxx
( ... )
PRIMARY KEY id
SOURCE(MYSQL(
    NAME 'mysql_prod'             -- Named Collection 引用
    table 'xxx'
    update_field 'updated_at'     -- 增量
    update_lag 30
    invalidate_query 'SELECT max(updated_at) FROM xxx'
))
LAYOUT(SPARSE_HASHED())           -- 千万级默认选择
LIFETIME(MIN 300 MAX 360);        -- 窄区间随机错峰
```

再配上启动后预热关键字典、`last_exception` 报警、每天凌晨低峰全量 `SYSTEM RELOAD` 一次清掉删除。内存预算按单个字典稳态的三倍去留，这里面包括了 2.5 倍的尖刺和一点余量。

## 最后

字典这东西，用对了是真香，一个 `dictGet` 能把一个要建 hash 表的 JOIN 变成一次内存查找。可它的成本不在查的时候，在刷的时候，也在规模上来以后。最容易踩的几个坑：`LIFETIME` 写成固定值，几个字典的尖刺叠在一起把节点打爆；大字典懒加载又不预热，重启后第一个查询卡几分钟；配了 `update_field` 却从不做全量，删掉的数据一直在字典里；还有分片字典，以为 `dictGet` 的 key 一定来自 sharding key，结果不是，返回一堆默认值，谁也没发现。

---

**相关**：[物化视图：三种机制，以及 100T 表上的 POPULATE](/clickhouse/deep-dive/materialized-view) · [到底要不要写 UDF](/clickhouse/deep-dive/udf)
