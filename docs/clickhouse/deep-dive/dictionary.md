---
title: ClickHouse 字典：省掉的 JOIN，多付的内存
---

# ClickHouse 字典：省掉的 JOIN，多付的内存

> 字典把「反复 JOIN 小维表」换成「一次加载、全局共享、O(1) 查找」—— 代价是双缓冲刷新时 2.2~2.5 倍的内存尖刺，以及一条你迟早会撞上的规模上限。
>
> **阅读对象**：在 ClickHouse 里反复 JOIN 小维表，或者被字典刷新的内存尖刺打过的工程师。

---

## 一、字典是什么

**ClickHouse 字典是一份由 ClickHouse 管理、常驻内存的查找表，可以用一个 key 在毫秒级（甚至微秒级）拿到对应的一行或几列数据。**

类比：
- 编程语言里的 `HashMap<Key, Value>`，只是 value 可以是多列
- Redis 里的 Hash，只是 ClickHouse 自己加载、自己刷新
- 关系型数据库里的「维表」，只是不需要每次 JOIN 都去磁盘扫

### 为什么需要它

考虑事实表 `events`（几十亿行）+ 维表 `users`（几百万行），传统 JOIN 每次都要把右表读出来、建 hash 表，即使维表没变。

字典做法：

```sql
SELECT
    dictGet('users_dict', 'city', user_id) AS city,
    count()
FROM events
WHERE action = 'click'
GROUP BY city;
```

`users_dict` **一次性常驻内存**，所有查询共享，`dictGet` 是 O(1) 哈希查找。维表更新由 ClickHouse 按 `LIFETIME` 自动刷新。

**这就是字典最核心的价值：把「反复 JOIN 小维表」优化成「一次加载、全局共享、O(1) 查找」。**

---

## 二、字典的三大组成

定义一个字典本质上就是回答三个问题：

| 部分 | 回答的问题 | 例子 |
|---|---|---|
| **SOURCE** | 数据从哪里来？| MySQL、PostgreSQL、ClickHouse 表、HTTP、文件 |
| **LAYOUT** | 在内存里怎么存？| 哈希表、扁平数组、LRU 缓存、区间树 |
| **LIFETIME** | 多久刷新一次？| 每 300 秒重新加载 |

加上 schema 描述（`PRIMARY KEY` 和属性列），一个字典就齐了。

---

## 三、最小可用示例

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

查询两种方式：

```sql
-- A. dictGet 函数（高频生产用法）
SELECT dictGet('users_dict', 'city', toUInt64(1001));
SELECT dictGet('users_dict', ('city', 'vip_level'), toUInt64(1001));

-- B. 字典当表 SELECT(调试用)
SELECT * FROM users_dict WHERE user_id = 1001;
```

⚠️ `dictGet` 的 key 类型要严格匹配，经常需要 `toUInt64(...)` 显式转换。

### dictGet 家族

| 函数 | 用途 |
|---|---|
| `dictGet` | key 不存在时返回类型默认值（`''`/`0`）|
| `dictGetOrDefault` | key 不存在时返回指定默认值 |
| `dictGetOrNull` | key 不存在时返回 NULL |
| `dictHas` | 判断 key 是否存在 |
| `dictGetHierarchy` | 用于层级字典（取祖先链路）|

---

## 四、容量规划

判断「字典适不适合」要看三个维度，不只看行数：

| 维度 | 关心什么 | 决定 |
|---|---|---|
| 行数 | 多少个 key | 加载时间 |
| 单行宽度 | 每行字节数（字符串列关键）| 内存占用 |
| 更新频率 | 多久变一次 | 刷新成本 |

### 按 LAYOUT 给出的容量推荐

| LAYOUT | 推荐量级 | 说明 |
|---|---|---|
| `flat` | ≤ 几十万，极限 500 万 | 数组大小由 **最大 key 值** 决定 |
| `hashed` | 几百万到几千万 | 通用首选 |
| `sparse_hashed` | 千万到亿级 | 省 30% 内存 |
| `complex_key_hashed` | 同 hashed，略高 | 复合 key |
| `cache` / `ssd_cache` | 上亿到几十亿 | 必须有热点分布 |
| `direct` | 任意 | 每次直查源，极小众 |

### 经验阈值

| 维表规模 | 推荐方案 |
|---|---|
| < 10 万行 | `flat` / `hashed`，内存忽略 |
| 10 万 ~ 1000 万 | `hashed` / `sparse_hashed` |
| 1000 万 ~ 1 亿 | `sparse_hashed`，算好预算 |
| 1 亿 ~ 10 亿 | `cache` / `ssd_cache`，要有热点 |
| > 10 亿且无热点 | **不要用字典**，改用 JOIN 或表设计 |

### 红线指标

满足任一条就要重新评估：

1. 单字典内存 > 节点物理内存的 10~20%(经验线：单字典 ≤ 8~16 GB)
2. 加载时间 > LIFETIME 的一半
3. 源库扛不住全量拉取
4. 维表更新频率到秒级

### 一句话

> 几十万到几千万行、单字典内存控制在 4~8 GB 以内，是字典最舒服的甜蜜区。

---

## 五、更新与刷新机制

### 1. LIFETIME 自动刷新

```sql
LIFETIME(300)                    -- 固定 300 秒
LIFETIME(MIN 300 MAX 600)        -- 300~600 随机
LIFETIME(0)                      -- 永不自动刷新
```

**关键：`MIN/MAX` 区间的作用是字典间错峰，不是 key 间错峰**(`cache` 例外，见后)。建议 `MAX ≈ MIN × 1.2 ~ 1.5`。

### 2. 双缓冲机制

刷新过程：

```
1. 后台线程：从 SOURCE 全量（或增量）拉数据
2. 在内存里构建新版本 V2
3. 原子地切换指针：dictGet 立刻指向 V2
4. 释放旧版本 V1
```

- 刷新过程中 `dictGet` 不会阻塞、不会读到半成品
- 内存瞬时翻倍（2x 尖刺，见第六节）
- 刷新失败时旧版本继续服务，不会丢数据

### 3. 增量更新（大字典必备）

```sql
SOURCE(MYSQL(
    ...
    update_field 'updated_at'    -- 增量字段
    update_lag 30                -- 回拉秒数，防时钟漂移漏更新
))
```

实际下发 SQL:
```sql
SELECT * FROM users WHERE updated_at >= (T_last - update_lag);
```

⚠️ 增量更新两个大坑：
- **拿不到删除**：删除没有更新事件 → 字典里脏数据残留 → 解法：软删除 + 定期全量
- **首次加载仍是全量**:`update_field` 只优化后续刷新

### 4. 手动控制

```sql
SYSTEM RELOAD DICTIONARY users_dict;     -- 同步全量刷新
SYSTEM RELOAD DICTIONARY users_dict ASYNC;
SYSTEM RELOAD DICTIONARIES;              -- 慎用，触发所有
```

### 5. 状态监控（第一张要记住的表）

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

---

## 六、内存尖刺

### 一定会有，而且常常超过 2x

**双缓冲机制必然导致 V1 + V2 共存，理论 2x，实际 2.2 ~ 2.5x**，放大因子：

1. 构建过程中的临时缓冲（Block 流式拉取）
2. 哈希表 rehash 的瞬时翻倍
3. String 列内存分配的碎片（10~20%）
4. 多个字典同时刷新叠加（必须用 `MIN/MAX` 错峰）

### 千万级字典的实际数字

```
1000 万行，key 8 字节 + 3 String 列 60 字节 + 数值 8 字节
单行 ≈ 130 字节（含 hash 开销）
稳态 ≈ 1.3 GB
刷新尖刺峰值 ≈ 3 GB，持续 30 秒 ~ 几分钟
```

### 降低尖刺的方案（代价从小到大）

1. **错峰刷新**(0 成本):`LIFETIME(MIN 300 MAX 600)`，**不要写 `LIFETIME(300)`**
2. **`sparse_hashed`**：稳态省 30%，尖刺绝对值跟降
3. **增量更新**：幅度不变但**持续时间极短**，撞 OOM 概率大降
4. **换 `cache`**：无全量重建，完全无尖刺（但回源风险）
5. **限制并发加载**:`<max_concurrent_loads>` 全局参数
6. **预留 3x 内存余量**

### 监控指标

```sql
-- 稳态
SELECT name, formatReadableSize(bytes_allocated) FROM system.dictionaries;

-- 节点 RSS(看真实尖刺)
SELECT metric, formatReadableSize(value)
FROM system.asynchronous_metrics
WHERE metric IN ('MemoryResident', 'MemoryTracking', 'jemalloc.resident');
```

把 `MemoryResident` 曲线画出来，会清楚看到字典刷新时刻的锯齿状尖刺。

---

## 七、LIFETIME 在不同 LAYOUT 下的语义

**常见误解：`LIFETIME(MIN/MAX)` 是打散 key 的过期时间。** 实际不是。

| LAYOUT | LIFETIME 控制的是 | 是否打散 key | 会不会一直刷新 | 会不会某些 key 长期不刷 |
|---|---|---|---|---|
| `flat` / `hashed` / `sparse_hashed` / `complex_key_hashed` / `range_hashed` | **整个字典下次刷新的时刻**(每轮重新随机) | ❌ | ❌ 有明确间隔 | ❌ 全量替换，所有 key 同步 |
| `cache` / `ssd_cache` | **每个 key 独立的 TTL** | ✅ | ❌ 只在 miss 时回源 | ⚠️ 冷门 key 可能长期不刷（但没人查也不算陈旧）|
| `direct` | 无意义 | — | — | — |
| `LIFETIME(0)` | 永不自动刷新 | — | ❌ 永远不刷 | ✅ 所有 key 永远不刷 |

### 对 `hashed` 家族

整个字典作为单位刷新，MIN/MAX 是**字典之间错峰**，不是 key 之间错峰。每轮刷新结束才决定下一轮时间，有 MIN 保底间隔。

### 对 `cache` 家族

每个 key 写入缓存时被分配一个 [MIN, MAX] 区间内的随机 TTL，过期后下次访问回源。**冷门 key 可能在缓存里「挂」很久，但只在被查询时才更新**。「不存在的 key」也有 TTL 缓存，避免反复回源。

---

## 八、自动 expire 机制

「expire」有三种含义，逐个回答：

### 含义 A：单 key 自动过期

| LAYOUT | 支持 |
|---|---|
| `cache` / `ssd_cache` | ✅ 按 TTL + LRU |
| `hashed` 家族 | ❌ 整体快照模型 |
| `direct` | ❌ 不缓存 |

### 含义 B：整个字典空闲自动卸载

**❌ 默认没有。** 字典加载后常驻内存，直到：
- `DROP DICTIONARY` / `DETACH DICTIONARY`
- 进程重启
- `SYSTEM DROP DICTIONARY CACHE`（仅对 cache 有效）

懒加载（`dictionaries_lazy_load`）只控制**首次加载时机**，不解决「加载后释放」。

### 含义 C：数据陈旧自动刷新

就是第五节的 `LIFETIME` + `invalidate_query`，严格说不叫过期叫刷新。

### 运维含义

- 不要「以防万一」创建大量字典，每个都吃内存且永不释放
- 不用的字典主动 `DROP DICTIONARY`

---

## 九、全量刷新与删除清理

### 区分全量 vs 增量

| 刷新类型 | 下发 SQL | 删除能否被感知 |
|---|---|---|
| 全量 | `SELECT * FROM users` | ✅ 源里没了就没了 |
| 增量 | `SELECT * FROM users WHERE updated_at >= ...` | ❌ 删除没有更新事件 |

什么决定全量还是增量：
- 没配 `update_field` → 永远全量
- 配了 `update_field` → 首次全量，后续增量
- `SYSTEM RELOAD DICTIONARY` → **永远全量**

### 全量如何自动清理删除

双缓冲切换时，V2 是源表最新快照，V1 里有但 V2 里没有的 key，切换后释放 → 自然消失。

### 生产标准模式：**增量 + 定期全量**

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

配套 crontab：每天凌晨低峰 `SYSTEM RELOAD DICTIONARY users_dict;`

**增量保性能，全量保正确性。**

### 其他删除感知方案

| 方案 | 删除感知延迟 | 复杂度 | 备注 |
|---|---|---|---|
| 纯全量 | 平均 LIFETIME/2 | 低 | 频繁尖刺 |
| 增量 + 每日全量 | 最长 24h | 低 | **推荐** |
| 增量 + 源表软删除 | 几分钟 | 中（改业务）| 字典中过滤 is_deleted |
| 增量 + `invalidate_query` | 看检测查询 | 中 | 行数变化触发全量 |
| Binlog CDC → CH 表 | 秒级 | 高 | 引入 CDC 组件 |
| `cache` + 短 TTL | 平均 TTL/2 | 低 | 自然反映 |

---

## 十、SOURCE 类型

按「数据从哪来」四大类：

### 数据库类

| SOURCE | 适用 | 注意 |
|---|---|---|
| `CLICKHOUSE` | 同/异集群 CH 表 | 性能最好，本地表可省 host/port |
| `MYSQL` | 业务维表 | N 节点 = N 倍并发到 MySQL,DATETIME 时区坑 |
| `POSTGRESQL` | PG 维表 | 类型映射比 MySQL 干净 |
| `MONGODB` | Mongo 文档 | 类型映射弱，生产少用 |
| `REDIS` | 配合 cache 用 | 只支持 simple / hash_map,schema 受限 |
| `ODBC` | SQL Server / Oracle 等 | 需要 `clickhouse-odbc-bridge` |

### 文件类

| SOURCE | 适用 | 注意 |
|---|---|---|
| `FILE` | 静态码表 | **每个节点都要有文件**，推荐打镜像 |
| `HDFS` / `S3` | T+1 数仓产出 | Parquet 比 CSV 快很多 |

### HTTP 类

```sql
SOURCE(HTTP(url '...' format 'CSV'))
```

- 适合配置中心、算法平台
- 大数据量（千万+）不推荐，建议改 S3
- 接口必须幂等且全量返回

### 可执行类

`EXECUTABLE` / `EXECUTABLE_POOL`：复杂度极高、安全风险大，**99% 团队不该用**，改用 HTTP 服务更标准。

### 通用 SOURCE 参数

| 参数 | 作用 |
|---|---|
| `update_field` | 启用增量 |
| `update_lag` | 增量回拉秒数 |
| `invalidate_query` | 源变更感知 |
| `where` | 部分行过滤 |
| `query` | 自定义 SELECT（支持 JOIN 多源表，但代价大）|

### 选型决策

| 场景 | 推荐 |
|---|---|
| MySQL/PG 业务维表 | `MYSQL` / `POSTGRESQL` |
| 维表已落 CH | `CLICKHOUSE`（性能最好）|
| SQL Server / Oracle | `ODBC` |
| 静态码表 | `FILE` 或代码 hardcode |
| T+1 数仓 | `S3` / `HDFS`（Parquet）|
| 配置中心 | `HTTP` |
| 自定义脚本 | 部署 HTTP 服务，**不要**用 `EXECUTABLE` |

---

## 十一、启动加载时机

### 默认是懒加载

```xml
<dictionaries_lazy_load>true</dictionaries_lazy_load>
```

服务启动只解析 DDL，字典第一次被使用时同步加载。

### 三种策略

| 策略 | `lazy_load` | `wait_dictionaries_load_at_startup` | 启动行为 |
|---|---|---|---|
| 完全懒加载（默认）| true | — | 启动极快，首次查询阻塞 |
| 启动时同步预加载 | false | true | 启动阻塞至全部加载完 |
| 启动时异步加载 | false | false | 启动不阻塞，后台并发加载 |

### 懒加载的隐藏成本

千万级字典首次查询可能卡几十秒到几分钟，**P99 尖刺**。高并发服务重启后瞬时多个查询全卡在同一字典加载。

### 生产推荐：懒加载 + 启动后预热

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

### 启动状态查询

```sql
SELECT name, status, formatReadableSize(bytes_allocated) AS mem,
       loading_duration, last_exception
FROM system.dictionaries
ORDER BY status != 'LOADED' DESC, loading_duration DESC;
```

---

## 十二、XML 配置文件 vs SQL DDL

### XML 方式：天然热更新

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

- 后台线程每 5 秒（`dictionaries_config_reload_interval`）扫描文件 mtime
- 改 XML 推送后**几秒自动生效**，无需重启或执行 SQL
- 安全部署：写临时文件 + `mv` 替换，避免读到中间状态
- 语法错文件被忽略，旧定义继续工作，看日志报错

### SQL DDL 方式

```sql
CREATE OR REPLACE DICTIONARY users_dict ( ... ) ... ;
```

执行立即生效。无 `ALTER DICTIONARY` 增量修改，只能整体替换。

### 对比

| 维度 | XML | SQL DDL |
|---|---|---|
| 热更新机制 | 文件扫描，5 秒 | 执行 SQL 立即 |
| 集群同步 | ⚠️ 每节点都要有文件 | ✅ Replicated DB 自动同步 |
| 版本控制 | XML 进 Git | 管理 migration SQL |
| 权限控制 | ❌ 无 | ✅ 标准 SQL 权限 |
| 归属数据库 | ❌ 无 | ✅ 按 db 隔离 |
| 审计 | 文件系统日志 | query log |

### 推荐

- **新项目优先 SQL DDL**：权限、审计、集群同步都更完善
- **基础设施型字典用 XML**：运维侧自治、配置管理友好
- XML 长期支持，不用担心被废弃

---

## 十三、Named Collection

### 定位

**Named Collection 是「连接配置的命名复用容器」，不是字典。**

类比：AWS named profile、K8s Secret + ConfigMap。

存储：host、port、user、password、bucket、url 等「连接信息」。

### 解决什么问题

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

### 使用场景

| 场景 | 例子 |
|---|---|
| 字典 SOURCE | `SOURCE(MYSQL(NAME 'mysql_prod' table 'users'))` |
| 表函数 | `mysql(mysql_prod, table = 'logs')` |
| 表引擎 | `ENGINE = MySQL(mysql_prod, ...)` |
| 远程 CH | `remote(ch_cluster, ...)` |
| S3 / HDFS | `s3(s3_backup, ...)` |
| BACKUP | `BACKUP ... TO S3(s3_backup, ...)` |
| Kafka | `ENGINE = Kafka(kafka_prod, ...)` |

### Named Collection vs Dictionary

| 维度 | Named Collection | Dictionary |
|---|---|---|
| 本质 | 配置参数集合 | 内存查找表 |
| 存什么 | 连接信息 | 数据行 |
| 占内存 | ❌ 几乎不 | ✅ GB 级 |
| 引用方式 | 名字嵌入 SQL | `dictGet(...)` |
| 周期刷新 | ❌(改 XML 才变) | ✅ |
| 解决问题 | 配置复用 + 凭证脱敏 | 维表 JOIN 性能 |

**核心区分：Named Collection 告诉 CH 「怎么连接源」，字典告诉 CH 「把源数据拉进来怎么用」。**

### 适合做「地址管理」

是的，这是 NC 的主战场。但要避免误用：
- ❌ 不要存业务地址数据（用户收货地址）
- ❌ 不要做动态服务发现（配置是静态的）
- ❌ 不要替代密钥管理系统（NC 里的密码仍是文件系统明文）

### 生产价值

- 单点变更（改密码改一处）
- 环境隔离（dev/staging/prod 用同名 NC 不同 XML,SQL 同构）
- 凭证脱敏（query_log 看到的是 `NAME 'xxx'`，不是密码）
- 权限收敛（`GRANT NAMED COLLECTION USAGE/ADMIN`）
- 热更新（XML 改了 5 秒生效）

---

## 十四、分布式场景：分片字典

### 默认行为的浪费

字典是**每节点本地资源**。10 分片 × 10GB 字典 = 100GB 总内存。但事实表按 `cityHash64(user_id)` 分片时，每个分片实际只需要 1/N 的字典数据。

ClickHouse **没有原生「分片字典」语法**，但可以通过 source 端设计实现。

### 方案 A：本地表做 source（推荐）

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

效果：每节点字典只有 1/N 数据，集群内存从 N 份降到 1 份。

**前提：事实表 sharding key = 维表 sharding key = 字典 key，三者一致。**

### 方案 B:source 用过滤查询 + macros

```sql
SOURCE(MYSQL(
    NAME 'mysql_prod'
    query 'SELECT ... FROM users WHERE cityHash64(user_id) % 10 = {shard}'
))
```

每分片下发不同 SQL。问题：
- Hash 函数两边要字面一致（MySQL 没原生 `cityHash64`）
- 分片数硬编码，扩容要改所有定义
- MySQL 这边 `cityHash64(user_id)` 不是索引列 → 全表扫描

生产里 **方案 A 远比方案 B 安全**。

### 真正属于分片字典自身的陷阱

1. **静默默认值**(核心特性):`dictGet` 错分片不报错，返回该类型的默认值 → 业务侧静默错误
   - 应对：`dictGet` 的 key 必须严格来自 sharding key;测试用 `dictHas` 校验
2. **Hash 表达式必须字符串字面一致**：事实表的 `cityHash64(user_id)` 和维表 Distributed 引擎里的表达式要一字不差
3. **副本间字典刷新不同步**：同分片两副本可能看到不同版本的字典（几分钟时间差），副本一致性敏感的业务要意识到
4. **调试可见性**:`SELECT * FROM users_dict` 看到的只是本分片切片

> 注：「扩容需要数据再均衡」不是分片字典特有的问题，这是 sharded 数据结构（包括 Replacing、Aggregating 引擎）的通用集群治理问题，应在集群规划层面解决，不属于字典讨论范围。

### 什么时候做、什么时候不做

✅ 适合：
- 集群 ≥ 4 分片
- 维表 ≥ 1 千万行
- 事实表 sharding key 就是 `dictGet` 的 key
- 集群拓扑稳定

❌ 不适合：
- 维表查询 key 多样（没有统一 sharding key）
- 维表小（几十万行），全量复制成本低
- 业务侧无法严格保证 `dictGet` key 来源

### 折中：用 Distributed 表做 source

```sql
SOURCE(CLICKHOUSE(TABLE 'users_distributed'))
```

等于没优化（每分片拉全量），但避免静默错误，适合「维表小、风险敏感」。

---

## 十五、`dictGet` 函数族 + SQL 中字典的高级用法

### 1. `dictGet` 完整语法

```
dictGet(dict_name, attr_name_or_tuple, key_or_tuple [, default])
```

**多属性 Tuple 形式是关键性能优化**:

```sql
-- 5 次哈希查找
SELECT dictGet(d,'a',k), dictGet(d,'b',k), dictGet(d,'c',k), ...

-- 1 次哈希查找
SELECT dictGet(d, ('a','b','c','d','e'), k)
```

宽字典查询能节省 80% 字典访问开销。

### 2. 默认值的三种语义

```sql
dictGet('users_dict', 'city', toUInt64(99999))                       -- 类型默认值 ''
dictGetOrDefault('users_dict', 'city', toUInt64(99999), 'Unknown')   -- 显式兜底
dictGetOrNull('users_dict', 'city', toUInt64(99999))                 -- 返回 NULL
```

生产推荐：
- 分片字典场景用 `dictGetOrDefault` 显式化「不在本分片」
- 下游需要 `coalesce` 判断用 `dictGetOrNull`

### 3. 类型化变体

`dictGetString` / `dictGetUInt64` / ... 是老写法，新版本通用 `dictGet` 已能自动推导类型。`dictGetStringOrDefault` 等带 OrDefault 后缀仍常用。

### 4. 辅助函数族

| 函数 | 用途 |
|---|---|
| `dictHas(dict, key)` | 判断 key 是否存在 |
| `dictGetChildren(dict, key)` | 层级：直接子节点 |
| `dictGetDescendants(dict, key)` | 层级：所有后代 |
| `dictGetHierarchy(dict, key)` | 层级：祖先链（自己到根）|
| `dictIsIn(dict, child, ancestor)` | 层级：是否在子树下 |

`dictHas` 典型用法：

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

### 5. 层级字典：树形 lookup

`HIERARCHICAL` 修饰符把某列声明为父指针：

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

经典查询 —— 「按任意层级聚合」:

```sql
SELECT sum(sales) FROM employees
WHERE dictIsIn('dept_dict', dept_id, toUInt64(2));   -- 整个 R&D 体系
```

替代递归 CTE / 打平祖先列表，性能高 1~2 个数量级。

### 6. 区间字典：`range_hashed` + 时间点

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

替代「按 start_date <= date < end_date JOIN」的复杂自连接。

约束：
- 区间不能重叠（否则未定义）
- 两端类型一致
- 闭区间 `[start, end]`

### 7. IP 字典

```sql
LAYOUT(IP_TRIE())
PRIMARY KEY prefix

-- IPv4 查询
SELECT dictGet('ip_dict', 'country', tuple(IPv4StringToNum('1.2.3.4')));
```

百万级 CIDR，单次查找 < 100ns,**自动最长前缀匹配**。

### 8. 字典作为表用

三种姿势：

```sql
-- A. 直接 SELECT(调试)
SELECT * FROM users_dict WHERE user_id = 1001;

-- B. 显式建 Dictionary 引擎表（老 SQL 兼容）
CREATE TABLE users_dict_table ( ... ) ENGINE = Dictionary('users_dict');

-- C. 子查询过滤
SELECT * FROM events
WHERE user_id IN (SELECT user_id FROM users_dict WHERE vip_level > 2);
```

生产高频仍用 `dictGet`，以上方式适合调试和过渡。

### 9. 字典 vs JOIN 取舍

| 场景 | 选择 |
|---|---|
| `dictGet` 取少量属性 + GROUP BY | 字典完胜 JOIN |
| `dictGet` 做过滤 | 字典完胜 |
| 取维表多列做投影 | Tuple 形式 `dictGet` |
| 多对多关系 | **JOIN**(字典做不到) |
| ANTI / OUTER JOIN 语义 | JOIN 更直观 |
| 维表大于事实表 | JOIN（字典装不下）|

### 10. 性能陷阱

**不要在 JOIN ON 里用 `dictGet`**:

```sql
-- 反例：每行算一次，关闭哈希 JOIN
... JOIN other ON dictGet('xxx', 'col', id) = other.col

-- 正确：先 dictGet 出列再 JOIN
SELECT ... FROM (
    SELECT *, dictGet('xxx','col',id) AS col FROM events
) e JOIN other USING col;
```

**同一行取多属性必须 Tuple**：已在 1 节强调。

**key 类型严格匹配**：养成 `toUInt64(id)` 习惯，避免隐式转换的边界问题。

**分布式查询中 `dictGet` 在每个分片本地执行**：这是分片字典优化能成立的根本。

**`dictGet` 是向量化批处理**：一次给一万个 key 返回一万个 value，性能受内存带宽而非 IPS 限制；`cache` miss 时**批量打包回源**自带防雪崩。

### 11. 实战：嵌套调用与数组属性

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

### 一句话

> **`dictGet` 是字典在 SQL 里的主入口，Tuple 多属性 / 默认值控制 / `dictHas` 组合是日常基本功；`HIERARCHICAL` / `range_hashed` / `ip_trie` 解决树形 / 时间区间 / IP 段三种特殊但高频的查找模式；真正的性能秘诀是「批量化、属性 Tuple 化、key 类型严格、不要在 JOIN ON 里调用」。**

---

## 十六、LAYOUT 详解与选型

LAYOUT 不是配置项，是字典的「形状本身」，决定数据结构、查找复杂度、内存占用、刷新模型、是否回源、支持的 key 类型。

### 1. `flat`：最快的字典，但有硬约束

**内部：扁平数组，key 直接作为下标**。`arr[key]` 一次内存访问，所有 LAYOUT 里最快。

致命约束：**数组大小由 max key 值决定，不是行数**。key=[1,2,3,99999999] → 数组开 1 亿长度，内存全空洞。

安全规则：
- key 是 `UInt8`/`UInt16`/`UInt32`，或密集自增 ID 知道上界
- 默认 `max_array_size = 500000`，可调

适合：小整数枚举（国家代码、错误码），几千到几万。
不适合：`UInt64` / 稀疏 / 行数 > 100 万。

### 2. `hashed`：通用首选

**内部：HashMap，开链冲突，装载因子约 0.5**。查找一次哈希 + 1~2 次内存访问。

内存 ≈ `(key + attrs) × 1.5 ~ 2.0`（哈希表 overhead）。

适合：**几乎所有维表场景的默认选择**，几十万到几千万。

进阶参数（23.x+）：
```sql
LAYOUT(HASHED(
    PREALLOCATE 1
    SHARDS 8                  -- 内部分片并行加载
))
```

`SHARDS` 让大字典加载从几分钟降到几十秒，千万级以上推荐开。

### 3. `sparse_hashed`：大字典省内存版

**内部：Google sparse hash，分组按需分配，装载因子可到 0.8**。

- 比 `hashed` 省 30~40% 内存
- 查找慢 10~20%，加载慢 20~30%(实战感知不到)
- **刷新尖刺绝对值也跟着降**

规则：**字典 ≥ 500 万行直接用 `sparse_hashed`，不犹豫**。

### 4. `complex_key_hashed`：复合 key

**内部：HashMap,key 序列化为字节串**。

```sql
PRIMARY KEY user_id, product_id
LAYOUT(COMPLEX_KEY_HASHED())

SELECT dictGet('d', 'score', tuple(toUInt64(1001), toUInt64(2002)));
```

比单 key 慢约 30%，内存多存序列化字节串。对应 sparse 变体：`COMPLEX_KEY_SPARSE_HASHED`。

### 5. `range_hashed`：区间字典

**内部：HashMap + 每个 key 的排序区间列表**，二分查找区间。

```sql
LAYOUT(RANGE_HASHED(
    range_lookup_strategy 'max'                 -- 多区间命中策略
    convert_null_range_bound_to_open 1          -- NULL 端点 = 无穷（23.x+）
))
RANGE(MIN start_date MAX end_date)
```

`range_lookup_strategy`：
- `min`（默认）：取 start 最小
- `max`：取 start 最大（「取最新生效版本」）

复合 key 版：`COMPLEX_KEY_RANGE_HASHED`。

### 6. `ip_trie`：IP CIDR 专属

**内部：Patricia Trie，自动最长前缀匹配**。复杂度 O（IP 位数），和数据量无关。

```sql
LAYOUT(IP_TRIE())
PRIMARY KEY prefix
```

百万级 CIDR 单次 < 100ns。GeoIP 场景必选。

为什么不用 `range_hashed`：IP 段没有自然分组 key + CIDR 是最长前缀匹配，语义不同。

### 7. `polygon`：地理多边形

**内部：R-Tree 或网格索引**。给定经纬度，查它落在哪个预定义多边形。

```sql
LAYOUT(POLYGON(STORE_POLYGON_KEY_COLUMN 1))

SELECT dictGet('districts', 'name', tuple(116.40, 39.90));
```

替代 ST_Contains JOIN，快几个数量级。

### 8. `cache`：亿级维表的杀手锏

**内部：分片 LRU（典型 256 shard），每个 cell 含 key + value + 过期时间戳 + LRU 链指针**。

```sql
LAYOUT(CACHE(
    SIZE_IN_CELLS 1000000                   -- 缓存容量（cell 数）
    MAX_THREADS_FOR_UPDATES 4               -- 回源并发上限
    ALLOW_READ_EXPIRED_KEYS 1               -- 过期 key 异步刷新而非阻塞
))
LIFETIME(MIN 300 MAX 600)                   -- 单 key TTL
```

性能：
- hit 微秒级，miss **毫秒到几十毫秒**(取决于源库)
- **命中率是 cache 的生命线**

回源风暴风险：
```
1000 个 key 同时 miss → 1000 个并发 SELECT 打 MySQL → 源库挂
```

应对：
1. `MAX_THREADS_FOR_UPDATES` 限制并发
2. `ALLOW_READ_EXPIRED_KEYS 1`：过期先返回旧值，异步刷新
3. 业务侧查询限流
4. 源库前加 ProxySQL 限流

### 9. `ssd_cache`：磁盘扩展

```sql
LAYOUT(SSD_CACHE(
    PATH '/var/lib/clickhouse/ssd_cache_dict/'
    MAX_PARTITIONS_COUNT 16
    BLOCK_SIZE 4096
    FILE_SIZE 16777216
))
```

内存 + 磁盘两层 LRU,**重启后磁盘缓存保留**(相对 `cache` 的最大优势)。

代价：磁盘 IO 慢两个数量级，P99 不如纯 `cache`。

### 10. `direct`：不缓存直查

每次 `dictGet` 直接 SELECT 源，无本地存储。

适合（极小众）：源极快 + 调用频率极低 + 合规要求不能缓存。
不适合：任何高频查询。

### 11. complex_key 系列对照

| 单 key | 复合 key |
|---|---|
| `HASHED` | `COMPLEX_KEY_HASHED` |
| `SPARSE_HASHED` | `COMPLEX_KEY_SPARSE_HASHED` |
| `RANGE_HASHED` | `COMPLEX_KEY_RANGE_HASHED` |
| `CACHE` | `COMPLEX_KEY_CACHE` |
| `SSD_CACHE` | `COMPLEX_KEY_SSD_CACHE` |
| `DIRECT` | `COMPLEX_KEY_DIRECT` |

`flat` 和 `ip_trie` 没有复合版本。

### 12. 选型决策流程

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

### 13. 全面对照表

| LAYOUT | 数据结构 | 查找复杂度 | 内存特征 | 刷新模型 | 适用场景 |
|---|---|---|---|---|---|
| `flat` | 扁平数组 | O(1)，最快 | 由 max key 决定 | 全量替换 | 小整数 key 枚举 |
| `hashed` | HashMap | O(1) | 行数 × 1.7 | 全量替换 | 通用首选 |
| `sparse_hashed` | sparse HashMap | O(1) 稍慢 | 行数 × 1.2 | 全量替换 | 大字典 |
| `complex_key_hashed` | HashMap + 序列化 | O(1) 略慢 | 多存 key 字节串 | 全量替换 | 复合 key |
| `range_hashed` | HashMap + 区间列表 | O(log m) | 多存区间字段 | 全量替换 | 时间段 / 数值段 |
| `ip_trie` | Patricia Trie | O（IP 位数）| 紧凑前缀压缩 | 全量替换 | CIDR / GeoIP |
| `polygon` | R-Tree / 网格 | O(log n) | 几何顶点存储 | 全量替换 | 地理判定 |
| `cache` | 分片 LRU | hit O(1) / miss 回源 | 固定 cell 数 | 单 key TTL | 亿级 + 热点 |
| `ssd_cache` | 内存 + SSD LRU | 内存 O(1) / SSD ms | 固定容量 | 单 key TTL | 重启不丢热点 |
| `direct` | 无 | 完全回源 | 0 | 不缓存 | 合规 / 极低频 |

### 一句话

> **`hashed`/`sparse_hashed` 覆盖 90% 场景；`cache` 解决 5% 的亿级热点；`range_hashed`/`ip_trie`/`polygon` 是为时间段 / IP 段 / 地理三种 lookup 模式定制的高性能数据结构；`flat`/`direct` 是边缘选择。能记住「`sparse_hashed` 是大字典默认，`cache` 要有热点才用，特殊查找模式找专用 layout」,90% 的选型就对了。**

---

## 十七、生产监控与故障排查

### 1. 核心系统表：四张牌

#### `system.dictionaries` —— 字典本身的状态（最重要）

```sql
SELECT
    database, name, status, type,
    element_count, load_factor, bytes_allocated,
    query_count, found_rate, hit_rate_time, miss_rate_time,
    last_successful_update_time, loading_start_time, loading_duration,
    last_exception, source
FROM system.dictionaries
WHERE database = currentDatabase();
```

`status` 状态机：

| status | 含义 | 处置 |
|---|---|---|
| `LOADED` | 已加载，正常服务 | 健康 |
| `LOADING` | 正在加载（首次或刷新）| 等待 |
| `FAILED` | 加载失败，旧版本还在 | **报警**，看 `last_exception` |
| `FAILED_AND_RELOADING` | 失败后重试 | 关注 |
| `NOT_LOADED` | 懒加载下未被使用过 | 通常正常 |
| `LOADED_AND_RELOADING` | 已加载，正在刷新 | 健康 |

#### `system.asynchronous_metrics` —— 节点级聚合

```sql
SELECT metric, value FROM system.asynchronous_metrics
WHERE metric LIKE '%Dictionar%';
```

关键：
- `NumberOfDictionariesLoaded`
- `DictionaryMaxLastSuccessfulUpdateTime`
- `MemoryDictionariesBytes`（评估字典是否吃了过多内存的总入口）

#### `system.events` —— 累积计数

```sql
SELECT event, value FROM system.events WHERE event LIKE 'Dict%';
```

`DictCacheRequests` / `DictCacheHits` / `DictCacheMisses` / `DictCacheRequestTimeNs`。
命中率 = Hits / Requests。

#### `system.query_log` —— 查询级溯源

```sql
SELECT query_start_time, query_duration_ms, query, user
FROM system.query_log
WHERE query LIKE '%dictGet%' AND event_date = today()
ORDER BY query_duration_ms DESC LIMIT 20;
```

定位：哪条业务 SQL 卡在字典上、哪个用户高频使用某字典。

### 2. 关键指标矩阵

| 指标 | 来源 | 健康 | 警戒 | 报警 |
|---|---|---|---|---|
| `status` | dictionaries | LOADED | LOADING > 1min | FAILED |
| `last_exception` | dictionaries | 空 | 非空但 LOADED | FAILED 且非空 |
| `loading_duration` | dictionaries | < LIFETIME.MIN × 0.3 | > × 0.5 | > LIFETIME.MIN |
| `bytes_allocated` | dictionaries | < 节点 5% | > 10% | > 20% |
| `element_count` | dictionaries | 与预期一致 | 突减 > 10% | 突减 > 30% |
| `found_rate`（cache）| dictionaries | > 95% | 80~95% | < 80% |
| `last_successful_update_time` | dictionaries | < LIFETIME × 2 | < × 5 | > × 10 |
| `MemoryDictionariesBytes` | async_metrics | < 节点 30% | > 50% | > 70% |
| `MemoryResident` | async_metrics | < max_mem × 70% | > 85% | > 95% |

容易忽视的：
- `found_rate < 80%`（cache）：回源风暴正在发生
- `loading_duration ≈ LIFETIME.MIN`：加载追不上刷新周期
- `element_count` 突降：源表被误删数据

### 3. 典型故障诊断剧本

#### 故障 1:`dictGet` 返回空 / 默认值

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

根因：FAILED / key 类型不匹配 / 分片字典 key 路由错 / LOADING 中。

#### 故障 2:节点 OOM

```sql
SELECT name, formatReadableSize(bytes_allocated) AS mem
FROM system.dictionaries ORDER BY bytes_allocated DESC LIMIT 10;

SELECT name, lifetime_min, lifetime_max,
       last_successful_update_time, loading_duration
FROM system.dictionaries ORDER BY last_successful_update_time DESC LIMIT 20;
```

根因：单字典过大 / 多字典刷新撞车 / 源表数据爆炸 / 查询 + 尖刺叠加。

临时处置：
```sql
SYSTEM DROP DICTIONARY CACHE;            -- 仅 cache 字典
DETACH DICTIONARY problematic_dict;
```

#### 故障 3:`cache` 回源风暴

```sql
SELECT name, found_rate, query_count
FROM system.dictionaries WHERE type LIKE '%Cache%'
ORDER BY query_count DESC;

SELECT name, miss_rate_time FROM system.dictionaries
WHERE type LIKE '%Cache%';
```

根因：大范围扫描查询 / cache 容量太小 / 没配 `ALLOW_READ_EXPIRED_KEYS` / 源库本身慢。

处置：
```sql
CREATE OR REPLACE DICTIONARY xxx ...
LAYOUT(CACHE(
    SIZE_IN_CELLS 5000000
    MAX_THREADS_FOR_UPDATES 8
    ALLOW_READ_EXPIRED_KEYS 1
));
```

#### 故障 4:数据陈旧

```sql
SELECT name, last_successful_update_time,
       now() - last_successful_update_time AS staleness,
       lifetime_max
FROM system.dictionaries WHERE name = 'users_dict';
```

根因：LIFETIME 周期未到 / 增量 `update_lag` 窗口外 / 源表 `update_field` 未更新 / 刷新失败 / 增量场景下的删除。

处置：`SYSTEM RELOAD DICTIONARY users_dict;`

#### 故障 5:启动后 P99 暴涨

```sql
SELECT name, status, loading_start_time, loading_duration
FROM system.dictionaries WHERE status = 'LOADING';

SELECT name, loading_duration FROM system.dictionaries
WHERE last_successful_update_time > now() - INTERVAL 1 MINUTE
ORDER BY loading_duration DESC;
```

根因：懒加载 + 首次查询触发同步加载。

处置：启动脚本预热 + 健康检查门控。

#### 故障 6:整点 MySQL CPU 飙满

```sql
SELECT name, lifetime_min, lifetime_max
FROM system.dictionaries WHERE lifetime_min = lifetime_max;
```

根因：多个字典 `LIFETIME` 固定值 → 整点同时全量 SELECT。

处置：改成 `LIFETIME(MIN X MAX Y)` 错峰 + 配 `update_field` 走增量 + `<max_concurrent_loads>` 限并发。

### 4. 报警规则模板

#### 必须立即报

```yaml
- alert: DictionaryFailed
  expr: clickhouse_dictionary_status{status="FAILED"} > 0
  for: 1m
  severity: critical

- alert: DictionaryMemoryHigh
  expr: |
    clickhouse_memory_dictionaries_bytes
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

#### 周期巡检（每日）

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

### 5. 调试小工具 SQL

#### 字典访问 Top N

```sql
SELECT
    extract(query, 'dictGet[a-zA-Z]*\\(''([^'']+)''') AS dict_name,
    count() AS calls,
    avg(query_duration_ms) AS avg_ms
FROM system.query_log
WHERE event_date >= today() - 1 AND query LIKE '%dictGet%'
GROUP BY dict_name ORDER BY calls DESC LIMIT 20;
```

#### 源表大小

```sql
SELECT table, sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS disk
FROM system.parts
WHERE active AND table = 'users_source'
GROUP BY table;
```

#### 集群副本一致性

```sql
SELECT hostName(), name, element_count, last_successful_update_time
FROM clusterAllReplicas('my_cluster', system.dictionaries)
WHERE name = 'users_dict';
```

副本间 `element_count` 差异大 → 副本刷新不同步。

#### 强制刷新观察耗时

```sql
SELECT now();
SYSTEM RELOAD DICTIONARY users_dict;
SELECT now(), loading_duration
FROM system.dictionaries WHERE name = 'users_dict';
```

### 6. 症状 → 根因 → 处置对照表

| 症状 | 最可能根因 | 一线处置 |
|---|---|---|
| `dictGet` 返回空/默认 | FAILED 或 key 不在 | 看 `last_exception`，检查 key 类型 |
| 节点 OOM | 多字典刷新尖刺叠加 | 错峰 `MIN/MAX` + `sparse_hashed` |
| MySQL CPU 飙满 | cache 回源风暴 / 同点刷新 | 限并发 + `ALLOW_READ_EXPIRED_KEYS` |
| 数据陈旧 | LIFETIME 未到 / 增量没拉到 | `SYSTEM RELOAD DICTIONARY` |
| 重启后 P99 暴涨 | 懒加载首次查询阻塞 | 启动脚本预热 + 健康检查门控 |
| 副本间结果不一致 | 副本刷新时差 | 接受时差或对齐刷新窗口 |
| 字典内存稳态翻倍 | 源表数据爆炸 | 看 `element_count` 历史，源侧治理 |

### 一句话

> **字典生产监控核心是 `system.dictionaries`，四个高价值字段：`status` / `last_exception` / `bytes_allocated` / `found_rate`。配齐「加载失败、内存超限、命中率暴降、刷新追不上周期」四类报警 + 每日巡检 SQL,90% 故障在变成事故前就被捕获。处置记住三招：`SYSTEM RELOAD DICTIONARY` 强刷新、错峰 `LIFETIME` 治尖刺、`ALLOW_READ_EXPIRED_KEYS` 治 cache 风暴。**

---

## 附录：速查表

### 字典选型一句话

| 需求 | 选择 |
|---|---|
| 通用维表 | `hashed` |
| 大维表省内存 | `sparse_hashed` |
| key 是密集整数 | `flat` |
| 复合 key | `complex_key_hashed` |
| 区间查找（年龄段、IP 段范围）| `range_hashed` |
| IP 段 | `ip_trie` |
| 地理多边形 | `polygon` |
| 亿级 + 有热点 | `cache` / `ssd_cache` |
| 每次现查 | `direct` |

### 必备 SQL

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

配套：
- 启动脚本预热关键字典
- 监控 `system.dictionaries.last_exception` 报警
- 每日凌晨低峰 `SYSTEM RELOAD` 全量，清理删除

### 内存预算口诀

> 单字典稳态 × 3 = 实际要预留的内存（含 2.5x 尖刺 + 余量）

### 必避的坑

1. `LIFETIME(300)` 而不是 `LIFETIME(MIN 300 MAX 360)` → 字典间叠加尖刺
2. 大字典懒加载 + 不预热 → 首次查询卡几分钟
3. 配了 `update_field` 但不做定期全量 → 删除残留
4. 分片字典假设 `dictGet` key 一定来自 sharding key，实际不严格满足 → 静默默认值

---

> 后续话题：LAYOUT 各类型的内部实现与选型细节、`dictGet` 函数族 + SQL 高级用法、生产监控与故障排查。
