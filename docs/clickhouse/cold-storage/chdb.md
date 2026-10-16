---
title: chDB + S3 Parquet：把冷数据变成可查询资产
---

# chDB + S3 Parquet：把冷数据变成可查询资产

维护 ClickHouse 集群时间一长，几乎一定会碰上这么几件事。

一是存储成本控制不住。MergeTree 表越积越大，NVMe SSD 的钱花得心疼，又不敢删。这两年大模型训练、推理井喷，HBM 挤占了 DRAM 产能，QLC、TLC 颗粒被 AI 数据集吃光，DRAM 和企业级 SSD 的价格被推高了好几倍，同样容量的本地存储比两年前贵了 2 到 4 倍，「硬件便宜，堆就是了」这个老想法已经不成立了。

二是冷查询拖累热查询。业务平时只查最近 7 天，偶尔有人查一年前的数据，IO 和内存一下就被吃干净。

三是集群越大越脆。节点越多、parts 越多，ZooKeeper 越累，扩容和升级都越来越难。

ClickHouse 官方给的办法是 S3 disk 加存储策略，把冷数据沉到 S3 上，存储成本是下来了。可这条路把 S3 拉进了 ClickHouse 运行时的关键路径，故障域跟着变大了。这篇讲的是另一条路：把冷数据从 ClickHouse 导出成标准的 Parquet 放到 S3，再由一个独立的 chDB 微服务负责查询。

整套架构长这样：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-01.light.svg" alt="整体架构：ClickHouse 导出 Parquet 到 S3，chDB 微服务独立查询">
<img class="dfig-d" src="/diagrams/chdb-01.dark.svg" alt="整体架构：ClickHouse 导出 Parquet 到 S3，chDB 微服务独立查询">
</figure>

## 为什么不用 S3 冷盘

S3 冷盘最大的卖点是无缝：给 ClickHouse 配一个 `<disk type="s3">`，加一条 TTL 自动下沉，业务完全无感。可问题恰恰出在这个无缝上。

把 S3 配成 ClickHouse 的 disk 以后，很多事情都建立在 S3 可用的前提上了。每个冷 part 的 metadata 都引用着 `s3://...` 路径；启动时要读 metadata、stat S3 对象、校验完整性；对冷分区做 `ALTER`，加列、改类型、改 TTL，要把元数据甚至数据拉回来；`ALTER UPDATE/DELETE` 打到冷分区，要重写 S3 上的 part；`Replicated*MergeTree` 的副本之间还要互相确认 part 在 S3 上的状态。S3 限速、区域故障、IAM 凭证过期、网络抖一下，任何一处出问题都会连锁反应：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-02.light.svg" alt="S3 冷盘的隐性耦合：S3 出问题后的连锁反应">
<img class="dfig-d" src="/diagrams/chdb-02.dark.svg" alt="S3 冷盘的隐性耦合：S3 出问题后的连锁反应">
</figure>

这算不上 ClickHouse 的 bug，把 S3 放进关键路径，就一定会这样。S3 不可达时 ClickHouse 起不来是什么样子，可以看 [S3 不可达时起不来：metadata 明明在本地，它却说 S3 上找不到](/clickhouse/troubleshooting/s3-unreachable-startup)。

同样的事情换成导出 Parquet 来做，ClickHouse 这边只剩每天一次 `INSERT INTO FUNCTION s3(...)`，跑完就断，不持有任何 S3 长连接；S3 上的 Parquet 和 ClickHouse 没有运行时的绑定；chDB 微服务是个独立进程，自己去读 S3，和 ClickHouse 谁也不知道谁。S3 出了问题，两种做法的影响范围是这样的：

| 方案 | S3 故障的爆炸半径 |
|---|---|
| S3 冷盘 | 冷查询失败 + 热查询变慢/失败 + ClickHouse 重启风险 + ZK 同步异常 |
| Export to Parquet | 仅冷查询失败 |

后者顶多是历史数据查不了，前者是整个数据库可能起不来，严重程度差了不止一个数量级。

### 顺手得到的几样好处

除了故障隔离，导出这条路还顺带解决了几件事。

格式是开放的。Parquet 是工业标准，DuckDB、Spark、Trino、Presto、Athena、pandas、polars 都能读，哪天 chDB 不合适了，换个引擎，数据不用动。S3 冷盘上的数据是 ClickHouse 的内部格式，离开 ClickHouse 就是一堆没人认识的二进制。

备份简单。冷数据本身就是冷备，要做灾备，`aws s3 sync` 到另一个 region 就行，不需要懂 ClickHouse 的内部结构。

schema 可以自由演进。每天的 Parquet 可以有不同的 schema，chDB 那边做兼容就行；S3 冷盘上的数据必须和当前表的 schema 一致。

成本能单独看清楚。S3 的存储和请求账单跟 ClickHouse 集群完全分开，财务上一眼就能看明白。S3 冷盘的 S3 IO 是后台 merge 触发的，账单和性能问题搅在一起，很难拆。

最容易被低估的一条，是存储成本不再被副本数放大，集群场景下尤其明显。`Replicated*MergeTree` 配 S3 冷盘时，每个 replica 都会往 S3 写自己的一份，3 副本集群的冷数据沉下去，S3 上就是 3 份，上 S3 省钱的初衷被副本系数抵掉一大半。社区曾经想用 `allow_remote_fs_zero_copy_replication` 解决，让多个 replica 共用 S3 上的同一份 part，可因为 part 引用计数、删除竞态、metadata 一致性一系列正确性问题，官方早就标成了实验性、不建议生产使用，这条路等于被堵死了。导出方案下，每个 shard 只往 S3 写一份（后面集群部署那一节会讲，每个 shard 选一个 replica 干活），S3 自己 11 个 9 的持久性顶替了 ClickHouse 的多副本，存储省下的就是副本因子那么多倍。

拿一个冷数据在 ClickHouse 里已经占了 50 TB（已经是 LZ4 压缩后的大小）的 3 副本集群算笔账：

| 维度 | S3 冷盘 | Export Parquet |
|---|---|---|
| 单份大小 | 50 TB（CK LZ4，跟本地盘一致） | ~30 TB（Parquet+ZSTD，比 CK LZ4 紧约 1.5-2×）|
| 副本数 | × 3 | × 1（S3 自有 11 个 9 持久性兜底） |
| S3 实际占用 | 150 TB | ~30 TB |
| S3 标准价 ~$0.023/GB·月 | ~$3,500/月 | ~$700/月 |
| 综合差距 | | ~5× |

大头是副本因子的 3 倍，再加上 Parquet 加 ZSTD 比 ClickHouse 默认的 LZ4 又多挤了一档，合起来是 4 到 6 倍。日志这种高重复的文本差距更大，后面实测那一节里，ClickHouse 内部 10 GB 的数据，导成 Parquet ZSTD 只有 4.5 GB，约 2.2 倍，再叠上 3 副本就是 7 倍左右。一年下来差好几万美元，再想想开头说的硬件涨了 2 到 4 倍，这部分省下的钱比少买一台 NVMe 服务器多得多。

### 要付出的代价

导出方案当然也有成本：

| 代价 | 严重程度 |
|---|---|
| 维护一个 export 脚本 / cron | 低，几十行 SQL + 验证 |
| 重叠期数据存两份 | 低，1 个月 ClickHouse 存储 |
| 跨冷热边界的查询要业务层拼接 | 中，但聚合查询通常不跨边界 |
| chDB 需要独立的查询微服务 | 低，本来就要做 |
| Schema 升级要同步考虑 chDB 端 | 低，Parquet 兼容性好 |

比起 S3 抖一下整个集群进 ICU，这点成本我觉得是值得的。能解耦的地方，我倾向于解耦。

## chDB 是什么

chDB 是 ClickHouse 的进程内嵌入式 OLAP 引擎，可以理解成 ClickHouse 界的 DuckDB 或者 SQLite。它把整个 ClickHouse 查询引擎打包成一个动态库，不用启动任何服务进程，在自己的应用里就能直接跑 ClickHouse SQL。它是 Auxten Wang 在 2023 年发起的，后来被 ClickHouse Inc. 收购，现在由官方维护。解析器、向量化执行引擎、函数库、存储格式都是 ClickHouse 原样的，所以 SQL 百分之百兼容。绑定有 Python、Go、Rust、Node.js、Bun、C/C++，其中 Python 支持得最好。

在这套架构里，它的位置是故意解耦出来的二级存储的读侧。它跟 ClickHouse 是平级的组件，不是 ClickHouse 的附属，边界很干净，将来要替换、扩容、迁移都容易。

它能做的事里，跟这套架构关系最大的是直接查 S3、HDFS、HTTP 上的 Parquet 或 ORC，不用建表，不用导入：

```python
import chdb
chdb.query("SELECT count() FROM 's3://bucket/path/*.parquet' WHERE x > 0", "Pretty")
```

另外它支持 70 多种数据格式，Parquet、ORC、CSV、JSON、Arrow、Avro、Protobuf 这些；`chdb.session.Session("/path")` 开一个持久化会话，相当于一个本地的 ClickHouse 实例；能直接把 Pandas、Polars、PyArrow 的 DataFrame 当表用 SQL 查，结果走 Arrow 零拷贝返回；ClickHouse 引擎层的设置也都继承下来了，限速、限内存、external spill 一个不少。

它做不到的事也得先知道。它没有官方的 Java binding，在 Java 为主的技术栈里，就只能作为一个微服务存在。它不是为高并发短查询设计的，单查询很强，但 QPS 上千的小查询场景，不如专门的内存引擎。它冷启动比 DuckDB 慢，动态库 500 MB 左右，第一次加载要几百毫秒到一秒，对 Lambda 不友好。`LIKE '%xxx%'` 这种子串过滤是 Parquet 和 ORC 共同的硬伤，下一节单独说。

资源上大概是这么个量级：

| 项 | 量级 |
|---|---|
| 动态库体积 | ~500 MB |
| 启动后 RSS | 100–300 MB |
| 冷启动 | 几百 ms 到 1 s |
| CPU 利用 | 多线程向量化，会吃满所有核 |
| 内存 | 大多数算子节制，GROUP BY 高基数 / JOIN 大表时需手动限制 |

跑 SQL 的计算全在 C++ 引擎里，Python 那边只是个遥控器。所以说 Python binding 的 chDB 慢，是个误解，只要查询够重，Python 那点边界开销根本看不出来。

## 单机 chDB 查 100G Parquet，能做到什么程度

我们的目标场景是单机 chDB，查 S3 上 100 GB 的 Parquet 或 ORC。

chDB 查 S3 上的 Parquet，数据要过三层漏斗：

<div class="sk sk-steps">
<div class="sk-box"><span class="sk-t">查询 SQL</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-cold"><span class="sk-n">1</span><span class="sk-t">S3 路径层</span><span class="sk-d">partition pruning</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">决定打开哪些文件</span></div>
<div class="sk-box is-warm"><span class="sk-n">2</span><span class="sk-t">文件层</span><span class="sk-d">file-level skip</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">决定读哪些 row group</span></div>
<div class="sk-box is-accent"><span class="sk-n">3</span><span class="sk-t">Row Group 层</span><span class="sk-d">statistics pruning：min/max + bloom</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">实际下载 + 解压 + 扫描</span></div>
<div class="sk-box is-ok"><span class="sk-t">内存中的列数据</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box"><span class="sk-t">向量化执行引擎</span></div>
<p class="sk-cap">三层都是「先判断要不要读」，真正下载发生在第三层之后</p>
</div>

每一层都是一种跳过数据的机制，哪一层失效了，下一层就得替它买单。所以数据存得对不对，决定了八成的查询性能，下一节专门讲。

引擎层能享受到的优化：

| 优化 | 效果 | 对 100G S3 的意义 |
|---|---|---|
| 列裁剪 (column pruning) | 只下载 SELECT 涉及的列 | 通常砍掉 80–95% IO |
| 谓词下推 (row-group skipping) | 用 Parquet footer 的 min/max 跳过整段 | 命中分区/范围条件时只读几个 GB |
| 多线程并行读取 | 文件级 + row-group 级并发 | 充分吃满 S3 带宽 |
| 向量化执行 | ClickHouse 原生引擎 | CPU 几乎不会成为瓶颈 |

真正的瓶颈是 S3 的出口带宽：同 region 的 EC2 大概 1 到 10 GB/s，本地走公网也就几十 MB/s。

### LIKE 是 Parquet 和 ORC 的硬伤

`LIKE 'prefix%'` 这种前缀匹配还好。Parquet 列的 min/max 统计对字符串按字典序算，前缀匹配能转成范围查询，能跳 row group，前提是数据有序。

`LIKE '%substring%'` 这种子串匹配就没救了。min/max 完全用不上，Parquet 的 BloomFilter 也只支持等值，结果就是这一列所有的 row group 都得从 S3 下载、解压、扫一遍。`multiSearchAny()`、`position()`、`hasToken()`、正则，道理都一样，没有索引可用。ORC 的 BloomFilter 同样只支持等值，还得建文件时显式打开。

按查询的频率，可以这么应对：

| 频率 | 建议 |
|---|---|
| 偶尔查一次 | 直接 chDB + S3，忍受全扫 |
| 反复查、前缀固定 | 改 `startsWith()`，写入时按该列排序 |
| 反复查子串 / 全文搜索 | Parquet 不合适，导入 chDB 的本地 MergeTree 并建 `tokenbf_v1` / `ngrambf_v1` / inverted index |
| 字段基数很低 | 提前 ETL 抽成独立列或数组，用等值 / `has()` |
| `LIKE '%xxx%' LIMIT N` 探查类查询 | 直接用，通常秒回，见下面 |

### LIKE '%xxx%' 加 LIMIT 为什么又能秒回

上面说的全扫，指的是聚合或者没有边界的扫描，`count()`、`GROUP BY`、`SELECT * WHERE ...` 这种必须看完所有数据才能出结果的查询。带 `LIMIT N` 的探查类查询是个例外：

```sql
SELECT * FROM s3('...50GB-file.parquet')
WHERE @message LIKE '%error%'
LIMIT 10;
-- 在 50 GB 单文件上常常 < 1s 返回，实际从 S3 拉下来的可能只有几十 MB
```

原因在 ClickHouse 和 chDB 的 pull 式向量化 pipeline：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-04.light.svg" alt="pull 式 pipeline：Limit 拿够 N 行后整条链短路">
<img class="dfig-d" src="/diagrams/chdb-04.dark.svg" alt="pull 式 pipeline：Limit 拿够 N 行后整条链短路">
</figure>

Limit 算子拿到 N 行以后，就不再往下游要数据了。Limit 不拉，Filter 就不拉，Decoder 就不解；S3 Reader 不再发新的 Range GET；后面的 row group 永远不会被下载，文件再大也不读。所以单个 50 GB 文件加子串 LIKE 加 `LIMIT 10` 能秒回，和 LIKE 要全扫并不矛盾，它们说的是两种不同形态的查询。

有几种情况会让短路失效或者打折扣。子串特别少见，命中率不到万分之一，就要扫很多 row group 才凑得够 N 条，接近全扫。`ORDER BY ... LIMIT N` 得先看完所有候选才能排序，LIMIT 推不下去。`OFFSET` 很大的时候，`LIMIT 10 OFFSET 100000` 仍然要先筛出 10 万条命中。还有 `max_threads > 1` 时的超读，多个线程同时扫多个 row group，Limit 喊停的时候已经有 row group 在路上了，实际下载的比理论值多一点，不过还是远小于全扫。

### 别让 chDB 把网关打爆

S3 和公司的出口网关都有带宽和 QPS 限制。ClickHouse 引擎层的限速设置，chDB 都能用：

```sql
SETTINGS
    max_remote_read_network_bandwidth = 52428800,  -- 单查询 50 MB/s
    s3_max_connections                = 8,          -- 并发连接数
    s3_max_get_rps                    = 200,        -- GET 请求速率
    s3_max_get_burst                  = 400,
    max_threads                       = 4,
    max_download_threads              = 4
```

Session 模式下用 `SET` 一次灌进去，会话里之后的查询都生效，算是 chDB 里的一个伪 profile：

```python
from chdb import session
s = session.Session()
for stmt in [
    "SET max_remote_read_network_bandwidth = 52428800",
    "SET s3_max_connections = 8",
    "SET max_threads = 4",
]:
    s.query(stmt)
```

要给整个进程封顶，用 `max_remote_read_network_bandwidth_for_server`，chDB 进程里所有查询加起来的带宽不会超过它，最合适不想把网关打爆的场景。不过在 ClickHouse 里它是服务端配置，作为查询级设置已经标成了废弃（`MAKE_DEPRECATED_BY_SERVER_CONFIG`），`SET` 了可能不生效。chDB 里用 `SET` 灌进去到底管不管用，上线前最好拿网卡流量实测一下。

## S3 上的数据怎么放

前面那三层漏斗能不能起作用，全看数据是怎么写进去的。路径怎么分区、单个文件多大、row group 多大、按什么排序，这四件事定下来，查询性能基本也就定了，后面再调引擎参数的空间很有限。

### S3 key 按 Hive 风格分区

```
s3://bucket/events/
  dt=2026-05-01/
    bucket=0/data.parquet
    bucket=1/data.parquet
    ...
  dt=2026-05-02/
    bucket=0/data.parquet
    ...
```

chDB 完整支持 Hive 风格的路径分区：

```sql
SET use_hive_partitioning = 1;

SELECT count() FROM s3('s3://bucket/events/**/*.parquet','AK','SK','Parquet')
WHERE dt = '2026-05-01' AND bucket = 5;
-- dt 和 bucket 被识别成虚拟列，chDB 根本不会去 list 其他分区的文件
```

分区列怎么选：

| 适合做分区 | 不适合做分区 |
|---|---|
| 时间（dt、hour），第一优选 | user_id / UUID，基数爆炸 |
| 地域 / 租户 / 业务线（基数 < 几百） | 任何文本字段的原值 |
| 数据来源（source、device_type） | 连续数值 |

经验上，分区目录总数别超过几万，不然 S3 的 LIST 自己就成了瓶颈。

#### 日志里的 IP 适合做分区吗

常有人问，日志场景下 IP 字段基数 1 到 5 万，能不能做分区？单看基数，好像就卡在阈值上，可跟时间一组合就炸了。

先看分区目录数的乘积：

| 配置 | 分区目录总数 | 状态 |
|---|---|---|
| 只 `ip=x.x.x.x/` | 5 万 | 卡在「几万」上限 |
| `dt=YYYYMMDD/ip=.../`，1 个月 | 30 × 5 万 = 150 万 | S3 LIST 超时 |
| `dt=.../ip=.../`，1 年 | 365 × 5 万 = 1825 万 | 灾难 |
| `dt=.../hour=HH/ip=.../`，1 月 | 30 × 24 × 5 万 = 3600 万 | 别想了 |

单一维度 5 万本身就在 S3 LIST 的性能拐点上了。`ListObjectsV2` 一页返回 1000 个 key，5 万个 IP 要翻 50 页，光 LIST 就得 20 到 30 秒。再和 dt 一组合，物理上就不可行了。

再看分布。日志里的 IP 通常严重倾斜：

```
头部 100 个 IP（CDN/网关/爬虫/大客户）  ──► 占 80% 流量
中部 1000 个 IP                          ──► 占 15%
尾部 4.9 万 IP（个人用户/扫描器）         ──► 占 5%
```

这是分区最糟糕的形态：头部的分区单个文件 1 到 10 GB，写一次要很久；尾部 4.9 万个分区每个只有 1 到 100 KB，典型的小文件问题，S3 GET 风暴。

查询模式通常也对不上：

| 典型查询 | IP 分区是否帮到忙 |
|---|---|
| 「查这个 IP 最近 7 天的所有日志」（安全追溯） | 能，命中 7 个分区 |
| 「Top 50 IP by traffic」 | 不能，必须扫所有 IP 分区 |
| 「某网段 10.0.0.0/24 的请求」（CIDR） | 不能，分区只支持等值/IN |
| 「异常 IP 列表关联请求」 | 不能，反向流，用不上分区 |

日志场景里按具体 IP 查的，一般只占一到两成，为这部分查询付出全局的存储代价，不划算。

我的建议是按 `dt` 分区，再按 `ip` 排序：

```sql
INSERT INTO FUNCTION s3('s3://.../dt={_partition_id}/data.parquet', ...)
PARTITION BY concat('dt=', toString(dt))
SELECT * FROM logs WHERE dt = '2026-05-27'
ORDER BY ip, event_time    -- ← 排序键, 不是分区列
SETTINGS output_format_parquet_row_group_size_bytes = 134217728;
```

套用前面的三层漏斗，效果是这样：

| 查询 | 用到的层 | 效率 |
|---|---|---|
| 特定 IP + 日期 | dt 路径裁剪 → row-group min/max skip | 跟分区一样快（1000:1 跳过）|
| Top IP | dt 路径裁剪 → 全文件扫 | 跟分区一样 |
| CIDR 范围查询 | dt 路径裁剪 → ip 排序后变成 row-group 范围裁剪 | 比分区还快，分区版根本做不到 CIDR |

分区只能做等值匹配，排序键能做等值、范围和前缀，所以 ip 做排序键比做分区用处更广。

如果统计下来按具体 IP 查的真占了一半以上，可以折中一下，加一个低基数的哈希桶：

```sql
PARTITION BY concat(
  'dt=', toString(dt),
  '/ipbucket=', toString(cityHash64(ip) % 16)    -- 16/32/64 桶
)
```

16 个桶乘 30 天，一个月 480 个分区，可控。查具体 IP 时 chDB 算一下哈希，只读一个桶；查 Top 还是要全扫，但按桶并行会更均匀。

最后归纳一下：

| 字段特征 | 该不该做分区列 |
|---|---|
| 基数 < 几十（地域、租户、event_type） | 可以直接分区 |
| 基数几百到几千（小数据源、设备型号） | 跟 dt 组合后看总数，超几万就不行 |
| 基数几千到几万 + 跟时间组合（IP、device_id）| 不行，改用排序键 |
| 基数 > 10 万（user_id、trace_id） | 必然爆炸，只能排序键 + bloom filter |
| 任何文本原值、连续数值 | 同上 |

### 单个文件多大合适

这点和 Hadoop、Spark 那个年代不一样。Hive 时代讲文件 128 MB 到 1 GB，依据是 HDFS 的 block size 加上 Spark 一个 task 读一个文件的并行模型。chDB、DuckDB、Trino 这些现代的 reader 都是在 row group 级别并行，文件大小不再决定读的并行度。所以上限可以放宽两个数量级，瓶颈从读不动变成了写和运维。

| 文件大小 | 状态 | 说明 |
|---|---|---|
| < 64 MB | 小文件问题 | S3 GET 固定开销（建连、SSL、HEAD）占比过大；LIST 慢 |
| 64–128 MB | 勉强可用 | 文件内只 0-1 个 row group，零文件内并行 |
| 128–256 MB | 可用下边界 | 1-2 个 row group |
| 256 MB – 几十 GB（推荐区间） | 甜区 | IO/并行/元数据三者平衡，读侧零顾虑 |
| 几十 GB – 100 GB | 可用但有代价 | 读侧仍 OK；写入 10-15 分钟、失败重试痛、footer 几 MB |
| 100 GB – 1 TB | 不推荐 | 写入小时级、Schema 修正代价大、footer 解析变慢（0.5-2s） |
| > 1 TB | 别这么干 | 工程上无意义，见下文协议上限 |

一天 50 GB 的数据，有两种合理的拆法。要兼容多个 reader，比如还要给 Trino、Spark 用，就拆 64 到 128 个文件，每个 400 到 800 MB；只有 chDB 一个 reader 的话，拆 8 到 16 个文件，每个 3 到 6 GB 也完全行。整天 50 GB 就一个文件，读起来其实也能用，只是写得慢，失败重试痛，下一节会讲。

简单记：目标文件数大约等于分区数据量除以目标文件大小，最少 1 个，最多几百个，目标文件大小在 256 MB 到 5 GB 之间都说得过去。

### 单个对象的上限

各家 S3 和 S3 兼容服务的单对象上限差别很大，但这是协议和服务策略层面的硬约束，跟上面说的甜区不是一回事，比工程上推荐的上限高得多：

| 服务 | 单对象上限 | 备注 |
|---|---|---|
| AWS S3 | 5 TiB (≈ 5.497 TB) | AWS 服务策略，文档明文 |
| Cloudflare R2 / Wasabi / GCS (S3 层) | 5 TiB | 镜像 AWS |
| Azure Blob (S3 兼容层) | ~4.75 TiB | 跟随 Azure block blob 限制 |
| Backblaze B2 (S3 兼容) | 10 TB | 略放宽 |
| 阿里云 OSS / 腾讯云 COS / 华为云 OBS | ~48.8 TiB | 放宽到 multipart 协议算术上限 |
| MinIO / Ceph RGW / SeaweedFS / rustfs 等自建 | 默认 5 TiB，可配置 | 看部署配置 |

真正算得上协议级硬约束的，只有 multipart upload 最多 10000 个 part 这一条，所有兼容实现都遵守，因为客户端 SDK 里写死了这个假设。单个 part 5 MiB 到 5 GiB，算下来上限约 48.8 TiB。AWS 在这之下又加了一道 5 TiB 的服务策略，国内几家云厂商没加。

```
协议硬上限         5 TiB - 48 TiB ────── 各家服务策略
不推荐区             > 100 GB ────────── 写小时级、retry 痛、footer 解析慢
甜区上界             ~ 几十 GB ────────── chDB / DuckDB 时代的拓宽
甜区下界             ~ 256 MB  ────────── 保证 2+ row group, 避免 S3 GET 开销
```

工程上有意义的范围，比协议上限低两到四个数量级。S3 允许 5 TiB，不代表你就该这么用。

### row group 和排序，最关键的一层

row group 是 Parquet 里最小的 IO 和裁剪单元，chDB 读 Parquet 时按 row group 并行。推荐 128 MB 一个，这也是多数引擎的默认值。太大，超过 512 MB，min/max 的过滤粒度就粗了，跳不掉数据；太小，低于 32 MB，元数据会膨胀。

Parquet 的 min/max 统计是每个 row group 算一个范围。**数据要是乱序写进去的，每个 row group 的范围都横跨全表，等于没有索引。**

举个例子，100 GB 数据，`user_id` 基数 1000 万。乱序写入的话，每个 row group 的 `user_id` 范围都是 `[1, 10000000]`，查 `user_id = 12345` 只能扫全部 row group。按 `user_id` 排好序再写，每个 row group 是一段紧凑的区间，`[12000, 13000]`、`[13000, 14000]`……，只命中一个 row group，裁剪比 1000:1。

排序键这么选：第一排序键用最常拿来做等值或范围过滤的列，比如 user_id、device_id、event_type；第二排序键用次常用的，通常是时间戳；第三个基本没意义了，min/max 只对前缀有效。经常用 `LIKE 'Apple%'` 做前缀匹配的话，就把那个字符串列设成排序键。

Parquet 和 ORC 里真正能当索引用的东西：

| 机制 | Parquet | ORC | chDB 利用 | 对什么有效 |
|---|---|---|---|---|
| min/max 统计 | 默认开 | 默认开 | row group skip | 范围、等值、前缀 LIKE（数据有序前提下）|
| Dictionary encoding | 自动 | 自动 | 谓词下推到字典 | 低基数列的等值 |
| Bloom filter | 写入时生成 | 需写入时开 | 支持读取 | 仅等值 |
| Page Index | 较新版本 | 无 | 部分支持 | row group 内更细粒度的 min/max |
| 倒排索引 / N-gram | 无 | 无 | 无 | LIKE '%xxx%' 没救 |
| 位图索引 | 无 | 无 | 无 | 无 |

bloom filter 适合的是基数高、常做等值查询、又没法当主排序键的列，典型的就是 trace_id。已经按某一列排过序了，再给它建 bloom 就多余了。

### 压缩怎么选

| 压缩 | 比例 | 解压速度 | 适用 |
|---|---|---|---|
| ZSTD（level 3） | 高 | 快 | 推荐默认 |
| ZSTD（level 6+） | 更高 | 略慢 | 冷数据、压缩比敏感 |
| Snappy | 中 | 很快 | 老栈兼容 |
| LZ4 | 低 | 最快 | 本地盘、CPU 紧张 |
| Gzip | 高 | 慢 | 不推荐 |

S3 场景下网络是瓶颈，压缩比直接换成少传的字节，所以 ZSTD 几乎总是最好的选择。

### 常见的错误做法

| 反模式 | 后果 |
|---|---|
| 一个分区一个 100 GB+ 巨型文件 | 写入慢（小时级）+ 失败重试代价大 + Schema 修正影响面广；读侧 row-group 级并行其实仍可，但日导出超 100 GB 建议再加一层哈希桶拆分 |
| 一个分区 10 万个 1MB 小文件 | LIST/GET 风暴 |
| 按 `user_id` 做分区 | 几千万个分区，LIST 自己就超时 |
| `dt/hour/region/source/type` 五层嵌套 | 分区目录爆炸 |
| 写入时不排序 | row group min/max 等于全表范围 |
| 用 Gzip | 解压慢，没换来更好压缩比 |
| 关掉 statistics（某些 Spark 配置默认关） | row-group skip 完全失效 |

写完可以这么自查：

```bash
parquet-tools meta s3://bucket/events/dt=2026-05-01/bucket=0/data.parquet | head -50
# 看 row group 数量、每个 row group 的 statistics(min/max) 是否存在
```

## 从 ClickHouse 直接写 Parquet 到 S3

数据本来就在 ClickHouse 里，这是最常见的情况，直接用 `s3()` 表函数加 INSERT 写到 S3 就行。只是默认行为跟上一节说的理想布局差得有点远，有几个旋钮得自己拧。

### 为什么不走 Spark 中转

很多团队的第一反应是：我有 Spark 集群，让 Spark 从 ClickHouse 读出来再写 S3。可数据已经在 ClickHouse 里、只是归档成 Parquet 放 S3 的话，ClickHouse 直接写几乎处处都更好：

| 维度 | CK 直写 | Spark / 调度器中转 |
|---|---|---|
| 数据跳数 | 1 跳（CK→S3） | 2-3 跳（CK→Spark→S3） |
| 调度机 / Spark 带宽 | 0 | 等于全量数据 |
| 中间组件 | cron + 几十行 Python | 一套 Spark 集群 |
| 类型保真 | CK 原生输出 | 中间环节可能丢精度（DateTime64 / Decimal） |
| 排序保留 | `ORDER BY` 直接生效 | 要重排 |
| 失败排查链路 | 一段 | 三段 |
| 集群伸缩性 | 见下文「集群部署」 | initiator 漏斗效应 |

Spark、Flink 真正合适的场景，放在这一节最后说。

### s3() 表函数还是 S3 表引擎

两个底层是同一套 S3 读写代码，区别只在暴露的方式：

| 维度 | `s3()` 表函数 | `S3` 表引擎 |
|---|---|---|
| 形态 | 匿名，单条 SQL 里临时构造 | 持久化对象，`CREATE TABLE ... ENGINE = S3(...)` |
| Schema | 每次查询动态推断或显式指定 | 建表时固化 |
| 凭证 | 内联或 named collection 引用 | 建表时绑定 |
| INSERT | `INSERT INTO FUNCTION s3(...) SELECT` | `INSERT INTO s3_table SELECT` |
| 进 `system.tables` | 否 | 是 |
| 适合场景 | 一次性 ETL、cron 导出 | 反复读写的外部表入口 |

性能、并行度、能调的设置完全一样，差的只是用起来顺不顺手。cron 导出用不着建持久的表对象，所以下面都拿 `s3()` 表函数举例。

### 默认会写出一个巨型文件

最简单的写法：

```sql
INSERT INTO FUNCTION s3(
    'https://bucket.s3.us-east-1.amazonaws.com/events/dt=2026-05-01/data.parquet',
    'AK','SK','Parquet'
)
SELECT * FROM events WHERE dt = '2026-05-01';
```

这一句会把 50 GB 数据全塞进一个文件。读其实完全没问题，Parquet 里按 row group 的 Range GET、列裁剪、LIMIT 短路都不受影响。麻烦在写和运维上。写入吞吐受限于单个输出流，50 GB 一个文件大概要 10 到 15 分钟，用 `PARTITION BY` 拆成 64 个桶并行，能压到 3 到 5 分钟。失败了要整个文件重来，写到 80% 网络断了，50 GB 全部作废重导，拆了桶只需要重导失败的那个 800 MB 左右。按 bucket 哈希拆开，还顺带有了 `WHERE bucket = N` 这种取子集的能力。Trino、Spark 这些多 reader 协同的引擎靠文件级并行，单个巨型文件到了它们手里并行度上不去，chDB 单 reader 倒是不受影响。

要不要拆，看场景：

| 场景 | 建议 |
|---|---|
| 日导出 < 10 GB、单 chDB reader、写入稳定 | 不需要拆，整天一个文件就够 |
| 日导出 50-100 GB、在意导出耗时 | 拆 8-64 桶 |
| 写入网络不稳，需要部分重试 | 拆 64-128 桶 |
| 要给 Trino / Spark / Athena 协同消费 | 必须拆到 256 MB - 2 GB / 文件 |
| 日导出 > 200 GB | 必须拆，控制单文件 < 50 GB |

一天 50 GB、要并行写、还要给外部引擎用的典型场景，带 bucket 拆分的写法是这样：

```sql
INSERT INTO FUNCTION s3(
    'https://bucket.s3.us-east-1.amazonaws.com/events/{_partition_id}/data.parquet',
    'AK','SK','Parquet'
)
PARTITION BY concat(
    'dt=', toString(dt),
    '/bucket=', toString(cityHash64(user_id) % 64)
)
SELECT * FROM events
WHERE dt BETWEEN '2026-05-01' AND '2026-05-07';
```

写出来是：

```
s3://bucket/events/
  dt=2026-05-01/bucket=0/data.parquet   ~ 800 MB
  dt=2026-05-01/bucket=1/data.parquet
  ...
  dt=2026-05-01/bucket=63/data.parquet
```

`PARTITION BY` 表达式拼出来的字符串就是 `{_partition_id}`；`cityHash64(user_id) % 64` 把每天的数据均匀拆成 64 份；桶数大约是每天的数据量除以目标文件大小，一天 50G 就是 64 到 128 个桶。路径必须是 Hive 风格的 `key=value`，不然 `use_hive_partitioning` 认不出来。

### row group 大小要显式设

ClickHouse 写 Parquet 默认的 row group 是未压缩 512 MB 或者 100 万行，也就是 `output_format_parquet_row_group_size_bytes = 536870912`、`output_format_parquet_row_group_size = 1000000`，哪个先到按哪个切。

| 数据行宽 | 谁先触发 | 默认 row group 实际表现 |
|---|---|---|
| 宽行（日志、长字符串）| 512 MB 字节限制 | 几十万行 / RG，压缩后 ~100-150 MB on-disk，勉强 OK |
| 中等行（混合类型） | 看情况 | 行数和字节都接近触发，~100-300 MB on-disk |
| 窄行（埋点、纯数值） | 100 万行限制 | 未压缩才几十 MB，压缩后 ~5-20 MB，太小，元数据膨胀 |

注意这个 512 MB 是未压缩的字节数。ZSTD 有 3 到 5 倍的压缩比，宽行场景下写出来的 row group 正好落在甜区，纯属碰巧，换成窄行就翻车了。

我建议显式设成 128 MB：

```sql
SETTINGS
    output_format_parquet_row_group_size_bytes = 134217728,  -- 128 MB（未压缩）
    output_format_parquet_row_group_size       = 1000000,    -- 100 万行兜底
    output_format_parquet_compression_method   = 'zstd',
    output_format_parquet_compression_level    = 3,
    output_format_parquet_use_custom_encoder   = 1,
    output_format_parquet_string_as_string     = 1,
    output_format_parquet_write_page_index     = 1
```

128 MB 是 Hadoop、Spark 生态的事实标准，`parquet.block.size` 的默认值就是它，Spark、Trino、Presto、chDB、DuckDB 这些读的一方大多按这个假设调优。它比 ClickHouse 默认的 512 MB 细了 4 倍，min/max 的过滤粒度更高，对范围和前缀过滤更友好。不显式设，写出来的文件统计粒度就粗了，尤其是拿 chDB 回头读自己写的 Parquet，谓词下推的效果要打折扣。

写完跑一下自查：

```bash
python -c "
import pyarrow.parquet as pq
m = pq.ParquetFile('your.parquet').metadata
for i in range(min(3, m.num_row_groups)):
    rg = m.row_group(i)
    print(f'rg{i}: rows={rg.num_rows}, uncompressed={rg.total_byte_size/2**20:.1f}MB')
print(f'total rgs={m.num_row_groups}')
"
```

看到 `uncompressed≈128MB` 就对了。要是看到 `rows=1000000`，字节数却远小于 128 MB，说明是行数限制先到了，得把 `output_format_parquet_row_group_size` 调大，让字节限制起作用。

`output_format_parquet_string_as_string = 1` 也顺手写上。较早的版本里它默认是关的，ClickHouse 会把 String 写成 Parquet 的 BINARY 类型，DuckDB、Spark、pandas 读出来是 bytes 而不是 str；现在的版本默认已经是开的了，显式写上，换个版本也不会出岔子。

### 排序：ClickHouse 天然的优势，但得主动用

MergeTree 里的数据本来就按 `ORDER BY` 键有序存放，这是外部 ETL 工具没有的优势。可 SELECT 并行读会把顺序打乱，要保证输出有序，得显式 ORDER BY：

```sql
INSERT INTO FUNCTION s3(...) ...
SELECT * FROM events
WHERE dt BETWEEN '2026-05-01' AND '2026-05-07'
ORDER BY user_id, event_time
SETTINGS
    max_threads = 4,
    max_insert_threads = 4
```

`max_threads` 别拉得太高，留一点有序性。

### bloom filter

写 Parquet 时的 bloom filter 开关是 `output_format_parquet_write_bloom_filter`，读的时候用不用它做过滤，看的是 `input_format_parquet_bloom_filter_push_down`。新版本这两个默认都是开的，老一点的版本可能还没有写的这个开关，用之前先查一下：

```sql
SELECT name, value FROM system.settings WHERE name LIKE '%parquet%bloom%';
```

已经按主过滤列排好序的话，bloom 的作用就不大了，它真正派上用场的是那些没法当主排序键、又经常做等值查询的列。

### 完整的导出模板

```sql
INSERT INTO FUNCTION s3(
    'https://bucket.s3.us-east-1.amazonaws.com/events/{_partition_id}/data.parquet',
    'AK','SK','Parquet'
)
PARTITION BY concat(
    'dt=', toString(dt),
    '/bucket=', toString(cityHash64(user_id) % 64)
)
SELECT
    dt,
    user_id,
    event_time,
    event_type
    -- ...
FROM events
WHERE dt BETWEEN '2026-05-01' AND '2026-05-07'
ORDER BY user_id, event_time
SETTINGS
    output_format_parquet_row_group_size_bytes = 134217728,
    output_format_parquet_row_group_size       = 1000000,
    output_format_parquet_compression_method   = 'zstd',
    output_format_parquet_compression_level    = 3,
    output_format_parquet_use_custom_encoder   = 1,
    output_format_parquet_string_as_string     = 1,
    output_format_parquet_write_page_index     = 1,
    max_threads        = 4,
    max_insert_threads = 4,
    s3_truncate_on_insert = 0,
    s3_create_new_file_on_insert = 1;
```

写完以后验证三样：

```bash
# 1. 看文件数和大小
aws s3 ls s3://bucket/events/dt=2026-05-01/ --recursive --human-readable --summarize

# 2. 看单文件元数据
parquet-tools meta s3://bucket/events/dt=2026-05-01/bucket=0/data.parquet

# 3. 用 chDB 跑一次 EXPLAIN 看 row group skip 数量
```

### 集群上每个 shard 各自写，别走分布式表

单机上的直觉，放到集群上会出大事。最容易犯的错，是在 initiator 节点上对分布式表导出：

```sql
-- 别这么写
INSERT INTO FUNCTION s3('s3://.../data.parquet', ...)
SELECT * FROM dist_app_logs   -- 分布式表
WHERE dt = '2026-05-25';
```

数据是这么流的：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-05.light.svg" alt="走分布式表导出时，所有 shard 的数据先汇到 initiator 再写 S3">
<img class="dfig-d" src="/diagrams/chdb-05.dark.svg" alt="走分布式表导出时，所有 shard 的数据先汇到 initiator 再写 S3">
</figure>

所有 shard 的数据都先流到 initiator 再出去，initiator 一个节点扛 N 倍的带宽。`SELECT * FROM dist_table` 在 OLAP 查询里很自然，结果集小，汇总起来便宜；可导出时结果集就是整个数据集，汇总的代价就爆了。一天 50 GB 还扛得住，一天 500 GB 就跪了。

正确的做法是查本地表，每个 shard 各写各的，路径里带上 `{shard}` 宏。每个节点 `config.xml` 的 `<macros>` 里定义了 `{shard}`、`{replica}`、`{cluster}`，服务端会自动替换：

```sql
INSERT INTO FUNCTION s3(
    's3://endpoint/bucket/cluster_a/mydb/app_logs/dt={date}/shard={shard}/data.parquet',
    'AK', 'SK', 'Parquet'
)
SELECT * FROM local_app_logs    -- ← 本地表, 不是 dist_app_logs
WHERE dt = '{date}'
ORDER BY user_id, event_time
SETTINGS
    output_format_parquet_row_group_size_bytes = 134217728,
    output_format_parquet_string_as_string     = 1,
    s3_create_new_file_on_insert              = 1
```

调度脚本给每个 shard 各发一次，每个 shard 只挑一个 replica 去执行，免得写两遍：

```python
import clickhouse_connect

seed = clickhouse_connect.get_client(host='ck-any.example.com')
shards = seed.query("""
    SELECT host_address FROM system.clusters
    WHERE cluster = 'cluster_a' AND replica_num = 1
""").result_rows

for (host,) in shards:
    clickhouse_connect.get_client(host=host).command(SQL_TEMPLATE)
```

写出来的路径：

```
s3://endpoint/bucket/cluster_a/mydb/app_logs/dt=20260525/shard=1/data.parquet
                                                          shard=2/data.parquet
                                                          shard=3/data.parquet
                                                          shard=4/data.parquet
```

chDB 读的时候用 `s3('.../shard=*/data.parquet')` 通配，或者靠 Hive 分区裁剪（路径里带了 `shard=N/`），自然就把所有 shard 的数据合起来了，业务查询完全感觉不到。

三种做法放一起比：

| 方案 | 数据流向 | Initiator 带宽 | 总跨网传输 |
|---|---|---|---|
| Spark + 分布式表 | shard→initiator→spark→s3 | 3× 单 shard | 3 倍 |
| CK 直写 + 分布式表（错） | shard→initiator→s3 | 2× 单 shard | 2 倍 |
| CK 直写 + 本地表 + `{shard}` | shard→s3（各自） | 0 | 1 倍 |

能伸缩，靠的是不汇总，跟引擎牛不牛没关系。这个做法一天 100 GB 能用，一天 PB 级也能用。

### INSERT...SELECT 在服务端执行，调度机没有流量

常有人担心：调度器在另一台机器上，给 shard 发 INSERT，数据会不会从我这台机器过一道？不会。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-06.light.svg" alt="INSERT...SELECT 在服务端执行，数据从 ClickHouse 直接流向 S3，调度机只收发 SQL 和状态">
<img class="dfig-d" src="/diagrams/chdb-06.dark.svg" alt="INSERT...SELECT 在服务端执行，数据从 ClickHouse 直接流向 S3，调度机只收发 SQL 和状态">
</figure>

50 GB 数据在 ClickHouse 服务端直接流向 S3，经过调度机的只有 SQL 文本和状态码，带宽消耗约等于零。关键看数据最终流到哪：

| 查询形态 | 数据流向 | 客户端流量 |
|---|---|---|
| `SELECT * FROM t` | server → client | 有（即便不读 rows，TCP/driver buffer 那部分也会过来）|
| `INSERT INTO FUNCTION s3() SELECT *` | server → S3 | 真的为零 |
| `SELECT count() FROM t` | 服务端聚合 | ~0（只回 1 行）|
| `SELECT ... LIMIT 0` | 不读数据 | ~0（只回 schema）|

`INSERT INTO FUNCTION s3()` 的数据终点在服务端，客户端根本不是接收方。`SELECT *` 就不一样了，客户端是终点，必须接数据，哪怕你不去读，TCP 背压把它拦住之前，也已经有几 MB 进了 driver 的缓冲区。

调度脚本有几点要注意。client 的 `send_receive_timeout` 要调大，导 50 GB 大约 5 到 15 分钟，导 200 GB 接近一小时。失败了用 `KILL QUERY WHERE query_id = '...'` 主动取消，别指望 client 断开就能取消，断开不一定会马上终止服务端的查询。监控要看 shard 上的 `system.query_log`（`written_bytes`、`written_rows`）和 `system.events`（`WriteBufferFromS3Bytes`、`S3WriteRequestsCount`），不是看调度机本地。导出期间调度机的网络监控上应该几乎没有流量，这是验证数据没有绕路最直接的证据。

### 什么时候不该用 ClickHouse 直写

ClickHouse 写 Parquet 已经够用了，但有几种场景外部工具更合适：

| 场景 | 用哪个 |
|---|---|
| 数据已经在 CH 里，定期增量导出 | ClickHouse 直写 + cron |
| 需要复杂转换（schema 变换、字段拆解、UDF） | Spark / Flink |
| 需要逐列细粒度 bloom filter 控制 | Spark |
| 原始数据在 Kafka/MySQL，不经过 CH | Flink / Spark 直接源到 S3 |
| 需要 Iceberg / Delta Lake / Hudi | 必须 Spark/Flink |

## 冷热数据的生命周期

### 时间窗口

我们的做法是 ClickHouse 里保留 4 个月，3 个月前的数据导出，中间留 1 个月重叠：

```
时间线:                                       现在
    ──┬───────────────┬───────────┬───────────┬─►
      T-4月            T-3月       T-1月       T

ClickHouse:  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (保留 4 个月)
S3 Parquet:  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                (T-3 月以前全量)
             ↑                       ↑
             冗余重叠区 (T-4 ~ T-3)   分界线
```

这 1 个月重叠，主要用处是留出纠错的时间。发现 S3 上的数据有问题，schema 错了、字段截断了、时区错了，还能从 ClickHouse 重新导一次；chDB 查 S3 和 ClickHouse 查出来对不上，有个标准答案可以比；临时把 chDB 查询服务关掉，最近一个月的数据还能从 ClickHouse 查。

### 导出成功的标准是验证通过

很多人的脚本是这么写的：

```python
ch.execute("INSERT INTO FUNCTION s3(...) ...")    # 没报错就当成功
ch.execute("ALTER TABLE events DROP PARTITION ...")
```

这是在给自己埋雷。Parquet 写成功了，可行数对不上、schema 错位、压缩出了问题，SQL 都不会报错。

最起码要做这些验证：

```python
def export_partition(dt):
    # 1) 导出
    ch.execute(f"INSERT INTO FUNCTION s3(...) ... WHERE dt = '{dt}' ...")

    # 2) 行数对账
    src_cnt = ch.execute(f"SELECT count() FROM events WHERE dt='{dt}'").fetchone()[0]
    dst_cnt = chdb.query(f"SELECT count() FROM s3('...dt={dt}/**/*.parquet',...)").fetchone()[0]
    assert src_cnt == dst_cnt, f"row count mismatch: {src_cnt} vs {dst_cnt}"

    # 3) 抽样校验：几个聚合值
    for sql in CHECK_QUERIES:
        a = ch.execute(sql.format(src='events', dt=dt)).fetchone()
        b = chdb.query(sql.format(src=f"s3('...dt={dt}/**/*.parquet',...)", dt=dt)).fetchone()
        assert a == b, f"check mismatch on {sql}"

    # 4) 通过后才回填标记
    ch.execute(f"""
        ALTER TABLE events
        UPDATE exported_at = now()
        WHERE dt = '{dt}' AND exported_at IS NULL
    """)
```

这一步比多留一个月冗余重要得多。没验证过的冗余，你也说不清它到底是好是坏。

导出、校验、回填，整个闭环画出来是这样：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-07.light.svg" alt="导出、校验、回填 exported_at 的闭环">
<img class="dfig-d" src="/diagrams/chdb-07.dark.svg" alt="导出、校验、回填 exported_at 的闭环">
</figure>

### 用带 WHERE 的 TTL 自动清理

TTL 是 ClickHouse 自带的删除机制，比 cron 省心。可单纯的 TTL 有个隐患，它只按时间触发，不知道你的导出成没成功。

假设导出脚本因为 IAM key 过期失败了 45 天，没人发现，TTL 却每天照常删 4 个月前的数据。等你发现的时候，已经有 45 天的数据既没进 S3，又被 ClickHouse 删掉了。

办法是给表加一个 `exported_at` 字段，TTL 表达式带上 `WHERE`：

```sql
ALTER TABLE events ADD COLUMN exported_at Nullable(DateTime) DEFAULT NULL;

ALTER TABLE events MODIFY TTL
    event_time + INTERVAL 4 MONTH DELETE WHERE exported_at IS NOT NULL;
```

验证过的分区，到 4 个月自动删掉，不用人管。没验证、没导出的分区留着不删，**ClickHouse 的存储一直往上涨，本身就是导出出了问题的告警**。cron 定时 detach、drop 那一套也都省了。整个生命周期管理就剩两样东西：一次性配好的 TTL，和一个自带验证、会回填 `exported_at` 的导出脚本。

### 迟到的数据

有了 `exported_at`，迟到的数据也有了着落。5 月 3 号来了一批 2 月份的迟到数据，INSERT 进来时 `exported_at` 是 NULL；TTL 看到 `exported_at IS NULL`，不会删；下次导出脚本扫到这些已经过期但还没导出的行，单独追加导一次到 S3，回填 `exported_at`；TTL 下次再扫到，就清掉了。

哪里漏了，都会表现成 ClickHouse 里的数据超期没删，看得见，不会悄无声息地丢。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-08.light.svg" alt="迟到数据：exported_at 为空时 TTL 不删，补导后回填再清理">
<img class="dfig-d" src="/diagrams/chdb-08.dark.svg" alt="迟到数据：exported_at 为空时 TTL 不删，补导后回填再清理">
</figure>

### 查询按时间路由

| 数据时段 | 路由到 | 原因 |
|---|---|---|
| T-4 月之内 | ClickHouse | 在本地，更快 |
| T-4 月 ~ T-3 月（重叠区） | ClickHouse | 两边都有，CH 快 |
| T-3 月以前 | chDB → S3 | 只 S3 有 |
| 跨越分界线（比如最近半年） | 业务层拼接：CH + chDB 各查一半然后 UNION | |

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-09.light.svg" alt="按时间路由：近期查 ClickHouse，更早的查 chDB，跨界的业务层拼接">
<img class="dfig-d" src="/diagrams/chdb-09.dark.svg" alt="按时间路由：近期查 ClickHouse，更早的查 chDB，跨界的业务层拼接">
</figure>

别在线上服务里对重叠区做双查对账，那是 cron 验证脚本该干的活，不该让用户的查询来背。

## 把 chDB 包成微服务

chDB 没有官方的 Java binding，在 Java 为主的技术栈里，它只能作为一个独立的微服务存在。

### 先想清楚谁会用、怎么用

动手之前，先把使用画像想清楚，很多设计取舍都是它决定的，也免得照着高吞吐分析平台那套模板过度设计。

冷数据归档以后，真实的访问是这样的：

| 场景 | 频率 | 查询特征 | 结果规模 |
|---|---|---|---|
| 审计（合规扫描特定记录） | 几次/月 | 等值过滤 user_id / order_id / IP | 几十~几千行 |
| 抽查（业务对账） | 几次/周 | 时间范围 + 维度过滤 | 几百~几千行 |
| 历史问题排障 | 几次/季度 | 自由 SQL，偶尔复杂 | 几行~几万行 |
| 报表回填 / 一次性分析 | 不规律 | 聚合后输出 | 已聚合到几百行 |

持续的批量分析、ML 特征训练、高 QPS 的在线服务、多人并发的交互式 BI、把百万行结果拉到 Java 或 Python 那边再加工，这些基本不会出现。真出现了，先问问自己，数据还在 ClickHouse 热表里的时候为什么不做。反过来，如果发现某些查询老是打到 chDB 和 S3 上，说明这份数据其实没那么冷，应该 ETL 出来做一张独立的热表，或者干脆别沉下去。

这个画像决定了后面所有设计的真实动机：

| 设计点 | 看似的理由 | 真实动机 |
|---|---|---|
| 限并发 / 限带宽 / 限内存 | 保护 S3、支撑高吞吐 | 防一个审计人员的坏 SQL 把进程吃满 |
| `query_id` + 主动 cancel | 节省资源 | 人会关页面、改主意、写错 SQL |
| OOM 防护四层 | 应对高负载 | 手工 SQL 写坏是常态，进程不能崩 |
| FastAPI 单进程 + systemd | 微服务范式 | QPS 个位数甚至小数，单进程绰绰有余 |
| 用 JSON，不引入 Arrow | 性能权衡 | 结果几乎都 ≤ 1 万行 + LIMIT，Java 多半透传给 FE |

说白了，这是一个给少数人随手查的归档入口，不是什么高并发分析平台。后面那些限制和防御，都是为了别让一条坏 SQL 把这个入口干趴下。

### 分机部署，走 HTTP

<div class="sk sk-steps">
<div class="sk-box is-cold"><span class="sk-t">Java 业务节点</span><span class="sk-d">IO / 编排型，普通配置</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">HTTP</span></div>
<div class="sk-box is-accent"><span class="sk-t">chDB 节点</span><span class="sk-d">CPU + 内存 + 网卡密集型，配置明显更高</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box"><span class="sk-t">S3</span></div>
<p class="sk-cap">两类节点的资源画像完全不同，混布会让其中一方长期闲置</p>
</div>

Java 这边和 chDB 这边要的资源完全不一样，分开部署是必然的。跨机通信用 HTTP 最省事，运维成熟，调试也方便。

### 限并发、限带宽、限内存

QPS 极低，可单个坏查询就能把进程拖垮。审计人员手写一句 `SELECT * FROM big_table WHERE name LIKE '%x%'`，服务得扛住，还不能殃及别的请求。

很多人第一反应是同一时刻只跑一条 SQL。保护是够彻底，可太重了，一条慢查询就把所有人堵死，chDB 的 CPU 和内存也白白浪费。我更推荐这样：

```python
# 应用层：限并发
from anyio import Semaphore
sem = Semaphore(4)   # 同时最多 4 条 SQL

@app.post("/query")
async def query(sql: str):
    async with sem:
        return run_query(sql)
```

```sql
-- chDB 层：限带宽 + 限内存
SET max_remote_read_network_bandwidth_for_server = 83886080  -- 80 MB/s 进程级硬顶
SET s3_max_get_rps = 200                                     -- 请求速率护栏
SET max_server_memory_usage = 25769803776                    -- 24 GB 进程级硬顶
SET max_memory_usage = 8589934592                            -- 8 GB 单查询硬顶
SET max_bytes_before_external_group_by = 4294967296          -- 4 GB 后 spill
SET max_bytes_before_external_sort = 4294967296
```

并发数 N 的经验公式是 `min(物理核数 / max_threads, 4)`，32 核的机器、`max_threads=8`，N 取 3 到 4。只有两种情况才需要严格串行：查询都是 30 分钟级的离线分析，并发了也没人等得起；或者 S3 网关有硬性的 QPS 配额，必须卡死。

### 结果用 JSON 传

照上面的使用画像，结果传输的取舍很简单。结果集本来就小，生产上的 SQL 几乎都带 `LIMIT 1000` 或 `LIMIT 10000`，再大就该改写成在 chDB 里聚合。Java 只是个中转站，加上鉴权和路由，原样转给前端，不读字段值做计算。前端是浏览器，必然要 JSON。

这三个条件下，JSON 是唯一合理的选择。chDB 序列化一次，Java 当字节流透传，前端反序列化一次，全程两步。中间换成别的格式，比如 Arrow，Java 那边就得先解码再编码成 JSON，纯属浪费 CPU。

```python
from fastapi import FastAPI, Response
from chdb import session

app = FastAPI()
s = session.Session("/data/chdb")

@app.post("/query")
def query(sql: str, fmt: str = "JSONCompact"):
    # JSONCompact / JSONEachRow 都是 chDB 原生格式, 零额外开销
    body = s.query(sql, fmt)
    return Response(content=body, media_type="application/json")
```

Java 网关收到 `application/json` 直接按字节透传，全链路没有多余的序列化来回。

### 防 OOM 的几层

手工 SQL 写坏是常态。审计、排障的人不一定懂 chDB 内部怎么跑，写出 `GROUP BY` 高基数列、`JOIN` 大维表这种查询的概率不低。嵌入式的 chDB 一旦有一条查询把进程搞 OOM 了，队列里排着的、正在跑的查询全部报废，那边认真审计的同事和这边排障的同事一起遭殃。

所以要一层层防。`max_memory_usage` 给单查询设硬顶，超了主动报错，进程不死；`max_bytes_before_external_group_by/sort` 打开 spill，慢一点但不崩；cgroup 或 Docker 的内存限制比 `max_server_memory_usage` 大 20% 到 30%，留出余量；最后才是 systemd 或者 k8s livenessProbe 这类守护进程兜底。前面三层都失效了才轮到守护进程出场，不能指望挂了再拉起来。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-11.light.svg" alt="OOM 防护层级：单查询硬顶、spill、cgroup 余量、守护进程兜底">
<img class="dfig-d" src="/diagrams/chdb-11.dark.svg" alt="OOM 防护层级：单查询硬顶、spill、cgroup 余量、守护进程兜底">
</figure>

### query_id 和取消

人会改主意。审计人员发现 SQL 写错了，直接关掉页面，或者改一条重新发，chDB 这边还在闷头扫 100G，既浪费资源，又占着那 4 个并发名额，把下一个人堵在外面。HTTP 超时、页面关闭都不会自动取消服务端的查询，必须主动 KILL：

```python
import uuid

@app.post("/query")
async def query(sql: str):
    qid = str(uuid.uuid4())
    s.query(f"SET query_id = '{qid}'")
    try:
        return s.query(sql, "JSONCompact")
    except asyncio.CancelledError:
        s.query(f"KILL QUERY WHERE query_id = '{qid}'")
        raise

@app.post("/cancel/{qid}")
def cancel(qid: str):
    s.query(f"KILL QUERY WHERE query_id = '{qid}'")
```

这么个小机制，能省下大量用户已经走了、查询还在扫的浪费，S3 的流量账单也好看些。

### Python 够不够快

很多人下意识觉得 Python 处理数据慢，心里拿来比的是纯 Python 写 for 循环处理 100 万行。chDB 在 Python 里其实是这样的：

```
Python 这边：写 SQL、拿结果      (毫秒级)
C++ 那边：扫 100G、SIMD、并行    (秒级，吃满所有核)
```

所以大查询上，Python binding 的 chDB 和 C++ 直接调用几乎一样快。

什么时候才该考虑 Go 或 Rust：

| 场景 | 建议 |
|---|---|
| 单查询 > 1 秒，QPS 低 | Python 完全够 |
| 单查询毫秒级，QPS > 几百 | Go / Rust 优势开始显现（避免 GIL + 解释器开销） |
| 嵌入到现有 Rust/Go 服务里 | 用对应 binding，别为了「Python 顺手」再起一个进程 |
| Serverless / 冷启动敏感 | Go / Rust（二进制更小） |

我们这个 100G S3 加秒级查询的场景，Python 正合适。

### 完整的服务骨架

```python
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from anyio import Semaphore
from chdb import session
import uuid

app = FastAPI()
sess = session.Session("/data/chdb")

# 启动时灌一次"profile"
for stmt in [
    "SET max_remote_read_network_bandwidth_for_server = 83886080",
    "SET s3_max_get_rps = 200",
    "SET max_server_memory_usage = 25769803776",
    "SET max_memory_usage = 8589934592",
    "SET max_bytes_before_external_group_by = 4294967296",
    "SET max_bytes_before_external_sort = 4294967296",
    "SET max_threads = 8",
    "SET use_hive_partitioning = 1",
]:
    sess.query(stmt)

sem = Semaphore(4)

@app.post("/query")
async def query(sql: str, fmt: str = "JSONCompact"):
    qid = str(uuid.uuid4())
    async with sem:
        sess.query(f"SET query_id = '{qid}'")
        try:
            body = sess.query(sql, fmt)
            return Response(content=body, media_type="application/json")
        except Exception as e:
            raise HTTPException(500, detail=str(e))

@app.post("/cancel/{qid}")
def cancel(qid: str):
    sess.query(f"KILL QUERY WHERE query_id = '{qid}'")
    return {"ok": True}
```

再加上 systemd 或 k8s 守护，几十行代码就是个能上生产的查询服务。

### 监控

| 指标 | 来源 |
|---|---|
| 队列长度、等待时长 | 应用层埋点 |
| 单查询耗时分布 | `system.query_log` |
| S3 字节数、请求数 | `system.events`（`ReadBufferFromS3Bytes`、`S3GetObject`）|
| 进程 RSS、CPU、网络出口 | 主机层（node_exporter / cAdvisor）|
| supervisor 重启次数 | systemd / k8s |

哪一项出了异常都要告警。

## chDB 和 DuckDB 怎么比才公平

很多 benchmark 文章翻车，是因为目标含糊或者方法不对。这个场景下我是这么设计对比的。

只测 4 个贴近真实使用的场景，不跑整套 TPC-H，免得无关的查询拉低信噪比：

| # | 场景 | 关心的指标 | 为什么 |
|---|---|---|---|
| Q1 | 冷启动 + 选择性 WHERE | wall time、S3 字节数 | 看列裁剪 + row-group skip |
| Q2 | 高基数 GROUP BY | wall time、峰值 RSS | 看聚合引擎和 spill |
| Q3 | LIKE 子串全列扫描 | wall time、CPU 利用率 | 看字符串匹配 SIMD 差距 |
| Q4 | JOIN 大维表 + 聚合 | wall time、峰值 RSS、是否 OOM | 看 hash join 内存策略 |

环境和数据：同一台 EC2（建议 `m6i.4xlarge` 或 `c6i.8xlarge`），和 S3 在同一个 region；TPC-H scale factor 1000 的 `lineitem` 表（约 100 GB）加 `orders` 表（约 15 GB）；两边读完全相同的 Parquet 文件，写的时候 row_group_size=128MB、ZSTD、statistics 打开、100 到 200 个文件；每条查询之间 `sync && echo 3 > /proc/sys/vm/drop_caches`，测冷态；每条跑 5 次，扔掉预热那次，取后 4 次的中位数和 p95。

配置要对齐：

```sql
-- chDB
SET max_threads = 16, s3_max_connections = 16;

-- DuckDB
PRAGMA threads = 16;
SET preserve_insertion_order = false;
```

测试脚本（`bench_chdb_vs_duckdb.py`）的核心结构：

```python
def run_once(query_fn, iface, drop_caches):
    maybe_drop_caches(drop_caches)
    rx_before = read_net_rx(iface)
    with RssSampler() as s:
        t0 = time.perf_counter()
        rows = query_fn()
        wall = time.perf_counter() - t0
    return RunResult(
        wall_seconds=wall,
        peak_rss_bytes=s.peak,
        net_rx_bytes=read_net_rx(iface) - rx_before,
        rows=rows,
    )
```

跑之前，按两个引擎的设计差异，我的预期是这样（实测可能有 ±30% 的浮动）：

| 场景 | 预期赢家 | 大致差距 | 原因 |
|---|---|---|---|
| Q1 选择性过滤 | 接近平手 | ±10% | 都做列裁剪 + row-group skip，bandwidth-bound |
| Q2 高基数 GROUP BY | chDB 略快 | 1.5–3× | ClickHouse 多核哈希聚合更成熟 |
| Q3 LIKE 子串 | chDB 明显快 | 2–5× | ClickHouse 字符串匹配走 Volnitsky/SIMD |
| Q4 JOIN | 看维表大小 | | DuckDB 在小内存上更省，chDB 在大数据上更稳 |
| 基线 RSS | DuckDB 完胜 | 10×+ | binary 体积决定 |
| 冷启动 | DuckDB 更快 | 几百 ms vs 1s+ | 同上 |

对真实业务来说，够用就行才是决定因素，1.5 倍的差距说明不了什么。chDB 适合常驻在数据节点、数据量大、要接 ClickHouse 生态的场景；DuckDB 适合笔记本上分析、Notebook、嵌入式的短任务。

做对比时容易踩的坑：第一次的结果要扔掉，冷启动和连接池预热会让第一次永远偏慢；两边要读同一份 Parquet 文件，row group 大小不同，裁剪效率就不同；别跨 region 跑，网络抖动会盖掉所有差距；`max_threads` 别用各自的默认值，要显式对齐；别只测一种数据分布，长字符串列和短整型列的扫描速度能差几个数量级；别只拿 wall time 一个数下结论，RSS、S3 字节数、CPU 利用率都要附上；别跑一次就发表，至少 4 个有效样本取中位数；要写版本号，两个项目都迭代得很快，半年前的结论可能已经过时了。还有两个和引擎默认值有关的坑，下面实测时撞上了：chDB 的 `remote_read_min_bytes_for_seek` 默认 4 MB，会让它对远程 Parquet 整个 row group 下载；DuckDB 的 `enable_external_file_cache` 默认是 `true`，会把远程文件缓存进内存。

## 实测：一份生产日志数据

上面是方法，下面是按这套方法真实跑出来的一组数据。这次故意没用 TPC-H，用的是一张生产 K8s 容器日志表。一是日志的 `@message` 列做 `LIKE '%xxx%'`，才是 Parquet 子串硬伤最真实的考场；二是真实数据的列基数分布，少数几个低基数维度，加上基数极高的 trace_id 和日志正文，比 TPC-H 更能看出列裁剪和聚合内存上的差别。

测试环境：

| 组件 | 规格 |
|---|---|
| 查询机（chDB / DuckDB 同机） | 48 核 / 251 GB RAM / Linux；到对象存储走 LAN，实测有效带宽 ~80 MB/s |
| chDB | 26.3.0（Python binding，进程内）|
| DuckDB | 1.5.3（Python，httpfs）|
| 对象存储 | rustfs（S3 兼容），HTTP + path-style endpoint，与查询机同 LAN |
| 导出端 ClickHouse | 25.9.3 拉源数据写 Parquet |

数据集是 `app_logs` 容器日志，从源集群用 `INSERT INTO FUNCTION s3()` 按天导出成 Parquet，导出加逐天的行数校验，5 分钟跑完。一共 4.69 亿行、21 天，未压缩的原始数据约 300 GB，在 ClickHouse 里约 10 GB，导成 Parquet（ZSTD level 3）以后只有 4.5 GB，原始数据到 Parquet 的压缩比约 67 倍，比 ClickHouse 自己的存储还小了一半多，日志文本按列压缩的效果确实好。布局是 `s3://my-bucket/app_logs/dt=YYYYMMDD/data.parquet`，每天一个文件，74 MB 到 300 MB，按 `@timestamp` 排序。列的基数差别极大，`stream` 只有 2 个值，`kube_node_name` 3 个，`kube_pod_name` 45 个，`TID` 却有 1193 万，`@message` 有 8438 万。

中间踩了个坑：这个环境里 ClickHouse 写出的 page index，在日志文本列上生成了坏的 min/max（`min_value > max_value`），chDB 一读就报错。把 `output_format_parquet_write_page_index` 关掉就好了，row group 级别的统计还在，裁剪不受影响。

四个查询，对应前面的四类场景：

| # | 场景 | 查询要点 |
|---|---|---|
| Q1 | 选择性时间过滤 + 聚合 | 单小时窗口 `count() + uniqExact(TID)`（靠 `@timestamp` row-group 统计跳掉 20/21 文件）|
| Q2 | 高基数 GROUP BY | `GROUP BY TID`（1193 万组）|
| Q3 | LIKE 子串全列扫 | `count() WHERE @message LIKE '%error%'`（命中 69.3 万）|
| Q4 | 重内存聚合 + count distinct | `GROUP BY kube_pod_name` + `uniqExact(TID)` + `uniqExact(@message)` |

两个引擎都是 16 线程、冷读 S3、列裁剪打开，每条跑 3 次取中位数：

| 查询 | 引擎 | 中位耗时 | 峰值 RSS | 网络读 | 吞吐 | CPU% |
|---|---|---:|---:|---:|---:|---:|
| Q1 选择性时间过滤 | chDB | 0.10s | 496 MB | ~0 | | 334% |
| | DuckDB | 0.31s | 10.7 GB | 25 MB | 83 MB/s | 260% |
| Q2 高基数 GROUP BY (TID) | chDB | 5.67s | 4.05 GB | 182 MB | 32 MB/s | 649% |
| | DuckDB | 4.00s | 12.2 GB | 198 MB | 49 MB/s | 670% |
| Q3 LIKE 子串全扫 | chDB | 18.17s | 2.27 GB | 1.48 GB | 82 MB/s | 1002% |
| | DuckDB | 18.70s | 10.8 GB | 1.50 GB | 80 MB/s | 881% |
| Q4 重内存 count distinct | chDB | 26.21s | 11.3 GB | 1.69 GB | 64 MB/s | 1132% |
| | DuckDB | 70.03s | 43.5 GB | 1.73 GB | 25 MB/s | 973% |

Q1 是选择性查询，chDB 赢得很干脆，0.10 秒对 0.31 秒，内存 496 MB 对 10.7 GB。文件按天切、按 `@timestamp` 排序，row group 的 min/max 跳掉了 21 个文件里的 20 个，几乎不用读数据；chDB 的进程开销也比 DuckDB 的 buffer manager 预占少得多。

Q2 是中等规模的 GROUP BY，DuckDB 略快，4.0 秒对 5.67 秒。两边读的字节数差不多，都是 190 MB 左右，只读了 `TID` 一列，这一档 DuckDB 的聚合流水线稍占上风。

Q3 是 LIKE 子串，打平，都是 18 秒左右。两边都要读 `@message` 整列，1.48 GB，卡在了 80 MB/s 左右的 LAN 带宽上，网络是瓶颈，字符串匹配上的 SIMD 差别完全被盖住了。不过 chDB 的内存少了 4 倍多。

Q4 是重 distinct，chDB 又赢了，26 秒对 70 秒，快 2.7 倍，内存 11 GB 对 43.5 GB，省了将近 4 倍。ClickHouse `uniqExact` 的状态管理在内存效率上比 DuckDB 的 `count(DISTINCT)` 高得多，DuckDB 一度逼近 OOM。

### 差点得出一个离谱的结论

这次实测最大的收获其实不是这几个数字，而是发现拿默认配置跑，会得出 DuckDB 比 chDB 快 50 倍的离谱结论。原因是两个正好对称的默认行为。

一个在 chDB 这边，它默认不对远程 Parquet 做列裁剪。`remote_read_min_bytes_for_seek` 默认 4 MB，会让 chDB 把整个 row group 的所有列都拉下来，而不是只取需要的那几列。Q2 只查 `TID` 一列（每个文件 10 MB 左右），却下载了整整 3.9 GB。**把 `remote_read_min_bytes_for_seek` 设成 0**，强制按列分块发 Range GET 以后，Q2 的网络读从 3.9 GB 降到 0.18 GB，耗时从 45 秒降到 5.7 秒，快了 8 倍左右。

另一个在 DuckDB 那边，它默认把远程文件缓存进内存。`enable_external_file_cache` 默认 `true`，同一个连接里第二次查询直接命中内存，网络读约等于零，CPU 冲到 1500% 以上，测的根本不是查 S3，是查内存。设成 `false` 以后每次都冷读，才和 chDB 对等。

两个坑叠在一起，等于拿 chDB 全量下载冷读，去比 DuckDB 单列命中内存，快几十倍纯属假象。所以对齐配置不光是对齐 `max_threads`，引擎各自 IO 路径上的默认值，远程读的粒度、文件缓存，也都得对齐，不然这种对比一点意义都没有。

### 结论

没有哪个引擎全面碾压。chDB 赢在选择性查询（Q1）和重 distinct 聚合（Q4，2.7 倍），DuckDB 在中等 GROUP BY（Q2）上略快，全扫描（Q3）打平。内存上 chDB 每一项都更省，少了 3 倍到 20 多倍，对一个多条查询共用一个常驻进程的微服务来说，这一点很要紧。全扫类的查询卡在 80 MB/s 左右的 LAN 带宽上，引擎的算力差别被网络盖住了，也印证了前面说的，真正的瓶颈在 S3 的出口带宽。这套架构里我用 chDB，看中的是它常驻进程时内存省，SQL 又和 ClickHouse 完全一样，导出端写什么样的查询，查询端照抄就行。

## 最后

回到开头那张图：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-12.light.svg" alt="整体架构总结">
<img class="dfig-d" src="/diagrams/chdb-12.dark.svg" alt="整体架构总结">
</figure>

整篇贯穿下来，就是能解耦的地方尽量解耦，让 S3 待在 ClickHouse 的关键路径之外，故障域就小一截。存得对比查得快重要，八成的性能是数据布局决定的，路径、文件、row group 三层漏斗，每一层都要让过滤起作用。删数据的条件要带上验证，TTL 写成 `WHERE exported_at IS NOT NULL`，导出失败就变成了存储告警，而不是丢数据。限制要事先主动设好，带宽、内存、并发、超时都给个明确的上限，宁可单条查询失败，也不让进程崩。`system.query_log`、`system.events` 和应用埋点，从第一天就要打开。

这套架构也有不合适的地方。频繁的 `LIKE '%xxx%'` 子串查询，是 Parquet 和 ORC 共同的硬伤，得导进 chDB 本地的 MergeTree 才能用上 ngram、tokenbf 索引。毫秒级响应、高 QPS 的在线服务，chDB 单查询再强，也扛不住每秒上千个 50 毫秒的查询。冷数据上频繁的事务性写入也不行，Parquet 是不可变的，更新只能整个文件重写。跨冷热边界的复杂 JOIN，业务层拼接还行，想在引擎层一把搞定比较难。

适合它的是历史数据分析、报表、审计、即席查询、机器学习特征回算，「有一堆冷数据，又不能扔」的需求，大部分都在这里面。

代价是多写一个导出脚本和一个查询微服务，换来的是 ClickHouse 集群更小、更稳，冷数据用的是开放格式，不绑定任何厂商，S3 出故障也不会再威胁到热查询。

## 附录：关键设置速查

chDB 查询端：

```sql
SET use_hive_partitioning = 1;
SET max_remote_read_network_bandwidth_for_server = 83886080;  -- 80 MB/s
SET s3_max_connections = 8;
SET s3_max_get_rps = 200;
SET max_threads = 8;
SET max_memory_usage = 8589934592;            -- 8 GB / query
SET max_server_memory_usage = 25769803776;    -- 24 GB / process
SET max_bytes_before_external_group_by = 4294967296;
SET max_bytes_before_external_sort = 4294967296;
SET input_format_parquet_filter_push_down = 1;
SET input_format_parquet_bloom_filter_push_down = 1;
SET remote_read_min_bytes_for_seek = 0;                -- 必开: 否则整 row group 下载, 列裁剪失效 (见实测一节)
SET input_format_parquet_enable_row_group_prefetch = 0;
```

DuckDB 那边做公平对比时，记得 `SET enable_external_file_cache = false`，默认的 `true` 会把远程文件缓存进内存，跨查询命中以后测的就不是 S3 了。

ClickHouse 写 Parquet 端：

```sql
SETTINGS
    output_format_parquet_row_group_size_bytes = 134217728,  -- 128 MB
    output_format_parquet_row_group_size       = 1000000,
    output_format_parquet_compression_method   = 'zstd',
    output_format_parquet_compression_level    = 3,
    output_format_parquet_use_custom_encoder   = 1,
    output_format_parquet_string_as_string     = 1,
    output_format_parquet_write_page_index     = 1,
    max_threads        = 4,
    max_insert_threads = 4,
    s3_truncate_on_insert = 0,
    s3_create_new_file_on_insert = 1
```

带验证的 TTL：

```sql
ALTER TABLE events ADD COLUMN exported_at Nullable(DateTime) DEFAULT NULL;
ALTER TABLE events MODIFY TTL
    event_time + INTERVAL 4 MONTH DELETE WHERE exported_at IS NOT NULL;
```

一个干净的数据布局：

```
s3://my-bucket/events/
  dt=2026-05-01/
    bucket=0/data.parquet    ~ 512 MB, sorted by (user_id, event_time)
    bucket=1/data.parquet
    ...
    bucket=63/data.parquet
  dt=2026-05-02/
    ...
```

每个 `data.parquet` 里：row group 128 MB，ZSTD level 3 压缩，statistics 打开（每个 row group 有 min/max），page index 打开，bloom filter 只给高基数、没法做主排序键的列开。

---

**相关**：[冷热分层概览](/clickhouse/cold-storage/) · [为什么要转 Parquet](/clickhouse/cold-storage/parquet) · [S3 不可达时起不来：metadata 明明在本地，它却说 S3 上找不到](/clickhouse/troubleshooting/s3-unreachable-startup)
