---
title: 应用平台的 S3 冷盘：队列分开是前提，剩下都是细节
---

# 应用平台的 S3 冷盘：队列分开是前提，剩下都是细节

> 这个系列前几篇基本在讲 S3 Disk 哪里不好。但它有几个无可替代的优点：零改造、存查同体、完整保留 MergeTree 的索引体系。如果你一定要用它，第一件事是把队列分开。
>
> **阅读对象**：在多租户或应用平台场景下运维 ClickHouse S3 冷盘的工程师。

---

## 引言

这套系列的前几篇基本是在讲「S3 Disk 哪里不好」——单租户百 TB 集群里 merge 爆炸、启动卡死、副本翻倍、schema 演化困难。结论倾向于「能不上就不上，能转 Parquet 就转 Parquet」。

但回到 S3 Disk 这个方案本身，它确实有几个无可替代的优点：

- **零改造**：表还是 MergeTree，SQL 一行不用动，TTL 表达式就能配冷热下沉。其他方案（Parquet、BACKUP）都涉及数据格式迁移、查询路径改造、工具链替换
- **存储和查询同体**：冷数据是直接可查的 MergeTree part，不需要再起一个 Spark/Trino/chDB 之类的查询侧。冷查询走的还是 ClickHouse 原本那套主键索引、列裁剪、过滤下推
- **完整保留 MergeTree 索引体系**：稀疏主键索引（granule 级跳读，8192 行粒度，比 Parquet 的 row group 细一个数量级）、跳数索引（minmax / set / bloom_filter / ngrambf / tokenbf）、Projection（同数据多排序副本，查询自动选最优）、列级 codec（DoubleDelta / Gorilla / T64 等专用编码）都在 S3 上继续工作。**S3 上的冷查询能做到只下载需要的列 + 只下载需要的 granule 字节范围**——Parquet 方案要叠 Iceberg/Hudi 这类湖仓格式才能追平这套索引能力
- **统一的运维心智**：所有数据都在 ClickHouse 里，监控、备份、权限、Schema 管理只有一套体系，不需要并行维护「热表 vs 冷文件」两套抽象
- **存储成本立刻下降**：S3 的单位存储价格通常是本地 NVMe 的 1/5~1/10，且随用随付，不用提前规划盘位
- **副本和高可用机制不变**：ReplicatedMergeTree 依然工作，Keeper 协调依然在，不需要重新设计可用性模型

这些优点合起来意味着一件事：**冷热分层从架构改造变成配置变更**。对一个已经在跑的 ClickHouse 系统来说，这是最低摩擦的扩展路径。

但代价就是前几篇讲的那一套——S3 不是本地盘，把 S3 当慢盘用会在 merge、启动、副本、schema 演化上付出代价。所以问题不是「S3 Disk 能不能用」，而是「**用的时候怎么不被它反噬**」。

> 所有跟 S3 相关的爆炸，本质都不是「限流不够」的问题，是**队列没分开**的问题。队列分开了之后，CK 在自己队列里慢慢排队就行了，外面感知不到。

阅读对象：在做应用平台（日志、可观测性、数据分析、SaaS 等）需要给用户提供 S3 冷盘能力，或者已经提供了但担心被它拖垮的工程师。

---

## 一、CH 在 S3 上的数据布局：优势与代价

后面所有论点（为什么 metadata_path 备份必须 P0、为什么对象数容易爆炸、为什么 granule 级跳读能成立、为什么禁 merge 省钱）都建立在 CH 的物理数据布局上。先把这一层讲清楚。

### 1.1 Part 是目录，不是单文件

一个 MergeTree part 在磁盘上是一个目录，里面是十几个独立文件：

```
part_xxx/
├── primary.idx              # 稀疏主键索引（整个常驻内存）
├── partition.dat            # 分区键值
├── minmax_<pk>.idx          # 分区列 minmax
├── columns.txt              # 列清单
├── count.txt                # 总行数
├── checksums.txt
├── <col>.bin                # 每列一个数据文件
├── <col>.mrk2               # 每列一个 mark 文件（granule 边界）
└── skp_idx_<name>.idx       # 跳数索引（每个一个文件）
```

上 S3 时，**每个文件变成一个独立的 S3 对象**。本地 `metadata_path` 维护「逻辑文件路径 → S3 object key」的映射。

跟 Parquet 那种「一个文件 + 尾部 footer 自描述」完全是两种模型。

### 1.2 查询时怎么走索引

<div class="sk sk-steps">
<div class="sk-box"><span class="sk-t">SELECT … WHERE pk_col &gt; X AND other_col = Y</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-ok"><span class="sk-n">1</span><span class="sk-t">本地 metadata_path 拿 part 列表</span><span class="sk-d">0 次 S3 IO</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-ok"><span class="sk-n">2</span><span class="sk-t">primary.idx 二分查找</span><span class="sk-d">通常已在内存，定位 granule 范围</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-warm"><span class="sk-n">3</span><span class="sk-t">minmax + skp_idx 跳数索引</span><span class="sk-d">Range GET，几 KB ~ 几 MB</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-warm"><span class="sk-n">4</span><span class="sk-t">&lt;col&gt;.mrk2 查 byte offset</span><span class="sk-d">Range GET</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-hot"><span class="sk-n">5</span><span class="sk-t">&lt;col&gt;.bin Range GET granule</span><span class="sk-d">只下载需要的列，只下载需要的字节范围</span></div>
<p class="sk-cap">颜色从中性走到琥珀再到赤红 —— 对应 S3 IO 代价逐级升高</p>
</div>

关键差别：**CH 不需要「读 footer」这一步**。Parquet 每个文件通常需要先 HEAD 或 GET 尾部解析 footer 才知道里面有什么（生产引擎会缓存 footer 减少重复读）；CH 因为本地 `metadata_path` 维护着全局的 part 清单和文件映射，这一步**本地完成，零 S3 IO**。

### 1.3 优势

**Granule 级精确跳读**

CH 的稀疏主键索引 + granule（默认 8192 行）让跳读粒度比 Parquet row group（128MB）细一个数量级。对主键过滤的查询通常只下载几个 granule，几百 KB 级别 IO。

**完整的索引体系都在 S3 上工作**

- 稀疏 PK 索引、minmax、跳数索引（bloom_filter / ngrambf / tokenbf）、Projection、列级 codec 都是 CH 自带的，不依赖外部湖仓格式
- Parquet 要追平这些能力需要叠 Iceberg/Hudi 这类元数据层

**加索引不用 rewrite 数据**

`ALTER TABLE ... ADD INDEX` 只写新的 `skp_idx_*.idx` 文件到 S3，已有 part 的 `.bin` 不动。Parquet 加 stats 要 rewrite 整个文件。

**零成本枚举 part**

列 part 列表是本地操作（读 metadata_path），秒级。Parquet on S3 要 `LIST` bucket 或依赖 Iceberg manifest，慢且贵。

### 1.4 代价

**对象数爆炸**

一个 50 列的 part 上 S3 就是 100+ 对象（每列 `.bin` + `.mrk2` + 索引 + 元数据）。100T 数据按 1GB/part 算，**总对象数轻松到千万级**。LIST、生命周期管理、备份都贵；merge 高峰期 PUT 容易撞 prefix 限流。

这是后面 5.6 节「Compact part」对冲的根本问题。

**`metadata_path` 是 single point of truth**

S3 上文件名是 hash，没有 footer 可解析。**本地 metadata 丢了，整个 S3 上的对象就是一堆孤儿**——不知道哪个对象属于哪个 part、哪列、哪个 granule。这就是为什么 metadata_path 备份必须 P0：它**是** CH 在 S3 上的「footer」，只是物理上挪到了本地。

**单 part 删除是多次 DELETE**

Drop 一个 part = DELETE 它的 100+ 个对象。生命周期清理的 DELETE 量是 part 数的两个数量级。

**文件名不可读**

S3 上 CH 的对象名都是 hash，没法肉眼区分归属哪张表、哪列、哪个 part。所有对账、回溯、归属判断都得回到本地 `metadata_path` 反查——metadata_path 不仅是数据可达性的单点，**实际上也是唯一可用**的把 S3 对象映射回业务语义的索引（理论上可以通过 S3 inventory + 对象内容自检重建，但代价极高，不算日常可用方案）。

### 1.5 这个布局对后续论点的支撑

这一章的物理事实是后面几乎所有结论的基础：

| 后面的论点 | 对应物理事实 |
|---|---|
| 「完整保留 MergeTree 索引体系」是优势 | 1.2 + 1.3 |
| `metadata_path` 备份必须 P0 | 1.4 |
| 禁 S3 上 merge | 1.1（per-column 多文件 + merge 要 GET/PUT 全套） |
| Compact part 对冲（5.6） | 1.4（对象数爆炸的根因） |
| S3 上文件名不可读不是问题 | 1.4（本来就靠 metadata_path） |

---

## 二、问题归一：四个「不能接受」是同一件事

应用平台对 S3 冷盘的需求其实很朴素——只要给客户一个开关：「过 X 天的数据下沉 S3，存储变便宜，查询慢一点没关系。」

但作为平台方，下面四件事任何一件发生都是事故：

1. 某个用户的大查询**把 S3 拉挂**（或触发限流，导致平台其他业务访问 S3 失败）
2. 大查询**把查询网关拉爆**（buffer 撑满、连接数耗尽，所有用户都连不上）
3. 大查询**把 ClickHouse 打爆**（OOM、影响写入、影响其他用户查询）
4. 大查询**影响到平台之外的业务**用 S3（最严重，跨产品的事故）

很多团队第一反应是「上限流」——给 CK 配 `s3_max_get_rps`、给查询配 `max_memory_usage`、给用户配并发上限。这些方向都对，但解决的不是同一个问题。

**因为限流不是隔离**。限流的实质是「让请求排队」。如果 CK 的请求队列和其他业务的请求队列**汇合在某个共享下游**，CK 一旦堆积几千个请求，那个下游的队尾就是其他业务在等。CK 自己慢没关系，但它会**让所有共享下游的人一起慢**。

四件事归一：**冷查询天然无界**（用户随便选个时间范围就能扫几十 GB），**S3 没有自然背压**（不像 TCP 有流控）。如果队列在某处合流，背压就传过去。

---

## 三、共享资源的几层队列

把 CK 查询 S3 的路径展开，看每一层在哪里「排队」：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/platform-02.light.svg" alt="三、共享资源的几层队列">
<img class="dfig-d" src="/diagrams/platform-02.dark.svg" alt="三、共享资源的几层队列">
</figure>

每一层都有自己的队列：

| 层 | 队列实质 | 满了会发生什么 |
|---|---|---|
| HTTP 连接池 | TCP 连接队列 | 后续请求等待空闲连接 |
| **VPC endpoint / NAT** | **endpoint 带宽 + 连接表** | **endpoint 整个慢下来** |
| AWS 账号 | API quota | 同账号 API 调用慢 |
| S3 bucket | bucket 级聚合 quota | 整桶慢 |
| S3 prefix | per-prefix 令牌桶 | 该 prefix 返回 503 SlowDown |

CK 这个「S3 重度用户」，**任何一层是共享的，就在那一层污染别人**。

最容易被忽略的是 **VPC endpoint / NAT 那一层**。很多团队「独立 bucket 都做了」，但 endpoint 共享，结果业务一上传大文件就被 CK 的 GET 流量挤到超时——AWS PrivateLink endpoint 的带宽是 endpoint 实例级别的，bucket 分得再细也救不了。

---

## 四、第一道防线：队列分开

把队列模型套上来，「隔离」这件事就被收敛成一个简单原则：

> **共享什么都行，只要 CK 的队列和别人的队列不合流。**

物理上是否在同一个 AWS 账号、同一个 VPC、同一台机器，都不重要——只要在共享下游那一层**队列分得开**，CK 在它自己队列里慢慢排队、慢慢限流、慢慢雪崩都没关系，外面无感。

按这个原则筛一遍隔离手段，**只剩两件是必须的**：

| 项 | 必要性 | 解决哪一层队列 |
|---|---|---|
| **独立 S3 bucket**（或独立 prefix） | 必须 | per-prefix 令牌桶分离 |
| **独立 VPC endpoint 或 NAT** | 必须 | 出口带宽 + 连接表分离 |
| 独立 IAM / AK | 推荐（审计、紧急封禁） | 不影响队列 |
| 独立 AWS 账号 / sub-account | 可省 | 数据平面队列已分开 |
| 独立 VPC / subnet | 可省 | 跟 endpoint 重叠 |
| 独立查询网关（chproxy 等） | 可省 | CK 本身是独立进程，自带 HTTP client |

两件加起来基础设施成本极低——一个 bucket + 一个 endpoint，几十块钱/月，跟「独立账号 + 独立 VPC」几千块的方案达到同等隔离效果。

最终物理路径：

<div class="sk sk-lanes">
<div class="sk-lane"><p class="sk-lane-h">业务侧</p>
<div class="sk-box is-ok"><span class="sk-t">业务服务</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box"><span class="sk-t">endpoint-business</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box"><span class="sk-t">s3://business/</span></div>
</div>
<div class="sk-lane"><p class="sk-lane-h">ClickHouse 侧</p>
<div class="sk-box is-cold"><span class="sk-t">CK reader</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box"><span class="sk-t">endpoint-clickhouse</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box"><span class="sk-t">s3://ck-cold/</span></div>
</div>
</div>

这条路径上**没有任何一段共享**。CK 在它自己那条管道上无论怎么排队、限流、雪崩，业务的请求走的是另一条管道，**物理上不可能排到 CK 后面**。

**前提建立完之后**，下面所有 CK 内部参数才有意义——它们承担的不再是「对外隔离」的责任，那部分已经被基础设施接管了。它们承担的是「CK 不雪崩自己」的责任。

---

## 五、CK 内的自我防御

队列已分开的前提下，CK 自己也需要不爆。这部分跟单租户集群的治理逻辑一致，只是目标变了：不再是「别影响别业务」（基础设施搞定了），而是「别影响别的用户、别拖垮自己」。

### 5.1 集群保持同构，靠 profile 和路由做软隔离

理论上更彻底的做法是把副本节点改造成专门跑冷查询的 reader 池——主节点只挂热盘负责写入和热查询，reader 节点挂全套 storage policy 处理冷查询，OOM 也不传染到写入路径。

**但这套架构对运维的代价不小**：

- 节点角色不同 → 配置不同 → 失去「扩容就是加同样的节点」的简洁性
- Storage policy 在主/reader 上不一致 → 表 TTL 规则要按节点角色区分，否则 MOVE 到 cold volume 时主节点上找不到该 volume
- Rolling upgrade 要分两组按顺序滚
- 监控、告警、容量规划都要按节点角色分别维护

**推荐做法：集群保持同构，所有节点配置完全一致，所有节点都挂全套 storage policy**。冷查询和写入物理上共享节点，但靠下面这些机制做软隔离：

- L2 网关层把大查询路由到异步导出（最有效——大查询根本不进集群）
- L3 profile 硬约束（`max_memory_usage=8G` 让单个查询无法 OOM 一台 64G+ 的机器）
- `max_concurrent_queries_for_user=2` + `max_threads=4` 限制冷查询聚合资源占用
- 队列已分开（L4），CK 节点自己慢不会污染别业务

接受的代价是：**一个坏冷查询会让所在节点的写入短暂变慢，但不会让节点 OOM、不会让集群挂**。这个 blast radius 通常可以接受——写入侧本来就有 buffer table 和重试，短暂的几秒慢不会丢数据。

### 5.2 禁止 S3 上 merge，禁止直接落冷

S3 Disk 头号坑：历史数据 INSERT 时如果已经满足 TTL，可能直接落冷盘，然后在 S3 上 merge，GET/PUT/DELETE 一起放大。

```xml
<!-- 全局 MergeTree 默认值 -->
<merge_tree>
  <merge_with_ttl_timeout>86400</merge_with_ttl_timeout>
</merge_tree>
```

```xml
<!-- cold volume: perform_ttl_move_on_insert 和 prefer_not_to_merge
     都是 volume 级属性,放在 storage policy 的 volume 节点下
     (参考官方 programs/server/config.xml 模板) -->
<cold>
  <disk>s3_cold</disk>
  <perform_ttl_move_on_insert>false</perform_ttl_move_on_insert>
  <prefer_not_to_merge>true</prefer_not_to_merge>
</cold>
```

`prefer_not_to_merge` 在官方文档里有警告（「You should not use this setting」），但在 S3 cold volume 上是公认例外——S3 merge 代价（GET 旧 part + PUT 新 part + DELETE 旧 part）远高于「不 merge 留下的小文件」。**只在冷盘开，热温盘开会反噬**。

配套的工程约束：

- 写入路径：所有用户必须走平台 ingest（Kafka / HTTP gateway），平台批量化后写入。**禁止用户直连 INSERT**，否则小 part 海。
- 历史回灌：走平台提供的批量导入 API，背后是「先落本地 staging 表 → merge 到 ≥1GB part → ALTER MOVE PART 到冷盘」。**绝不允许小 part 直接 MOVE 上 S3**。
- 平台代码不生成 mutation 类 SQL（见下）。

#### 为什么禁 mutation

Mutation 是 CK 里「按行重写 part」的机制（`ALTER UPDATE/DELETE`、`MODIFY COLUMN` 改类型、`MATERIALIZE COLUMN`、`DROP COLUMN`、`DELETE FROM` 等都走这条路径）。在 100T 冷数据上，它会触发每个 part 重新读 + 写 + 上传 S3，几周到几个月不等——这是 S3 Disk 上最贵的一类操作。

**加列不是 mutation**（如果 DEFAULT 是常量或 Nullable）——纯元数据操作，瞬时完成，零 S3 IO。这是平台合法的 schema 演化能力。

所以「禁 mutation」具体指：平台 schema-evolution 模块只暴露安全方法（`add_column` 带常量 DEFAULT、`rename_column`、`drop_partition`），**不提供** `modify_column_type` 和 `drop_column`。真要 drop 一列，代码层标记 deprecated 即可，老数据靠 TTL 自然过期。真要改类型，走「加新列 + 双写 + 分区 backfill + 删老列」四步法，作为运维工单流程，不是日常 API。

具体每种 ALTER 在冷数据上的代价见 [《ClickHouse 冷数据三种方案下的 ALTER TABLE 行为》](/clickhouse/cold-storage/alter)。

### 5.3 Profile 硬约束

冷查询走独立 user profile，所有限制必须带 `<constraints>`，否则 `SETTINGS` 能覆盖：

```xml
<profiles>
  <cold_reader>
    <max_memory_usage>8000000000</max_memory_usage>
    <max_memory_usage_for_user>16000000000</max_memory_usage_for_user>
    <max_bytes_to_read>20000000000</max_bytes_to_read>
    <max_rows_to_read>2000000000</max_rows_to_read>
    <max_execution_time>600</max_execution_time>
    <max_concurrent_queries_for_user>2</max_concurrent_queries_for_user>

    <!-- 关键:压小 max_threads -->
    <max_threads>4</max_threads>

    <max_bytes_before_external_group_by>2000000000</max_bytes_before_external_group_by>
    <max_bytes_before_external_sort>2000000000</max_bytes_before_external_sort>
    <join_algorithm>partial_merge,hash</join_algorithm>

    <force_primary_key>1</force_primary_key>
    <force_index_by_date>1</force_index_by_date>
    <readonly>1</readonly>

    <constraints>
      <max_memory_usage><max>8000000000</max></max_memory_usage>
      <max_bytes_to_read><max>20000000000</max></max_bytes_to_read>
      <max_execution_time><max>600</max></max_execution_time>
      <max_threads><max>4</max></max_threads>
    </constraints>
  </cold_reader>
</profiles>
```

几个非显然的点：

- **`max_threads=4` 不是为了控 CPU，是为了控 S3 并发**。单查询的 S3 GET 并发 ≈ `max_threads × parts`，threads 越大越容易把自己的 prefix 打到 503。压小同时解决「内存翻倍」和「自己把自己限流」两件事。
- **`force_index_by_date=1`** 防止业务员写 `WHERE col=x` 这种没时间过滤的查询全分区扫。
- **`max_bytes_before_external_*` 必须开**，否则 ORDER BY/GROUP BY 大查询很容易 OOM。

Spill 路径要给一块独立 SSD 做 `tmp_path`：

```xml
<tmp_path>/data/ch/tmp_ssd/</tmp_path>
```

否则一个大 SORT spill 几十 GB 写在数据盘上，把热盘 IO 打死，反而影响热查询。

### 5.4 S3 客户端自律限速

限速和重试参数**全部放在 S3 disk 定义里**（server config 级），不要放进 `<profiles>`——`s3_retry_attempts` 作为 query/profile setting 在新版本上已经 `MAKE_DEPRECATED_BY_SERVER_CONFIG`，profile 里写它会被忽略或告警。

```xml
<storage_configuration>
  <disks>
    <s3_cold>
      <type>s3</type>
      <endpoint>...</endpoint>
      <s3_max_get_rps>300</s3_max_get_rps>
      <s3_max_get_burst>600</s3_max_get_burst>
      <s3_max_put_rps>100</s3_max_put_rps>
      <s3_max_connections>100</s3_max_connections>
      <!-- 重试次数:必须在 disk 级,不能放 profile -->
      <retry_attempts>3</retry_attempts>
    </s3_cold>
  </disks>
</storage_configuration>
```

最容易反噬的是 **`retry_attempts`**。这个值在 CH 版本之间漂移得很厉害——早期版本默认 10，近期版本默认拉到 500（见 `src/IO/S3Defines.h` 的 `DEFAULT_RETRY_ATTEMPTS`）。**默认值是哪个不重要，关键是 500 这个量级在 503 SlowDown 时会把流量放大几百倍，雪崩稳定复现**。压到 3 让失败快速暴露，配合熔断和退避。

> 注：不同 CH 版本上这些 S3 配置的可放置位置有过迁移（22.x → 23.x → 24.x → 25.x），部分设置的名称和归属层级都变过。落地前**务必**参照你目标 CH 版本的官方文档 + `Settings.cpp` 里的 `MAKE_DEPRECATED_BY_SERVER_CONFIG` 列表复核。

### 5.5 服务器级兜底

```xml
<!-- config.xml 顶层 -->
<max_server_memory_usage_to_ram_ratio>0.8</max_server_memory_usage_to_ram_ratio>
<max_concurrent_queries>50</max_concurrent_queries>
<async_load_databases>1</async_load_databases>
```

`async_load_databases=1` 是 23.8 LTS 引入的启动优化（24.6+ 默认开启，25.3 LTS 上无需配置）——S3 抖动时 server 能起来，不会因为某些表 attach 慢卡死整个集群。**注意它是 server 顶层配置，不在 `<merge_tree>` 下**。

启动期 S3 不可达的救援姿势详见 [《ClickHouse 启动期 S3 行为变迁与故障救援指南》](/clickhouse/troubleshooting/s3-unreachable-startup)，本文不重复。

### 5.6 Compact part：小文件问题的对冲

MergeTree 的 per-column-per-file 设计在本地盘上是优点（独立 IO、独立 codec、灵活加列），到 S3 上变成 PUT 量爆炸——一个 50 列的表，每个 part 上 S3 就是 100+ 个对象（每列 .bin + .mrk2 + 索引 + 元数据）。100T 数据按 1GB/part 算，**总对象数轻松到千万级**，merge 高峰期 PUT 限流（默认每 prefix 3500/s）极容易撞线。

CH 23.x+ 提供了 **Compact part** 格式作为对冲。两个相关参数放在不同层级：

```xml
<!-- config.xml 的 merge_tree 全局配置 -->
<merge_tree>
  <!-- part 小于 1GB 时自动用 Compact 格式
       (所有列合并到一个 data.bin + 一个 data.mrk3) -->
  <min_bytes_for_wide_part>1073741824</min_bytes_for_wide_part>
</merge_tree>

<!-- storage policy 里 cold volume 内,不在 merge_tree 下 -->
<storage_configuration>
  <policies>
    <tiered>
      <volumes>
        <cold>
          <disk>s3_cold</disk>
          <prefer_not_to_merge>true</prefer_not_to_merge>
          <!-- 控制 part 上限,避免单个文件几十 GB -->
          <max_data_part_size_bytes>10737418240</max_data_part_size_bytes>
        </cold>
      </volumes>
    </tiered>
  </policies>
</storage_configuration>
```

效果：100 列的 part 从 200+ 文件压缩到 10 个出头（`data.bin` + `data.mrk3` + 元数据 + 跳数索引）。**对 S3 对象数有一个数量级的优化**，PUT 量同比下降。

代价（在你这个场景下都很小）：

- Compact part 不能 per-column 缓存（没上 cache disk，无影响）
- 单列查询要 Range GET data.bin 里的局部（S3 本来就是 Range GET，几乎无差）
- 旧版本上 vertical merge 行为不同（生产前在你的版本验证）

跟「禁 S3 merge」是配对的优化：

- 禁 merge → part 不在 S3 上 rewrite
- Compact part → 每个 part 在 S3 上的对象数少

两条加起来才是冷盘上 S3 IO 量的真正治理。

---

## 六、Cache 的取舍：默认不上

### Cache 真正解决什么

Cache disk 只解决一件事：**同一段冷数据被反复查时，第二次起不再打 S3**。它不解决大查询防爆、不解决限流、不解决多用户隔离。

所以问「要不要 cache」等价于问「**冷查询有没有重复访问模式**」。

日志平台的冷查询大致三类：

| 模式 | 重复访问 | Cache 收益 |
|---|---|---|
| 故障调查（开一个时间窗反复改 WHERE） | 高 | 大 |
| 批量导出（一次扫一个月） | 接近 0 | 几乎为负（污染 cache） |
| BI / 趋势查询 | 该走预聚合，根本不该打冷盘 | 不适用 |

只有第一类拿得到收益。问题是它占冷查询总量的比例**先验是不知道的**。

### 默认不上的理由

- 多一块要管的盘（会爆、要监控命中率、有过 cache 格式版本不兼容的坑）
- 多一个失败模式（cache 写满时 eviction storm）
- OS page cache 已经免费帮你 cache 了短时间重复访问
- 多挂一块盘等于多一个 disk 故障域，节点恢复时间变长
- 你的用户已经「接受冷查询慢」，cache 不在关键路径

### 决策规则

**Phase 1（上线）**：不配 cache。`s3_cached` 这一层直接不要，cold volume 直接挂 `s3_cold`。

**Phase 2（跑 2-4 周）**：通过 query_log 看冷查询是否有重复访问信号：

```sql
SELECT
  user,
  count() AS queries,
  formatReadableSize(sum(ProfileEvents['ReadBufferFromS3Bytes'])) AS total_s3_bytes,
  uniqExact(query_id) AS unique_qs
FROM system.query_log
WHERE event_time > now() - INTERVAL 7 DAY
  AND ProfileEvents['ReadBufferFromS3Bytes'] > 0
GROUP BY user
ORDER BY sum(ProfileEvents['ReadBufferFromS3Bytes']) DESC;
```

如果某些用户每周复读同一段冷数据多次，且 S3 出口字节大头集中在他们身上，再上 cache 才划算。

**Phase 3（如果要上）**：

```xml
<s3_cached>
  <type>cache</type>
  <disk>s3_cold</disk>
  <path>/data/ch/s3_cache/</path>
  <max_size>500Gi</max_size>
  <max_file_segment_size>8Mi</max_file_segment_size>
  <cache_on_write_operations>0</cache_on_write_operations>
  <enable_cache_hits_threshold>2</enable_cache_hits_threshold>
  <enable_filesystem_cache_log>1</enable_filesystem_cache_log>
</s3_cached>
```

两个关键参数：

- `cache_on_write_operations=0`：part MOVE 上 S3 这步写不进 cache。刚 move 上去的数据短期不会被查，进 cache 纯污染。
- `enable_cache_hits_threshold=2`：要求一个文件被访问 ≥2 次才进 cache。一次性扫描的批量导出不污染 cache。

集群同构架构下，所有节点都开 cache；要避免写入路径污染 cache 就靠 `cache_on_write_operations=0` 这条。

### 反直觉的信号

Cache 命中率长期高到 80%+ **不是好事**——说明「冷数据」实际访问频率很高，分层做错了。这部分应该挪回热盘或加 warm 层，而不是用 cache 假装它是冷的。

---

## 七、业务员防呆：让坏查询写不出来

前面的所有防线（队列分开 + CK 内部）都是**承受坏查询**的。最理想的状态是**坏查询根本进不来**。

日志平台的真实用户构成是：少量懂 SQL 的 SRE/运维 + 大量不懂的业务员。业务员能写出来的 worst case 是：

```sql
SELECT * FROM big_table WHERE timestamp BETWEEN '2024-01-01' AND '2024-06-30' AND message LIKE '%xx%' ORDER BY timestamp LIMIT 1000;
```

没有过滤、没有分页、跨半年。如果直接进 CK，几百 GB 扫描，OOM 或网关 buffer 撑爆是必然。

### 很容易想到的直觉方案

**方案 A：限制时间范围（≤7 天）**
- 容易绕过（写 7 个查询查 49 天）
- 误伤合规月度报表
- **时间范围不是数据量的代理**——高流量表 1 小时可能比低流量表 1 个月还多

**方案 B：时间切片流式返回**
- 适用面有限：`SUM/COUNT/AVG/MIN/MAX` 和 `GROUP BY 时间`可拆；`DISTINCT count`、`quantile`、JOIN、全局 `ORDER BY` 拆不了
- 单片仍可能爆：高流量表 1 小时本身就是 50GB

因此，两条看起来都有道理，但都不完整。

### 真正的方案：执行前预估 + 分级路由

应用层最有效的措施是**不让坏查询开始跑**。预估走得通是因为日志数据有两个天然属性：按时间分区（partition pruning 之后 part 数就定了）、列存压缩比相对稳定。

ClickHouse 自带 `EXPLAIN ESTIMATE`：

```sql
EXPLAIN ESTIMATE
SELECT * FROM logs WHERE event_time > now() - INTERVAL 7 DAY;
```

返回：

```
┌─database─┬─table─┬─parts─┬───rows─┬─marks─┐
│ logs_db  │ logs  │    42 │ 3.2e9  │  390k │
```

三个数：part 数、行数、mark 数。**不实际读数据**，只走主键索引和分区裁剪。

行 → 字节换算（每张表算一次，缓存起来）：

```sql
SELECT
  table,
  sum(data_compressed_bytes) / sum(rows) AS bytes_per_row_compressed
FROM system.parts
WHERE active AND database = 'logs_db'
GROUP BY table;
```

`预估扫描字节 ≈ ESTIMATE.rows × bytes_per_row_compressed × SELECT 列占比`

预估出来之后**三档路由**：

| 预估扫描 | 路由 | SLA |
|---|---|---|
| < 1 GB | 同步执行 | 秒级 |
| 1 GB ~ 100 GB | 自动切片 + 流式 | 首字节秒级、可中断 |
| > 100 GB | 拒绝同步，转**异步导出** | 分钟到小时级，Parquet 落 S3 |

业务员写 `WHERE BETWEEN 半年` → 预估 5 TB → 网关弹窗「此查询过大，已转异步导出，邮件通知下载」。**根本进不了 CK**。

### EXPLAIN ESTIMATE 的边界

这工具有用，但不是万能：

1. **不免费**：要读相关 part 的主键索引和 mark。Part 数几百时秒回，几万 part 时 ESTIMATE 自己几秒。**所有查询都跑 ESTIMATE 是浪费**，要配 fast path——时间窗 ≤1 天 + 有主键过滤的小查询直接放行。
2. **只估外层**：子查询、CTE 看不见。需要 SQL 解析提取「裸的内层表」单独 ESTIMATE。
3. **Distributed 只估本地**：数据路由到不同 shard 评估不准，虽然每个 shard 计算量相对均衡，但对 S3 的读写压力是实打实的。
4. **JOIN 估不准**：右表扫描和 hash 表大小估得很差（新版本上有改善但仍不可靠）。**实践：网关层禁止冷数据 JOIN**，比试图估准 JOIN 容易。
5. **内存估不出来**：只估「读多少」，不估「用多少」。需要叠加 SQL 形状判断：`ORDER BY 非主键`、`DISTINCT/uniq`、高基数 `GROUP BY` 加风险评分。

### 业务员根本不写 SQL

不太懂的用户**最好接触不到 SQL**。给他们 UI：

- 时间范围拖拽，实时显示预估扫描量（「预计扫描 12 GB」）
- 必选字段：用户标识、时间、至少一个过滤条件
- 聚合是预置下拉：count/sum/avg + group by 时间粒度
- 大查询按钮自动变成「提交导出任务」

这条比所有后端限制都管用——**让业务员根本写不出灾难查询**。SQL 入口留给少数高级用户，他们也走同一套预估和路由。

### 网关层落地形状

<figure class="dfig">
<img class="dfig-l" src="/diagrams/platform-04.light.svg" alt="网关层落地形状">
<img class="dfig-d" src="/diagrams/platform-04.dark.svg" alt="网关层落地形状">
</figure>

预估结果可以按 query template + 时间窗缓存 5 分钟，进一步降负载。

### 用户重复提交：去重不是限流

预估和分级路由解决了「单次坏查询」。但实际业务里还有一个更隐蔽的模式——**用户不耐烦反复点**：

```
T=0    用户点查询  → CK 开始跑 query_A，扫 S3
T=10s  没等到结果  → 又点 → query_A' 进入队列
T=20s  还没出来    → 又点 → query_A''
T=30s  query_A 跑完 → query_A' 立刻接着跑 → 用户以为这次"快"
T=40s  query_A' 跑完 → query_A'' 接着跑 → 用户感觉"又慢了"
```

后果：

- 用户感知诡异不稳定（实际同一查询跑了 3 遍）
- CK 完全做了 3 倍冗余工作
- 最糟时多个查询并发跑（profile 的 `max_concurrent_queries_for_user=2` 让第 3 个排队，但前 2 个并发执行，**内存直接翻倍**），雪崩
- 本来一个查询 S3 和 CK 勉强能扛，几个相同查询同时来就崩了

很多人第一反应是「加 `max_concurrent_queries_for_user`」。**这条参数不解决问题**——它是并发控制不是去重，让 5 次重复提交排队执行，CPU/S3 总工作量还是 5 倍，用户体验更差。

**真正需要的是去重**，且必须放在服务端。客户端的 UI debounce 只是「礼貌」，不是「防御」——用户可以重开浏览器、用隐身模式、手机 + PC 同时点、直接调 API 绕过 UI。**任何依赖客户端状态的去重都拦不住**。

#### 一般原则

```
客户端控制 = 礼貌（提升体验、处理大部分无意识误操作）
服务端控制 = 防御（处理剩下 5% + 全部恶意/异常场景）
```

两件事不能互相替代。

#### 落地：五层组合

**L1 UI debounce + 进度提示**（客户端，礼貌层）

提交按钮点击后禁用，直到返回结果、用户取消或超时。配合实时进度（从 `system.processes` 拉 `read_rows / total_rows_approx`），让用户**知道后端在动**——重复点击大部分是「以为卡死了」。

**L2 网关层指纹去重**（服务端，核心防御）

每个查询算指纹：

```
fingerprint = hash(normalized_sql + user_id)
```

**去重边界是 `user_id`，不是 `session_id` / `connection_id`**。这样同一用户在 5 个浏览器同时点、用 curl 直连 API、手机 PC 同操作，都映射到同一指纹。

网关维护 `in_flight_queries: fingerprint → {query_id, stream_handle, ref_count}`，新查询进来：

```python
def submit_query(sql, user):
    fp = fingerprint(sql, user)
    if fp in in_flight:
        # attach 到现有流,引用计数+1
        in_flight[fp].ref_count += 1
        return attach_to_stream(in_flight[fp].stream_handle)
    query_id = uuid()
    in_flight[fp] = start_query(sql, query_id)
    return in_flight[fp].stream_handle
```

`user_id` 从 auth token 取，客户端没法伪造。

**L3 `replace_running_query` 兜底**（CK 层）

两条都是 profile / 用户级 setting，放在 `users.xml` 的 profile 下：

```xml
<profiles>
  <default>
    <replace_running_query>1</replace_running_query>
    <replace_running_query_max_wait_ms>5000</replace_running_query_max_wait_ms>
    <cancel_http_readonly_queries_on_client_close>1</cancel_http_readonly_queries_on_client_close>
  </default>
</profiles>
```

客户端把 `query_id` 设为 `{user_id}_{fingerprint}_{5min_bucket}`——同一用户 5 分钟内点 3 次相同查询，`query_id` 相同，CK 自动杀掉旧的接受新的。

**`query_id` 必须由后端构造**，不能让客户端自己提交，否则客户端能改的就一定会被改。

**L4 `cancel_http_readonly_queries_on_client_close=1`**（CK 层，跟 L3 在同一个 profile 里）

客户端断开 TCP（关页签、刷新），CK 立刻 KILL 查询。防的是「用户走了 CK 还在为他烧 S3 流量」。

**L5 大查询异步化**（架构层，根治）

回到分级路由：**预估 >1GB 强制转异步**。异步路径上「重复点击」天然不存在——用户提交后立刻拿到 task_id，没有「同步等待」这个状态，就没有不耐烦的机会。

#### 完整组合

| 层 | 性质 | 部署位置 | 必要性 |
|---|---|---|---|
| L1 UI debounce + 进度提示 | 礼貌 | 客户端 | 强烈建议 |
| L2 网关指纹去重（key = user + sql） | **防御** | 服务端 | **必须** |
| L3 `replace_running_query` | 防御兜底 | CK | **必须**（一行配置） |
| L4 `cancel_http_readonly_queries_on_client_close` | 防御 | CK | **必须**（一行配置） |
| L5 大查询异步化 | 防御（消除同步等待） | 网关 + 异步系统 | **必须** |

L3 + L4 是两行配置，立刻部署。L1 大部分前端框架自带 debounce。L2 是工程化的核心。L5 在主架构里已经有了。

#### 一个隐藏陷阱：取消语义

L2 的 attach 模式下：

- 用户点 1 次：1 个流，1 个底层查询
- 又点 1 次：网关 attach 到同一查询，2 个流监听
- 用户点「取消」：取消的是**这个用户的流**，还是**底层查询**？

正确语义：取消用户自己的流；只有当**所有 attach 的流都被取消**时，才 KILL 底层查询。这是引用计数的事，漏了会出现「用户都取消了，CK 还在烧 S3」。

#### 一个可选优化：租户级软去重

同租户不同 user 同时点相同 SQL（运营团队 3 个人同时排查同一起事故），技术上是 3 个不同 user_id，但对 CK 是同样的工作做 3 遍。

可以加一层 tenant 维度的去重：相同 tenant + 相同 SQL（指纹不含 user_id），第 2 个起 attach 到第 1 个的流。

前提：该查询不涉及 user 级 row policy。如果查询结果跟 user 身份相关，跨 user attach 就泄露权限了。

判断要不要做看 telemetry，租户内重复查询占比 >20% 时值得做。这是**优化不是防御**——不做平台也能跑。

---

## 八、完整防御层次

四层防御，每层独立工作：

<div class="sk sk-tiers">
<div class="sk-box"><span class="sk-t">用户查询</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-ok"><span class="sk-t">L1 UI 层</span><span class="sk-d">业务员不写 SQL；预估扫描量可见；大查询自动转异步</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">绕过 UI 直接走 SQL</span></div>
<div class="sk-box is-warm"><span class="sk-t">L2 网关层</span><span class="sk-d">SQL 解析 + EXPLAIN ESTIMATE；三档路由（同步 / 切片 / 异步）；单用户并发 ≤ 3、流式回吐</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">绕过预估</span></div>
<div class="sk-box is-hot"><span class="sk-t">L3 CK 防御层</span><span class="sk-d">集群同构 + Profile constraints（内存 / 扫描 / 超时 / max_threads）；Spill 强制；禁 S3 merge、禁 mutation</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">CK 自己挂</span></div>
<div class="sk-box is-cold"><span class="sk-t">L4 物理隔离层</span><span class="sk-d">独立 bucket + 独立 endpoint；CK 自己排队不影响别的业务</span></div>
<p class="sk-cap">每一层拦不住的，交给下一层 —— 箭头标的是「穿透方式」，不是正常流程</p>
</div>

**任何一层挂了，下面那层还顶得住**：

- 业务员的 `WHERE BETWEEN 半年` 在 L1 被 UI 拦
- 高级用户绕到 SQL 接口，L2 预估拦
- 旧 API 没接预估，L3 profile 的 `max_bytes_to_read` 拦
- L3 配置漏了，L4 物理隔离保证至少不污染别业务

**L4 是核心论点所在**——前面三层都是「内部自治」，L4 才是「对外不传染」的保证。前三层挂了平台自己难受；L4 挂了别业务跟着难受。优先级一定是 L4 第一。

---

## 九、不要做的事

按「队列分开 + 简化模型」的原则，下面这些常见做法可以不做：

| 做法 | 不做的理由 |
|---|---|
| 加 warm 层 | 两层足够。多一层多一套 TTL 规则、监控、迁移逻辑，价值有限。用户用钱投票决定保留期 |
| 在共享 endpoint 上叠 bucket 隔离 | 队列没分开，bucket 分得再细也救不了。endpoint 不分等于没分 |
| 让业务员直连写 SQL | 一个 SELECT * 能毁所有努力。给 UI，预估可见，结构化构造 |
| 默认上 cache disk | 增加失败模式，价值取决于查询模式。先不上，看 telemetry 决定 |
| 对所有查询跑 EXPLAIN ESTIMATE | 浪费。fast path 跳过小查询 |
| 开 zero-copy replication 想省 S3 存储 | 22.8+ 已默认禁用，24.x 文档明确「不推荐生产」。接受副本各存一份 |
| 让用户配置 TTL 表达式 | 模板化：UI 上选保留 30/90/365 天，不让自由写 |
| 为了省一份冷数据而做非常规改造 | S3 价格本身已经很便宜，副本各存一份带来的可用性远比省的钱重要 |

---

## 结语

这篇文章的论点其实只有一句：**作为应用平台必须提供 S3 冷盘按钮时，关键不是「限制用户用得多狠」，而是「让 CK 在它自己的队列里慢慢工作」**。

所有其他事情——CK 内部的限流、profile、spill、cache、预估、UI 引导——都是这个原则的展开。它们解决的是「CK 自己不雪崩」，不是「CK 不影响别人」。前者靠工程治理，后者靠基础设施隔离，**两件事不能混为一谈**。

前几篇文章的态度是「S3 Disk 这条路不好走，能转 Parquet 就转」。这篇文章的态度是「S3 Disk 这条路要走稳，前提是认清队列模型，然后把基础设施和工程治理分两层处理」。

两个态度不矛盾：

- 如果你能选——优先考虑 BACKUP（合规归档）或 [chDB + S3 Parquet](/clickhouse/cold-storage/chdb)（湖仓化），把 S3 从 CK 运行时关键路径上摘掉
- 如果你不能选，按本文的原则把 S3 Disk 跑稳

最后一句：**冷盘的承诺不是「冷数据查得跟热数据一样快」，而是「冷数据存得起、查得到、慢得不影响别人」**。把这句话刻在产品文档里，比任何参数都管用。

---

## 系列其他文章

- [冷热分层四部曲导读](/clickhouse/cold-storage/)
- [ClickHouse S3 Disk 实战：机制、踩坑与治理](/clickhouse/cold-storage/s3-disk)
- [ClickHouse 启动期 S3 行为变迁与故障救援指南](/clickhouse/troubleshooting/s3-unreachable-startup)
- [ClickHouse 超冷归档：BACKUP/RESTORE 为什么适合金融政企](/clickhouse/cold-storage/backup-restore)
- [从 S3 Disk 到 Parquet：ClickHouse 冷数据为什么要脱离主线](/clickhouse/cold-storage/parquet)
- [ClickHouse 冷数据三种方案下的 ALTER TABLE 行为](/clickhouse/cold-storage/alter)
- [chDB + S3 Parquet：把冷数据变成可查询资产的架构实战](/clickhouse/cold-storage/chdb)
