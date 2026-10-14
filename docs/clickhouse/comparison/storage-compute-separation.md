---
title: 存算分离横评：谁真的做到了
---

# 存算分离横评：谁真的做到了

这是 OpenObserve 系列的第三篇，前两篇是 [源码深挖](/clickhouse/comparison/openobserve-internals) 和 [压测实录](/clickhouse/comparison/openobserve-benchmark)。

起因是一个很具体的问题。O2 最大的卖点是数据直接进 S3、天然存算分离，那 ClickHouse 能不能也这么干？顺着这条线查下去，答案比我想的复杂得多，还把另外几家也牵了出来。最后量了五个：ClickHouse、OpenObserve、Doris、GreptimeDB，外加 CK 内核的开源旁支 ByConity。

结论尽量来自官方文档原句、源码、GitHub 上的 PR 和 issue，或者几个来源交叉对得上的。厂商自己测的性能数字一律单独标出来，不进主对比表。查不到的就写「未找到证据」，这跟「不支持」不是一个意思，只是没有公开信息可查。

## 什么才算存算分离

这个词被用得太滥了。数据能放 S3，和存算分离是两回事，中间隔着一整套架构改造。我用三条判据，所有系统用同一把尺子量：

| 判据 | 含义 | 不满足会怎样 |
|---|---|---|
| 计算无状态 | 计算节点本地不持有唯一数据副本，宕机不丢数据、重启不需恢复 | 节点故障要等数据恢复；扩容要搬数据 |
| 共享一份存储 | N 个计算节点共享同一份物理数据，而非各存一份 | 3 副本就是 3 份存储成本，S3 只是换了个便宜介质 |
| 独立扩缩 | 计算和存储可以各自独立扩缩容 | 想加算力就得加存储，反之亦然 |

三条全中才叫存算分离。只满足第二条、不满足第一条的，那只能叫把数据放在了对象存储上，后面会反复碰到这个区别。

用这把尺子量下来是这样：

| | 计算无状态 | 共享一份存储 | 独立扩缩 | 开源协议 | 成熟度 |
|---|---|---|---|---|---|
| OpenObserve | 部分：Querier 是，Ingester 不是 | 是 | 是 | AGPL-3.0 | 生产在跑 |
| ClickHouse 开源 | 否 | 否 | 否 | Apache-2.0 | 只做到了存储在 S3 |
| ClickHouse Cloud | 是 | 是 | 是 | 闭源 | GA |
| ByConity（CK 内核） | 是 | 是 | 是 | Apache-2.0 | GA，但公开仓库近一年多低活跃 |
| Apache Doris 3.0+ | 是 | 是 | 是 | Apache-2.0 | 3.0（2024-10）起 |
| GreptimeDB | 部分 | 是 | 是 | Apache-2.0 | 1.0 GA（2026-04-14） |

表里有一格得先拎出来说：OpenObserve 是 AGPL-3.0，不是 Apache-2.0。

```
GitHub API → openobserve/openobserve → 「spdx_id」: 「AGPL-3.0」
Cargo.toml → license = 「AGPL-3.0」   (v0.93.0)
```

GreptimeDB、Doris、ClickHouse 都是 Apache-2.0，只有 O2 用 AGPL。AGPL 要求你修改了它、又通过网络对外提供服务的话，衍生作品得以同样的协议开源。打算把 O2 嵌进对外售卖的产品里，这是个法务问题，得在评估性能之前就先过掉，性能再好也救不了。

## 挨个看

### ClickHouse：六条路，只有闭源那条走通了

ClickHouse 把数据放到 S3 上的办法不止一种，可 ClickHouse 自己没有哪种开源方案能同时满足三条判据（CK 内核的开源旁支 ByConity 是另一回事，后面单说）：

| 方案 | 计算无状态 | 共享一份 | 独立扩缩 | 结论 |
|---|---|---|---|---|
| MergeTree + `disk = s3`（默认本地元数据） | 否，元数据在本地 | 否，N 副本 N 份 | 否 | 不是分离，只是存储在 S3 |
| ＋ zero-copy replication | 否 | 是 | 部分 | 官方标注 not ready for production |
| `s3_plain_rewritable` | 是，元数据也在 S3 | — | — | 只做到一半，不支持 replication |
| SharedMergeTree | 是 | 是 | 是 | 唯一 GA 的，闭源，仅 Cloud/BYOC |
| Altinity Antalya | 是 | 是 | 是 | 架构对，Apache-2.0，非 GA |
| 读 Iceberg / Delta Lake | 是 | 是 | 是 | 读已经成熟；写还是 experimental |

有三条硬证据，都不是营销材料。ClickHouse 官方的 S3 存储指南最后直接写着「we recommend using ClickHouse Cloud」。维护者 alesapin 在清理 zero-copy replication 代码的 PR #82508 里说「nobody supports this code」。Altinity 的创始人在 issue #54644 里说 SharedMergeTree「is not going to be released in open source」。

顺带一个容易被忽略的事实：ClickHouse 现在连 WAL 都没有了。MergeTree 的 in-memory parts 和配套的 WAL 在 24.2 被彻底删掉（23.5 起标记 obsolete），`in_memory_parts_enable_wal` 现在的文档说明是「Obsolete setting, does nothing.」。源码里 `fsync_after_insert` 和 `fsync_part_directory` 默认也都是 `false`：

```cpp
// src/Storages/MergeTree/MergeTreeSettings.cpp
DECLARE(Bool, fsync_after_insert, false, ...)
DECLARE(Bool, fsync_part_directory, false, ...)
```

所以 CK 写入的可靠性不靠落盘，靠多副本。默认 INSERT 只要一个副本确认就返回，要更强的保证得开 `insert_quorum`。官方对丢数据窗口的说法是，数据只写到一个副本、这个副本所在的机器随后没了，数据就丢了，没给具体的时间窗口。

扩缩容是 CK 最痛的地方，不只是繁琐。官方文档原话：

> 「ClickHouse doesn't support automatic shard rebalancing」

分片是静态的，写入时按分片键路由，新加的节点不会自动分到任何存量数据。官方给的人工办法只有三种：调分片权重、detach-attach 分区、`INSERT INTO SELECT` 全量重新导一遍（官方自己都说「won't be performant on very large datasets」）。核心开发者提的原生 resharding RFC（issue #45766）到现在还是 open。

操作层面倒是有解，就是 ckman。ckman 是我写的，所以它的短处下面我照样写清楚。

[ckman](https://github.com/housepower/ckman)（Apache-2.0，v4.0.0 / 2026-05-22）把原来要手写脚本的分片搬迁封装成了一个任务。源码 `service/clickhouse/rebalance/` 里有两种策略：

| 策略 | 适用 | 实现 | 代价 |
|---|---|---|---|
| ByPartition | 副本表 | ZK 元数据级 `ALTER TABLE ... FETCH PARTITION` + `ATTACH PARTITION` + `DROP PARTITION` | 低，不搬物理文件 |
| ByPartition | 非副本表 | `DETACH PARTITION` → rsync 拷贝 → `ATTACH PARTITION` | 受网络/磁盘 I/O 限制 |
| ByShardingKey | 数据未按原生分片规则写入 | 建临时表 → `MOVE PARTITION ... TO TABLE` → 各节点并行 `INSERT INTO ... SELECT` 按哈希写回 | 高 |

v4.0.0 抽出了 `Strategy` 接口，`Plan()` 提供只读的预览（「It must not mutate cluster data」）；贪心算法只在 `max >= min + 2*size` 时才搬分区，并且跳过最新的分区，避开还在写入的数据。

可它并没有让 ClickHouse 有了自动均衡的能力，局限有四条。`AddNode` 和 `RebalanceCluster` 是两个独立的操作，都得人去点，加了节点不会自动均衡，ClickHouse 内核不会自动 rebalance 这件事没变，变的只是操作成本。DETACH/ATTACH 那条路没有内建的数据校验，issue #82（2021-05-20 提的）「rebalance 是不是可以加一下数据校验，因为 attach 和 detach 的过程可能出错」到现在还 open。ByShardingKey 有一个一致性窗口，`MOVE PARTITION ... TO TABLE` 会先把原表搬空到临时表再回填，这期间查原表可能读到不完整的数据，源码里没看到写锁。另外它纳管不了 K8s 上的 ClickHouse，ckman 的部署模型是 SSH 到裸机或虚拟机上生成配置、启停进程，跟 Operator 部署的 StatefulSet 合不到一起（README 里说的 Kubernetes，是指 ckman 自己能跑在 K8s 里，不是能纳管）。

所以准确地说，CK 的扩缩容还是做不到自动均衡，有了 ckman，成本从手写高风险脚本降到了点一下就能跑的半自动任务，比原生支持自动 rebalance 的系统仍然要高。

### OpenObserve：做到了，代价在别处

O2 是这几家里架构最简单的，单二进制、零建模、数据直接进对象存储。三条判据基本满足，但要打两处折扣。

第一处，Ingester 并不是无状态的。README 里写的是「stateless architecture」，可官方架构文档里逐个节点列属性的那张表写得很老实，Ingester 那一栏是：

> Stateless: Yes (buffers in WAL, Memtable, and local parquet)

也就是说 Querier、Compactor、Router 扩容确实不用搬数据，但一个正在写 WAL、还没 flush 的 Ingester 被强杀，是有丢数据窗口的。

第二处更严重，WAL 的 fsync 默认是关的：

```rust
// src/config/src/config.rs:1159
#[env_config(name = "ZO_WAL_FSYNC_DISABLED", default = true)]
pub wal_fsync_disabled: bool,
```

```rust
// src/wal/src/writer.rs:173-187
pub fn sync(&mut self) -> Result<()> {
    if self.synced { return Ok(()); }
    self.f.flush()?;                                   // 只到 OS page cache
    if !config::get_config().common.wal_fsync_disabled {
        self.f.get_ref().sync_data()?;                 // 真 fsync，默认不执行
    }
}
```

而且这是主动改的。PR #7092（commit `b58dbda`，2025-06-10）把默认值从 `false` 改成了 `true`，算在一组性能优化里。O2 在 2025 年 6 月拿持久性换了写入速度。

再叠上一条：开源版的 ingester 不做数据复制。源码里搜 `replica`，只有协调用的 `ZO_NATS_REPLICAS` 和去重标签用的 `ZO_PROMETHEUS_HA_REPLICA`，跟业务数据都没关系；官方架构文档原话是「no ongoing data replication to manage」。这样 O2 的持久性就全押在两件事上：本地的 WAL/PVC 能活到上传完成，以及对象存储自己的持久性。

官方博客是这么说的：

> 「Even if a disk crashes, at most ten minutes of data might be lost, depending on `ZO_MAX_FILE_RETENTION_TIME`.」

跟源码对得上（`ZO_MAX_FILE_RETENTION_TIME` 默认 600 秒）。但官方只讨论了进程崩溃磁盘还在、物理磁盘损坏这两种情况，fsync 默认关着的时候直接断电会怎样，没提。这部分是我从源码机制推出来的，不是官方说法。

还有个没有任何文档提示的部署差异。官方 Helm chart 的 `values.yaml` 里显式写了 `ZO_WAL_FSYNC_DISABLED: "false"`，也就是用 Helm 装会把 fsync 重新打开，直接跑 Docker 或二进制则是关着的，同一个产品两种装法，持久性保证就不一样。

### Apache Doris：存算分离、真开源、已落地、还在活跃维护，只有它全占了

Doris 3.0（2024-10）引入的存算分离是这几家里最完整的：FE（元数据和规划）+ 无状态的 BE（计算）+ 无状态的 Meta Service + FoundationDB（元数据）+ 共享存储。

官方原话：

> 「the BE nodes are stateless... Multiple compute clusters share a single set of data」

存算分离模式下，官方示例直接建单副本表 `"replication_num" = "1"`，挂上 `storage_vault_name`，靠对象存储自己的冗余。官方的说法是「by storing the data in shared storage, Doris no longer needs to handle the complex logic of multi-replica consistency」。

Doris 也是唯一给出冷查询量化基准的厂商（TPC-H/TPC-DS 1TB），这份数据很有价值：

| 缓存状态 | 相对存算一体的性能 |
|---|---|
| 全命中 | 无衰减 |
| 部分命中（官方称「best reflects real-world usage」） | 约 10% 开销 |
| 零命中（清空缓存） | 约 35% 衰减 |

配套的容量建议是，file cache 大约要热查询数据量的 1.5 倍。

代价是运维复杂度，而且是硬性的。它强制依赖 FoundationDB，官方要求「at least three machines equipped with SSDs」组成双副本的 FDB 集群。Meta Service 生产上至少 3 个节点，FE Follower 要奇数个（「three FOLLOWERs are sufficient」）。官方明确说「storage solutions like JuiceFS should not be used」。FDB 扩容是手动流程，装新机器、拷配置、重启，之后「Data distribution will slowly reorganize」，要多久、有什么风险，官方没给数。

社区里的抱怨比官方文档具体。issue #51892 里，FDB backup 一上压力，RPC 延迟升到 1 秒左右，24 个并发的 routine load 调度间隔被拉长到 2 分钟左右，「causing severe jitter in the consumption of routine load」。doris-operator 的 issue #233 里，有用户说官方部署文档过时，照着装不起来，还直接质疑 FDB 的学习和维护成本太高，提议换成 Redis 这种更常见的东西。

### GreptimeDB：和 O2 几乎一个模子，但无状态要打折

两者像到值得单列一张表：

| | OpenObserve | GreptimeDB |
|---|---|---|
| 语言 | Rust | Rust |
| 存储格式 | Parquet on 对象存储 | Parquet on 对象存储 |
| 索引容器格式 | Puffin | Puffin |
| 全文索引 | Tantivy | Tantivy（+ 自研 Bloom 后端） |
| 定位 | logs/metrics/traces 统一 | logs/metrics/traces 统一 |
| 对象存储抽象 | — | OpenDAL |

可无状态这一条要打折，官方文档写得很直白：

> 「After a Datanode restarts, it must replay the WAL to restore the latest data, during which time the node remains unavailable.」

想接近真正的无状态，得开 Remote WAL（Kafka）。Region Failover 的前提是「Kafka WAL (Remote WAL) or Local WAL with `allow_region_failover_on_local_wal=true`」，而后面这个开关默认是 `false`，官方说明是「not recommended... may lead to data loss during failover」。

还有三个容易漏掉的细节。默认 `wal.sync_write=false`，`sync_period` 默认 10s，官方原话「may lose data when running host shutdown unexpectedly」，跟 O2 是同一类风险。Kafka Remote WAL 的 `replication_factor` 默认是 1，「用了 Kafka 所以更可靠」这个说法有个官方没明说的前提，副本数你得自己调大。WAL 模式也不能热切换，「you must tear down the entire cluster and perform a clean redeployment」，所有 PVC、对象存储目录和元数据存储都得清空。

另外，开源版没有 Remote Compaction，compaction 还是在 Datanode 本地做，这条直接影响存算分离的成色。2026 路线图 issue #7685 里这一项还没勾上，计划 v1.3（约 2026-08）production ready；2025 路线图 issue #5446 原本计划 v1.1（2025-08）交付，已经跳票一年多了。PR #4181 引入了 `RemoteJobScheduler` trait 的抽象，可描述里明说「Its implementation is in GreptimeDB Enterprise」；Helm chart `greptimedb-remote-compaction` 标的是「for GreptimeDB Enterprise」，也没有能公开拉取的镜像。

这意味着 GreptimeDB 做 compaction，得把对象存储上的数据下载回本地再合并，跟 O2 是同一个模式。压测篇里实测 O2 写完后 10 分钟内还有 1,417 次 GET 和 1,226 次 PUT，GreptimeDB 架构上没理由躲得过这笔开销。

实测也印证了（2026-07-22，4.5 亿行）。GreptimeDB 导入后 S3 抓包看到 12,898 GET + 8,700 PUT + 4,504 POST + 60 DELETE，有 GET 也有 DELETE，说明它确实在对象存储上做后台整理，下载、合并、删除，不是只管追加。导入完成后自动 compaction 只覆盖了很小一部分，3,546 个 L0 SST 只合出了 15 个 L1，要把历史文件重新组织好，必须手动触发 SWCS。两次 SWCS 一共花了 81 分钟，期间又产生了约 25,477 GET + 10,140 PUT + 7,416 DELETE。compaction 在本地做、对象存储付流量，实际就是这么个样子。

同一轮测试里还有个旁证，跟 O2 的 issue #13363 有关。那条让 O2 静默丢数据的高基数 Top-N 查询，GreptimeDB 返回的结果和 ClickHouse 一模一样，是对的。这就排除了数据本身有问题、或者 tokenizer 不同这两种可能。同样是 Rust + Parquet + Puffin + Tantivy，GreptimeDB 算对了，只有 O2 走 `TantivyOptimizeExec` 那条近似路径算错了，所以这是 O2 自己实现上的缺陷，不是这条技术路线的通病。

### ByConity：CK 内核里唯一开源做到存算分离的旁支

前面说 ClickHouse 自己没有开源方案做到存算分离。可要是把范围放宽到 CK 内核的衍生项目，就有一个反例得单独拎出来：字节跳动开源的 ByConity。它不是 ClickHouse 的某种部署方式，而是基于 ClickHouse 内核重写的一个独立云原生数仓，2023 年开源，技术路线参照 Snowflake 的论文，元数据和数据都做了存算分离。

拿同一把尺子量，三条全中，而且是真开源：

| 判据 | ByConity | 证据 |
|---|---|---|
| 计算无状态 | 是 | Server（接入/优化/调度）+ Worker（执行 plan segment、从 cloud storage 读数据），读写分离，Worker 无状态 |
| 共享一份存储 | 是 | HDFS 或 S3（+ GCS/Azure/OSS，统一 VFS 抽象）；数据文件存远端统一存储，与计算节点分离 |
| 独立扩缩 | 是 | 存算分离，扩容无需数据均衡，可快速弹性扩缩 |
| 开源协议 | Apache-2.0 | GitHub API `spdx_id`；未归档 |
| 血统 | CK 内核 | CNCHMergeTree 统一分布式表、ClickHouse 方言 |

所以 CK 内核想要开源的真存算分离，SharedMergeTree 并不是唯一出路，ByConity 是一条 Apache-2.0、支持 S3、兼容 ClickHouse 的现成的路。已经在用 CK、又想要存算分离和 S3 的团队，可以把它算进来。

但它有两个问题，得跟其他几家一样标清楚。

头一个是公开仓库的维护活跃度存疑。看 GitHub 提交历史，最近的提交（2026-06）基本是零碎改动，修 LRUCache 的拼写、更新 README，再往前直接跳到了 2025-02，也就是说近一年多公开仓库几乎没有实质开发。2,237 star，182 个 open issue。字节的商业精力放在了闭源的云版 ByteHouse（火山引擎）上，开源 ByConity 的社区投入看起来已经明显收缩了。对生产选型来说，上游停更比性能差更要命。

第二个是和 Doris 一样背着 FoundationDB 的包袱。ByConity 的元数据也存在 FoundationDB 里（catalog 层实现完整的 ACID），前面说 Doris 的那些 FDB 负担，3 台 SSD 起步、运维复杂、issue #51892 的抖动，ByConity 一样都继承了。社区里甚至有团队（烽火星空）自己改源码，用 RocksDB 替掉了 FDB，可见这笔负担是实打实的。整套系统也很重，Server + Worker + FoundationDB + Timestamp Oracle + Daemon Manager + Resource Manager + 共享存储 + 本地 DiskCache 二级缓存，离 O2 单二进制的简洁差得远，部署运维的复杂度跟 Doris 一个档次，甚至更高。

ByConity 的信创适配（麒麟、飞腾、龙芯这些）我没去查，所以后面信创那一节没把它放进去。它的 DiskCache 同样是把远端数据下载到本地加速，所以存算分离查询拼的是缓存命中率这一条，对它一样成立。

## 全表对比

几张大表里的标记统一一下：「厂商声称」是只在官方博客或厂商自测里出现、没有第三方复现的；「未找到证据」是没查到公开信息，不等于不支持；「未实测」是我们没有一手压测数据，也不拿厂商的数字去填。

### 架构与形态

| 维度 | OpenObserve | GreptimeDB | Doris 3.0+ | ClickHouse 开源 |
|---|---|---|---|---|
| 开源协议 | AGPL-3.0<br>美国 | Apache-2.0<br>中国 | Apache-2.0<br>ASF，中国主导 | Apache-2.0<br>俄裔美国 |
| 架构 | 分层，存算分离<br>组件对等 | 分层，存算分离<br>角色分明 | 存算一体<br>或存算分离 | 对等分片<br>非存算分离 |
| 存储形式 | 列式 Parquet | 列式 Parquet<br>宽表窄表并存 | 列式<br>宽表为主 | 列式<br>宽窄表动态适应 |
| 压缩算法 | 6 种可选<br>仅全局，不可逐列 | ZSTD level 1 硬编码<br>完全不可配 | 7 种可选<br>仅表级，不可逐列 | 6 种以上<br>可逐列，可组合 |
| 写入语义 | At-Least-Once | At-Least-Once | Exactly-Once | At-Least-Once |

几格的细节说明一下。组件上，OpenObserve 是 Router、Ingester、Querier、Compactor、AlertManager 几个对等组件；GreptimeDB 是 Frontend、Datanode、Metasrv，可选 Flownode，角色分得很清楚；Doris 存算分离模式是 FE 加无状态 BE 加 Meta Service 加 FoundationDB；ClickHouse 就是分片加副本。

写入语义上，OpenObserve 和 GreptimeDB 都是 At-Least-Once，靠 WAL 加定期刷盘；Doris 是 Exactly-Once，靠 Label 机制保证单次导入去重，前提是上游能做到 At-Least-Once；ClickHouse 是 At-Least-Once，`insert_quorum` 可以要求多副本确认。

压缩算法那一行值得展开。OpenObserve 由 `ZO_PARQUET_COMPRESSION` 控制，默认 zstd，可选 snappy、gzip、brotli、lz4、none，只能全局设；GreptimeDB 是 ZSTD level 1 硬编码；Doris 有 LZ4F、ZSTD、LZ4、Snappy、Zlib 等 7 种，只能在表级设；ClickHouse 有 LZ4、ZSTD、Delta、DoubleDelta、Gorilla、T64 等，自建默认 LZ4，可以逐列指定，还能 pipeline 组合。按能不能配、能配到多细，正好分三档：

```
可逐列配置        ClickHouse                    ← 唯一
仅表级配置        Doris、OpenObserve
完全不可配置      GreptimeDB                    ← 硬编码 ZSTD level 1
```

压测篇里那个核心发现就是从这儿来的：功能对等的条件下，CK 的数据列比 O2 小 33%。原因不是 CK 的压缩算法更强，两边都能用 ZSTD，而是 CK 能给每一列挑最合适的 codec 和编码，时间列用 Delta，低基数列用 LowCardinality，浮点列用 Gorilla，O2 只能一个 ZSTD 打天下。代码摆在这：

```rust
// OpenObserve — src/config/src/utils/parquet.rs → new_parquet_writer()
.set_compression(get_parquet_compression(compression))   // 无列名参数，全文件统一
.set_column_encoding(TIMESTAMP_COL_NAME.into(), Encoding::DELTA_BINARY_PACKED)
//   ↑ 唯一的"列级"处理是硬编码的 _timestamp 列，不是开放给用户的能力
```

```rust
// GreptimeDB — src/mito2/src/sst/parquet/writer.rs → maybe_init_writer()
.set_compression(Compression::ZSTD(ZstdLevel::default()))   // level 1，无任何配置入口
```

```sql
-- ClickHouse — 逐列绑定不同 codec
CREATE TABLE codec_example (
    dt           Date     CODEC(ZSTD),
    ts           DateTime CODEC(LZ4HC),
    float_value  Float32  CODEC(NONE),
    value        Float32  CODEC(Delta, ZSTD)      -- pipeline 组合
)
```

顺带纠正一个流传很广的说法。Doris 官方 CREATE-TABLE 文档写的默认压缩是 LZ4，可 branch-3.0 源码 `PropertyAnalyzer.analyzeCompressionType()` 里实际是 `return TCompressionType.LZ4F;`，文档和源码对不上（master 分支后来才改成可配置、默认 ZSTD）。

### 能力与性能

| 维度 | OpenObserve | GreptimeDB | Doris 3.0+ | ClickHouse 开源 |
|---|---|---|---|---|
| 压缩率 | 实测 219.78 GiB<br>（27.3 亿行，含索引） | SWCS 后 35.15 GiB<br>（4.5 亿子集）比 CK 大 37%<br>SWCS 使索引翻倍（+133%） | 未实测 | 实测 164.12 GiB<br>（同数据同索引语义，小 25%） |
| 写入效率 | 实测基准 1× | COPY 114,867 行/s<br>但读预生成 Parquet<br>非同协议，不可直接排名 | 未实测 | 实测约 18×（功能对等下） |
| 单表查询性能 | 热态中位 1.39×CK<br>正文子串快 CK 3.6 倍 | 跨度 26 倍：SWCS 前冷 15.68× CK（垫底）→ SWCS 后热赢 13/24（但 0 次 S3 请求） | 未实测 | 基准 1.00×<br>并发扩展显著更强 |
| 内存模型开销 | 写入实测 2.90 GiB（四家最省）<br>查询峰值 6.07 GiB | 查询 8 并发 RSS<br>峰值 21.8 GiB（最高） | 未找到证据 | 写入实测 10.46 GiB |
| 写入可靠性 | 默认低：`ZO_WAL_FSYNC_DISABLED=true`（PR #7092 主动改的）+ 开源版无数据副本；最坏丢 10 分钟。<br>Helm 部署会重新开启 fsync | 默认低：`wal.sync_write=false`，`sync_period=10s`；Kafka WAL 的 `replication_factor` 默认 1 | 较高：多数派写入 + 默认 3 副本；但存算分离模式官方示例用单副本，RPO 官方未披露 | 中：24.2 起 WAL 已彻底移除，`fsync_after_insert` 默认 false；可靠性来自 `insert_quorum` 多副本而非落盘 |
| SQL 标准 | 弱：DataFusion，官方无 ANSI 兼容声明；append-only，无行级 UPDATE/DELETE；Broadcast Join 是企业版专属 | 弱：官方原句「a subset of ANSI SQL」；明确「No ACID transactions」；JOIN 官方称「非重点」 | 强：完整 MPP SQL、9 类 JOIN、窗口函数；但不支持递归 CTE，隔离级别仅 READ COMMITTED | 强：官方称「mostly compatible with ANSI SQL」；支持递归 CTE；不支持相关子查询；多语句事务 experimental |
| 扩展能力 | 弱：无用户级 SQL UDF 注册（VRL 仅用于摄入管道）；联邦查询企业版专属；无原生 Kafka 摄入（issue #2882 挂了两年多） | 弱：无 UDF（Python coprocessor 已被 PR #5637 删除）；无 Kafka 数据源 connector | 强：Java UDF/UDAF/UDWF/UDTF + Remote UDF 多语言；13+ 种 Catalog 联邦查询；Trino Connector 插件框架 | 较强：Executable UDF（语言不限）/ SQL UDF / WASM UDF（实验）；丰富 integration engines；但无运行时插件系统 |

GreptimeDB 这几格是一手实测填的（2026-07-22，450,394,721 行的同数据子集），但它们算不上干净的引擎排名，原因下面细说。Doris 这几格还空着。素材里有它的官方数字，说比 ES 快 21 倍、性价比高 5 到 10 倍，可都是厂商自测，没有第三方复现，我不往表里放。要填 Doris，只能我们自己压。

还有一点：GreptimeDB 用的 4.5 亿行子集和 O2、CK 的 27.3 亿行全表差了 6 倍，表里 GreptimeDB 的压缩率只能跟同子集的 CK（25.69 GiB）比，不能跟全表的数字直接相减。

### GreptimeDB 的实测，别只抄一个数

GreptimeDB 的查询性能是一段跨了 26 倍的区间，给不出一个数。落在哪一头，看两件事：做没做过 SWCS compaction，缓存命没命中。

| 状态 | 24 场景合计耗时 | 相对 CK | 胜出场景 |
|---|---:|---:|---:|
| SWCS 前 · 冷 | 104.33 s | 15.68×（垫底） | 0 / 24 |
| SWCS 后 · 预热轮 | 120.72 s* | — | 1 / 24 |
| SWCS 后 · 热缓存 | 3.93 s | 快过 CK 的 5.70 s | 13 / 24 |

<small>* 预热轮被 P01 的 67.52 秒冷启动主导；去掉 P01 后其余 23 场景 53.21 s。</small>

同一个引擎、同一份数据，从比 CK 慢 15 倍、一场没赢，到总耗时比 CK 还短、赢了 13 场。这个跨度说明，GreptimeDB 在对象存储上的表现和 O2 一样，拼的是 compaction 之后的文件布局和缓存命中率，不是一个稳定的引擎能力值。

热态那个漂亮数字有个前提：热轮的抓包是个 24 字节的空 pcap，一次 S3 HTTP 请求都没有，数据全是本地缓存出的。所以 3.93 s 是 SWCS 加上本地缓存全命中的上限，不是每次都从 RustFS 读的常态。SWCS 前两轮冷查分别产生了 18,080 和 12,014 次 GET，真实生产落在两头之间，看你的缓存能装下多少热数据。

另外两条限制也得一起看。这是单节点 standalone，官方明确把这个模式定位成开发测试用的，代表不了分布式集群的上限。写入也不是同一个协议，GreptimeDB 的 COPY 读的是预先生成好的本地 Parquet（114,867 行/s），O2 走的是 JSON bulk（51,863），CK 是同集群的列式复制（930,965），三条路的开销差得天上地下，行吞吐没法直接排名。

不受这些状态影响、能带走的结论有三条。点查强，靠的是 tag/ID：Bloom skipping index 让 P01 8 并发跑到 57.69 QPS，逼近 CK 的 63.62；热轮里 P04 comment_id 点查 0.053 s，比 CK 的 0.102 s 还快，这是架构给的，稳定成立。对象存储上的聚合、扫描、深分页并发弱：SWCS 之后 8 并发也只有 0.13 到 0.17 QPS，CPU 平均 1.3 到 1.6 核就上不去了，瓶颈在 S3 I/O 等待，跟 O2 是同一类问题。存储比 CK 大，SWCS 之后更大：SWCS 前 33.29 GiB，之后 35.15 GiB，比 CK 的 25.69 大 37%；SWCS 让数据小了 0.84%，索引却从 1.60 涨到 3.73 GiB（+133%），总量反而多了 5.59%。这跟对 O2 的判断是一回事，Parquet 放对象存储这条路线，存储体积普遍打不过 CK 的列式编码（逐列 codec + LowCardinality + ORDER BY 聚类），O2 和 GreptimeDB 都比 CK 大，不是巧合。

SWCS 把热态的上限从垫底拉到了领先，同时也让索引体积翻了一倍，而且得手动触发：自动 compaction 只合出了 15 个 L1，3,546 个 L0 纹丝不动，两次 SWCS 一共 81 分钟。在 GreptimeDB 上导完数据直接查是个坑，官方文档也是叫你别这么干的。

### 成本与运维

| 维度 | OpenObserve | GreptimeDB | Doris 3.0+ | ClickHouse 开源 |
|---|---|---|---|---|
| S3 流量成本 | 实测有持续开销：停写后 10 分钟内仍有 1,417 GET + 1,226 PUT（compaction 下载-合并-上传） | 同类开销：开源版无 Remote Compaction，compaction 在 Datanode 本地做，必然回拉数据 | 未实测；官方提供 file cache 与流量控制参数 | 不适合 S3（无存算分离，S3 仅作冷存介质） |
| 扩缩容成本 | 低：NATS 自动注册发现；Querier/Compactor/Router 无需搬数据。但 Ingester 有状态，强杀有丢数据窗口 | 低：计算节点可独立扩缩 | 低：BE 无状态；但 FDB 扩容是手动流程且官方未量化耗时 | 较高：内核不支持自动 rebalance（RFC #45766 至今 open），新节点不自动获得存量数据。ckman 把分片搬迁封装成一键任务，成本从「手工脚本」降为「半自动」，仍非自动均衡 |
| 集群部署/运维复杂度 | 中：单二进制起步极简，但 HA 需 PostgreSQL + NATS + 对象存储 | 中：Frontend + Datanode + Metasrv + 元数据后端（etcd/MySQL/PG）（+ Kafka）。官方无统一的「生产最小拓扑表」，需跨多篇文档拼凑 | 最高：FE + BE + Meta Service + FoundationDB，各 3 台起；官方禁用 JuiceFS | 中：分片 + 副本 + ClickHouse Keeper。有成熟的开源管理工具（ckman）覆盖部署/滚动升级/启停/监控/备份/rebalance，但纳管不了 K8s 上的 CK |
| 外部依赖 | PostgreSQL（强制）+ NATS + 对象存储 | etcd / MySQL / PostgreSQL 三选一（官方已转向不推荐 etcd，PR #6127）+ 可选 Kafka | FoundationDB（强制，3+ SSD 机器） | ZooKeeper / ClickHouse Keeper |
| 信创适配度 | 全空白：ARM64 官方支持；国产 CPU/OS 零证据，`loongarch` 仓库检索 0 条，查不到任何国内商业支持方 | 弱：ARM64 支持；龙芯有明确反面证据（检索 0 条、CI 无该 target）；国产 CPU/OS 未找到证据；厂商声称过信通院验证但 CAICT 名录检索不到。国内主体：格睿科技（杭州） | 相对最强：官方 ARM 编译文档明确列出银河麒麟 Kylin-Server-10-SP1 + 飞腾 FT-2000+/64 已验证；3.0.3 起 ARM 支持存算分离。SelectDB 宣称的六方兼容互认证、信通院测评均无法在麒麟/统信/CAICT 官网交叉核实 | 内核有反面证据，生态有正面信号：内核侧 issue #19028（飞腾+麒麟 SIGABRT，2021 至今未修）、#89841（麒麟 ARM 崩溃，2025-11）；龙芯仅「实验性支持」无预编译包；无官方在华商业支持。管理侧 ckman 由国内团队维护，支持达梦 DM8 作元数据后端、提供 ARM64/aarch64 官方包，代码级可用，无信创专项 CI 或认证 |
| 适用场景 | 一体化开源可观测性平台；中小规模、资源受限、快速起步 | 云原生统一可观测数据库（metrics 强于 logs） | 功能完整的日志分析数据仓库；需要 JOIN / 更新 / 湖仓联邦 | 超大规模日志的实时分析引擎；查询性能与并发的天花板 |

## 存算分离不是免费的

存算分离最常见的推销话术是存储成本降多少多少。这话本身没错，可只算了一半的账，另一半是查询延迟、缓存容量和请求费用，哪一家都绕不开。

### 冷查询要慢多少

Doris 是唯一公开了冷查询衰减量化数据的厂商，正好拿来当基准线：

| | Doris 官方（TPC-H/DS 1TB） | OpenObserve（我们的实测，27.3 亿行） |
|---|---|---|
| 缓存全命中 | 无衰减 | — |
| 部分命中 | 约 10% 开销 | 热态中位 1.39× CK（即约 +39%） |
| 零命中 / 首次触达 | 约 35% 衰减 | 首次触达中位 4.28× CK（即 +328%） |

两组数字口径不一样，Doris 是相对自己的存算一体模式，我们是相对 ClickHouse，不能直接相减。但量级上的差距足够说明问题：Doris 把冷查询的代价控制在 35% 以内，O2 首次触达要付出好几倍。

O2 首次触达慢，跟调研篇里从源码得出的结论一致，冷路径要下载并解析 Parquet footer，还要预热 Tantivy 的 term，这是架构决定的，调参调不掉。

### 缓存是一笔隐藏的硬件预算

Doris 官方给的容量建议是个很实用的经验值：file cache 大约要热查询数据量的 1.5 倍。

言下之意，存算分离省下的存储成本，有一部分要以本地 SSD 缓存的形式再花回去。热数据 10 TB，计算节点就得配 15 TB 的本地缓存盘，这笔钱在「S3 比本地盘便宜多少倍」的宣传里是看不到的。

压测篇里看到的是同一件事的另一面：

```
O2 S3 查询：
  cache-bypass 首轮：  12,911 次 GET，1.269 GiB
  重复轮 / 热态 / 并发：      0 次 GET
```

除了第一轮，一次 S3 GET 都没发。那些看着还不错的 S3 查询数字，测的其实都是远端流加上本地文件缓存。O2 在对象存储上的查询性能，说白了就是拼缓存命中率，命中的时候能跟本地盘引擎打个平手，一掉到冷路径，4.28 倍的代价就又回来了。

### compaction 那笔账

存算分离并没有消灭 compaction，只是把它挪到了网络上。三家的 compaction 都得把数据从对象存储下载回来，合并，再传上去：

| | Remote Compaction | 实际做法 |
|---|---|---|
| OpenObserve | 无 | 实测：停写后 10 分钟内仍有 1,417 GET + 1,226 PUT |
| GreptimeDB | 开源版没有（Enterprise 专属） | compaction 在 Datanode 本地做，必然回拉数据 |
| Doris | 未实测 | 官方提供 file cache 与流量控制参数 |

压测篇的实测结论是，compaction 的代价不在拖慢写入（校正后净影响在 2% 以内），而在后台资源和 S3 请求数：compaction 期间 CPU 平均多了 29.7%，峰值冲到 8.73 核，S3 请求量翻倍。存储成本降多少的那笔账里，从来不算这一块。

## 信创与商业支持

这一块的结论方向跟前面的技术维度正好反过来，技术上最强的 ClickHouse 和 OpenObserve，在信创上恰恰最弱。

这也是全文证据最薄的部分，所以我卡得最严。厂商宣传的已通过某某认证，在认证机构官网上查不到对应收录页的，一律当厂商声称处理。

Doris 相对最强，而且有官方的硬证据。官方 ARM 编译文档里明确列出的已验证环境包括：

> KylinOS（银河麒麟）Kylin-Server-10-SP1 + 飞腾 FT-2000+/64

还注明了「Starting from version 3.0.3, the ARM platform supports compilation and deployment in compute-storage decoupled mode.」。但 SelectDB（飞轮科技）宣传的那部分核实不了，所谓通过中国信通院第 15 批可信数据库测评、与兆芯、飞腾、海光、统信、麒麟完成六方兼容互认证，在麒麟软件、统信软件官网的兼容列表和 CAICT 官网上都查不到对应的收录页面，只能算厂商声称。

GreptimeDB 偏弱，龙芯还有明确的反面证据。ARM64 是官方支持的（有 `linux-arm64`、`darwin-arm64`、`android-arm64` 构建）；龙芯方面，GitHub 搜 `loongarch`、`loong64` 返回 0 条，CI 的构建矩阵里也没有这个 target，这是反面证据，不只是没找到。鲲鹏、飞腾、海光、麒麟、统信全都没找到证据。格睿官网自称已经拿到信通院的可信数据库验证（2026-07），CAICT 的公开名录里查不到。网上还流传 GreptimeDB 已通过麒麟、统信认证的说法，我追了一下出处，其实来自 RustFS 项目，跟 GreptimeDB 没关系。信创信息里这种张冠李戴非常多，一定要核对原始出处。

ClickHouse 有明确的反面证据，是这几家里唯一在国产环境下有公开崩溃记录的。issue #19028（2021）是飞腾 FT2000+/64 + 麒麟 v10sp1 上 SIGABRT 崩溃，一直挂着 minor，没见明确修复；issue #89841（2025-11 提的，25.11.1.2141）是麒麟 ARM 上崩溃，我查的时候还没修。

不过这个崩溃的根因值得说清楚，它不是 bug，是构建目标对不上。ClickHouse 默认的 ARM 构建按 ARMv8.2 编译，依赖 LSE 原子指令（ARMv8.1 起强制）；飞腾 FT-2000+/64 是 ARMv8.0，没有 LSE，执行到相关指令就 SIGILL 或 SIGABRT。官方 CMake 里写得很清楚：

```cmake
// cmake/cpu_features.cmake
option (NO_ARMV81_OR_HIGHER "Disable ARMv8.1 or higher on Aarch64 for maximum
        compatibility with older/embedded hardware." 0)

if (NO_ARMV81_OR_HIGHER)
    set (COMPILER_FLAGS "${COMPILER_FLAGS} -march=armv8+crc")
else ()
    # ARMv8.2 ... 包含 LSE（ARMv8.1 起强制），提供显著加速
```

同一个文件里的报错信息甚至直接给了解法：

> `"The build machine does not satisfy the minimum CPU requirements, try to run cmake with -DNO_ARMV81_OR_HIGHER=1"`

官方也为此提供了 `aarch64v80compat` 的预编译产物。所以不是没办法，但代价得认：官方主线包在 ARMv8.0 的国产 CPU 上开箱即崩，要么自己带兼容参数重新编译，要么用兼容包，损失 LSE 带来的那部分性能。这也解释了为什么 #19028 挂了五年还是 minor，在官方看来是用户选错了构建目标，在国产化项目看来是默认那条路走不通，后者得额外花构建和验证的功夫。这方面我们自己踩过，详见 [ARM 上一跑就 SIGILL](/clickhouse/vendor/kylin-arm-instruction-baseline)。另外，龙芯官方文档明确标注是「实验性支持」，只给了交叉编译指南，没有预编译二进制；华为鲲鹏社区有生态文档，但实际上是引导你去下通用的 aarch64 RPM 包，不是专门优化的构建。

商业支持也得说清楚。我没查到 ClickHouse Inc. 在国内有分支机构或者官方授权的代理商。阿里云的云数据库 ClickHouse、腾讯云 TCHouse-C、火山引擎 ByteHouse，都是云厂商自研或者深度改造的产品，不等于 ClickHouse Inc. 的官方商业支持。

OpenObserve 是全空白。ARM64 官方支持，但国产 CPU、国产 OS、信创认证目录，全都零证据，仓库里搜 `loongarch` 0 条。也查不到任何国内的代理商、经销商或者商业支持方，官方支持渠道是它美国主体 OpenObserve Inc. 的境外联系页面。

所以项目要是有信创要求，基本就是这么个局面：

```
Doris        有官方验证的麒麟+飞腾组合，国内主体（飞轮科技）可采购支持
GreptimeDB   国内主体（格睿科技，杭州），但适配证据薄弱，龙芯明确不支持
ClickHouse   ARMv8.0 国产 CPU 上官方包开箱即崩，需自行编译兼容版本；
             无官方在华支持，但管理侧有国内维护的 ckman（DM8/ARM64）
OpenObserve  技术上可能可跑（ARM64），但零适配证据、零国内支持、且是 AGPL
```

ClickHouse 的国产 ARM 问题是个能解的构建问题，代价你事先就知道；OpenObserve 这边是信息完全空白，没人公开跑过，也没人公开支持过，连代价是多少都不知道。做信创项目，前者好办得多。AGPL、没有国内商业支持、零信创证据，这三条叠在一起，对有合规要求的项目，O2 可能在性能对比开始之前就已经出局了。

## 回到最初的问题

ClickHouse 能不能像 O2 那样数据直接进 S3、做存算分离？

ClickHouse 自己的开源版不能。它能把数据存在 S3 上，可那不是存算分离，元数据还在本地，N 个副本还是 N 份存储，计算和存储也没法各自扩缩。ClickHouse 官方产品里真正的存算分离只有 SharedMergeTree 一条路，而它闭源，只在 Cloud 和 BYOC 上提供，这是维护者和 Altinity 创始人公开说过的。

把范围放宽到 CK 内核的衍生项目，倒是有一条开源的路走通了，就是 ByConity。代价两条：公开仓库近一年多不怎么活跃，有上游停更的风险；和 Doris 一样背着 FoundationDB 的运维负担。

O2 的护城河，也不是存算分离本身。这个能力在 2026 年已经不稀缺了，Doris、GreptimeDB 都开源提供，CK 内核的 ByConity 也做到了，Altinity Antalya 在架构上跟 O2 几乎一个样。O2 真正独有的是存算分离加单二进制加零建模这个组合，Doris 要 FDB 起步，GreptimeDB 要 Metasrv、Datanode、Frontend 加元数据后端，只有 O2 能一个二进制就跑起来，还带着对象存储。可这个组合的代价，这篇加前两篇已经列得很清楚了：AGPL、默认关 fsync、开源版没有数据副本、不能逐列压缩、没有用户 UDF、联邦查询是企业版专属、冷查询 4.28 倍的代价、零信创证据。

## 我会怎么选

前面一直在回答谁做到了存算分离。这道题本身没问题，可它有个隐含的前提，就是存算分离本身是目标。我不这么看。

我是做 ClickHouse 的，[ckman](https://github.com/housepower/ckman) 是我写的，[clickhouse_sinker](https://github.com/housepower/clickhouse_sinker) 是我在维护，主要场景是金融和信创。上面对 CK 的结论我完全同意，ClickHouse 开源版确实没有真正的存算分离，六条路只有闭源那条走通了，这一点我不翻案。

可正因为在 CK 上待得够久，有件事我看得比较清楚：一个能力它没有，不代表这个需求解决不了。

把「我要存算分离」翻译回去，大多数团队真正想要的，是三件事里的一两件：冷数据要便宜，别再拿 NVMe 存一年前的日志；冷数据还得能查，合规回溯、偶尔排障，删不得；计算能独立扩缩，高峰扩、平时缩。这三件事里，只有最后一件是非存算分离不可的。

而在我接触的金融、信创项目里，第三件排在最后，甚至压根不在单子上。变更窗口都是提前排期排出来的，没人半夜做弹性扩容。天天被问的是前两件，而前两件用不着存算分离。

我的做法是把冷数据从 ClickHouse 里导出成 Parquet 放进 S3，再用 chDB 当独立的查询端。ClickHouse 本地盘只留最近 4 个月，TTL 按已导出的标记删。每天 cron 导一次，Hive 风格分区，按主过滤列排序，ZSTD 加 row group statistics。导出成功不是看 INSERT 有没有报错，而是行数核对和抽样比对都通过了，才回填 `exported_at`，才允许删分区。读的时候分三段路由，近 4 个月走 ClickHouse，更早的走 chDB，跨了分界线的查询在业务层拆成两段再合并。完整的落地方式、参数和脚手架在 [chDB + S3 Parquet：把冷数据变成可查询资产](/clickhouse/cold-storage/chdb)。

前两件事解决了，代价是一个导出任务。可这个代价我也得算全。它不是存算分离，第三件事它管不了，计算和存储还是不能各自扩缩，CK 该扩还得扩。它多了一条数据管道，cron、行数校验、抽样比对、标记回填，每一步都得能幂等重试，这条管道本身就要人维护。冷热边界得让业务感知到，跨分界线的查询要在业务层拆开再合，这是要改业务代码的。两套 schema 得一起演进，CK 改了列，导出管道和 chDB 那边的读取都得跟着改。MergeTree 的稀疏主键索引也没了，Parquet 只有 row group 级别的 min/max 和 bloom，跳读粒度比 granule 粗一个数量级。chDB 还是个独立进程，并发控制、内存上限、spill、查询取消、OOM 兜底，都得自己搭。

换成上 Doris，前两件事一样能解决，顺带把第三件也解决了，代价是 FoundationDB、FE、BE 一整套新的运维面，再加一批你还没学会的故障模式。为一个能力引进一整套组件，这个账要算全；反过来，为了省一套组件自己造一条管道，管道的维护成本也得算进去。

两边的账都摆出来，我的选择是这样的：

| 你的情况 | 我会选 |
|---|---|
| 冷数据要便宜 + 能查，负载平稳，团队养得起一条管道 | CK + Parquet + chDB |
| 同上，但没人维护管道 | S3 Disk，接受它的运维成本 |
| 冷数据一年查一两次，合规驱动 | BACKUP/RESTORE，别想着在线查 |
| 计算真的需要独立弹性扩缩 | Doris，别硬凑 |
| 有信创/合规要求，又非要存算分离 | Doris，它是唯一有官方验证的麒麟+飞腾组合，国内也买得到支持 |
| 已经在 CK 内核上，且能承担上游停更风险 | ByConity |
| 中小规模、快速起步、日志为主，能接受 AGPL | OpenObserve，单二进制、零建模，正文检索比 CK 快 3.6 倍 |
| metrics 为主，要 PromQL | GreptimeDB，原生 Rust 实现的 PromQL，但开源版没有 Remote Compaction，也没有 UDF |

我推 ClickHouse，理由一半是上面这些数据，CK 的查询并发（实测点查 7 倍线性扩展）和逐列 codec 带来的 25% 存储优势是实打实的；另一半是我熟它，知道它的短板在哪，也知道绕过去要花多少钱。Doris 这些年的存算分离做得确实漂亮，可它的坑我踩得远没有 CK 多，有些看起来强的地方，可能只是我用得不深，还没碰上。

什么时候我会改主意？第三件事变成了硬需求，比如日内负载有 10 倍以上的波动，或者要做按查询计费的多租户，自己搭的管道凑不出弹性，该上 Doris 就上。冷数据的查询从批量扫描变成了高并发点查，Parquet 的 row group 粒度扛不住，得是 MergeTree 的稀疏索引才行。SharedMergeTree 开源了，或者 ByConity 的上游重新活跃起来，前者概率不大，Altinity 创始人在 issue #54644 里已经把话说死了，后者值得一直盯着。还有一种情况，团队里没人能接手那条导出管道，技术上成立、组织上养不活的方案，就等于不成立。

## 附：出处

文中关键结论的出处：

| 结论 | 证据 |
|---|---|
| O2 是 AGPL-3.0 | GitHub API `spdx_id`；`Cargo.toml` `license = "AGPL-3.0"` |
| CK 存算分离只有闭源路（CK 官方产品内） | PR #82508（alesapin「nobody supports this code」）；issue #54644 |
| ByConity 是 CK 内核开源存算分离 | GitHub API `spdx_id=Apache-2.0`、未归档；官方架构文档（Server/Worker + HDFS/S3 + FoundationDB 元数据） |
| ByConity 公开仓库近一年多低活跃 | GitHub commits：最新提交（2026-06）为 typo/README，上一批实质提交回退至 2025-02 |
| ByConity 依赖 FoundationDB | 官方架构文档「metadata 基于 FoundationDB」；社区改用 RocksDB 的实践（烽火星空） |
| CK 不支持自动 rebalance | 官方文档原句；RFC issue #45766 仍 open |
| CK WAL 已移除 | 24.2 changelog；`in_memory_parts_enable_wal` 标注 obsolete |
| O2 默认关闭 fsync | `src/config/src/config.rs:1159`；PR #7092 / commit `b58dbda` |
| O2 不可逐列压缩 | `src/config/src/utils/parquet.rs` → `new_parquet_writer()` |
| GreptimeDB 压缩硬编码 | `src/mito2/src/sst/parquet/writer.rs` → `maybe_init_writer()` |
| GreptimeDB 无 Remote Compaction | issue #7685 / #5446；PR #4181；Helm chart 标注 |
| GreptimeDB 无 UDF | PR #5637「They were added for python feature, which is removed now.」 |
| Doris 默认压缩文档与源码不符 | `PropertyAnalyzer.analyzeCompressionType()` (branch-3.0) |
| Doris 不可逐列压缩 | issue #50631，2025-11-14 被 Stale 自动关闭 |
| Doris FDB 运维负担 | issue #51892；doris-operator issue #233 |
| CK 国产环境崩溃 | issue #19028（飞腾+麒麟）；issue #89841（麒麟 ARM） |
| ckman rebalance 两种策略 | `service/clickhouse/rebalance/{strategy,bypartition,byshardingkey,run,prereq}.go` |
| ckman rebalance 缺数据校验 | ckman issue #82（2021-05-20 提出，至今 open） |
| ckman 达梦 DM8 支持 | `repository/dm8/`；CHANGELOG v2.2.7「dm8 database adapt」 |
| ckman ARM64 支持 | CHANGELOG v2.2.4「adapted for arm64」；官方下载页三类产物 |

信创那一节里大量的「未找到证据」，如果正好落在你的关键决策点上，直接找厂商要测试报告。

---

**相关**：[OpenObserve 源码深挖](/clickhouse/comparison/openobserve-internals) · [OpenObserve 压测实录](/clickhouse/comparison/openobserve-benchmark) · [chDB + S3 Parquet](/clickhouse/cold-storage/chdb) · [2026 年 ClickHouse 和 Doris 怎么选](/clickhouse/comparison/clickhouse-vs-doris)
