---
title: ClickHouse 集群机房搬迁实战
---

# ClickHouse 集群机房搬迁实战

> 机房搬迁难的不是技术，是它同时牵涉数据迁移、shard 拓扑、元数据对象、业务双写和对账验证 —— 任何一环没考虑到，都可能在切流当天翻车。不讨论灾备。
>
> **阅读对象**：单集群几节点到几十节点、要做跨云或跨机房搬迁的团队。

---

## 写在前面

机房搬迁是 ClickHouse 运维里最重的工程之一。不是因为技术难度有多高，而是它牵涉到**数据迁移、shard 拓扑、元数据对象、业务双写、对账验证**等多个维度，任何一个环节没考虑到都可能在切流当天翻车。

这篇文章把「中小客户跨云机房搬迁」这个场景下的可落地方案、决策依据、实操陷阱讲清楚。**不讨论灾备**——灾备的指标体系（RPO/RTO）和搬迁完全不同，混在一起讲会模糊重点。

适用对象：单集群规模在几节点到几十节点、单表数据量从 GB 到 PB 级、表数量从几十张到几千张的团队。头部互联网公司的极端规模场景不在讨论范围内。

文中标注的特性版本号（如 `22.8+`）以社区版为准，实操前请对照自己集群的实际版本。

---

## TL;DR：一分钟拿到结论

如果你没时间读全文，先记住这几条：

1. **默认方案就是 `INSERT INTO ... SELECT FROM remote()`**。只要数据量能在迁移窗口期内一次性灌完（中小客户通常 < 30 TB），别上 `clickhouse-backup`，那是杀鸡用牛刀。
2. **表多但量不大（1000+ 表 / 5~10 个 DB）时，首选 `BACKUP DATABASE`**，编排成本一条命令搞定。
3. **Sharding key 是数据正确性约束，不只是性能优化**。合并型引擎（`ReplacingMergeTree` 等）的 sharding key 必须是 `ORDER BY` 字段的函数，改错会让 `FINAL` 静默返回错误结果。
4. **PB 级表 + reshard 是季度级工程**，能用规划手段（节点数一致约束 + 数据生命周期管理）绕开就绕开。中小客户的 PB 级总量里，真正需要 reshard 的热数据往往只有 100 TB 级。
5. **元数据对象（MV / 字典 / UDF / 分布式表）有严格的迁移顺序**，顺序错了会触发连锁失败。

下面展开。

---

## 一、可落地的迁移方案盘点

业界常见的方案大致 6 种，按「侵入度 / 停机窗口 / 数据规模」维度排：

| 方案 | 适用规模 | 是否需停写 | 增量同步 | 备注 |
|---|---|---|---|---|
| `INSERT INTO ... SELECT FROM remote()` | < 30 TB | 视情况 | 否 | 最简单 |
| `clickhouse-backup` + S3 | TB ~ 百 TB | 一般可接受短窗口 | 支持 incremental | 社区事实标准 |
| 原生 `BACKUP/RESTORE` 到 S3 | 同上 | 同上 | 支持 incremental | 22.8+，官方推荐 |
| 双写 + 历史回填 | 任意 | 不停写 | 应用侧保证 | 改造成本最高 |
| 加副本到新机房（Replicated） | 任意 | 不停写 | ZK/Keeper 自动 | 跨云不推荐 |
| `FREEZE` + 物理 part 拷贝 + `ATTACH PARTITION` | 任意 | 分区粒度短停 | 增量靠新分区 | 同版本同 schema 才稳 |

`clickhouse-copier` 在 23.3 deprecated，24.x 已移除，**新项目不要选**。

---

## 二、跨云机房搬迁的推荐路径

跨云搬迁的核心约束是**网络**——专线带宽不便宜、抖动比同机房严重得多。倾向于不依赖底层数据复制，走应用层双写。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-01.light.svg" alt="二、跨云机房搬迁的推荐路径">
<img class="dfig-d" src="/diagrams/datacenter-migration-01.dark.svg" alt="二、跨云机房搬迁的推荐路径">
</figure>

**为什么不推荐「加副本法」**：跨云共享 Keeper 风险大，RTT 通常 30~50ms，写入吞吐会断崖下跌，session timeout 也容易出问题。除非已经在跑跨云 multi-DC Keeper（罕见），否则别走。

---

## 三、四阶段搬迁流程

<div class="sk sk-phases">
<div class="sk-box"><div class="sk-ph-h"><span class="sk-ph-n">1</span><span class="sk-t">准备</span><span class="sk-ph-when">D-7 ~ D-1</span></div><ul><li>B 集群建好，schema 同步</li><li>全量快照（BACKUP / INSERT SELECT）</li><li>验证全量</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-warm"><div class="sk-ph-h"><span class="sk-ph-n">2</span><span class="sk-t">双写</span><span class="sk-ph-when">D ~ D+N</span></div><ul><li>应用切双写</li><li>增量回填补齐快照之后的数据</li><li>持续对账</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-warm"><div class="sk-ph-h"><span class="sk-ph-n">3</span><span class="sk-t">灰度切读</span><span class="sk-ph-when">D+N+1 ~ D+N+7</span></div><ul><li>读流量灰度切到 B（10% → 50% → 100%）</li><li>观察查询正确性与延迟</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-ok"><div class="sk-ph-h"><span class="sk-ph-n">4</span><span class="sk-t">全量切换</span><span class="sk-ph-when">D+N+8</span></div><ul><li>停 A 集群写入</li><li>保留 A 一周作回退保险</li></ul></div>

</div>

### 配置一致性的边界

「两个集群的配置需要一模一样」是个常见误区。准确地说：

- **必须一致**：表 schema、`PARTITION BY`、`ORDER BY`、TTL、字段 codec、`storage_policy` 名称
- **必须不一致**：`<remote_servers>` 集群拓扑、`macros` 里的 `{shard}/{replica}`、ZK/Keeper 路径前缀（千万别两边共用，否则数据会被当成同一张 Replicated 表互相拉，乱套）
- **可以不一致**：副本数、分片数、机器规格、`background_pool_size` 这类性能 server setting

### 双写的实现路径

双写的本质是让一条数据同时落到两个集群。**实现方式取决于数据是从哪来的**：

| 数据来源 | 双写实现方式 |
|---|---|
| 业务应用直接 INSERT | 应用层改造，封装 DAO 让其同时写两个集群（推荐异步双写 + 失败重试队列） |
| 通过 Kafka 流入 | 在外部消费层（Vector / Kafka Connect / 自研服务）订阅同一 topic，用两个独立的 consumer group 分别写 A 和 B |
| 通过 ETL 批量写入 | ETL job 改造为输出两份，或加一个反向同步 job |

**避免使用 ClickHouse 自带的 `Kafka Engine` 做双写**。它在故障恢复、schema 演进、错误处理上的运维成本远超表面看起来的简单：一个 replica 一个 consumer，replica 挂了消费就停；schema 变更要 detach/attach；错误处理粗糙；故障恢复时数据可能丢/重。生产环境推荐外部消费 + 标准 INSERT 协议。

应用层双写的关键约束：

- **异步而非同步**：写 B 失败不能阻塞业务，落地到补偿队列后续重试
- **同一条数据双写要带相同的 dedup key**：利用 `insert_deduplicate`（query setting，默认 1）+ `replicated_deduplication_window`（merge tree setting，默认 1000），同 block 哈希在 24h 内会自动去重
- **保留切流前的对账窗口**：双写至少跑 7 天后再切流

#### 合并型引擎跨集群 INSERT SELECT 的 FINAL 陷阱

如果源表是 `ReplacingMergeTree` / `CollapsingMergeTree` 等合并型引擎，**跨集群 INSERT SELECT 必须显式 FINAL**：

```sql
-- ❌ 错误：拷过去的是未去重的多版本数据
INSERT INTO b.user_state_distributed
SELECT * FROM remote('a-host', a.user_state_distributed, ...);

-- ✅ 正确：先在源端去重再拷贝
INSERT INTO b.user_state_distributed
SELECT * FROM remote('a-host', a.user_state_distributed, ...) FINAL;
```

不加 FINAL 会拷贝所有历史版本。如果新旧集群 sharding key 完全一致，这倒不影响最终正确性（B 集群依然能 FINAL 出对的结果）；但如果 sharding key 有任何变化，多版本数据可能被打散到不同 shard，FINAL 再也无法复原——**这是一个静默错误**。（原理见第五节。）

### 对账方法

按 sharding key 的桶分别 count + hash：

```sql
-- 在 A 集群跑
SELECT
    cityHash64(user_id) % 5 AS new_shard,  -- 按【新】sharding 规则分桶
    count() AS cnt,
    sum(sipHash64(user_id, event_id, event_time)) AS sig
FROM db.events_distributed
WHERE event_date BETWEEN '2026-04-01' AND '2026-04-28'
GROUP BY new_shard
ORDER BY new_shard;
```

`sipHash64` 是 ClickHouse 方言，PG/MySQL 没有。注意 `sum(hash)` 对**重复数据不敏感**（`A=B+B` 和 `A+B=B` 看不出来），如果是 ReplacingMergeTree 之类还得加 `count(distinct ...)`。

---

## 四、表的分类与迁移策略匹配

千万不要用一套流程套所有表。**分区策略本身编码了数据量预期**，不同特征的表迁移姿势完全不同。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-03.light.svg" alt="四、表的分类与迁移策略匹配">
<img class="dfig-d" src="/diagrams/datacenter-migration-03.dark.svg" alt="四、表的分类与迁移策略匹配">
</figure>

迁移启动前先扫一遍：

```sql
SELECT
    database, table,
    sum(bytes_on_disk) / pow(1024, 3) AS gb,
    sum(rows) AS rows,
    countDistinct(partition) AS partitions
FROM system.parts
WHERE active
GROUP BY database, table
ORDER BY gb DESC;
```

按结果分类：

| 分类 | 特征 | 迁移策略 |
|---|---|---|
| 大表 | 时间分区 + 数据量大（TB+） | 双写 + 增量回填，按分区切片 |
| 中表 | 任意分区 + GB ~ 百 GB | 物理拷贝（FREEZE/clickhouse-backup）一把过 |
| **小表** | **不分区 / 非时间分区，通常 < 100 GB** | **一次性 INSERT SELECT 全量灌过去，再开双写** |
| 配置表 | 字典、维度表（MB 级） | 跟着代码走，不需要专门迁移 |

### 小表「先迁后双写」的好处

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-04.light.svg" alt="小表「先迁后双写」的好处">
<img class="dfig-d" src="/diagrams/datacenter-migration-04.dark.svg" alt="小表「先迁后双写」的好处">
</figure>

- **没有「增量回填」环节**，全量在双写启动前就同步完了
- **对账简单**，不需要担心快照与双写之间的时间窗口漂移
- **失败可重试**：`TRUNCATE` 重来即可

### 关于「无分区表」的迷思

很多人担心无分区表难迁。其实不必：

> **一旦设计这张表不按时间分区，说明设计者认定它不会无限膨胀。** 如果它真涨到了 TB 级，那是设计错误，不是迁移难题——迁移阶段不应该为修复设计错误买单。

无分区表通常 GB 到几十 GB，一次性 INSERT SELECT 几分钟到几小时搞定。真正的例外场景（少数用 hash 分区的大表）在第九节单独讲。

---

## 五、Sharding Key：不只是优化，更是约束

在讨论 reshard 之前，必须先把 sharding key 的三重作用讲清楚。**很多团队只把它当性能优化考虑，结果在迁移时才发现它其实是数据正确性的硬约束**。

### 作用一：写入分布（最基础）

让数据均匀落到各个 shard，避免单点热点。这是教科书级的认知，不展开。

### 作用二：合并型引擎的去重正确性（最容易翻车）

对于**合并型引擎**（`ReplacingMergeTree`、`CollapsingMergeTree`、`VersionedCollapsingMergeTree`、`SummingMergeTree`、`AggregatingMergeTree`），sharding key **必须**是 `ORDER BY` 字段的函数。

原因：FINAL 和后台 merge 都是 **per-shard** 的，只能去重/合并同一个 shard 内的数据。如果同一个 dedup key 的多个版本被分散到不同 shard，FINAL 永远查不出去重后的正确结果。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-05.light.svg" alt="作用二：合并型引擎的去重正确性（最容易翻车）">
<img class="dfig-d" src="/diagrams/datacenter-migration-05.dark.svg" alt="作用二：合并型引擎的去重正确性（最容易翻车）">
</figure>

```sql
-- ✅ 正确：sharding key 是 ORDER BY 字段的函数
CREATE TABLE user_state_local (
    user_id UInt64,
    state String,
    updated_at DateTime
)
ENGINE = ReplicatedReplacingMergeTree(updated_at)
ORDER BY user_id;

CREATE TABLE user_state_distributed AS user_state_local
ENGINE = Distributed(cluster, db, user_state_local, cityHash64(user_id));

-- ❌ 错误：用 rand() 打散，FINAL 失效
ENGINE = Distributed(cluster, db, user_state_local, rand());
```

| 引擎 | 去重/合并依据 | sharding key 必须满足 |
|---|---|---|
| `ReplacingMergeTree` | `ORDER BY` 全部字段 | 是 ORDER BY 字段的函数 |
| `CollapsingMergeTree` | `ORDER BY` + `sign` | 是 ORDER BY 字段的函数 |
| `VersionedCollapsingMergeTree` | `ORDER BY` + `sign` + `version` | 是 ORDER BY 字段的函数 |
| `SummingMergeTree` | `ORDER BY` 字段 | 是 ORDER BY 字段的函数 |
| `AggregatingMergeTree` | `ORDER BY` 字段 | 是 ORDER BY 字段的函数 |
| `MergeTree` / `ReplicatedMergeTree` | 不去重 | 任意 |

补充一个相关坑：`OPTIMIZE TABLE ... FINAL` 也是 per-shard 的，**不会跨 shard 去重**。即使 OPTIMIZE 了源表，sharding key 错了一样救不回来。

### 作用三：Colocate Join（性能优化的关键）

两张表如果用**相同的 sharding key**，则相同 join key 的数据会落在同一个 shard，分布式 join 可以优化为 **per-shard 本地 join**，性能差距可以是数量级的。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-06.light.svg" alt="作用三：Colocate Join（性能优化的关键）">
<img class="dfig-d" src="/diagrams/datacenter-migration-06.dark.svg" alt="作用三：Colocate Join（性能优化的关键）">
</figure>

启用本地 join 需要在查询时显式声明（query setting）：

```sql
SELECT o.*, i.qty
FROM orders_distributed AS o
JOIN order_items_distributed AS i USING (order_id)
SETTINGS distributed_product_mode = 'local';
```

`distributed_product_mode` 默认值随版本演化：21.x 及以前是 `allow`（自动广播右表，悄悄退化为分布式 JOIN），22.x+ 改成 `deny`（多表都是 distributed 时直接报错）。很多团队从老版本升级上来、sharding key 设计本来是错的（依赖广播跑通），升级后查询全报错。**生产环境一定要在表设计阶段就规划好 colocate，不要依赖 `allow` 模式偷懒。**

实测亿级表 JOIN 亿级表，colocate 比广播快 **10~30 倍**——这也是 ClickHouse JOIN 性能口碑的真正成因。很多「ClickHouse JOIN 性能不行」的吐槽，根因都是没用 colocate。

#### Colocate Join 对迁移的影响

这个作用让 sharding key 的「锁定」约束**进一步加强**：

- 不仅每张表自己的 sharding key 不能随便改
- **一组互相 join 的表必须保持同步变更** —— 改一张就要改所有相关表
- 跨集群迁移 reshard 时，必须**一组表一起 reshard**，且新旧 sharding key 表达式行为一致

实际场景里，一个业务领域通常有 5~10 张表共享同一个 sharding key（如 `cityHash64(user_id)`）。reshard 时这些表是一个不可分割的工作单元。

好消息是：**只要保持「两张表用同一个 sharding key 表达式」这个原则，shard 数从 3 变 5 不破坏 colocate**——同一个 user_id 在 B 集群仍然落在同一个 shard，只是 shard 编号变了。这个约束是「表达式相同」，不是「shard 编号相同」。

坏消息是：**colocate 退化是无声的**。失效后查询从 2 秒退化到 60 秒，业务方往往切流后几天才反馈，那时已经很难回滚。**切流前必须有针对性的性能回归测试**——挑出业务里所有的 JOIN 查询，跑一遍对比 A、B 集群的耗时。

### 三重作用对迁移决策的连锁影响

把这三个作用合起来看，sharding key 在迁移决策中的地位远比「性能优化」严肃：

| 作用 | 影响 | 改错的后果 |
|---|---|---|
| 写入分布 | 数据均匀性 | 性能问题，可观察、可调整 |
| Colocate JOIN | 查询性能 | **静默退化**：查询变慢但不报错，需协同变更多张表 |
| 合并型引擎去重 | 数据正确性 | **静默错误**：FINAL 返回错误结果 |

重要性从上到下递增，修正难度也递增——前两个有性能信号能发现，第三个完全静默，可能在迁移后几个月才被业务方发现「统计数据怎么对不上」。

这意味着：

1. **表设计阶段一旦选定 `ReplacingMergeTree` + 某个 ORDER BY，sharding key 实际上已经被锁死**为 ORDER BY 字段的函数。后续迁移想换 sharding key？只有同时改 dedup key 才行——这是表语义层面的变更，不是单纯的物理重分布
2. **物理拷贝路线天然保持 shard 数和 sharding key 不变，对合并型引擎反而是最安全的**——这是物理拷贝路线的一个被忽视的优势
3. **reshard 不是单表决策，是表组决策**——一组 colocate join 的表要么一起 reshard，要么都不动

---

## 六、Resharding：跨云迁移的硬骨头

如果新旧集群 shard 数不一样，**物理拷贝路线全部失效**。原因：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-07.light.svg" alt="六、Resharding：跨云迁移的硬骨头">
<img class="dfig-d" src="/diagrams/datacenter-migration-07.dark.svg" alt="六、Resharding：跨云迁移的硬骨头">
</figure>

shard 2 的 part 文件里只有 `% 3 == 1` 的数据。如果新集群是 5 shard，正确归属应该是 `% 5`，**part 必须重新读出来重新路由**，没有捷径。

### 双写自然完成 reshard

如果走双写路线，**reshard 是免费送的**：

```sql
-- 在 B 集群执行（B 是 5 shard，A 是 3 shard）
INSERT INTO db.events_distributed
SELECT * FROM remoteSecure(
    'a-cluster-distributed-host:9440',
    'db.events_distributed',
    ...
)
WHERE user_id BETWEEN 0 AND 1000000
SETTINGS
    max_execution_time = 0,
    max_insert_threads = 8,
    parallel_distributed_insert_select = 2;  -- query setting，22.8+
```

**重点**：写 Distributed 表会按新 sharding 规则分发，这一来一回就完成了 reshard。

### PB 级 reshard 的工程现实

1 PB 跨云专线 10 Gbps 实际传 15 天起步，加上 egress 费用、CPU、内存、merge 压力——**这是季度级工程**。

建议团队定一条工程纪律：

> **超过 1 PB 的表，新旧集群必须保持 shard 数一致。** 扩容只能通过加副本或升级机器规格。表设计阶段做 5 年容量规划，确保 shard 数够用。如必须 reshard，按独立项目立项。

更精细的分级：

| 表规模 | sharding 变更政策 |
|---|---|
| < 10 TB | 自由 reshard，迁移走 INSERT SELECT 即可 |
| 10 TB ~ 100 TB | reshard 需要架构评审，预留 1~2 周迁移窗口 |
| 100 TB ~ 1 PB | reshard 需要立项，给出 3 年规划 |
| **> 1 PB** | **默认禁止 reshard**，节点数必须一致 |

这样的好处是把 reshard 的代价显式化、决策可控，而不是迁移时才发现要还的债。结合第五节讲的 sharding key 三重约束，这条纪律的根本依据不只是工程量，更是「sharding key 一旦确定就承载了多张表的数据正确性 + JOIN 拓扑两个契约」。

---

## 七、为什么中小客户的 PB 级迁移其实是 100 TB 级工程

这个推论需要把三件事的因果讲清楚：**数据量分布、查询访问模式、sharding key 的作用**。

### 第一步：中小客户的真实数据画像

头部互联网（字节、阿里）的 ClickHouse 集群是**日增 PB 级**——总量是流量驱动，每天写入量本身就大。这种规模下，热数据就是 PB 级，没有「压缩问题规模」的余地。

中小客户完全不同：

| 业务类型 | 日增量 | 5 年累积 | 典型集群规模 |
|---|---|---|---|
| 中型 SaaS | 10~100 GB/天 | 几十 TB | 3~6 节点 |
| 中型 ToC | 100 GB~1 TB/天 | 几百 TB | 6~12 节点 |
| 大型 ToC | 1~10 TB/天 | PB 级 | 20~50 节点 |

**关键观察**：中小客户出现 PB 级表时，几乎都是 **2~3 年累积**的结果——日增 GB 到 TB 级，乘以时间维度堆上来的。**总量大不等于活跃**。

### 第二步：实际查询的访问模式

ClickHouse 在 OLAP 场景的典型查询模式：

- **业务监控、运营大盘**：查最近 24 小时 / 7 天 / 30 天
- **用户行为分析**：查最近 30~90 天
- **季度同比、年度报表**：查最近 1 年
- **历史回溯、合规审计**：查 1~3 年前的数据，**频次极低**（每月几次）

中小客户的实际系统里，**90%+ 的查询命中最近 6~12 个月的数据**——这部分是「热数据」。

### 第三步：sharding key 的实际作用

回到第五节讲的三重作用：写入分布、合并型引擎去重、colocate join。这三个作用**全部针对「被频繁访问的数据」**。

- 写入分布：冷数据已经停写，分布是否均匀已无意义
- 合并型引擎去重：冷数据状态已稳定，不再有新版本
- Colocate join：冷数据极少参与查询，join 性能不再敏感

如果一类查询执行频次极低（比如 2 年前的历史回溯），那这部分数据用什么 sharding 都无所谓——全表扇出查一次的代价业务能接受。

### 因果链闭合

<div class="sk sk-steps">
<div class="sk-box"><span class="sk-t">中小客户 PB 级表</span><span class="sk-d">数年累积</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">业务自然规律</span></div>
<div class="sk-box"><span class="sk-t">90%+ 查询命中最近 6~12 个月数据</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">sharding key 服务于活跃访问</span></div>
<div class="sk-box"><span class="sk-t">sharding key 的三重作用只对热数据有意义</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">冷数据不需要新 sharding</span></div>
<div class="sk-box"><span class="sk-t">冷数据可以保持旧 sharding，或归档到对象存储</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">问题规模缩小一个数量级</span></div>
<div class="sk-box is-accent"><span class="sk-t">真正参与 reshard 的只有 100 TB 级热数据</span></div>
<p class="sk-cap">结论不是「PB 级不用 reshard」，是「需要 reshard 的从来不是那个 PB」</p>
</div>

### 落地策略：分层迁移

| 数据分层 | 占比 | 迁移方式 |
|---|---|---|
| 热数据（近 6~12 月） | 10~20% (~100 TB) | 双写 + 全量回填 + 走新 sharding |
| 温数据（6~24 月） | 20~30% (~300 TB) | 物理拷贝（保持旧 sharding）或归档 |
| 冷数据（2 年+） | 50~70% (~600 TB) | 归档到对象存储（Parquet/Iceberg），通过 `s3()` 表函数按需查询 |

**前提**：业务方接受冷数据查询走慢路径（秒级 → 十几秒级）。这是个**产品决策**，不是技术问题。如果业务承诺「所有历史数据秒级响应」，这个策略就破产，回到老路。

### 配套技术能力

ClickHouse 原生支持 TTL 跨盘（22.8+ 稳定）：

```sql
CREATE TABLE db.events_local (...)
ENGINE = ReplicatedMergeTree(...)
ORDER BY ...
TTL event_date + INTERVAL 6 MONTH TO DISK 'cold_s3',
    event_date + INTERVAL 2 YEAR DELETE;
```

归档查询直接从对象存储读：

```sql
SELECT count() FROM s3(
    'https://archive.oss/events/year=2022/*.parquet', 'Parquet'
) WHERE user_id = 12345;
```

---

## 八、不同规模的方案选型

### 10 TB 以下：INSERT SELECT 直推

10 TB 以下别想多了，最优解是直接 INSERT SELECT。**`clickhouse-backup` 是杀鸡用牛刀**——工具部署、S3 配置、权限调试、版本兼容排查的复杂度溢价不划算。

```sql
INSERT INTO db.events_local
SELECT * FROM remoteSecure('a-host:9440', 'db.events_local', 'user', 'pwd')
SETTINGS max_execution_time=0, max_insert_threads=8;
```

时间预估（10 TB）：

| 网络 | 实际时间 |
|---|---|
| 同机房万兆 | 3.5~4 小时 |
| 跨云千兆专线 | 36~40 小时 |
| 跨云万兆专线 | 3.5~4 小时 |

判据是「**能否在窗口期内一次性灌完**」，不是数据量本身。同机房万兆 30 TB 都能从容跑完。

INSERT SELECT 的另外几个隐性优势：走 SQL 协议，**跨大版本兼容范围极宽**（19.x → 24.x 平推都见过），物理拷贝的 part 格式版本差异问题它没有；失败重试简单，`TRUNCATE` 重来即可；写 distributed 表还能顺手完成 reshard。

### 千表场景：BACKUP DATABASE 才是首选

1000+ 张表通常分布在 5~10 个 DB 里。整个 DB 一把过：

```sql
-- 22.8+ 原生 BACKUP
BACKUP DATABASE app, analytics, ods
TO S3('https://bucket/migrate/full', 'ak', 'sk')
SETTINGS compression_method='zstd';

-- B 集群
RESTORE DATABASE app, analytics, ods
FROM S3('https://bucket/migrate/full', 'ak', 'sk');
```

或 `clickhouse-backup`：

```bash
clickhouse-backup create_remote full_$(date +%Y%m%d) \
    --tables="app.*,analytics.*,ods.*"
clickhouse-backup restore_remote full_20260429
```

**DATABASE 级备份的优势**（相比逐表 INSERT SELECT）：

- 一条命令，无需自己写编排
- 依赖顺序自动处理（普通表 → MV → 视图）
- 元数据完整：UDF（24.x+）、字典定义都包含在内
- 失败可恢复：增量备份能续上未传完的部分

**仍需手工处理的部分**（BACKUP 不管）：

- ZK path 重写
- 分布式表里的 cluster 名（是 server config，不在 backup 里）
- users / roles：22.8 原生 BACKUP 不含，24.x 起 `BACKUP ALL` 才包含
- 字典 XML 文件：放 `/etc/` 下的 XML 配置不在 BACKUP 里

**不适合的场景**：业务库 + 测试库混在一个 DB（用 `--tables` 过滤）、跨大版本 21.x → 24.x（part 格式不兼容，回退到 INSERT SELECT）、需要 reshard（用双写）。

> 千表场景的真痛点其实不是迁数据慢，而是**编排和验证**的复杂度：串行跑太慢、并发跑容易打爆连接、单表失败定位难，尤其是 **schema 漂移**——生产环境里「我们就 800 张表」扫一遍发现 1247 张，里面一堆死表、临时表（`Memory`/`Log` 引擎重启就没）。所以千表迁移的第一步永远是**扫表清单 + 业务确认死表**，把 1000 拆小，再决定用 BACKUP DATABASE 还是逐表调度。

### PB 级 + reshard：S3 中转 + s3Cluster

PB 级跨云直连 reshard 不现实（专线打满半个月、egress 费用百万），用对象存储中转：

<div class="sk sk-steps">
<div class="sk-box"><span class="sk-t">A 集群</span><span class="sk-d">老 sharding</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">① 导出 Native 格式，按 A shard × 时间切片</span></div>
<div class="sk-box"><span class="sk-t">A 云对象存储</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">② 跨云 CRC（对象存储自带）</span></div>
<div class="sk-box"><span class="sk-t">B 云对象存储</span></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg><span class="sk-arl">③ INSERT INTO b.distributed SELECT FROM s3()</span></div>
<div class="sk-box is-accent"><span class="sk-t">B 集群</span><span class="sk-d">新 sharding —— reshard 在这一步自动完成</span></div>
<p class="sk-cap">数据不经过任何中转机器，跨云复制由对象存储自己做</p>
</div>

```sql
-- A 集群每个 shard 直接导出本地数据到对象存储
INSERT INTO FUNCTION s3(
    'https://a-bucket.oss/migrate/shard0/events_{_partition_id}.native.zst',
    'ak', 'sk', 'Native'
)
SELECT * FROM db.events_local
WHERE event_date BETWEEN '2026-04-01' AND '2026-04-30';

-- B 集群从 S3 并行读取，写入 distributed 表自动 reshard
INSERT INTO db.events_distributed
SELECT * FROM s3Cluster(
    'b_cluster',
    'https://b-bucket.oss/migrate/*.native.zst',
    'ak', 'sk', 'Native'
)
SETTINGS
    max_insert_threads = 16,
    parallel_distributed_insert_select = 2;
```

`s3Cluster` 函数 22.3+ 支持。`parallel_distributed_insert_select` 22.8+ 才稳定。

为什么这样更好：跨云流量走对象存储跨区复制（同账户跨 region 通常比 egress 便宜得多）；A 端只读一次、B 端只写一次，CPU 减半；每个 S3 对象独立，天然断点续传。

---

## 九、表无分区 / 非时间分区怎么办

这是搬迁里最常被问的一个问题。按第四节的逻辑，**这种表通常本来就不大**（GB 到几十 GB），全量一次性灌完就好，不需要增量。

如果确实是个例外（少数大表用 hash 分区，比如多租户场景），技术手段：

### 全量阶段：按 partition_id 平行

```bash
for pid in $(clickhouse-client -q "SELECT DISTINCT partition_id FROM system.parts WHERE table='events' AND active FORMAT TSV"); do
    # FREEZE + 拷贝 + ATTACH PARTITION ID '$pid'
done
```

`ATTACH PARTITION ID '<id>'` 用 partition_id（而非分区表达式值），对 hash 分区特别方便。

物理拷贝（FREEZE → rsync → ATTACH）的几个必踩坑：rsync 过去后必须 `chown -R clickhouse:clickhouse`，否则 ATTACH 失败；detached 目录下若有同名残留 part，ATTACH 会跳过；Replicated 表用 `ATTACH PARTITION ON CLUSTER` 或只在一个副本 ATTACH 让其余副本走 ZK 自动 fetch；跨 major 版本（21 → 24）part 格式差异大，别用物理拷贝。

### 增量阶段：part diff

`clickhouse-backup create --diff-from-remote=xxx` 比对的是 **part 文件级别的 diff**，不依赖分区维度。哪怕分区不按时间，它也能正确做出「只包含新 part」的增量备份。

这是为什么千表 + 中等数据量场景推荐 `clickhouse-backup`——它把「按分区/按时间增量」抽象成了「按 part 增量」。

### 对账：按主键范围分桶

```sql
SELECT
    intDiv(cityHash64(user_id), pow(2, 56)) AS bucket,  -- 256 个桶
    count() AS cnt,
    sum(sipHash64(user_id, event_id, event_time)) AS sig
FROM db.events
GROUP BY bucket
ORDER BY bucket;
```

---

## 十、元数据对象的迁移

数据迁移之外，还有一堆「非表对象」要处理。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-10.light.svg" alt="十、元数据对象的迁移">
<img class="dfig-d" src="/diagrams/datacenter-migration-10.dark.svg" alt="十、元数据对象的迁移">
</figure>

### 物化视图：双写期最大的坑

物化视图是**两个对象**：MV 定义（INSERT 触发器）+ 底层存储表。

**带 `TO` 子句的 MV**（推荐写法）：底层是个普通命名表，按普通表迁即可。

**不带 `TO` 的 MV**（老写法）：底层表是自动生成的 `.inner_id.xxxx`，没法直接 attach 过去，只能「建好 MV → 重新 populate」。

#### 关键陷阱：双写期 MV 状态会两边各算一份

如果 MV 是聚合（`SummingMergeTree` / `AggregatingMergeTree`），双写期 A 和 B 会**独立累加**——切流时新集群的 MV 数据可能和源表对不上。

**最稳的做法**：切流前 B 集群把 MV 底层表清空，从源表重新算一次：

```sql
TRUNCATE TABLE db.events_daily_local;
INSERT INTO db.events_daily_local
SELECT toDate(event_time) AS day, count() FROM db.events GROUP BY day;
```

不能依赖双写期间的累积结果。

#### 不要用 POPULATE

`CREATE MATERIALIZED VIEW ... POPULATE` 在创建时把源表全量数据跑一遍。但 **POPULATE 期间源表新写入的数据会丢失**——这是官方明确警告的。

正确姿势：先迁底层 TO 表的数据，再创建 MV 定义（不带 POPULATE），让 MV 只负责未来增量。

### 字典：源在哪决定迁移方式

字典的「数据」在外部源里，迁移策略**完全取决于源在哪**。

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-11.light.svg" alt="字典：源在哪决定迁移方式">
<img class="dfig-d" src="/diagrams/datacenter-migration-11.dark.svg" alt="字典：源在哪决定迁移方式">
</figure>

跨云迁移时最常见的疏漏是：字典源在 A 云内网，B 云连不到（如 MySQL/PG 源）。迁移前务必在 B 集群机器上验证网络可达（`nc -zv mysql.internal 3306`）。

#### 推荐用 named_collections（22.12+）

```sql
SOURCE(MYSQL(NAME 'mysql_app_config'))
```

`mysql_app_config` 在 server config 里定义。迁移时 DDL 不用改、B 集群定义同名 named_collection 即可——**最干净的迁移姿势**，把环境差异隔离在配置里。

#### 字典定义存放在哪

| 方式 | 存放位置 | 迁移 |
|---|---|---|
| `CREATE DICTIONARY` SQL | 系统数据库 | 跟着 schema 走 |
| `*.xml` 配置文件 | `/etc/clickhouse-server/dictionaries.d/` | **必须**手动拷贝到 B 集群所有节点 |

XML 方式容易在迁移时被遗漏，专门检查：

```sql
SYSTEM RELOAD DICTIONARIES;
SELECT name, status, last_exception FROM system.dictionaries;
-- status 应该全是 LOADED
```

### 分布式表：cluster 名必须改

```sql
-- A 集群
CREATE TABLE db.events_distributed AS db.events_local
ENGINE = Distributed('a_cluster_3shards', db, events_local, cityHash64(user_id));

-- B 集群（cluster 名要改）
CREATE TABLE db.events_distributed AS db.events_local
ENGINE = Distributed('b_cluster_5shards', db, events_local, cityHash64(user_id));
```

cluster 名是 server config 里的，不会自动迁过来。

迁移前确认 A 集群没有积压的异步分发：

```sql
SELECT * FROM system.distribution_queue;  -- 应该是空的
SYSTEM FLUSH DISTRIBUTED db.events_distributed;
```

`SYSTEM FLUSH DISTRIBUTED` 会强制把异步队列里的数据 push 完。20.5+ 支持。

### UDF

| 类型 | 迁移内容 | 注意 |
|---|---|---|
| SQL UDF（21.10+） | 纯元数据，`CREATE FUNCTION` 重建 | `/var/lib/clickhouse/user_defined/` 也可直接 rsync |
| Executable UDF（21.11+） | XML 配置 + 可执行脚本 + 依赖 | 部署到 B 集群**所有节点**；注意架构（x86 / ARM） |

Executable UDF 是最容易遗漏的，因为它超出了 ClickHouse 本身的范畴（脚本部署、依赖安装、CPU 架构兼容都得管）。

### 标准迁移顺序

<div class="sk sk-phases">
<div class="sk-box"><div class="sk-ph-h"><span class="sk-ph-n">1</span><span class="sk-t">基础对象</span></div><ul><li>集群拓扑配置（remote_servers）</li><li>named_collections</li><li>users / roles / quotas</li><li>UDF 配置 + 脚本</li><li>字典 XML 配置</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.3 6, 11.7 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box"><div class="sk-ph-h"><span class="sk-ph-n">2</span><span class="sk-t">表 + 数据</span></div><ul><li>普通表 schema</li><li>MV 底层 TO 表（当作普通表建）</li><li>数据迁移（双写 + 回填）</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 11.6 6, 10.4 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-warm"><div class="sk-ph-h"><span class="sk-ph-n">3</span><span class="sk-t">衍生对象</span></div><ul><li>SQL UDF</li><li>字典（CREATE DICTIONARY）</li><li>物化视图（<strong>不要</strong> POPULATE）</li><li>普通视图</li><li>分布式表（改 cluster 名）</li></ul></div>
<div class="sk-arw"><svg class="sk-ar" width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M11 1 C 10.5 6, 11.5 12, 11 18"/><path d="M6.5 13.5 C 8 17, 10 20.5, 11 22.5"/><path d="M15.5 13.5 C 14 17, 12 20.5, 11 22.5"/></svg></div>
<div class="sk-box is-ok"><div class="sk-ph-h"><span class="sk-ph-n">4</span><span class="sk-t">切流前最终检查</span></div><ul><li>SYSTEM RELOAD DICTIONARIES</li><li>SYSTEM RELOAD FUNCTIONS</li><li>字典 status 全部 LOADED</li><li>MV 一致性对账</li><li>分布式表 SELECT 测试</li></ul></div>
<p class="sk-cap">顺序不能换：衍生对象依赖基础对象，MV 依赖它的 TO 表</p>
</div>

**关键顺序**：UDF 和字典在表创建前就位；MV 必须在源表迁完且双写稳定**之后**创建；分布式表最后；视图最后。

---

## 十一、决策框架总览

把所有决策维度汇总成一张二维矩阵：

| | 表少（< 50） | 表中等（50~500） | 表多（500+） |
|---|---|---|---|
| **总量小（< 10 TB）** | 手写 INSERT SELECT | INSERT SELECT + for 循环 | **`BACKUP DATABASE` 一把过** |
| **总量中等（10~100 TB）** | INSERT SELECT 切片 | INSERT SELECT + 调度 | `clickhouse-backup` + 双写 |
| **总量大（> 100 TB）** | 双写 + 增量回填 | 双写 + 调度 | 双写 + 调度（项目级工程） |

需要 reshard 时：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/datacenter-migration-13.light.svg" alt="十一、决策框架总览">
<img class="dfig-d" src="/diagrams/datacenter-migration-13.dark.svg" alt="十一、决策框架总览">
</figure>

90% 的中小客户场景都会落在 **INSERT SELECT 直推** 或 **BACKUP/RESTORE** 上。

---

## 结论

1. **数据生命周期管理是迁移规划的前置工作**，不是迁移完才考虑的事。能把 PB 压到 100 TB，工程难度差一个数量级。

2. **不要用一套流程套所有表**。配置表做增量切片、事件日志做全量对账，工程量会爆炸。按表的「成熟度阶段」匹配迁移策略：配置/维度表一把灌完、业务核心表双写回填、归档表物理拷贝。

3. **Sharding key 是数据正确性约束，不只是性能优化**。合并型引擎的 sharding key 必须是 ORDER BY 字段的函数，否则 FINAL 静默返回错误结果；colocate join 要求一组表共享同一 sharding key——这两条决定了 sharding key 一旦定下就难以单表变更。

4. **MV 在双写期会两边各算一份**，状态独立累加。切流前一定要从源表重新算一次 MV 底层表，不能依赖双写期间的累积结果。

5. **PB 级表 + reshard 是季度级工程**。用规划手段（节点数一致约束 + 数据生命周期管理）避免，比用技术手段硬扛省事得多。

6. **元数据对象的迁移顺序很重要**：UDF/字典先于表、MV 后于源表稳定双写、分布式表最后建。顺序错了会触发连锁失败。
