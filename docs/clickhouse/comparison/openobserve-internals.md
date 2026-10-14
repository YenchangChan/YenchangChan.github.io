---
title: OpenObserve 的 140x 压缩：源码里的分母是什么
---

# OpenObserve 的 140x 压缩：源码里的分母是什么

这两年老有人问我 OpenObserve（下面简称 O2）。问法大同小异：它号称存储成本比 Elasticsearch 低 140 倍，那跟 ClickHouse 比怎么样？是不是可以直接拿来替代 ClickHouse 做日志？

官网和各种文章翻了一圈，回答不了这个问题。O2 自己的数字几乎都是拿 ES 当参照，跟 ClickHouse 的对比，官方维护者公开说过没有。那就只能自己看了。我把 O2 的仓库从写入、存储、索引到查询翻了一遍（核对的是 commit `99c571b`），这一篇讲源码里看到了什么，下一篇是 27.3 亿行数据的实测。

文中写「源码里」的，都是对到了具体文件和常量的；只有官方一家之言、找不到第二个来源的数字，我会直说是厂商自述。

## O2 是什么

O2 是一个用 Rust 写的可观测性平台，日志、指标、追踪都管。技术栈一句话就能说完：Rust 加 Apache Arrow / DataFusion，加 Parquet，加对象存储。

它主打的是用列存加对象存储把存储成本打下来，对标的是 ES/ELK 那种存储开销，不是查询性能的上限。这一点想明白了，O2 后面的很多取舍就都好理解了。

## 写入路径和存储格式

O2 的写入是一条三段的管道，官方文档有，源码里也对得上：

```
写入
  → WAL（本地磁盘，保证即时持久化）
  → 内存 Memtable（Arrow RecordBatch）
  → 阈值触发落盘为本地 Parquet 文件
  → 周期性 compaction 合并成更大文件
  → 上传对象存储（S3 / GCS / MinIO / Azure Blob / OSS / COS）长期保存
```

WAL 阶段的 Parquet 文件就能直接查，不用等上传到对象存储，新数据的可见性靠的就是这个。

几个阈值常量，取自官方架构文档：

| 常量 | 默认值 | 含义 |
|---|---|---|
| `ZO_MAX_FILE_SIZE_IN_MEMORY` | 256 MB | 内存中单文件上限 |
| `ZO_MAX_FILE_SIZE_ON_DISK` | 128 MB | 本地磁盘单 Parquet 上限 |
| `ZO_MEM_PERSIST_INTERVAL` | 5 s | 内存持久化间隔 |
| `ZO_FILE_PUSH_INTERVAL` | 10 s | 文件推送间隔 |
| `ZO_COMPACT_MAX_FILE_SIZE` | 2048 MB | compaction 合并目标大小 |

源码里能对上的地方：`object_store` trait 抽象出了 `Remote` 结构体和做并发控制的 `LimitStore`，`ingester/wal.rs` 里有 `.par → .parquet` 的重命名逻辑。不过文档里的阈值有的已经过时了，当前源码里 `ZO_MAX_FILE_SIZE_ON_DISK` 实际是 512 MB，这类值随版本在变，以你部署的版本为准。

落盘格式是 Apache Parquet，默认 zstd 压缩，也能配成 Snappy 之类（`config.rs` 里 `ZO_PARQUET_COMPRESSION` 默认 `zstd`）。Parquet footer 里塞了 min/max 时间戳和记录数（`parquet.rs` 里 `set_key_value_metadata` 写的 `min_ts/max_ts/records`），查询时靠它在文件级别做裁剪。

集群或者 HA 模式必须用对象存储，HA 下不支持本地盘。也就是说一上生产集群，存储后端就绑在了对象存储的延迟和计费模型上。O2 便宜是因为这个，高基数点查偏弱也跟这个有关，后面会说到。

## 索引是一套组合

O2 的索引不是一种，是几种叠着用：

| 机制 | 作用 | 默认状态 |
|---|---|---|
| Tantivy 倒排索引 | 长文本字段（body/message）分词，支持全文检索 | 需显式开启 |
| Secondary Index | 单值字段（如 `kubernetes_namespace_name`）整值作为单一 token | 可配置 |
| Bloom Filter | 高基数字段快速排除不命中的文件 | 默认仅对 `trace_id` 生效 |
| 时间分区 + 缓存 | 时间范围裁剪 | 内置 |

`parquet.rs` 里 `set_column_bloom_filter_enabled` 按字段条件启用 bloom filter，环境变量文档也写了默认只对 `trace_id` 生效。Tantivy 索引什么时候生成，后面讲全文检索的时候说，答案是只在 compaction 的时候。

## schemaless 省心，但有边界

自动拆列确实省心，可前提是字段稳定、结构扁平。下面这些行为我都在源码里核过。

字段数有个硬上限，单个 stream 最多 1000 列（`ZO_COLS_PER_RECORD_LIMIT=1000`）。新字段会自动加一个 nullable 列，历史行读出来补 `null`，这没问题。问题是一旦超过 1000，这一批数据整批被拒，`schema.rs` 报 `"Data discarded"`，客户端收到错误，没有部分成功，也不是把多出来的字段丢掉了事。

O2 其实有个兜底机制叫 UserDefinedSchema：只给白名单字段建独立列，其余字段整个序列化成 JSON 字符串塞进兜底列 `_all`（`column_all`）。可它默认是关的（`ZO_ALLOW_USER_DEFINED_SCHEMAS=false`）。所以开箱即用的状态下，要是灌进去的日志把 user_id、uuid 当 key 用，列数会悄悄涨到 1000，然后开始整批丢数据。零建模的便利，在字段失控的时候就变成了丢数据的风险，灌动态日志之前，要么先开 UDS，要么先把字段收住。另外别跟 `_all_values` 搞混，那是把所有值用空格拼起来做全文检索的列，跟字段爆炸没关系。

类型冲突上，O2 比 ES 宽容，这是它实打实的优点。同一个字段先来 int 后来 string，O2 优先把这一列提升成 string，提升不了就逐条强转（`zo_cast`），强转也失败才丢单条记录。ES 遇到 mapping 冲突是直接拒整个文档，O2 官方那次对比测试里 ES 拒收了 62% 的文档，原因就在这。处理脏数据、异构数据，O2 比 ES 稳得多，这一点比 140x 实在。

嵌套 JSON 默认打平，分隔符是 `_` 不是 `.`，`a.b.c` 变成 `a_b_c`。key 会被强制转小写，`[a-z0-9_]` 以外的字符都换成 `_`，所以驼峰字段可能撞名，`Foo` 和 `foo` 都变成 `foo`，后写的覆盖先写的。默认打平层级是 `ZO_INGEST_FLATTEN_LEVEL=3`，超过三层的子对象整个转成 JSON 字符串。不过源码里无参的 `flatten()` 是无限展开的，这个 3 只在显式限制层级的调用里生效，JSON、OTLP、bulk 这几个入口是不是都传了 3，我没有一个个追完，POC 时拿一条五层嵌套的日志试一下就知道了。

最大的坑是数组。JSON 数组，包括对象数组，一律整个转成 JSON 字符串存一列，里面的字段完全不拆。源码里能看出来团队评估过按下标拆列，后来放弃了。所以 spans、items、tags、events 这种对象数组，到了 O2 里就是一个字符串，没法按里面的字段做列式过滤和聚合，只能全文检索或者用 JSON 函数硬解。ES 和 CK 都原生支持嵌套和数组，这是打平路线实打实的短板。

字段爆炸还会反过来打压缩率。触发 `_all` 兜底以后，数据都挤进一个高熵的 JSON 字符串列里，字典编码、RLE 这些就失效了，压缩率掉下来，还没法列式查询，对象数组转字符串也是一样。官方那些九十多倍的样例，必然是字段稳定、结构扁平、没有对象数组的干净日志。真实业务日志里的动态字段和嵌套数组，会同时打在压缩率、查询能力和写入稳定性上。所以 POC 之前先看两件事：你的日志字段会不会逼近 1000 列；有没有对象数组，里面的字段要不要按条件查。这两点比数据量更能决定 O2 在你这儿好不好用。

## 排序键写死了

O2 的物理排序键是 `_timestamp DESC`，写死的。compaction 合并时排序 SQL 的目标列是编译期常量，`grep sort_key`、`grep ZO_SORT` 一个都搜不到，用户没法自定义，也没法多字段排序。CK 是 `ORDER BY (a,b,c)` 随你定，O2 在这一层的控制权是零。后面讲到的压缩率不能调、没有去重引擎，根子都在这。

这里别跟查询 SQL 里的 `ORDER BY` 搞混。查询时 DataFusion 支持任意字段、多字段排序，那管的是结果怎么展示；存储的物理排序键管的是文件里每一行的先后顺序，决定压缩效率，这个是写死的。

分区键倒是可以自定义，Value、Hash、Prefix 都行，还能多字段，可它只决定数据落到哪个文件路径，不决定文件里行的顺序。

时间字段也有几个规矩。`_timestamp` 是强制存在的，JSON 里没有时间字段或者是 null，就自动填 `Utc::now().timestamp_micros()`，这时候存下来的是到达时间而不是事件时间，按时间范围查的时候要留个心眼。数字时间戳以 `1971-01-01` 为锚点按数量级比较，自动区分秒、毫秒、微秒、纳秒，内部统一成微秒，对可观测性里那些近期时间戳相当靠谱；字符串按 RFC3339、ISO8601、带小数秒的格式、RFC2822 依次去试。但字段名 `_timestamp` 是硬编码的，没有 `ZO_TIMESTAMP_COL` 这种改名的配置，也不支持自定义 strptime 格式，`MM/DD/YYYY` 这种非标准格式会解析失败，`0` 或者特别小的值会落到 `now()` 或者 1970。你的时间字段要是叫别的名字，得先在 ingestion pipeline 里映射一下。

## 查询引擎是 DataFusion

O2 的查询引擎是 Apache DataFusion。InfluxDB 3.0、Coralogix 用的也是它，算是可观测性这一类产品共用的底座，不是 O2 独有的。这也意味着 O2 查询能力的上限，很大程度上跟着 DataFusion 社区走。

性能上最容易被带偏。网上流传一个说法，DataFusion 是击败 ClickHouse、DuckDB、chDB 的最快单节点引擎。我去对了 SIGMOD 2024 那篇论文（DataFusion 作者本人写的，署名里有 InfluxData 和 Coralogix 的人），单核基准用的是 ClickBench 14GB/100 文件、TPC-H SF=10 和 H2O-G。结论是 DataFusion 在高选择性的谓词下推场景领先，能充分吃到 Parquet 的裁剪；在千万级分组的高基数 group-by、TPC-H 的 join 排序优化、个别聚合函数（比如 `corr`）上明显落后，部分查询慢两倍以上。整体是和 DuckDB 一个量级，各有胜负，谈不上碾压。而且这是单核、2024 年的数据，又有一定的自证成分，多核和多租户并发的生产场景不一定是这个结果。

论文里另一组多核扩展测试质量更高一些，用 GCP c3-highcpu-176 从 1 核测到 192 核，对比 DataFusion 和 DuckDB。1 到 32 核两者都接近线性扩展；到 64、128、192 核，部分查询（Q11、Q14、Q32）反而随核数增加变慢，作者归因于核间协调开销变大。总的看，DataFusion 的扩展曲线和 DuckDB 形状差不多。但这组测试只比了两个单机嵌入式引擎，跟 ClickHouse 无关，也不涉及多租户并发，推不出 O2 在生产上并发查询表现如何。那个「最快单节点 Parquet 引擎」的排名，来自 16 核单机的 ClickBench，同样证明不了并发场景。

摄入吞吐，官方给的是每 vCPU 7–30 MB/s，看配置。这是单一官方来源，没有第三方复现过。另外有个调优项已经失效了：大量资料，包括官方较早的性能指南，会让你开 `ZO_FEATURE_PER_THREAD_LOCK=true`，说能到每核约 23 MB/s。可这个开关 2025-09 就被删掉了，在 v0.91.1 这种当前版本上设置它，会被静默忽略，不报错也不生效，等价的能力换成了 `ZO_MEM_TABLE_BUCKET_NUM > 1`（memtable 分桶，减少写入路径上的锁竞争）。照旧文档去调，结果是什么都没发生，还以为自己调过了。

## 140x 是怎么来的

O2 最出圈的数字，是存储成本比 Elasticsearch 低约 140 倍。官方文档原文确实写了「~140x lower storage cost vs Elasticsearch」，可它自带三个前提。

一是只算存储成本，不含计算和查询（原文：「This cost comparison pertains only to storage」）。二是不开全文倒排索引（原文：「does not do full-text indexing」），开了全文检索要额外多出约 25% 的存储，压缩收益被吃掉一部分。三是官方自己也说结果取决于日志的可压缩性。更关键的是，O2 自己在更大的 1.1 TB 数据上测出来的是 87x，不是 140x：那次 ES 因为字段类型 mapping 冲突拒收了 62% 的文档，原始对比是失真的，剔掉以后的公平对比值是 87x。

所以 140x 是理想条件下的上限。做预算应该按开了全文索引以后的真实倍数算，可这个数，公开资料里没有。

O2 的 stream 统计 API 单独暴露了 `index_size`，跟 `storage_size`、`compressed_size` 并列，理论上谁都能自己采数据算出索引占比，但我没找到任何公开的案例这么算过。倒是有一个警示信号：GitHub issue #5224 的示例数据里出现了 `index_size(7327) > compressed_size(6139)`，索引比压缩后的数据还大，跟官方说的「只多 25% 左右」差得远。这条数据的来源、单位、代表性都说不清，证明不了什么，只能算又一个必须自己测的理由。官方博客还有一篇「49s→2s 提升 25 倍」的调优案例，归因于调大 `ZO_COMPACT_MAX_FILE_SIZE`、减少 S3 小请求，具体数字也只有厂商自己的说法。

下面这些说法，核下来都站不住：

| 说法 | 为什么站不住 |
|---|---|
| 「140x 更低存储成本」作为无条件结论 | 官方原文明确限定「仅存储、不开索引」，去掉前提即失真 |
| 「查询性能比 ES 更好且只用 1/4 硬件」 | 仅厂商自证，无独立复现 |
| 「全文检索性能提升 1000x」 | 无法复现，来源单一 |
| 「摄入比 ES 快 5–10x」 | 仅官方文档单方面声明 |
| 「真实 Kubernetes 场景 140x」 | 场景与前提不符，证据不足 |

## 和 ClickHouse 比，没有现成的数据

找 O2 和 ClickHouse 的对比，最重要的发现是数据不存在。2025 年 1 月，O2 官方维护者 prabhatsharma 在 GitHub Discussion #5662 里被问到有没有 O2 vs ClickHouse 的性能对比，日志、trace、metric 的摄入、查询延迟、压缩比都算上，他的回答是：「No. If you do one, then let us know.」

所以任何「O2 比 ClickHouse 快多少倍、省多少钱」的说法，只要不是你自己 POC 测出来的，都别信。社区里零星的讨论是有，但没有一份能公开引用的对比，拿来做决策不够。

运维复杂度也一样没有定论。常听人说 O2 单二进制零依赖，比 SigNoz（ClickHouse 加 ZooKeeper 一堆容器）好部署。往下查，两边都站不住：「SigNoz 默认用自建 ZooKeeper 镜像、有兼容性坑」，issue 细节不足；「O2 零依赖所以更好运维」，是 HN 用户 GordonS 的个人看法。反方也有人说，有 ClickHouse 背景的评论者 sdairs 指出 ClickHouse 新版已经不需要 ZooKeeper，单机部署不用任何协调组件，ClickHouse 部署复杂这个老印象可能过时了。这也是个人看法，但至少提醒一句，别拿老黄历做判断。后面讲 HA 的时候，源码会给出更准的答案。

## 压缩上，O2 有什么 ClickHouse 没有的

O2 的存储逻辑，按时间排序、文件 merge、zstd、列存，跟 ClickHouse 的 MergeTree 几乎是一套东西。那 O2 凭什么号称 140x，CK 从来没这么说过？

答案是，140x 的分母是 Elasticsearch，不是 ClickHouse。把这个数拆开，大头是 ES 自己的浪费，不是 O2 压得多狠：

| 140x 的来源 | 贡献 | CH 有这个浪费吗 |
|---|---|---|
| ES 保留整份 `_source` 原文冗余 | 大 | 没有，CH 也是纯列存 |
| ES 默认全字段倒排 + doc_values + norms | 大 | 没有，CH 默认不建倒排 |
| ES 常 1 主 + 2 副本（3x 放大） | 中 | 没有，CH 副本可控 |
| 列存编码 + zstd（真正的「压缩」） | 中 | 有，而且更强 |

随便哪个正经的列存，CH、DuckDB、Parquet 系，拿去和默认配置的 ES 比日志存储，都能打出几十倍的差距，O2 在这一点上并不特殊。这大概也解释了为什么 O2 官方从不发和 ClickHouse 的对比，分母一换成 CH，这个故事就讲不下去了。

论压缩的工具箱，CK 反而比 O2 全：

| 能力 | O2 | ClickHouse |
|---|---|---|
| 按 key 排序 | 仅 `_timestamp`，写死 | `ORDER BY` 任意多列、用户可控 |
| 时序专用编码 | delta_binary_packed（单一） | Delta / DoubleDelta / Gorilla / T64 任选 |
| 低基数字符串 | Parquet dictionary（row group 局部） | `LowCardinality` 全局字典 |
| per-column 编码 | 基本没有（时间戳除外） | `CODEC(Delta, ZSTD(3))` 逐列手调 |
| zstd 级别 | 写死（默认 ~1） | 可调 |

O2 基本就是吃 Parquet 的默认行为，外加一个时间戳特化；CK 允许你逐列指定 codec。调到位的 CK 表结构，压缩率通常不会比 O2 差。

光说不练不行，我拿同一份数据分别灌了 O2 和 ClickHouse，两边都建全文索引，功能对等。

第一组是 O2 官方的 k8s 日志样例，8.40 MiB、3,846 行：

| 方法 | 数据 | 索引 | 合计 | 说明 |
|---|---|---|---|---|
| `zstd -19` 单文件 | 53.4 KiB | — | 53.4 KiB | 通用压缩极限（O2 的 level 写死、用不到） |
| `zstd -1` 单文件 | 79.3 KiB | — | 79.3 KiB | 与 O2 默认 zstd level 对齐 |
| O2 | 80 KB | 100 KB | 184 KB | 数据部分几乎等于 `zstd -1` |
| ClickHouse | 70.53 KB | 132.02 KB | 202.55 KB | 数据更小，但索引开销更重 |

O2 的数据部分 80 KB，跟命令行敲一句 `zstd -1` 得到的 79.3 KiB 几乎一样，列式编码省下来的，正好被 Parquet 元数据和小文件的固定开销吃掉了。`zstd -19` 能压到 53 KiB，可 O2 的 level 写死在 1 左右，想调都没有入口。这一局总量上 O2 反而略胜，184 KB 对 202.55 KB，因为数据量太小，CK 全文索引的开销（132 KB，是它数据的 1.9 倍）把 CK 数据侧的优势吃掉了。

第二组是 GitHub Events，27.3 亿行、54 列：

| 方案 | 数据 | 索引 | 合计 | vs O2 |
|---|---|---|---|---|
| O2（Tantivy 全文索引） | 174.64 GiB | 45.14 GiB | 219.78 GiB | 基准 |
| CK `text(splitByNonAlpha)`（功能对等） | 117.32 GiB | 46.80 GiB | 164.12 GiB | 小 25% |
| CK `ngrambf_v1`（概率型） | 105.64 GiB | 12.23 GiB | 117.87 GiB | 小 46% |
| CK 无二级索引 | 105.58 GiB | 0 | 105.58 GiB | 小 52%（但无全文检索） |
| CK `text(ngrams(5))`（子串匹配） | 106.05 GiB | 417.81 GiB | 523.86 GiB | 大 138% |

先说一个坑：压缩率倍数没法比，只能比落盘的绝对字节数。同一份数据，O2 报的是 3.08 TiB 压到 174.64 GiB，约 18x；CK 报的是 792.69 GiB 压到 105.58 GiB，约 7.5x。看着 O2 的压缩率是 CK 的 2.4 倍，可落盘是 CK 更小，差别全在分母上。

O2 这个分母，翻源码看相当微妙。UI 上的「采集数据 / Ingested Data」对应的是 `StreamStats.storage_size`，名字叫 storage，其实跟存储没关系，`add_file_meta()` 里是 `self.storage_size += meta.original_size`，真正的落盘字节在 `compressed_size`。而 `original_size` 是对打平以后的记录调 `serde_json::to_vec()` 得到的 JSON 文本字节数，链路是 `flatten_with_level()` → `Entry.data_size` → `RecordBatchEntry.data_json_size` → `FileMeta.original_size` → `StreamStats.storage_size`。

这个口径跟 CK 的 `data_uncompressed_bytes`（列式二进制的未压缩值）有四处结构上的不同。一是 key 名逐行重复，`serde_json` 不会跨记录去重 key，54 个字段名在 27.3 亿行里每行都写一遍，CK 的列名只在 schema 里存一份。二是打平还会把 key 拉长，嵌套的 `a.b.c` 拼成 `a_b_c`，比如 `payload_commits_message`，所以这个「采集数据」甚至可能比你实际上传的原始 JSON 文件还大。三是 JSON 语法本身的开销，花括号、冒号、逗号、引号。四是数字变成了文本，一个 int64 在 JSON 里是 10 到 19 个 ASCII 字符，CK 列式定宽只要 8 字节。这四项各占多少，源码层面拆不出来，只能确认方向和数量级是对的。

分母越虚，倍数越好看，这已经内建在产品 UI 的统计口径里了。而且 O2 根本没有暴露「列式未压缩大小」这种统计量，`FileMeta`、`StreamStats` 里都没有，你没法用它自带的数据算出一个和 CK 对等的未压缩基线。

撇开倍数，看绝对大小。功能对等下 CK 小 25%，差距全在数据列：索引两边差不多（O2 45.14 GiB，CK 46.80 GiB），数据列 CK 117.32 GiB 对 O2 174.64 GiB，小了 33%。这是 CK 的列存编码，LowCardinality 全局字典、逐列 codec、`ORDER BY` 聚类，在真实高熵数据上的实打实收益，也是 O2 排序键写死、不能逐列调 codec 的代价。O2 的 Tantivy 倒排是合格的，45.14 GiB 和同语义的 CK `text(splitByNonAlpha)` 几乎一样大。

上表那几种 CK 索引不是同一个方案调参数，是不同的技术、不同的取舍：

| 索引方案 | 索引大小 | 精确性 | 支持的查询 |
|---|---|---|---|
| CH `ngrambf_v1` | 12.23 GiB | 概率型（有假阳性，须回表验证） | 子串剪枝 |
| CH `text(splitByNonAlpha)` | 46.80 GiB | 精确 | token 匹配，可 direct read |
| CH `text(ngrams(5))` | 417.81 GiB | 精确 | 子串匹配，可 direct read |
| CH 无二级索引 | 0 | — | 全表扫描 |
| O2（Tantivy） | 45.14 GiB | 精确 | token 匹配 |

精确的子串匹配是最贵的能力，`ngrams(5)` 的组合爆炸让索引涨到了数据的 4 倍（417.81 对 106.05 GiB）。想省空间，要么退回 `ngrambf_v1`（12.23 GiB），接受假阳性；要么退回 token 语义（46.80 GiB），放弃子串。CK 让你在 0 到 418 GiB 这一段上按需求自己挑：要不要子串、能不能忍假阳性、给多少空间预算。O2 把你固定在一个点上，既不能拿概率型索引换空间，也没法升级到精确子串匹配。

所以谁压得更小，没有放之四海皆准的答案，小数据量上 O2 略胜，大数据量上 CK 反超，还得看要不要全文检索、你会不会调 CK。能确定的只有一条：O2 在压缩上没有护城河，它的数据侧约等于 `zstd -1`，调到位的 CK 能比它小 25% 到 46%。

样例日志的百倍压缩是最好的情况。真实生产日志里有大量高基数字段，trace_id、user_id、IP、request body，压缩率会被拉回个位数到十几倍，O2 和 CK 一起掉，而高基数恰恰是 O2 比 CK 弱的地方。选型得按生产的情况算。

### 压缩率是一条曲线

ClickHouse 官方有一篇讲 nginx 日志压缩的文章（*Compressing nginx logs 170x with column storage*，2025-10），把整条压缩曲线都摊开了。数据集是 20GB、6675 万行的 nginx access log：

| 阶段 | 压缩率 | 做法 |
|---|---|---|
| LZ4 裸压 | 20x | 通用压缩 |
| GZIP 裸压 | 31x | 通用压缩 |
| ZSTD(3) 裸压 | 38x | 通用压缩（裸压就吃掉大半） |
| 仅拆列 | 56x | 结构化成各字段列 |
| 极致调优 | 178x | IPv4/UInt 类型 + LowCardinality + 逐列 codec（时间戳 Delta(4)+ZSTD(1)、字符串 ZSTD(6)）+ ordering key 按 (referer, user_agent…) |
| 按时间排序 | ~50x | ordering key 改 `toStartOfDay(time)` 打头，查询友好 |

CK 调到极致能压到 178x，它不拿这个数做营销而已。当然 178x 是对原始日志、140x 是对 ES 的存储成本，两个数不是一个口径，可至少说明「CK 压缩弱」站不住。更有意思的是官方自己承认，178x 那套 ordering key「may not always be ideal for query performance」。现实里查询大多按时间过滤，改成按时间排序以后压缩率掉到 50x 左右，这才是既能查又能省的甜点区。

压缩率是拿查询性能换的，是一条取舍的曲线。CK 把整条曲线交给你，压缩级别、index_granularity、codec 全能调，你可以自己挪到甜点区。O2 递给你的是一个点，zstd 级别写死、编码走 Parquet 默认、不能逐列调，这个点你挪不动，它也从来不告诉你这个点在曲线的哪一段。再加上 O2 高基数查询偏弱、对象存储有查询延迟、metrics 曾经 OOM 这些情况，我猜它的 140x 更可能落在压得不错但查询一般的那一段，这要靠实测去证实或者推翻。

### O2 真正不一样的地方

那 O2 和 CK 真正的差别在哪？在架构上。

一是对象存储原生，存算彻底分离。O2 生来就把 S3、GCS 当主存，存储成本就是对象存储的单价，比 CK 传统的本地盘、EBS 便宜得多，O2 省钱的底子在这儿。二是 schemaless 零建模，O2 自动推断列，排序和分区默认配好；CK 要手写 DDL，自己选 ORDER BY、codec、分区键，想压到极致，前提是你得会调。三是单二进制，起步就一个 binary；CK 集群要操心分片、副本、Keeper、merge 风暴、schema 迁移。

反过来，CK 的高基数聚合、join、点查都更强，压缩能调的上限更高，生态也更成熟。

## 对象存储上的全文检索

这件事本身是矛盾的：Tantivy 倒排查询要大量随机 seek，对象存储随机读延迟高，索引体积还常常比数据大。O2 的解法相当精细，下面都是源码里看到的。

索引也放在对象存储上。`.ttv` 文件（Puffin 容器格式）和 Parquet 走同一个 `storage::put`，同 ID、同分区路径，只是目录从 `logs/` 换成 `index/`，一一对应，查询端拿字符串就能算出索引路径，不用查表。

索引只在 compaction 阶段生成，`create_tantivy_index` 唯一的调用点在 `merge.rs`。这意味着刚写进来、还没 compaction 的实时数据没有倒排索引，全文检索在这部分数据上退回全表扫描。查最近几分钟日志的时候没有索引加速，对实时排障是实打实的影响。

为了在对象存储上把检索跑快，O2 下了不少功夫。最巧的是 `footer_cache` 预计算：compaction 建索引时，把打开索引要读的元数据预先全部 touch 一遍，固化成一个独立的 blob 塞进 Puffin，查询时一次 range GET 取回来，Tantivy 冷启动的那些随机读就提前算掉了。Puffin footer 加 range GET：先读文件末尾 4KB 拿到所有 blob 的 offset 和 length，然后按精确字节范围去读，绝不整文件下载；footer 解析结果放进进程级缓存（默认占总内存 5%，限制在 100MB 到 1GB 之间），同一个文件后面就零 IO 了。`warm_up_terms` 把查询涉及的 term postings、fast field 一次性并行发出去（`tokio::try_join`），避免顺序 seek 把延迟叠起来。

查询是两段式的：常规路径是索引返回 row-id 位图，再回读 Parquet 对应的 row group；count、histogram、top-n、distinct 走旁路，索引直接出结果，不回读 Parquet。命中率超过 35%（`inverted_index_skip_threshold`）就放弃索引退回全扫描，免得索引加扫描两份开销。剪枝是分层的，min-max 和分区在文件级最粗，bloom filter 在文件级做等值，tantivy 到行级。缓存有四层：进程级的 footer 缓存，querier 文件缓存（磁盘默认开、内存默认关，`.ttv` 和 `.parquet` 共用），查询结果缓存（默认 1 万条），还有单次查询内的 byte-range 缓存。

这套东西工程上做得很认真。

### top-n 旁路会悄悄丢数据

上面说的 top-n 旁路，查询跨的文件一多，会悄悄返回不完整的聚合结果。不只是计数偏小，整个分组会从结果里消失。

触发条件低得吓人。`is_simple_topn`（`index_optimizer/topn.rs`）只要求 GROUP BY 的字段在这个 stream 的 `index_fields` 里，连 `match_all()` 都不需要。一条最普通的 `GROUP BY level ORDER BY count DESC LIMIT 100`，只要 `level` 建了索引就会走这条路，命中的时候 O2 日志里能看到 `TantivyOptimizeExec`。

实测用的是 27.3 亿行 GitHub Events，`index_fields=[event_type, repo_name]`，`event_type` 实际只有 12 个不同的值：

| 查询跨度 | 文件数 | 返回分组数 | 行数覆盖 |
|---|---:|---:|---:|
| 1 小时 | 4 | 12 | 100.00% |
| 6 小时 | 24 | 12 | 100.00% |
| 1 天 | 96 | 12 | 100.00% |
| 7 天 | 757 | 7 | 82.87% |
| 31 天 | 4,125 | 3 | 29.33% |

31 天的查询，12 个事件类型只回来了 3 个，行数少了 70.67%，`is_partial` 却是 false。

调大 LIMIT 只能缓解，找不到一个安全的值（同样是 31 天）：

```
LIMIT  100 →  3 组  29.33%       LIMIT 1000 →  6 组  68.84%
LIMIT  500 →  5 组  46.43%       LIMIT 2000 →  9 组  93.13%   ← 仍然错
LIMIT  999 →  6 组  68.80%
```

需要的 LIMIT 跟着文件数涨，757 个文件时 LIMIT 1000 就够了，4,125 个文件时 2000 还不够。可你事先根本不知道该设多大，要知道，就得先知道正确答案。

相关源码在 `src/config/src/tantivy/query/topn_collector.rs` 的 `TopNSegmentCollector::harvest`：分组数超过 `ZO_INVERTED_INDEX_TOPN_MAX_GROUP_NUM`（默认 1000）时，调 `select_top_k_dense()` 只保留本文件局部的 Top-K，注释里自己写着「the merged top-n becomes approximate」。可实测丢得比这个阈值能解释的还多，`event_type` 才 12 组，远低于 1000，照样丢，完整的机制得等官方去定位。

有两个误会我实测排除了。它跟对象存储无关：同一个实例上换成非索引字段（`actor_login`）分组，结果 100% 正确；本地盘那个实例没配 `index_fields`，也是 100% 正确。变量是索引配置，不是存储后端。它也跟 compaction 滞后无关：查 `file_list` 元数据，这个流 205,835 个文件的 `index_size` 全都大于 0，索引覆盖率 100%，没有一个文件缺索引。

最麻烦的是它不报。`is_partial` 的赋值链是 `cluster/flight.rs` → `cluster/http.rs` → `Response::set_partial`，`partial_err` 只有两个来源，搜索超时或取消，以及返回行数超过默认展示上限。走近似路径时唯一的痕迹是一条 `log::debug!`，默认日志级别下根本看不见。

这还不是孤例。官方 issue #6311（2025-03-19 提的，到现在还 open）报告了 VRL 函数报错时 `is_partial` 同样不置位，2026-05-06 的验证评论里写着「Root cause — STILL UNFIXED」。也就是说，`is_partial=false` 代表结果完整这件事，现在至少在两条独立的路径上靠不住。这段实现自 PR #12574（2026-06-11）重写以后再没动过，v0.93.0 和 v0.91.1 字节级相同，问题还在。我已经报给了官方：[openobserve/openobserve#13363](https://github.com/openobserve/openobserve/issues/13363)。

按日志级别、服务名、状态码、事件类型分组，是可观测性里最基本的查询，而 `index_fields` 恰恰就是官方建议给这类字段配的。两个推荐做法叠在一起，出来的是悄悄错掉的结果，查询范围越大错得越离谱。查最近 30 天各服务的错误分布，你会拿到一张少了 70% 的图，没有任何提示。

### 其他代价

实时数据没索引，上面说了，全文检索反而是最新的数据最慢。

索引不压缩，还跟数据抢缓存。Tantivy 的段文件（`.term/.idx/.pos/.fast`）完全不压缩，这是 `index_size > data_size` 在结构上的根源；`.ttv` 和 `.parquet` 又共用同一个 querier 本地缓存池，索引又大又不压缩，吃缓存、跟数据抢地方。高基数全文字段一多，缓存压力和内存、OOM 风险都会被放大，后面讲内存的时候还会说到。

也没有专门的索引热节点或者独立缓存，索引和数据都是承担查询的 querier 按需拉到本地算，缓存冷的时候，性能就回落到对象存储的延迟上。

所以 O2 的全文检索快不快，取决于三个条件：compaction 做完了，querier 本地缓存够大，查询选择性够高（命中超过 35% 就退化）。POC 的时候，要测清空 querier 缓存以后的冷查询延迟，这是对象存储延迟的真实暴露；测实时数据（还没 compaction）的全文检索延迟，和已经 compaction 的数据对比；测大量高基数全文字段下 querier 缓存会不会被挤爆、会不会 OOM；还有高基数 `GROUP BY` 的结果对不对，拿一条已知答案的查询去对，别只看延迟。最后这条是我后来补的，因为真踩到了，前面三条测的是快不快，这条测的是对不对。

## HA 和分布式

O2 存算分离的分布式设计，正确性做得相当正规，但也让零依赖这个说法露了底。

角色上分 Router（入口）、Ingester（写，手上有还没上传的本地数据）、Querier（查）、Compactor（合并加建索引）、AlertManager、FlattenCompactor、ActionServer，可以分别扩缩。协调层是 NATS，代码里 etcd 已经一点痕迹都没有了；集群的元数据库强制用 PostgreSQL，单机才用 SQLite，MySQL 已经弃用。一致性哈希只管 Querier 和 Compactor 的调度，不管 Ingester 写入，用途是缓存亲和，把同一个 stream 的查询稳定地路由到同一个 querier，让本地的索引和数据缓存热起来，跟全文检索那套靠缓存命中率的思路是一回事。

schema 一致性不是靠各节点碰巧一样。schema 存在中心的 Postgres，各节点只有缓存；改 schema 的流程是写 Postgres，NATS watch 广播，各节点回源拉取刷新，中间有个短暂的窗口，最终会收敛。并发改 schema 也不会冲突，`handle_diff_schema` 里看得见的锁只是进程内的 `tokio::Mutex`，真正跨节点的互斥在底层的 `get_for_update`，用的是 Postgres advisory lock 或者 NATS dist_lock，是正经的分布式锁。历史文件写入时 schema 版本各不相同，靠带时间窗的版本化 schema（start_dt/end_dt）、读时 union 补 null 和类型提升来兼容，查询以 `STREAM_SCHEMAS_LATEST` 的并集为准。

实时查询做得好。默认是 scatter-gather，每次查询同时发给 querier 和 ingester，ingester 把本地还没上传的数据也算进来。memtable 也能查（`search_memtable()` 直接读内存），实时性几乎就是当下，不用等落盘，也可以用 `feature_query_skip_wal=true` 关掉换速度。防重复、防遗漏有三层：memtable_id 匹配、pending_delete 过滤、查询期间的文件锁。节点间协议是自定义的 gRPC（tonic 加 protobuf），不是字面意义上的 Arrow Flight，代码里只是借用了 flight 这个名字。

compaction 是在对象存储上做的。流程是 compactor 从 file_list（Postgres）查出小文件，全量下载到本地（N 次 GET），DataFusion 排序合并，上传大文件（PUT），重建 `.ttv` 索引再上传（又一次 PUT），最后在 file_list 里用事务切换。一次事务性的 `batch_process` 同时做新文件登记和旧文件软删除，物理删除交给延迟 GC，再加上先 put 大文件、再切元数据，任何时刻查询看到的文件都是真实可读的，不会读到合并中或者已删除导致的 404。正确性很扎实。

成本也是实打实的，营销材料里从来不提。每一轮 compaction 都是全量字节 GET 加全量字节 PUT，数据和索引各一次，这是对象存储上的写放大，还叠加 PUT、GET、LIST 的请求计费。写多查少的冷数据，compaction 纯属亏本。公平地说，不做 compaction，成本会转移到查询侧并且放大，小文件多了，每次查询的 GET 数会爆炸，O2 官方那个「49s→2s」的调优，主要就是把单次查询的 S3 请求从一万多降到了六百左右。compaction 是拿一次写放大，换后面多次查询少发请求，数据查得越多越划算。

再看零依赖。O2 单二进制零依赖，只在单机成立，上 HA 集群就得运维 PostgreSQL（元数据）和 NATS（协调层）两个外部依赖：

| | 单机 | HA 集群 |
|---|---|---|
| O2 | 真零依赖（SQLite+内置） | + PostgreSQL + NATS |
| SigNoz | ClickHouse | ClickHouse + ZooKeeper/Keeper |

谁运维更简单，公开讨论没有定论，源码给的答案是：更简单主要在单机和小规模成立，上了生产集群，两边都有各自的分布式依赖要养。

把 TCO 补全了看：

| 成本项 | 140x 算了吗 | 真实情况 |
|---|---|---|
| 存储容量费 | 算了 | 确实省（对象存储单价 + 高压缩） |
| 请求费 PUT/GET/LIST | 没算 | 摄入 + compaction 写放大 + 查询都在产生 |
| compactor 计算/内存/网络 | 没算 | 持续后台开销，吃内存 |
| querier 本地缓存盘/内存 | 没算 | 为不让查询被对象存储延迟拖垮 |
| HA 依赖（Postgres + NATS）运维 | 没算 | 集群模式的固定成本 |

真实的 TCO 是省下来的存储费，加上请求费、计算和缓存资源、HA 依赖的运维。写多查少、stream 多、摄入频率高的场景，后面几项会把 140x 的光环啃掉一大块。POC 时一定要把对象存储的 request metrics 打开，实测请求费，那是营销数字里看不见的部分。

## UPDATE 和 DELETE

高压缩列存、不可变的 Parquet、对象存储，这三样凑一起，注定了 O2 对修改和删除的态度。

UPDATE 是完全没有的。ES 兼容的 bulk 接口里那个 `update` action 只是表面兼容，实际走的是 index/create 的路径，新增一行，`_id` 从来不用来定位或覆盖旧记录。更坑的是 ES bulk 的 `delete` action，O2 根本不认，直接静默跳过，不删数据也不报错。从 ES 迁过来、复用带 delete 的 bulk 客户端，会以为删成功了，其实什么都没发生。`update_fields`、`delete_fields` 是纯粹的 schema 元数据操作，不碰已经写下的数据。

DELETE 有三种粒度，都是整文件级的，所以很便宜：

| 粒度 | 支持 | 实现 |
|---|---|---|
| retention 按期自动删 | 支持 | 整文件软删除 + 批量对象存储 DELETE |
| 按 stream 全量删 | 支持 | 同上 |
| 按时间范围删 | 支持，但强制对齐分区边界（小时级要整点） | 同上 |
| 条件删除 / 行级 / 按 user_id | 不支持 | — |

能删的这几种都是整文件 `DELETE`，从来不做下载、过滤、重写，DELETE 请求还不收费，跟高压缩完全不冲突，删的是整个文件，不碰内容。

要删一行或者几行，O2 没有任何官方 API，只能自己写一个迷你 compactor，下载、解压、过滤、重新压缩、上传、重建索引，成本差不多是一次完整的文件重写，事务和并发保护还得自己做。所以要删某个 user_id 的全部历史数据，O2 做不到。分区键一般是时间不是 user_id，目标用户的数据和别人的混在同一批文件里，要么把同一时间窗所有用户的数据一起删掉，要么删不干净。有合规删除需求的，这是硬伤。

跟 ClickHouse 比：

| 能力 | ClickHouse | O2 |
|---|---|---|
| 整分区删除 | `DROP PARTITION` | 有等价能力 |
| 行级删除（重写 part） | `ALTER TABLE DELETE` mutation | 无 |
| 行级标记删除 | lightweight delete 位掩码 | 无 |
| merge 时去重/替代 update | `ReplacingMergeTree` / `CollapsingMergeTree`（insert 新版本 → merge 去重 → `FINAL` 查询） | 无任何特殊 merge 引擎 |

O2 比 CK 更纯粹，就是只追加、粗粒度清理。CK 事实上的 upsert 是 insert 新版本，`ReplacingMergeTree` 在 merge 时按排序键留最新的，查询时 `FINAL` 或 `argMax` 收敛。O2 连这条路都没有，compaction 的 merge SQL 就是一句 `SELECT * FROM tbl ORDER BY _timestamp DESC`，没有任何按键去重或折叠的逻辑，`ReplacingMergeTree`、`CollapsingMergeTree`、`AggregatingMergeTree` 这一家子，O2 一个对应的都没有。这也是必然的，ReplacingMergeTree 去重的前提是按业务主键排序、merge 时把相邻的同键行去掉，而 O2 的排序键写死在 `_timestamp` 上，连按业务键排序都做不到，去重无从谈起。

所以要分清楚你的数据是什么。日志、指标、追踪这种天然只追加的事件流，正是 O2 的设计甜点。需要 upsert、去重取最新的，CDC、状态表、维表、需要去重的日志，在 O2 上只能查询时自己 `argMax` 或者 `GROUP BY` 去重，那是查询开销，不是存储去重。要做 GDPR、CCPA 合规删除，修正错误数据，按业务维度删，只能整个 stream 重建或者等分区过期。后两种情况 O2 直接出局，这是架构定位决定的，调配置绕不过去。

## 成熟度

O2 还是一个在快速迭代的产品，有几个坑已经被证实过。

metrics 查询 OOM：到 2024 年 12 月，metrics 查询路径还是一次性把数据全量加载进内存，有 OOM 风险，2025 年 1 月的 PR #5584 改成了分批读取，修掉了。

内存问题更像是设计上的特点，不是偶发 bug。O2 默认给搜索预留约 50% 的可用内存（`ZO_MEMORY_CACHE_MAX_SIZE`，可配），搜索和 compaction 或者批处理一起跑的时候，两边内存叠加可能触发 OOM。这个模式从 2023 年（v0.4.7）到 2024 年（discussion #2711 里有真实的 cgroup OOM kill 日志）一直存在，一直在被修补，得给查询和后台合并留出内存余量。至于社区里流传的具体倍数，「要 10 倍内存」「O2 内存是 Grafana 的 10 倍」「4 核 4GB 跑 25 亿条 OOM」「compactor 内存 = 单文件上限 × CPU 核数 × 2」，都只来自单个用户的报告，没有第二个来源，不足为信。能确定的就是并发时有 OOM 风险，具体阈值得自己测。

版本升级也出过事。2023 年 9 月，有用户从 0.5.2 直接升到 0.6.2，两个数据流（16.18GB）在 UI 里消失了。官方确认是 `metadata.sqlite` 需要迁移来适配 0.6.x 的结构变化，跨版本直升会跳过必要的迁移步骤，而且没有明确的报错，底层数据其实没丢，只是 UI 看不见了。这是 2023 年的早期版本，不能说 2026 年的版本还有同样的风险，但它说明 O2 历史上有过需要人工干预、又不报错的破坏性升级，升级前查迁移文档，别跨版本直升。

高基数点查，也就是按 trace_id 精确定位一条，业界普遍说 Parquet 放对象存储上对这个不友好。我去查了，DataFusion 官方的 object store 架构文档完全没讲延迟、点查、高基数的性能，这个说法既证实不了也推翻不了，只能 POC：拿 trace_id 精确查询，在 O2 和 ClickHouse 上各测一遍 P50/P99。

生产规模上，厂商说的数字很大。创始人 Prabhat Sharma 说最大客户每天 2.5 PB；官方口径是 6000 多个组织、5 家财富 100 强、银行和政府客户、单集群每天 100 TB 以上、每天超过 2 PB。单节点基准约 31 MB/s（Apple M2），折合每天 2.6 TB，PB 级靠 ingester、querier、compactor 水平扩展，再加 Super Cluster 跨区域联邦。

这些全是厂商自述。我觉得最可信的反而是一个踩坑故事：O2 最大的客户在 PB 级部署时撞上了 GCP 一个没写进文档的限制，GCS 单 bucket 单 project 每天读取上限 1 PB，只能拆成多个 project 和 bucket 绕过去。这种撞上云厂商未公开限制的细节编不出来，间接说明 PB 级部署是真的；同时也说明到了 PB 级，瓶颈往往不在 O2 本身，而在云的基础设施，而且是撞上了才知道。除此之外，没有独立、具名的第三方大规模案例，Gartner Peer Insights 评价是正面的，但都是匿名；Reddit、HN 上也没有第一手的大规模生产复盘。2.5 PB/day、1 PB 查询 2 秒、31 MB/s 这些数，全来自厂商营销、创始人访谈和自家文档，没人复现过。O2 能跑到 PB 级，我信；你的负载在它上面跑得好不好、花多少钱，公开资料回答不了，得在你自己的目标云上测。

## 我的看法

源码读下来，O2 的架构是怎么设计的，能看得比较清楚；它在你的规模下实际表现如何、到底省多少钱，公开资料不够下结论。140x、87x、每核 7–30 MB/s 几乎都是官方自己的数字，没有独立第三方的基准；O2 和 ClickHouse、SigNoz 之间的 TCO、延迟、运维复杂度，没有经过验证的直接对比；高基数场景、TB 到 PB 级的生产表现，也都没有独立的证据。

O2 和 CK 的存储引擎是近亲，排序、merge、列存、zstd，同一套原理。140x 是 ES 的臃肿衬托出来的，O2 并没有在压缩上超过 CK，而且我实测下来，O2 那吹得神乎其神的高压缩，在 CK 面前并不成立。它真正的卖点是对象存储当主存、schemaless 开箱即用、单机单二进制这一套成本和复杂度的结构。

什么时候可以用 O2？日志和追踪为主，冷数据留得久，更在乎存储成本而不是亚秒级点查；已经在用或者愿意用 S3、GCS、MinIO，想摆脱 ES 的本地盘成本；团队不大，想单二进制起步，以后再平滑上 HA；查询主要是时间范围加高选择性过滤，这是 DataFusion 加分区加索引最舒服的区间。这几条都满足的话，O2 用起来确实省心。

什么时候别用？依赖高基数点查，经常按 trace_id、request_id 精确找一条；大量高基数 group-by、复杂 join 的分析查询，DataFusion 在这儿比 CK 弱；要按索引字段做分组统计，又在乎结果对不对，top-n 那个问题修好之前，这是硬伤；需要更新、去重、按条件删除；需要一个成熟稳定、生产事故少的平台，O2 还在快速修架构级的缺陷；把官方的 140x 当成无条件的预算承诺，那个数前提很严，实测可能腰斩。

还有一点，O2 的开源协议是 AGPL，拿来做商业产品、对外提供服务，这一条对商用很不友好，法务那关要先过。

如果让我选，日志分析这件事我还是推 ClickHouse。这里有我做 CK 的私心，可也不全是。CK 压得不比它差，查得比它快，能调的东西多，结果对不对也让人放心；CK 的坑我大多踩过，知道它的边界在哪。O2 吸引人的那几样，对象存储、零建模、单二进制，确实是 CK 开源版的短处，如果你的团队没人会调 CK、数据就是纯追加的日志、主要诉求就是存得便宜，O2 值得认真 POC 一下。至于它在你的数据上到底表现如何，下一篇是 27.3 亿行的实测，附录里也有一份 POC 清单。

---

## 附录 A：结论和依据

「依据」一列：源码，是直接读 O2 仓库核实到文件或常量；官方+源码，是官方文档的说法被源码印证；论文/GitHub，是第三方学术成果或一手 issue；厂商自述，是只有官方单方面的说法；空白，是没有可采信的公开数据，需要自己测。标源码的，核对的是 O2 仓库 commit `99c571b`。

| 结论 | 置信度 | 依据 |
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
| 官方承认不存在 O2 vs ClickHouse 对比数据 | 高 | 官方维护者原话 |
| 默认预留 ~50% 内存给搜索，与 compaction 并发可致 OOM（定性） | 中 | 源码 + 多个 issue |
| 早期版本跨版升级破坏性变更（0.5.2→0.6.2，2023） | 中 | GitHub discussion |
| 开启全文索引的真实存储倍数 | 空白 | 无第三方数据，需 POC |
| O2 vs ClickHouse/SigNoz 的 TCO / 延迟硬对比 | 空白 | 官方确认不存在 |
| 高基数点查在对象存储上的延迟 | 空白 | 需自建 POC |
| PB 级生产案例（厂商称最大 2.5 PB/day、单集群 100+ TB/day） | 低-中 | 厂商自述 + GCP 踩坑佐证 |
| 物理排序键写死 `_timestamp`、不可配置、无多字段 | 高 | 源码 |
| 无 UPDATE / 无行级 DELETE / 无 ReplacingMergeTree 去重引擎 | 高 | 源码 |
| 全文索引仅 compaction 时生成（实时数据无索引） | 高 | 源码 |
| HA 集群强制依赖 PostgreSQL + NATS | 高 | 源码 |
| 索引字段上的 GROUP BY 会走 top-n 近似路径，跨文件多时静默丢分组 | 高 | 源码 + 实测 |

## 附录 B：主要信息来源

官方：

- OpenObserve 架构文档 https://openobserve.ai/docs/architecture/
- 性能优化指南 https://openobserve.ai/docs/enterprise-setup/performance/
- 竞品对比文档 https://openobserve.ai/docs/overview/comparison-with-alternatives/comparison/
- Tantivy 索引文档 https://openobserve.ai/docs/user-guide/advanced/query-tuning/tantivy-index/
- GitHub 仓库与源码 https://github.com/openobserve/openobserve
- metrics OOM issue https://github.com/openobserve/openobserve/issues/5456
- 1.1TB 基准博客 https://openobserve.ai/blog/elasticsearch-openobserve-benchmarking/

第三方和学术：

- DataFusion vs DuckDB 多核扩展性（SIGMOD 2024）https://dl.acm.org/doi/10.1145/3626246.3653368
- DataFusion ClickBench 博客 https://datafusion.apache.org/blog/2024/11/18/datafusion-fastest-single-node-parquet-clickbench/
- DataFusion object store 集成（DeepWiki）https://deepwiki.com/apache/datafusion/7.2-object-store-integration
- 源码分析（DeepWiki）https://deepwiki.com/openobserve/openobserve/2.2-data-storage-architecture
- ClickHouse 官方：nginx 日志压缩 178x 与 trade-off https://clickhouse.com/blog/log-compression-170x
- ClickHouse 官方：用日志聚类(Drain3)自动结构化 https://clickhouse.com/blog/improve-compression-log-clustering
- ClickHouse 官方：压缩编码/codec 原理 https://clickhouse.com/resources/engineering/database-compression

证据空白与生产坑：

- 官方承认无 O2-ClickHouse 对比 https://github.com/openobserve/openobserve/discussions/5662
- 内存/OOM 与 compaction https://github.com/openobserve/openobserve/discussions/2711、 https://github.com/openobserve/openobserve/discussions/1002
- 版本升级破坏性变更 https://github.com/openobserve/openobserve/discussions/1563
- index_size 反超数据体积信号 https://github.com/openobserve/openobserve/issues/5224
- top-n 静默丢分组 https://github.com/openobserve/openobserve/issues/13363

生产采用规模（厂商自述为主，无独立具名案例）：

- Techzine 报道（140x / 创始人访谈转述）https://www.techzine.eu/blogs/analytics/140020/openobserve-lowers-observability-storage-costs-by-140x/
- CubeAPM 定价与评测 https://cubeapm.com/blog/openobserve-pricing-review/
- Gartner Peer Insights（匿名评价）https://www.gartner.com/reviews/market/observability-platforms/vendor/openobserve/product/openobserve-748339221
- 官方 K8s at scale 指南（TB/day 量级示例）https://openobserve.ai/blog/monitor-kubernetes-logs-at-scale/
- HN 讨论（2024/10，偏 SSO 付费墙争论）https://news.ycombinator.com/item?id=41927743

## 附录 C：POC 清单

公开资料回答不了的问题都在这。要认真考虑上 O2，建议拿自己的真实日志依次验证：

1. 真实存储成本：取一份有代表性的生产日志，分别导入 O2（开、关 Tantivy 全文索引两种配置）和 ES，用 O2 的 `compressed_size` + `index_size` 对比 ES 的索引大小，算出你自己场景下的倍数，别信 140x 和 87x。
2. 高基数点查延迟：按 trace_id、request_id 精确查，测 O2 和 ClickHouse/SigNoz 的 P50/P99。
3. 聚合和 join 延迟：跑你最常用的高基数 group-by 和多表 join，对比 O2 和 ClickHouse，同时核对结果是否一致。
4. 内存余量和稳定性：在搜索加 compaction 并发的高压场景下压测，看 OOM 的表现，定出你这个规模需要预留多少内存。
5. 升级演练：在非生产环境走一遍版本升级，验证迁移步骤和数据可见性，定下不跨版本直升的升级流程。

### 压缩率怎么比才公平

只测最大压缩率没用，那是极限区。该做的是画出两边各自的取舍曲线：同样可用的查询性能下谁更省，或者同样的压缩率下谁更快。

先花五分钟用 `zstd -19` 把原始文件裸压一遍。要是裸 zstd 就逼近 O2 的落盘大小，说明高压缩率主要来自数据太软加 zstd，列存的增益有限，不用纠结引擎差异。

有四个坑不对齐的话，会误判成 CK 压不过 O2：

| 陷阱 | 后果 | 对齐做法 |
|---|---|---|
| CH 默认 LZ4，O2 默认 zstd | CH 天然吃亏 | CH 显式 `CODEC(ZSTD(3))` |
| CH 把整条日志塞一个 String 列 | CH 退化行存，被碾压是必然 | 让 CH 也拆列（JSON 字段各建列 / JSON 类型），对等 O2 schemaless |
| O2 未等 compaction 就量 | 量到未排序 WAL parquet，低估 O2 | O2 侧等 compaction 完成再量 |
| 样例 7MB 太小 | part/row group 效应不足，噪声大 | 真实对比用 ≥ 几百 MB~GB |

测几档，画散点，每档记压缩率和 P99 查询延迟两个坐标：

| 配置档 | 说明 |
|---|---|
| O2 默认 | O2 基本只有这一个点 |
| CH 甜点（~50x） | LowCardinality + 合理 codec + 中等 granularity |
| CH 极限 | 高 ZSTD level + 大 index_granularity |
| CH 低压 | LZ4 + 细 granularity |

测量口径要对齐。O2 用 `compressed_size` + `index_size`，别用 `storage_size`，那个字段累加的是 `original_size`，是 JSON 文本大小，不是落盘大小。CH 用 `SELECT sum(bytes_on_disk) FROM system.parts WHERE active`，这样二级索引也算进去了，只看 `system.columns` 的 `data_compressed_bytes` 会漏掉全文索引。索引也要对等，O2 含全文索引，就别拿去比 CH 的纯数据。

别忘了同时测查询。高基数点查和高基数 group-by 的 P50/P99 是 O2 的弱项，很可能测出来 O2 存储略省、查询慢一截，那才是完整的选型画面。

---

**相关**：[OpenObserve 压测实录：27.3 亿行下的真实表现](/clickhouse/comparison/openobserve-benchmark) · [存算分离横评](/clickhouse/comparison/storage-compute-separation) · [2026 年 ClickHouse 和 Doris 怎么选](/clickhouse/comparison/clickhouse-vs-doris)
