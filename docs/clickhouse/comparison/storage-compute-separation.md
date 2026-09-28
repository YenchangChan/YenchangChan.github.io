---
title: 存算分离横评：谁真的做到了
---

# 存算分离横评：谁真的做到了

> 把「存算分离」当成一把尺子，量 ClickHouse、OpenObserve、Doris、GreptimeDB，外加 CK 内核的开源旁支 ByConity。结论来自官方原句、源码与 PR，厂商自测数字一律单列。
>
> **我的立场**：我是做 ClickHouse 的，§2.1 对 CK 的负面结论我同意。但我认为「要存算分离」这个需求本身值得重新翻译一遍 —— 完整论证和我会选什么在 [§七](#七、我的立场-这道题-也可以不做)。
>
> **阅读对象**：正在做可观测性或日志存储选型，尤其在意冷数据成本与弹性扩缩的团队。

---

本文是《拆解 OpenObserve 140x 压缩神话》系列的**第三篇**。前两篇：[调研篇](/clickhouse/comparison/openobserve-internals)、[压测篇](/clickhouse/comparison/openobserve-benchmark)。

<div class="note">

**证据标准**

起因是一个具体问题：O2 最大的卖点是「数据直入 S3、天然存算分离」，那 **ClickHouse 是不是也能做到？**顺着这条线查下去，答案比预期复杂得多，也牵出了另外三家。

**本文的证据标准**：结论来自官方文档原句、源码、GitHub PR/issue，或多源交叉验证。厂商自测的性能数字一律标注为「厂商声称」，不进主对比表。查不到的就写「未找到证据」——**「未找到证据」不等于「不支持」，只是没有公开信息可查**，这个区分在本文中始终保持。

</div>

---

## 一、先定义：什么叫「真·存算分离」

这个词被用得太滥了。「数据能放 S3」和「存算分离」是两回事，中间隔着一整套架构改造。本文用三条判据，四个系统都用同一把尺子量：

| 判据 | 含义 | 不满足会怎样 |
|---|---|---|
| **① 计算无状态** | 计算节点本地不持有唯一数据副本，宕机不丢数据、重启不需恢复 | 节点故障要等数据恢复；扩容要搬数据 |
| **② 共享一份存储** | N 个计算节点共享同一份物理数据，而非各存一份 | 3 副本就是 3 份存储成本，S3 只是换了个便宜介质 |
| **③ 独立扩缩** | 计算和存储可以各自独立扩缩容 | 想加算力就得加存储，反之亦然 |

三条全中才叫存算分离。**只满足②不满足①，那叫「把数据放在对象存储上」**——这是本文要反复区分的一个关键差别。

先给结论表：

| | ① 计算无状态 | ② 共享一份存储 | ③ 独立扩缩 | 开源协议 | 成熟度 |
|---|---|---|---|---|---|
| **OpenObserve** | ⚠️ Querier 是，**Ingester 不是** | ✅ | ✅ | **AGPL-3.0** | 生产在跑 |
| **ClickHouse 开源** | ❌ | ❌ | ❌ | Apache-2.0 | **只有「存储在 S3」** |
| ClickHouse Cloud | ✅ | ✅ | ✅ | **闭源** | GA |
| **ByConity**（CK 内核） | ✅ | ✅ | ✅ | Apache-2.0 | GA，但**公开仓库近一年多低活跃** |
| **Apache Doris 3.0+** | ✅ | ✅ | ✅ | Apache-2.0 | 3.0（2024-10）起 |
| **GreptimeDB** | ⚠️ 半 | ✅ | ✅ | Apache-2.0 | 1.0 GA（2026-04-14） |

> **⚠️ 一个必须首先澄清的事实：OpenObserve 是 AGPL-3.0，不是 Apache-2.0。**
>
> ```
> GitHub API → openobserve/openobserve → 「spdx_id」: 「AGPL-3.0」
> Cargo.toml → license = 「AGPL-3.0」   (v0.93.0)
> ```
>
> 对照组：GreptimeDB、Doris、ClickHouse **全部是 Apache-2.0**。四家里只有 O2 用 AGPL。
>
> **这条对选型的杀伤力可能超过本文所有性能数字**：AGPL 要求，如果你修改了它并通过网络对外提供服务，衍生作品需以同等协议开源。如果你打算把 O2 嵌进对外售卖的产品里，这是**法务问题而不是技术问题**，需要在评估性能之前就先解决。

---

## 二、逐一体检（四家主角 + CK 内核旁支 ByConity）

### 2.1 ClickHouse：六条路，只有闭源那条走通了

ClickHouse 把数据放到 S3 的方案不止一种，但**ClickHouse 自身没有一种开源方案同时满足三条判据**（CK **内核**的开源旁支 ByConity 是另一条真正走通的路，单列 §2.5）：

| 方案 | ① 无状态 | ② 共享一份 | ③ 独立扩缩 | 结论 |
|---|---|---|---|---|
| MergeTree + `disk = s3`（默认本地元数据） | ❌ 元数据在本地 | ❌ N 副本 N 份 | ❌ | **不是分离，是「存储在 S3」** |
| ＋ zero-copy replication | ❌ | ✅ | 部分 | 官方标注 not ready for production |
| `s3_plain_rewritable` | ✅ 元数据也在 S3 | — | — | 只做到一半，不支持 replication |
| **SharedMergeTree** | ✅ | ✅ | ✅ | **唯一 GA，闭源，仅 Cloud/BYOC** |
| Altinity Antalya | ✅ | ✅ | ✅ | 架构对，Apache-2.0，非 GA |
| 读 Iceberg / Delta Lake | ✅ | ✅ | ✅ | 读成熟；**写是 experimental** |

三条硬证据，都不是营销材料：

- ClickHouse 官方 S3 存储指南结尾直接写 **「we recommend using ClickHouse Cloud」**
- 维护者 alesapin 在清理 zero-copy replication 代码的 PR #82508 中说：**「nobody supports this code」**
- Altinity 创始人在 issue #54644 中说 SharedMergeTree **「is not going to be released in open source」**

**顺带一个容易被忽略的事实：ClickHouse 现在连 WAL 都没有了。** MergeTree 的 in-memory parts 及其配套 WAL 在 **24.2 版本被彻底移除**（23.5 起标记 obsolete），`in_memory_parts_enable_wal` 现在的文档说明是 「Obsolete setting, does nothing.」。而源码里 `fsync_after_insert` 与 `fsync_part_directory` **默认均为 `false`**：

```cpp
// src/Storages/MergeTree/MergeTreeSettings.cpp
DECLARE(Bool, fsync_after_insert, false, ...)
DECLARE(Bool, fsync_part_directory, false, ...)
```

所以 CK 的写入可靠性**不来自落盘保证，而来自多副本**：默认 INSERT 只需一个副本确认即返回，要更强保证得开 `insert_quorum`。官方对丢失窗口的表述是「若数据只写到一个副本、该副本所在机器随后消失，数据即丢失」，**没有给出具体时间窗口数字**。

**扩缩容是 CK 最痛的地方，比「繁琐」更严重**——官方文档原句：

> **「ClickHouse doesn't support automatic shard rebalancing」**

分片是静态的，写入时按分片键路由。**新加的节点不会自动获得任何存量数据**。官方给的人工方案只有三种：调分片权重、detach-attach 分区、`INSERT INTO SELECT` 全量重摄入（官方自己提示「won't be performant on very large datasets」）。核心开发者提交的原生 resharding RFC（issue #45766）**至今仍是 open**。

**但操作层有解：ckman。**

> **⚠️ 利益相关声明**：本文作者是 ckman 的作者之一。因此本节对 ckman 的评价刻意保持了与其余四家同等的审视标准——下述局限均来自对其源码与 issue 的独立核查，未因作者身份而弱化。读者仍应对本节保留额外的判断距离。

[ckman](https://github.com/housepower/ckman)（Apache-2.0，上海擎创信息技术有限公司维护，v4.0.0 / 2026-05-22）把原本需要手写脚本的分片搬迁封装成了一键任务。源码 `service/clickhouse/rebalance/` 提供两种策略：

| 策略 | 适用 | 实现 | 代价 |
|---|---|---|---|
| **ByPartition** | 副本表 | ZK 元数据级 `ALTER TABLE ... FETCH PARTITION` + `ATTACH PARTITION` + `DROP PARTITION` | **低**，不搬物理文件 |
| **ByPartition** | 非副本表 | `DETACH PARTITION` → rsync 拷贝 → `ATTACH PARTITION` | 受网络/磁盘 I/O 限制 |
| **ByShardingKey** | 数据未按原生分片规则写入 | 建临时表 → `MOVE PARTITION ... TO TABLE` → 各节点并行 `INSERT INTO ... SELECT` 按哈希写回 | 高 |

v4.0.0 重构出了 `Strategy` 接口，`Plan()` 提供只读的干跑预览（「It must not mutate cluster data」），贪心算法仅在 `max >= min + 2*size` 时才移动分区，并排除最新分区以避开正在写入的数据。

**但它没有让 ClickHouse 获得自动均衡能力，四条局限需要写清楚：**

1. **`AddNode` 与 `RebalanceCluster` 是两个独立的、都需要人工触发的操作**。加节点不会自动触发数据均衡——ClickHouse 内核「不会自动 rebalance」这个底层事实没有改变，改变的只是操作成本。
2. **DETACH/ATTACH 路径缺内建数据校验**：issue #82（2021-05-20 提出，**至今 open**）「rebalance 是不是可以加一下数据校验，因为 attach 和 detach 的过程可能出错」。
3. **ByShardingKey 存在一致性风险窗口**：`MOVE PARTITION ... TO TABLE` 会先把原表数据搬空到临时表再回填，期间对原表的查询可能读到不完整数据，源码中未见写锁定机制。
4. **纳管不了 K8s 上的 ClickHouse**：ckman 的部署模型是 SSH 到裸机/VM 生成配置、启停进程，与 Operator 部署的 StatefulSet 架构不兼容。（README 中的 「Kubernetes」 指 ckman 自身可运行在 K8s 中，不是纳管能力。）

**所以更准确的结论是**：CK 的扩缩容仍无法做到自动均衡，但借助 ckman，操作成本已从「手工高风险脚本」降为「一键触发的半自动任务」。**仍高于原生支持自动 rebalance 的系统，但不再是「唯一选择就是手工搬数据」。**

### 2.2 OpenObserve：做到了，但代价在别处

O2 是四家里架构最简单的：单二进制、零建模、数据直入对象存储。三条判据基本满足，但有两个必须说清的折扣。

**折扣一：Ingester 并不是无状态的。**

README 的营销表述是 「stateless architecture」，但官方架构文档的逐节点属性表写得很诚实——Ingester 那一栏是：

> Stateless: **Yes (buffers in WAL, Memtable, and local parquet)**

即 Querier / Compactor / Router 扩容确实不需要搬数据，但**强杀一个正在写 WAL、尚未 flush 的 Ingester，存在数据丢失窗口**。

**折扣二（更严重）：默认关闭 WAL fsync。**

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
        self.f.get_ref().sync_data()?;                 // 真 fsync —— 默认不执行
    }
}
```

**而且这是主动改的**：PR #7092（commit `b58dbda`，2025-06-10）把默认值从 `false` 改成 `true`，作为一组性能优化的一部分。**O2 在 2025 年 6 月用持久性换了写入速度。**

叠加第三个事实——**开源版 ingester 不做数据复制**（源码里搜 `replica` 只有 `ZO_NATS_REPLICAS` 协调用和 `ZO_PROMETHEUS_HA_REPLICA` 去重标签，都与业务数据无关；官方架构文档原话 「no ongoing data replication to manage」）——O2 的持久性完全押在两件事上：**本地 WAL/PVC 活到上传完成**，以及**对象存储自身的持久性**。

官方博客的说法是：

> 「Even if a disk crashes, at most ten minutes of data might be lost, depending on `ZO_MAX_FILE_RETENTION_TIME`.」

这与源码一致（`ZO_MAX_FILE_RETENTION_TIME` 默认 600 秒）。但**官方只讨论了「进程崩溃+磁盘存活」和「物理磁盘损坏」两种场景，没有讨论 fsync 默认关闭时纯断电场景的风险敞口**。

> ⚠️ **一个没有任何文档提示的部署差异**：官方 Helm chart 的 `values.yaml` 里显式写了 `ZO_WAL_FSYNC_DISABLED: "false"`——**用 Helm 装会重新打开 fsync，直接跑 Docker/二进制则是关闭的**。同一个产品，两种部署方式，持久性保证不同。

### 2.3 Apache Doris：唯一「存算分离 + 真开源 + 已落地 + 持续活跃」

Doris 3.0（2024-10）引入的存算分离架构是四家里最完整的：FE（元数据/规划）+ 无状态 BE（计算）+ 无状态 Meta Service + FoundationDB（元数据）+ 共享存储。

官方原句：

> 「the BE nodes are stateless... Multiple compute clusters share a single set of data」

存算分离模式下官方示例直接建**单副本表** `"replication_num" = "1"` 并挂载 `storage_vault_name`，依赖对象存储自身冗余——官方说明「by storing the data in shared storage, Doris no longer needs to handle the complex logic of multi-replica consistency」。

**Doris 也是唯一给出了冷查询量化基准的厂商**，这份数据的价值很高（TPC-H/TPC-DS 1TB）：

| 缓存状态 | 相对存算一体的性能 |
|---|---|
| 全命中 | 无衰减 |
| **部分命中**（官方称 「best reflects real-world usage」） | **约 10% 开销** |
| 零命中（清空缓存） | **约 35% 衰减** |

配套的容量建议是：**file cache 容量约为热查询数据量的 1.5 倍**。

**代价是运维复杂度，而且是硬性的：**

- **强制依赖 FoundationDB**，官方要求「at least three machines equipped with SSDs」组成双副本 FDB 集群
- Meta Service 生产环境至少 3 节点，FE Follower 需为奇数（「three FOLLOWERs are sufficient」）
- 官方明确 **「storage solutions like JuiceFS should not be used」**
- FDB 扩容是**手动流程**：装新机器 → 拷配置 → 重启，之后「Data distribution will slowly reorganize」，**官方未量化耗时或风险**

社区的一手抱怨比任何官方文档都有说服力：

- **issue #51892**：FDB backup 造成压力上升时，RPC 延迟升至约 1 秒，24 并发 routine load 的调度间隔被拉长到**约 2 分钟**，「causing severe jitter in the consumption of routine load」
- **doris-operator issue #233**：用户反馈官方部署文档过时导致按文档装不起来，并直接质疑 FDB 学习/维护成本过高，提议换成 Redis 等更主流的方案

### 2.4 GreptimeDB：和 O2 几乎同构，但「无状态」要打折

架构相似度高到值得单列一张表：

| | OpenObserve | GreptimeDB |
|---|---|---|
| 语言 | Rust | Rust |
| 存储格式 | Parquet on 对象存储 | Parquet on 对象存储 |
| 索引容器格式 | **Puffin** | **Puffin** |
| 全文索引 | **Tantivy** | **Tantivy**（+ 自研 Bloom 后端） |
| 定位 | logs/metrics/traces 统一 | logs/metrics/traces 统一 |
| 对象存储抽象 | — | OpenDAL |

**但「无状态」这条要打折，官方文档写得很直白：**

> 「After a Datanode restarts, it must replay the WAL to restore the latest data, **during which time the node remains unavailable**.」

要接近真无状态得开 Remote WAL（Kafka）。Region Failover 的前提是 「Kafka WAL (Remote WAL) **or** Local WAL with `allow_region_failover_on_local_wal=true`」，而后者这个开关默认 `false`，官方说明 **「not recommended... may lead to data loss during failover」**。

三个容易被忽略的细节：

1. **默认 `wal.sync_write=false`**，`sync_period` 默认 10s，官方原句 「may lose data when running host shutdown unexpectedly」——**和 O2 是同一类风险**
2. **Kafka Remote WAL 的 `replication_factor` 默认是 1**。「用 Kafka 所以更可靠」这个叙事有个官方没明说的前提：你得自己把副本数调大
3. **WAL 模式不能热切换**：「you must tear down the entire cluster and perform a clean redeployment」，要清空所有 PVC、对象存储目录和元数据存储

**还有一条直接影响「存算分离」成色的事实：开源版没有 Remote Compaction，compaction 仍在 Datanode 本地做。**

- 2026 路线图 issue #7685 该项**仍未勾选**，计划 v1.3（约 2026-08）production ready
- 2025 路线图 issue #5446 原计划 **v1.1（2025-08）交付——已跳票超一年**
- PR #4181 引入了 `RemoteJobScheduler` trait 抽象，但描述明说 **「Its implementation is in GreptimeDB Enterprise」**
- Helm chart `greptimedb-remote-compaction` 标注 「for GreptimeDB Enterprise」，无公开可拉取镜像

这意味着 GreptimeDB 的 compaction 需要把对象存储上的数据**下载回本地**再合并——和 O2 是同一个模式。我们在压测篇里实测 O2 写完后 10 分钟内仍有 **1,417 次 GET + 1,226 次 PUT**，GreptimeDB 架构上没有理由免疫这笔开销。

**实测印证了这一点**（2026-07-22，4.5 亿行）：GreptimeDB 导入后 S3 抓包显示 **12,898 GET + 8,700 PUT + 4,504 POST + 60 DELETE**——有 GET 和 DELETE，说明它确实在对象存储上做后台整理（下载-合并-删除），不是只追加 PUT。而导入完成后自动 compaction 只覆盖了很小一部分（3,546 个 L0 SST 只合出 15 个 L1），**必须手动触发 SWCS 才能把历史文件重组**——两次 SWCS 共耗时 81 分钟，期间又产生约 **25,477 GET + 10,140 PUT + 7,416 DELETE**。这正是「compaction 在本地做、对象存储付流量」这套模式的实际形态。

> **一个对 issue #13363 的独立佐证**：同一轮测试里，GreptimeDB 在那条触发 O2 静默丢数据的高基数 Top-N 查询上，**返回了与 ClickHouse 完全一致的正确结果**。这排除了「是数据本身有问题」或「是 tokenizer 差异」的可能——**同构架构（都是 Rust + Parquet + Puffin + Tantivy）的 GreptimeDB 算得对，只有 O2 走 `TantivyOptimizeExec` 那条近似路径算错**。缺陷是 O2 实现特有的，不是这条技术路线的通病。

### 2.5 ByConity：CK 内核里唯一开源做到存算分离的那条旁支

前面 §2.1 的结论是「ClickHouse 自身没有开源方案做到存算分离」。但如果把范围放宽到 **CK 内核的衍生项目**，有一个必须单列的反例——字节跳动开源的 **ByConity**。它不是 ClickHouse 的某种部署模式，而是**基于 ClickHouse 内核重写的独立云原生数仓**，2023 年开源，技术路线遵循 Snowflake 论文，做到了元数据与数据的双重存算分离。

用同一把尺子量，三条判据全中，而且是**真开源**：

| 判据 | ByConity | 证据 |
|---|---|---|
| **① 计算无状态** | ✅ | Server（接入/优化/调度）+ Worker（执行 plan segment、从 cloud storage 读数据），读写分离，Worker 无状态 |
| **② 共享一份存储** | ✅ | HDFS **或 S3**（+ GCS/Azure/OSS，统一 VFS 抽象）；数据文件存远端统一存储，与计算节点分离 |
| **③ 独立扩缩** | ✅ | 存算分离，扩容无需数据均衡，可快速弹性扩缩 |
| **开源协议** | ✅ **Apache-2.0** | GitHub API `spdx_id`；未归档 |
| **血统** | CK 内核 | CNCHMergeTree 统一分布式表、ClickHouse 方言 |

**这一条直接修正了本文原来的一个绝对表述**：CK 内核想要开源的真存算分离，SharedMergeTree（闭源）**不是唯一出路**——ByConity 是一条 Apache-2.0、支持 S3、且 ClickHouse 兼容的现成路。对已有 CK 技术栈、又要存算分离 + S3 可查的团队，这是原文漏掉的一个真实选项。

**但两条 caveat 必须和其余四家同等标注，否则就成了软文：**

**caveat 1（选型最该警惕）——公开仓库维护活跃度存疑。** GitHub 提交历史显示：最近的提交（2026-06）多为琐碎改动（LRUCache typo 修正、README 更新），再往前**直接跳到 2025-02**——**近一年多公开仓库几乎没有实质性开发**。2,237 star / 182 open issues。字节的商业精力放在**闭源云版 ByteHouse**（火山引擎），开源 ByConity 的社区投入看起来已明显收缩。**对生产选型，上游停更是比性能更致命的风险**——这一点与本文对 Doris/GreptimeDB 同等如实标注。

**caveat 2——和 Doris 一样背 FoundationDB 包袱。** ByConity 元数据同样存在 **FoundationDB**（catalog 层实现完整 ACID）。本文 §2.3 批评过 Doris 的 FDB 负担（3 台 SSD 起、运维复杂、issue #51892 抖动），ByConity **继承同一笔运维债**——社区甚至有团队（烽火星空）自行改源码用 RocksDB 替换 FDB，反证这笔负担是真实的。而且整套是重型分布式系统（Server + Worker + FoundationDB + Timestamp Oracle + Daemon Manager + Resource Manager + 共享存储 + 本地 DiskCache 二级缓存），离 O2 单二进制的简洁相去甚远，部署运维复杂度与 Doris 同档甚至更高。

> **一个诚实的边界**：ByConity 的**信创适配度**（麒麟/飞腾/龙芯等）本文未做检索核实，§五不将其纳入信创对比，避免用未验证的信息填表。它的 DiskCache 同样是「把远端数据下载到本地加速」，因此本文反复强调的「存算分离查询本质是缓存命中率游戏」这条，对 ByConity 同样成立。

---

## 三、18 维度全表对比

**证据等级标注**（本文所有对比表通用）：

| 标记 | 含义 |
|---|---|
| ✅ | **已验证**——官方文档原句 / 源码 / PR / issue，或多源交叉验证 |
| 📢 | **厂商声称**——仅见于官方博客或厂商自测，无第三方复现 |
| ❓ | **未找到证据**——检索未发现公开信息。**不等于「不支持」** |
| ⬜ | **未实测**——我们没有一手压测数据，且拒绝用厂商数字填充 |

### 表 A：架构与形态

| 维度 | OpenObserve | GreptimeDB | Doris 3.0+ | ClickHouse 开源 |
|---|---|---|---|---|
| **开源协议** | ✅ **AGPL-3.0**（美国） | ✅ Apache-2.0（中国） | ✅ Apache-2.0（ASF，中国主导） | ✅ Apache-2.0（俄裔美国） |
| **架构** | ✅ 分层，**存算分离**；组件对等（Router/Ingester/Querier/Compactor/AlertManager） | ✅ 分层，**存算分离**；角色分明（Frontend/Datanode/Metasrv[/Flownode]） | ✅ 存算一体 or **存算分离**（FE + 无状态 BE + Meta Service + FDB） | ✅ 对等分片架构（Shard + Replica），**非存算分离** |
| **存储形式** | ✅ 统一列式（Parquet） | ✅ 列式（Parquet），宽表窄表并存 | ✅ 列式，宽表为主 | ✅ 列式，宽窄表动态适应 |
| **压缩算法** | ✅ **ZSTD 固定**（`ZO_PARQUET_COMPRESSION`，默认 zstd，可选 snappy/gzip/brotli/lz4/none）**——仅全局，不可逐列** | ✅ **ZSTD level 1 硬编码，用户完全不可配置** | ✅ LZ4F（3.0 源码实际默认）/ ZSTD / LZ4 / Snappy / Zlib 等 7 种**——仅表级，不可逐列** | ✅ LZ4（自建默认）/ ZSTD / Delta / DoubleDelta / Gorilla / T64 等**——可逐列，可 pipeline 组合** |
| **写入语义** | ✅ At-Least-Once；WAL + 定期刷盘 | ✅ At-Least-Once；WAL + 定期刷盘 | ✅ **Exactly-Once（需上游 At-Least-Once 配合）**；Label 机制保证单次导入去重 | ✅ At-Least-Once；`insert_quorum` 可选多副本确认 |

**表 A 最重要的一行是「压缩算法」**，因为它把四家分成了三档：

```
可逐列配置        ClickHouse                    ← 唯一
仅表级配置        Doris、OpenObserve
完全不可配置      GreptimeDB                    ← 硬编码 ZSTD level 1
```

**这一格直接解释了压测篇里那个核心发现**：功能对等条件下 CK 的数据列比 O2 小 33%。原因不是 CK 的压缩算法更强（两边都能用 ZSTD），而是**CK 能给每一列挑最合适的 codec 与编码**（时间列用 Delta、低基数列用 LowCardinality、浮点列用 Gorilla），而 O2 只能一个 ZSTD 打天下。

三条证据：

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

> **⚠️ 顺带纠正一个流传很广的说法**：Doris 官方 CREATE-TABLE 文档写「默认压缩是 LZ4」，但 branch-3.0 源码 `PropertyAnalyzer.analyzeCompressionType()` 实际是 `return TCompressionType.LZ4F;`。文档、源码两个说法不一致（master 分支后来才改成可配置、默认 ZSTD）。**这是一个「官方文档也不能全信」的具体例证。**

### 表 B：能力与性能

| 维度 | OpenObserve | GreptimeDB | Doris 3.0+ | ClickHouse 开源 |
|---|---|---|---|---|
| **压缩率** | ✅ 实测 219.78 GiB<br>（27.3 亿行，含索引） | ⚠️ SWCS 后 **35.15 GiB**<br>（4.5 亿子集）比 CK **大 37%**<br>SWCS 使索引翻倍（+133%） | ⬜ 未实测 | ✅ 实测 **164.12 GiB**<br>（同数据同索引语义，**小 25%**） |
| **写入效率** | ✅ 实测基准 1× | ⚠️ COPY 114,867 行/s<br>但读预生成 Parquet<br>**非同协议，不可直接排名** | ⬜ 未实测 | ✅ 实测 **约 18×**（功能对等下） |
| **单表查询性能** | ✅ 热态中位 1.39×CK<br>**正文子串快 CK 3.6 倍** | ⚠️ **跨度 26 倍**：SWCS 前冷 **15.68× CK**（垫底）→ SWCS 后热 **赢 13/24**（但 0 次 S3 请求） | ⬜ 未实测 | ✅ 基准 1.00×<br>**并发扩展显著更强** |
| **内存模型开销** | ✅ 写入实测 **2.90 GiB**（四家最省）<br>查询峰值 6.07 GiB | ⚠️ 查询 8 并发 RSS<br>峰值 **21.8 GiB**（最高） | ❓ | ✅ 写入实测 10.46 GiB |
| **写入可靠性** | ⚠️ **默认低**：`ZO_WAL_FSYNC_DISABLED=true`（PR #7092 主动改的）+ **开源版无数据副本**；最坏丢 10 分钟。<br>Helm 部署会重新开启 fsync | ⚠️ **默认低**：`wal.sync_write=false`，`sync_period=10s`；Kafka WAL 的 `replication_factor` 默认 **1** | ✅ **较高**：多数派写入 + 默认 3 副本；但**存算分离模式官方示例用单副本**，RPO ❓官方未披露 | ⚠️ **中**：24.2 起**WAL 已彻底移除**，`fsync_after_insert` 默认 false；可靠性来自 `insert_quorum` 多副本而非落盘 |
| **SQL 标准** | ⚠️ **弱**：DataFusion，官方无 ANSI 兼容声明；**append-only，无行级 UPDATE/DELETE**；Broadcast Join 是企业版专属 | ⚠️ **弱**：官方原句 「a subset of ANSI SQL」；明确 **「No ACID transactions」**；JOIN 官方称「非重点」 | ✅ **强**：完整 MPP SQL、9 类 JOIN、窗口函数；但**不支持递归 CTE**，隔离级别**仅 READ COMMITTED** | ✅ **强**：官方称 「mostly compatible with ANSI SQL」；**支持递归 CTE**；不支持相关子查询；多语句事务 experimental |
| **扩展能力** | ⚠️ **弱**：无用户级 SQL UDF 注册（VRL 仅用于摄入管道）；联邦查询**企业版专属**；**无原生 Kafka 摄入**（issue #2882 挂了两年多） | ⚠️ **弱**：**无 UDF**（Python coprocessor 已被 PR #5637 删除）；无 Kafka 数据源 connector | ✅ **强**：Java UDF/UDAF/UDWF/UDTF + Remote UDF 多语言；**13+ 种 Catalog 联邦查询**；Trino Connector 插件框架 | ✅ **较强**：Executable UDF（语言不限）/ SQL UDF / WASM UDF（实验）；丰富 integration engines；**但无运行时插件系统** |

> **关于这四行**：GreptimeDB 已用一手实测填入（2026-07-22，450,394,721 行同数据子集），但**每一格都带 ⚠️——因为它们不是干净的引擎排名**，四条硬约束见下面 §3.1。**Doris 仍是空格**：素材里有它的官方数字（宣称「比 ES 快 21 倍」「成本性能优 5~10 倍」），但均为厂商自测、无第三方复现，**本文拒绝把它放进对比表**。要填 Doris 这几格，只有一条路：我们自己压。

### 3.1 GreptimeDB 实测：三个状态，别只抄一个数字

GreptimeDB 的查询性能**不是一个数字，是一条跨度 26 倍的光谱**，决定它落在哪一端的是两个变量：**是否做过 SWCS compaction**、**缓存是否命中**。抄任何单一数字都是断章取义：

| 状态 | 24 场景合计耗时 | 相对 CK | 胜出场景 |
|---|---:|---:|---:|
| **SWCS 前 · 冷** | 104.33 s | **15.68×**（垫底） | 0 / 24 |
| SWCS 后 · 预热轮 | 120.72 s* | — | 1 / 24 |
| **SWCS 后 · 热缓存** | **3.93 s** | **快过 CK 的 5.70 s** | **13 / 24** |

<small>* 预热轮被 P01 的 67.52 秒冷启动主导；去掉 P01 后其余 23 场景 53.21 s。</small>

同一个引擎、同一份数据，从「比 CK 慢 15 倍、一场没赢」到「总耗时比 CK 还短、赢 13/24」。**这个 26 倍的跨度本身就是最重要的结论**——它说明 GreptimeDB 在对象存储上的表现，和 O2 一样，**是一场「compaction 布局 + 缓存命中率」的游戏**，而不是一个稳定的引擎能力值。

**但热态那个漂亮数字有个致命前提**：热轮抓包是 **24 字节空 pcap，0 次 S3 HTTP 请求**——数据全部由本地缓存服务。所以 3.93 s 是「SWCS + 本地缓存全命中」的**上限**，不是「每次从 RustFS 读」的常态。对照 SWCS 前两轮冷查产生的 **18,080 + 12,014 次 GET**，真实生产落在两端之间，取决于你的缓存能装下多少热数据。

**剩下两条约束也必须一起看**：

- **单节点 standalone**。官方明确把该模式定位为开发/测试，**不代表分布式 MPP 集群的上限**。
- **写入不是同协议**。GreptimeDB 的 COPY 读预生成的本地 Parquet（114,867 行/s），O2 走 JSON bulk（51,863），CK 是同集群列式复制（930,965）。**三条路径开销天差地别，行吞吐不能直接排名。**

**不受状态影响的三条结构性结论**（这些才是能带走的）：

- **强在 tag/ID 点查**：Bloom skipping index 让 P01 8 并发达 57.69 QPS 逼近 CK 63.62；热轮里 P04 comment_id 点查 **0.053 s，快过 CK 的 0.102 s**。这是架构给的，稳定成立。
- **弱在对象存储上的聚合/扫描/深分页并发**：即便 SWCS 后，8 并发仍仅 **0.13~0.17 QPS**，CPU 平均 1.3~1.6 核却打不上去——瓶颈是 S3 I/O 等待。**和 O2 是同一类问题。**
- **存储比 CK 大，且 SWCS 后更大**。SWCS 前 33.29 GiB、后 **35.15 GiB**（比 CK 的 25.69 **大 37%**）——**SWCS 让数据略降 0.84%，但索引从 1.60 涨到 3.73 GiB（+133%），总量反增 5.59%**。这印证了对 O2 的同一判断：**Parquet-on-对象存储这条路线在存储体积上普遍打不过 CK 的列式编码**（逐列 codec + LowCardinality + ORDER BY 聚类），O2 和 GreptimeDB 都比 CK 大，不是偶然。

> **SWCS 这一步值得单独记一笔**：它不是「跑完 compaction 就变好」这么简单。它把查询热态上限从垫底拉到领先，却**同时让索引体积翻倍、且必须手动触发**（自动 compaction 只合了 15 个 L1，3,546 个 L0 纹丝不动，两次 SWCS 共耗时 81 分钟）。「导完数据直接能查」在 GreptimeDB 上是个陷阱——**这正是官方文档叫你别做的事**。

### 表 C：成本与运维

| 维度 | OpenObserve | GreptimeDB | Doris 3.0+ | ClickHouse 开源 |
|---|---|---|---|---|
| **S3 流量成本** | ✅ **实测有持续开销**：停写后 10 分钟内仍有 1,417 GET + 1,226 PUT（compaction 下载-合并-上传） | ⚠️ **同类开销**：开源版**无 Remote Compaction**，compaction 在 Datanode 本地做，必然回拉数据 | ⬜ 未实测；官方提供 file cache 与流量控制参数 | ⚠️ 不适合 S3（无存算分离，S3 仅作冷存介质） |
| **扩缩容成本** | ✅ **低**：NATS 自动注册发现；Querier/Compactor/Router 无需搬数据。**但 Ingester 有状态**，强杀有丢数据窗口 | ✅ **低**：计算节点可独立扩缩 | ✅ **低**：BE 无状态；但 **FDB 扩容是手动流程**且官方未量化耗时 | ⚠️ **较高**：内核不支持自动 rebalance（RFC #45766 至今 open），新节点不自动获得存量数据。**但 ckman 把分片搬迁封装成一键任务**，成本从「手工脚本」降为「半自动」，仍非自动均衡 |
| **集群部署/运维复杂度** | ⚠️ **中**：单二进制起步极简，但 HA 需 PostgreSQL + NATS + 对象存储 | ⚠️ **中**：Frontend + Datanode + Metasrv + 元数据后端（etcd/MySQL/PG）（+ Kafka）。**官方无统一的「生产最小拓扑表」**，需跨多篇文档拼凑 | ❌ **最高**：FE + BE + Meta Service + **FoundationDB**，各 3 台起；官方禁用 JuiceFS | ⚠️ **中**：分片 + 副本 + ClickHouse Keeper。**有成熟的开源管理工具（ckman）**覆盖部署/滚动升级/启停/监控/备份/rebalance，但纳管不了 K8s 上的 CK |
| **外部依赖** | PostgreSQL（强制）+ NATS + 对象存储 | etcd / MySQL / PostgreSQL 三选一（**官方已转向不推荐 etcd**，PR #6127）+ 可选 Kafka | **FoundationDB**（强制，3+ SSD 机器） | ZooKeeper / ClickHouse Keeper |
| **信创适配度** | ❌ **全空白**：ARM64 官方支持 ✅，国产 CPU/OS **零证据**，`loongarch` 仓库检索 0 条，**查不到任何国内商业支持方** | ⚠️ **弱**：ARM64 ✅；龙芯**有明确反面证据**（检索 0 条、CI 无该 target）；国产 CPU/OS ❓；📢自称过信通院验证但 CAICT 名录检索不到。国内主体：格睿科技（杭州） | ⚠️ **相对最强**：官方 ARM 编译文档**明确列出银河麒麟 Kylin-Server-10-SP1 + 飞腾 FT-2000+/64 已验证**；3.0.3 起 ARM 支持存算分离。📢 SelectDB 宣称的六方兼容互认证、信通院测评**均无法在麒麟/统信/CAICT 官网交叉核实** | ⚠️ **内核有反面证据，生态有正面信号**：内核侧 issue #19028（飞腾+麒麟 SIGABRT，2021 至今未修）、#89841（麒麟 ARM 崩溃，2025-11）；龙芯仅「实验性支持」无预编译包；无官方在华商业支持。**但管理侧 ckman 由国内实体（上海擎创）维护，支持达梦 DM8 作元数据后端、提供 ARM64/aarch64 官方包**——代码级可用，无信创专项 CI 或认证 |
| **适用场景** | 一体化开源可观测性平台；中小规模、资源受限、快速起步 | 云原生统一可观测数据库（metrics 强于 logs） | 功能完整的日志分析数据仓库；需要 JOIN / 更新 / 湖仓联邦 | 超大规模日志的实时分析引擎；查询性能与并发的天花板 |

---

## 四、成本的真相：存算分离不是免费的

存算分离最常见的推销话术是「存储成本降 N 成」。这句话本身没错，但它只算了一半的账。**另一半是查询延迟、缓存容量和请求费用**，四家没有一家能绕开。

### 4.1 冷查询衰减：唯一的行业基准线，和我们的实测

Doris 是四家里**唯一公开了冷查询量化衰减数据**的厂商，这份数据因此有了基准线的价值：

| | Doris 官方（TPC-H/DS 1TB） | OpenObserve（我们的实测，27.3 亿行） |
|---|---|---|
| 缓存全命中 | 无衰减 | — |
| 部分命中 | **约 10% 开销** | 热态中位 **1.39×** CK（即约 +39%） |
| 零命中 / 首次触达 | **约 35% 衰减** | 首次触达中位 **4.28×** CK（即 **+328%**） |

两组数字口径不同（Doris 是「相对自己的存算一体模式」，我们是「相对 ClickHouse」），**不能直接相减**。但量级差异足够说明问题：**Doris 把冷查询代价控制在 35% 以内，而 O2 首次触达要付出数倍代价。**

O2 首触达代价高，与调研篇的源码结论一致：冷路径要下载并解析 Parquet footer、warm up Tantivy term。**这不是 bug，是架构选择的必然账单。**

### 4.2 缓存容量：存算分离的隐藏硬件预算

Doris 官方给出的容量建议是一条很实用的经验值：

> file cache 容量应约为**热查询数据量的 1.5 倍**

这条建议的潜台词是：**存算分离省下的存储成本，有一部分要以本地 SSD 缓存的形式重新花掉。** 如果你的热数据是 10 TB，就得给计算节点配 15 TB 的本地缓存盘——这笔钱在「S3 比本地盘便宜 N 倍」的宣传里是不出现的。

我们在压测篇里实测到的现象是同一枚硬币的另一面：

```
O2 S3 查询：
  cache-bypass 首轮：  12,911 次 GET，1.269 GiB
  重复轮 / 热态 / 并发：      0 次 GET
```

**除首轮外，一次 S3 GET 都没发。**所有看起来还不错的 S3 查询数字，测的都是「远端流 + 本地文件缓存」。**O2 在对象存储上的查询性能，本质是一场缓存命中率游戏**——缓存命中时能和本地盘引擎五五开，一旦落到冷路径，4.28× 的代价就会重新出现。

### 4.3 Compaction：那笔从不出现在账单里的开销

**存算分离并没有消灭 compaction，只是把它搬到了网络上。** 四家里有三家的 compaction 需要把数据从对象存储下载回来、合并、再上传：

| | Remote Compaction | 实际做法 |
|---|---|---|
| **OpenObserve** | 无 | ✅ 实测：停写后 10 分钟内仍有 **1,417 GET + 1,226 PUT** |
| **GreptimeDB** | **开源版没有**（Enterprise 专属） | compaction 在 Datanode 本地做，必然回拉数据 |
| **Doris** | ⬜ 未实测 | 官方提供 file cache 与流量控制参数 |

GreptimeDB 这条尤其值得注意，因为跳票时间很长：

- 2025 路线图 issue #5446 计划 v1.1（2025-08）交付
- 2026 路线图 issue #7685 该项**仍未勾选**，改计划 v1.3（约 2026-08）
- PR #4181 的 `RemoteJobScheduler` trait 描述直言 **「Its implementation is in GreptimeDB Enterprise」**

我们压测篇的实测结论是：**compaction 的代价不在「拖慢写入」（校正后净影响 2% 以内），而在后台资源与 S3 请求数**——compaction 期 CPU 平均 +29.7%、峰值飙到 8.73 核，S3 请求量翻倍。**这正是「存储成本降 N 成」那笔账里从不出现的部分。**

---

## 五、信创与商业支持：可能比性能更影响选型

这一维度必须单独成章，因为它的结论方向和技术维度**完全不同**——技术上最强的两家（ClickHouse、OpenObserve），在这一维度上恰好最弱。

**先说方法论**：本章是全文证据链最薄弱的部分，因此分层最严格。厂商宣传的「已通过 XX 认证」，如果在认证机构官网检索不到对应收录页，本文一律标注为「厂商声称」而非事实。

### 5.1 逐家结论

**Apache Doris——相对最强，且有官方硬证据**

官方 ARM 编译文档明确列出**已验证环境**包含：

> **KylinOS（银河麒麟）Kylin-Server-10-SP1 + 飞腾 FT-2000+/64**

并注明 「Starting from version 3.0.3, the ARM platform supports compilation and deployment in compute-storage decoupled mode.」

但 SelectDB（飞轮科技）宣传的部分**无法交叉核实**：所谓「通过中国信通院第 15 批可信数据库测评」「与兆芯/飞腾/海光/统信/麒麟完成六方兼容互认证」——**麒麟软件、统信软件官网的兼容列表、以及 CAICT 官网，均检索不到对应收录页面**。这些只能算厂商声称。

**GreptimeDB——弱，且龙芯有明确反面证据**

- ARM64 官方支持 ✅（含 `linux-arm64`/`darwin-arm64`/`android-arm64` 构建）
- **龙芯：GitHub 搜索 `loongarch`/`loong64` 返回 0 条，CI 构建矩阵不含该 target**——这是反面证据，不是「未找到」
- 鲲鹏 / 飞腾 / 海光 / 麒麟 / 统信：全部未找到证据
- 📢 格睿官网自称已获信通院「可信数据库」验证（2026-07），**CAICT 公开名录检索不到**

> ⚠️ **调研中踩到的一个坑**：网上流传「GreptimeDB 已通过麒麟、统信认证」的说法，**实际来自 RustFS 项目，与 GreptimeDB 无关**。这类张冠李戴在信创信息里非常常见，务必核对原始出处。

**ClickHouse——有明确的反面证据**

这是全文唯一一家**在国产环境下有公开崩溃记录**的：

- **issue #19028**（2021）：飞腾 FT2000+/64 + 麒麟 v10sp1 环境下 SIGABRT 崩溃，长期标记 minor，**未见明确修复**
- **issue #89841**（2025-11 提交，25.11.1.2141 版本）：麒麟 ARM 环境崩溃，截至调研时**未修**

**但这个崩溃的根因值得说清楚，因为它不是 bug，而是构建目标不匹配。**

ClickHouse 的默认 ARM 构建按 **ARMv8.2** 编译，依赖 **LSE 原子指令**（ARMv8.1 起强制）；而**飞腾 FT-2000+/64 属 ARMv8.0**，没有 LSE——执行到相关指令即 SIGILL / SIGABRT。这一点在官方 CMake 里写得很明白：

```cmake
// cmake/cpu_features.cmake
option (NO_ARMV81_OR_HIGHER "Disable ARMv8.1 or higher on Aarch64 for maximum
        compatibility with older/embedded hardware." 0)

if (NO_ARMV81_OR_HIGHER)
    set (COMPILER_FLAGS "${COMPILER_FLAGS} -march=armv8+crc")
else ()
    # ARMv8.2 ... 包含 LSE（ARMv8.1 起强制），提供显著加速
```

同一文件里的报错信息甚至直接给了解法：

> `"The build machine does not satisfy the minimum CPU requirements, try to run cmake with -DNO_ARMV81_OR_HIGHER=1"`

官方也为此提供了 **`aarch64v80compat`** 预编译产物。

**所以这不是无解，但代价要认**：官方主线包在 ARMv8.0 的国产 CPU 上**开箱即崩**，要么自行以兼容 flag 重新编译，要么改用兼容包（会损失 LSE 带来的性能）。这解释了为什么 #19028 挂了五年还是 minor——**对官方而言这是「用户构建目标选错了」，对国产化项目而言这是「默认路径走不通」。** 两边都没错，但后者要额外付出构建与验证成本。
- 龙芯：官方文档明确标注「实验性支持」，仅提供交叉编译指南，**无预编译二进制**
- 华为鲲鹏社区有生态文档，但实质是引导下载**通用 aarch64 RPM 包**，非专属优化构建

**商业支持也要说清**：未查到 ClickHouse Inc. 在华设有分支机构或官方授权代理商。阿里云「云数据库 ClickHouse」、腾讯云 TCHouse-C、火山引擎 ByteHouse **均是云厂商自研或深度改造的产品，不等同于 ClickHouse Inc. 的官方商业支持**。

**OpenObserve——全空白**

- ARM64 官方支持 ✅
- 国产 CPU / 国产 OS / 信创认证目录：**全部零证据**，仓库检索 `loongarch` 0 条
- **查不到任何国内代理商、经销商或商业支持提供方**，官方支持渠道是其美国主体 OpenObserve Inc. 的境外联系页

### 5.2 这一章的实际含义

如果你的项目有信创要求，上面这张表基本上就是终局：

```
Doris        有官方验证的麒麟+飞腾组合，国内主体（飞轮科技）可采购支持
GreptimeDB   国内主体（格睿科技，杭州），但适配证据薄弱，龙芯明确不支持
ClickHouse   ARMv8.0 国产 CPU 上官方包开箱即崩，需自行编译兼容版本；
             无官方在华支持，但管理侧有国内维护的 ckman（DM8/ARM64）
OpenObserve  技术上可能可跑（ARM64），但零适配证据、零国内支持、且是 AGPL
```

> **这一栏最容易被误读的一点**：ClickHouse 的国产 ARM 问题是**可解的构建问题**，不是能力缺失；而 OpenObserve 的问题是**信息完全空白**——没有人公开跑过、没有人公开支持过。前者你知道要付出什么代价，后者你连代价是多少都不知道。**对信创项目而言，已知的成本远好过未知的风险。**

**AGPL + 无国内商业支持 + 零信创证据**——O2 在这三条上叠加的风险，对于有合规要求的项目而言，可能在任何性能对比开始之前就已经出局了。

---

## 六、选型建议

**先回答那个最初的问题**：ClickHouse 能不能像 O2 那样数据直入 S3、做存算分离？

**ClickHouse 自身的开源版不能。** 它能把数据*存在* S3 上，但那不是存算分离——元数据仍在本地、N 个副本仍占 N 份存储、计算和存储无法独立扩缩。ClickHouse 官方产品里真正的存算分离只有 SharedMergeTree 一条路，而它**闭源、只在 Cloud/BYOC 提供**。这不是我的推断，是维护者和 Altinity 创始人的公开表态。

**但如果放宽到 CK 内核的衍生项目，有一条开源的路走通了：ByConity（§2.5）。** 它是字节基于 ClickHouse 内核重写的独立数仓，Apache-2.0、支持 S3、三条判据全中。代价是两条：**公开仓库近一年多低活跃（上游停更风险）**，以及**和 Doris 一样的 FoundationDB 运维负担**。所以准确的结论是：CK 内核想要开源存算分离并非无解，但现成的那条路（ByConity）要先过「上游是否还在维护」这一关。

### 按场景的建议

| 你的情况 | 建议 | 理由 |
|---|---|---|
| **有信创/合规要求** | **Doris** | 唯一有官方验证的麒麟+飞腾组合 + 国内商业支持主体。**先排除 O2（AGPL + 零信创证据）** |
| **要极致查询性能与高并发** | **ClickHouse** | 并发扩展显著更强（实测点查 7 倍线性扩展）；逐列 codec 带来 25% 存储优势。**代价是放弃存算分离**；扩缩容弹性差，但 ckman 可把成本降到「半自动」 |
| **已有 CK 技术栈，又要存算分离 + S3** | **ByConity**（谨慎） | CK 内核 + Apache-2.0 + 真存算分离 + 支持 S3，是 CK 生态里唯一开源做到的。**但先评估两点：公开仓库近一年多低活跃（上游停更风险）、FoundationDB 运维负担** |
| **要存算分离 + 完整 SQL + 湖仓** | **Doris** | 唯一「存算分离 + 真开源 + 已落地 + 活跃维护」；13+ Catalog 联邦。**代价是 FoundationDB 的运维负担** |
| **中小规模、快速起步、日志为主** | **OpenObserve** | 单二进制 + 零建模 + 正文检索快 CK 3.6 倍。**前提是先过 AGPL 这一关** |
| **metrics 为主，要 PromQL** | **GreptimeDB** | 原生 Rust PromQL 实现 + 统一存储。**注意开源版无 Remote Compaction、无 UDF** |

### 关于 O2 护城河的重新判断

**O2 的护城河不是「存算分离」本身——这个能力在 2026 年已经不稀缺**（Doris、GreptimeDB 都开源提供，CK 内核的 ByConity 也开源做到了，架构上 Altinity Antalya 与 O2 几乎同构）。

它真正独有的是**「存算分离 + 单二进制 + 零建模」这个组合**。Doris 要 FDB 起步、GreptimeDB 要 Metasrv+Datanode+Frontend+元数据后端，只有 O2 能一个二进制跑起来还带对象存储。

但这个组合的代价，本文和前两篇加起来已经列得很清楚了：AGPL 协议、默认关闭 fsync、开源版无数据副本、无逐列压缩、无用户 UDF、无联邦查询（企业版专属）、冷查询 4.28× 代价、零信创证据。

**值不值，取决于你的约束条件——但至少现在这些代价都摆在明处了。**

---

## 七、我的立场：这道题，也可以不做

前面六章都在回答同一个问题：**谁做到了存算分离。**

这是一道好题，但它有个隐含前提 —— 存算分离本身是目标。我不这么认为。而这篇文章到这里为止，只在附录里声明了利益相关，没说过我的偏向。补在这里。

### 先把偏向摆出来

我是做 ClickHouse 的：[ckman](https://github.com/housepower/ckman) 第一作者、[clickhouse_sinker](https://github.com/housepower/clickhouse_sinker) 维护者，主要场景是金融和信创。

§2.1 的结论我完全同意 —— **ClickHouse 开源版确实没有真正的存算分离，六条路只有闭源那条走通了。** 这一章不是要翻案。

但正因为在 CK 上待得够久，我知道一件在对手那边未必看得清的事：**「这个能力它没有」和「这个需求解决不了」，不是一回事。**

### 需求到底是什么

把「我要存算分离」翻译回去，绝大多数团队真正想要的是三件事里的一到两件：

1. **冷数据要便宜** —— 别再拿 NVMe 存一年前的日志
2. **冷数据还得能查** —— 合规回溯、偶发排障，删不得
3. **计算能独立扩缩** —— 高峰扩、平时缩

**只有第 3 条是非存算分离不可的。**

而在我接触的金融、信创项目里，第 3 条排在最后，甚至根本不在列表上 —— 变更窗口是提前排期排出来的，没有人在半夜做弹性扩容。真正天天被问的是第 1 和第 2 条。

这两条，不需要存算分离。

### 第三种答案：Parquet + chDB

把冷数据从 ClickHouse 里导出成 Parquet 放进 S3，再用 chDB 作为独立的查询侧：

- ClickHouse 本地盘只留最近 4 个月，TTL 按「已导出」标记删除
- 每日 cron 导出，Hive 风格分区，按主过滤列排序，ZSTD + row group statistics
- **导出成功的判据不是「INSERT 没报错」，是行数核对加抽样比对都通过**，通过了才回填 `exported_at`，才允许删分区
- 读路由分三段：近 4 个月走 ClickHouse，更早走 chDB，跨越分界线的查询在业务层拆两段再合并

完整的落地形态、参数和脚手架在 [chDB + S3 Parquet：把冷数据变成可查询资产](/clickhouse/cold-storage/chdb)。

它解决了第 1、2 条，**代价是一个导出任务**。

### 代价要算全，包括我推荐的这个

这一栏的规矩是代价必须算全，那就先算我自己这边的：

- **这不是存算分离，第 3 条它解决不了。** 计算和存储仍然不能独立扩缩，CK 该扩还得扩
- **多了一条数据管道**：cron、行数校验、抽样比对、标记回填，每一步都得幂等可重试 —— 这条管道本身就是个要维护的东西
- **冷热边界要业务感知**：跨越分界线的查询得在业务层拆开再合并，这是侵入业务代码的
- **两套 schema 要一起演化**，CK 改了列，导出管道和 chDB 侧的读取都得跟
- **丢掉了 MergeTree 的稀疏主键索引**。Parquet 只有 row group 级别的 min/max 和 bloom，跳读粒度比 granule 粗一个数量级
- **chDB 是独立进程**，并发控制、内存上限、spill、查询取消、OOM 兜底，全都得自己搭

对比一下另一条路的代价：上 Doris 同样能解决第 1、2 条，而且顺带把第 3 条也解决了 —— 代价是 FoundationDB + FE + BE 一整套新的运维面，外加一批你还没学会的故障模式。

**为一个能力引入一整套组件，账要算全。** 但反过来也一样：为了省一套组件而自己造一条管道，这条管道的维护成本同样要算进去。

### 我会选什么

| 你的情况 | 我会选 |
|---|---|
| 冷数据要便宜 + 能查，负载平稳，团队养得起一条管道 | **CK + Parquet + chDB** |
| 同上，但没人维护管道 | **S3 Disk**，接受它的运维成本 |
| 冷数据一年查一两次，合规驱动 | **BACKUP/RESTORE**，别想着在线查 |
| 计算真的需要独立弹性扩缩 | **Doris**，别硬凑 |
| 已经在 CK 内核上，且能承担上游停更风险 | **ByConity** |

### 什么情况下我会改主意

- **第 3 条变成硬需求**：日内负载有 10 倍以上波动，或者做按查询计费的多租户 —— 这时自建管道凑不出弹性，该上就上
- **冷查询从批量扫描变成高并发点查**：Parquet 的 row group 粒度扛不住这个，MergeTree 的稀疏索引才扛得住
- **SharedMergeTree 开源**，或者 ByConity 上游恢复活跃 —— 前者概率不高（Altinity 创始人在 issue #54644 里已经把话说死了），后者值得持续观察
- **团队里没人能接手那条导出管道**。技术上成立但组织上养不活的方案，等于不成立

---

## 附录 A：证据清单

本文全部一手材料（**177 条 URL、549 条官方英文原句、92 条量化数据、12 个 PR、20 个 issue**）已汇编成独立文件，未经改写：

```
存算分离-原始素材.md    （414 KB / 4337 行）
```

文中引用的关键证据锚点：

| 结论 | 证据 |
|---|---|
| O2 是 AGPL-3.0 | GitHub API `spdx_id`；`Cargo.toml` `license = "AGPL-3.0"` |
| CK 存算分离只有闭源路（**CK 官方产品内**） | PR #82508（alesapin 「nobody supports this code」）；issue #54644 |
| ByConity 是 CK 内核开源存算分离 | GitHub API `spdx_id=Apache-2.0`、未归档；官方架构文档（Server/Worker + HDFS/S3 + FoundationDB 元数据） |
| ByConity 公开仓库近一年多低活跃 | GitHub commits：最新提交（2026-06）为 typo/README，上一批实质提交回退至 2025-02 |
| ByConity 依赖 FoundationDB | 官方架构文档「metadata 基于 FoundationDB」；社区改用 RocksDB 的实践（烽火星空） |
| CK 不支持自动 rebalance | 官方文档原句；RFC issue #45766 仍 open |
| CK WAL 已移除 | 24.2 changelog；`in_memory_parts_enable_wal` 标注 obsolete |
| O2 默认关闭 fsync | `src/config/src/config.rs:1159`；PR #7092 / commit `b58dbda` |
| O2 不可逐列压缩 | `src/config/src/utils/parquet.rs` → `new_parquet_writer()` |
| GreptimeDB 压缩硬编码 | `src/mito2/src/sst/parquet/writer.rs` → `maybe_init_writer()` |
| GreptimeDB 无 Remote Compaction | issue #7685 / #5446；PR #4181；Helm chart 标注 |
| GreptimeDB 无 UDF | PR #5637 「They were added for python feature, which is removed now.」 |
| Doris 默认压缩文档与源码不符 | `PropertyAnalyzer.analyzeCompressionType()` (branch-3.0) |
| Doris 不可逐列压缩 | issue #50631，2025-11-14 被 Stale 自动关闭 |
| Doris FDB 运维负担 | issue #51892；doris-operator issue #233 |
| CK 国产环境崩溃 | issue #19028（飞腾+麒麟）；issue #89841（麒麟 ARM） |
| ckman rebalance 两种策略 | `service/clickhouse/rebalance/{strategy,bypartition,byshardingkey,run,prereq}.go` |
| ckman rebalance 缺数据校验 | ckman issue #82（2021-05-20 提出，至今 open） |
| ckman 达梦 DM8 支持 | `repository/dm8/`；CHANGELOG v2.2.7 「dm8 database adapt」 |
| ckman ARM64 支持 | CHANGELOG v2.2.4 「adapted for arm64」；官方下载页三类产物 |

---

## 附录 B：未验证项清单

**本文明确没有做到的事，列在这里，不藏着。**

**一、四个性能维度：GreptimeDB 已实测，Doris 仍空白**

压缩率、写入效率、单表查询性能、内存开销——**GreptimeDB 已用一手实测填入**（2026-07-22，4.5 亿行子集），但受未 compact / 单节点 standalone / 缓存不对等 / 写入非同协议四条约束限制，**只能作为「当前部署的实际表现」，不是引擎能力排名**（详见 §3.1）。**Doris 仍是空白**——素材里有官方数字，但均为厂商自测、无第三方复现，本文拒绝将其填入对比表。要填 Doris，只有一条路：我们自己压。

另需说明：GreptimeDB 的 4.5 亿行子集与 O2/CK 的 27.3 亿行全表**规模差 6 倍**，表 B 里 GreptimeDB 的压缩率数字只与同子集的 CK（25.69 GiB）可比，不能与 O2/CK 的全表数字直接相减。

**ByConity 同样未做一手压测，也未核实其信创适配**：本文对 ByConity 只验证到「架构层面满足三条判据 + 开源协议 + 公开仓库活跃度」，其压缩率/写入/查询性能、以及麒麟/飞腾/龙芯等信创适配，均**未实测/未检索**，因此不进 §三 的性能对比表、不进 §五 的信创表。要评估 ByConity 的真实性能与信创可用性，同样只有「自己压 + 直接向社区/厂商核实」一条路。

**二、官方文档本身的空白（不是调研不够深）**

- **Doris 存算分离模式的 RPO**：多路独立检索均未找到官方对「客户端收到写入成功」与「Segment 实际完成上传对象存储」之间时序保证的任何量化承诺。**这是厂商未披露的风险点。**
- **O2 断电场景的具体丢失窗口**：官方博客只讨论了「进程崩溃+磁盘存活」和「物理磁盘损坏」两种场景，未提及 fsync 默认关闭时的额外敞口。本文的相关表述是**基于源码机制的推导**，非官方声明。
- **GreptimeDB WAL replay 期间查询的具体表现**：官方只声明「不可用」，未描述报错/超时/路由行为。
- **CK 与 Doris 的扩容耗时量级**：两家官方文档均未给出数字。

**三、检索工具的固有局限**

GitHub 代码全文搜索需登录，未能穷尽核实，主要影响 GreptimeDB 「enterprise feature 隔离范围」的结论完备性。龙芯支持的结论已用 issue/PR 搜索 API 交叉验证（0 命中），置信度较高。

**四、ckman 相关的利益相关与未验证项**

本文作者是 ckman 的作者之一，§2.1 已作声明。该节的评价标准与其余四家保持一致，但以下几项仍属未验证：

- **rebalance 的大数据量表现无基准数据**：源码与文档均未给出吞吐量/耗时基准。副本表路径是 ZK 元数据级操作（理论上快），非副本表路径依赖 rsync，未见性能数据。
- **DM8 与 ARM64 缺专项 CI**：`.gitlab-ci.yml` 只有通用 build/test/lint，没有针对达梦或 ARM 环境的回归流水线。因此这两项应理解为「代码级已实现」，而非「持续验证」。
- **未找到擎创科技对 ckman 提供商业 SLA/付费支持的官方页面**——存在国内维护实体 ≠ 有商业支持承诺。
- **ByShardingKey 策略的一致性窗口**：源码中未见写锁定机制，但「实际使用中是否要求停写」未在文档中明确，此处是基于源码的推断而非官方声明。

**五、一条方法论提醒**

本文严格区分「未找到证据」与「确认不支持」。信创章节的大量 ❓ 属于前者——**没有公开信息可查，不代表跑不起来**。如果这是你的关键决策点，正确做法是直接向厂商索取测试报告，而不是采信本文（或任何一篇文章）的检索结果。

---

> **系列前两篇**：[调研篇 —— 源码级的存储与查询深挖](/clickhouse/comparison/openobserve-internals) · [压测篇 —— 27.3 亿行下的真实表现](/clickhouse/comparison/openobserve-benchmark)
