---
title: chDB + S3 Parquet：把冷数据变成可查询资产
---

# chDB + S3 Parquet：把冷数据变成可查询资产

> 把冷数据从 ClickHouse 里拆出去，存成开放格式的 Parquet 放进 S3，再用 chDB 作为独立的查询侧。从动机、数据布局、写入、生命周期一直到查询微服务的完整架构。
>
> **阅读对象**：历史数据已经堆到几十 TB、热查询带不动、又不敢贸然迁移的团队。

---

## 引子：为什么要单独写这套架构

如果你正在维护一个 ClickHouse 集群，时间一长几乎一定会遇到这三个问题：

1. **存储成本失控**：MergeTree 表越积越大，NVMe SSD 的钱花得心疼，但又不敢删——而且这两年大模型训练 / 推理井喷直接把 DRAM 和企业级 SSD 价格推高了数倍（HBM 挤占 DRAM 产能、QLC/TLC 颗粒被 AI 数据集吃光），同样容量的本地存储跟两年前比涨了 2-4 倍，「硬件便宜可以堆」的旧假设已经不成立；
2. **冷查询拖累热查询**：业务只查最近 7 天，但偶尔有人查 1 年前的数据，把 IO 和内存吃干净；
3. **集群越大越脆**：节点越多、parts 越多、ZooKeeper 越累，扩容和升级都越来越难。

ClickHouse 官方给出的方案是 **S3 disk / 存储策略**——把冷数据下沉到 S3，存储成本下来了。但这条路把 **S3 拉进了 ClickHouse 的运行时关键路径**，故障域就此扩大。本文要讨论的是另一条路：

> **把冷数据从 ClickHouse 导出成标准 Parquet，存到 S3，由独立的 chDB 微服务负责查询**。

整套架构长这样：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-01.light.svg" alt="引子：为什么要单独写这套架构">
<img class="dfig-d" src="/diagrams/chdb-01.dark.svg" alt="引子：为什么要单独写这套架构">
</figure>

整篇文章按「为什么这样选 → 数据怎么放 → 怎么写出来 → 怎么管生命周期 → 怎么对外提供查询」的顺序展开。

---

## 一、为什么不用 S3 冷盘：故障域才是决定性问题

S3 冷盘最大的卖点是「无缝」——给 ClickHouse 配一个 `<disk type="s3">`，加一条 TTL 自动下沉，业务无感知。但这个「无缝」恰恰是问题。

### S3 冷盘的隐性耦合

把 S3 配成 ClickHouse 的 disk 后，下面这些事都建立在 S3 可用的前提上：

- 每个冷 part 的 metadata 都引用 `s3://...` 路径；
- 启动时要读 metadata、stat S3 对象、校验完整性；
- `ALTER` 冷分区（加列、改类型、改 TTL）要拉回元数据甚至数据；
- `ALTER UPDATE/DELETE` 打到冷分区要重写 S3 part；
- `Replicated*MergeTree` 副本之间要互相确认 part 在 S3 的状态。

任何一项遇到问题——S3 限速、区域故障、IAM 凭证过期、网络抖动——都会触发连锁反应：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-02.light.svg" alt="S3 冷盘的隐性耦合">
<img class="dfig-d" src="/diagrams/chdb-02.dark.svg" alt="S3 冷盘的隐性耦合">
</figure>

这不是 ClickHouse 的 bug，是架构选择把 S3 拉进了关键路径的必然结果。

### Export 方案的爆炸半径

把同样这件事用「导出 Parquet」做：

- ClickHouse 这边只有「每天一次 INSERT INTO FUNCTION s3(...)」，跑完即断，不持有任何 S3 长连接；
- S3 上的 Parquet 跟 ClickHouse 没有运行时绑定；
- chDB 微服务是独立进程，独立读 S3，跟 ClickHouse 互不知道对方存在。

S3 出问题时：

| 方案 | S3 故障的爆炸半径 |
|---|---|
| S3 冷盘 | 冷查询失败 + 热查询变慢/失败 + ClickHouse 重启风险 + ZK 同步异常 |
| Export to Parquet | 仅冷查询失败 |

后者就是「历史分析查不了」，前者是「整个数据库可能起不来」。**这两件事的严重性差一个数量级以上**。

### 其他经常被低估的优势

除了故障隔离，export 方案还顺手解锁了几件事：

1. **格式开放**：Parquet 是工业标准，DuckDB / Spark / Trino / Presto / Athena / pandas / polars 都能读。哪天 chDB 不合适了，换引擎不用动数据。S3 冷盘的数据是 ClickHouse 内部格式，离开 ClickHouse 就是一堆没人认识的二进制。
2. **备份简单**：冷数据天然就是冷备，需要灾备时 `aws s3 sync` 到另一个 region 就行，不需要懂 ClickHouse 内部结构。
3. **Schema 演进自由**：每天的 Parquet 可以有不同 schema，chDB 端做兼容即可。S3 冷盘上的数据必须跟当前表 schema 一致。
4. **成本独立可观测**：S3 的存储和请求账单跟 ClickHouse 集群完全分开，财务上一眼看清。S3 冷盘的 S3 IO 是后台 merge 触发的，账单跟性能问题揉在一起难拆。
5. **存储成本不再被副本数放大**——这条尤其在集群场景下被严重低估。`Replicated*MergeTree` 配 S3 冷盘时，**每个 replica 都会向 S3 写自己那一份**：3 副本集群冷数据下沉 = S3 上存 3 份。本来「上 S3 省钱」的初衷被副本系数抵消大半。
   社区曾用 `allow_remote_fs_zero_copy_replication` 试图解决这个问题（多 replica 共享 S3 上同一份 part），但因为 part 引用计数、删除竞态、metadata 一致性等一系列正确性问题，**官方早已标注为「实验性、不建议生产使用」**——这条路实际上被堵死了。
   Export 方案下，**每个 shard 只往 S3 写一份**（详见第五章「集群部署」那节，每 shard 选一个 replica 出力），S3 自己的 11 个 9 持久性天然替代了 CK 的多副本——**存储成本省 N×**（N = 副本因子）。
   一个 CK 内部已占 **50 TB on-disk**（已是 LZ4 压缩后）的 3 副本冷数据集群，实账：

   | 维度 | S3 冷盘 | Export Parquet |
   |---|---|---|
   | 单份大小 | 50 TB（CK LZ4，跟本地盘一致） | ~30 TB（Parquet+ZSTD，比 CK LZ4 紧约 1.5-2×）|
   | 副本数 | **× 3** | × 1（S3 自有 11 个 9 持久性兜底） |
   | S3 实际占用 | **150 TB** | **~30 TB** |
   | S3 标准价 ~$0.023/GB·月 | ~$3,500/月 | ~$700/月 |
   | 综合差距 | — | **~5×** |

   主导项是**副本因子 3×**，加上 Parquet+ZSTD 比 CK 原生 LZ4 多挤一档（columnar + dictionary encoding，列压缩天然比行存友好），合计 4-6× 的实账差距。**日志类高重复文本**差距更大——参见第九节实测：CK 内部 10 GB / Parquet ZSTD 仅 4.5 GB（~2.2×），叠加 3 副本就是 ~7×。
   一年下来差几万美刀，结合本节开头那个「硬件涨 2-4×」的背景，**这部分省下的钱比「少一台 NVMe 服务器」明显多**。

### 要付出的代价

当然，export 方案也要付出对应的成本：

| 代价 | 严重程度 |
|---|---|
| 维护一个 export 脚本 / cron | 低——几十行 SQL + 验证 |
| 重叠期数据存两份 | 低——1 个月 ClickHouse 存储 |
| 跨冷热边界的查询要业务层拼接 | 中——但聚合查询通常不跨边界 |
| chDB 需要独立的查询微服务 | 低——本来就要做 |
| Schema 升级要同步考虑 chDB 端 | 低——Parquet 兼容性好 |

跟「S3 抖一下整个集群进 ICU」比，这点成本通常是值得的。**在可解耦的地方倾向于解耦**——这是分布式系统设计里普遍奏效的取舍。

---

## 二、chDB 是什么，凭什么承担「独立查询侧」

### 一句话定义

**chDB 是 ClickHouse 的进程内嵌入式 OLAP SQL 引擎**，可以把它理解为「ClickHouse 界的 DuckDB / SQLite」。它把整个 ClickHouse 查询引擎打包成一个动态库，让你不用启动任何服务进程，在自己的应用里直接跑 ClickHouse SQL。

- 由 Auxten Wang 于 2023 年发起，后被 ClickHouse Inc. 收购，现为官方维护项目；
- 100% ClickHouse 兼容：复用 ClickHouse 的解析器、向量化执行引擎、函数库和存储格式；
- 多语言绑定：Python、Go、Rust、Node.js、Bun、C/C++，**Python 是一等公民**。

### 它在这套架构里的定位

不是「一个查询工具」，而是 **「故意解耦的二级存储的读侧」**。它跟 ClickHouse 是对等组件而不是从属关系——这是干净的架构边界，将来要替换、扩容、迁移都容易得多。

### 关键能力

1. **直接查询 S3 / HDFS / HTTP 上的 Parquet/ORC**，无需建表无需导入：
   ```python
   import chdb
   chdb.query("SELECT count() FROM 's3://bucket/path/*.parquet' WHERE x > 0", "Pretty")
   ```
2. **支持 70+ 数据格式**：Parquet、ORC、CSV、JSON、Arrow、Avro、Protobuf 等；
3. **持久化会话**：`chdb.session.Session("/path")` 等同于一个本地 ClickHouse 实例；
4. **DataFrame 互通**：直接把 Pandas / Polars / PyArrow 当表 SQL 查询，零拷贝（Arrow）返回结果；
5. **完整继承 ClickHouse 引擎层设置**：限速、限内存、external spill 全都有。

### 它的边界在哪里

同时，有几件 chDB 做不到的事需要事先了解：

- **没有官方 Java binding**——这点直接决定了它在「Java 主导的栈」里只能作为微服务存在；
- **不是为高并发短查询设计**——单查询性能强，但 QPS 上千的微查询场景不如专门的 in-memory 引擎；
- **冷启动比 DuckDB 慢**——动态库 ~500 MB，首次加载几百 ms 到 1s，对 Lambda 不友好；
- **`LIKE '%xxx%'` 等子串过滤是 Parquet/ORC 共同的硬限制**——这一点单列详述（见下一节）。

### 资源画像

| 项 | 量级 |
|---|---|
| 动态库体积 | ~500 MB |
| 启动后 RSS | 100–300 MB |
| 冷启动 | 几百 ms 到 1 s |
| CPU 利用 | 多线程向量化，会吃满所有核 |
| 内存 | 大多数算子节制，GROUP BY 高基数 / JOIN 大表时需手动限制 |

**关键认知**：跑 SQL 的实际计算在 C++ 引擎里完成，Python 端只是个遥控器。所以 「Python binding 的 chDB 慢」是误解——只要查询足够「重」，Python 那点边界开销看不见。

---

## 三、100G S3 Parquet：chDB 的能力边界

我们的目标场景：**单机 chDB，查 S3 上 100 GB 的 Parquet/ORC**。下面把它能干什么、做不到什么、瓶颈在哪讲清楚。

### 关键认知：三层过滤模型

chDB 查 S3 Parquet 时，数据要经过三层漏斗：

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

每一层都对应一种「跳过数据」的机制，**任何一层失效，下一层都要为它埋单**。所以「存得对不对」决定了 80% 的查询性能（详见第四节）。

### 引擎层享受到的优化

| 优化 | 效果 | 对 100G S3 的意义 |
|---|---|---|
| 列裁剪 (column pruning) | 只下载 SELECT 涉及的列 | 通常砍掉 80–95% IO |
| 谓词下推 (row-group skipping) | 用 Parquet footer 的 min/max 跳过整段 | 命中分区/范围条件时只读几个 GB |
| 多线程并行读取 | 文件级 + row-group 级并发 | 充分吃满 S3 带宽 |
| 向量化执行 | ClickHouse 原生引擎 | CPU 几乎不会成为瓶颈 |

真正的瓶颈是 S3 出口带宽：同 region EC2 ~1–10 GB/s，本地公网 ~几十 MB/s。

### LIKE 是 Parquet/ORC 的硬伤

这是必须先讲清楚的限制：

1. **`LIKE 'prefix%'`（前缀匹配）**：Parquet 列的 min/max 统计对字符串按字典序，前缀匹配能转化成范围查询，能跳 row group。**前提是数据有序**。
2. **`LIKE '%substring%'`（子串匹配）**：min/max 完全无效；Parquet 的 BloomFilter 也只支持等值。**结果是该列所有 row group 都得从 S3 下载、解压、扫一遍**。`multiSearchAny()` / `position()` / `hasToken()` / 正则——原理一样，**没有索引能用**。
3. **ORC 的 BloomFilter** 也只支持等值，且要建文件时显式开启。

对应的策略：

| 频率 | 建议 |
|---|---|
| 偶尔查一次 | 直接 chDB + S3，忍受全扫 |
| 反复查、前缀固定 | 改 `startsWith()`，写入时按该列排序 |
| 反复查子串 / 全文搜索 | Parquet 不合适，导入 chDB 的本地 MergeTree 并建 `tokenbf_v1` / `ngrambf_v1` / inverted index |
| 字段基数很低 | 提前 ETL 抽成独立列或数组，用等值 / `has()` |
| **`LIKE '%xxx%' LIMIT N`** 探查类查询 | **直接用，通常秒回**——见下文短路原理 |

### 例外：`LIKE '%xxx%' LIMIT N` 通常秒回——pipeline 短路

上面说的「全扫」前提是 **聚合或无界扫描**——`count()`、`GROUP BY`、`SELECT * WHERE ...` 这类必须看完所有数据才能给结果的查询。但**带 `LIMIT N` 的探查类查询是例外**：

```sql
SELECT * FROM s3('...50GB-file.parquet')
WHERE @message LIKE '%error%'
LIMIT 10;
-- 在 50 GB 单文件上常常 < 1s 返回，实际从 S3 拉下来的可能只有几十 MB
```

原理是 ClickHouse / chDB 的 **pull-based 向量化 pipeline**：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-04.light.svg" alt="例外：`LIKE '%xxx%' LIMIT N` 通常秒回——pipeline 短路">
<img class="dfig-d" src="/diagrams/chdb-04.dark.svg" alt="例外：`LIKE '%xxx%' LIMIT N` 通常秒回——pipeline 短路">
</figure>

Limit 算子拿到 N 行后停止向下游拉数据，整条链短路：

1. Limit 不再拉 → Filter 不再拉 → Decoder 不再解；
2. S3 Reader **不再发起新的 Range GET**；
3. 后续 row group 永不下载，文件再大也不读。

所以「单 50 GB 文件 + 子串 LIKE + `LIMIT 10` 秒回」和「LIKE 全扫」并不矛盾——它们是**不同查询形态**的两种结论。

**会让短路失效或退化的场景**：

- **子串极稀有**（命中率 < 1‱）：要扫很多 row group 才凑齐 N 条，退化成接近全扫；
- **`ORDER BY ... LIMIT N`**：必须先看完所有候选才能排序，LIMIT 推不下去；
- **大 `OFFSET`**：`LIMIT 10 OFFSET 100000` 仍要筛 10 万条命中；
- **`max_threads > 1` 的「超读」**：多线程并发扫多个 row group，Limit 喊停时已有 RG 在路上，实际下载略大于理论值（但仍远小于全扫）。

### 限速：让 chDB 不要打爆网关

S3 / 公司出口网关都有带宽和 QPS 限制。chDB 完整支持 ClickHouse 引擎层的所有限速 setting：

```sql
SETTINGS
    max_remote_read_network_bandwidth = 52428800,  -- 单查询 50 MB/s
    s3_max_connections                = 8,          -- 并发连接数
    s3_max_get_rps                    = 200,        -- GET 请求速率
    s3_max_get_burst                  = 400,
    max_threads                       = 4,
    max_download_threads              = 4
```

Session 模式下用 `SET` 一次性灌进去，对会话内所有后续查询生效——这就是 chDB 里的「伪 profile」：

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

进程级硬顶用 `max_remote_read_network_bandwidth_for_server`，整个 chDB 进程所有查询的总带宽不破顶，最适合「不要拉爆网关」的诉求。

---

## 四、S3 数据布局：让查询提速 10–100× 的杠杆

这是整篇文章里**收益最大、最容易被忽略**的一章。存得好，100G 数据查 1 秒；存得糟，再多优化也救不回来。

### 第一层：S3 Key 组织（Hive 风格分区）

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

chDB 完整支持 Hive 风格路径分区：

```sql
SET use_hive_partitioning = 1;

SELECT count() FROM s3('s3://bucket/events/**/*.parquet','AK','SK','Parquet')
WHERE dt = '2026-05-01' AND bucket = 5;
-- dt 和 bucket 被识别成虚拟列，chDB 根本不会去 list 其他分区的文件
```

**分区列选择原则**：

| 适合做分区 | 不适合做分区 |
|---|---|
| 时间（dt、hour）—— 第一优选 | user_id / UUID —— 基数爆炸 |
| 地域 / 租户 / 业务线（基数 < 几百） | 任何文本字段的原值 |
| 数据来源（source、device_type） | 连续数值 |

**经验上限**：分区目录总数不超过几万，否则 S3 LIST 自己就成瓶颈。

#### 案例：日志场景下 IP 字段适合做分区吗？基数 1-5 万

这是个常被问到的边界情况——**单独看基数像在阈值上，组合看就爆炸**。

**1. 分区目录数的实际乘积**

| 配置 | 分区目录总数 | 状态 |
|---|---|---|
| 只 `ip=x.x.x.x/` | 5 万 | 卡在「几万」上限 |
| `dt=YYYYMMDD/ip=.../`，1 个月 | 30 × 5 万 = **150 万** | ❌ S3 LIST 超时 |
| `dt=.../ip=.../`，1 年 | 365 × 5 万 = **1825 万** | ❌❌ 灾难 |
| `dt=.../hour=HH/ip=.../`，1 月 | 30 × 24 × 5 万 = **3600 万** | ❌❌❌ 别想 |

单一维度 5 万本身就已经在 S3 LIST 性能拐点上——`ListObjectsV2` 单页返回 1000 个 key，5 万 IP 要 50 次 paginated 请求，光 LIST 就 ~20-30 s。和 dt 一组合就直接物理不可行。

**2. 日志里 IP 通常严重倾斜（Pareto/Zipf）**

```
头部 100 个 IP（CDN/网关/爬虫/大客户）  ──► 占 80% 流量
中部 1000 个 IP                          ──► 占 15%
尾部 4.9 万 IP（个人用户/扫描器）         ──► 占 5%
```

结果是分区策略最糟糕的形态：**头部分区单文件 1-10 GB**（写一次很久），**尾部 4.9 万分区每个 1-100 KB**（典型小文件问题，S3 GET 风暴）。

**3. 查询模式通常不匹配**

| 典型查询 | IP 分区是否帮到忙 |
|---|---|
| 「查这个 IP 最近 7 天的所有日志」（安全追溯） | ✅ 7 个分区命中 |
| 「Top 50 IP by traffic」 | ❌ 必须扫所有 IP 分区 |
| 「某网段 10.0.0.0/24 的请求」（CIDR） | ❌ 分区只支持等值/IN，CIDR 没救 |
| 「异常 IP 列表关联请求」 | ❌ 反向流，没法用分区 |

日志场景里「按具体 IP 查」通常只占 10-20%，给这部分查询的福利付出全局存储代价不划算。

**4. 推荐做法：`dt` 分区 + `ORDER BY ip` 排序**

```sql
INSERT INTO FUNCTION s3('s3://.../dt={_partition_id}/data.parquet', ...)
PARTITION BY concat('dt=', toString(dt))
SELECT * FROM logs WHERE dt = '2026-05-27'
ORDER BY ip, event_time    -- ← 排序键, 不是分区列
SETTINGS output_format_parquet_row_group_size_bytes = 134217728;
```

查询效果（基于本章三层过滤模型）：

| 查询 | 用到的层 | 效率 |
|---|---|---|
| 特定 IP + 日期 | dt 路径裁剪 → row-group min/max skip | **跟分区一样快**（1000:1 跳过）|
| Top IP | dt 路径裁剪 → 全文件扫 | 跟分区一样 |
| CIDR 范围查询 | dt 路径裁剪 → ip 排序后**变成 row-group 范围裁剪** | **比分区还快**（分区版根本做不到 CIDR）|

**核心洞察**：分区只支持等值匹配，排序键支持等值 + 范围 + 前缀。**ip 做排序键比做分区更通用**。

**5. 中间路线：哈希桶（如果 IP 等值查询真的高频）**

如果统计显示「按具体 IP 查」占 50%+，可以引入低基数哈希桶：

```sql
PARTITION BY concat(
  'dt=', toString(dt),
  '/ipbucket=', toString(cityHash64(ip) % 16)    -- 16/32/64 桶
)
```

16 个桶 × 30 天 = 480 分区/月，可控；查具体 IP 时 chDB 算一下哈希，只读 1 个桶；查 Top 时仍要全扫，但桶级并行更均匀。

**判断速查表**

| 字段特征 | 该不该做分区列 |
|---|---|
| 基数 < 几十（地域、租户、event_type） | ✅ 可以直接分区 |
| 基数几百到几千（小数据源、设备型号） | ⚠️ 跟 dt 组合后看总数，超几万就不行 |
| **基数几千到几万 + 跟时间组合**（IP、device_id）| ❌ **改用排序键** |
| 基数 > 10 万（user_id、trace_id） | ❌❌ 必然爆炸，只能排序键 + bloom filter |
| 任何文本原值、连续数值 | ❌ 同上 |

### 第二层：单个文件多大合适

这一节的建议跟 Hadoop/Spark 时代有重要差别，得讲清楚。**Hive 时代的「128 MB - 1 GB」窄区间**根基是 HDFS block size + Spark 「1 task / 1 file」 的并行模型；**chDB / DuckDB / Trino 等现代 reader 都在 row group 级并行**，文件大小不再决定读侧并行度。所以上界可以拓宽两个数量级，瓶颈从「读不动」转移到「写运维」。

| 文件大小 | 状态 | 说明 |
|---|---|---|
| < 64 MB | ❌ 小文件问题 | S3 GET 固定开销（建连、SSL、HEAD）占比过大；LIST 慢 |
| 64–128 MB | ⚠️ 勉强可用 | 文件内只 0-1 个 row group，零文件内并行 |
| 128–256 MB | ⚠️ 可用下边界 | 1-2 个 row group |
| **256 MB – 几十 GB**（推荐区间） | ✅ 甜区 | IO/并行/元数据三者平衡，**读侧零顾虑** |
| 几十 GB – 100 GB | ⚠️ 可用但有代价 | 读侧仍 OK；写入 10-15 分钟、失败重试痛、footer 几 MB |
| 100 GB – 1 TB | ❌ 不推荐 | 写入小时级、Schema 修正代价大、footer 解析变慢（0.5-2s） |
| > 1 TB | ❌❌ 别这么干 | 工程上无意义，详见下文协议上限 |

**怎么拆数十 GB 的分区**：50 GB 当天数据有两种合理方案：

- **保守派（兼容多 reader / Trino / Spark 协同）**：拆 64-128 个文件，每个 400 MB - 800 MB；
- **激进派（仅 chDB 单 reader）**：拆 8-16 个文件，每个 3-6 GB，也完全可行；
- **极端单文件**：50 GB 一个文件**读侧也能用**，只是写入慢、retry 痛——见第五章坑 1。

**公式记忆**：目标文件数 ≈ 分区数据量 / 目标文件大小，下限 1 个，上限几百个。目标文件大小落在 256 MB - 5 GB 都是合理选择。

### 单对象上限：协议物理上限 ≠ 工程推荐

不同 S3 / S3 兼容服务的单对象上限差异很大，但跟前面的「甜区」是两回事——**这是协议/服务策略层面的硬约束**，远高于工程上的推荐上限：

| 服务 | 单对象上限 | 备注 |
|---|---|---|
| **AWS S3** | **5 TiB** (≈ 5.497 TB) | AWS 服务策略，文档明文 |
| Cloudflare R2 / Wasabi / GCS (S3 层) | 5 TiB | 镜像 AWS |
| Azure Blob (S3 兼容层) | ~4.75 TiB | 跟随 Azure block blob 限制 |
| Backblaze B2 (S3 兼容) | 10 TB | 略放宽 |
| **阿里云 OSS / 腾讯云 COS / 华为云 OBS** | **~48.8 TiB** | 放宽到 multipart 协议算术上限 |
| MinIO / Ceph RGW / SeaweedFS / rustfs 等自建 | 默认 5 TiB，**可配置** | 看部署配置 |

**唯一接近「协议级」的硬约束**是 multipart upload **最多 10000 parts**（这条所有兼容实现都遵守，因为客户端 SDK 硬编码假设），单 part 范围 5 MiB - 5 GiB，算术上限 ~48.8 TiB。AWS 在这之下加了一道 5 TiB 服务策略，中国云厂商没加。

**关键认知**：这些数字跟「建议怎么用」是两回事。

```
协议硬上限         5 TiB - 48 TiB ────── 各家服务策略
不推荐区             > 100 GB ────────── 写小时级、retry 痛、footer 解析慢
甜区上界             ~ 几十 GB ────────── chDB / DuckDB 时代的拓宽
甜区下界             ~ 256 MB  ────────── 保证 2+ row group, 避免 S3 GET 开销
```

工程上有意义的范围比协议上限**低 2-4 个数量级**。「S3 允许 5 TiB」不代表「你应该这么用」。

### 第三层：Row group + 排序（最关键的一层）

Row group 是 Parquet 里**最小的 IO + 裁剪单元**，chDB 读 Parquet 时按 row group 并行。

- 推荐：**128 MB / row group**（多数引擎默认值）；
- 太大（> 512 MB）：min/max 统计的过滤分辨率变粗，跳不掉数据；
- 太小（< 32 MB）：元数据膨胀。

**最关键的一句话**：

> Parquet 的 min/max 统计是「按 row group 算一个范围」——**如果数据乱序，每个 row group 的范围都横跨全表，等于没有索引**。

举例：100 GB 数据，`user_id` 字段基数 1000 万。

- 乱序写入：每个 row group 的 `user_id` 范围都是 `[1, 10000000]`，查 `user_id = 12345` 必须扫所有 row group；
- 按 `user_id` 排序后写入：每个 row group 是紧凑区间 `[12000, 13000]`、`[13000, 14000]`...，只命中 1 个 row group，**裁剪比 1000:1**。

**排序键的选择原则**：

1. 第一排序键 = 最高频的等值/范围过滤列（user_id、device_id、event_type）；
2. 第二排序键 = 次高频列（通常是时间戳）；
3. 第三排序键基本没意义——min/max 只对前缀有效；
4. 如果常用 `LIKE 'Apple%'` 前缀匹配，把那个字符串列设为排序键。

### Parquet / ORC 真正可用的「索引」清单

| 机制 | Parquet | ORC | chDB 利用 | 对什么有效 |
|---|---|---|---|---|
| min/max 统计 | 默认开 | 默认开 | row group skip | 范围、等值、前缀 LIKE（数据有序前提下）|
| Dictionary encoding | 自动 | 自动 | 谓词下推到字典 | 低基数列的等值 |
| Bloom filter | 需写入时开 | 需写入时开 | 支持读取 | 仅等值 |
| Page Index | 较新版本 | – | 部分支持 | row group 内更细粒度的 min/max |
| 倒排索引 / N-gram | 无 | 无 | – | LIKE '%xxx%' 没救 |
| 位图索引 | 无 | 无 | – | – |

**Bloom Filter 什么时候开**：高基数、常做等值查询、无法做主排序键的列（典型如 trace_id）。已经按某列排序了的话，bloom 是冗余。

### 压缩选择

| 压缩 | 比例 | 解压速度 | 适用 |
|---|---|---|---|
| ZSTD（level 3） | 高 | 快 | 推荐默认 |
| ZSTD（level 6+） | 更高 | 略慢 | 冷数据、压缩比敏感 |
| Snappy | 中 | 很快 | 老栈兼容 |
| LZ4 | 低 | 最快 | 本地盘、CPU 紧张 |
| Gzip | 高 | 慢 | 不推荐 |

S3 场景下 ZSTD 几乎总是最优——网络是瓶颈，压缩比直接换成「少传字节」。

### Anti-Patterns 清单

| 反模式 | 后果 |
|---|---|
| 一个分区一个 100 GB+ 巨型文件 | **写入慢（小时级）+ 失败重试代价大 + Schema 修正影响面广**；读侧 row-group 级并行其实仍可，但日导出超 100 GB 建议再加一层哈希桶拆分 |
| 一个分区 10 万个 1MB 小文件 | LIST/GET 风暴 |
| 按 `user_id` 做分区 | 几千万个分区，LIST 自己就超时 |
| `dt/hour/region/source/type` 五层嵌套 | 分区目录爆炸 |
| 写入时不排序 | row group min/max 等于全表范围 |
| 用 Gzip | 解压慢，没换来更好压缩比 |
| 关掉 statistics（某些 Spark 配置默认关） | row-group skip 完全失效 |

**自检命令**：

```bash
parquet-tools meta s3://bucket/events/dt=2026-05-01/bucket=0/data.parquet | head -50
# 看 row group 数量、每个 row group 的 statistics(min/max) 是否存在
```

---

## 五、ClickHouse 直写 Parquet 到 S3：参考配置

如果你原始数据已经在 ClickHouse 里——这是最常见的场景——可以直接用 `s3()` 表函数 + INSERT 把数据写到 S3。但默认行为和上一节的「理想布局」差得有点远，要主动控制几个旋钮。

### 先回答方案选择：为什么 CK 直写，不走 Spark/调度器中转

很多团队第一反应是「我有 Spark 集群，让 Spark 从 CK 读再写 S3」。**对「数据已在 CK、纯归档导 Parquet 到 S3」的场景，CK 直写几乎全方位更优**：

| 维度 | CK 直写 | Spark / 调度器中转 |
|---|---|---|
| 数据跳数 | **1 跳**（CK→S3） | 2-3 跳（CK→Spark→S3） |
| 调度机 / Spark 带宽 | **0** | 等于全量数据 |
| 中间组件 | cron + 几十行 Python | 一套 Spark 集群 |
| 类型保真 | CK 原生输出 | 中间环节可能丢精度（DateTime64 / Decimal） |
| 排序保留 | `ORDER BY` 直接生效 | 要重排 |
| 失败排查链路 | 一段 | 三段 |
| 集群伸缩性 | 见下文「集群部署」 | initiator 漏斗效应 |

Spark/Flink 真正合适的反例放在本章末尾的「什么时候不走 ClickHouse 直写」。**纯归档不要绕 Spark**。

### `s3()` 表函数 vs `S3` 表引擎：选哪个

两者底层是同一份 S3 读写代码，差别只在「暴露方式」：

| 维度 | `s3()` 表函数 | `S3` 表引擎 |
|---|---|---|
| 形态 | 匿名，单条 SQL 里临时构造 | 持久化对象，`CREATE TABLE ... ENGINE = S3(...)` |
| Schema | 每次查询动态推断或显式指定 | 建表时固化 |
| 凭证 | 内联或 named collection 引用 | 建表时绑定 |
| INSERT | `INSERT INTO FUNCTION s3(...) SELECT` | `INSERT INTO s3_table SELECT` |
| 进 `system.tables` | 否 | 是 |
| 适合场景 | **一次性 ETL、cron 导出** | **反复读写的外部表入口** |

**性能、并行度、可控 setting 完全一致**——只是开发体验差异，不是性能差异。本章其余部分以 `s3()` 表函数为例——cron 导出场景下不需要建持久表对象。

### 坑 1：默认会写一个巨型文件

最简单写法：

```sql
INSERT INTO FUNCTION s3(
    'https://bucket.s3.us-east-1.amazonaws.com/events/dt=2026-05-01/data.parquet',
    'AK','SK','Parquet'
)
SELECT * FROM events WHERE dt = '2026-05-01';
```

这一句把 50 GB 数据全塞进一个文件。**读侧其实完全可用**——Parquet 内 row group 级 Range GET、列裁剪、LIMIT 短路都不受影响（详见第三节）。真正的问题在写入和运维侧：

- **写入吞吐受限于单输出流**：50 GB 单文件 ~10-15 分钟；用 `PARTITION BY` 拆 64 桶并行可压到 3-5 分钟；
- **失败重试代价是整文件**：写到 80% 网络断了 → 整个 50 GB 作废重导；拆桶后只重导失败的那个 ~800 MB；
- **没有局部取样 / 部分重算的能力**：bucket 哈希拆分天然给了 `WHERE bucket = N` 的子集查询能力；
- **多 reader 协同（Trino / Spark）依赖文件级并行**：单巨型文件在他们手里并行度受限（chDB 单 reader 不受影响）。

**所以是否要拆 bucket，取决于场景**：

| 场景 | 建议 |
|---|---|
| 日导出 < 10 GB、单 chDB reader、写入稳定 | **不需要拆**，整天一个文件就够 |
| 日导出 50-100 GB、在意导出耗时 | 拆 8-64 桶 |
| 写入网络不稳，需要部分重试 | 拆 64-128 桶 |
| 要给 Trino / Spark / Athena 协同消费 | **必须拆**到 256 MB - 2 GB / 文件 |
| 日导出 > 200 GB | **必须拆**，控制单文件 < 50 GB |

下面给出**带 bucket 拆分的标准写法**（典型 50 GB/天 + 需要写入并行 + 要给外部引擎协同消费的场景）：

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

写出来：

```
s3://bucket/events/
  dt=2026-05-01/bucket=0/data.parquet   ~ 800 MB
  dt=2026-05-01/bucket=1/data.parquet
  ...
  dt=2026-05-01/bucket=63/data.parquet
```

关键点：

- `PARTITION BY` 表达式拼成的字符串就是 `{_partition_id}`；
- `cityHash64(user_id) % 64` 把每天数据均匀拆 64 份；
- 桶数 = 预期日数据量 / 目标文件大小（50G/天 → 64–128 桶）；
- 命名必须是 Hive 风格 `key=value`，否则 `use_hive_partitioning` 识别不了。

### 坑 2：Row group 大小要显式设

**ClickHouse 默认 row group 大小是 512 MB（未压缩）/ 1,000,000 行**——`output_format_parquet_row_group_size_bytes = 536870912`、`output_format_parquet_row_group_size = 1000000`，**先到先触发**。

| 数据行宽 | 谁先触发 | 默认 row group 实际表现 |
|---|---|---|
| 宽行（日志、长字符串）| 512 MB 字节限制 | 几十万行 / RG，压缩后 ~100-150 MB on-disk，**勉强 OK** |
| 中等行（混合类型） | 看情况 | 行数和字节都接近触发，~100-300 MB on-disk |
| 窄行（埋点、纯数值） | 100 万行限制 | 未压缩才几十 MB，压缩后 ~5-20 MB，**太小，元数据膨胀** |

注意 512 MB 是**未压缩**字节数。ZSTD 3-5× 压缩比之下，宽行场景写出的 row group 落在「甜区」是偶然——窄行就翻车。

**建议显式设到 128 MB**：

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

**为什么 128 MB**：

- 它是 Hadoop/Spark 生态的事实标准（`parquet.block.size` 默认值），多数读侧（Spark/Trino/Presto/chDB/DuckDB）都按这个假设来调优；
- 比 ClickHouse 默认 512 MB **细 4 倍**——min/max 统计的过滤分辨率更高，对范围/前缀过滤更友好；
- 不显式设就会写出「统计粒度差一倍」的文件——尤其用 chDB 反过来读自己生成的 Parquet，谓词下推效果会打折。

**自检**（写完跑一下）：

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

看到 `uncompressed≈128MB` 就对了；看到 `rows=1000000` 但字节远小于 128 MB → 是行数限制赢了，得**调大** `output_format_parquet_row_group_size` 让字节限制生效。

特别提一个**最容易踩**的坑：**`output_format_parquet_string_as_string = 1` 必须开**。默认情况下 ClickHouse 把 String 写成 Parquet 的 BINARY 类型，导致 DuckDB / Spark / pandas 读出来是 bytes 而不是 str。开了这个 setting，String 才会正确写成 STRING。

### 坑 3：排序——ClickHouse 这边的天然优势，但要主动用上

ClickHouse 的 MergeTree 数据本来就按 `ORDER BY` 键有序存的，这是外部 ETL 工具没有的天然优势。但 SELECT 并行读会打乱顺序。要保证输出有序，显式 ORDER BY：

```sql
INSERT INTO FUNCTION s3(...) ...
SELECT * FROM events
WHERE dt BETWEEN '2026-05-01' AND '2026-05-07'
ORDER BY user_id, event_time
SETTINGS
    max_threads = 4,
    max_insert_threads = 4
```

`max_threads` 不要拉太高——保留一些有序性。

### 坑 4：Bloom Filter 不会自动写

新版 ClickHouse 支持 Parquet bloom filter 输出，但默认不写：

```sql
SETTINGS output_format_parquet_bloom_filter_push_down = 1
```

不同版本 setting 名字有变化，用前 `SELECT name FROM system.settings WHERE name LIKE '%bloom%'` 确认。

如果你已经按主过滤列排序了，bloom 价值有限——它的真正用武之地是「无法做主排序键、但高频等值查询」的列。

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

**写完必做的验证三连**：

```bash
# 1. 看文件数和大小
aws s3 ls s3://bucket/events/dt=2026-05-01/ --recursive --human-readable --summarize

# 2. 看单文件元数据
parquet-tools meta s3://bucket/events/dt=2026-05-01/bucket=0/data.parquet

# 3. 用 chDB 跑一次 EXPLAIN 看 row group skip 数量
```

### 集群部署：每个 shard 各自直写 S3，不要走分布式表

单机直觉到集群上会出大事，这是整章里**最容易被忽略**的一点。

**反模式：在 initiator 节点上跑分布式表**

```sql
-- ❌ 别这么写
INSERT INTO FUNCTION s3('s3://.../data.parquet', ...)
SELECT * FROM dist_app_logs   -- 分布式表
WHERE dt = '2026-05-25';
```

数据流向：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-05.light.svg" alt="集群部署：每个 shard 各自直写 S3，不要走分布式表">
<img class="dfig-d" src="/diagrams/chdb-05.dark.svg" alt="集群部署：每个 shard 各自直写 S3，不要走分布式表">
</figure>

所有 shard 的数据流向 initiator 再出去——**initiator 单点扛 N 倍带宽**。`SELECT * FROM dist_table` 在 OLAP 查询里很自然（结果集小，汇聚便宜），但**导出场景「结果集 = 数据集」**，汇聚成本爆炸。50 GB/天扛得住，500 GB/天就跪。

**正确做法：本地表 + per-shard fan-out + `{shard}` 宏**

每个 shard 节点 `config.xml` 里的 `<macros>` 段定义了 `{shard}`、`{replica}`、`{cluster}`，会在服务端自动替换：

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

调度脚本向每个 shard 各发一次（每 shard 选一个 replica 出力，避免双写）：

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

写出来的 S3 路径：

```
s3://endpoint/bucket/cluster_a/mydb/app_logs/dt=20260525/shard=1/data.parquet
                                                          shard=2/data.parquet
                                                          shard=3/data.parquet
                                                          shard=4/data.parquet
```

chDB 读侧用 `s3('.../shard=*/data.parquet')` 通配符或 Hive partition pruning（path 里加 `shard=N/`）自然合并所有 shard 数据，**业务查询完全无感**。

**三种方案的总账**：

| 方案 | 数据流向 | Initiator 带宽 | 总跨网传输 |
|---|---|---|---|
| Spark + 分布式表 | shard→initiator→spark→s3 | **3× 单 shard** | 3 倍 |
| CK 直写 + 分布式表（错） | shard→initiator→s3 | **2× 单 shard** | 2 倍 |
| **CK 直写 + 本地表 + `{shard}`** | **shard→s3（各自）** | **0** | **1 倍** |

**伸缩性来自「避免汇聚」，不是来自更牛的引擎**。这套做法在 100 GB/天和 PB/天都成立。

### 关键事实：`INSERT...SELECT` 是服务端执行，调度机零流量

很多人担心「调度器在另一台机器上，向 shard 发 INSERT，数据会不会流经我这台机？」——**不会**。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-06.light.svg" alt="关键事实：`INSERT...SELECT` 是服务端执行，调度机零流量">
<img class="dfig-d" src="/diagrams/chdb-06.dark.svg" alt="关键事实：`INSERT...SELECT` 是服务端执行，调度机零流量">
</figure>

50 GB 数据在 CK 服务端流向 S3，调度机**带宽消耗 ≈ 0**——只有 SQL 文本和状态码过本机。

**关键看 sink 在哪**：

| 查询形态 | 数据流向 | 客户端流量 |
|---|---|---|
| `SELECT * FROM t` | server → client | ✅ 有（即便不读 rows，TCP/driver buffer 那部分也会过来）|
| **`INSERT INTO FUNCTION s3() SELECT *`** | **server → S3** | ❌ **真零** |
| `SELECT count() FROM t` | 服务端聚合 | ~0（只回 1 行）|
| `SELECT ... LIMIT 0` | 不读数据 | ~0（只回 schema）|

`INSERT INTO FUNCTION s3()` 的 sink 在服务端，客户端不是数据接收方。这跟 `SELECT *`（客户端是 sink，必须接数据）有本质区别——后者即便你不 Scan，TCP backpressure 拦下来前已经有几 MB 进了 driver buffer。

**调度脚本的几个注意事项**：

- 调大 client 的 `send_receive_timeout`（导 50 GB 大约 5-15 分钟，导 200 GB 接近 1 小时）；
- 失败时用 `KILL QUERY WHERE query_id = '...'` 主动取消，**不要靠 client 断开来 cancel**——断开不一定立刻终止服务端查询；
- 监控落在 shard 上的 `system.query_log`（`written_bytes`、`written_rows`）和 `system.events`（`WriteBufferFromS3Bytes`、`S3WriteRequestsCount`），**不是调度机本地**；
- 调度机的网络监控应该在导出期间**几乎没流量**——这是验证「数据真的没绕」的最直接证据。

### 什么时候不走 ClickHouse 直写

ClickHouse 写 Parquet 已经够用，但几种场景外部工具更合适：

| 场景 | 用哪个 |
|---|---|
| 数据已经在 CH 里，定期增量导出 | ClickHouse 直写 + cron |
| 需要复杂转换（schema 变换、字段拆解、UDF） | Spark / Flink |
| 需要逐列细粒度 bloom filter 控制 | Spark |
| 原始数据在 Kafka/MySQL，不经过 CH | Flink / Spark 直接源到 S3 |
| 需要 Iceberg / Delta Lake / Hudi | 必须 Spark/Flink |

---

## 六、冷热分层的生命周期管理

### 时间窗口设计

**保留 4 个月，3 个月后导出，1 个月冗余**——这个组合不是拍脑袋：

```
时间线:                                       现在
    ──┬───────────────┬───────────┬───────────┬─►
      T-4月            T-3月       T-1月       T

ClickHouse:  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (保留 4 个月)
S3 Parquet:  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                (T-3 月以前全量)
             ↑                       ↑
             冗余重叠区 (T-4 ~ T-3)   分界线
```

**1 个月冗余的真正价值不是「保险」，是「纠错窗口」**：

- 发现 S3 上的数据有问题（schema 错、字段截断、时区错）→ 可以从 CH 重新导一次；
- 发现 chDB 查 S3 跟 CH 查结果不一致 → 有 ground truth 可比；
- 临时关掉 chDB 查询服务时，最近一个月的数据仍能从 CH 查。

### 导出不是「INSERT 成功」，是「验证通过」

很多人写脚本是这样的：

```python
ch.execute("INSERT INTO FUNCTION s3(...) ...")    # 没报错就当成功
ch.execute("ALTER TABLE events DROP PARTITION ...")
```

这是事故温床。Parquet 写「成功」但行数对不上、schema 错位、压缩出问题——SQL 都不会报错。

**最低限度的验证**：

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

**这一步比「延长冗余 1 个月」重要 10 倍**——没验证的冗余，仍然是 schrödinger 状态。

整个「导出 → 校验 → 回填」过程可以画成这样一个闭环：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-07.light.svg" alt="导出不是「INSERT 成功」，是「验证通过」">
<img class="dfig-d" src="/diagrams/chdb-07.dark.svg" alt="导出不是「INSERT 成功」，是「验证通过」">
</figure>

### 用 TTL + WHERE 子句优雅地自动清理

TTL 是 ClickHouse 原生的删除机制，比 cron 优雅。但**纯 TTL 有一个隐患：它按时间触发，不知道你的 S3 export 有没有成功**。

场景：export 脚本因 IAM key 过期失败 45 天，没人发现，但 TTL 还在每天默默删 4 个月前的数据——等你发现的时候，已经有 45 天的数据既没进 S3、又被 CH 删了。

**解法**：给表加一个 `exported_at` 字段，TTL 表达式带 `WHERE` 子句：

```sql
ALTER TABLE events ADD COLUMN exported_at Nullable(DateTime) DEFAULT NULL;

ALTER TABLE events MODIFY TTL
    event_time + INTERVAL 4 MONTH DELETE WHERE exported_at IS NOT NULL;
```

**效果**：

- 验证过的分区：到 4 个月自动删，零运维；
- 没验证 / 没导出的分区：留着不删，自动变成「告警信号」（CH 存储一直涨就知道 export 出问题了）；
- 不需要 cron-detach / cron-drop。

整套生命周期管理只剩两个东西：**TTL 配置（一次性）+ export 脚本（自带验证 + 回填 exported_at）**。

### 迟到数据自愈

加了 `exported_at` 字段之后，迟到数据天然有了归宿：

- 5/3 迟到的 2 月份数据 INSERT 进来 → `exported_at = NULL`；
- TTL 看到 `exported_at IS NULL`，不会删；
- 下次 export 脚本扫到这些「已过期但未导出」的行，单独追加导一次到 S3；
- 回填 `exported_at`，TTL 下次扫到就清掉。

整套机制是**自愈的**——任何缺失都会以「CH 数据保留时间超期」的形式可见，不会无声丢数据。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-08.light.svg" alt="迟到数据自愈">
<img class="dfig-d" src="/diagrams/chdb-08.dark.svg" alt="迟到数据自愈">
</figure>

### 读路由：三段式策略

应用查询时根据时间路由：

| 数据时段 | 路由到 | 原因 |
|---|---|---|
| T-4 月之内 | ClickHouse | 在本地，更快 |
| T-4 月 ~ T-3 月（重叠区） | ClickHouse | 两边都有，CH 快 |
| T-3 月以前 | chDB → S3 | 只 S3 有 |
| 跨越分界线（比如最近半年） | 业务层拼接：CH + chDB 各查一半然后 UNION | – |

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-09.light.svg" alt="读路由：三段式策略">
<img class="dfig-d" src="/diagrams/chdb-09.dark.svg" alt="读路由：三段式策略">
</figure>

**别在重叠区「双查对账」在线服务里**——那是 cron 验证脚本的工作，不是用户查询的负担。

---

## 七、把 chDB 包成微服务：架构与实现细节

由于 **chDB 没有官方 Java binding**，Java 主导的栈里它只能作为独立微服务存在。下面是生产可用的形态。

### 前提：这套微服务的真实使用画像

动手设计之前，先把「谁会用、怎么用」想清楚——很多设计选择直接由这个决定，也避免按「高吞吐分析平台」那套模板过度设计。

**冷数据归档后的真实访问模式**：

| 场景 | 频率 | 查询特征 | 结果规模 |
|---|---|---|---|
| **审计**（合规扫描特定记录） | 几次/月 | 等值过滤 user_id / order_id / IP | 几十~几千行 |
| **抽查**（业务对账） | 几次/周 | 时间范围 + 维度过滤 | 几百~几千行 |
| **历史问题排障** | 几次/季度 | 自由 SQL，偶尔复杂 | 几行~几万行 |
| 报表回填 / 一次性分析 | 不规律 | 聚合后输出 | 已聚合到几百行 |

**几乎不会出现的「假场景」**（如果出现要反问自己「为什么数据在 CK 热表时不做」）：

- 持续批量分析、ML 特征训练；
- 高 QPS 在线服务；
- 多人并发的交互式 BI；
- 拿百万行结果集去 Java/Python 端再加工。

**反向校准**：如果发现某些查询频繁打到 chDB → S3，**说明这条数据其实没那么冷**，应该 ETL 出来作为独立的热表，或者干脆别下沉。

**这个使用画像决定了下面所有设计的真实动机**：

| 设计点 | 看似的理由 | 真实动机 |
|---|---|---|
| 限并发 / 限带宽 / 限内存 | 保护 S3、支撑高吞吐 | **防一个审计人员的坏 SQL 把进程吃满** |
| `query_id` + 主动 cancel | 节省资源 | **人会关页面、改主意、写错 SQL** |
| OOM 防护四层 | 应对高负载 | **手工 SQL 写坏是常态，进程不能崩** |
| FastAPI 单进程 + systemd | 微服务范式 | **QPS 个位数甚至小数，单进程绰绰有余** |
| 用 JSON，不引入 Arrow | 性能权衡 | **结果几乎都 ≤ 1 万行 + LIMIT，Java 多半透传给 FE** |

**一句话**：这是一个**给少数人随手查的归档查询入口**，不是高并发分析平台。后面所有「限制」和「防御」都是为了**坏 SQL 不要把这个入口干掉**——不是为了支撑高吞吐。

### 跨机部署 + HTTP 通信

<div class="sk sk-steps">
<div class="sk-box is-cold"><span class="sk-t">Java 业务节点</span><span class="sk-d">IO / 编排型，普通配置</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">HTTP</span></div>
<div class="sk-box is-accent"><span class="sk-t">chDB 节点</span><span class="sk-d">CPU + 内存 + 网卡密集型，配置明显更高</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box"><span class="sk-t">S3</span></div>
<p class="sk-cap">两类节点的资源画像完全不同，混布会让其中一方长期闲置</p>
</div>

CH 这边和 chDB 这边的资源画像完全不同——分开部署是必然选择。HTTP 是跨机最简单的协议，运维成熟、调试友好。

### 限并发 + 限带宽 + 限内存三件套

承接前提：**QPS 极低，但单个坏查询能把进程吃垮**。三件套不是为了「扛吞吐」，是为了**给坏 SQL 划个铁笼子**——审计人员手写 `SELECT * FROM big_table WHERE name LIKE '%x%'` 之类查询，**必须扛得住、不能传染到其他请求**。

很多人第一反应是「同一时刻只跑一条 SQL」——保护够彻底但太重。一条慢查询就堵死所有人；chDB 的 CPU/内存利用率被白白浪费。

**更好的做法**：

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

并发数 N 的经验公式：`min(物理核数 / max_threads, 4)`。32 核机、`max_threads=8`，N 取 3–4。

**严格串行**只在两种情况才需要：

1. 查询都是 30 分钟级离线分析，并发了也没人等得起；
2. S3 网关有硬性 QPS 配额，必须确定性卡位。

### 结果传输用 JSON

按本章开头的「使用画像」，结果传输的取舍其实简单：

1. **结果集天然小**：生产 SQL 几乎都带 `LIMIT 1000` / `LIMIT 10000`，再大就该重写成 chDB 端聚合；
2. **Java 是转运站**：加 auth/路由后原样转给 FE，**不读字段值做计算**；
3. **FE 是浏览器**：必然要 JSON。

在这三个条件下，JSON 是唯一合理选择——chDB 序列化 1 次，Java 当 bytes 透传，FE 反序列化 1 次，**全链路只有 2 步**。任何中间转其他格式（比如 Arrow）都得在 Java 端先 decode 再 encode JSON，**纯浪费 CPU**。

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

Java 网关收到 `application/json` 直接 byte 透传，**全链路无序列化往返**。

### OOM 防护层级

继续承接前提：**手工 SQL 写坏是常态**。审计/排障人员不一定理解 chDB 内部行为，写出 `GROUP BY 高基数列` 或 `JOIN 大维表` 这类查询的概率不低。嵌入式 chDB 一旦某条查询把进程 OOM——**队列里所有排队和正在跑的查询全废**，连带把「那位认真审计的同事」和「另一位排障的同事」一起干掉。防御层次：

1. `max_memory_usage` 设单查询硬顶 → 超了主动报错，进程不死；
2. `max_bytes_before_external_group_by/sort` 开 spill → 慢但不崩；
3. cgroup / Docker memory limit 比 `max_server_memory_usage` 大 20%–30% → 留 buffer；
4. supervisor（systemd / k8s livenessProbe）兜底。

**只有 1–3 都失效时**才让 supervisor 介入——而不是「挂了再拉起」。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-11.light.svg" alt="OOM 防护层级">
<img class="dfig-d" src="/diagrams/chdb-11.dark.svg" alt="OOM 防护层级">
</figure>

### query_id 与取消机制

承接前提：**人会改主意**。审计人员发现 SQL 写错了直接关页面 / 改一条重发，chDB 这边还在闷头扫 100G——白烧资源 + 占着 N=4 的并发名额堵下一个人。HTTP 超时、页面关闭都不会自动 cancel 服务端查询，必须主动 KILL。

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

这一个小机制能省下大量「用户已经走了但查询还在扫」的浪费——对 S3 流量账单也友好。

### Python 在这里够不够快

很多人下意识觉得「Python 跑数据慢」，对照对象是「纯 Python for 循环处理 100 万行」。但 chDB 在 Python 里的画风是：

```
Python 这边：写 SQL、拿结果      (毫秒级)
C++ 那边：扫 100G、SIMD、并行    (秒级，吃满所有核)
```

Python 只是个遥控器，重活全在 C++。所以 Python binding 的 chDB 和 C++ 直调的 chDB 在大查询上性能几乎一样——**chDB 设计上最聪明的地方**。

什么时候才该考虑 Go / Rust：

| 场景 | 建议 |
|---|---|
| 单查询 > 1 秒，QPS 低 | Python 完全够 |
| 单查询毫秒级，QPS > 几百 | Go / Rust 优势开始显现（避免 GIL + 解释器开销） |
| 嵌入到现有 Rust/Go 服务里 | 用对应 binding，别为了「Python 顺手」再起一个进程 |
| Serverless / 冷启动敏感 | Go / Rust（二进制更小） |

对我们这个「100G S3 + 秒级查询」场景，**Python 是最匹配的选择**。

### 完整服务骨架

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

加上 systemd / k8s 守护，几十行代码就是个生产可用的查询微服务。

### 可观测性

| 指标 | 来源 |
|---|---|
| 队列长度、等待时长 | 应用层埋点 |
| 单查询耗时分布 | `system.query_log` |
| S3 字节数、请求数 | `system.events`（`ReadBufferFromS3Bytes`、`S3GetObject`）|
| 进程 RSS、CPU、网络出口 | 主机层（node_exporter / cAdvisor）|
| supervisor 重启次数 | systemd / k8s |

任何一个出异常都要告警。

---

## 八、chDB vs DuckDB：怎么做公平的对比

很多 benchmark 文章翻车都因为目标含糊或方法不对。给这个场景一份可复现的对比方案。

### 测试目标

**4 个真实场景**（不测 TPC-H 全套，避免无关 query 拉低信噪比）：

| # | 场景 | 关心的指标 | 为什么 |
|---|---|---|---|
| Q1 | 冷启动 + 选择性 WHERE | wall time、S3 字节数 | 看列裁剪 + row-group skip |
| Q2 | 高基数 GROUP BY | wall time、峰值 RSS | 看聚合引擎和 spill |
| Q3 | LIKE 子串全列扫描 | wall time、CPU 利用率 | 看字符串匹配 SIMD 差距 |
| Q4 | JOIN 大维表 + 聚合 | wall time、峰值 RSS、是否 OOM | 看 hash join 内存策略 |

### 环境与数据

- 同一台 EC2（建议 `m6i.4xlarge` 或 `c6i.8xlarge`），与 S3 同 region；
- TPC-H scale factor 1000 的 `lineitem` 表（~100 GB）+ `orders` 表（~15 GB）；
- 两边读完全相同的 Parquet 文件，写入时：row_group_size=128MB、ZSTD、statistics 开启、100–200 个文件；
- 每条 query 之间 `sync && echo 3 > /proc/sys/vm/drop_caches` 测冷态；
- 跑 5 次，丢掉 warmup，取后 4 次的 median + p95。

### 配置对齐

```sql
-- chDB
SET max_threads = 16, s3_max_connections = 16;

-- DuckDB
PRAGMA threads = 16;
SET preserve_insertion_order = false;
```

### 测试脚本

完整可跑的 Python 脚本已经写好（`bench_chdb_vs_duckdb.py`），核心结构：

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

### 基于架构原理的预期

基于两个引擎设计差异的合理推断（实测可能 ±30% 浮动）：

| 场景 | 预期赢家 | 大致差距 | 原因 |
|---|---|---|---|
| Q1 选择性过滤 | 接近平手 | ±10% | 都做列裁剪 + row-group skip，bandwidth-bound |
| Q2 高基数 GROUP BY | chDB 略快 | 1.5–3× | ClickHouse 多核哈希聚合更成熟 |
| Q3 LIKE 子串 | chDB 明显快 | 2–5× | ClickHouse 字符串匹配走 Volnitsky/SIMD |
| Q4 JOIN | 看维表大小 | – | DuckDB 在小内存上更省，chDB 在大数据上更稳 |
| 基线 RSS | DuckDB 完胜 | 10×+ | binary 体积决定 |
| 冷启动 | DuckDB 更快 | 几百 ms vs 1s+ | 同上 |

**实战结论**：对真实业务而言，**「够用就行」才是决定因素**，不是 1.5× 的差距。chDB 适合「数据节点常驻、大数据量、ClickHouse 生态接续」，DuckDB 适合「笔电分析、Notebook、嵌入式短任务」。

### 避坑清单

1. 不丢第一次结果——cold start + connection pool warmup 让第一次永远偏慢；
2. 两边用不同 Parquet 文件——row group 大小不同直接决定 pruning 效率；
3. 跨 region 跑——网络抖动会淹没所有差距；
4. `max_threads` 用各自默认值——要显式对齐；
5. 只测一种数据分布——长字符串列和短整型列扫描差几个数量级；
6. 拿 wall time 一个数字下结论——附上 RSS、S3 字节、CPU 利用率才完整；
7. 跑一次就发表——至少 4 个有效样本求中位数；
8. 不写版本号——两者都在快速迭代，半年前的结论可能已过期；
9. **chDB 默认不对远程 Parquet 做列裁剪**——`remote_read_min_bytes_for_seek` 默认 4 MB 会让它整 row group 下载，必须置 0（详见下方实测）；
10. **DuckDB 默认把远程文件缓存进内存**——`enable_external_file_cache` 默认 `true`，第二次查询命中内存而非 S3，必须关掉才能和 chDB 公平比冷读。

---

## 九、实测：一份真实生产日志数据集

上面是方法论框架。下面是按这套方法**真实跑出来的一组数据**——刻意没用 TPC-H，而是用了一份生产 K8s 容器日志表。原因有二：日志的 `@message` 列做 `LIKE '%xxx%'` 才是 Parquet「子串硬伤」最真实的考场；真实数据的列基数分布（少数低基数维度 + 极高基数的 trace_id / 日志正文）比 TPC-H 更能暴露列裁剪和聚合内存的差异。

### 测试环境

| 组件 | 规格 |
|---|---|
| 查询机（chDB / DuckDB 同机） | 48 核 / 251 GB RAM / Linux；到对象存储走 LAN，实测有效带宽 **~80 MB/s** |
| chDB | 26.3.0（Python binding，进程内）|
| DuckDB | 1.5.3（Python，httpfs）|
| 对象存储 | rustfs（S3 兼容），HTTP + path-style endpoint，与查询机同 LAN |
| 导出端 ClickHouse | 25.9.3 拉源数据写 Parquet |

### 数据集

`app_logs` 容器日志，从源集群经 `INSERT INTO FUNCTION s3()` 按天导出成 Parquet（导出 + 逐天行数校验，5 分钟跑完）：

- **4.69 亿行 / 21 天**；原始（未压缩）约 **300 GB**，在 ClickHouse 内部约 **10 GB**，导出成 Parquet（ZSTD level-3）后仅 **4.5 GB**——原始→Parquet **压缩比约 67×**（列式 + 日志文本压缩率极高，比 CH 行存内部压缩还小一半）；
- 布局 `s3://my-bucket/app_logs/dt=YYYYMMDD/data.parquet`，每天一个文件（74 MB–300 MB），按 `@timestamp` 排序；
- 列基数差异极大：`stream` 2 个、`kube_node_name` 3 个、`kube_pod_name` 45 个 —— 但 `TID` **1193 万**、`@message` **8438 万**；
- 踩到的坑：本环境 ClickHouse 写出的 **page index 在日志文本列上生成了损坏的 min/max**（`min_value > max_value`），chDB 读取直接报错；关闭 `output_format_parquet_write_page_index` 即可（row-group 统计仍在，裁剪不受影响）。

### 四个查询（映射第八节的 4 类场景）

| # | 场景 | 查询要点 |
|---|---|---|
| Q1 | 选择性时间过滤 + 聚合 | 单小时窗口 `count() + uniqExact(TID)`（靠 `@timestamp` row-group 统计跳掉 20/21 文件）|
| Q2 | 高基数 GROUP BY | `GROUP BY TID`（1193 万组）|
| Q3 | LIKE 子串全列扫 | `count() WHERE @message LIKE '%error%'`（命中 69.3 万）|
| Q4 | 重内存聚合 + count distinct | `GROUP BY kube_pod_name` + `uniqExact(TID)` + `uniqExact(@message)` |

### 结果

两引擎均 **16 线程、冷读 S3、列裁剪开启**，runs=3 取中位数：

| 查询 | 引擎 | 中位耗时 | 峰值 RSS | 网络读 | 吞吐 | CPU% |
|---|---|---:|---:|---:|---:|---:|
| **Q1** 选择性时间过滤 | chDB | **0.10s** | **496 MB** | ~0 | – | 334% |
| | DuckDB | 0.31s | 10.7 GB | 25 MB | 83 MB/s | 260% |
| **Q2** 高基数 GROUP BY (TID) | chDB | 5.67s | 4.05 GB | 182 MB | 32 MB/s | 649% |
| | DuckDB | **4.00s** | 12.2 GB | 198 MB | 49 MB/s | 670% |
| **Q3** LIKE 子串全扫 | chDB | 18.17s | **2.27 GB** | 1.48 GB | 82 MB/s | 1002% |
| | DuckDB | 18.70s | 10.8 GB | 1.50 GB | 80 MB/s | 881% |
| **Q4** 重内存 count distinct | chDB | **26.21s** | **11.3 GB** | 1.69 GB | 64 MB/s | 1132% |
| | DuckDB | 70.03s | 43.5 GB | 1.73 GB | 25 MB/s | 973% |

**逐项解读**：

- **Q1（选择性查询）chDB 完胜**：0.10s vs 0.31s，且 RSS 仅 496 MB vs 10.7 GB。文件按天切 + 按 `@timestamp` 排序，row-group min/max 跳掉 20/21 文件，几乎不读数据；chDB 进程开销也远低于 DuckDB 的 buffer manager 预占。
- **Q2（中等 GROUP BY）DuckDB 略快**：4.0s vs 5.67s，两边读的字节一样（~190 MB，只读 `TID` 列）。这一档 DuckDB 的聚合流水线稍占优。
- **Q3（LIKE 子串）打平**：~18s 持平，两边都读 `@message` 列（1.48 GB），卡在 **~80 MB/s 的 LAN 带宽**——网络受限，字符串匹配的 SIMD 差异被完全淹没。但 chDB 内存少 4 倍多。
- **Q4（重 distinct）chDB 完胜**：26s vs 70s（2.7×），内存 11 GB vs 43.5 GB（4×）。ClickHouse 的 `uniqExact` 状态管理比 DuckDB 的 `count(DISTINCT)` 内存效率高得多，后者一度逼近 OOM。

### ⚠️ 两个让结论直接翻车的陷阱

这次实测最大的价值不是那几个数字，而是发现**用默认配置跑会得出「DuckDB 比 chDB 快 50×」的离谱错误结论**。根因是两个互相对称的默认行为：

**陷阱一：chDB 默认不对远程 Parquet 做列裁剪。**
`remote_read_min_bytes_for_seek` 默认 4 MB，会让 chDB 把整个 row group（所有列）拉下来，而不是只取需要的列 chunk。Q2 只查 `TID`（单列 ~10 MB/文件）却下载了整份 **3.9 GB**。置 `remote_read_min_bytes_for_seek = 0` 强制按列 chunk 发 ranged GET 后，Q2 网络读 **3.9 GB → 0.18 GB，耗时 45s → 5.7s（约 8 倍）**。

**陷阱二：DuckDB 默认把远程文件缓存进内存。**
`enable_external_file_cache` 默认 `true`，同一连接里第二次查询直接命中内存（网络读 ≈ 0、CPU 飙到 1500%+），测的根本不是「查 S3」而是「查内存」。置 `enable_external_file_cache = false` 后每轮都冷读，才和 chDB 对等。

两个陷阱叠加，等于拿「chDB 全量下载冷读」去比「DuckDB 单列内存命中」——快几十倍纯属假象。**这是第八节避坑清单第 4 条「配置必须显式对齐」的放大版：不仅 `max_threads` 要对齐，引擎特有的 IO 路径默认值（远程读粒度、文件缓存）也必须对齐，否则信噪比为零。**

### 实测结论

- **没有一个引擎全面碾压**：chDB 赢在选择性查询（Q1）和重 distinct 聚合（Q4，2.7×），DuckDB 在中等 GROUP BY（Q2）略快，全表扫描（Q3）打平。
- **内存上 chDB 全面更省**，差距 4–20 倍——这在「多查询共驻一个常驻进程」的微服务里至关重要。
- **全扫类查询卡在 LAN 带宽（~80 MB/s）**，引擎算力差异被网络淹没，再次印证第三节「真正瓶颈是 S3 出口带宽」。
- 呼应第八节判断：对真实业务而言 **「够用就行」才是决定因素**；chDB「数据节点常驻、大数据量、ClickHouse 生态接续」的定位，与这套冷数据架构天然契合。

---

## 十、整体架构总结

回到最开始那张图：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/chdb-12.light.svg" alt="十、整体架构总结">
<img class="dfig-d" src="/diagrams/chdb-12.dark.svg" alt="十、整体架构总结">
</figure>

### 设计原则归纳

1. **能解耦的地方倾向于解耦**——这是贯穿所有判断的主线。让 S3 留在 ClickHouse 的关键路径之外，故障域就小一截。
2. **存得对比查得快重要**——80% 的性能由数据布局决定。三层漏斗（路径 / 文件 / row group）每一层都要让过滤生效。
3. **删除条件要带验证语义**——TTL 表达式带 `WHERE exported_at IS NOT NULL`，让「导出失败」自动变成「存储告警」而不是「数据丢失」。
4. **限制是用来主动设的，不是等出事兜底**——带宽、内存、并发、超时，每个都明确设上限，宁可单查询失败也不让进程崩。
5. **可观测性是架构的一部分**——`system.query_log` / `system.events` / 应用埋点必须从第一天就开。

### 这套架构的边界

这套架构也有几个**不适合**的场景需要说明：

- **频繁的 `LIKE '%xxx%'` 子串查询**——Parquet/ORC 共同的硬限制，要导入到 chDB 本地 MergeTree 才能用 ngram/tokenbf 索引；
- **毫秒级响应、高 QPS 的在线服务**——chDB 单查询性能强，但不适合「每秒上千个 50ms 查询」的场景；
- **频繁的事务性写入到冷数据**——Parquet 是不可变的，更新只能整文件重写；
- **跨冷热边界的复杂 JOIN**——业务层拼接 OK，引擎层一把梭比较难。

适合的场景：**历史数据分析、报表、审计、即席查询、机器学习特征回算**。这正好覆盖 80% 的「我有一堆冷数据但又不能扔」的需求。

### 一句话收尾

> 把冷数据从 ClickHouse 里拆出去、用 chDB 重新捡起来——不是「省钱的小聪明」，是把「运行时依赖」换成「数据依赖」的架构升级。代价是多写一个 export 脚本和一个查询微服务；收益是 ClickHouse 集群更小更稳、冷数据用开放格式 vendor 无关、S3 故障不再威胁热查询。**这点工作量，换来的是整个系统的故障耐受性提升一个量级**。

---

## 附录：本文涉及的关键设置速查

### chDB 查询端

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
SET remote_read_min_bytes_for_seek = 0;                -- 必开: 否则整 row group 下载, 列裁剪失效 (见第九节)
SET input_format_parquet_enable_row_group_prefetch = 0;
```

> DuckDB 侧做公平对比时，记得 `SET enable_external_file_cache = false`（默认 `true` 会缓存远程文件到内存，跨查询命中后测的不是 S3 而是内存）。

### ClickHouse 写 Parquet 端

```sql
SETTINGS
    output_format_parquet_row_group_size_bytes = 134217728,  -- 128 MB
    output_format_parquet_row_group_size       = 1000000,
    output_format_parquet_compression_method   = 'zstd',
    output_format_parquet_compression_level    = 3,
    output_format_parquet_use_custom_encoder   = 1,
    output_format_parquet_string_as_string     = 1,   -- 必开
    output_format_parquet_write_page_index     = 1,
    max_threads        = 4,
    max_insert_threads = 4,
    s3_truncate_on_insert = 0,
    s3_create_new_file_on_insert = 1
```

### TTL with 验证守门

```sql
ALTER TABLE events ADD COLUMN exported_at Nullable(DateTime) DEFAULT NULL;
ALTER TABLE events MODIFY TTL
    event_time + INTERVAL 4 MONTH DELETE WHERE exported_at IS NOT NULL;
```

### 一个干净的数据布局示例

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

每个 `data.parquet`：

- Row group: 128 MB
- 压缩: ZSTD level 3
- Statistics: enabled (min/max per row group)
- Page index: enabled
- Bloom filter: 仅对高基数、无法做主排序键的列开

---

*本文配套基准测试脚本：`bench_chdb_vs_duckdb.py`*
