---
title: 2026 年 ClickHouse 和 Doris 怎么选
---

# 2026 年 ClickHouse 和 Doris 怎么选

前些年人们说起日志存储，不自觉会拿 Elasticsearch 和 ClickHouse 对比。这几年大家不大提 ES 了，ClickHouse 更多时候成了 Doris 的对标对象。ClickHouse 也终于从一位屠龙者，长成了别人眼里的巨龙。

很多朋友让我出一期 ClickHouse 和 Doris 的全面对比。随着 Apache Doris 在国内火起来，不管是可观测、实时分析，还是 AI 相关的数据场景，这两个数据库总是一起出现在候选名单里。做选型的人难免纠结：到底该选 ClickHouse（以下简称 CK），还是 Doris？

我做了六年多 ClickHouse 的开发和运维，是 ClickHouse、clickhouse-go 的 contributor，也是 ckman 和 clickhouse_sinker 的作者，Doris 也深度用过、调过。CK 这边我熟得多，生产上的案例也多，这一点先交代清楚。下面尽量把事实、我自己测过的和我个人的看法分开说，一项一项比下来。

## 先看出身

### 开源协议

Doris 是 Apache 顶级项目，Apache License 2.0。CK 早年由 Yandex 主导，后来因为众所周知的原因独立出去，搬到了大漂亮的西雅图，协议同样是 Apache 2.0。两边都允许商用和二次开发。

协议一样，事情却颇具戏剧性：基于 CK 魔改的二开版本数不胜数，Doris 却几乎没有，唯一分出去的 StarRocks 今天已经是两个独立演进的项目了。这事后面讲二开的时候再展开。

商业版这块，Doris 有社区版，也有 SelectDB 的商业产品，内核能力基本共享，差别主要在交付、配套工具和技术支持。CK 也分开源版和 Cloud，但这两个差别就大了：存算分离、更完整的写入查询监控运维能力，有一部分只在 Cloud 里，要想体验只能花钱。而 Cloud 在国内又不怎么流行，国内用户更习惯用阿里、华为这些云厂商的托管 CK。

### 编程语言和安装包

CK 是纯 C++，这几年开始实验性地引入 Rust。Doris 的 BE 是 C++，FE 和 UDF 用 Java。两边的 C++ 都已经用上了 C++20。

从产物看，CK 的安装包两百多兆，Doris 足足 2.8 个 G，多出来的大头是 jar 包依赖。安装方式上 CK 有 rpm、deb、tgz，有 yum 源、apt 源和 docker 镜像，Doris 只有一个 tar.gz。

### 信创

Doris 最早是百度一批人开发并开源的，后来独立成公司，在信创这一块，血脉上就天生优人一等，信创认证、本地化适配、项目交付都占便宜。

CK 是外国人主导开发的，虽然在信创过程中没有因为非国产被直接排除，但在 Kylin ARM 上吃过不少苦头：直接跑官方安装包，一运行就 coredump。原因是官方构建的指令集基线比目标 CPU 新，用 `-DNO_ARMV81_OR_HIGHER=1` 重新编译就能正常跑。所以 CK 在 Kylin ARM 上不是不能用，是不能开箱即用，编译、验证、维护安装包的活得落地团队自己扛。这个坑我单独写过一篇：[ARM 上一跑就 SIGILL](/clickhouse/vendor/kylin-arm-instruction-baseline)。

### 安全漏洞扫描

国内有很多傻乎乎的安全扫描软件，它并不关心你代码怎么实现的，只看你用的依赖库版本是不是低于它知识库里的漏洞版本。政企、银行、证券这些行业，上线前要过漏洞扫描，有的还是强制准入条件。Doris 用了大量 Java，每次都能扫出一大堆漏洞，一点都不奇怪。

说得专业一点，这类扫描大多是 SCA（软件成分分析）：解析构建产物，列出依赖清单，拿版本号去比 CVE 库。它判断的是「你用了某个有已知漏洞的版本」，不是「有漏洞的代码会不会被执行到」。Java 在这套规则下天然吃亏：一个 FE 模块直接依赖几十个，展开传递依赖就是几百个 jar；Log4j2、Fastjson、Jackson、Netty 这些几乎是标配，又恰好是 CVE 最密集的几个库；jar 包里的 `MANIFEST.MF`、`pom.properties` 把版本号写得清清楚楚，扫描器连推断都不用。

CK 的待遇完全不同，但原因不是它更安全。CK 主干仓库的 `.gitmodules` 里有 139 个 submodule，`contrib/` 下近 300 个目录，openssl、curl、protobuf、boost、libxml2、krb5、icu，个个都是 CVE 常客。区别只在于这些库是源码 vendor 进来、静态链接进那个两百多兆的二进制里的，没有版本清单，也没有独立的 so。SCA 工具面对一个静态链接的 C++ 二进制，基本什么都列不出来，报告干干净净，只是因为工具看不见。

扫出来以后修起来更麻烦。开源组件的依赖版本是上游定的，你单独升一个 jar，很可能撞上 API 不兼容；有的组件已经 EOL，上游根本不会再发版；等社区合并修复再发版，估计要等到猴年马月去，项目上线窗口可不等人。强合规的场景下，还可以准备 SBOM、可达性说明和豁免材料，能不能被接受就看各家机构的规矩了。

PS：我并不认为 C++ 写出来的代码就没有安全漏洞，只是扫描软件太傻，识别不了而已。Java 只要比对 jar 包版本，简单粗暴。可很多企业就认这个，没办法。所以这里比的是过安全准入的成本，不是谁更安全。

## 查询

### 聚合查询

聚合查询这一项，说 CK 断档式领先也不为过（这里不是单单针对 Doris，是在座的各位）。十亿级的数据做个最简单的 count，CK 基本秒出，Doris 在我当时的测试里要十秒开外。当然这类数字受表模型、数据分布、缓存、并行度和机器配置影响很大，换个环境数字会变，但量级上的差距我是认的。

为什么？两边虽然都是列存，磁盘上的组织方式差别很大。CK 的数据层级是 SHARD → PARTITION → PART → GRANULARITY → ROWS，数据在磁盘上按排序键排好了放，这决定了它压缩比更高，按指定列查的时候也能快到极致。

Doris 的层级是 PARTITION → BUCKET → TABLET → ROWSET → ROWS。它先按分桶规则把数据拆成适合并行处理的 tablet，tablet 内部再按 Key 列排序、建前缀索引。它更强调并行执行、更新语义和数据能挪来挪去；CK 则把排序键、稀疏索引和物理布局绑得更紧，在按排序键裁剪数据和压缩上更占便宜。两边并排放一起看会更直观，Doris 多出来的 BUCKET/TABLET 这一层，后面讲数据均衡的时候还会再碰到。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/doris-01.light.svg" alt="ClickHouse 与 Doris 的数据层级对比">
<img class="dfig-d" src="/diagrams/doris-01.dark.svg" alt="ClickHouse 与 Doris 的数据层级对比">
</figure>

### JOIN

在过往很多介绍 Doris 的文章里，经常拿 JOIN 来打 CK。先说说 Doris 的 JOIN 为什么强。

Doris 的 FE 规划分布式 JOIN 时，优先级是 Colocate Join → Bucket Shuffle Join → Broadcast Join → Shuffle Join。Colocate Join 是本地 join，要求参与 join 的 hash key 落在相同节点上，建表时用 `colocate_with` 指定。Bucket Shuffle Join 用于等值 hash，左表已经按 JOIN 键分桶时，左表不动，只按同样的规则重新分发右表，网络开销约等于右表的数据量。Broadcast Join 简单粗暴，右表全量发给每个节点，网络和内存开销都是 N × B（N 是节点数，B 是右表数据量）。Shuffle Join 是左右两表都按 hash 打散到各节点，网络开销 A + B，内存开销 B。

Doris 还有 runtime filter：扫左表和加载右表同时进行，右表一般先完成，这时根据 JOIN ON 条件动态生成过滤条件，广播给正在扫左表的各个节点，左表少扫很多数据。左表很大、右表很小的时候特别管用。再加上 Nereids 优化器能按统计信息调整 JOIN 顺序，把小的输入放到构建侧，多表 JOIN 也不太需要人操心。

CK 的分布式 JOIN 分带 global 和不带 global，不带 global 的有严重的读放大，基本不会用。global join 是汇总节点先把右表查出来，广播给各节点和左表的本地表 join，再把结果收回来，执行过程更接近 Broadcast Join。

CK 没有原生的 colocate join，但这东西本身没什么技术难度。我们在 clickhouse_sinker 里支持按某个 sharding key 做路由，相同的数据写到固定节点，轻而易举就有了 colocate join 的效果。实际生产里，事实表 300 亿、维度表 5000 万的 JOIN，基本两三秒内返回。当然这是在这种数据布局下的效果，不能代表 CK 的 JOIN 普遍都这么快。

CK 一直被人诟病的是大表 JOIN 大表、多表 JOIN 不行。原因还是右表太大，构建 hash 表吃内存，容易 OOM，性能也奇差。不过 24.7 以来 CK 一直在优化 parallel hash join，到 25.7 趋于稳定，官方压测里 9 张表的 JOIN 也不在话下。优化器这块，CK 从 23.x 开始重写 analyzer，25.x 之后陆续加了 join reorder，早年那种复杂 JOIN 要靠手动调嵌套顺序的日子也在过去。runtime filter 也有了，25.10 引入 `enable_join_runtime_filters`（PR #84772），原理和 Doris 一样，从右表的 JOIN key 建 bloom filter，作为 PREWHERE 下推到左表扫描。2026 年 2 月起默认开启，26.4/26.5 又做了增强。所以过往文章里「Doris 有 runtime filter，CK 没有」这一条，现在已经作废了。

CK 还有个很好用的功能：可以拿 CK 的表和 MySQL 的表直接 JOIN。CK 的数据适合插入和查询，不适合改和删，那就把需要频繁修改的维度数据放 MySQL，大量的事实数据放 CK，用 MySQL 引擎把两边 JOIN 起来。这个玩法 Doris 用不了。

JOIN 这一项，Doris 的执行策略和优化器确实更成熟，这个我认。但差距没有很多文章说的那么大，而且在缩小。

### 并发查询

CK 官方默认配置里，`max_concurrent_queries` 是 100。这其实释放出一个信息：CK 的并发能力可能并不是很强。准确地说，`max_connections` 默认 4096，连接能建很多，但同时跑的查询只有 100 个，进来了也得排队，排不上的在队列里等 `queue_max_wait_ms`（默认 5 秒），等不到就抛 `Too many simultaneous queries`。

为什么这么设？因为 CK 的单个查询默认就要吃掉半台机器。`max_threads` 默认是 CPU 核数的一半，一条 SELECT 下去几十个线程一起扫。CK 能把十亿行 count 做到秒出靠的是这个，并发上不去也是因为这个。你不可能既让每个查询独占大半台机器，又让几百个查询同时跑。

高并发场景我一般这么调。先降单条查询的资源占用，短查询试试 `max_threads=1`，在我的负载里，上下文切换和线程汇合的开销少了，总 QPS 反而上去了，当然重扫描的查询不能这么干。小结果集的短查询，可以对比一下 HTTP 和 Native 协议，我测过不带 keepalive 的 HTTP 请求，2000 并发下延迟还能在 50ms 以内。然后才是调大 `max_concurrent_queries`，同时把 `queue_max_wait_ms` 调小，排不上的快速失败，别把连接池拖死。最后是架构手段：单分片、每个节点全量数据，QPS 不够就横向加节点，单分片不走网络，JOIN 反而更快。

即便这么调，CK 的并发上限也得重点压测。网易云音乐公开过一组数据：他们的 CK 集群并发超过 200 就频繁 `Too many simultaneous queries`，同一个案例里 Doris 能撑 500 以上。这是特定业务下的数字，但方向是对的。Doris 的 BE 按 tablet 并行执行，再用 Workload Group 限制不同负载，这套模型天生更适合大量短查询同时打进来。

这一项我给 Doris。几百人同时看报表，Doris 更合适；并发不高、但单条查询要尽快出结果，CK 的并行扫描更能发挥。

### 全文检索

全文检索是两边这几年变化最快的一块，很多旧结论都失效了。

Doris 从 2.0 开始内置倒排索引，到 2.x 已经相当成熟，4.0 又加了 `search()` 函数，把检索语法直接嵌进 SQL。网易云音乐的案例里，倒排索引把全文检索性能提了 7 倍，撑住了 50 台机器、2PB 数据、峰值 6GB/s 的写入。可以说，Doris 是真把「当 ES 用」这件事做成了。

CK 这边，过去几年一直被打的就是「不支持全文检索」。现在情况变了，但没有宣传的那么好。text index 确实 GA 了，从源码的 `SettingsChangesHistory.cpp` 里能拉出完整的时间线：

| 版本 | 事件 |
| --- | --- |
| 24.6 | `allow_experimental_full_text_index` 引入 |
| 25.9 | text index 第三次重写，仍是 experimental |
| 25.12 | 转 beta，`default` 分词器名被废弃，必须显式指定分词器 |
| 26.2 | `"The text index is now GA"`，正式 GA |
| 26.6 | 新增 `allow_experimental_text_index_lazy_apply` |
| 26.7 | 上面这个开关被标记 obsolete，改用 `text_index_posting_list_apply_mode='lazy'` |

GA 之后第四个版本又塞进来一个 experimental 开关，这个开关只活了一个版本就被废弃改名。短语搜索依赖的 `allow_experimental_text_index_phrase_search` 至今还挂着 experimental 的牌子，官方说磁盘格式还不稳定。

分词器的命名更乱。`TokenizerFactory.cpp` 里有这么一行：

```cpp
factory.registerTokenizer("unicode_word", ITokenizer::Type::AsciiCJK, ascii_cjk_creator);
```

注册名叫 `unicode_word`，枚举类型却是 `AsciiCJK`，同一个分词器挂着 `asciiCJK`、`unicodeWord`、`unicode_word` 三个名字。提交历史上也是反反复复：6 月 23 日一天之内 `rename one field` → `Revert "rename one field"` → `rename one field`；6 月 25 日有一条 `Reapply "Text index postprocessor"`，说明这个特性被整个 revert 过一次；7 月 7 日还有一条 `Don't use the text index for hasToken with non-splitByNonAlpha tokenizer`。

功能上也有明确的限制。它不支持 BM25，没有相关性打分，官方自己的定位就是「加速引擎而非相关性引擎」，能帮你快速过滤出包含关键词的行，没法告诉你哪一行更相关。`LIKE '%term%'` 用不上索引，模糊匹配还是全表扫。`hasToken` 用的是默认分词器而不是索引的分词器，这个坑大到官方不得不新加 `searchAny`/`searchAll` 两个函数来绕。

所以 CK 的 text index 现阶段更适合理解成关键词过滤加速，而不是搜索引擎。要拿它直接接管 ES 的负载，我不建议。如果目标真是全文检索，而不只是日志分析，Doris 更稳。

### 跨集群和跨机房

CK 开源版没有原生的跨集群持续复制。它能做的是跨集群查询，`remote()`/`remoteSecure()` 可以直接查另一个集群，但那只是查询时临时拉数据。真要做异地灾备或者多机房同步，官方给不出答案，以前有个 `clickhouse-copier`，现在也废弃了。

所以 CK 的跨集群方案都在数据库外面。一种是写入端双写，一份数据同时投递到两个集群；另一种是在管理层把多个物理集群抽象成一个逻辑集群，ckman 的逻辑集群就是这个思路，上层看到的是一个统一视图，底下是几个独立的物理集群，坏了一个不影响另一个。

Doris 有原生方案 CCR（Cross Cluster Replication）。2.0 引入了 Binlog，靠一个叫 Syncer 的外部组件读 binlog，回放到下游集群，底层是 Backup/Restore 做全量，再按 CommitSeq 做增量。库级、表级、全量、增量，连 DDL 都能同步，能力上确实完整。

可 CCR 的实用性一般。看看官方文档自己列的注意事项：同步期间 backup/restore job 和 binlog 全在 FE 内存里，建议每个 job 在两边 FE 各预留 4GB 以上的堆内存，多几个 job，FE 就得单独扩容；binlog 默认无限保留，不手动设 `binlog.max_bytes` 磁盘迟早被撑爆；同步的表带倒排索引，目标集群得配 `restore_reset_index_id=false`；上游只要建了 tmp partition，Doris 就禁止 backup，同步直接中断；BE 的 `thrift_max_message_size` 默认 100MB，tablet 一多就超限。再加上 Syncer 本身还得单独部署和运维，这东西更像是「能用」，而不是「省心」。

账面上 Doris 赢，毕竟有原生方案。但真到生产上，CCR 是个需要精心调参、持续照看的半成品，CK 那套双写加逻辑集群虽然朴素，反而更可控。我的建议是，跨机房这件事，不管用哪个数据库，都别指望它自己能解决好。

### 物化视图

聊物化视图，不能只把它当成「预计算后的查询缓存」。在 CK 里，增量物化视图还干着流式计算和写入转换的活。两边各有三种预计算机制，但能力线是错开的，直接正面比很容易比歪。

CK 的增量 MV 不是定时刷新的缓存，它是插入触发器。每个 INSERT block 到达，MV 立刻对这一批数据算完，把结果写进目标表。从 PostgreSQL 过来的人常带着「物化视图 = 缓存的查询结果 + 定时刷新」的印象，在 CK 这里是完全错的。

这么设计的第一个好处，是成本只和增量有关，和表的总量无关。一张 PB 级的表挂上 MV，集群几乎没有额外压力，因为它永远只算刚写进来的那一个 block。

第二个好处是能持久化聚合状态。`sumState`、`uniqState`、`quantilesState` 这些 `-State` 组合子存的不是最终结果，而是能继续合并的中间态，查询时用 `-Merge` 得到想要的粒度。一份按分钟存的 `uniqState`，能正确合并出小时、天、月的精确去重数，而不是把每分钟的 UV 简单相加。状态还能一层层往上卷：源表 → MV → 分钟级 AggregatingMergeTree → 再挂 MV → 小时级 → 天级，每一层的计算量都只取决于新增数据。Doris 也有 `AGG_STATE` 和 `state`/`merge`/`union` 组合子，BITMAP、HLL 也能继续聚合，所以不能说 Doris 没有聚合中间态，但和增量处理链路结合成这么一整套体系，CK 要成熟得多。

第三个好处是 MV 本身就是个 ETL 算子。里面可以做 schema 转换、字段解析、类型清洗，一张源表挂多个 MV，各自带不同的 WHERE，就能把数据分流到不同的表；源表用 `Null` 引擎，写入不落盘，只做扇出，就是一条「一次写入、多路加工」的管道。CK 生态里最经典的入库范式 Kafka 引擎表 → 物化视图 → MergeTree，也是建在 MV 上的。

不过这套范式优雅归优雅，生产口碑一般。脏消息会让消费卡住，得人工去清 offset；解析消费都挤在 CK 集群里，消费者一多，CPU 就被 merge 吃掉；投递只有 at-least-once。CK 官方现在给 Cloud 用户的建议已经改成用 ClickPipes 了。实际生产里，这一段大多交给数据库外面的组件，官方的 clickhouse-kafka-connect、我写的 clickhouse_sinker 都是。Kafka 表引擎展示的是增量 MV 能做到哪一步，不是生产级的入库方案。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/doris-02.light.svg" alt="CK 增量物化视图的几种用法：Kafka 入库、聚合状态级联、Null 引擎扇出">
<img class="dfig-d" src="/diagrams/doris-02.dark.svg" alt="CK 增量物化视图的几种用法：Kafka 入库、聚合状态级联、Null 引擎扇出">
</figure>

增量 MV 的代价也很明显：只有最左侧源表的插入才触发，右表变了不触发；没有快照隔离，AggregatingMergeTree 的 merge 是异步的，读到的可能是合并了一半的状态；还有最现实的一条，一张高频写入的表上挂多个 MV，会成倍放大 too many parts。

CK 另外两种机制是 Projection 和 Refreshable MV。Projection 对查询透明，CK 自己判断用不用，不用改 SQL，适合接 BI，但只能单表。Refreshable MV 24.10 起 production-ready，定时全量重算写入目标表，支持 `DEPENDS ON` 搭 DAG，能替代简单的 dbt 调度，但成本跟着源表总量走，大表上刷一次又慢又吃内存，而且得显式去查目标表。

Doris 这边，同步物化视图实时，但本质是 rollup，只能单表。真正的优势在异步物化视图：能做多表 JOIN，还在 CBO 层做透明改写，用户根本不需要知道 MV 存在，优化器自己判断能不能用 MV 改写查询。CK 的三种机制里，Projection 透明但只能单表，Refreshable MV 能 JOIN 但不透明，没有一个能同时做到「多表」和「透明」。

所以物化视图这一项，要看你拿它干什么。做流式加工链路、想省掉一套 Flink，CK 的增量 MV 是独一份；想给已有的 BI 报表提速，又不想改 SQL，Doris 的透明改写更省事。

### 数据湖

Doris 在这块的设计更正统。Multi-Catalog 建了 catalog → database → table 三级元数据，Hive、Iceberg、Hudi、Paimon、ES、JDBC 在 catalog 这一层整体接进来。早期 Doris 只有两级，接外部数据得一张表一张表地 `create external table`，几百张表就是几百条 DDL，这个痛点现在解决了。有了 catalog 这一层，跨 catalog 的联邦 JOIN、下沉到外部 catalog 的统一权限、湖上写回，这几件事 CK 都做不了。

CK 这边有表函数（`iceberg()`、`deltaLake()`、`hudi()`、`paimon()`，一条 SQL 直接查）、表引擎（`IcebergS3` 等，把外部表持久化成一张表定义），还有 `DataLakeCatalog` 库引擎对接 Unity、REST、Polaris、Glue，26.2 起还能查 Google BigLake。配合 25.8 引入的 Parallel Replicas，文件扫描能摊到多个节点上。和 2024 年比，CK 对 Iceberg 的支持已经完善了很多。

差距在深度，不在有无。CK 把湖当成一个数据源来读，Doris 把湖当成一等公民来管。湖上要联邦查询、统一权限、写回，选 Doris；湖只是个只读的上游，数据最终还要落进本地表做高吞吐分析，CK 足够了。

### 存算分离

Doris 3.0 有完整的存算分离：共享存储（对象存储或 HDFS）、计算组（Compute Group）、元数据服务（Meta Service）三层。数据在共享存储上，BE 无状态，编成计算组，用 `use @<compute_group_name>` 把不同负载分到不同计算组，导入和查询物理隔离。工程细节也做得不错，扩缩容时渐进式预热缓存，不影响正在跑的查询；一个集群的表只复制元数据就能克隆到另一个集群。官方给的数字是存储成本下降约 90%，查询性能下降约 35%（这些数字来自 SelectDB/VeloDB 的博客，只能当厂商案例看）。

CK 对应的能力叫 SharedMergeTree，只在 Cloud 里有，开源版没有。开源版能做的只有存储下沉：把 S3 注册成一块盘，用 `TTL ... TO VOLUME` 把冷数据挪过去。这解决的是冷数据的存储成本，计算和存储还是绑死的，没法独立扩计算节点，扩容还是要搬数据，说到底只是分级存储。

必须私有化部署存算分离的，Doris 有明确优势。协议一样是 Apache 2.0，但 Doris 把存算分离放进了开源版，CK 把它留在了 Cloud，差别在产品边界。

## 存储

### 分区

分区看起来只是建表时的一行 DDL，但两家在这里的取向截然不同，而且会一直影响日常运维。

CK 是先有数据后有分区。`PARTITION BY` 是一个表达式，数据写进来时求值，分区不存在就当场创建：

```sql
PARTITION BY toYYYYMM(event_time)
```

建完表直接灌，2023 年的数据来了就有 2023 年的分区，回填十年前的历史数据也不用提前准备，数据探索、历史回补的时候非常舒服。代价是分区数失控的风险全落在使用者身上。分区键选细了，比如跨多年的数据按天分，分区数肉眼可见地膨胀。更隐蔽的是脏数据，日志里混进一个 1970 年或者 2099 年的时间戳，就能凭空造出一个分区，而且一直待在那。`max_partitions_per_insert_block`（默认 100）拦得住「一次写入撒到几百个分区」，拦不住「分区总数慢慢涨到几万个」，这事我在 [Too many partitions](/clickhouse/deep-dive/too-many-partitions) 那篇里也说过。

分区多了的后果，CK 在报错信息里写得很直白：启动变慢、INSERT 变慢、SELECT 变慢，建议单表 1000 个以内。同一段提示里还有一句常被忽略的话：分区不是用来加速查询的，那是排序键的活，分区是为了 `DROP PARTITION` 这类数据操作存在的。很多人把分区当索引用，方向从一开始就错了。CK 也不支持原地改分区键，选错了只能新建表、迁数据、`RENAME` 交换，所以这一行得在建表时想清楚。

Doris 是先有分区后有数据。传统的 RANGE/LIST 分区必须先建好，分区不存在，导入直接报错。好处是分区数始终在掌控之中。增量数据可以用 `dynamic_partition` 自动滚动，配几个参数就不用管了。

问题出在历史数据上。动态分区只管窗口之内，超出 `dynamic_partition.start` 的历史数据没有分区可落，导入失败；要补历史分区得开 `create_history_partition=true`，还受 FE 的 `max_dynamic_partition_num` 限制。而且 `start` 到当前时间之间要是有分区意外丢了，动态分区不会再帮你建回来。

这套机制真正难受的地方，在数据时间轴稀疏的时候。举个实际会遇到的场景：一个月前某一天补了一批历史数据，中间三十来天什么都没有，然后今天才有新数据进来。按天分区，想让那一天的数据落进去，就得把那天到今天之间的分区全建出来，中间那三十个分区一行数据都不会有，纯粹是为了让边界上那一天能进库。空分区也不是零成本：每个分区都要按分桶数乘副本数分配 tablet，一张 32 桶 3 副本的表，一个空分区就是 96 个 tablet，30 个就将近 3000 个，这些元数据全驻留在 FE 内存里，还要写进 BDB JE 参与 checkpoint；BE 侧也要建目录、定期向 FE 做 tablet report，前面 CCR 那条 `thrift_max_message_size` 被撑爆，根因就是 tablet 太多。`max_dynamic_partition_num` 默认只有 500（`Config.java:1686`），按天分区一年多一点就顶到天花板了。

同样的数据在 CK 这边不是问题：7 月 5 日有数据就建 7 月 5 日的分区，中间三十天没数据就一个都不建，连空目录都没有。

Doris 2.1 的 AUTO PARTITION 就是冲着这个来的，按导入数据的实际取值按需建分区，中间的空洞不会被填上，说白了就是朝 CK 那套数据驱动的模式靠了一步。但它只管建、不管删，过期得自己写脚本 `DROP PARTITION`；2.1.3 起还不能和 dynamic_partition 共用，因为动态分区回收时不看分区是谁建的，会把 AUTO PARTITION 建的一并回收掉，造成不易察觉的数据丢失；上限换成了 `max_auto_partition_num`，默认 2000（`Config.java:2953`）。所以在 Doris 上，「不产生空分区」和「分区自动过期」这两件事，2.1.3 之后是二选一。CK 没有这个取舍，分区创建和 TTL 回收本来就是两套独立的机制。

一句话说，CK 把分区当成写入的副产物，Doris 把分区当成需要申报的资源。前者省了规划，风险留到运行期，可能被脏数据带跑；后者在建表和导入时多花心思，换来规模可控，代价是时间轴不连续时要拿空分区去凑。我自己更喜欢 CK 这种，脏数据的问题在写入端过滤就是了，空分区的问题可没法在写入端解决。

### 更新和删除

CK 是为追加写设计的，更新删除是后来一点点补上的。ReplacingMergeTree 能让同主键最终只留最新版本，但去重靠后台 merge，什么时候完成说不准，要立刻看到去重结果就得在查询里加 `FINAL`，查询代价跟着上去。`ALTER TABLE ... UPDATE/DELETE` 是 mutation，直接重写整个 part，异步执行，大表上跑一次能把 IO 打满，生产上基本属于能不用就不用。轻量级 delete/update 用标记代替重写，好多了，但限制还是不少。`insert_quorum` 管的是副本写入确认，`insert_deduplication_token` 管的是投递幂等，都和主键语义没关系。这些可以组合着用，但组合起来也不等于一个主键约束，CK 没有写入即可见的唯一键语义。

Doris 是正面解决的。Unique Key 表从 2.1 起默认 Merge-on-Write：写入时 BE 先在 memtable 里按 key 排好序，然后拿批次里的每个 key 去查各个 segment 的主键索引，找到旧行所在的 rowset 和 row id，在对应 rowset 的 delete bitmap 上置位，新行写进一个全新的 rowset。查询时直接跳过被标记的行，不需要按 key 做多版本合并，旧数据等 compaction 时再回收。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/doris-03.light.svg" alt="Doris Merge-on-Write 的写入路径，查主键索引是写放大的主要来源">
<img class="dfig-d" src="/diagrams/doris-03.dark.svg" alt="Doris Merge-on-Write 的写入路径，查主键索引是写放大的主要来源">
</figure>

配套也完整：sequence 列（`function_column.sequence_col`）决定同一个 key 的两次更新谁赢，CDC 场景下事件乱序到达也能留下较新的那条；`__DORIS_DELETE_SIGN__` 隐藏列置 1 就是软删除；部分列更新时自动读出缺的列值补全整行。MOW 也有代价，写放大主要来自主键索引查找，delete bitmap 的计算开销随存量和并发导入数上升，存算分离模式下计算还要持锁，3.0 修过一类「上一个失败事务没释放锁、后续导入全部卡死」的问题。

这一项 Doris 赢得很干脆。业务里有高频更新、CDC 入库、需要唯一键约束，基本就是 Doris；数据以追加为主，这一项的权重就低得多。

### 写入

CK 写入调优的核心约束是一次 INSERT 通常产生一个 part，插入频率超过后台合并速度，part 失控，就报 too many parts（详见 [Too many parts](/clickhouse/deep-dive/too-many-parts)）。物化视图还会放大这个问题，每个挂在源表上的 MV 都在持续生成小 part。官方的办法说到底都是攒批：客户端攒够几十万行或上百 MB 再写；客户端攒不了就开 `async_insert`；或者用 Buffer 表先缓存在内存里定期刷，好处是缓冲区里的数据也能查到，坏处是它在事务之外，宕机就丢。

Doris 的写入是事务性的。同一个 label 在一个 DB 里只会成功一次，重试会被判重拒绝，天然幂等；Stream Load 支持两阶段提交，由 Flink/Spark 在 checkpoint 成功后再 Commit，这是真正的 exactly-once。

不过这里要泼一盆冷水：Doris 也不是不用攒批。每次 Stream Load 产生一个 rowset，rowset 就相当于 CK 的 part，高频微批一样会撞上版本数限制、compaction 跟不上。区别是 Doris 把攒批做进了 Routine Load、Flink Connector 和 Group Commit，还有事务兜着。

我当初写 clickhouse_sinker，初衷之一就是在数据库外面把攒批、去重、路由、失败重试补齐。这也意味着评估 CK 的时候，不能只算数据库本身的运维成本，写入组件那一层也得算进去。纯吞吐两边都能做得很高，把事务、幂等、exactly-once 算进来，Doris 更完整。

### 压缩比

CK 压缩比高，这是公认的，但很多人说不清为什么高。根子还是前面说的排序存放：排序以后相邻行相似度极高，同一列的相邻值往往连续或者重复，这给压缩算法提供了最理想的输入。Doris 的 tablet 内部虽然也按 Key 排序，但没有 CK 这么彻底地围绕排序键组织数据，压缩效果要打个折扣。再加上 CK 有列级 codec，`Delta`、`DoubleDelta`、`Gorilla`、`T64`，时间戳列用 `DoubleDelta`、浮点指标用 `Gorilla`，压缩比还能再上一个台阶，这套东西 Doris 没有对等物。

网上有一种说法流传很广：「CK 开 ZSTD 会触发 too many parts，所以生产上只能用 LZ4。」源头是浩瀚深度那个 13PB 的迁移案例，他们为了省存储试了 ZSTD，结果频繁 too many parts、入库积压，退回 LZ4；迁到 Doris 后用 ZSTD 跑得很稳，存储还比 CK 的 LZ4 低 6%。这个数据被大量引用，甚至被读成「Doris 压缩比比 CK 高」。

这个结论站不住。它比的是 Doris 的 ZSTD 和 CK 的 LZ4，根本不是同一个算法，同样开 ZSTD，CK 不会输。它是单一迁移案例，还发在迁移方自己的渠道上，典型的一面之词。最关键的是，too many parts 的根因是 merge 跟不上写入，不是压缩算法。ZSTD 比 LZ4 慢是事实，但它只是压垮骆驼的最后一根稻草，该调的是 merge 线程池、`max_bytes_to_merge_at_max_space_in_pool` 这类参数。我自己的生产环境长期用 ZSTD，没因为它出过入库积压。

所以压缩比 CK 确实领先，只是领先幅度被网上的文章夸大了；「开高压缩比容易撞写入瓶颈」也确实存在，但那是调优问题。

### 分级存储

两边功能看着差不多，差别在于对象存储被放在了哪一层抽象里。

CK 把对象存储当成一块盘。在 `storage_configuration` 里把 S3/HDFS 注册成 disk，disk 组成 volume，volume 组成 storage policy，表绑定 policy，再用 TTL 控制数据什么时候挪到冷卷：

```sql
TTL event_time + INTERVAL 30 DAY TO VOLUME 's3'
```

好处是 TTL 能指定业务字段，事件时间过了 30 天就下沉，什么时候变冷由业务语义决定，非常贴合真实需求。代价是强绑定：既然对象存储是一块盘，那它不可达就等于本地盘坏了，S3/HDFS 挂掉时 CK 可能直接起不来，故障从「部分历史数据查不到」升级成「整个服务不可用」。这个坑我在 [S3 不可达时起不来：metadata 明明在本地，它却说 S3 上找不到](/clickhouse/troubleshooting/s3-unreachable-startup) 那篇里实打实踩过。

Doris 把对象存储当成一种资源，`RESOURCE` → `STORAGE POLICY` → `TABLE`。看起来只是命名不同，实际影响很大：资源不可用时，只是放在这个资源上的那部分数据查不到，服务照常跑。但 Doris 也有两个坑：表一旦绑定了 resource 就换不了，前期规划错了后期改不了；冷却判定看的是 `visableVersion` 的时间，也就是数据什么时候写进来的，不是业务时间，你回补一批三个月前的数据，它会被当成新数据留在热存储里。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/doris-04.light.svg" alt="对象存储不可达时，CK 整个服务起不来，Doris 只影响该资源上的数据">
<img class="dfig-d" src="/diagrams/doris-04.dark.svg" alt="对象存储不可达时，CK 整个服务起不来，Doris 只影响该资源上的数据">
</figure>

两边的代价落在不同地方：CK 的冷却语义更贴业务，但把外部存储的可用性绑进了服务可用性；Doris 故障隔离更好，冷却判定却不带业务含义。数据回补频繁的，CK 更合适；对服务可用性要求极高、对象存储又不太靠谱的，Doris 更稳。

### 半结构化数据

先澄清一个过时的认知：「ClickHouse 不擅长 JSON」，说的是一个已经不存在的旧实现。CK 的 JSON 类型 25.3 GA，旧的 `Object('json')` 25.11 被彻底移除。现在的实现是从头重写的纯列式方案，每个路径存成独立子列，保留原生类型，查询只读用到的路径。CK 还有个独立的 `Variant` 类型，和 Doris 的 VARIANT 不是一回事，它得显式声明能装哪些子类型，存 JSON 应该用 JSON 类型。

Doris 的 VARIANT 2.1 引入，写入时在 memtable 里对相同的 JSON 键做类型推导和合并，存储上是动态子列加稀疏列，设计目标是撑住万列级的子列。实践中有个坑：某个路径下的值类型没法兼容转换时，会退化成 JSONB，性能比原生列差一截，所以业务上得尽量保证字段类型一致。

性能上两边正面 PK 过一次，挺有意思。JSONBench（十亿条 JSON）的默认配置下，CK 第一、第二，Doris 第三。Doris 官方随后发文，用 Schema 结构化、生成列、缓存配置、并行度调参，把总耗时降了 74%，反超 CK 约 39%。关键是生成列：JSONBench 的查询路径是固定的，那就把高频字段用生成列提成真正的列。可 JSONBench 是 CK 维护的，反超的对比是 Doris 官方发的，两边都有立场，像是对着考题的开卷考试，两组数字都得打折看。我的看法是两边打平，CK 开箱即用更省心，Doris 在 schema 变化频繁、超宽表的场景下更有针对性。

## 资源管理和 AI

### 负载隔离

多租户共享一个集群，最怕一个查询把整个集群拖垮。

Doris 用 Workload Group，基于 CGroup 做 OS 级隔离，限制单个查询在单个 BE 上能用的 CPU 和内存百分比，分软限和硬限。实测设 `cpu_hard_limit=50%`，16 核机器上并发 1/2/4 跑同一个查询，CPU 稳稳停在 800% 左右，刚好一半。限制是软限和硬限同一时刻只能二选一；2.1 起 CPU 限制基于 CGroup v1，还不支持 v2；容器里用的话，CPU 是在容器可用资源上再切的，宿主机 64 核、容器 8 核、硬限 50%，实际只有 4 核，而且得特权模式启动容器才能读写宿主机的 CGroup 文件。

CK 这几个版本一直在补资源调度：23.9 加 IO 调度，24.11 能用 SQL 管理 workload，25.4 引入 CPU slot 调度。先定义 CPU 资源，`max_concurrent_threads` 才生效：

```sql
CREATE RESOURCE cpu (MASTER THREAD, WORKER THREAD);

CREATE WORKLOAD all SETTINGS max_concurrent_threads_ratio_to_cores = 2;
CREATE WORKLOAD admin IN all SETTINGS max_concurrent_threads = 2, priority = -1;
CREATE WORKLOAD analytics IN production SETTINGS max_cpu_share = 0.7, weight = 3;
CREATE WORKLOAD development IN all SETTINGS max_cpu_share = 0.3;
```

workload 组成一棵层级树，`weight` 做加权公平分配，`max_cpu_share` 做份额上限，两个能在同一层并存，`priority` 越小越优先抢 slot，`max_cpu_waiting_share` 还能限制 CPU 等待时间的占比。用 settings profile 把某个用户的查询固定到某个 workload，后台任务另有 `merge_workload` 和 `mutation_workload`，`system.scheduler` 里能看到整棵调度树。表达力上比 Doris 强。

要 OS 级不可突破的硬隔离，比如强 SLA 的多租户、混部，Doris 的 cgroup 硬限更彻底；要弹性优先级、加权公平、IO 和 CPU 统一调度，CK 更灵活。顺带说一句，「CK 没有资源隔离」这个说法，25.4 以后就不成立了。

### 熔断和限流

熔断管的是单个查询失控，这是 CK 少数几个明确领先的运维项。单查询级有 `max_memory_usage`、`max_execution_time`、`max_rows_to_read`、`max_bytes_to_read`、`max_result_rows`，超限直接抛异常；用户级有 `max_memory_usage_for_user`；Quota 能按小时、天、周、月限制查询次数、错误数、执行时间、读取行数，这个粒度 Doris 没有；跑起来以后还能在 `system.processes` 里看实时查询，`KILL QUERY` 精准干掉。

Doris 有 Workload Policy（4.1 增强）、query timeout 和内存超限自动 kill，策略是声明式的，理解起来简单，但能控的维度确实没 CK 细。

### 向量和 AI

AI 这块其实是三条互不相干的线：向量索引、SQL 里调大模型的 AI 函数、面向 Agent 的 MCP 生态。

向量检索，Doris 从 4.0 开始支持 HNSW 的 ANN 索引，4.1 加了 IVF 和 IVF_ON_DISK，扩展到十亿乃至万亿规模，Ann Index Only Scan 可以跳过原始列的 IO。CK 是 `vector_similarity` 索引：

```sql
ALTER TABLE t ADD INDEX vec_idx vector
  TYPE vector_similarity('hnsw', 'cosineDistance', 384, 'bf16', 64, 512);
```

两边差在两个地方。一个是索引粒度：Doris 在 Segment 粒度上建索引，参数只要按单批导入的规模设，数据总量涨到多少都不用重建；CK 是 part 加 GRANULARITY（向量索引默认粒度 1 亿），两个 part 合并时要给合并后的 part 重建索引，写入越频繁，重建开销越大，HNSW 会明显拖慢 INSERT 和 OPTIMIZE。另一个是构建方式：Doris 后台异步建，导入后立即可查；CK 要 `MATERIALIZE INDEX`，两三千万行的数据集，建一次几分钟到几小时。内存两边都是硬约束，CK 给了估算公式，100 万条 1536 维 bf16 向量大约要 3.5GB；Doris 也承认常用参数下 HNSW 内存约为原始数据的 2 倍，10 亿向量接近 1TB。到了十亿级两家都得靠量化。CK 社区自己在 RFC #104122 里也承认了这些问题。

AI 函数是 Doris 独有的，4.0 起分析师可以直接在 SQL 里调大模型做信息抽取、情感分析、文本摘要。

MCP 生态 CK 积累更深：官方 MCP Server 下载量超过 22 万次，Cloud 有远程 MCP Server 和 Ask AI agent，ClickStack MCP Server 可以把 Claude、Cursor、Codex 直接连到可观测数据上，还有给 AI 编码 agent 打包领域知识的 Agent Skills 仓库。Doris MCP Server 功能上也不弱，但被主流 AI 工具集成的程度跟 CK 还有差距。

做 RAG、向量检索，Doris 更合适；让 Agent 直接访问分析数据，CK 更成熟。

## 运维

### 集群运维

CK 的运维痛点，摊开讲有这么几条。加节点要改配置文件，集群拓扑写在 `config.xml`/`metrika.xml` 里，加一个节点就要改配置、分发到每一台机器，Doris 只要一条 `ALTER SYSTEM ADD BACKEND "host:port";`。CK 不感知拓扑变化，这个下一节专门讲。元数据也是各节点各管各的，Doris 的 FE 自带元数据管理，基于 BDB JE 做复制，不依赖外部组件。

不过说到 CK 依赖 ZooKeeper，得说句公道话。早年 CK 把分布式 DDL、表和 part 信息全存在 ZK 里，ZK 经常成为瓶颈，这个批评当时完全成立（我在 [znode 爆炸：根子在 ClickHouse 的后台线程池](/clickhouse/troubleshooting/znode-explosion) 里就写过一次 ZK 被打爆的事故）。但 CK 自 21.x 起就在推自研的 ClickHouse Keeper，C++ 重写、Raft 共识、兼容 ZK 协议，到 24.x 基本取代了 ZooKeeper，还能内嵌在 clickhouse-server 进程里跑，不用再单独维护一套 Java 服务。所以「CK 依赖 ZooKeeper」也是一条正在过时的批评。

即便如此，CK 的运维复杂度还是比 Doris 高。这也正是 ckman、ByteHouse 和各家云厂商魔改版存在的理由。ckman 干的就是这个：可视化部署、滚动升级、节点增删、表与数据治理、备份恢复、监控告警，把原本要手改配置、逐台分发的操作，变成 Web 上点几下。

### 数据均衡

数据自动均衡是 CK 开源版最突出的运维短板。Doris 扩缩容时自动重新分布 tablet；服务器宕机或者坏盘，自动切副本、重定向写入、屏蔽故障节点，在其他节点上重建副本。菜鸟网络的 Doris 集群频繁扩缩容应对大促，不用人工干预。CK 开源版做不到这些，新加了节点，存量数据不会自己挪过去，磁盘或节点故障也得结合副本状态人工处理。

根子在于 CK 少了一层抽象。Doris 的 tablet 是一个可以整体迁移的最小单元，它属于哪个 BE 只是一个可变的映射，改一下映射、把文件拷过去就完成了迁移。CK 的最小单元是 part，part 归哪个 shard 是 sharding key 硬绑定的，你把一个 part 挪到另一个节点，那个节点上就出现了本不该属于它的数据，路由就错了。

所以 CK 的扩容全是绕路。改各 shard 的权重，让新数据大部分写到新节点，等老数据按 TTL 自然过期，慢慢趋于均衡，再把权重调回来，这是数据量大时最现实的办法，但周期以月计。数据量不大可以建新表重导再换名，表一多就没法用了。还有备份恢复加原地重分片，过程复杂容易出错。云厂商的说法也很直白，腾讯云直接把这称为「ClickHouse 使用和运维上的一大痛点」，它的 Resharding 模式要求剩余容量超过整表大小，一个集群同时只能跑一个任务。

既然 CK 自己不做，就只能外部工具来补。ckman 把数据均衡做成了一个可编排的任务，按表选两种策略。

默认是按分区搬：规划阶段用贪心，每一轮挑出占用最大和最小的 host，尝试把大 host 上的某个分区搬到小 host 上，只有满足 `max >= min + 2 * size` 才搬，不然搬完原本最小的反倒成了最大的，就是在原地打转。每个 host 最新的那个分区会跳过，它还在接收写入，搬它必然出事。复制表集群走纯元数据操作，目标端 `FETCH PARTITION` 拉过来，`ATTACH` 上，源端再 `DROP`，不需要主机之间打通 SSH；非复制表集群就得 `DETACH`、rsync、`ATTACH`，ckman 会先探测连通性，探测失败就跳过这张表，不让整个任务失败。

按分区搬有个前提：数据在分区之间本身分布得比较匀。如果当初 sharding key 就选歪了，搬分区只是把不均衡换个地方放，这时候要用第二种策略，按分片键重新算归属。每个 shard 上先建一张临时表（Replicated 引擎的 ZooKeeper 路径会被替换掉，免得和真表冲突），把数据搬进去校验行数，再从 `cluster()` 读临时表，用 `hash(key) % N = idx` 过滤，每个 host 只把属于自己的行 INSERT 回原表，再校验一次，清理临时表。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/doris-05.light.svg" alt="ckman 按分片键重分布的流程">
<img class="dfig-d" src="/diagrams/doris-05.dark.svg" alt="ckman 按分片键重分布的流程">
</figure>

这里面有几个细节。行数校验用 `>=` 而不是 `==`，均衡期间业务还在写，行数只会变多，卡死 `==` 会误报失败。校验失败等 5 秒再试一次，因为 `cluster()` 是分布式查询，可见性有一点延迟。还可以配一个可接受的丢失率兜底。两种策略都能只算不做，先看这次要搬哪些分区、多少行、多少字节，确认了再执行。取消检查放在每个分区、每个插入批次的边界上，中途点停止是真能停下来的。

话说回来，这些都是数据库外面的补偿，它没法像 Doris 那样节点一宕就自动重建副本，解决的只是「扩容之后怎么把存量数据挪过去」这一件事。Doris 的自动均衡也不是零成本，坏盘或宕机后的均衡会吃掉大量集群资源，生产上还是得盯着限流参数，尽量放到低峰期。数据均衡这件事我单独写过一篇：[扩容之后为什么不自动做数据均衡](/clickhouse/tooling/why-not-auto-rebalance)。

### 备份恢复

这一项 CK 原生的覆盖反而更全。Doris 的 `BACKUP`/`RESTORE` 对表或分区做硬链接快照，再由各 BE 并发上传到远端仓库，要提前部署对应的 broker，作业分阶段执行，每个阶段的进度和错误都看得到，语义很清楚。

CK 有三条路。原生 `BACKUP`/`RESTORE` 能备表、字典、库、视图、ALL，带 `PARTITION` 和 `ON CLUSTER`，目标可以是 `File`、`Disk` 或 `S3`，用 `base_backup` 做增量，支持异步、压缩和限速，不用部署 broker。`FREEZE PARTITION` 是硬链接快照，几乎不占额外空间，但只备数据不备元数据，建表 SQL 得自己从 metadata 目录拷出来，很容易踩坑。第三方的 clickhouse-backup 支持本地和 S3，part 级增量，有保留策略，还能起 server 模式提供 API。

单论周期性的冷备和恢复，两边对等，CK 的语法更全。Doris 多出来的是 CCR 那套持续同步，但实用性要打折扣。不管用哪个，备份成功都不等于能恢复，定期做恢复演练比备份命令本身重要得多。

### 生命周期

生命周期管理是 CK 优势很明确的一项。TTL 是一等公民，写在建表 DDL 里：

```sql
-- 行级 TTL：整行过期删除
TTL event_time + INTERVAL 90 DAY

-- 列级 TTL：某几列先过期，其他列保留
TTL event_time + INTERVAL 7 DAY TO detail_json

-- 到期挪到冷卷
TTL event_time + INTERVAL 30 DAY TO VOLUME 's3'

-- 聚合降采样
TTL event_time + INTERVAL 30 DAY GROUP BY dim1, dim2
    SET metric = sum(metric), cnt = sum(cnt)
```

列 TTL 能让原始日志正文、大 JSON 这些大字段先过期释放空间，时间、维度、指标这些小字段继续存很久，可观测场景里 90 天的指标只要几个字段，7 天的原始日志才需要全文。`TTL ... GROUP BY` 降采样，数据过了 30 天自动聚合成粗粒度，相当于内建了一套 rollup，不用额外跑 ETL。几条规则还能组合在同一张表上：7 天后丢明细字段，30 天后降采样并下沉到 S3，90 天后彻底删掉，全部由数据库自己执行，一行调度代码都不用写。

Doris 这边主要是动态分区加分区级的冷热策略，配几个参数就完事，心智负担确实轻，但表达力就是不如 CK，列 TTL 和降采样都没有对等的机制。

### 权限

两边都是 RBAC，模型大同小异，差别在细节。Doris 照着 MySQL 设计，用户是 `username@'host'`，天然带白名单，行级权限是查询时自动追加谓词（不能给 root 和 admin 设），列级权限也有。CK 是一套完整的 SQL 驱动的 RBAC，users、roles、row policies、quotas、settings profiles 五个维度。

CK 的 ROW POLICY 有两个必须知道的限制。一是只在只读访问下才有意义，用户能改表、能在表之间复制分区，就能绕过行策略，所以它是给只读分析师用的，不是给能写数据的开发用的。二是 Distributed 表上不生效，行策略只在本地读表时起作用，得在每台服务器的本地表上分别定义，集群一大就是运维灾难。另外 CK 默认没有策略就能看全部行，要做默认拒绝得用 permissive/restrictive 组合，不太直观。好在 `system.row_policies` 能看到所有生效的策略，审计时很方便。

整体上打平。CK 的 quota 和 settings profile 更细；Doris 的 MySQL 心智和 host 白名单更亲民，也没有 Distributed 表那个坑。

### 数据安全

除了漏洞扫描，安全合规还管脱敏、审计和留痕，这些数据库层面的能力 Doris 准备得更完整。

Doris 有原生的动态数据脱敏，可以把信用卡号、身份证号部分或全部替换成星号，原始数据不动，脱敏发生在返回结果的路上。CK 没有，只能自己用视图或者 UDF 包一层，再靠权限不让人直接访问底表，能用，但维护成本高，只要有一个地方忘了套视图，敏感数据就裸奔了。

审计日志，Doris 有基于 FE 插件框架的审计插件，把审计日志定期导进指定的 Doris 集群，直接用 SQL 分析，查起来跟查业务表一样。CK 靠 `system.query_log`，信息其实非常全，谁、什么时候、跑了什么 SQL、读了多少行、用了多少内存，但它就是一张普通的系统表，默认 TTL 有限，长期审计得自己配持久化和归档。

这和前面的漏洞扫描正好反过来：CK 在依赖扫描上占了实现语言的便宜，在合规功能的内建程度上又得靠外部方案补。

### 交互体验

Doris 兼容 MySQL 协议，这带来的接入成本差异常常被低估。所有 MySQL 客户端直接能连，Navicat、DBeaver、命令行的 `mysql`；所有 BI 工具直接能接，Tableau、Superset、帆软、Quick BI；所有语言的 MySQL 驱动和 ORM 直接能用。运维排查问题，一句 `mysql -h host -P 9030 -u root` 就进去了。要在公司里大范围推广，业务方的 BI 工程师不用学新语法，存量报表也不用改造，这部分成本很难体现在跑分里，但真推起来往往占大头。

CK 用自己的 SQL 方言和协议，虽然也有 `mysql_port`，但兼容范围有限，不少 BI 工具缺原生支持。`ARRAY JOIN`、`-If`/`-Array`/`-State` 组合子这些语法很有表现力，可学习和迁移成本也得算进去。CK 的补偿是 `clickhouse-client` 本身极其好用，实时进度条、几十种输出格式、多行编辑、语法高亮，用惯了再用 `mysql` 客户端，感觉像回到了石器时代。

执行计划也是这个味道。CK 的 EXPLAIN 家族信息量极大，`EXPLAIN PLAN` 看逻辑计划，`EXPLAIN PIPELINE` 看每个算子几路并行，`EXPLAIN ESTIMATE` 预估读多少 part 和 mark，`EXPLAIN indexes=1` 看主键和跳数索引各裁掉了多少 granule。再配上 `SET send_logs_level='trace'`，执行过程每一步都打到客户端。调优时信息密度极高，但门槛也高，看不懂 granule、mark、part 的关系，这些输出就是天书。Doris 的 EXPLAIN 和 Query Profile 更结构化，有 Web UI，各阶段耗时、行数、内存一目了然，还能看到 CBO 估算和实际值的偏差，看懂的门槛低得多。CK 的信息更全，Doris 的更好懂。

### 系统表

这是 CK 最容易被低估的一项。它几乎把所有内部状态都做成了能用 SQL 查的系统表：`query_log` 记每条查询，`processes` 看正在跑的，`parts` 看每个 part 的行数和压缩前后大小，`part_log` 记 part 的每一次创建、合并、下载、删除，`columns` 能看每一列的压缩比，`merges`、`mutations`、`replication_queue` 看后台任务，`metrics`、`events`、`asynchronous_metrics` 是各类指标，`errors` 是各类错误的累计次数，`text_log` 能用 SQL 查服务端日志，连 `system.numbers` 这种造数据的都有。

好处是你不需要任何外部工具就能把 CK 自己查明白。想知道哪张表压缩比最差，查 `system.columns`；merge 为什么跟不上，查 `system.merges` 和 `system.part_log`；昨天哪条 SQL 把内存打爆了，查 `system.query_log` 按 `memory_usage` 排。我前面写的好几篇排障文章，靠的基本都是这几张表。ckman 的原生监控也是直接读这些系统表实现的，一行埋点都不用加。

Doris 这边是 `information_schema` 加 `SHOW PROC '/...'`，够用，但覆盖面和信息密度差着量级，`SHOW PROC` 的输出是给人看的，不方便用 SQL 再加工。

## 生态

### ckman 和 Doris Manager

两家都有集群管理工具，出身完全不同。

[ckman](https://github.com/housepower/ckman) 是我参与开发的开源项目，前端 Vue，后端 Go。部署、滚动升级、启停、节点增删，分布式表、分区、TTL、物化视图管理，定时备份，三级 RBAC，多实例加 Nacos 选主做高可用，原生直读系统表的监控，还有前面说的逻辑集群，Web 和 API 两个通道都能用。

Doris Manager（现在叫 Cluster Manager for Apache Doris）由 SelectDB 出品，能力也很全面，部署接管集群、扩缩容、升级、监控告警、参数配置、日志查看、巡检，24.0 改成了 server-agent 架构，不再依赖 SSH 互信。但它是闭源的商业产品。SelectDB 宣布过免费开放，下载入口在企业版下载页面，可免费不等于开源，源码至今没有公开。

这就有意思了。Doris 的开源协议更开放，存算分离、倒排索引、实时更新这些核心特性也都在开源版里，这一点 CK 不如它。可到了运维工具这一层，情况反了过来：CK 的管理工具是社区补的，Doris 的管理工具是厂商卖的。想要一个趁手的 Doris 集群管理工具，要么用 SelectDB 给的闭源二进制，要么自己写；CK 这边，社区已经给了好几个能用的开源方案。选型时值得先问自己一句：你在意的到底是内核开源，还是整套方案开源。

### SDK 和驱动

Doris 在这一层直接复用了 MySQL 驱动。任何语言、任何框架，能连 MySQL 就能连 Doris，Java 用 `mysql-connector-java`，Go 用 `go-sql-driver/mysql`，Python 用 `PyMySQL`，不需要任何 Doris 专属的 SDK，ORM 也直接能用。另外还有 Flink/Spark Connector 和 Arrow Flight SQL，大批量拉数据比 MySQL 协议快很多。

CK 全是自己造的轮子：`clickhouse-go`、`clickhouse-jdbc`、`clickhouse-connect`、`clickhouse-cpp`、`clickhouse-rs`，官方维护，质量都不错。走 Native 协议性能明显好于 HTTP，支持列式批量写入、异步插入、查询进度回调，批量写入的吞吐很能打，clickhouse_sinker 就是基于 clickhouse-go 写的。但冷门语言基本没有官方支持。

### 二次开发

回到开头说的那个戏剧性：基于 CK 魔改的二开版本数不胜数，Doris 几乎没有。字节的 ByteHouse，阿里云、腾讯云、华为云各自的托管版，Altinity 的企业版，嵌入式的 chdb，再加上数不清的没对外发布的企业内部版本。

CK 为什么这么容易二开？单体 C++，一个二进制跑起来就是完整的数据库，改哪编哪都很直接；表引擎、函数、格式、磁盘都是插件化注册的，加一个自己的实现不用动核心；Apache 2.0 加上社区治理约束弱，想改就改，想发就发。Doris 是 FE(Java) + BE(C++) 双语言架构，一个功能往往要同时动两边，还要处理中间的 Thrift 接口，改起来成本高得多；ASF 的治理框架下，社区也更倾向把改动贡献回主干。唯一分出去的 StarRocks，那是分裂，不是二开，而且分完之后两家闹得水火不容。

被大量二开，至少说明代码结构清晰到别人改得动。但对使用方来说是两面的：A 云上的 CK 和 B 云上的 CK 行为可能不一样，社区经验未必适用于手上的魔改版，出了问题上游也难介入。对需要私有化交付、深度定制的厂商来说，CK 的可改造性是实打实的价值。

### 可观测生态

Doris 在可观测这块的能力是「支持被监控」：FE 和 BE 各自暴露 Prometheus endpoint，官方给 Grafana Dashboard 模板，中规中矩。CK 当然也有这些，内置 Prometheus endpoint，有官方的 Grafana 数据源插件。

但 CK 更重要的身份，是可观测生态的后端存储。CK 官方的 ClickStack，开源 APM SigNoz、Uptrace，被 CK 收购的 HyperDX，还有 Highlight.io、Coroot，都把 CK 选作存储引擎。云杉网络的 Deepflow 2021 年起就用 CK 替代了 InfluxDB 和 ES，收敛日志、指标、追踪三种数据。自建的大规模案例也不少：Tesla 用 CK 搭了代号 Comet 的可观测平台替换 Prometheus，为了不重写存量的 dashboard 和告警，自研了 PromQL 到 SQL 的转译层；Anthropic 在 Claude 3.5 之后可观测系统被写入量压垮，最后迁到了气隙部署的 ClickHouse。

撑起这个地位的，正是前面讲的系统表、压缩比、聚合性能和 TTL 降采样，每一样都是可观测场景的刚需。所以人们聊可观测时，拿来跟 CK 比的往往是 VictoriaMetrics，而不是 Doris。Doris 也开始在可观测上发力，日志检索做得相对完善（倒排索引加 VARIANT），指标和 trace 还有很长的路要走。

### 云原生

K8s 这块两边都有 operator。CK 这边 Altinity 的 [clickhouse-operator](https://github.com/Altinity/clickhouse-operator) 是事实标准，用了很多年，集群定义、配置管理、滚动升级、PVC 管理、Keeper 集成都很完备。Doris 社区的 doris-operator 起步晚一些，基本能力都有。

但长期看可能是反过来的。CK 开源版是存算一体，节点有状态，上了 K8s，Pod 的弹性伸缩受限于 PVC 和数据分布，扩容还是绕不开前面说的数据均衡难题，K8s 能帮的主要是部署编排。Doris 3.0 存算分离以后 BE 是无状态的，计算节点随起随停，正适合 K8s 的弹性伸缩。现在就要上 K8s，CK 的 operator 更成熟；规划未来几年的部署形态，Doris 的架构更对路。

### 商业支持

商业支持不算内核能力，但在国内 ToB 项目里往往占很高的权重。

ClickHouse Inc. 的势头很猛：2025 年 5 月 C 轮 3.5 亿美元，估值 63.5 亿；2026 年 1 月 D 轮 4 亿美元，估值 150 亿美元，不到一年翻了一倍多；Cloud 客户超过 3000 家，同期还收购了 Langfuse。不过也有冷静的声音，CB Insights 记录 CK 2025 年营收 8800 万美元，对应 150 亿的估值，这个倍数显然是被 AI 叙事推上去的。SelectDB/VeloDB 那边没看到公开的新一轮融资。

可对国内用户来说，融资和估值转化不成本地支持。CK 官方对国内客户的支持相对较弱，中文文档滞后，社区提 issue 响应看运气，商务上主推的 Cloud 在国内又基本用不了，真出了问题，你能依靠的是社区、云厂商，或者专门的技术支持团队。SelectDB 是国内公司，中文支持、驻场、定制开发、7×24 响应都更容易落地，政企、金融这些需要强技术支持的行业尤其看重这个。

还有一个风险得提一句。150 亿美元的估值，对应的是投资人对 Cloud 收入曲线的预期，不是开源社区的活跃度。SharedMergeTree 没进开源版已经是事实，以后还会有哪些能力被划进 Cloud，谁也说不准。如果你的方案强依赖开源版的长期演进，这一点要算进去。

### 其他开源组件

两边周边的长法很不一样。CK 这边大多是社区自发的：我写的 clickhouse_sinker 和 ckman，嵌入式的 chdb，官方的 clickhouse-local，clickhouse-backup，Altinity 全家桶。Doris 那边以官方规划为主：Flink/Spark Connector，DataX、SeaTunnel 插件，ccr-syncer，doris-streamloader。CK 的周边杂乱，但覆盖长尾，你遇到的奇怪需求很可能已经有人写过工具；Doris 的周边整齐规范，但有缺口，缺的只能等排期。这和二开那件事是同一个逻辑。

## 一份过时说法的清单

写这篇的时候，我核实了很多流传很广的说法，发现相当一部分已经不成立了，包括我自己以前的一些认知。技术选型最怕的就是拿三年前的结论做今天的决策：

| 流传的说法 | 现在的情况 |
| --- | --- |
| CK 不支持全文检索 | 26.2 已 GA，但只算半个：没有 BM25，模糊匹配用不上索引，GA 后还在频繁改名 |
| CK 不擅长 JSON | JSON 类型 25.3 已 GA，纯列式实现，JSONBench 默认配置下排第一 |
| CK 没有资源隔离 | 25.4 引入 CPU slot 调度，层级 workload 模型表达力比 Doris 强 |
| CK 依赖 ZooKeeper，运维负担重 | ClickHouse Keeper 自 21.x 起逐步取代，24.x 后基本不用再部署 ZK |
| CK 大表 JOIN 不行 | 24.7 起持续优化 parallel hash join，25.7 趋于稳定 |
| runtime filter 是 Doris 独有的 | CK 25.10 引入，2026 年 2 月起默认开启 |
| CK 开 ZSTD 必然 too many parts | 源自单一迁移案例，根因是 merge 跟不上写入，不是压缩算法 |
| Doris 写入不需要攒批 | rowset 相当于 part，高频微批一样撞版本数限制 |
| Doris 的 CCR 开箱即用 | 每个 job 要预留 4GB 以上 FE 堆内存，binlog 要手动限，tmp partition 会中断同步 |
| CK 的物化视图就是预计算缓存 | 增量 MV 按写入块触发，能做流式转换、持久化聚合状态 |

这份清单本身也会过时。最靠谱的还是拿自己的数据测，其次是看两家的 release note 和源码，而不是看两年前的对比文章，包括这一篇。

## 我推 ClickHouse

一项一项比下来，Doris 和 ClickHouse 之争，有点像自动挡新能源和手动挡性能跑车之间的较量。Doris 秉承着中国人中庸的思想，什么都想做，什么都是中上等，不冒尖，也没有特别明显的短板，上限不顶尖，下限也不低。CK 是手动挡跑车，会调教的人觉得强得离谱，不会用的人甚至觉得不如 MySQL。它是典型的偏科生，擅长的领域一骑绝尘，短板的地方又拉胯得让人没法直视。

那到底选哪个？如果问我，我推 ClickHouse。

我是做 ClickHouse 的，这个结论可能不让人意外，但它不全是屁股决定脑袋。理由一半在前面的对比里：聚合查询、压缩比、增量物化视图、TTL 和降采样、系统表，这些是分析和可观测场景天天要用的东西，CK 都是明确领先的那一方。而 CK 的那些短板，并发、更新、扩容、跨机房，很多场景其实碰不到，碰到了也有成熟的绕法。

另一半理由是我熟它。这么多年下来，CK 的坑我基本都踩过一遍，知道它在哪里会塌，塌了怎么兜：并发不够就降 `max_threads`、单分片横向加节点；扩容搬不动数据就用权重倾斜，或者 ckman 去搬；写入扛不住就在 sinker 那一层攒批。一个我知道边界在哪的数据库，用起来比一个看起来什么都好、但边界在哪我还摸不清的数据库心里踏实得多。Doris 有些地方看起来确实很强，这个我不否认，但也可能只是我用得不深，很多坑还没碰到。

推 CK 不等于无脑上 CK。下面这几种情况，我会直接让人选 Doris：

- 对信创有非常严格的要求，无脑入 Doris 就对了
- 业务里有高频更新、CDC 入库，或者需要唯一键约束
- 几百人同时看报表，还要对接一堆存量 BI 工具和 MySQL 工具链，在公司里大范围推广
- 必须私有化部署存算分离
- 集群要频繁扩缩容，又没有专门的人去管分片和数据均衡
- 要拿它当 ES 用，做真正的全文检索
- 强合规场景，需要原生的数据脱敏和 SQL 化审计

如果你的业务刚好卡在两者中间，那就别看我的结论，也别看厂商的，拿自己的数据、自己的查询、自己的故障场景做一轮 POC。

---

**相关**：[日志检索三家实测](/clickhouse/comparison/log-search-ck-doris-es) · [存算分离横评：谁真的做到了](/clickhouse/comparison/storage-compute-separation) · [扩容之后为什么不自动做数据均衡](/clickhouse/tooling/why-not-auto-rebalance)
