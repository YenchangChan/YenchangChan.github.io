# 冷热分层

ClickHouse 的冷热分层，不是调一个参数、配一个 storage policy 就完事的。

真做起来，至少要回答四件不相干的事：数据怎么从热盘沉到对象存储；S3 不可达的时候 ClickHouse 怎么启动、怎么恢复；几乎不查的超冷数据怎么归档；冷数据要给别的引擎用的时候，怎么从 ClickHouse 里脱出来。

## 这一栏和「一次讲透」有什么区别

两栏都往深里写，区别在于要不要在几个方案里挑一个。

这一栏讲的是一个架构问题，有好几条路线，重点在取舍：选错了代价是什么，到什么规模该换路。[一次讲透](/clickhouse/deep-dive/) 讲的是一个功能，一条线走到底，重点在机制。

## 这一栏怎么写

每条路线我都尽量写清楚它什么时候是对的，什么时候会反咬你一口。

只说优点的方案介绍没什么用。这几条路线我都在生产上用过或者评估过，踩到的坑比官方文档上写的多。每篇的结论都带着适用的规模区间，超出了区间就别照搬。

## 文章

<div class="posts">

<a class="post" href="/clickhouse/cold-storage/s3-disk">
<span class="post-t">S3 Disk：把对象存储当慢盘用，会遇到什么</span>
<span class="post-d">原生方案，改造成本最低。Disk / Volume / Storage Policy 的模型、part 在 S3 上的组织方式、为什么生产上通常需要 cache disk，以及规模上来后哪些默认行为会变成坑。</span>
</a>

<a class="post" href="/clickhouse/troubleshooting/s3-unreachable-startup">
<span class="post-t">S3 不可达时起不来 <em>（在「生产排障」栏）</em></span>
<span class="post-d">改错 endpoint 加 <code>skip_access_check</code> 的偏方，22.8 上好使，23.x 就不灵了。这篇按事故复盘写，所以放在排障栏。</span>
</a>

<a class="post" href="/clickhouse/cold-storage/backup-restore">
<span class="post-t">BACKUP/RESTORE 超冷归档：为什么适合金融政企</span>
<span class="post-d">留存 7 年、一年查一两次、提单后 N 个工作日返回也能接受。在这种约束下，在线可查反倒成了成本。</span>
</a>

<a class="post" href="/clickhouse/cold-storage/parquet">
<span class="post-t">从 S3 Disk 到 Parquet：冷数据为什么要脱离主线</span>
<span class="post-d">不让 ClickHouse 管冷数据。导出成开放格式，代价是数据格式迁移和查询路径改造。</span>
</a>

<a class="post" href="/clickhouse/cold-storage/alter">
<span class="post-t">冷数据上的 ALTER TABLE：三种方案各会发生什么</span>
<span class="post-d">方案选定之后，schema 怎么改才不出事。同一句 ADD COLUMN，可能一瞬间就完，也可能折腾几周。</span>
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

## 怎么选

先按查询频率看：

| 冷数据查询频率 | 推荐路线 |
|---|---|
| 经常在线查 | S3 Disk，配合治理和 reader 隔离 |
| 偶尔查，能接受慢 | S3 Disk 或 Parquet |
| 很少查，一年几次 | BACKUP/RESTORE |
| 要跨引擎共享 | Parquet 或 Iceberg |
| 只为合规长期保留 | BACKUP/RESTORE 或导出到企业备份体系 |

再按数据保留期看：

| 保留期 | 推荐思路 |
|---|---|
| 90 天以内 | 本地盘或本地 + warm 层 |
| 90 天到 1 年 | S3 Disk 或 Parquet |
| 1 到 3 年 | Parquet + 生命周期管理 |
| 3 年以上 | BACKUP/RESTORE、Glacier、NAS/磁带等归档体系 |

还要看团队自己的情况：

| 团队情况 | 更合适的路线 |
|---|---|
| 小团队，想少改架构 | S3 Disk |
| 有 DBA/备份体系，合规驱动 | BACKUP/RESTORE |
| 有数据平台团队，多引擎共用 | Parquet / Iceberg |
| 已经被 S3 Disk 运维成本拖住 | 逐步迁出到 Parquet 或 BACKUP |

最后是数据规模，这个放到下面的业界案例里一起说。

## 三条路线各在哪个象限

把三条路线放到一张平面上，横轴是查询频率，纵轴是开放性：

<div class="sk">
<p class="sk-quad-y"><span>← 查询频率低</span><span>查询频率高 →</span></p>
<div class="sk-quad">
<div class="sk-box is-cold"><span class="sk-t">Iceberg / Lakehouse</span><span class="sk-d">低频查询 + 开放格式</span><span class="sk-pin">Iceberg / Hudi</span></div>
<div class="sk-box is-cold"><span class="sk-t">Parquet 甜点区</span><span class="sk-d">高频查询 + 开放格式</span><span class="sk-pin">S3 Engine + Parquet</span></div>
<div class="sk-box is-mute"><span class="sk-t">BACKUP 甜点区</span><span class="sk-d">低频查询 + 锁定 ClickHouse</span><span class="sk-pin">BACKUP/RESTORE</span></div>
<div class="sk-box is-warm"><span class="sk-t">S3 Disk 甜点区</span><span class="sk-d">高频查询 + 锁定 ClickHouse</span><span class="sk-pin">S3 Disk</span><span class="sk-pin">本地 MergeTree</span></div>
</div>
<p class="sk-quad-x"><span>上排：开放 / 跨引擎 ↑</span><span>↓ 下排：锁定 ClickHouse</span></p>
<p class="sk-cap">上半开放格式、下半锁定 ClickHouse；左半低频、右半高频</p>
</div>

三条路线各占一块，选型的时候先看清楚自己的数据落在哪一块。

## 业界是怎么做的

下面几个案例是我从工程博客、ClickHouse Meetup、技术大会分享和社区讨论里整理的，数字会随时间变，要引用的话最好回原文再看一眼。

Cloudflare 的工程博客多次披露过，他们用 ClickHouse 处理 HTTP analytics、DNS、安全分析这些业务，整体是 PB 级。方案是自建加 R2（他们自家的 S3 兼容存储），做了大量预聚合（rollup）来减少对冷数据的查询，副本各存一份，不靠 zero-copy，宁可多几个小集群也不堆一个大集群。R2 出网免费，跨集群读冷数据的成本很低。

B 站、滴滴、携程算是百 TB 级 ClickHouse 集群的典型。共同的做法有三层 storage policy（NVMe → SSD → 对象存储），TTL 触发下沉的时间避开业务高峰，自己写缓存预热脚本，冷数据上基本不让做 mutation。滴滴早期用过 zero-copy，踩了不少坑，后来干脆不省这个存储钱，副本各存各的。

Sentry 的 Snuba 管着几十 PB 的错误追踪数据，他们绕开了 S3 disk，老数据要查就走 BigQuery 或者离线任务，不在 ClickHouse 里查。规模到了这个量级，干脆不在 ClickHouse 里做冷热分层，反而更省事。

字节跳动是在 S3 Disk 模式扛不住以后，自研了存算分离的引擎，也就是后来开源的 ByConity。它分成无状态的 Server、Worker（Virtual Warehouse）、基于 FoundationDB 的 Catalog，以及 HDFS/S3/OSS 存储几层。从给 ClickHouse 一路打补丁到自己造一个新引擎，算是「S3 Disk 之后该怎么办」的一个公开答案。

金融、政企、运营商这边，从我接触过的项目看，监管报送、风控日志、交易流水、审计留痕这些场景，冷数据归档用 BACKUP/RESTORE 的多，用 Parquet 的少。原因跟技术先不先进没关系，这些单位排优先级的时候，合规、可控、能放进现有的备份体系，排在在线可查前面。

把这些案例放在一起，规模和架构大致是这么对应的：

| 数据规模 | 推荐架构 | 关键挑战 | 代表案例 |
|---|---|---|---|
| < 100 TB | ClickHouse 单集群 + S3 Disk | 几乎无，参数调对就能跑 | 大多数中小业务 |
| 100 TB ~ 1 PB | ClickHouse 多集群 + S3 Disk + 严格治理 | 资源管控、网络隔离、运维流程 | B 站、滴滴、携程 |
| 1 PB ~ 10 PB | 混合架构（S3 Disk 温层 + Parquet/BACKUP 冷层）| 双引擎运维、台账管理、数据格式转换 | Sentry、Uber 部分场景 |
| > 10 PB | SharedMergeTree（Cloud）/ ByConity / Iceberg | 部署复杂度、生态适配、迁移成本 | Cloudflare、字节 ByConity |

S3 Disk 最合适的区间是 100TB 到 1PB，低于这个用不上这一整套工程，高于这个复杂度就压不住了。

## 最后

S3 Disk、BACKUP、Parquet 并不互斥。更常见的成熟做法是分层组合着用：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/cold-storage-02.light.svg" alt="冷热分层的组合形态：热数据本地盘，温数据 S3 Disk，冷数据 Parquet 或 BACKUP">
<img class="dfig-d" src="/diagrams/cold-storage-02.dark.svg" alt="冷热分层的组合形态：热数据本地盘，温数据 S3 Disk，冷数据 Parquet 或 BACKUP">
</figure>

冷热分层要回答的是三个问题：哪些数据还归查询系统管，哪些只需要归档，哪些应该导出成开放格式给别人用。这三个问题答完了，再去选盘和 storage policy。
