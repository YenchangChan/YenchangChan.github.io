# 冷热分层

ClickHouse 冷热分层不是一个参数问题，也不是「配个 storage policy 就完事」。

它至少包含四类互不相同的问题：

- 数据怎么从热盘下沉到对象存储
- S3 不可达时 ClickHouse 怎么启动和恢复
- 几乎不查的超冷数据怎么归档
- 冷数据要跨引擎使用时，怎么脱离 ClickHouse 主线

## 这一栏和「一次讲透」的分界

两栏都往深里写，区别在于**要不要在几个方案之间做选择**：

- **这一栏**：一个架构命题，多条路线，重点在**取舍** —— 选错路线的代价是什么，以及什么规模下该换路。
- **[一次讲透](/clickhouse/deep-dive/)**：一个功能，一条线到底，重点在**机制**。

简单说：**要在几条路里挑一条 → 看这里；只有一个东西但不知道它怎么回事 → 看那边。**

## 这一栏的写法

每条路线都写清楚**它什么时候是对的，什么时候会反咬你**。

只说优点的方案介绍没有价值 —— 四条路线我都在生产上用过或评估过，踩到的坑比官方文档上写的多。下面每篇的结论都附上适用规模区间，超出区间就别照搬。

## 文章

<div class="posts">

<a class="post" href="/clickhouse/cold-storage/s3-disk">
<span class="post-t">S3 Disk：把对象存储当慢盘用，会遇到什么</span>
<span class="post-d">原生方案，改造成本最低。Disk / Volume / Storage Policy 的模型、part 在 S3 上的组织方式、为什么生产上通常需要 cache disk，以及规模上来后哪些默认行为会变成坑。</span>
</a>

<a class="post" href="/clickhouse/troubleshooting/s3-unreachable-startup">
<span class="post-t">S3 不可达时起不来 <em>（在「生产排障」栏）</em></span>
<span class="post-d">启动期 attach 行为跨版本变严，一个广为流传的救命偏方是怎么失效的。这篇按事故复盘写，所以放在排障栏。</span>
</a>

<a class="post" href="/clickhouse/cold-storage/backup-restore">
<span class="post-t">超冷归档：BACKUP/RESTORE 为什么适合金融政企</span>
<span class="post-d">留存 7 年、一年查一两次、可以接受提单后 N 个工作日返回 —— 在这类约束下，「在线可查」不是优点而是成本。</span>
</a>

<a class="post" href="/clickhouse/cold-storage/parquet">
<span class="post-t">从 S3 Disk 到 Parquet：冷数据为什么要脱离主线</span>
<span class="post-d">不让 ClickHouse 管冷数据。导出成开放格式，代价是数据格式迁移和查询路径改造。</span>
</a>

<a class="post" href="/clickhouse/cold-storage/alter">
<span class="post-t">三种冷数据方案下，ALTER TABLE 会发生什么</span>
<span class="post-d">横向补充：方案选定之后，schema 怎么演化才不出事。同一句 ADD COLUMN，可能是瞬时操作，也可能是几周的灾难。</span>
</a>

<a class="post" href="/clickhouse/cold-storage/platform">
<span class="post-t">应用平台的 S3 冷盘：队列分开是前提</span>
<span class="post-d">如果一定要用 S3 Disk：五层共享队列在哪里合流，以及四层防御该怎么搭。</span>
</a>

<a class="post" href="/clickhouse/cold-storage/chdb">
<span class="post-t">chDB + S3 Parquet：把冷数据变成可查询资产</span>
<span class="post-d">Parquet 路线的完整落地形态：数据布局、导出验证、生命周期、查询微服务，以及读路由怎么分段。</span>
</a>

</div>

---

## 如何选择

可以先按查询频率选：

| 冷数据查询频率 | 推荐路线 |
|---|---|
| 经常在线查 | S3 Disk，配合治理和 reader 隔离 |
| 偶尔查，能接受慢 | S3 Disk 或 Parquet |
| 很少查，一年几次 | BACKUP/RESTORE |
| 要跨引擎共享 | Parquet 或 Iceberg |
| 只为合规长期保留 | BACKUP/RESTORE 或导出到企业备份体系 |

再按数据保留期选：

| 保留期 | 推荐思路 |
|---|---|
| 90 天以内 | 本地盘或本地 + warm 层 |
| 90 天到 1 年 | S3 Disk 或 Parquet |
| 1 到 3 年 | Parquet + 生命周期管理 |
| 3 年以上 | BACKUP/RESTORE、Glacier、NAS/磁带等归档体系 |

再按组织能力选：

| 团队情况 | 更合适的路线 |
|---|---|
| 小团队，想少改架构 | S3 Disk |
| 有 DBA/备份体系，合规驱动 | BACKUP/RESTORE |
| 有数据平台团队，多引擎共用 | Parquet / Iceberg |
| 已经被 S3 Disk 运维成本拖住 | 逐步迁出到 Parquet 或 BACKUP |

最后按数据规模看成熟度：

| 数据规模 | 推荐架构 |
|---|---|
| < 100 TB | ClickHouse 单集群 + S3 Disk |
| 100 TB ~ 1 PB | ClickHouse 多集群 + S3 Disk + 严格治理 |
| 1 PB ~ 10 PB | 混合架构（S3 Disk 温层 + Parquet/BACKUP 冷层）|
| > 10 PB | SharedMergeTree（Cloud）/ ByConity / Iceberg |

S3 Disk 的甜点区是 **100TB ~ 1PB**——下面「业界路线参考」会给出各档对应的真实案例。

---

## 三方案的定位象限

把三条路线放到二维平面上，能看到它们各自的「甜点区」：

<div class="sk">
<p class="sk-quad-y"><span>← 查询频率低</span><span>查询频率高 →</span></p>
<div class="sk-quad">
<div class="sk-box is-cold"><span class="sk-t">Iceberg / Lakehouse</span><span class="sk-d">低频查询 + 开放格式</span><span class="sk-pin">Iceberg / Hudi</span></div>
<div class="sk-box is-cold"><span class="sk-t">Parquet 甜点区</span><span class="sk-d">高频查询 + 开放格式</span><span class="sk-pin">S3 Engine + Parquet</span></div>
<div class="sk-box is-mute"><span class="sk-t">BACKUP 甜点区</span><span class="sk-d">低频查询 + 锁定 ClickHouse</span><span class="sk-pin">BACKUP/RESTORE</span></div>
<div class="sk-box is-warm"><span class="sk-t">S3 Disk 甜点区</span><span class="sk-d">高频查询 + 锁定 ClickHouse</span><span class="sk-pin">S3 Disk</span><span class="sk-pin">本地 MergeTree</span></div>
</div>
<p class="sk-quad-x"><span>上排：开放 / 跨引擎 ↑</span><span>↓ 下排：锁定 ClickHouse</span></p>
<p class="sk-cap">三方案的定位差异 —— 上半开放格式、下半锁定 ClickHouse；左半低频、右半高频</p>
</div>

横轴是「查询频率」，纵轴是「开放性」。**三方案不是替代关系，是各自落在不同象限**——选型本质是判断你的数据落在哪个象限。

---

## 业界路线参考

下面整理几个有公开资料的真实案例，供选型时参照——信息来自工程博客、ClickHouse Meetup 演讲、技术大会分享和社区讨论的整理，**具体数字和实践可能随版本与时间演化，引用前请回到原始来源核实**。

**Cloudflare**——根据其工程博客的多次披露，处理 HTTP analytics、DNS、安全分析等业务，整体规模在 PB 级。方案是自建 + R2（自家 S3 兼容存储），关键设计包括大量预聚合（rollup）减少冷数据查询、副本各存一份不依赖 zero-copy、宁可多个小集群也不堆一个大集群。R2 出网免费让跨集群读冷数据成本极低。

**B 站 / 滴滴 / 携程**——百 TB 级 ClickHouse 集群的典型代表。共同实践包括三层 storage policy（NVMe → SSD → 对象存储）、TTL 触发的下沉时间避开业务高峰、自研缓存预热脚本、冷数据基本不允许 mutation。滴滴早期用过 zero-copy 踩了不少坑，后来选择「不省存储钱，副本各存各的」。

**Sentry / Snuba**——几十 PB 错误追踪数据的玩家，**绕开了 S3 disk**：老数据查询走 BigQuery 或离线任务，不在 ClickHouse 里查。这是个有意思的信号——到一定规模后，「不在 ClickHouse 里做冷热分层」反而是更优解。

**字节跳动 ByConity**——规模超过 S3 Disk 模式扛不住后，自研了存算分离引擎（已开源为 ByConity）。三层架构：Server（无状态）+ Worker（Virtual Warehouse）+ Catalog（基于 FoundationDB）+ Storage（HDFS/S3/OSS）。从 ClickHouse 一路打补丁到自研新引擎的演进路径，代表了「S3 Disk 之后该怎么办」的一个公开答案。

**金融 / 政企 / 运营商**——从我接触过的项目看，监管报送、风控日志、交易流水、审计留痕这类场景，冷数据归档更多采用 BACKUP/RESTORE 而不是 Parquet。原因不是技术先进性问题，而是这些组织的价值排序里「合规、可控、可融入既有备份体系」高于「在线可查」。这观察来自项目经验而非行业普查。

**规模演进路径**——综合上面这些案例，能看到一个相对清晰的能力—规模匹配关系：

| 数据规模 | 推荐架构 | 关键挑战 | 代表案例 |
|---|---|---|---|
| < 100 TB | ClickHouse 单集群 + S3 Disk | 几乎无——参数调对就能跑 | 大多数中小业务 |
| 100 TB ~ 1 PB | ClickHouse 多集群 + S3 Disk + 严格治理 | 资源管控、网络隔离、运维流程 | B 站、滴滴、携程 |
| 1 PB ~ 10 PB | 混合架构（S3 Disk 温层 + Parquet/BACKUP 冷层）| 双引擎运维、台账管理、数据格式转换 | Sentry、Uber 部分场景 |
| > 10 PB | SharedMergeTree（Cloud）/ ByConity / Iceberg | 部署复杂度、生态适配、迁移成本 | Cloudflare、字节 ByConity |

S3 Disk 的甜点区是 **100TB ~ 1PB**。低于这个杀鸡用牛刀，高于这个工程复杂度爆炸。

---

## 一句话总结

S3 Disk、BACKUP、Parquet 不是互斥关系。更常见的成熟形态是分层组合：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/cold-storage-02.light.svg" alt="一句话总结">
<img class="dfig-d" src="/diagrams/cold-storage-02.dark.svg" alt="一句话总结">
</figure>

冷热分层真正要解决的不是「数据放哪里」，而是「什么数据还属于查询系统，什么数据只属于归档系统，什么数据应该成为开放格式资产」。
