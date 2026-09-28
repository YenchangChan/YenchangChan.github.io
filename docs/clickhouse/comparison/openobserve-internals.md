---
title: 拆解 OpenObserve 的 140x 压缩神话
---

# 拆解 OpenObserve 的 140x 压缩神话

> 源码级深挖 O2 的存储与查询两大内核。所有关键数字都标了置信度和前提条件，官方营销话术被单独拎出来核验 —— 没扛住的一律标记「已证伪」。
>
> **阅读对象**：在 OpenObserve 和 ClickHouse 之间做选型、需要看到源码级证据的人。

---

本文是《拆解 OpenObserve 140x 压缩神话》系列的**第一篇（调研篇）**。后续：[压测篇：27.3 亿行下的真实表现](/clickhouse/comparison/openobserve-benchmark)、[存算分离横评](/clickhouse/comparison/storage-compute-separation)。

<div class="note">

**证据标准**

**取证原则**：本文所有结论，要么**从 O2 源码直接取证**（GitHub 仓库，核实到具体文件与常量），要么**经多个独立来源相互印证/证伪**。不采信官方单方面的营销说法，也不采信第三方个人的孤立观点——凡只有厂商自证、无法交叉核实的数字，一律标注为「厂商自述」并单列。

**唯一的结构性局限**：面向 O2 本身的独立第三方基准极少，因此涉及性能/成本的绝对数值大多只能靠自建 POC 落定——这一点请务必读到最后一节。

</div>

---

## 一、O2 是什么：一句话定位

OpenObserve 是一个用 **Rust** 编写的可观测性（日志 / 指标 / 追踪）平台，技术栈可以概括为一个公式：

> **Rust + Apache Arrow / DataFusion + Parquet + 对象存储**

它的核心卖点不是「性能最强」，而是**用列式存储 + 对象存储把存储成本打下来**，对标 Elasticsearch/ELK 的高存储开销。理解这一点，是理解 O2 所有取舍的钥匙——它是一个**存储成本导向**的方案，而非查询性能天花板方案。

---

## 二、存储架构：三层管道（源码级）

O2 的写入路径是一条清晰的三层管道，这一结论有**官方文档常量 + GitHub 源码**双重佐证：

```
写入
  → WAL（本地磁盘，保证即时持久化）
  → 内存 Memtable（Arrow RecordBatch）
  → 阈值触发落盘为本地 Parquet 文件
  → 周期性 compaction 合并成更大文件
  → 上传对象存储（S3 / GCS / MinIO / Azure Blob / OSS / COS）长期保存
```

关键在于：**WAL 阶段的 Parquet 文件即可被直接查询**，不必等上传对象存储，这保证了新数据的可见性。

支撑这套管道的阈值常量（来自官方架构文档，并被源码交叉验证）：

| 常量 | 默认值 | 含义 |
|---|---|---|
| `ZO_MAX_FILE_SIZE_IN_MEMORY` | 256 MB | 内存中单文件上限 |
| `ZO_MAX_FILE_SIZE_ON_DISK` | 128 MB | 本地磁盘单 Parquet 上限 |
| `ZO_MEM_PERSIST_INTERVAL` | 5 s | 内存持久化间隔 |
| `ZO_FILE_PUSH_INTERVAL` | 10 s | 文件推送间隔 |
| `ZO_COMPACT_MAX_FILE_SIZE` | 2048 MB | compaction 合并目标大小 |

> 📌 源码证据：`object_store` trait 抽象出 `Remote` 结构体 + `LimitStore` 并发控制；`ingester/wal.rs` 中有 `.par → .parquet` 的重命名逻辑。这不是从文档「猜」的架构，而是能对到代码行的事实。
>
> ⚠️ 上表阈值取自官方文档；源码当前版本部分默认值已上调（如 `ZO_MAX_FILE_SIZE_ON_DISK` 实为 512 MB）。**这类阈值随版本变化，选型时以你部署的版本为准。**

### 2.1 存储格式（源码确证）

- 持久化格式：**Apache Parquet**
- 默认压缩：**zstd**（可配置为 Snappy 等）
- Parquet footer 内嵌 **min/max 时间戳 + 记录数**元数据，用于查询时的文件级裁剪（谓词下推的基础）

源码佐证：`config.rs` 中 `ZO_PARQUET_COMPRESSION` 默认 `zstd`；`parquet.rs` 中 `set_key_value_metadata` 写入 `min_ts/max_ts/records`。

### 2.2 索引体系（源码确证，多机制组合）

O2 不是靠单一索引，而是一套组合拳：

| 机制 | 作用 | 默认状态 |
|---|---|---|
| **Tantivy 倒排索引** | 长文本字段（body/message）分词，支持全文检索 | 需显式开启 |
| **Secondary Index** | 单值字段（如 `kubernetes_namespace_name`）整值作为单一 token | 可配置 |
| **Bloom Filter** | 高基数字段快速排除不命中的文件 | **默认仅对 `trace_id` 生效** |
| **时间分区 + 缓存** | 时间范围裁剪 | 内置 |

源码佐证：`parquet.rs` 中 `set_column_bloom_filter_enabled` 按字段条件启用；环境变量文档确认 Bloom Filter 默认仅对 `trace_id` 生效。

> ⚠️ **一个无法确证的细节**：Tantivy 索引究竟是在「摄入时」还是「仅后台 compaction 时」生成？曾有一条声称「仅 compaction 时生成」的二手说法，但与源码其它证据相互矛盾、无法坐实，因此**本文不对索引生成时机下结论**——凡是源码对不上、又无第二来源印证的细节，宁可留白也不硬下判断。

### 2.3 HA 模式的硬约束（官方文档 + 源码确证）

**集群 / HA 模式必须使用对象存储，本地磁盘存储在 HA 下不受支持。** 这意味着一旦上生产集群，你的存储后端就绑定到了对象存储的延迟与成本特性上——这既是 O2 低成本的来源，也是它高基数点查偏弱的根因（详见第三章与 §9.3）。

### 2.4 schemaless 建模的边界：动态字段与嵌套 JSON（源码级）

「自动拆列」很省心——但只在**字段稳定、结构扁平**时成立。以下行为均经 O2 源码核实（区分 🟢源码确证 / 🟡推测）：

**① 字段数硬上限 1000，超限＝整批拒绝写入** 🟢
新字段会自动加 nullable 列（历史行读取补 `null`），但单 stream 列数上限 `ZO_COLS_PER_RECORD_LIMIT=1000`。**一旦超限，该批数据整批被拒绝**（`schema.rs` 报错 `"Data discarded"`，客户端收到错误、无部分成功），**不是丢多余字段、不是自动兜底**。

**② 字段爆炸兜底（`_all`）默认关闭** 🟢
O2 有 UserDefinedSchema 机制：只把白名单字段建独立列，其余字段整体序列化成 JSON 字符串塞进兜底列 `_all`（`column_all`）。**但它默认关闭**（`ZO_ALLOW_USER_DEFINED_SCHEMAS=false`），需手动开启。

> ⚠️ **关键裂缝**：开箱即用状态下，灌入字段动态的日志（把 user_id/uuid 当 key），列数悄悄涨到 1000 就开始**静默整批丢数据**，且默认无兜底。O2 的「零建模便利」在字段失控时会变成**数据丢失风险**。生产上灌动态日志前，务必先开 UDS 或收敛字段。
> （注意别混淆：另有一个 `_all_values` 列是「所有值空格拼接做全文检索」，与字段爆炸治理无关。）

**③ 类型冲突：比 ES 宽容（O2 真优势）** 🟢
同字段先 int 后 string，O2 优先把列**提升为 string**（widening 几乎总允许），提升不了走记录级强转（`zo_cast`），只有强转也失败才丢**单条**记录。对比 ES：mapping 冲突直接拒**整个文档**（这正是 ES 在 O2 官方对比测试中拒收 62% 文档的根因）。**处理脏/异构数据的鲁棒性，O2 明显强于 ES——比 140x 压缩实在。**

**④ 嵌套 JSON：flatten，分隔符是 `_` 不是 `.`** 🟢
默认打平，`a.b.c` → `a_b_c`；key 强制小写、非 `[a-z0-9_]` 转 `_`（**驼峰字段可能撞名覆盖**，`Foo` 与 `foo` 都变 `foo`，后写覆盖）。默认层级 `ZO_INGEST_FLATTEN_LEVEL=3`，超过 3 层的子对象整个转 JSON 字符串。
🟡 caveat：源码里无参 `flatten()` 默认无限展开，配置的 `3` 仅在显式受限调用时生效；各 ingestion 入口（JSON/OTLP/bulk）是否都传 `3` 未逐一追完，POC 时可用 5 层嵌套日志实测确认。

**⑤ 数组一律不拆列（最大的建模坑）** 🟢
**JSON 数组（含对象数组）整体转 JSON 字符串存一列，内部字段完全不拆**（源码中团队评估过按索引拆列但放弃了）。含义：**spans/items/tags/events 这类对象数组在 O2 里退化成字符串，无法列式过滤/聚合，只能全文或 JSON 函数硬解析。** 这是 flatten 路线相对原生支持 nested/array 的 ES/CH 的实打实短板。

**⑥ 闭环回压缩：字段爆炸会「双杀」**
触发 `_all` 兜底后，数据挤进高熵 JSON 字符串列 → dictionary/RLE 失效，**压缩率掉 + 不能列式查询**；对象数组转字符串同理。**官方 95x 样例必然是字段稳定、扁平、无对象数组的干净日志**；真实业务日志的动态字段与嵌套数组，会**同时打击压缩率、查询能力、写入稳定性**三个维度。

> **POC 增补项**：① 你的日志字段动态性——会不会逼近 1000 列；② 有没有对象数组，这些数据是否需要按内部字段查询。这两点比数据量更能决定 O2 在你场景的真实可用性。

### 2.5 物理排序键与时间字段（源码级）

**① 物理排序键写死 `_timestamp DESC`，不可配置** 🟢
compaction 合并的排序 SQL 目标列是编译期常量，`grep sort_key/ZO_SORT` 零命中——**用户无法自定义、无法多字段**。对比 CH 的 `ORDER BY (a,b,c)`，O2 这一层控制权为零。这是它**压缩率不可调**（第五节）、**没有去重引擎**（第八节）的共同根因。
> 注意区分：查询时 SQL 的 `ORDER BY`（DataFusion 支持任意字段/多字段）vs 存储物理排序键（写死）是两回事——前者管结果展示，后者管文件内行的物理顺序、决定压缩效率。

**② 没有时间字段 → 摄入时间兜底** 🟢
`_timestamp` 强制存在；JSON 里无时间字段或为 null → 自动填 `Utc::now().timestamp_micros()`。⚠️ 语义提醒：这种数据的「时间」是**到达时间**而非**事件时间**，时间范围查询要注意偏差。

**③ 时间格式自动识别（比想象稳健）** 🟢
数字时间戳以 `1971-01-01` 为锚点做**数值量级比较**，自动区分秒/毫秒/微秒/纳秒，内部统一微秒。对可观测性的近期时间戳相当可靠。字符串走 RFC3339 / ISO8601 / 带毫秒微秒小数 / RFC2822 级联尝试。
> 限制：字段名 `_timestamp` **硬编码**（无 `ZO_TIMESTAMP_COL` 改名），**无自定义 strptime 格式**——非标准时间格式（如 `MM/DD/YYYY`）解析失败；`0`/极小值会落到 `now()` 或 1970。你的时间字段若叫别的名字，得靠 ingestion pipeline 先映射。

**④ 分区键 ≠ 排序键** 🟢
分区键（Value/Hash/Prefix）可自定义、可多字段，但**只决定数据落哪个文件路径，不决定文件内行序**。partition 管「分到哪个文件」，排序键管「文件内行的先后」——O2 只有后者，且写死。

---

## 三、查询引擎与性能：请平衡看待（中置信度）

### 引擎底座：DataFusion（源码确证）

O2 的查询引擎是 **Apache DataFusion**（Rust/Arrow 生态）。值得注意的是，DataFusion 同时也是 **InfluxDB 3.0、Coralogix** 的后端——它是可观测性品类的**共享技术底座**，而非 O2 独有的黑科技。这对选型的含义是：O2 的查询能力上限，很大程度上取决于 DataFusion 这个上游社区的演进。

### 性能真相：有胜有负，不是全面领先（中置信度，证据有分歧）

这是最容易被营销话术带偏的地方。基于 **SIGMOD 2024 论文**（DataFusion 作者本人撰写，含 InfluxData/Coralogix 作者署名）的**单核**基准（ClickBench 14GB/100 文件、TPC-H SF=10、H2O-G）：

- ✅ **DataFusion 领先**：高选择性谓词下推场景（能充分利用 Parquet 裁剪）
- ❌ **DataFusion 明显落后**：
  - 高基数 group-by（千万级分组）
  - TPC-H 的 join 排序优化
  - 个别聚合函数实现（如 `corr` 相关系数）
  - **部分查询慢 2 倍以上**

> 🚫 **打假**：坊间流传的「DataFusion 是击败 ClickHouse / DuckDB / chDB 的最快单节点引擎」这一表述，与论文原文对不上、也无独立复现，属于去语境化的营销结论。真实情况是**与 DuckDB 处于同一量级、各有胜负**，不是碾压。而且这是**单核 + 2024 年**的数据，多核 / 多租户并发的生产场景未必一致——正因证据只覆盖单核、且论文有一定自证性质，本项定为中置信度。

### 摄入吞吐（官方单一来源，无第三方复现）

官方指引：**7–30 MB/s/vCPU 核心**（随配置变化）。

> ⚠️ **一个已失效的调优项，别照旧文档抄**：大量资料（含官方较早的性能指南）会让你开 `ZO_FEATURE_PER_THREAD_LOCK=true` 以达到约 23 MB/s/核。但该开关**已于 2025-09 被移除**——在当前版本（如 v0.91.1）设置它会被**静默忽略，不报错、也不生效**。等价能力已由 **`ZO_MEM_TABLE_BUCKET_NUM > 1`**（memtable 分桶，降低写入路径的锁竞争）接管。**照旧文档调优，你会得到一个「什么都没发生」的结果，还以为已经优化过了。**

> ⚠️ 该吞吐数据**仅有单一官方来源，无第三方复现**，因此定为中置信度。选型时务必用自己的数据实测。

---

## 四、成本真相：「140x 省钱」到底该信几分

这是全文最需要**祛魅**的部分。O2 最出圈的营销数字是「存储成本比 Elasticsearch 低约 140 倍」，我们把它拆开验证。

### ✅ 官方确实这么说（官方文档原文确证）——但绑定了三个前提

官方文档原文确有 **「~140x lower storage cost vs Elasticsearch」**，但它自带三条死死绑定的前提条件：

1. **仅指存储成本**，不含计算 / 查询成本（原文：*「This cost comparison pertains only to storage」*）
2. **前提是不开启全文倒排索引**（原文：*「does not do full-text indexing」*）。一旦开启全文检索，**额外约 +25% 存储开销**，并吃掉部分压缩收益
3. 官方自己声明「结果取决于你的日志可压缩性」。更关键的是：**O2 自家在 1.1 TB 更大规模的实测中得到的是 87x，而非 140x**（因 Elasticsearch 因字段类型映射冲突拒收了 62% 文档导致原始对比失真，剔除后的「公平对比」值是 87x）

**结论：140x 是一个理想条件下的上限值，不是可跨场景通用的承诺。做预算时，请以「开启全文索引的真实倍数」为准——而这个数字目前没有可靠公开数据（详见下节）。**

### 🚫 被证伪的营销话术清单

以下说法经核验站不住脚——要么与官方文档自带的前提矛盾，要么只有厂商单方面自证、无任何独立来源支撑，**引用它们会损害你的可信度**：

| 被证伪的声明 | 证伪依据 |
|---|---|
| 「140x 更低存储成本」作为无条件结论 | 官方原文明确限定「仅存储、不开索引」，去掉前提即失真 |
| 「查询性能比 ES 更好且只用 1/4 硬件」 | 仅厂商自证，无独立复现 |
| 「全文检索性能提升 1000x」 | 无法复现，来源单一 |
| 「摄入比 ES 快 5–10x」 | 仅官方文档单方面声明 |
| 「真实 Kubernetes 场景 140x」 | 场景与前提不符，证据不足 |

### 开启全文索引后的真实成本：依然空白（低置信度）

追查「生产上开启 Tantivy 全文索引后，相对 ES 的真实存储倍数」，结果是**没有任何独立第三方做过这个计算**。

- O2 的 stream 统计 API 确实单独暴露了 `index_size` 字段（与 `storage_size`、`compressed_size` 并列），理论上用户可自行采集数据算出开销比例，但**至今无公开案例这么做过**。
- 一条**警示信号**：GitHub issue #5224 的示例数据中出现 `index_size(7327) > compressed_size(6139)`，即**索引体积反超压缩后的数据体积**（>100%），与官方「仅增约 25%」的说法明显出入。**但该数据来源/单位/代表性均不明，不足以采信**——它不能证明什么，只能作为「必须自测」的又一个理由。
- 官方博客一篇「49s→2s 提升 25 倍」的调优案例（归因于调大 `ZO_COMPACT_MAX_FILE_SIZE`、减少 S3 小请求数），其**具体数字仅厂商单方面自证、无独立复现，不宜引用**。

> **净结论：开启全文索引后 O2 到底省多少 / 索引占多少，是全文最硬的空白。官方的 25%/87x/140x 全是自测、无第三方复现。做预算前，这是第一个必须 POC 的点。**

---

## 五、竞品横向对比：一个必须正视的「证据空白」

这一节**最重要的发现不是某个数字，而是数字的「不存在」**。

### 🎯 关键反向证据：官方承认没有对比数据（官方维护者原话，高置信度）

截至 2025 年 1 月，OpenObserve 官方维护者（prabhatsharma）在 GitHub Discussion #5662 中，面对「有没有 O2 vs ClickHouse 的性能对比」的提问，**公开明确回答「No. If you do one, then let us know.」**——覆盖范围明确包括日志/trace/metric 的**摄入、查询延迟、压缩比**。

这意味着：

> **本文第一节想要的「O2 vs ClickHouse/SigNoz 的 TCO、高基数点查延迟、聚合/join 延迟」对比，在公开资料中根本不存在权威数据源。** 不是我们没找到，而是官方自己确认它不存在。

对选型的直接含义：任何声称「O2 比 ClickHouse 快 X 倍 / 省 Y 钱」的说法，只要不是来自你自己的 POC，都不可信。

> ⚠️ 注意分寸：官方「没有官方对比」这一点有维护者原话确证；但不能把它放大成「整个社区都从未有过任何对比」的**全称否定**——那无法穷尽证明。准确表述是：**没有权威/可公开引用的对比基准，零散社区讨论存在但不可作为决策依据。**

### 运维复杂度对比：也没有可靠结论

坊间常说「O2 单二进制零依赖，比 SigNoz（ClickHouse + ZooKeeper 多容器）好部署」。就此检索的结果是**两头都站不住**：

- 「SigNoz 默认用自建 ZooKeeper 镜像、有兼容性坑」——issue 细节证据不足，不采信
- 「O2 零依赖所以更易运维」（HN 用户 GordonS 观点）——仅个人意见，不采信
- 反方观点也值得记一笔：有 ClickHouse 背景的评论者（sdairs）指出 **ClickHouse 新版已不再需要 ZooKeeper、单机部署无需协调组件**——即「ClickHouse 部署复杂」的老印象可能已过时。此条同样只是个人意见，但提醒你别用陈旧认知做判断。

**结论：运维复杂度对比同样缺乏可靠公开证据，需以你实际部署的版本为准实测。**

### 5.3 深入：O2 与 ClickHouse 存储引擎为什么「像」，以及 140x 的真相

一个绕不开的问题：O2 的存储逻辑（按 `_timestamp` 排序、part/文件 merge、zstd、列存）和 ClickHouse 的 **MergeTree** 高度相似。那 O2 凭什么号称 140x 压缩，而 CH 从没这种说法？

**答案是：在压缩这件事上，O2 对 CH 没有杀手锏。「140x」的分母是 Elasticsearch，不是 ClickHouse。**

#### 140x 里，真正来自「压缩算法」的部分很小

拆开这个数字，大头是 ES 的**结构性浪费**，而非 O2 的压缩魔法：

| 140x 的来源 | 贡献 | CH 有这个浪费吗 |
|---|---|---|
| ES 保留整份 `_source` 原文冗余 | 大 | ❌ CH 也是纯列存，无此冗余 |
| ES 默认全字段倒排 + doc_values + norms | 大 | ❌ CH 默认也不建倒排 |
| ES 常 1 主 + 2 副本（3x 放大） | 中 | ❌ CH 副本可控 |
| 列存编码 + zstd（真正的「压缩」） | **中** | ✅ **CH 完全有，且更强** |

只要是正经列存（CH / DuckDB / Parquet 系）拿去和默认 ES 比日志存储，都能打出几十倍差距。**O2 在这一点上不特殊。** 这也解释了为何 O2 官方从未发布 vs ClickHouse 的对比（维护者已在 #5662 承认不存在）——一旦分母换成 CH，故事就讲不动了。

#### 论压缩工具箱，CH 反而比 O2 更能打

| 能力 | O2 | ClickHouse |
|---|---|---|
| 按 key 排序 | 仅 `_timestamp`，写死 | `ORDER BY` 任意多列、用户可控 |
| 时序专用编码 | delta_binary_packed（单一） | Delta / DoubleDelta / Gorilla / T64 任选 |
| 低基数字符串 | Parquet dictionary（row group 局部） | `LowCardinality` 全局字典 |
| per-column 编码 | ❌（除时间戳外基本没有） | `CODEC(Delta, ZSTD(3))` 逐列手调 |
| zstd 级别 | 写死（默认 ~1） | 可调 |

O2 是「吃 Parquet 默认行为 + 一个时间戳特化」；CH 允许**逐列手工指定最优 codec**。**调优到位的 CH schema，压缩率通常 ≥ O2。** CH 做不到 140x，不是压不动，而是没人拿它去和裸奔的 ES + 最软的数据比着发营销稿。

#### ⚠️ 压缩率是「数据熵」的函数，不是引擎的固定属性 —— 一个真实教训

**两组实测**（均为同一份数据分别灌 O2 与 ClickHouse，**功能对等：两边都建全文索引**）。

**第一组：官方样例 k8s 日志（8.40 MiB / 3,846 行）**

| 方法 | 数据 | 索引 | **合计** | 说明 |
|---|---|---|---|---|
| `zstd -19` 单文件 | 53.4 KiB | — | 53.4 KiB | 通用压缩极限（O2 的 level 写死、用不到） |
| `zstd -1` 单文件 | 79.3 KiB | — | 79.3 KiB | 与 O2 默认 zstd level 对齐 |
| **O2** | 80 KB | 100 KB | **184 KB** | 数据部分几乎等于 `zstd -1` |
| **ClickHouse** | 70.53 KB | 132.02 KB | **202.55 KB** | 数据更小，但索引开销更重 |

- **O2 的列存净增益 ≈ 0**：数据部分 80 KB 与 `zstd -1` 的 79.3 KiB **几乎逐字节相同**——列式编码省下的，恰好被 Parquet 元数据 + 小文件固定开销吃掉。**O2 的「压缩」 = 一个 `zstd -1` 命令。**
- **O2 主动放弃 34% 压缩空间**：`zstd -19` 能到 53 KiB，但 O2 的 level 写死 ~1，**你想调都没入口**。
- **这一局 O2 略胜**（184 KB vs 202.55 KB）：小数据量上 CH 的全文索引开销更重（132 KB，是其数据的 1.9 倍），把 CH 数据侧的优势吃掉了。

**第二组：真实大数据 github events（27.3 亿行 / 54 列）**

| 方案 | 数据 | 索引 | **合计** | vs O2 |
|---|---|---|---|---|
| **O2（全文索引）** | 174.64 GB | 45.14 GB | **219.78 GB** | 基准 |
| **CH `text_zstd_split`（功能对等）** | 117.32 GB | 46.80 GB | **164.12 GB** | **小 25%** |
| CH `ngram` | 105.64 GB | 12.23 GB | 117.87 GB | 小 46% |
| CH 无二级索引 | 105.58 GB | 0 | 105.58 GB | 小 52%（但无全文检索） |
| **CH `text`（默认全文索引）** | 106.05 GB | **417.81 GB** | **523.86 GB** | **大 138%** |

三个关键结论：

1. **「压缩率倍数」是个陷阱，只能比绝对磁盘占用。** 同一份数据：O2 报「3.08 TB → 174.64 GB ≈ 18x」，CH 报「792.69 GB → 105.58 GB ≈ 7.5x」——看似 O2 压缩率是 CH 的 2.4 倍，**但 CH 落盘更小**。差别全在分母，而 O2 这个分母的口径经源码核实后相当微妙：

> **⚠️ 一个误导性的字段名**：O2 UI 上的「采集数据 / Ingested Data」对应 `StreamStats.storage_size`，但**这个字段与「存储」无关**——源码 `add_file_meta()` 里 `self.storage_size += meta.original_size`，它累加的是 `original_size`；真正的落盘字节数在 `compressed_size`。
>
> 而 `original_size` 的定义是：**对 flatten 之后的记录调用 `serde_json::to_vec()` 得到的 JSON 文本字节数**（链路：`flatten_with_level()` → `Entry.data_size` → `RecordBatchEntry.data_json_size` → `FileMeta.original_size` → `StreamStats.storage_size`）。

这个口径与 CH 的 `data_uncompressed_bytes`（列式二进制未压缩值）有四项结构性差异：

- **key 名逐行重复**：`serde_json` 不做跨记录 key 去重，54 个字段名在 27.3 亿行里各重复一次；CH 的列名只在 schema 里存一份。
- **flatten 还会把 key 拉长**：嵌套 `a.b.c` 被拼成 `a_b_c`（如 `payload_commits_message`）——**因此这个「采集数据」甚至可能大于你实际上传的原始 JSON 文件**。
- **JSON 语法开销**：`{}`、`:`、`,`、引号。
- **数字文本化**：一个 int64 在 JSON 里是 10~19 个 ASCII 字符，CH 列式定宽只需 8 字节。

**所以「分母越虚、倍数越好看」不只是营销话术，它已经内建在产品 UI 的统计口径里。** 更关键的是：**O2 并未暴露任何「列式未压缩大小」的统计量**（`FileMeta`/`StreamStats` 中没有这一项），你无法用它自带的数据构造出与 CH 对等的未压缩基线——**唯一诚实的比较，仍然是绝对落盘字节数。**
>
> 诚实的边界：上述四项各自贡献多少百分比，源码层面无法定量拆解，只能确认方向与数量级合理。
2. **功能对等下 CH 胜 25%，而且差距全在数据列。** 索引两边几乎一样（O2 45.14 GB vs CH 46.80 GB），但数据列 **CH 117.32 GB vs O2 174.64 GB——CH 小 33%**。这才是 CH 列存编码（LowCardinality 全局字典 + per-column codec + `ORDER BY` 聚类）在真实高熵数据上的实打实增益，也正是 O2「排序键写死、不能逐列调 codec」的代价。
3. **CH 提供的是一整套索引技术光谱，O2 只有一个固定方案。** 上表那几种 CH 索引并非「同一方案的参数调优」，而是**不同技术、不同取舍**：

| 索引方案 | 索引大小 | 精确性 | 支持的查询 |
|---|---|---|---|
| CH `ngrambf_v1` | 12.23 GB | **概率型**（有假阳性，须回表验证） | 子串剪枝 |
| CH `text(splitByNonAlpha)` | 46.80 GB | 精确 | token 匹配，可 direct read |
| CH `text(ngrams(5))` | **417.81 GB** | 精确 | **子串匹配**，可 direct read |
| CH 无二级索引 | 0 | — | 全表扫描 |
| **O2（Tantivy）** | **45.14 GB** | 精确 | token 匹配 |

两个要点：

- **「精确子串匹配」是全场最贵的能力**：`ngrams(5)` 的组合爆炸让索引膨胀到数据的 4 倍（417.81 GB vs 106.05 GB）。想省空间就得退回 `ngrambf_v1`（12.23 GB）接受假阳性，或退回 token 语义（46.80 GB）放弃子串。
- **O2 的索引效率并不差**：45.14 GB 与同语义的 CH `text(splitByNonAlpha)`（46.80 GB）几乎相同——**O2 的 Tantivy 倒排是合格的，它在大数据上落后的那 55 GB 全部来自数据列**（174.64 vs 117.32 GB），而非索引。

> 所以真正的差距是**选择权**：CH 让你在「0 → 418 GB」这条光谱上按「要不要子串、能不能容忍假阳性、给多少空间预算」自行取舍；**O2 把你固定在一个点上——既不能用概率型索引换空间，也不能升级到精确子串匹配。** 这就是「曲线 vs 点」的真正含义。

> ⚠️ 诚实提醒：小数据量上 O2 略胜（CH 索引开销占比过高），大数据量上 CH 反超（列存编码优势显现）。**所以「谁压得更小」没有普适答案，取决于数据规模、是否需要全文检索、以及你会不会调 CH。** 唯一可确定的是：**O2 没有压缩上的护城河**——它的数据侧约等于 `zstd -1`，而调优到位的 CH 能比它小 25~46%。

**真实生产日志会把压缩率拉回个位数~十几倍**（大量高基数字段：trace_id、user_id、IP、request body），O2 与 CH 双双回落，且高基数恰是 O2 相对 CH 的弱项。**样例的百倍级压缩是「最好情况」，生产是「最坏情况」，选型必须按后者算。**

#### 更关键的：压缩率是一条 trade-off 曲线，不是一个数字

ClickHouse 官方一篇 nginx 日志的稿子（*Compressing nginx logs 170x with column storage*, 2025-10）给了决定性佐证，它把**整条压缩曲线**摊开——数据集 20GB / 66.75M 行 nginx access log：

| 阶段 | 压缩率 | 做法 |
|---|---|---|
| LZ4 裸压 | 20x | 通用压缩 |
| GZIP 裸压 | 31x | 通用压缩 |
| **ZSTD(3) 裸压** | **38x** | 通用压缩（关键：裸压就吃掉大半） |
| 仅拆列 | 56x | 结构化成各字段列 |
| **极致调优** | **178x** | IPv4/UInt 类型 + LowCardinality + 逐列 codec（时间戳 Delta(4)+ZSTD(1)、字符串 ZSTD(6)）+ ordering key 按 (referer, user_agent…) |
| **按时间排序（甜点）** | **~50x** | ordering key 改 `toStartOfDay(time)` 打头，查询友好 |

两个决定性结论：

1. **CH 压缩天花板 178x > O2 的 140x**，直接证伪「CH 压缩弱」——CH 从不拿这个数字营销而已。
2. **压缩率是一条 trade-off 曲线，不是一个数字。** CH 官方诚实指出：178x 那套 ordering key *「may not always be ideal for query performance」*（对查询未必理想）；现实中查询多按时间过滤，改按时间排序后压缩率降到 **~50x**——这才是「既能查又能省」的甜点区。

极致压缩靠精心的 ordering key + 逐列高 level codec——**省空间是拿查询性能换的**。于是关键问题变成：

> **O2 递给你一个 140x 的点，却从不告诉你它在这条曲线的哪一段——是甜点，还是「几乎无法用」的极限？**

而且 O2 的处境比 CH 更被动：

- **CH 给你一整条曲线**：压缩级别、index_granularity、codec 全可调，你能自己挪到甜点区。
- **O2 把你钉在一个点上**：zstd 级别写死（默认 ~1）、编码走 Parquet 默认、不能逐列调——**140x 那个点你挪不动。**

结合 O2 高基数查询弱、对象存储查询延迟、metrics 曾 OOM 的既有结论，**O2 的 140x 很可能偏向「压得不错但查询一般」那一段，且不可调。** 这是一个必须实测证实/证伪的假设。

#### 那 O2 相对 CH 的真正差异化在哪（不在压缩，在架构）

1. **对象存储原生 / 存算彻底分离**：O2 生来把 S3/GCS 当主存，存储成本 = 对象存储单价（远低于 CH 传统的本地盘/EBS）。**这才是「省钱」叙事的真正底座——不是压得更狠，而是存得更便宜。**
2. **schemaless 零建模**：O2 自动推断列、默认配好排序/分区；CH 要手写 DDL、选 ORDER BY / codec / 分区键——压缩到极致的前提是「你得会调」。
3. **单二进制 / 运维极简**：O2 一个 binary 起步；CH 集群要操心分片、副本、Keeper、merge 风暴、schema 迁移。

反过来，**CH 的优势**：高基数聚合/join/点查性能更强、压缩可调上限更高、生态更成熟。

#### 小结（选型判断）

> O2 和 CH 的存储引擎是**近亲**（排序 + merge + 列存 + zstd 同一套物理学）。O2 没有、也不需要在压缩率上超越 CH——140x 是 ES 的臃肿衬托出来的。**O2 的卖点是「对象存储主存 + schemaless 开箱即用 + 单体运维」这套成本与复杂度结构，不是压缩魔法。**
> - 诉求是「极致压缩 + 强查询」且不怕调优 → **ClickHouse** 更硬
> - 诉求是「零建模 + 低运维 + 对象存储直接省钱 + 日志为主」 → **O2** 更省心
>
> **已有初步实测**：上述 8.4 MiB 样例中，CH（含全文索引，122x）已大幅超过 O2（数据+索引，47x）——「CH 压缩更优」不再是理论假设。**仍需复验的是幅度而非方向**：换**大数据量 + 真实高基数生产日志**（trace_id/user_id 密集）再测一轮，确认 CH 的领先在你的数据上是放大还是收窄。

---

## 六、全文检索如何在对象存储上生效（源码级）

这是 O2 架构里技术含量最高的部分之一，也是一个天生矛盾的命题：**Tantivy 倒排索引查询靠大量随机 seek，而对象存储随机读延迟高、索引体积还常比数据大**。O2 的解法相当精细（均源码确证 🟢）。

### 索引在哪、何时生成

- **索引上对象存储**：`.ttv`（Puffin 容器格式）与 Parquet 走同一 `storage::put`，同 ID、同分区路径，只是目录段 `logs/` → `index/`，**1:1 确定性关联**（查询端纯字符串算出索引路径，无需查表）。
- **只在 compaction 阶段生成索引**（`create_tantivy_index` 唯一调用点在 `merge.rs`）。⚠️ **含义：刚写入、未 compaction 的实时数据没有倒排索引，全文检索退回全表扫描**——查最近几分钟日志时全文检索无索引加速，对实时排障是真实影响。

### 性能组合拳

1. **`footer_cache` 预计算（最精巧）**：compaction 建索引时，预先把「打开索引所需的全部元数据读取」touch 一遍、固化成一个独立 blob 打进 Puffin。查询时一次 range GET 取回，**把 Tantivy 冷启动的多次随机读预计算掉了**。
2. **Puffin footer + range GET**：读末尾 4KB 拿到所有 blob 的 offset/length，各段按精确字节范围读，绝不整文件下载；footer 解析进进程级缓存（默认总内存 5%，clamp [100MB,1GB]），同文件后续零 IO。
3. **`warm_up_terms` 并行预热**：查询涉及的所有 term postings / fast field 一次性并行发起（`tokio::try_join`），避免顺序 seek 的延迟叠加。
4. **两段式 + 智能放弃**：常规是「索引返回 row-id 位图 → 回读 Parquet 对应 row group」；count/histogram/top-n/distinct 走「索引直接出结果、不回读 Parquet」旁路；**命中率 >35%（`inverted_index_skip_threshold`）就放弃索引退回全扫描**，避免「索引+扫描」双开销。
5. **分层剪枝**：min-max/分区（文件级，最粗）→ bloom filter（文件级，等值向）→ tantivy（行级）。
6. **四层缓存**：进程级 footer 缓存 / querier 文件缓存（磁盘默认开、内存默认关，`.ttv` 与 `.parquet` 共享）/ 查询结果缓存（默认 1 万条）/ 单次查询 byte-range 缓存。

### 代价与瓶颈（诚实）

- **🔴 top-n 旁路会静默丢数据，最严重实测丢 70.67%**。上面第 4 条提到的「top-n 走索引直接出结果」旁路，在查询跨文件较多时会**静默返回不完整的聚合结果**——不只是计数偏小，**整个分组会从结果里消失**。

  **触发条件低得惊人**：`is_simple_topn`（`index_optimizer/topn.rs`）只要求 GROUP BY 字段属于该 stream 的 `index_fields`，**连 `match_all()` 都不需要**。也就是说，一条最普通的 `GROUP BY level ORDER BY count DESC LIMIT 100`，只要 `level` 建了索引就会走这条路。查询命中时 O2 日志里可见 `TantivyOptimizeExec`。

  实测数据（27.3 亿行 GitHub Events，`index_fields=[event_type, repo_name]`，`event_type` 实际只有 **12** 个不同值）：

  | 查询跨度 | 文件数 | 返回分组数 | 行数覆盖 |
  |---|---:|---:|---:|
  | 1 小时 | 4 | 12 | **100.00%** ✅ |
  | 6 小时 | 24 | 12 | **100.00%** ✅ |
  | 1 天 | 96 | 12 | **100.00%** ✅ |
  | 7 天 | 757 | **7** | **82.87%** ❌ |
  | 31 天 | 4,125 | **3** | **29.33%** ❌ |

  **31 天的查询，12 个事件类型只返回了 3 个，行数少了 70.67%，而 `is_partial=false`。**

  **提高 LIMIT 只能缓解，没有安全阈值**（同为 31 天范围）：

  ```
  LIMIT  100 →  3 组  29.33%       LIMIT 1000 →  6 组  68.84%
  LIMIT  500 →  5 组  46.43%       LIMIT 2000 →  9 组  93.13%   ← 仍然错
  LIMIT  999 →  6 组  68.80%
  ```

  所需 LIMIT 随文件数增长：757 文件时 LIMIT 1000 已足够，4,125 文件时 2000 仍不够。**而你无法事先知道该设多大——要知道，就得先知道正确答案。**

  相关源码：`src/config/src/tantivy/query/topn_collector.rs` → `TopNSegmentCollector::harvest`，其中超过 `ZO_INVERTED_INDEX_TOPN_MAX_GROUP_NUM`（默认 1000）时调用 `select_top_k_dense()` 只保留本文件局部 Top-K，注释自述 「the merged top-n becomes approximate」。**但实测表明实际丢失比该阈值所能解释的更严重**（`event_type` 仅 12 组，远低于 1000，却照样丢失），完整机制需由官方定位。

  **两个必须排除的误解**（都是我们实测排除的）：
  - **与对象存储无关**。同一实例上换成非索引字段（`actor_login`）分组，结果 100% 正确；本地盘实例因未配 `index_fields`，同样 100% 正确。变量是索引配置，不是存储后端。
  - **与 compaction 滞后无关**。查 `file_list` 元数据，该流 **205,835 个文件的 `index_size` 全部 > 0，索引覆盖率 100%**，没有任何文件缺索引。

  **最麻烦的是它不上报**：`is_partial` 的赋值链（`cluster/flight.rs` → `cluster/http.rs` → `Response::set_partial`）里，`partial_err` 只有两个来源——搜索超时/取消、返回行数超默认展示上限。**降级路径唯一的痕迹是一条 `log::debug!`**，默认日志级别看不见。

  > 这不是孤例。官方 issue **#6311**（2025-03-19，至今 open）报告 `is_partial` 在 VRL 函数报错时同样不置位，2026-05-06 验证评论写着 **「Root cause — STILL UNFIXED」**。**`is_partial=false` 作为「结果完整」的承诺，目前在至少两条独立路径上失效。**
  >
  > 该实现自 PR #12574（2026-06-11）重写后未再改动，**v0.93.0 与 v0.91.1 字节级相同，仍未修复**。已上报官方：[openobserve/openobserve#13363](https://github.com/openobserve/openobserve/issues/13363)。
  >
  > **实际杀伤面**：按日志级别、服务名、状态码、事件类型分组，是可观测性最基本的查询，而 `index_fields` 恰恰就是官方建议给这类字段配的。**两个推荐做法叠加，产出静默错误的结果，且查询范围越大错得越离谱。**「查最近 30 天各服务的错误分布」这种场景，你会拿到一个少了 70% 的图表，没有任何警告。

- **实时数据无索引**（见上）——全文检索的最新数据反而最慢。
- **索引不压缩 + 与数据共享缓存池**：Tantivy 段文件（`.term/.idx/.pos/.fast`）完全不压缩（这是 `index_size > data_size` 的结构性根因），而 `.ttv` 与 `.parquet` 共享同一 querier 本地缓存池 → **索引又大又不压缩，吃缓存、和数据争空间**；高基数全文字段场景，缓存压力与内存/OOM 风险被放大（与第九章内存/OOM 一节相互印证）。
- **无索引热节点/独立缓存优化**：索引与数据都由承担查询的 querier（follower）按需拉取到本地算，缓存冷时性能回落到对象存储延迟。

### 选型判断 + POC

O2 的对象存储全文检索**工程认真、非玩具**，但性能强依赖三条件：**① compaction 已完成 ② querier 本地缓存够大 ③ 查询选择性高（>35% 命中即退化）**。

**POC 必测**：① 清空 querier 缓存后的**冷查询延迟**（对象存储延迟的真实暴露）；② **实时数据（未 compaction）全文检索**延迟 vs 已 compaction 数据；③ 大量高基数全文字段下 querier 缓存是否被挤爆、OOM 风险；④ **高基数 `GROUP BY` 的聚合结果正确性**——拿一条已知答案的查询对拍，别只看延迟。

> **④ 这条是后来补上的，因为我们真的踩到了。** 前三条测的都是「快不快」，而 top-n 近似降级测的是「对不对」——**后者一旦出问题，前者毫无意义**。跨引擎 POC 如果只比耗时不比结果，会把一个正确性缺陷读成「O2 聚合还挺快」。

---

## 七、HA 架构与分布式正确性（源码级）

O2 存算分离的分布式设计，正确性做得相当正规，但也暴露了「零依赖」叙事的边界。以下均源码确证 🟢（少量标 🟡）。

### 节点角色与协调层

- **角色**：Router（入口）/ Ingester（写、持本地未上传数据）/ Querier（查）/ Compactor（合并+建索引）/ AlertManager / FlattenCompactor / ActionServer，可独立扩缩。
- **协调层 = NATS**（代码里 etcd 已零痕迹）；**集群元数据库强制 PostgreSQL**（单机才用 SQLite，MySQL 已弃用）。
- **一致性哈希只管 Querier/Compactor 调度，不管 Ingester 写入**；其用途是**缓存亲和**——把同一 stream 的查询稳定路由到同一 querier，让本地索引/数据缓存热起来（与全文检索那盘「缓存命中率」棋是同一逻辑）。

### 分布式 schema 一致性：不靠「祈祷各节点一样」

- schema 存**中心 Postgres**，各节点只有 cache；改 schema → 写 Postgres → **NATS watch 广播** → 各节点回源拉取刷新（有短暂窗口，会收敛）。
- **并发演进不冲突**：`handle_diff_schema` 可见的锁只是进程内 `tokio::Mutex`；真正的跨节点互斥在底层 `get_for_update`——**Postgres advisory lock 或 NATS dist_lock，是货真价实的分布式锁**。
- **历史文件异构**（数据质量的真实形态）：不同 parquet 写入时 schema 版本不同，靠**版本化 schema（start_dt/end_dt 时间窗）+ 读时 union 补 null + widening 类型提升**兼容，查询以 `STREAM_SCHEMAS_LATEST` 并集为准。

### 实时查询：WAL + memtable 都可查（做得好）

- **默认 scatter-gather**：每次查询同时下发 querier + ingester，ingester 把本地未上传数据纳入。
- **memtable 可查**（`search_memtable()` 直读内存），**实时性边界几乎是「当下」**，不用等落盘（可用 `feature_query_skip_wal=true` 关掉换速度）。
- **三层防重复/防漏**：memtable_id 匹配 + pending_delete 过滤 + 查询期文件锁。
- 协议是**自定义 gRPC（tonic+protobuf）**，非字面 Arrow Flight（代码借用了 「flight」 命名）。

### compaction 在对象存储上进行——正确性扎实，但成本真实

**流程**：compactor 从 file_list(Postgres) 查小文件 → **全量下载到本地**（GET×N）→ DataFusion 排序合并 → **上传大文件**（PUT）→ **重建 .ttv 索引并上传**（又一次 PUT）→ file_list 事务切换。

- **正确性**：一次事务性 `batch_process` 同时「新文件登记 + 旧文件软删除」，物理删除交延迟 GC，加上「先 put 大文件、再切元数据」——**任意时刻查询看到的文件都真实可读**，不会读到「合并中/已删 404」。
- ⚠️ **成本（营销从不提）**：每轮 compaction = 全量字节 GET + 全量字节 PUT，**且数据和索引各一次**。这是对象存储上的**写放大**，叠加 PUT/GET/**LIST** 请求计费。**写多查少的冷数据，compaction 是纯亏。**
  - 但也要公平看：不 compaction，成本转移到查询侧并放大（小文件多 → 每次查询 GET 数爆炸，O2 官方「49s→2s」调优主因正是把单查询 S3 请求从 1 万+ 降到 ~600）。**compaction 是「一次写放大换多次查询请求下降」的摊销，数据查得越多越划算。**

### 关键选型洞察：HA 打破「零依赖」神话

> **O2「单二进制零依赖」只在单机成立。上 HA 集群，必须运维 PostgreSQL（元数据）+ NATS（协调层）两个外部依赖。**

| | 单机 | HA 集群 |
|---|---|---|
| O2 | 真零依赖（SQLite+内置） | **+ PostgreSQL + NATS** |
| SigNoz | ClickHouse | ClickHouse + ZooKeeper/Keeper |

关于「O2 vs SigNoz 谁运维简单」，公开讨论没有定论；源码给了准确答案：**「运维更简单」主要成立在单机/小规模，上生产集群两边都有各自的分布式依赖要养。**

### TCO 的完整账（更新）

| 成本项 | 140x 算了吗 | 真实情况 |
|---|---|---|
| 存储容量费 | ✅ | 确实省（对象存储单价 + 高压缩） |
| 请求费 PUT/GET/**LIST** | ❌ | 摄入 + compaction 写放大 + 查询都在产生 |
| compactor 计算/内存/网络 | ❌ | 持续后台开销，吃内存（回到 OOM 账） |
| querier 本地缓存盘/内存 | ❌ | 为不让查询被对象存储延迟拖垮 |
| **HA 依赖（Postgres + NATS）运维** | ❌ | 集群模式的固定成本 |

**真实 TCO = 存储费（省）+ 请求费 + 计算/缓存资源 + HA 依赖运维。** 写多查少、高 stream 数、高频摄入场景，后几项会显著侵蚀「140x」的光环。**POC 务必打开对象存储 request metrics 实测请求费——那是营销数字里的暗物质。**

---

## 八、UPDATE / DELETE：append-only 模型（源码级）

高压缩列存 + 不可变 Parquet + 对象存储，注定了 O2 对修改/删除的态度。均源码确证 🟢。

### UPDATE：完全不存在

- **没有任何行级 UPDATE**。ES 兼容 bulk 接口里的 `update` action 只是**表层兼容**——实际走 index/create 路径（新增一行），`_id` 从不用于定位/覆盖旧记录。
- ⚠️ **迁移坑**：ES bulk 的 `delete` action **O2 根本不识别、直接静默跳过**——不删数据也不报错。从 ES 迁移复用带 delete 的 bulk 客户端，会以为删成功、实际啥也没发生。
- `update_fields`/`delete_fields` 是纯 schema 元数据操作，不碰已写数据。

### DELETE：三种粒度，全是「整文件级」——所以便宜

| 粒度 | 支持 | 实现 |
|---|---|---|
| retention 按期自动删 | ✅ | 整文件软删除 + 批量对象存储 DELETE |
| 按 stream 全量删 | ✅ | 同上 |
| 按时间范围删 | ✅ 但**强制对齐分区边界**（小时级要整点） | 同上 |
| **条件删除 / 行级 / 按 user_id** | ❌ **完全不存在** | — |

能删的这几种成本都极低——**整文件 `DELETE`，从不「下载-过滤-重写」**，DELETE 请求还免费。**与高压缩率完全不冲突**（删整个文件，不碰内容），反而是绝配。

### 行级删除：不是「贵」，是「没有」

要删单/少数行，O2 **没有任何官方 API**。只能自己手写「迷你 compactor」（下载→解压→过滤→重压→上传→重建索引），**成本≈一次完整文件重写，且要自建事务/并发保护**。

### GDPR 场景无解 🔴

想删「某 user_id 的所有历史数据」——**O2 做不到**。分区键通常是时间不是 user_id，目标用户数据与他人混在同一批文件里：要么连带删掉同时间窗所有用户数据，要么无法精确删除。**有合规删除需求，这是硬伤。**

### vs ClickHouse

| 能力 | ClickHouse | O2 |
|---|---|---|
| 整分区删除 | `DROP PARTITION` | ✅ 等价 |
| 行级删除（重写 part） | `ALTER TABLE DELETE` mutation | ❌ 无 |
| 行级标记删除 | lightweight delete 位掩码 | ❌ **连这个都没有** |
| merge 时去重/替代 update | `ReplacingMergeTree` / `CollapsingMergeTree`（insert 新版本 → merge 去重 → `FINAL` 查询） | ❌ **无任何特殊 merge 引擎** |

O2 是比 CH 更纯粹的 「only append + coarse-grained purge」 模型。

### 连「insert + replace 去重」的路都没有

CH 事实上的 upsert 路径是「insert 新版本 → `ReplacingMergeTree` 在 merge 时按排序键保留最新 → 查询 `FINAL`/`argMax` 收敛」。**O2 没有这条路**：compaction 的 merge SQL 是纯粹的 `SELECT * FROM tbl ORDER BY _timestamp DESC`，**没有任何按键去重/折叠逻辑**；`ReplacingMergeTree`/`CollapsingMergeTree`/`AggregatingMergeTree` 家族 O2 一个都没有对应物。

这其实是**必然**：ReplacingMergeTree 去重的前提是「按业务主键排序，merge 相邻同键去重」，而 **O2 物理排序键写死 `_timestamp`、不能设成业务主键**（见 §2.5）——连「按业务键排序」都做不到，去重引擎无从谈起。排序键不可配置这个限制，直接堵死了去重的可能性。

> **选型结论**：
> | 数据语义 | 适配 |
> |---|---|
> | 纯事件流（日志/指标/追踪，天然 append-only） | ✅ O2 设计甜点 |
> | 需要 upsert / 去重取最新（CDC、状态表、维度表、去重日志） | ❌ **架构根子上出局**，只能查询时 `argMax`/`GROUP BY` 自己去重（查询开销，非存储去重） |
> | GDPR/CCPA 合规删除、修正错误数据、按业务维度删除 | ❌ 硬伤，只能整 stream 重建或等分区过期 |
>
> 上生产前务必确认：你的数据是**纯 append-only 事件**，还是**需要更新/去重的实体**——后者 O2 直接出局，这不是配置问题，是架构定位。

---

## 九、扩展性与成熟度：一个仍在快速迭代的产品

### 9.1 多核扩展性：唯一的高质量学术证据（SIGMOD 2024 论文）

本文**质量最高**的一份证据来自 SIGMOD 2024 论文（Lamb et al.），它对 DataFusion 与 DuckDB 做了 **1 至 192 核**的扩展性测试（GCP c3-highcpu-176 实例）：

- **1–32 核**：两者均近乎**线性扩展**，执行时间随核数下降，表现良好
- **64 / 128 / 192 核**：部分查询（Q11、Q14、Q32）出现**随核数增加反而变慢**的现象，作者归因于核间协调开销相对增大
- 总体结论：DataFusion 的模块化 + 拉取式调度并未妨碍达到业界领先的多核性能，扩展曲线与 DuckDB 形状相似

> ⚠️ **两个关键边界**：(1) 该测试仅对比 **DataFusion vs DuckDB 两个单机嵌入式引擎**，**完全不涉及 ClickHouse，也不涉及多租户并发**；(2) 论文作者含 DataFusion 核心开发者（InfluxData），有一定自证性质。因此**不能外推**到「O2 在多租户生产环境下并发查询表现如何」——这仍是未解问题。

同时，那条常被引用的「DataFusion 是最快单机 Parquet 引擎（超过 ClickHouse/DuckDB/chDB）」的排名结论**站不住脚**——它来自 16 核单机 ClickBench，既不能证明并发场景，排名结论也缺乏独立支持。

### 9.2 已实证的生产坑

**① metrics 查询 OOM（GitHub issue/PR 确证）**：截至 2024/12，metrics 查询路径一次性全量加载数据入内存，存在 OOM 风险；2025/01 的 PR #5584 已改为分批读取修复。

**② 内存/OOM 是设计特征，非孤例（源码 + 多个 issue 印证，中置信度）**：O2 **默认为搜索预留约 50% 可用内存**（`ZO_MEMORY_CACHE_MAX_SIZE`，可配）。当**搜索与 compaction/批处理并发**时，两者内存叠加可能触发 OOM。该模式从 2023（v0.4.7）到 2024（discussion #2711 有真实 cgroup OOM kill 日志）持续存在并被逐步修补——**这是一个需要为查询与后台合并预留内存冗余的架构特征，不是一次性 bug。**

> 🚫 **但具体倍数全是传闻**：社区流传的「需约 10x 内存」「O2 内存占用是 Grafana 的 10 倍」「4 核 4GB 跑 25 亿条 OOM」「compactor = 单文件上限 × CPU 核数×2」等**具体数字均出自单一用户报告、无第二来源印证，不足采信**。**可靠的只有定性结论：并发场景存在 OOM 风险，需预留内存冗余；具体阈值必须自测。**

**③ 版本升级破坏性变更（GitHub discussion，2023 年，注意时效）**：2023/09，用户从 O2 **0.5.2 直升 0.6.2** 后，两个数据流（16.18GB）在 UI 中「消失」。官方确认根因是 `metadata.sqlite` 需迁移适配 0.6.x 结构变更，直接跨版本升级会**跳过必要迁移步骤**，且**无明确报错**（底层数据未真正丢失，是 UI 层不可见）。

> ⚠️ 该案例是 **2023 年早期版本**（0.5→0.6），不能直接推断 2026 年当前版本仍有同等风险。它的价值是提示一个模式：**O2 历史上有过需人工干预、且静默无报错的破坏性升级——制定升级路径时务必查迁移文档、勿跨版本直升。**

### 9.3 高基数点查：说法未被证伪也未被证实

「Parquet on 对象存储对高基数点查（按 trace_id 精确定位单条）不友好」是业界常见说法。核查结论是：**DataFusion 官方 object store 架构文档完全不涉及延迟/点查/高基数性能**，既无法证实也无法证伪。**这属于确凿的证据空白，只能靠 POC（对比 trace_id 精确定位查询在 O2 vs ClickHouse 下的 P50/P99）来回答。**

### 9.4 生产采用规模：PB 级案例「存在」，但证据几乎全是厂商自述

「业界有没有上百 TB/PB 级生产案例」是评估成熟度的关键。截至 2026 年检索：

**厂商声称的规模（低-中置信度，几乎全是自述）**：
- 创始人 Prabhat Sharma：最大客户 **2.5 PB/day**；官方口径 6000+ 组织、**5 个 Fortune 100**、银行/政府、**单集群 100+ TB/day**、>2 PB/day。
- 单节点基准 ~31 MB/s（Apple M2）≈ 2.6 TB/day，PB 靠 ingester/querier/compactor 水平扩展 + Super Cluster 多区域联邦。

**最可信的一条证据，是个踩坑故事（中置信度，间接佐证）**：
- O2 最大客户在 PB 级部署时撞上 GCP 一个**未文档化的限制**——GCS 单 bucket 单 project 每天读取上限 1 PB，只能拆多 project/bucket 绕过。这种「踩到云厂商未公开限制」的技术细节编不出来，**间接证明 PB 级真实部署确实存在**；但它同时说明 **PB 级瓶颈往往不在 O2 本身，而在云栈基础设施**，且是撞上才知道的坑。

**证据缺口（重要）**：
- **无独立、具名的第三方大规模案例研究**；Gartner Peer Insights 评价正面但匿名；Reddit/HN 无第一手大规模生产复盘。
- 所有 PB/TB 数字（2.5 PB/day、1 PB 查询 2 秒、31 MB/s）**均来自厂商营销/创始人访谈/自家文档，无第三方复现**。

> **净结论**：「O2 能跑到 PB 级」有厂商证据 + 一个可信踩坑佐证支撑，可信度高于纯营销；但「**你的负载能否在 O2 上跑好、成本几何**」仍无公开数据可依，且大规模会撞上云栈的系统性瓶颈（那个 GCP 限制就是活例）。**写入与查询性能必须在你的目标云上自测**——这正是留给压测篇的工作。

---

## 十、选型判断：什么时候用，什么时候别用

### ✅ 适合用 O2

- 日志 / 追踪为主，**冷数据留存周期长**，更看重存储成本而非亚秒级点查
- 已在用（或愿意用）S3/GCS/MinIO 等对象存储，想摆脱 ES 的本地磁盘成本
- 团队规模不大，想要**单二进制起步、后续再平滑上 HA 集群**
- 查询以「时间范围 + 高选择性过滤」为主（DataFusion + 分区 + 索引的最佳区）

### ❌ 不适合 / 需谨慎

- 依赖**高基数点查**（频繁按 trace_id / request_id 精确定位单条）——Parquet on 对象存储对此不友好
- 大量**高基数 group-by、复杂 join 排序**的分析型查询——DataFusion 在这类场景弱于 ClickHouse
- 需要**成熟稳定、生产事故少**的平台——O2 仍在快速修复架构级缺陷
- 把官方「140x 省钱」当**无条件预算承诺**——该数字前提严格，实测可能腰斩

---

## 十一、诚实的局限（请务必读）

1. **证据高度依赖厂商自证**——「140x」「87x」「7–30 MB/s/核」几乎全来自 O2 官方文档 / 博客 / 自家仓库，**缺独立第三方审计基准**。
2. **没有经验证的 O2 vs ClickHouse/SigNoz 直接对比**（TCO、延迟、运维复杂度）。
3. **高基数场景、TB/PB 级生产表现、HA 集群运维复杂度**——均无独立验证证据。
4. DataFusion 基准是**单核 + 2024 年**数据，与多核并发生产差异未知。

> 换句话说：本文能高置信度地告诉你 O2「**架构是怎么设计的**」，但对「**它在你的规模下实际表现如何、真实省多少钱**」，公开数据不足以下定论——**这部分必须靠你自己的 POC 验证**。

---

## 附录 A：核心结论速查

> 「证据来源」一列标明每条结论的取证方式：**源码** = 直接读 O2 仓库核实到文件/常量；**官方+源码** = 官方文档说法并被源码交叉印证；**论文/GitHub** = 第三方学术或一手 issue；**厂商自述** = 仅官方单方面声明、无独立复现；**空白** = 无可采信的公开数据、需自测。

| 结论 | 置信度 | 证据来源 |
|---|---|---|
| 三层存储管道（WAL→Memtable→本地 Parquet→对象存储） | 高 | 官方+源码 |
| Parquet + zstd 默认压缩，footer 存 min/max 元数据 | 高 | 源码 |
| HA 模式必须用对象存储 | 高 | 官方+源码 |
| Tantivy 倒排 + Secondary Index + Bloom Filter 组合索引 | 高 | 源码 |
| 「140x 省钱」为真但仅限存储、不开全文索引前提 | 高 | 官方文档原文 |
| DataFusion 与 DuckDB 同量级、有胜有负 | 中 | SIGMOD 论文（有分歧） |
| DataFusion 1–32 核近线性扩展，64 核+ 部分查询变慢 | 高 | SIGMOD 论文 |
| 摄入 7–30 MB/s/核 | 中 | 厂商自述（单一来源） |
| metrics 查询 OOM 缺陷（2024/12，后已修复） | 中 | GitHub issue/PR |
| **官方承认不存在 O2 vs ClickHouse 对比数据** | 高 | 官方维护者原话 |
| 默认预留 ~50% 内存给搜索，与 compaction 并发可致 OOM（定性） | 中 | 源码 + 多个 issue |
| 早期版本跨版升级破坏性变更（0.5.2→0.6.2，2023） | 中 | GitHub discussion |
| 开启全文索引的真实存储倍数 | **空白** | 无第三方数据，需 POC |
| O2 vs ClickHouse/SigNoz 的 TCO / 延迟硬对比 | **空白** | 官方确认不存在 |
| 高基数点查在对象存储上的延迟 | **空白** | 需自建 POC |
| PB 级生产案例（厂商称最大 2.5 PB/day、单集群 100+ TB/day） | 低-中 | 厂商自述 + GCP 踩坑佐证 |
| 物理排序键写死 `_timestamp`、不可配置、无多字段 | 高 | 源码 |
| 无 UPDATE / 无行级 DELETE / 无 ReplacingMergeTree 去重引擎 | 高 | 源码 |
| 全文索引仅 compaction 时生成（实时数据无索引） | 高 | 源码 |
| HA 集群强制依赖 PostgreSQL + NATS | 高 | 源码 |

## 附录 B：主要信息来源

**官方（一手）**
- OpenObserve 架构文档 https://openobserve.ai/docs/architecture/
- 性能优化指南 https://openobserve.ai/docs/enterprise-setup/performance/
- 竞品对比文档 https://openobserve.ai/docs/overview/comparison-with-alternatives/comparison/
- Tantivy 索引文档 https://openobserve.ai/docs/user-guide/advanced/query-tuning/tantivy-index/
- GitHub 仓库与源码 https://github.com/openobserve/openobserve
- metrics OOM issue https://github.com/openobserve/openobserve/issues/5456
- 1.1TB 基准博客 https://openobserve.ai/blog/elasticsearch-openobserve-benchmarking/

**第三方 / 学术**
- DataFusion vs DuckDB 多核扩展性（SIGMOD 2024）https://dl.acm.org/doi/10.1145/3626246.3653368
- DataFusion ClickBench 博客 https://datafusion.apache.org/blog/2024/11/18/datafusion-fastest-single-node-parquet-clickbench/
- DataFusion object store 集成（DeepWiki）https://deepwiki.com/apache/datafusion/7.2-object-store-integration
- 源码分析（DeepWiki）https://deepwiki.com/openobserve/openobserve/2.2-data-storage-architecture
- ClickHouse 官方：nginx 日志压缩 178x 与 trade-off https://clickhouse.com/blog/log-compression-170x
- ClickHouse 官方：用日志聚类(Drain3)自动结构化 https://clickhouse.com/blog/improve-compression-log-clustering
- ClickHouse 官方：压缩编码/codec 原理 https://clickhouse.com/resources/engineering/database-compression

**证据空白与生产坑的一手来源**
- 官方承认无 O2-ClickHouse 对比 https://github.com/openobserve/openobserve/discussions/5662
- 内存/OOM 与 compaction https://github.com/openobserve/openobserve/discussions/2711、 https://github.com/openobserve/openobserve/discussions/1002
- 版本升级破坏性变更 https://github.com/openobserve/openobserve/discussions/1563
- index_size 反超数据体积信号 https://github.com/openobserve/openobserve/issues/5224

**生产采用规模（厂商自述为主，无独立具名案例）**
- Techzine 报道（140x / 创始人访谈转述）https://www.techzine.eu/blogs/analytics/140020/openobserve-lowers-observability-storage-costs-by-140x/
- CubeAPM 定价与评测 https://cubeapm.com/blog/openobserve-pricing-review/
- Gartner Peer Insights（匿名评价）https://www.gartner.com/reviews/market/observability-platforms/vendor/openobserve/product/openobserve-748339221
- 官方 K8s at scale 指南（TB/day 量级示例）https://openobserve.ai/blog/monitor-kubernetes-logs-at-scale/
- HN 讨论（2024/10，偏 SSO 付费墙争论）https://news.ycombinator.com/item?id=41927743

> ⚠️ 附录 A 中标「源码」的结论来自对 O2 仓库（commit `99c571b`）的直接核实，非文档转述。

---

## 附录 C：给决策者的 POC 验证清单

公开数据无法回答的问题，都汇总到这里——**这是全文的最终「行动项」**。若要严肃采用 O2，建议用你自己的真实日志数据集依次验证：

1. **真实存储成本**：采集一份代表性生产日志，分别导入 O2（开/关 Tantivy 全文索引两种配置）与 ES，对比 `storage_size` + `index_size` vs ES 索引大小，算出**你的场景**的真实倍数（别信 140x/87x）。
2. **高基数点查延迟**：对 trace_id/request_id 精确定位查询，测 O2（DataFusion on 对象存储）vs ClickHouse/SigNoz 的 P50/P99。
3. **聚合与 join 延迟**：跑你最常用的高基数 group-by 和多表 join，对比 O2 vs ClickHouse。
4. **内存冗余与稳定性**：在**搜索 + compaction 并发**的高压场景下压测，观察 OOM 行为，定出你规模下的内存冗余系数（社区传闻的 10x 不可信，必须自测）。
5. **升级演练**：在非生产环境走一遍版本升级，验证迁移步骤与数据可见性，制定不跨版本直升的升级 SOP。

### O2 vs ClickHouse 公平对比 SOP（压缩率专项）

单测「最大压缩率」是无用功（那是极限区）。正确目标是**画出各自的帕累托前沿**：同等可用查询性能下谁更省，或同等压缩率下谁更快。

**先做 5 分钟祛魅**：`zstd -19 原始文件` 裸压。若裸 zstd 就逼近 O2 的落盘大小，说明高压缩率主要来自「数据太软 + zstd」，列存增益有限，不必纠结引擎差异。

**四个必须对齐的公平性要点**（否则会误判 CH 压不过 O2）：

| 陷阱 | 后果 | 对齐做法 |
|---|---|---|
| CH 默认 LZ4，O2 默认 zstd | CH 天然吃亏 | CH 显式 `CODEC(ZSTD(3))` |
| CH 把整条日志塞一个 String 列 | CH 退化行存，被碾压是必然 | 让 CH 也拆列（JSON 字段各建列 / JSON 类型），对等 O2 schemaless |
| O2 未等 compaction 就量 | 量到未排序 WAL parquet，低估 O2 | O2 侧等 compaction 完成再量 |
| 样例 7MB 太小 | part/row group 效应不足，噪声大 | 真实对比用 ≥ 几百 MB~GB |

**测多档，画散点**（每档记录「压缩率 × P99 查询延迟」两个坐标）：

| 配置档 | 说明 |
|---|---|
| O2 默认 | O2 基本只有这一个点 |
| CH 甜点（~50x） | LowCardinality + 合理 codec + 中等 granularity |
| CH 极限 | 高 ZSTD level + 大 index_granularity |
| CH 低压 | LZ4 + 细 granularity |

**测量口径对齐**：O2 用 `storage_size + index_size`；CH 用 `SELECT sum(data_compressed_bytes)/sum(data_uncompressed_bytes) FROM system.columns WHERE table='logs'`。索引要对等——O2 含全文索引就别拿去比 CH 纯数据。

**别忘了同时测查询**：高基数点查（trace_id 定位单条）、高基数 group-by 聚合的 P50/P99——这俩是 O2 相对 CH 的弱项，很可能出现「O2 存储略省、查询慢一截」，那才是完整选型画面。

---

*全文结论均来自源码直接取证或多源交叉印证，不采信官方营销与第三方个人观点。**核心发现**：O2 的架构设计可高置信度厘清，但其在你规模下的真实成本与查询表现，公开数据存在结构性空白（官方亦承认无 O2-ClickHouse 对比）——最终决策必须以附录 C 的 POC 结果为准。*
