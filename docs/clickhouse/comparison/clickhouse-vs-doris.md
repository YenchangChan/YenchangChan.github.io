---
title: 2026 年 ClickHouse 和 Doris 怎么选
---

# 2026 年 ClickHouse 和 Doris 怎么选

> CK 的主要对手已经从 Elasticsearch 变成了 Doris。两者覆盖的场景大量重合，但相似的功能背后往往是不同的实现路径。从基础属性、性能、运维到生态四个维度展开，事实、实测与个人判断分开写。
>
> **阅读对象**：在 ClickHouse 和 Doris 之间做选型，或者手里还攥着三年前结论的人。

---

前些年讨论日志存储，大家习惯把 Elasticsearch 和 ClickHouse 放在一起比较。近几年，Apache Doris 在国内快速普及，CK 的主要对手也逐渐从 ES 变成了 Doris。无论是实时分析、可观测性，还是正在兴起的 AI 数据场景，这两款数据库经常同时出现在候选名单里。

本文不准备只比较查询速度。查询模式、写入语义、运维成本和团队能力都会影响最后的选择。CK 和 Doris 覆盖的场景有大量重合，但相似的功能背后，往往采用了不同的实现路径。

笔者有六年以上的 ClickHouse 开发和运维经验，是 ClickHouse、clickhouse-go 的 contributor，也是 ckman 和 clickhouse_sinker 的作者；同时也对 Doris 做过使用和优化。受经历所限，本文对 CK 的理解和生产案例会更深入一些。下面尽量把事实、实测经验和个人判断分开，讨论两者各自适合什么场景。

## 1. 基础属性对比

### 1.1 开源协议

Doris 是 Apache 顶级项目，采用 Apache License 2.0。ClickHouse 早期由 Yandex 主导，后来成立独立公司，总部位于西雅图，同样采用 Apache License 2.0。两者的开源协议都允许商业使用和二次开发。

虽然协议相同，两边的二次开发生态并不一样。CK 衍生出了不少公开或内部版本；Doris 的改动更多回流主干，公开的独立分支较少。StarRocks 与 Doris 存在历史渊源，但今天已经是两个独立演进的项目。

Doris 有社区版，也有 SelectDB 提供的商业产品和服务。两者共享主要内核能力，差异更多体现在交付形态、配套工具和技术支持。

ClickHouse 则同时维护开源版和 Cloud 产品。Cloud 提供存算分离以及更完整的写入、查询、监控和运维能力，其中一部分没有进入开源版。国内用户更多通过本地云厂商使用托管 CK，ClickHouse Cloud 在国内的可获得性和服务覆盖相对有限。

### 1.2  编程语言

ClickHouse 使用纯 C++实现，近些年也在开始实验性引入 Rust。Doris 的 BE 采用 C++，FE 和 UDF 则使用 Java。二者的 C++都已经使用到了比较新的 C++20 标准。

从编译产物来看，ClickHouse 安装包仅 200 多 M，而 Doris 则足足有 2.8 个 G，这大约也是因为多了很多 jar 包依赖的缘故。ClickHouse 提供了 rpm、deb、tgz 等多种安装方式，也提供了对应的 yum 源，apt 源，以及 docker 镜像。Doris 仅提供了 tar.gz 一种安装方式。

### 1.3 信创适配

Doris 最早由百度团队开发并开源，国内厂商主导的研发和服务体系，使它在信创认证、本地化适配和项目交付方面更有优势。

ClickHouse 在部分 Kylin ARM 环境中直接运行官方安装包会出现 coredump，但这并不意味着它在技术上无法适配，问题主要来自官方构建所采用的指令集基线与目标 CPU 不一致。使用`-DNO_ARMV81_OR_HIGHER=1`重新编译后，CK 可以正常运行。

因此，CK 在 Kylin ARM 上能用，但不一定开箱即用：落地团队需要识别软硬件差异，并承担编译、验证和维护安装包的工作。两者在这一场景中的差别主要是构建门槛和本地支持，并非 CK 本身不能运行。

### 1.4 安全漏洞

国内不少安全扫描工具以依赖版本和漏洞知识库做静态匹配，并不会进一步判断漏洞代码是否真正进入执行路径。Java 项目依赖数量通常较多，因此更容易产生大量需要逐项解释或整改的扫描结果。

对于一些要求比较严格的政企、银行、证券等行业，对安全这一块把控得又特别严，需要上线前做应用的安全漏洞扫描，甚至作为一个能否上线的强制准入条件。Doris 由于使用了大量的 Java 代码开发，自然不可避免地每次都能扫描出特别多的安全漏洞。

开源组件的漏洞修复最为麻烦，因为你不能指望官方给你去修，这个效率，估计要等到猴年马月去，而有些东西，并不是简单替换 jar 包就能完全修好的。而纯 C++系的 CK 则避免了这个困扰。（PS：我并不认为 C++写出的代码就一定没有安全漏洞，只是因为扫描软件太傻，没办法识别而已，而 java 代码只用比对 jar 包版本就行，简单粗暴。但很多企业就认这个，所以没办法。）

这类扫描会直接增加上线前的解释和整改工作，下面拆开来看。

先说扫描工具的工作方式。市面上大多数准入扫描走的是 SCA（软件成分分析）：解析构建产物，列出依赖清单，再拿版本号去比对 CVE 知识库。它判断的是「你用了某个存在已知漏洞的版本」，而不是「这段有漏洞的代码会不会被执行到」。这两件事的差距非常大，绝大部分扫出来的条目属于前者。

Java 在这套规则下天然吃亏，原因有三条：

1. **依赖树深**。一个 FE 模块直接声明几十个依赖，传递依赖展开后往往是几百个 jar。你并不知道它们从哪来，但扫描器全都算在你头上
2. **重灾区集中**。Log4j2、Fastjson、Jackson、Netty、Guava、commons-collections 这些几乎是每个 Java 项目的标配，也恰好是 CVE 披露最密集的几个库
3. **版本号一目了然**。jar 包的`MANIFEST.MF`、`pom.properties`把版本写得清清楚楚，扫描器不需要任何推断能力

而 CK 享受的「待遇」完全不同，但原因不是它更安全。笔者本地拉的 ClickHouse 主干仓库里，`.gitmodules`记录了**139 个 git submodule**，`contrib/`目录下有近 300 个子目录，里面包括 openssl、curl、google-protobuf、boost、libxml2、krb5、icu、libarchive、c-ares、avro——每一个都是 CVE 历史上的常客。

区别只在于：这些库以源码形式 vendor 进仓库，编译期静态链接进那个 200 多 M 的二进制里，成品既没有版本清单，也没有独立的 so 文件。SCA 工具面对一个静态链接的 C++二进制，基本什么都列不出来。所以扫描报告干干净净，不代表这些 CVE 不存在，只代表**工具看不见**。

进入修复环节后，常见问题有三类：

- **升不动**。开源项目的依赖版本是上游定的。你把某个 jar 单独升上去，很可能撞上 API 不兼容或行为变更；要保证正确，就得自己维护一个补丁分支，长期跟着上游 rebase
- **修不了**。有些 CVE 的所属组件已经 EOL，上游根本不会再发版；有些漏洞的修复需要改调用方式，不是换个版本号能解决的
- **等不起**。等上游社区合并修复再发版，周期完全不可控，而项目上线窗口是死的

在强合规场景下，除了升级依赖，还可以提前准备完整的 SBOM、逐条的可达性说明，以及不可达项的豁免材料。这些材料能否被接受，取决于具体机构的准入规则。

这里比较的是**通过安全准入的成本**，不是两款数据库真实的安全水平。C++静态链接让 CK 较少暴露在基于依赖清单的扫描中，但 C++本身也存在内存安全风险。因此，扫描结果的数量不能直接代表产品安全性。

## 2. 性能与资源

### 2.1 查询能力

#### 2.1.1 聚合查询

在大规模扫描和聚合查询上，ClickHouse 通常更有优势，尤其适合数据追加写入、查询集中在排序键和聚合指标上的场景。笔者的部分生产测试中，同样是十亿级数据量的计数或聚合，CK 可以在秒级返回，而 Doris 需要更长时间。不过这类数字受表模型、数据分布、缓存状态、并行度和机器配置影响很大，不能脱离测试条件直接当作通用结论。

究其原因，ClickHouse 虽然和 Doris 都是列存，但是磁盘底层逻辑上还是有很大差别。

CK 的数据层级是 SHARD->PARTITION->PART->GRANULARITY->ROWS， 其数据在磁盘中是排序存放的，这决定了它拥有更高的压缩比之外，对于指定列的查询，也能达到极致查询速度。

Doris 的数据层级是 PARTITION->BUCKET->TABLET->ROWSET->ROWS。它先按分桶规则把数据拆成适合并行处理的 tablet，tablet 内部再按 Key 列排序并建立前缀索引。与 CK 相比，Doris 的数据分布更强调并行执行、更新语义和可迁移性；CK 则把排序键、稀疏索引和物理布局结合得更紧密，在符合排序键的数据裁剪和压缩上通常更占优势。

把两边的层级并排放，差异会更直观。注意 Doris 比 CK 多出的 BUCKET/TABLET 这一层，它在 3.2 节讨论数据均衡时还会再出现。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/doris-01.light.svg" alt="2.1.1 聚合查询">
<img class="dfig-d" src="/diagrams/doris-01.dark.svg" alt="2.1.1 聚合查询">
</figure>

#### 2.1.2 join 查询

在过往很多介绍 Doris 的文章中，经常会拿 JOIN 查询能力来打 ClickHouse。

Doris 的 JOIN 优势首先来自分布式执行策略和优化器。

Doris 的 FE 节点在规划分布式 join 查询计划时，其优先级顺序如下：
    Colocate Join -> Bucket Shuffle Join -> Broadcast Join -> Shuffle Join

colocate join 的原理是本地 join，它要求参与 join 的 hash key 分布在相同的节点上（可以在建表时通过 colocate_with 属性来指定）。

bucket shuffle join 主要用于等值 HASH 场景。当左表已经按 JOIN 键分桶时，左表数据可以留在原节点，只需按照相同的分桶规则重新分发右表，网络开销约为右表数据量。

broadcast join 简单粗暴，直接将右表全量数据发送给各个节点。网络开销和内存开销均是 N * B（N 为节点数，B 为 B 表数据）

shuffle join 是将左表和右表的数据经过 hash 计算分散到各个节点中，网络开销为 A+ B,内存开销为 B。

除此之外，Doris 为了加速 join 查询，还提供了 runtime filter 机制。当扫描左表和加载右表同时进行时，右表一般会率先完成，此时根据 join on cause 动态生成一些过滤条件，并广播给正在各个节点扫描的左表，使得左表扫描的数据量减少，从而加速整个查询，避免不必要的网络开销。它主要适用于左表很大，右表很小时的场景。

ClickHouse 的分布式 JOIN，分为带 global 和不带 global，不带 globa 的 join 存在严重的读放大问题，基本上不会使用。常规的 global join 流程如下：

1. 汇总节点将右表改成子查询，先在汇总节点将右表的数据结果集查询出来
2. 将右表的结果集广播给各个节点，与各个节点的左表本地表进行 join 查询
3. 各个节点将查询结果发送给汇总节点

它的执行过程更接近 Broadcast Join。ClickHouse 没有直接提供 Doris 式的 colocate group，但可以在写入端按 sharding key 固定路由，让关联数据落到相同节点，获得本地 JOIN 的条件。我们在 clickhouse_sinker 中采用了这一做法；一组生产数据中，事实表约 300 亿行、维度表约 5000 万行，相关 JOIN 可以在两三秒内返回。这个数字仅说明该数据布局下的效果，不能单独代表通用 JOIN 性能。

ClickHouse 一直被人诟病的是大表与大表 JOIN 能力弱，多张表之间的 JOIN 性能差。原因还是在于右表太大，构建 hash 表会占用太多内存，不仅容易出现 OOM，而且性能奇差。然而在 24.7 版本以来，ClickHouse 对 parallel hash join 做了持续优化，至 25.7 版本趋于稳定。在资源占用、查询性能方面已经有了非常大的提升。在官方压测报告中，9 张表的 JOIN 查询也不在话下。

ClickHouse 还有一个非常好用的功能是可以拿 CK 的数据与 Mysql 表的数据进行 JOIN。由于 CK 的特性，数据易于插入和查询，不易于修改和删除。我们便可以将那些需要频繁修改的维度数据存储到 MySQL 中，而涉及到大数量的事实表数据存储于 CK 中。然后通过 MySQL 引擎将 mysql 表中的数据与 CK 中的表进行 JOIN。这则是 Doris 不具备的新场景了。

Doris 的多表 JOIN 能力不只来自执行策略，也依赖 Nereids 优化器。它可以根据统计信息调整 JOIN 顺序，把较小的输入放到构建侧，并提前执行选择性较强的过滤。早期 CK 更依赖 SQL 书写顺序和人工改写，复杂 JOIN 往往需要手动调整嵌套关系。CK 从 23.x 开始重写 analyzer，25.x 之后陆续加入 join reorder，两者在优化器成熟度上的差距正在缩小。

ClickHouse 在 25.10 版本引入了`enable_join_runtime_filters`（PR #84772），原理与 Doris 完全一致，从右表的 JOIN key 构建 bloom filter，在 JOIN 执行前作为 PREWHERE 下推到左表扫描，跳过无关行。该特性在 2026 年 2 月起已默认开启，26.4/26.5 又做了增强：ON 子句中即便同时包含非等值谓词，也仍会基于等值 key 构建 filter；并且能利用首次执行收集的 runtime 统计信息，在后续执行中自动切换到 parallel hash 算法。所以过往文章里「Doris 有 runtime filter 而 CK 没有」这条对比，现在已经作废了。

#### 2.1.3 并发查询

CK 的官方默认配置里，单节点最大连接数为 100， 它其实释放出一个信息：CK 的并发查询能力可能并不是很强。这是由它的执行模型决定的，而不是某个参数没调好。

准确地说，CK 的`max_connections`默认是 4096，能建的连接并不少；但`max_concurrent_queries`默认只有 100，连接进得来，查询得排队。排不上的请求在队列里等`queue_max_wait_ms`（默认 5 秒），等不到就抛`Too many simultaneous queries`。

为什么要这么设？因为 CK 的单个查询默认就要吃掉半台机器。`max_threads`默认取 CPU 核数的一半，一条 SELECT 下去，几十个线程一起并行扫数据。这正是 CK 能把十亿行 count 做到秒出的原因，也正是它并发上不去的原因，这是同一件事情的两面。你不可能既要每个查询独占大半台机器，又要几百个查询同时跑。

笔者在高并发场景中的调优思路，是先降低单条查询的资源占用：

1. 对短查询尝试`max_threads=1`。在笔者的负载中，这减少了上下文切换和线程汇合开销，提高了总体 QPS；重扫描查询不适合直接套用这一配置
2. 对小结果集短查询比较 HTTP 与 Native 协议。笔者的测试中，不带 keepalive 的 HTTP 请求在 2000 并发下仍能保持 50ms 以内延迟；连接建立成本和网络环境不同，结果也会变化
3. 然后才是调大`max_concurrent_queries`，同时把`queue_max_wait_ms`调小，让排不上的查询快速失败而不是把连接池拖死
4. 最后是架构手段：单分片、每节点全量数据，QPS 不够就横向加节点。这个方案还有个副作用好处——单分片不走网络，JOIN 性能反而更好

即便采用上述配置，CK 的并发上限仍需要重点验证。网易云音乐公开过一组数据：其 CK 集群在并发查询数超过 200 后频繁出现`Too many simultaneous queries`，而同一案例中的 Doris 可以支撑 500 以上并发。这是特定业务和集群配置下的结果，不能直接换算成两款产品的固定上限。

Doris 的 BE 按 tablet 粒度并行执行查询，并可通过 Workload Group 限制不同负载的资源占用。这套模型更偏向同时处理大量短查询，但可达到的并发数仍取决于查询复杂度、数据裁剪效果和单节点资源。

Doris 在高并发服务上更有优势，但这更多是执行模型的取舍，而不是简单的技术高下。大量用户同时发起短查询时，Doris 通常更合适；并发不高、但单条查询需要尽快完成时，CK 更容易发挥并行扫描能力。具体分界仍应以实际查询集压测为准。

#### 2.1.4 全文检索

全文检索是两边近几年变化最快的能力之一，很多旧的对比结论已经失效。

Doris 从 2.0 版本开始内置倒排索引，支持任意维度快速检索和文本分词全文检索。到 2.x 已经相当成熟，4.0 又引入了`search()`函数，把检索语法直接嵌进 SQL 里。网易云音乐的案例中，倒排索引把全文检索性能提升了 7 倍，支撑 50 台服务器、2PB 数据、峰值 6GB/s 的写入吞吐。可以说，Doris 是把「当 ES 用」这件事真正做成了。

而 ClickHouse 这边，过去几年一直被打的就是「不支持全文检索」。现在情况变了，但变得没有宣传的那么好。

CK 的 text index 确实 GA 了。从源码里的`SettingsChangesHistory.cpp`可以拉出完整的时间线：

| 版本 | 事件 |
| --- | --- |
| 24.6 | `allow_experimental_full_text_index` 引入 |
| 25.9 | text index 第三次重写，仍是 experimental |
| 25.12 | 转 beta，`default`分词器名被废弃，必须显式指定分词器 |
| **26.2** | `{"allow_experimental_full_text_index", true, true, "The text index is now GA"}`，**正式 GA** |
| **26.6** | 新增`allow_experimental_text_index_lazy_apply` |
| **26.7** | 上述开关被标记为 obsolete，改用`text_index_posting_list_apply_mode='lazy'` |

GA 之后的第四个版本又塞进来一个新的 experimental 开关，而这个开关只活了一个版本就被废弃改名。与此同时，短语搜索所依赖的`allow_experimental_text_index_phrase_search`至今仍挂着 experimental 的牌子，官方明说磁盘格式还不稳定。

分词器的命名混乱更是一目了然。`TokenizerFactory.cpp`里有这么一行：

```cpp
factory.registerTokenizer("unicode_word", ITokenizer::Type::AsciiCJK, ascii_cjk_creator);
```

注册名叫`unicode_word`，枚举类型却是`AsciiCJK`。同一个分词器现在挂着`asciiCJK`、`unicodeWord`、`unicode_word`三个名字；默认分词器`SplitByNonAlphaTokenizer`还得靠`getName()`和`getExternalName()`两套名字来兼容历史。

再看提交历史上的反复：短语搜索的`positions`参数在 2026-07-09 才改名为语义明确的`support_phrase_search`；6 月 23 日一天之内出现了`rename one field` → `Revert "rename one field"` → `rename one field`；6 月 18 日有一条`remove settings from mergetreesettings until positions are ready`；6 月 25 日的`Reapply "Text index postprocessor"`说明这个特性被整个 revert 过一次；7 月 7 日还有一条`Don't use the text index for hasToken with non-splitByNonAlpha tokenizer`，`hasToken`配非默认分词器被直接判定为坏组合，禁止走索引。

除了接口和实现仍在变化，CK 的 text index 还有三个明确的功能限制：

1. **不支持 BM25**，没有相关性打分。官方自己的定位是「加速引擎而非相关性引擎」——它能帮你快速过滤出包含关键词的行，但没法告诉你哪一行更相关
2. `LIKE '%term%'`用不上索引。索引只在能切出完整 token 时才激活，模糊匹配依然是全表扫
3. `hasToken`用的是默认分词器而不是索引的分词器，这个坑大到官方不得不新增`searchAny`/`searchAll`两个函数来绕开

因此，CK 目前更适合把 text index 理解为关键词过滤加速，而不是完整的搜索引擎。GA 之后接口仍在频繁调整，短语检索等能力也尚未完全稳定，不宜仅凭「已经 GA」就直接接管 ES 负载。Doris 的倒排索引在分词、相关性和生产成熟度方面更完整，如果目标是全文检索而不仅是日志分析，现阶段更稳妥。

#### 2.1.5 跨集群与跨机房

ClickHouse 目前没有面向开源版的原生跨集群持续复制方案。

CK 能做的是跨集群「查询」，`remote()`/`remoteSecure()`表函数可以直接查另一个集群的表，Distributed 表也能把远端集群的表纳进来。但这只是查询时的临时拉取，不是数据复制。真正要做异地灾备或多机房数据同步，官方给不出答案。历史上有个`clickhouse-copier`，现在已经废弃了。

所以 CK 的跨集群方案，实际上都在数据库之外。一种是写入端双写（我们在 clickhouse_sinker 里就是这么干的，一份数据同时投递到两个集群）；另一种是把多个物理集群在管理层抽象成一个逻辑集群，ckman 里的逻辑集群功能就是这个思路，让上层查询看到的是一个统一的集群视图，而底层是多个独立的物理集群。这种方案的好处是物理集群之间完全解耦，坏了一个不影响另一个；坏处是数据一致性得自己保证。

Doris 这边有原生方案，叫 CCR（Cross Cluster Replication）。2.0 版本引入 Binlog 机制（Meta Binlog 和 Data Binlog）记录数据变更，通过一个叫 Syncer 的外部组件读取 binlog 并回放到下游集群。它的底层实现是 Backup/Restore 做全量，然后按 CommitSeq 做增量回放。能力上确实完整：库级/表级同步、全量或增量、甚至支持 DDL 同步（上游建表加字段，下游自动跟上）。

但 CCR 的实际实用性一般。看看官方文档自己列出的注意事项：

- 同步期间 backup/restore job 和 binlog 全部驻留在 FE 内存中，建议为每个 CCR job 在源集群和目标集群的 FE 各预留 4GB 以上堆内存。多几个 job，FE 就得单独扩容
- binlog 默认无限保留，必须手动设置`binlog.max_bytes`等限制，否则磁盘迟早被撑爆
- 同步的表如果带倒排索引，目标集群必须配置`restore_reset_index_id=false`，否则索引对不上
- 上游只要创建了 tmp partition，Doris 就会禁止 backup，直接导致同步中断，得设置`ignore_backup_tmp_partitions=true`来规避
- `max_backup_restore_job_num_per_db`默认 10，官方建议调到 2
- BE 的`thrift_max_message_size`默认 100MB，tablet 数量多了会超限，得调大

再加上 Syncer 本身是个需要独立部署和运维的外部进程，整套东西的运维复杂度并不低。它更像是「能用」，而不是「省心」。

账面上 Doris 赢，毕竟有原生方案。但真到生产上，CCR 是个需要精心调参和持续照看的半成品，CK 那套双写加逻辑集群虽然朴素，反而更可控。笔者的建议是，跨机房这件事无论用哪个数据库，都别指望它自己能解决好。

#### 2.1.6 物化视图

讨论物化视图时，不能只把它理解成「预计算后的查询缓存」。在 ClickHouse 中，增量物化视图还承担了流式计算和写入转换的职责。

CK 和 Doris 各有三种预计算机制，但这三条能力线是错位的，直接正面比较会得出错误结论。

##### CK 的增量物化视图：一个内嵌在数据库里的流处理引擎

CK 的增量 MV 不是「定时刷新的缓存」，它是插入触发器。每个 INSERT block 到达时，MV 立即对这一批新数据完成计算，把结果写进目标表。从 PostgreSQL 过来的人往往会带着「物化视图=缓存的查询结果+定时刷新」的心智模型，在 CK 这里是完全错的。

这么设计带来的第一个好处是成本只与增量相关，与表总量无关。一张 PB 级的表挂上 MV，对集群几乎没有额外压力，因为它永远只算刚写进来的那一个 block。所有「定时全量重算」的方案在这一点上都没法比。

第二个重要能力是持久化聚合状态（AggregateFunction）。`sumState`、`uniqState`、`quantilesState`、`maxState`这些`-State`组合子保存的不是最终结果，而是可以继续合并的中间态；查询时再通过`-Merge`得到所需粒度的结果。

换来的效果是：一份按分钟粒度存储的`uniqState`，能正确合并出小时、天、月的精确去重数，而不是把每分钟的 UV 简单相加。粒度可以任意往上卷，而且结果是对的。

CK 的优势在于，聚合状态与增量物化视图、AggregatingMergeTree 和函数组合子形成了一套成熟体系。Doris 也提供`AGG_STATE`以及`state`、`merge`、`union`组合子，并可通过 BITMAP、HLL 等状态继续聚合，但覆盖范围、成熟度以及与增量处理链路的结合方式和 CK 并不相同。因此这里更准确的结论是 CK 体系更完整，而不是 Doris 完全不具备聚合中间态。

聚合状态还可以级联复用：源表 → MV → 分钟级 AggregatingMergeTree → 再挂 MV → 小时级 → 再挂 MV → 天级。每一层通过`-MergeState`继续合并下层状态，由此构成实时聚合链路，各层计算量都主要取决于新增数据。

第三个好处是 MV 不止能做聚合，它本身就是一个完整的 ETL 算子。MV 里可以做 schema 转换、字段解析、类型清洗，还可以做条件路由——一张源表挂多个 MV，各自带不同的 WHERE 条件，把数据分流写进不同的目标表。配合`Null`引擎作为源表（写入不落盘，纯做扇出），可以做出「一次写入、多路加工、零冗余存储」的管道。

而 CK 生态里最经典的入库范式，正是建立在 MV 之上的：

```
Kafka引擎表 → 物化视图 → MergeTree表
```

消费、转换、落盘，全部在数据库内部完成，不需要任何外部 ETL 进程。很多团队正是用这一套省掉了一整套 Flink 作业。

把上面讲的几种用法画在一起，更能看出增量 MV 在 CK 里承担的角色：左侧是 Kafka 入库管道，中间是聚合状态的级联，下方是借助 Null 引擎做的扇出分流。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/doris-02.light.svg" alt="CK 的增量物化视图：一个内嵌在数据库里的流处理引擎">
<img class="dfig-d" src="/diagrams/doris-02.dark.svg" alt="CK 的增量物化视图：一个内嵌在数据库里的流处理引擎">
</figure>

当然代价也很明显：只有最左侧的源表插入才会触发 MV，右表数据变更不触发；没有快照隔离，AggregatingMergeTree 的 merge 是异步的，读到的可能是部分合并的状态；以及最现实的一条，同一张高频写入的表上挂多个 MV，会成倍放大`too many parts`问题。

##### CK 的另外两种机制

**Projection**：查询仍然面向主表，由 CK 自动判断是否使用 projection。它与主表同生命周期，支持自动回填，不要求修改 SQL，因此适合对接 BI 工具。限制是只能用于单表，不能引用其他表；创建过多也会明显增加存储开销。

**Refreshable MV**：24.10 起 production-ready，定时对全量数据重算并写入目标表。支持`DEPENDS ON`构建 DAG，一个视图等另一个跑完再刷新，可以替代简单的 dbt 调度；26.6 又加了级联刷新和实验性的连续查询。代价是成本正比于源表总量而非变更量，大表上全量刷新既慢又吃内存。而且必须显式去查目标表，不会透明改写。

##### Doris 侧

**同步物化视图**：实时，但本质是 rollup，只能单表，可用的聚合函数有限。

**异步物化视图**：能做多表 JOIN，并且在 CBO 层做透明改写，这是 Doris 真正的优势所在。用户根本不需要知道 MV 的存在，优化器会自动判断能否用 MV 改写查询。而 CK 的三种机制里，Projection 有透明改写但只能单表，Refreshable MV 能 JOIN 但必须显式查目标表，没有一个能同时做到「多表」和「透明」。

##### 对照

| 能力 | ClickHouse | Doris | 判断 |
| --- | --- | --- | --- |
| 流式增量计算 | 增量 MV（插入触发器） | 无对等物 | **CK 独有** |
| 可再聚合的中间态 | AggregateFunction + `-State`/`-Merge` | 无 | **CK 独有** |
| MV 内做 ETL/路由/消费 Kafka | 生态核心范式 | 需外部组件 | **CK 领先** |
| 单表透明改写 | Projection | 同步 MV | 打平 |
| 多表 JOIN 的 MV | Refreshable MV | 异步 MV | 打平 |
| 多表 MV 的 CBO 透明改写 | 无 | 支持 | **Doris 独有** |

两者的物化视图并不是同一条能力线。CK 擅长增量计算、状态持久化、Kafka 消费以及写入时转换和分流，使用方式接近数据库内嵌的轻量流处理；Doris 则擅长由优化器自动匹配多表物化视图，让已有 SQL 直接获得加速。前者强调计算和管道能力，后者强调查询改写和使用透明度。

流式加工链路更适合发挥 CK 增量 MV 的能力；如果目标是加速已有 BI 报表且尽量不修改 SQL，Doris 的透明改写更省事。

#### 2.1.7 数据湖查询

Doris 在这一块的设计更「正统」。它的 Multi-Catalog 建立了 catalog → database → table 的三级元数据体系，外部数据源在 catalog 这一层就整体接进来。支持 Hive、Iceberg、Hudi、Paimon、Elasticsearch、JDBC 等。这解决了老版本的一个真实痛点，早期 Doris 只有 db 和 table 两级，接外部数据得一张表一张表地`create external table`，几百张表就是几百条 DDL。

有了 catalog 这一层，Doris 能做到几件 CK 做不了的事：跨 catalog 的联邦 JOIN（一条 SQL 同时 JOIN Hive 表、Iceberg 表和 Doris 内表）、统一的权限治理（RBAC 可以下沉到外部 catalog，并遵循 catalog 侧的 IAM/HMS ACL）、以及湖上写回。2.1 版本又补上了多 SQL 方言兼容和 Arrow Flight 高速读取接口。

CK 这边提供了三种机制，各自对应不同的访问模式：

1. **表函数**：`iceberg()`、`deltaLake()`、`hudi()`、`paimon()`，一条 SQL 里直接查，不需要提前配置，还有 S3/Azure/GCS 各种变体
2. **表引擎**：`IcebergS3`（别名`Iceberg`）、`IcebergAzure`、`IcebergHDFS`、`IcebergLocal`，把外部表持久化成 CK 里的一张表定义
3. `DataLakeCatalog`库引擎：对接 Unity、REST、Polaris、Glue 等 catalog 做自动发现，26.2 起还支持查 Google BigLake

配合 25.8 引入的 Parallel Replicas，CK 可以把文件扫描分摊到多个节点，读取 Parquet 的吞吐也有明显提升。与 2024 年的版本相比，2026 年 CK 对 Iceberg 的支持已经完善了许多。

但差距在深度而不在有无。CK 把湖当作一个「数据源」来读，Doris 把湖当作「一等公民」来管。联邦 JOIN、统一权限、写回这三项，CK 都弱。

两者的定位可以概括为：CK 侧重高效读取外部湖数据，Doris 侧重把数据湖纳入统一查询和治理体系。需要跨异构 catalog 联邦查询、统一权限或湖上写回时，Doris 更合适；如果数据湖主要是只读上游，最终仍要落入本地表提供高吞吐分析，CK 已经足够，单表扫描也很有竞争力。

#### 2.1.8 存算分离

存算分离是本文中两者产品边界差异最明显的一项。

Doris 3.0 引入了完整的存算分离架构，三层结构：共享存储层（对象存储或 HDFS）+ 计算组（Compute Group） + 元数据服务（Meta Service）。数据持久化在共享存储，无状态的 BE 节点编组成计算集群，通过`use @<compute_group_name>`把不同负载分配到不同计算组，实现导入与查询的物理隔离、读写分离。

工程上的细节也做得不错：采用渐进式主动缓存预热，扩缩容期间不影响正在进行的查询和导入；升级时用多进程模式保证查询和导入不失败；一个集群的表可以只通过元数据复制就克隆到另一个集群。

官方给出的收益是存储成本下降约 90%，同时——这个数字更值得看：查询性能下降约 35%。用性能换成本，值不值得就看具体场景了。

CK 这边呢？对应的能力叫 SharedMergeTree，只在 ClickHouse Cloud 里有，开源版本没有。

开源版能做的只有「存储下沉」：把 S3 注册成一块磁盘，用`TTL ... TO VOLUME`把冷数据挪过去。这解决的是冷数据的存储成本问题，但计算和存储依然是绑死的，你没法独立扩计算节点，没法做计算组隔离，扩容依然要搬数据（见 3.2）。这不是存算分离，这只是分级存储。

这里引用的公开对比材料主要来自 SelectDB/VeloDB 官方博客，包括「成本下降约 90%」这一数字，因此只能作为厂商案例参考，不能替代独立测试。但 SharedMergeTree 未进入 ClickHouse 开源版，是可以明确确认的产品边界。

对于必须私有化部署存算分离架构的用户，Doris 有明确优势。两者虽然都使用 Apache 2.0 协议，但开源范围并不相同：Doris 把存算分离放进了开源版本，CK 的 SharedMergeTree 则属于 Cloud 能力。这不是性能差异，而是直接影响选型的产品边界。

### 2.2 存储能力

#### 2.2.1 分区机制

分区看起来只是建表时的一行 DDL，但两家在这里的取向截然不同，而且这个差异会一直影响到日常运维。

**ClickHouse：数据驱动，先有数据后有分区**

CK 的`PARTITION BY`是一个表达式。数据写进来时对表达式求值，得到分区名；分区不存在就当场创建。整个过程不需要任何预先规划。

```sql
PARTITION BY toYYYYMM(event_time)
```

建完表直接灌数据，2023 年的数据来了就有 2023 年的分区，2026 年的来了就有 2026 年的。回填十年前的历史数据也一样，不需要提前做任何准备。这种自由度在数据探索、历史回补、时间跨度不确定的场景下非常舒服。

代价是分区数量失控的风险完全落在使用者身上。分区键粒度选细了（比如跨多年的数据用`toDate()`按天分，或者把某个高基数维度拼进分区键），分区数量会以肉眼可见的速度膨胀。更隐蔽的是脏数据：日志里混进一个 1970 年或 2099 年的时间戳，就能凭空造出一个分区，而且它会一直待在那里。

CK 有一道保护叫`max_partitions_per_insert_block`，默认 100，超了就抛`Too many partitions for single INSERT block`，整个 INSERT 原子回滚。但要注意它限制的是**单个插入块涉及的分区数**，不是表的分区总量——它拦得住「一次写入撒到几百个分区」，拦不住「分区总数慢慢涨到几万个」。

分区多了的后果，CK 官方在错误信息里写得很直白：服务器启动变慢、INSERT 变慢、SELECT 变慢，建议单表分区总数控制在 1000 以内。同一段提示里还有一句常被忽略的话：**分区不是用来加速查询的**，那是排序键的职责；分区是为了支持`DROP PARTITION`这类数据操作而存在的。很多人把分区当索引用，方向从一开始就错了。

最麻烦的是纠错成本。CK 不支持原地修改 MergeTree 表的分区键，一旦发现选错，只能新建表、迁数据、`RENAME`交换。所以`PARTITION BY`这一行，属于建表时就得想清楚的决定。

**Doris：规划先行，先有分区后有数据**

Doris 传统的 RANGE/LIST 分区必须先建好。分区不存在时数据写不进去，导入直接报错。好处是分区数量始终在掌控之中，不会有意外膨胀。

面向未来的增量数据，`dynamic_partition`可以自动滚动：按`start`/`end`窗口定期创建新分区、回收过期分区，配好几个参数就不用管了。

问题出在历史数据上。动态分区只负责窗口之内，超出`dynamic_partition.start`的历史数据没有分区可落，导入会失败。要一次性补齐历史分区，得开`create_history_partition=true`，还要受 FE 的`max_dynamic_partition_num`限制。而且有个容易踩的坑：`start`与当前时间之间若有分区意外丢失，动态分区**不会**重新创建它们（只有当前时间到`end`之间的会补）。

所以往 Doris 里导历史数据这件事，心智负担确实比 CK 重——你得先算清楚要多少个分区、用什么方式建出来、会不会撞上数量上限。

**而这套机制真正难受的地方，在于数据时间轴稀疏的时候。**

举个实际会遇到的场景：一个月前的某一天补了一批历史数据，中间三十来天什么都没有，然后跳到今天才有新数据进来。按天分区的话，你想让那一天的数据落进去，就必须把从那天到今天之间的分区**全部创建出来**——中间那三十个分区一行数据都不会有，纯粹是为了让边界上那一天能进库而存在。

分区数量是靠这种方式凑齐的，这跟「按需分配」就是两回事了。而且空分区并不是零成本：

- 每个分区都要按分桶数乘副本数分配 tablet。一张 32 桶 3 副本的表，一个空分区就是 96 个 tablet 的元数据，30 个空分区接近 3000 个
- 这些 tablet 元数据全部驻留在 FE 内存里，同时要写进 BDB JE 并参与 checkpoint
- BE 侧同样会创建 tablet 目录和 meta 记录，并周期性向 FE 做 tablet report。tablet 规模上去之后，report 消息本身就会变大——2.1.5 节提到的 CCR 场景里，`thrift_max_message_size`默认 100MB 被撑爆，根因正是 tablet 数量过多
- 查询规划阶段做分区裁剪时，要遍历的是完整的分区列表，空分区一样占位置

更现实的约束是上限。`max_dynamic_partition_num`默认只有**500**（源码`Config.java:1686`），按天分区一年多一点就顶到天花板了。想覆盖更长的历史区间，要么调大这个参数，要么放弃动态分区改用手工`ALTER TABLE ADD PARTITION`按需补，后者又回到了「得自己算清楚建哪些」的老路上。

同样的数据形态在 CK 这边不构成问题：7 月 5 日有数据就建 7 月 5 日的分区，中间三十天没数据就一个分区都不建，连空目录都不会有。这正是数据驱动模式的直接好处。

Doris 2.1 引入的**AUTO PARTITION**恰好是冲着这个来的：按导入数据的实际取值按需创建分区，同时支持 RANGE 和 LIST，中间的空洞不会被填上，也天然容纳任意历史时间点。本质上这是朝 CK 那套数据驱动模式靠了一步。

但它并不是免费的升级，用之前要清楚几件事：

- 导入时要先检索已有分区再决定是否创建，相比动态分区有额外的时间开销
- 只负责创建，不负责回收。生命周期管理得靠外部调度脚本`DROP PARTITION`，动态分区那套自动过期就用不上了
- **2.1.3 起不能与 dynamic_partition 共用**。原因是动态分区回收时不区分分区的创建来源，会把 AUTO PARTITION 建出来的分区一并回收，造成不易察觉的数据丢失
- 导入失败或被取消时，过程中已创建的分区不会自动清理
- 上限换成了`max_auto_partition_num`，默认**2000**（源码`Config.java:2953`），比动态分区宽松，但依然是个需要盯着的数字

所以在 Doris 上，「不产生空分区」和「分区自动过期回收」这两件事，2.1.3 之后是**二选一**的：用 dynamic_partition 拿到自动回收，就得接受稀疏数据带来的空分区；用 AUTO PARTITION 避开空分区，就得自己写脚本管过期。这个取舍在 CK 那边不存在，因为 CK 的分区创建和 TTL 回收本来就是两套彼此独立的机制（TTL 见 3.4 节）。

**两种取向的代价落点不同**

| 维度 | ClickHouse | Doris |
| --- | --- | --- |
| 分区创建 | 写入时按表达式自动创建 | 需预先创建，或由 dynamic/AUTO 托管 |
| 历史数据回填 | 无需准备，直接写 | 需先补历史分区，或改用 AUTO PARTITION |
| 时间轴稀疏时 | 只为有数据的时间点建分区 | dynamic 需填满区间产生空分区；AUTO 可避免 |
| 分区膨胀风险 | 脏数据即可凭空造分区 | 数量可控，但空分区同样占 tablet 元数据 |
| 数量上限 | 官方建议单表 1000 以内（软约束） | `max_dynamic_partition_num`=500 / `max_auto_partition_num`=2000（硬约束） |
| 写入端保护 | `max_partitions_per_insert_block`（限单块） | 无对应分区则直接拒绝写入 |
| 分区键可改 | 不可原地修改，需重建表 | 可增删分区，分区列同样不可改 |
| 生命周期 | TTL 独立于分区创建（见 3.4） | dynamic 自带回收；用 AUTO 则需外部脚本 |

概括起来：**CK 把分区当成写入的副产物，Doris 把分区当成需要申报的资源**。前者省去了规划，把风险留到运行期，代价是分区可能被脏数据带跑；后者在建表和导入阶段多花心思，换取分区规模的确定性，代价是数据时间轴不连续时要用空分区去凑。选哪种更省事，取决于你的数据时间跨度是否可预期、上游时间字段是否干净，以及历史数据是成片到达还是零散补录。

#### 2.2.2 数据更新与删除

数据更新与删除是 CK 和 Doris 最核心的架构分歧之一，也往往是选型中的硬约束。

CK 主要面向追加写入，更新和删除能力是在这一基础上逐步补充的：

- ReplacingMergeTree：同主键的数据最终保留最新版本，但去重依赖后台 merge，完成时间并不确定。需要立即得到去重结果时通常要在查询中使用`FINAL`，由此增加读取和合并开销
- `ALTER TABLE ... UPDATE/DELETE`（mutation）：直接重写整个 part。异步执行，什么时候完成不可预期，大表上跑一次能把集群 IO 打满。这东西在生产上基本属于「能不用就不用」
- **轻量级 delete/update**：新特性，用标记代替重写，好了很多，但仍有各种限制
- **`insert_quorum`**：只保证写入被 N 个副本确认，解决的是写入可靠性，跟主键去重没关系
- `insert_deduplication_token`：防止同一批数据被重复插入，解决的是投递幂等，跟主键语义也没关系。顺带一提，26.2 起 CK 把所有插入的去重默认打开了

需要注意的是，这几项机制各自解决的问题并不相同：ReplacingMergeTree 处理的是最终去重，`insert_quorum`处理的是副本写入确认，`insert_deduplication_token`处理的是投递幂等。它们可以组合使用，但组合的结果并不等价于一个主键约束——CK 没有提供写入即可见的唯一键语义。

Doris 这边是正面解决的。Unique Key 表从 2.1 起默认使用 Merge-on-Write（MOW）：

写入时，BE 先在 memtable 里按 key 排序缓冲这一批数据；然后对批次内的每个 key 去查各 segment 的主键索引，定位它在哪个已有 rowset 的哪一行；找到后，把旧行的 row id 在对应 rowset 的 delete bitmap 上置位；新行则写进一个全新的 rowset。

delete bitmap 是以`(rowset_id, segment_id, version)`为键的 Roaring bitmap，记录了查询时需要跳过的 row id。这样一来，查询时不需要做任何按 key 的多版本合并，读取时直接跳过被标记的行就行了。旧数据仍然留在磁盘上，等 compaction 时才真正回收。

整条写入路径如下，标红的那一步是写放大的主要来源：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/doris-03.light.svg" alt="2.2.2 数据更新与删除">
<img class="dfig-d" src="/diagrams/doris-03.dark.svg" alt="2.2.2 数据更新与删除">
</figure>

配套的能力也很完整：

- **sequence 列**（`function_column.sequence_col`）：决定同一个 key 的两次更新谁胜出。CDC 场景下事件乱序到达时，靠它保证最终留下的是较新的那条
- `__DORIS_DELETE_SIGN__`隐藏列：置 1 即可软删除，任何导入通道都能用
- **部分列更新**：只写部分列时，Doris 会自动从已有行读出缺失的列值，回写完整行

MOW 也不是毫无代价：写放大的主要来源是主键索引 lookup，delete bitmap 的计算开销随存量数据量和并发导入数线性上升。存算分离模式下 delete bitmap 计算还需要持锁，3.0 修过一类「上一个失败事务没释放锁导致后续导入全部卡死」的问题。所以 MOW 表的分区粒度要控制好，compaction 资源要留足。

这是两者面向的写入模型不同带来的结果：CK 围绕追加写优化，更新和删除是后来补充的能力；Doris 把主键语义放进了写入路径。如果业务包含高频更新、CDC 入库或需要唯一键约束，这项差异通常会直接成为选型的硬约束；如果数据以追加为主，它的权重则要低得多。

#### 2.2.3 写入性能

CK 写入调优的核心约束是：一次 INSERT 通常会产生一个 part。

part 多了查询要扫的文件就多，所以 CK 靠后台的 MergeTree 进程持续把小 part 合并成大 part。一旦插入频率超过后台合并速度，part 数量失控，就报`too many parts`。物化视图会放大这个问题，源表每秒插几次小批量，每个挂在上面的 MV 都在持续生成小 part。

官方给出的规避手段，本质都是「攒批」：

1. **客户端本地攒批**，攒够几十万行或上百 MB 再写。这是最推荐的做法
2. **`async_insert`**：客户端没法攒批时，让 CK 在服务端先缓存再写
3. **Buffer 表**：数据先进内存缓冲区，定期批量刷到目标表。好处是缓冲区里的数据也能被查到，且与 MV 目标表兼容；坏处是它在事务之外，宕机就丢数据

Doris 这边，写入是事务性的。Load Transaction 机制可以把多条导入语句作为一个原子单元，并提供两层保障：

- **label 去重**：同一个 label 在同一个 DB 内只会成功一次，重试会被判重拒绝，天然幂等
- 2PC（`two_phase_commit`）：Stream Load 先 PreCommit，由 Flink/Spark 等 sink 在 checkpoint 成功后再 Commit，失败则 Abort。与引擎的 checkpoint 对齐，这是真正的 exactly-once

这里要泼一盆冷水：Doris 并不是不需要攒批。每次 Stream Load 产生一个 rowset，rowset 就等价于 CK 的 part，高频微批同样会撞上版本数限制和 compaction 落后。

Doris 把攒批整合进 Routine Load、Flink Connector 和 Group Commit，并由事务机制保护；CK 的 Buffer 表位于事务之外，节点故障可能导致尚未刷盘的数据丢失。

纯写入吞吐需要结合批次大小和表模型实测，两者都能达到很高水平；更值得关注的是事务、幂等和失败恢复语义。

笔者开发 clickhouse_sinker 的初衷之一，就是在数据库外补齐攒批、去重、路由和失败重试。这些能力在 CK 生态里经常由写入组件承担，也意味着实际评估 CK 时，不能只计算数据库本身的运维成本。

因此，单看追加写吞吐，两者各有优势；如果把事务、幂等和 exactly-once 语义纳入比较，Doris 更完整。

#### 2.2.4 压缩比

CK 压缩比高，这是公认的，但很多人说不清为什么高。

根本原因在 2.1.1 已经埋了伏笔：CK 的数据在磁盘上是按主键排序存放的。排序意味着相邻行的相似度极高，同一列的相邻值往往连续或重复，这给压缩算法创造了最理想的输入。Doris 虽然也是列存，但数据在 tablet 内部并没有全局排序，压缩效果自然打折。

除此之外，CK 还提供了列级 codec：`Delta`、`DoubleDelta`、`Gorilla`、`T64`、`LowCardinality`……可以按列的数据特征逐列定制。时序场景下时间戳列用`DoubleDelta`、浮点指标用`Gorilla`，压缩比能再上一个台阶。这套东西 Doris 没有对等物。

接下来要专门拆一个流传很广的结论。

网上有一种说法：「CK 开 ZSTD 会触发 too many parts，所以生产上只能用 LZ4。」这个说法源自浩瀚深度那个 13PB 的迁移案例，他们为降低存储成本尝试 ZSTD，结果频繁出现`too many parts`和入库积压，最后退回 LZ4；迁到 Doris 后用 ZSTD 跑得很稳，存储消耗比 CK 的 LZ4 还低 6%。这个数据被大量引用，甚至被读成「Doris 压缩比比 CK 高」。

这个结论站不住，至少有三处问题：

第一，它是跨压缩算法的对比，Doris(ZSTD) vs CK(LZ4)，不是同一算法的横向比较。同样开 ZSTD，CK 的压缩比不会输。

第二，这是单一迁移案例，且发布在迁移方的官方渠道，属于典型的一面之词。

第三，也是最关键的——`too many parts`的根因是 merge 跟不上写入速率，不是压缩算法。ZSTD 比 LZ4 慢是事实，但它只是压垮骆驼的最后一根稻草。真正该调的是 merge 线程池大小、`max_bytes_to_merge_at_max_space_in_pool`这类参数，而不是换压缩算法。笔者自己的生产环境长期使用 ZSTD，运行稳定，从未因此出现过入库积压。

所以压缩比这一项 CK 确实领先，只是领先幅度被网上的文章夸大了。而「CK 开高压缩比容易撞写入瓶颈」这个痛点是真实存在的，只不过它是个调优问题，不是架构缺陷。

#### 2.2.5 分级存储

分级存储方面，两者的功能看起来相近，真正的差异在于对象存储被放在了哪一层抽象中。

**ClickHouse：把对象存储当成一块磁盘**

CK 的做法是在`storage_configuration`里把 S3/HDFS 注册成一个 disk，多个 disk 组成 volume，volume 组成 storage policy，然后表绑定 policy，用 TTL 规则控制数据什么时候从热卷挪到冷卷。

```sql
TTL event_time + INTERVAL 30 DAY TO VOLUME 's3'
```

这个设计的优势是 TTL 可以指定业务字段。上面这条规则的语义清清楚楚：事件时间过了 30 天就下沉。数据什么时候变冷，由业务语义决定，这非常贴合真实需求。CK 的 TTL 表达力在 3.4 节还会展开讲，那是它的强项。

但代价是强绑定。既然对象存储是「一块磁盘」，那么磁盘不可达就等同于本地盘坏了，S3/HDFS 挂掉时，CK 服务可能直接起不来。故障等级从「部分历史数据查不到」直接升级成「整个服务不可用」。这个爆炸半径，在生产上是很吓人的。

**Doris：把对象存储当成一种资源**

Doris 的抽象是三级的：`RESOURCE` → `STORAGE POLICY` → `TABLE`。冷存储是一种资源，不是一块磁盘。

这个差别看起来只是命名，实际影响很大：资源不可用时，只影响存储在这个资源上的那部分数据查不到，Doris 服务本身不受影响，照常跑。故障影响级别和 CK 完全不在一个层面上。

但 Doris 这边也有两个坑：

1. 表一旦绑定了 resource 就不能更换。这是个硬约束，前期规划错了后期改不了
2. 冷却判定依据是`visableVersion`的时间，而不是业务字段。也就是说，Doris 看的是「这批数据什么时候写进来的」，而不是「这条数据的业务时间是什么」。对于有数据回补、乱序到达的场景，这个语义是不准的，你回补一批三个月前的历史数据，它会被当成新数据留在热存储里

这个抽象层次的差别，落到故障时的表现上最为直观：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/doris-04.light.svg" alt="2.2.5 分级存储">
<img class="dfig-d" src="/diagrams/doris-04.dark.svg" alt="2.2.5 分级存储">
</figure>

两边的代价落在不同位置：CK 的冷却语义更贴合业务，但把外部存储的可用性绑进了服务可用性；Doris 的故障隔离更好，但冷却判定依据不带业务含义。这两类代价都有缓解手段——Doris 侧可以按业务时间分区、让写入时间与业务时间对齐，CK 侧则需要把对象存储的可用性纳入自身的 SLA 评估。哪一类更难以承受，取决于你的数据回补频率和对服务可用性的要求。

#### 2.2.6 半结构化数据支持

先澄清一个流传很广的过时认知：「ClickHouse 不擅长 JSON」这句话，指向的是一个已经不存在的旧实现。在 2026 年重复这个批评，属于信息过时。

CK 的 JSON 类型在 25.3 正式 GA（旧的`Object('json')`在 25.11 被彻底移除）。当前的实现是从头重写的纯列式方案：JSON 的每个路径存成独立的子列，保留原生类型，支持主键索引，查询时只读取你实际用到的路径。此外 CK 还有一个独立的`Variant`类型——注意它和 Doris 的 VARIANT 不是一回事，CK 的 Variant 必须显式声明能容纳哪些子类型，且不能包含 JSON 类型，存 JSON 应该用 JSON 类型。

Doris 的 VARIANT 在 2.1 引入。写入时在 memtable 里对相同的 JSON 键做类型推导与合并，生成一棵前缀树，记录每个 JSON field 的类型和 column 信息，然后把同一列的所有类型合并成最小公共类型，编码成 Doris 存储格式写进 segment。存储上是动态子列 + 稀疏列，配合路径索引，设计目标是撑住万列级别的子列。

VARIANT 有一个实践上的坑要注意：字段类型不一致时会退化成 JSONB。当某个路径下的值类型无法做兼容转换时，Doris 会把它统一转成 JSONB 类型，而 JSONB 列的性能相比 int、text 这类原生列有明显退化。所以业务上要尽量保证字段类型的一致性。

性能上，两边正面 PK 过一次，结果很有意思。JSONBench（十亿条 JSON 记录）的默认配置下，排名是 ClickHouse 第一、第二，Doris 第三。但 Doris 官方随后发文，通过 Schema 结构化 + 生成列 + 缓存配置 + 并行度调参，把查询总耗时降低了 74%，反超原榜首的 CK 约 39%。

关键手段是生成列（generated columns）：JSONBench 的查询用的是固定提取路径，也就是说这批半结构化数据的 schema 其实是固定的。那就可以用生成列把高频字段提取成真正的列，同时享受半结构化的灵活性和结构化的性能。

这里必须提醒立场问题：JSONBench 本身由 ClickHouse 维护，而调优反超的对比由 Doris 官方发布，两边都有立场，像是对着试题针对性的开卷考试，两组数字都要打折看。真要选型，还是拿自己的数据集实测。

两者对半结构化数据采用了不同路线。CK 的 JSON 是开箱即用的列式动态类型，默认配置下性能较好；Doris 的 VARIANT 采用动态列、稀疏列与显式结构化相结合的方式，在 schema 频繁变化和超宽表场景下更有针对性。厂商测试结论并不足以判定绝对优劣，仍应使用业务数据验证。

### 2.3 资源管理

#### 2.3.1 负载隔离

多租户共享集群时，最怕的就是一个查询把整个集群拖垮。两家给出的方案，思路差别不小。

**Doris：Workload Group，基于 CGroup 做 OS 级隔离**

Doris 把用户执行的 Query 与 Workload Group 关联，限制单个 Query 在单个 BE 节点上能用的 CPU 和内存百分比。资源空闲时，多个 Group 可以共享空闲资源、自动突破限制。

CPU 限制分软限和硬限：软限资源利用率更高，空闲时能灵活借用；硬限侧重性能稳定性，确保各 Group 之间不会因负载变化互相干扰。实测数据：设置`cpu_hard_limit=50%`，在 16 核机器上并发 1/2/4 执行同一查询，CPU 利用率始终稳定在 800%左右，就是刚好一半。

两个限制要注意：

1. 软限和硬限不能同时使用，一个集群某一时刻只能是软限或者硬限
2. 从 2.1 起默认基于 CGroup v1 做 CPU 限制，暂不支持 CGroup v2，BE 所在节点必须装好 CGroup v1 环境。不配 cgroup 的话，除 CPU 限制外的其他功能仍可用

容器场景下还有一层坑：Workload Group 的 CPU 用量是在容器可用资源的基础上再切分的。宿主机 64 核、容器分 8 核、硬限配 50%，实际只有 4 核。而且需要特权模式启动容器才能读写宿主机的 CGroup 文件。

**ClickHouse：Workload Scheduling，层级化的调度树**

CK 近几个版本持续补充资源调度能力：23.9 加入 IO 调度，24.11 支持用 SQL 管理 workload，25.4 又引入 CPU slot 调度。

用法是先定义 CPU 资源，之后`max_concurrent_threads`才生效：

```sql
CREATE RESOURCE cpu (MASTER THREAD, WORKER THREAD);

CREATE WORKLOAD all SETTINGS max_concurrent_threads_ratio_to_cores = 2;
CREATE WORKLOAD admin IN all SETTINGS max_concurrent_threads = 2, priority = -1;
CREATE WORKLOAD analytics IN production SETTINGS max_cpu_share = 0.7, weight = 3;
CREATE WORKLOAD development IN all SETTINGS max_cpu_share = 0.3;
```

这套模型的表达力比 Doris 强：workload 组成一棵层级树，`weight`做加权公平分配（软），`max_cpu_share`做份额上限（硬），两者可以在同一层并存；`priority`控制优先级，数值越小越优先抢 slot。此外还有`max_cpu_waiting_share`限制 CPU 等待时间占比，设成 0.1 就能保证长期来看 CPU wait 不超过可用执行时间的 10%。

绑定方式也很自然：查询用`workload`设置区分负载，通过 settings profile 把某个用户的所有查询固定到某个 workload。后台任务另有`merge_workload`和`mutation_workload`。可观测性上，`system.scheduler`能看到整棵调度树的活跃请求和权重分配。

**对照**

| 维度 | Doris Workload Group | ClickHouse Workload Scheduling |
| --- | --- | --- |
| CPU 隔离实现 | CGroup v1（不支持 v2） | 进程内 CPU slot 调度 |
| 硬限语义 | `cpu_hard_limit=N%`，OS 级不可突破 | `max_cpu_share`/`max_concurrent_threads` |
| 软硬限共存 | 不支持，同一时刻只能二选一 | 支持，层级树中`weight`与`max_cpu_share`并存 |
| 层级结构 | 扁平 group | 命名资源池组成的层级树 |
| 绑定方式 | user/query 关联 group | settings profile 统一标记 |
| 可观测 | workload group 系统表 | `system.scheduler` + `system.processes` |

要 OS 级不可突破的铁壁隔离（强 SLA 多租户、混部场景），Doris 的 cgroup 硬限更彻底；要弹性优先级、加权公平、IO 和 CPU 统一调度，CK 25.x 的层级模型表达力更强。顺带把另一条过时论调也作废掉：从 25.4 之后，「CK 没有资源隔离」这个说法就不成立了。

#### 2.3.2 熔断与限流

隔离解决的是「分蛋糕」，熔断解决的是「有人要把整个蛋糕端走」。

CK 的手段非常细，而且这是它少数几个明确领先的运维项：

- **单查询级**：`max_memory_usage`、`max_execution_time`、`max_rows_to_read`、`max_bytes_to_read`、`max_result_rows`，超限直接抛异常
- **用户级**：`max_memory_usage_for_user`，限制某个用户所有查询的内存总和
- **Quota**：按小时/天/周/月配额，限制查询次数、错误数、执行时间、读取行数。这个粒度 Doris 没有对等物
- **运行时干预**：`system.processes`看实时查询，`KILL QUERY`精准干掉

Doris 这边有 Workload Policy（4.1 增强）、query timeout、以及内存超限自动 kill。策略是声明式的，配置心智更简单，但可控的维度确实不如 CK 细。

CK 的 quota 和 settings profile 提供了更细的限制维度；Doris 的策略配置更偏声明式，理解成本较低，但控制粒度相对有限。

### 2.4 AI 与向量能力

AI 相关能力可以拆成三条彼此独立的路线：向量索引、SQL 中的 AI 函数，以及面向 Agent 的 MCP 生态。

**向量检索：索引粒度与构建方式的差异**

Doris 从 4.0 开始支持基于 HNSW 的 ANN 索引，4.1 又加了 IVF 和 IVF_ON_DISK，把向量检索扩展到十亿乃至万亿规模，并新增 Ann Index Only Scan 优化，向量检索可以跳过原始列的 IO，查询性能相比 4.0 最高提升 4 倍。

```sql
INDEX idx_vec (embedding) USING ANN PROPERTIES (
  "index_type" = "hnsw",
  "metric_type" = "l2_distance",
  "dim" = "768",
  "quantizer" = "flat"
)
```

CK 这边是`vector_similarity`索引：

```sql
ALTER TABLE t ADD INDEX vec_idx vector
  TYPE vector_similarity('hnsw', 'cosineDistance', 384, 'bf16', 64, 512);
```

两边都提供了 ANN 索引，但索引粒度和构建方式存在两项重要差异：

**第一，索引粒度**。Doris 在 Segment 粒度上构建和使用 ANN 索引，这把「全表数据量」与「索引超参数」彻底解耦了——用户只需要根据单批次导入的规模设参数，数据总量涨到多少都不用重建索引。CK 则是 part + GRANULARITY（向量索引的默认粒度是 1 亿，与普通跳数索引的 1 完全不同），而且两个 part 合并时，会为合并后的 part 重新构建索引。这意味着写入越频繁，索引重建的开销越大，HNSW 索引会明显拖慢 INSERT 和 OPTIMIZE。

**第二，构建方式**。Doris 是异步后台构建，数据导入后立即可查，索引在后台慢慢建，不阻塞导入。CK 需要`MATERIALIZE INDEX`，对一个两三千万行的数据集，构建索引可能要几分钟到几小时。

内存开销两边都是硬约束。CK 给了明确的估算公式：向量内存 = 向量数 × 维度 × 量化字节数，图内存 = 向量数 × `hnsw_max_connections_per_layer` × 4 × 2。100 万条 1536 维 bf16 向量大约需要 3.5GB。Doris 官方也承认，常用参数下 HNSW 索引内存约为原始数据的 2 倍，扩展到 10 亿向量时接近 1TB，大多数团队接受不了。所以到了十亿级，两家都得靠量化，CK 有二值量化配合过采样和 rescoring，Doris 有 sq8/sq4，以及 4.1 新增的 IVF_ON_DISK。

CK 社区自己也在 RFC #104122 里承认了这些问题：HNSW 需要为向量和图占内存，增量更新需要完整重建，单 VM 上的单一向量索引无法服务十亿级搜索。

**AI 函数：Doris 独有**

Doris 4.0 引入了 AI 函数，分析师可以直接在 SQL 里调用大模型完成信息抽取、情感分析、文本摘要。这个能力 CK 目前没有对等物。

**MCP 生态：CK 更成熟**

在 Agent 生态方面，CK 的积累更深：

- 官方 MCP Server（PyPI 安装，可自托管），下载量已超 22 万次
- ClickHouse Cloud 的远程 MCP Server + Ask AI agent
- ClickStack MCP Server：把可观测性调查能力开放给外部 agent，可以直接把 Claude、Cursor、Codex 连到可观测数据上，通过一组专为日志/指标/追踪设计的调查原语操作
- ClickHouse Agent Skills 仓库：给 AI 编码 agent 打包的领域知识，涵盖 schema 设计、查询优化、数据摄入模式

Doris MCP Server 在功能覆盖上也不弱（查询、元数据、高级分析、治理，用 ADBC/Arrow 和连接池，支持 Catalog 联邦），但整体生态成熟度和被主流 AI 工具集成的程度，跟 CK 还有差距。

因此不能把三条能力合并成一个输赢结论。向量检索方面，Doris 的索引粒度和后台构建机制更适合持续写入的大规模数据；SQL 内调用模型是 Doris 的差异化能力；CK 则在 Agent 和 MCP 生态上更成熟。RAG、混合检索和 AI 可观测更看重前两项，让 Agent 直接访问分析数据则更看重后一项。

## 3. 运维与扩展

### 3.1 集群运维

CK 的运维痛点，摊开讲有这么几条：

**加节点要改配置文件**。CK 的集群拓扑写在`config.xml`/`metrika.xml`里，加一个节点意味着要修改配置并分发到集群里每一台机器。而 Doris 只需要一条 SQL：

```sql
ALTER SYSTEM ADD BACKEND "host:port";
```

**不感知拓扑变化**。这是更根本的问题，下一节专门讲。

**元数据管理**。CK 没有集中的元数据管理，每个节点各管各的，高可用一般要靠业务方自己实现。Doris 的 FE 内建了元数据管理（基于 BDB JE 做副本复制），不依赖任何外部组件。

不过关于 CK 依赖 ZooKeeper 这一点，得说句公道话。早年 CK 把分布式 DDL、表和 part 信息全存在 ZK 里，由于是细粒度文件信息，ZK 经常成为性能瓶颈，这个批评在当时完全成立。但 CK 自 21.x 起就在推自研的 ClickHouse Keeper（用 C++重写的 ZK 兼容实现，用 Raft 做共识），到 24.x 之后基本已经取代了 ZooKeeper，内存占用和性能都好得多，而且可以内嵌到 clickhouse-server 进程里跑，不需要单独维护一套 Java 服务。所以「CK 依赖 ZooKeeper」也是一条正在过时的批评。

即便如此，CK 的运维复杂度仍然高于 Doris。这也正是 ckman、ByteHouse 以及各家云厂商魔改版存在的理由，把 CK 缺失的那层运维能力补上。ckman 做的事情就是这个：可视化部署、滚动升级、节点增删、表与数据治理、备份恢复、监控告警，把原本需要手工改配置、逐台分发的操作变成 Web 上的几次点击。

集群运维方面 Doris 的内建能力更完整。CK 通常需要额外的管理层来弥补拓扑管理和自动化运维能力，这一层目前主要由社区工具和云厂商提供。

### 3.2 数据均衡

**数据自动均衡是 CK 开源版最突出的运维短板之一。**

Doris 这边：集群扩缩容时自动完成 tablet 的重新分布；服务器宕机或坏盘时，自动完成副本切换与写入重定向，自动屏蔽故障节点的查询与写入请求，并在其他可用节点上重建副本。菜鸟网络的生产环境里，Doris 集群频繁扩缩容应对电商大促，无需人工干预，服务不中断。

CK 开源版不能根据拓扑变化自动完成跨 shard 的数据再均衡。新增节点后，存量数据不会自动迁移；发生磁盘或节点故障时，也通常需要结合副本状态和业务布局进行人工处理。

为什么会这样？根因在于 CK 少了一层抽象。

对比两边的数据层级：

- CK：`SHARD → PARTITION → PART → GRANULARITY → ROWS`
- Doris：`PARTITION → BUCKET → TABLET → ROWSET → ROWS`

Doris 的 TABLET 是一个可以整体迁移的最小单元，它属于哪个 BE 只是一个可变的映射关系，改一下映射、把文件拷过去就完成了迁移。而 CK 的最小单元是 part，part 归属哪个 shard 是由 sharding key 硬绑定的，你想把一个 part 挪到另一个节点，那这个节点上就出现了本不该属于它的数据，路由就错了。没有 bucket 这一中间层，数据就没法在节点间自由流动。

所以 CK 的扩容，实际做法全是绕路：

1. **权重倾斜 + TTL 自然消解**：改`metrika.xml`里各 shard 的权重，让新数据大部分写到新节点，随着老数据按 TTL 自然过期，数据逐渐趋于均衡，然后再把权重调回来。这是数据量大时最现实的方案，但周期以月计
2. **建新表重导**：数据量不大时，新建表把数据导过去再换名。表一多就没法用了
3. **备份恢复 + 原地重分片**：Contentsquare 这样的企业用户也是这么干的，过程复杂且容易出错
4. `clickhouse-copier`：已废弃

云厂商的定性也很直白。腾讯云直接把这个称为「ClickHouse 使用和运维上的一大痛点」，它提供的 Resharding 模式会把数据重新插入，过程中的临时数据需要额外存储空间，要求剩余容量超过整表大小，而且一个集群同时只支持一个任务执行。字节的 ByteHouse 也把「MPP 架构导致扩容成本高」列为 CK 运维的核心痛点，指出不管哪种方式都需要用户手动复制元数据、校验数据、拼装流程。

**ckman 是怎么做的**

既然 CK 自己不做，这件事就只能由外部工具补。ckman 把数据均衡实现成了一个可编排的任务，提供两种策略，按表选择。

**策略一：按分区搬移（ByPartition）**

这是默认策略，思路是把整个分区作为搬移单元，不动数据内容。

规划阶段用贪心：每一轮挑出当前占用最大的 host 和最小的 host，尝试把大 host 上的某个分区搬到小 host 上。这里有个关键约束——只有满足`max >= min + 2 * size`才执行，也就是说搬完之后不能反过来让原本最小的变成最大的，否则就是在原地打转。循环直到没有有效的搬移为止。另外，**每个 host 最新的那个分区会被跳过**，因为它还在接收写入，搬它必然出问题。同一轮规划里，一个 host 不会既搬出又搬入。

执行阶段分两条路：

- **复制表集群**：纯元数据操作。目标端通过 ZooKeeper 发起`FETCH PARTITION`把数据拉过来，`ATTACH`挂上，源端再`DROP`。全程不需要操作系统层面的文件拷贝，也不需要主机之间打通 SSH
- **非复制表集群**：源端`DETACH`分区，用 rsync 把 part 文件传到目标端，目标端再`ATTACH`。这条路要求主机之间免密 SSH、并且能 sudo 读数据目录。ckman 会先做一次连通性探测，探测失败就跳过这张表，而不是让整个任务失败

**策略二：按分片键重分布（ByShardingKey）**

按分区搬移有个前提：数据在分区之间的分布本身要相对均匀。如果原本的分片就是斜的（比如当初 sharding key 选得不好），搬分区只是把不均衡换个地方放。这时候需要按行重新计算归属。

流程是这样的：每个 shard 上先建一张临时表（用`engine_full`镜像原表结构，Replicated 引擎的 ZooKeeper 路径会被替换掉以免和真表冲突），把原表数据搬进临时表并校验行数；然后从`cluster()`函数读临时表，用`hash(key) % N = idx`过滤，让每个 host 只 INSERT 属于自己的那部分行回原表；再校验一次行数，最后清理临时表。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/doris-05.light.svg" alt="3.2 数据均衡">
<img class="dfig-d" src="/diagrams/doris-05.dark.svg" alt="3.2 数据均衡">
</figure>

几处工程细节值得一提：

- 行数校验用的是`>=`而不是`==`。均衡期间业务仍在写入，行数只会变多，卡死`==`会误报失败
- 校验失败后会等 5 秒重试一次。`cluster()`是分布式查询，可见性有轻微延迟，一次性的最终一致重试能覆盖掉这种误判，同时不至于陷入无限重试
- 整个过程支持配置一个可接受的丢失率（`AllowLossRate`）作为兜底阈值
- 两种策略都实现了`Plan`接口，可以只算不做，先预览这一次均衡会搬哪些分区、涉及多少行和多少字节，确认之后再执行
- 上下文取消检查放在每次分区搬移、每个插入批次的边界上，所以中途点「停止」是真能停下来的，不用等整张表跑完

需要坦白的是，这些都属于外部工具在数据库之外做的补偿。它没法像 Doris 那样在节点宕机时自动触发副本重建，也不可能做到无感知；它解决的是「扩容之后怎么把存量数据挪过去」这个具体问题，而不是把 CK 变成一个自动均衡的系统。ByShardingKey 策略还需要额外的临时表空间，这一点和腾讯云的 Resharding 模式面临的是同一个约束。

需要补充一点公允：Doris 的自动均衡也不是零成本。坏盘或宕机后的数据均衡过程会消耗大量集群资源，引发短时间的负载过高。生产上仍然需要关注均衡限流参数，尽量安排在业务低峰期。

### 3.3 备份恢复

在备份恢复方面，CK 的原生功能覆盖较完整。

**Doris**的`BACKUP`/`RESTORE`：对指定表或分区的数据文件做快照（本质是硬链接，耗时很少），然后由各个 BE 并发上传到远端仓库。需要提前部署对应远端存储的 broker。作业分阶段执行——备份是 SNAPSHOTTING → UPLOADING，恢复是 SNAPSHOTTING → DOWNLOADING → COMMIT，每个阶段的子任务和错误都可以通过`UnfinishedTasks`/`TaskErrMsg`/`Status`观察。快照完成之后对表的修改和导入不再影响备份结果，语义很清晰。

**ClickHouse**这边其实有三条路：

1. 原生`BACKUP`/`RESTORE`语句。覆盖面比 Doris 还全：支持 TABLE、DICTIONARY、DATABASE、TEMPORARY TABLE、VIEW、ALL 等对象，可带`PARTITION`子句和`ON CLUSTER`，目标可以是`File(...)`、`Disk(...)`或`S3(...)`，并通过`SETTINGS base_backup=...`实现增量备份。支持 ASYNC 执行并用返回的 id 查进度，支持`compression_method`/`compression_level`，还能用`backup_threads`/`restore_threads`限制资源消耗。系统表方面，以`_log`结尾的历史表（query_log、part_log）可以像普通表一样备份，也可以排除掉省空间
2. `FREEZE PARTITION`：硬链接快照，几乎不额外占磁盘，无需停服。但它只备数据不备元数据，建表 SQL 得自己从 metadata 目录里拷出来。这是个很容易踩的坑
3. clickhouse-backup：第三方工具，支持本地和 S3 等多种存储，part 级增量（对比两次全量备份的 part 文件），有`backups_to_keep_local`/`backups_to_keep_remote`保留策略，还能起 server 模式对外提供 API，适合容器化环境

**对照**

| 维度 | Doris | ClickHouse |
| --- | --- | --- |
| 快照原理 | 硬链快照 + BE 并发上传 | FREEZE 硬链 / BACKUP 直写 Disk、S3 |
| 增量 | CCR 的全量+binlog 回放 | `base_backup`增量、clickhouse-backup 的 part 级增量 |
| 对象覆盖 | 表、分区 | 表、字典、库、视图、ALL，可带 PARTITION |
| 落地存储 | 需部署 broker | File/Disk/S3 直连，无需额外组件 |
| 跨集群持续同步 | CCR 原生支持 | 无 |

单论周期性冷备与恢复，两边功能对等，CK 的原生语法覆盖面反而更全，还不需要部署 broker。Doris 的优势在 CCR 带来的持续同步，但那个实用性得打折（见 2.1.5）。

无论使用哪一款数据库，备份任务成功都不等于数据可以恢复。生产方案必须包含定期恢复演练，并记录恢复时间、对象完整性和业务校验结果；这通常比备份命令本身更重要。

### 3.4 生命周期管理

生命周期管理是 CK 优势较为明确的一项能力。

CK 的 TTL 是一等公民，写在建表 DDL 里，表达力相当强：

```sql
-- 行级TTL：整行过期删除
TTL event_time + INTERVAL 90 DAY

-- 列级TTL：单独某几列先过期，其他列保留
TTL event_time + INTERVAL 7 DAY TO detail_json

-- 分级存储：到期挪到冷卷
TTL event_time + INTERVAL 30 DAY TO VOLUME 's3'

-- 聚合降采样
TTL event_time + INTERVAL 30 DAY GROUP BY dim1, dim2
    SET metric = sum(metric), cnt = sum(cnt)
```

前三种 Doris 或多或少有对应物，但后面两种没有：

- **列 TTL**：可以让明细字段（比如原始日志正文、大 JSON）先过期释放空间，而时间、维度、指标这些小字段继续存很久。可观测场景下这个能力相当实用，90 天的指标只要几个字段，7 天的原始日志才需要全文
- `TTL ... GROUP BY`降采样：数据过了 30 天自动聚合成粗粒度，明细扔掉只留汇总。这在时序/指标场景下相当于内建了一套 rollup 机制，不需要额外的 ETL 作业

而且这几条规则可以组合写在同一张表上，形成完整的数据生命周期策略：7 天后丢明细字段 → 30 天后降采样并下沉到 S3 → 90 天后彻底删除。全部由数据库自动执行，一行调度代码都不用写。

Doris 这边主要是动态分区：按时间自动创建新分区、自动删除旧分区，配合分区级的冷热策略。心智负担确实更轻，配好`dynamic_partition`的几个参数就完事了，不需要理解 TTL 表达式的求值时机。但表达力就是不如 CK。

CK 在生命周期管理上的优势主要来自列 TTL 和`TTL GROUP BY`降采样，Doris 目前缺少直接对等的机制；Doris 动态分区的优点则是配置简单。对于可观测、时序和指标数据，CK 的 TTL 体系可以减少额外的数据治理任务。

### 3.5 用户权限管理

两边都是 RBAC，模型上大同小异，差别在细节。

**Doris**的权限系统参照 MySQL 设计。用户被识别为一个 User Identity，由 username 和 host 两部分组成，写作`username@'host'`，天然带白名单机制。支持自定义角色，角色的权限变更会实时体现在所有属于该角色的用户上。

- **行级权限（Row Policy）**：原理是给配置了策略的用户在查询时自动追加谓词。注意不能给 root 和 admin 设置
- **列级权限**：可以只授予表中特定列的权限

**ClickHouse**是一套完整的 SQL 驱动 RBAC，包含 users、roles、row policies、quotas、settings profiles 五个维度。列级权限直接通过`GRANT`指定列，行级用`CREATE ROW POLICY`。

CK 的 ROW POLICY 有两个必须知道的致命限制：

1. **只有在只读访问场景下才有意义**。如果用户能修改表，或者能在表之间复制分区，就能绕过行策略的限制。也就是说，行策略是给「只读分析师」用的，不是给「能写数据的开发」用的
2. **Distributed 表不生效**。行策略只在本地读取表数据时生效，对于把读取委托给远端服务器的 Distributed 表，必须在每一台服务器的底层本地表上分别定义策略。集群一大，这就是个运维灾难

另外 CK 默认是「没有策略就能看全部行」，要做「默认拒绝」得用 permissive/restrictive 组合（先`USING 0 TO ALL`全禁，再对特定角色放行），这个心智不太直观。

可观测性上 CK 有个优势：`system.row_policies`表能看到所有生效的行策略、条件、以及适用的用户和角色，审计时很方便。

整体上两家模型对等。CK 的 quota 和 settings profile 维度更细，`system.row_policies`便于审计；Doris 的 MySQL 心智和 host 白名单更亲民，行级权限也没有 Distributed 表那个坑。

### 3.6 数据安全管理

除了依赖漏洞扫描，安全合规还涉及数据脱敏、访问审计和长期留痕。在这些数据库层面的能力上，Doris 准备得更完整。

**动态数据脱敏**：Doris 有原生的 Data Masking，CK 没有。

Doris 可以对敏感字段配置脱敏策略，把信用卡号、身份证号的部分或全部数字替换成星号，或者把真实姓名替换成假名，查询结果返回时动态处理。原始数据不动，脱敏发生在返回路径上。（同样地，给 admin/root 设置脱敏不会生效。）

CK 这边没有内置的动态脱敏，只能自己用视图或 UDF 封装一层，然后靠权限控制不让用户直接访问底表。这个方案能 work，但维护成本高、容易出漏洞，只要有一个地方忘了套视图，敏感数据就裸奔了。

**审计日志**：Doris 有基于 FE 插件框架的审计日志插件，可以在运行时灵活安装或卸载，把 FE 端的审计日志定期导入到指定的 Doris 集群里，然后直接用 SQL 做审计分析。这个设计很讨巧，审计数据就存在数据库自己里，查起来跟查业务表一样。

CK 靠`system.query_log`，信息其实非常全（谁、什么时候、执行了什么 SQL、读了多少行、用了多少内存、耗时多久），但它是一张普通的系统表，默认 TTL 有限，要做长期审计得自己配持久化和归档。

就数据库自身提供的合规能力而言，Doris 的覆盖更完整，脱敏和审计都不需要额外封装。这与 1.4 节的情况恰好构成对照：CK 在依赖扫描环节占了实现语言的便宜，在合规功能的内建程度上则要靠外部方案补齐。等保和安全评审具体考察哪些项，各行业口径差别很大，建议按实际评审清单逐项核对，而不是直接套用结论。

### 3.7 交互体验

#### 3.7.1 查询交互

**Doris 兼容 MySQL 协议，这带来的接入成本差异常被忽略。**

所有 MySQL 客户端直接能连（Navicat、DBeaver、DataGrip、命令行的`mysql`），所有 BI 工具直接能接（Tableau、Superset、帆软、Quick BI），所有语言的 MySQL 驱动直接能用，所有 ORM 直接能跑。运维排查问题时一句`mysql -h host -P 9030 -u root`就进去了，不用装任何额外东西。

对于需要在企业内大范围推广的系统，这意味着业务方的 BI 工程师不必学习新语法，存量报表系统也不需要改造。这部分成本很难体现在跑分里，但在实际推进中往往占据不小的比重。

CK 使用自己的 SQL 方言和协议，也提供 MySQL 兼容端口（`mysql_port`），但兼容范围有限，部分语法和函数无法直接复用。DBeaver 等客户端通常需要专用驱动，一些 BI 工具也缺少原生支持。`ARRAY JOIN`、`-If`/`-Array`/`-State`组合子和`ANY INNER JOIN`等语法很有表现力，但学习和迁移成本同样需要计入选型。

CK 的补偿是`clickhouse-client`本身极其好用。实时进度条（显示已扫描行数、速度、剩余时间）、几十种输出格式（`Pretty`、`PrettyCompact`、`JSONEachRow`、`CSV`、`Vertical`……）、多行编辑、语法高亮、查询历史。用惯了之后再用`mysql`客户端会觉得回到了石器时代。

在企业内部推广时，Doris 的 MySQL 兼容性能显著降低接入成本；直接操作数据库时，CK 客户端提供的进度、格式和诊断信息更丰富。面向数百名用户的平台，「能否复用现有工具和驱动」往往比小幅性能差异更重要。

#### 3.7.2 执行计划

CK 的 EXPLAIN 家族信息量极大：

- `EXPLAIN` / `EXPLAIN AST` / `EXPLAIN SYNTAX`：语法树和改写后的 SQL
- `EXPLAIN PLAN`：逻辑计划
- `EXPLAIN PIPELINE`：物理执行管道，能看到每个算子有几路并行
- `EXPLAIN ESTIMATE`：预估会读多少 part、多少 mark、多少行
- `EXPLAIN indexes=1`：索引使用情况，主键索引裁剪掉了多少 granule，跳数索引又裁掉了多少

再配合`SET send_logs_level='trace'`，执行过程中的每一步都会打到客户端，选中了哪些 part、每个索引过滤后剩多少 mark、每个阶段耗时多少。调优时信息密度极高。

但门槛也高。要看懂`EXPLAIN PIPELINE`的输出，你得先理解 CK 的算子模型和并行执行机制；要看懂 trace 日志，你得知道 granule、mark、part 这些概念之间的关系。这不是一个新手能上手的东西。

Doris 的`EXPLAIN`和 Query Profile 更结构化，有 Web UI 展示，各阶段耗时、行数、内存一目了然，还能看到 CBO 估算的代价和实际值的偏差。看懂的门槛低得多。

CK 的信息更全，Doris 的更能看懂。这个差异其实是两家整体气质的缩影。

#### 3.7.3 系统表

**CK 把内部状态几乎全部暴露成了可查询的系统表。**

CK 几乎把所有内部状态都做成了可以用 SQL 查询的系统表：

- **查询与执行**：`query_log`（每条查询的完整记录）、`query_thread_log`、`processes`（实时运行中的查询）、`query_views_log`
- **存储**：`parts`（每个 part 的行数、大小、压缩前后字节数）、`part_log`（part 的每一次创建、合并、下载、删除）、`columns`（每列的压缩比！）
- **后台任务**：`merges`（正在进行的合并）、`mutations`（ALTER 的执行进度）、`replication_queue`、`replicated_fetches`
- **指标**：`metrics`（当前值）、`events`（累计计数）、`asynchronous_metrics`（周期采集的系统指标）
- **诊断**：`errors`（各类错误的累计次数）、`text_log`（服务端日志，可以用 SQL 查日志！）、`stack_trace`
- **配置**：`settings`、`merge_tree_settings`、`disks`、`storage_policies`、`clusters`、`macros`
- **甚至还有数据生成器**：`system.numbers`、`system.zeros`，造测试数据一句 SQL 搞定

这套东西的好处是，你不需要任何外部工具就能把 CK 自己查明白。想知道哪张表压缩比最差，查`system.columns`；想知道 merge 为什么跟不上，查`system.merges`和`system.part_log`；想知道昨天哪条 SQL 把内存打爆了，查`system.query_log`按`memory_usage`排序。ckman 的原生监控就是直接读这些系统表实现的，一行埋点都不用加。

这套自省能力也是 CK 在可观测领域被广泛采用的基础之一，4.4 节还会再提到。

Doris 这边是`information_schema` + `SHOW PROC '/...'`那一套。`information_schema`是 MySQL 标准的元数据视图，`SHOW PROC`能看集群拓扑、tablet 分布、导入作业状态。够用，但覆盖面和信息密度跟 CK 差着量级，而且`SHOW PROC`的输出是给人看的，不方便用 SQL 做二次加工。

系统表的覆盖范围和可查询性，是 CK 相当突出的优势。

## 4. 生态周边

### 4.1 ckman vs Doris Manager

两家都有集群管理工具，但出身完全不同。

**ckman**是笔者参与开发的开源项目（[housepower/ckman](https://github.com/housepower/ckman)），前端 Vue、后端 Go。能力覆盖：

- **集群全生命周期**：部署、升级（含滚动升级）、销毁、启停、节点增删，Web 和 API 双通道
- **表与数据治理**：分布式表管理、分区、TTL、物化视图、DML、数据归档、purge
- **备份恢复**：定时策略、增量去重，支持本地和 S3
- **权限**：三级 RBAC + JWT + 客户端 IP 绑定
- **高可用**：多实例部署 + Nacos 主节点选举，持久层支持 MySQL/PostgreSQL/达梦/SQLite
- **监控**：原生直读 CK 系统表，开箱即用；Prometheus/Grafana 可选接入
- **逻辑集群**：把多个物理集群抽象成统一视图（见 2.1.5）

**Doris Manager**（现在叫 Cluster Manager for Apache Doris / SelectDB Manager）由 SelectDB 出品，能力也很全面：部署和接管集群、实时查看运行状态、扩缩容、升级重启、监控告警、参数配置、日志查看、任务审计、集群巡检。24.0 版本改成了 server-agent 架构（此前 23.x 依赖 SSH 互信，对于不允许在内网使用 SSH 互信的高安全客户不适用），agent 装在每个节点上，采集主机和进程指标主动上报，Server 和 Agent 之间用 HTTP + SSL 通信。

但它是闭源的商业产品。SelectDB 曾宣布 Doris Manager「免费开放」以回馈社区，下载入口在企业版下载页面——但免费不等于开源，源码至今未公开。

这里有个值得玩味的对照，恰好呼应 1.1 节讲的那个「戏剧性」：

> CK 的管理工具是社区补的，Doris 的管理工具是厂商卖的。

Doris 的开源协议更开放、核心特性（存算分离、倒排索引、实时更新）也确实都在开源版里，这一点 2.1.8 已经说过 CK 不如它。但到了运维工具这一层，情况反了过来，你想要一个趁手的 Doris 集群管理工具，要么用 SelectDB 给的闭源二进制，要么自己写；而 CK 这边，社区已经给了好几个能用的开源方案。

这一层没有绝对的赢家，但开源与闭源的边界，两家的划法完全不同。选型时值得先问自己一句：你在意的到底是内核开源，还是整套方案开源。

### 4.2 SDK 与驱动

**Doris 在这一层直接复用了 MySQL 驱动。**

任何语言、任何框架，只要能连 MySQL 就能连 Doris。Java 用`mysql-connector-java`、Go 用`go-sql-driver/mysql`、Python 用`PyMySQL`、Node 用`mysql2`……不需要任何 Doris 专属的 SDK。ORM 也是直接可用。这是复用 MySQL 生态带来的直接收益，接入成本几乎为零，语言和框架覆盖面也远超任何单独维护的驱动体系。

除此之外 Doris 还提供了 Flink Connector、Spark Connector、以及 Arrow Flight SQL 高速读取接口（大批量拉数据时比 MySQL 协议快很多）。

CK 这边全是自己造的轮子：`clickhouse-go`、`clickhouse-jdbc`、`clickhouse-connect`（Python）、`clickhouse-cpp`、`clickhouse-rs`，官方维护，质量都不错。走 Native 协议的性能明显优于 HTTP，批量写入的吞吐很能打（笔者的 clickhouse_sinker 就是基于 clickhouse-go 实现的）。

差别在于深度和广度的取舍：CK 的驱动能力更深，支持 Native 协议、支持列式批量写入、支持异步插入、能拿到查询进度回调；但覆盖的语言和框架有限，冷门语言基本没有官方支持。

Doris 赢在广度，靠的是 MySQL 生态；CK 赢在深度，靠的是自己造的轮子。

### 4.3 基于开源版本的二开

这是 1.1 节埋下的那个「戏剧性」的展开：基于 CK 魔改的二开版本数不胜数，而 Doris 几乎没有。

CK 的二开名单可以列很长：字节的 ByteHouse、阿里云/腾讯云/华为云各自的托管版、Altinity 的企业版、嵌入式的 chdb、以及数不清的没有对外发布的企业内部版本。

为什么 CK 这么容易被二开？

1. **单体 C++架构，无外部依赖**。一个二进制跑起来就是完整的数据库，改哪里、编哪里都很直接
2. **代码模块化程度高**。表引擎、函数、聚合函数、格式、磁盘都是插件化注册的，加一个自己的实现不需要动核心
3. Apache 2.0 + 弱社区治理约束。想改就改，想发就发，不需要跟任何人商量

而 Doris 的 FE(Java) + BE(C++)双语言架构，改起来成本高得多，一个功能往往要同时动 Java 和 C++两侧，还要处理两者之间的 Thrift 接口。加上 ASF 的治理框架下，社区更倾向于把改动贡献回主干而不是自己拉分支。唯一分出去的 StarRocks，那是分裂而不是二开，而且分完之后两家闹得水火不容。

这件事该怎么评价？

被大量二次开发这件事，至少说明代码结构清晰到别人改得动。但对使用方来说它是双面的：版本碎片化意味着 A 云上的 CK 和 B 云上的 CK 行为可能并不一致，社区经验和文档未必适用于手上的魔改版，出了问题上游也难以介入。

二次开发能力很难简单判定优劣。但对需要私有化交付和深度定制的厂商而言，CK 的模块化结构和可改造性确实有价值。

### 4.4 可观测生态

两者在可观测领域的差距，不只体现在功能，也体现在生态位置。

Doris 在可观测这块的能力是「支持被监控」：FE 和 BE 各自暴露 Prometheus endpoint，官方提供 Grafana Dashboard 模板，配好就能看到集群的各项指标。这是每个成熟数据库都该有的东西，Doris 做得中规中矩。

CK 当然也有这些：`system.metrics`/`events`/`asynchronous_metrics`三张表覆盖了所有内部指标，内置 Prometheus endpoint，还有 clickhouse_exporter 和官方维护的 Grafana 数据源插件。

**但 CK 更重要的身份是——它本身就是可观测生态的后端存储。**

看看有多少可观测产品把 CK 选作存储引擎：

- **ClickStack**：CK 官方的可观测栈（26.2 起内置 UI）
- **SigNoz**：开源 APM，全套 log/metric/trace 存在 CK 里
- **Uptrace**：同上
- **Grafana**：官方 CK 数据源插件，很多团队直接拿 CK 当日志后端
- **HyperDX**（已被 CK 收购）、Highlight.io、Coroot……

这个名单还在变长。CK 不是「支持监控」，它是被整个可观测行业选中的存储底座。而支撑这个地位的，正是 3.7.3 讲的那套系统表、2.2.4 的压缩比、2.1.1 的聚合性能，以及 3.4 的 TTL 降采样能力，每一样都是可观测场景的刚需。

这也解释了本文结尾提到的那个现象：人们聊可观测时，拿来跟 CK 对比的是 VictoriaMetrics 而不是 Doris。两者在这个赛道上所处的位置不同：CK 已经是多个可观测产品的既有存储层，Doris 则是近几年才开始发力。Doris 在日志检索方向进展不错（倒排索引加 VARIANT），metric 和 trace 的生态积累还在早期。

就当前生态规模而言，CK 在可观测后端领域领先较多。

### 4.5 云原生生态

K8s 部署这块，两边都有 operator，但成熟度有差距。

**CK**：Altinity 的[clickhouse-operator](https://github.com/Altinity/clickhouse-operator)是事实标准，用了很多年，功能完备（集群定义、配置管理、滚动升级、PVC 管理、ZK/Keeper 集成），社区活跃。官方也提供 Helm chart。ClickHouse Cloud 本身就是云原生架构，很多经验会反哺开源侧。

**Doris**：社区的 doris-operator，起步晚一些，但基本能力都有。

不过有意思的是长期趋势可能是反的。

CK 开源版是存算一体架构，BE 是有状态的，上了 K8s 之后，Pod 的弹性伸缩受限于 PVC 和数据分布，扩容依然要面对 3.2 讲的数据均衡难题。K8s 带来的弹性优势，在 CK 这里发挥不出来多少，更多只是解决了「部署编排」的问题。

而 Doris 3.0 的存算分离架构下，BE 是无状态的。数据在共享存储上，计算节点可以随起随停，配合 Compute Group 做隔离，这才是 K8s 真正擅长的场景，想扩就扩、想缩就缩、按需付费。

就当前成熟度而言 CK 的 operator 更完善；就架构与 K8s 弹性模型的契合度而言，Doris 3.0 的无状态 BE 更对路。这两点分别对应短期可用性和长期演进空间，权重取决于你是现在就要上 K8s，还是在规划未来几年的部署形态。

### 4.6 商业化公司技术支持

商业支持不属于内核能力，却经常在国内 ToB 项目中占据很高权重。

**ClickHouse Inc.**（总部西雅图）的势头很猛：

- 2025 年 5 月 C 轮融资 3.5 亿美元，估值 63.5 亿
- 2026 年 1 月 D 轮融资 4 亿美元，Dragoneer 领投，估值 150 亿美元，不到一年翻了一倍多
- 累计融资超过 10 亿美元
- ClickHouse Cloud 客户超过 3000 家，ARR 同比增长 250%+
- 同期收购了 Langfuse（开源 LLM 可观测平台）

资本市场用真金白银投了票。不过也有冷静的声音：CB Insights 记录 CK 在 2025 年的营收是 8800 万美元，对应 150 亿估值，这个倍数显然是被 AI 叙事推上去的。

**SelectDB/VeloDB**这边未见公开的新一轮融资进展，估值也未披露。

不过对国内用户来说，融资和估值并不能直接转化为本地支持体验：

- CK 官方对国内客户的支持非常薄弱。中文文档滞后于英文版，社区提 issue 的响应速度看运气，商务上主推 Cloud——而 Cloud 在国内又基本不可用。真出了问题，你能依靠的是社区、云厂商，或者自己
- SelectDB 是国内公司，中文支持、驻场、定制开发、7×24 响应等交付方式在国内项目中更容易落地

因此需要分别看行业投入和国内落地能力：

- **从行业地位和长期投入看**：CK 的融资规模、客户数量和迭代节奏都处于领先，资本市场给出的认可度更高
- **从落地支持看**：国内项目里 Doris 的本土化优势明显，这一点在政企、金融等需要强技术支持的行业尤其重要

这里也有一个属于推测范畴的风险项：150 亿美元的估值对应的是投资人对 Cloud 收入曲线的预期，而不是开源社区的活跃度。SharedMergeTree 未进入开源版（见 2.1.8）是已经发生的事实，未来还会有哪些能力被划入 Cloud 则无从预判。如果你的方案强依赖开源版长期演进，这一点值得纳入风险评估。

### 4.7 其他开源组件

两边周边生态的生长方式很不一样。

**CK 侧**（大量社区自发项目）：

- clickhouse_sinker：Kafka → CK 的高性能写入组件（笔者作品），负责攒批、去重、路由、失败重试
- **ckman**：集群管理（笔者作品，见 4.1）
- **chdb**：嵌入式 CK，像用 SQLite 一样在进程内跑 CK
- **clickhouse-local**：官方的单文件查询工具，可以直接查 CSV/Parquet/JSON
- clickhouse-backup：备份恢复（见 3.3）
- **Altinity 全家桶**：operator、backup、各类运维工具

**Doris 侧**（官方规划为主）：

- Flink Connector / Spark Connector
- DataX、SeaTunnel 插件
- ccr-syncer（见 2.1.5）
- doris-streamloader

CK 的周边是社区自发生长出来的，杂乱但覆盖长尾，你遇到的奇怪需求很可能已经有人写过工具；Doris 的周边是官方统一规划的，整齐规范但有缺口，缺的部分只能等排期。这跟 4.3 讲的二开现象是同一个逻辑的两面。

## 总结

### 5.1 场景速查

先按硬约束过一遍。下面这棵树上的每个判断点，都对应前文的某一节；能在前几步就分流出去的场景，往往不需要再纠结跑分。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/doris-06.light.svg" alt="5.1 场景速查">
<img class="dfig-d" src="/diagrams/doris-06.dark.svg" alt="5.1 场景速查">
</figure>

下表把前文的讨论压缩成一份索引，用于快速定位到对应章节，不建议脱离上下文直接当作选型结论。表中的「打平」不代表两家做法相同，只表示在该维度上没有明显优劣。

| 场景 / 能力 | 通常更适合 | 章节 |
| --- | --- | --- |
| 大数据量聚合分析、单查询低延迟 | **ClickHouse** | 2.1.1 |
| 高并发点查、几百人同时看报表 | **Doris** | 2.1.3 |
| 全文检索、当 ES 用 | **Doris** | 2.1.4 |
| 流式加工链路、想省掉 Flink | **ClickHouse** | 2.1.6 |
| BI 报表提速且不想改 SQL | **Doris** | 2.1.6 |
| 湖仓联邦查询、跨 catalog JOIN | **Doris** | 2.1.7 |
| 私有化部署 + 存算分离 | **Doris**（CK 开源版没有） | 2.1.8 |
| 实时更新、CDC 入库、主键语义 | **Doris**（常为硬约束） | 2.2.2 |
| 高吞吐追加写入 | 打平（语义 Doris 赢，吞吐不输） | 2.2.3 |
| 极致压缩、存储成本敏感 | **ClickHouse** | 2.2.4 |
| 冷热分层，且要求故障不影响服务 | **Doris**（故障隔离更好） | 2.2.5 |
| 半结构化 / JSON | 打平 | 2.2.6 |
| 强 SLA 多租户、OS 级资源硬隔离 | **Doris** | 2.3.1 |
| 精细化查询熔断与配额 | **ClickHouse** | 2.3.2 |
| 向量检索 / RAG | **Doris** | 2.4 |
| AI Agent 接入、MCP 生态 | **ClickHouse** | 2.4 |
| 集群频繁扩缩容 | **Doris**（CK 需外部工具补） | 3.2 |
| 周期性备份恢复 | 打平（CK 语法更全，无需 broker） | 3.3 |
| 数据生命周期治理、降采样 | **ClickHouse**（列 TTL + TTL GROUP BY） | 3.4 |
| 强合规、需要数据脱敏和 SQL 化审计 | **Doris** | 3.6 |
| 对接存量 BI 工具、全公司推广 | **Doris**（MySQL 协议） | 3.7.1 |
| 自诊断、自监控、可观测底座 | **ClickHouse**（系统表） | 3.7.3、4.4 |
| 信创、arm/Kylin 环境 | **Doris** | 1.3 |
| 需要深度定制、二次开发 | **ClickHouse** | 4.3 |
| 国内本土化技术支持 | **Doris** | 4.6 |

### 5.2 一份「过时论调」清单

写这篇文章时，笔者核实了大量流传甚广的说法，发现相当一部分已经不成立了，包括我自己此前的一些认知。技术选型最怕的就是拿三年前的结论做今天的决策，所以单独列一份清单：

| 流传的说法 | 现状 |
| --- | --- |
| CK 不支持全文检索 | ❌ 26.2 已 GA，但只是「半个」，无 BM25、不支持模糊匹配，且 GA 后仍在频繁改名和反复（详见 2.1.4） |
| CK 不擅长 JSON | ❌ JSON 类型 25.3 已 GA，纯列式实现，JSONBench 默认配置下排名第一 |
| CK 没有资源隔离 | ❌ 25.4 引入 CPU slot 调度，层级 workload 模型表达力比 Doris 更强 |
| CK 依赖 ZooKeeper，运维负担重 | ❌ ClickHouse Keeper 自 21.x 起逐步取代，24.x 后基本无需再部署 ZK |
| CK 大表 JOIN 不行 | ❌ 24.7 起持续优化 parallel hash join，25.7 趋于稳定，官方压测 9 表 JOIN 无压力 |
| runtime filter 是 Doris 独有的加速能力 | ❌ CK 25.10 引入，2026 年 2 月起默认开启 |
| CK 开 ZSTD 必然触发 too many parts | ❌ 源自单一迁移案例。根因是 merge 跟不上写入，不是压缩算法（详见 2.2.4） |
| Doris 写入不需要攒批 | ❌ rowset 等价于 part，高频微批同样撞版本数限制。差别在于攒批被内建进了导入通道且受事务保护 |
| Doris 的 CCR 开箱即用 | ❌ 每个 job 需 FE 预留 4GB+堆内存、binlog 需手动限流、tmp partition 会中断同步，实用性一般 |
| CK 的物化视图就是个预计算缓存 | ❌ CK 的增量 MV 按写入块触发，可承担流式转换并持久化聚合状态；Doris 虽有`AGG_STATE`等能力，但整体机制和适用方式不同（详见 2.1.6） |

这份清单本身也会过时。唯一可靠的做法是拿自己的数据集实测，其次是去看两家的 release note 和源码，而不是看两年前的对比文章，包括这一篇。

### 5.3 最后

CK 和 Doris 的能力边界正在接近，但两者的设计重心并没有因此消失。CK 围绕有序存储、向量化执行和追加写入不断强化分析效率，很多高级能力也允许使用者深入控制；Doris 则把更多精力放在 MPP 调度、更新语义、自动运维和 MySQL 生态兼容上，优先降低企业落地成本。

这种差异在可观测场景中尤其明显。CK 已经被大量日志、指标和 APM 产品用作存储后端，聚合性能、压缩、TTL 和系统表共同构成了它的生态基础。Doris 的日志检索能力进步很快，但在指标和 Trace 生态中仍处于追赶位置。即便如此，日志场景也不能只按产品名称选择：侧重全文检索时，Doris 的倒排索引更成熟；侧重扫描、聚合和生命周期治理时，CK 更有优势。

选型时可以先看几个硬约束：是否需要高频更新和主键语义，是否要频繁扩缩容，是否依赖私有化存算分离，是否需要全文搜索，以及查询主要是高并发短查询还是少量重聚合。这些条件往往比功能清单和单项跑分更能决定结果。

如果数据以追加写为主，核心负载是大规模聚合、可观测分析或时序降采样，并且团队有能力管理分片和参数，CK 通常更合适。如果需要 CDC 更新、高并发 BI、自动均衡、MySQL 工具链或信创环境适配，Doris 通常更稳妥。处在两者交集中的业务，则应使用自己的数据分布、查询集合和故障场景完成 POC，而不是直接套用厂商或本文的结论。

归根结底，CK 倾向于把更多控制权交给使用者，以换取性能和表达力；Doris 倾向于把更多复杂度收进系统内部，以换取一致的使用和运维体验。选型的关键不是谁的功能更多，而是哪一种复杂度更适合你的团队承担。
