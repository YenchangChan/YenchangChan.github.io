---
title: Doris 与 StarRocks 的存算分离：元数据放在哪里，版本如何可见
---

# Doris 与 StarRocks 的存算分离：元数据放在哪里，版本如何可见

把文件放到 S3 上之后，计算节点就可以随便删了吗？如果节点正在合并数据，合到一半挂了，新文件已经上传了一部分，下一次查询到底读哪份？

看 Doris 和 StarRocks 的存算分离，我觉得从这个问题往下追，比先列一张功能表更容易理解。两边都让计算节点保留本地缓存，把持久数据放到共享存储；真正需要拆开看的，是谁记录文件属于哪个版本，又是谁决定这个版本能不能查。

这里讨论原生内部表，Doris 以 4.x 架构为主，StarRocks 以 4.1 Shared-data 文档为主。通过 Catalog 查询外部湖表、存算一体下把冷数据迁到 S3，都不属于本文的范围。尤其 Doris 的 Storage Policy 冷热分层，不能和 Cloud Mode 混在一起。

## 数据在 S3，元数据不一定都在

先只画持久状态和主要职责，省掉缓存、心跳等连线：

```text
StarRocks Shared-data

FE：表结构、事务、可见版本、调度
 │
 └── CN：写入、查询、Compaction、执行版本发布任务
       │
       └── 共享存储：数据文件、Tablet 版本元数据等

Doris Cloud Mode

FE：表结构、SQL 规划和协调
 │
 ├── Meta Service ── FoundationDB：数据事务、Tablet / Rowset 元数据
 │        ↑
 └── BE ──┘
      │
      └── 共享存储：Segment、索引等数据文件
```

StarRocks 对外部署的主要组件是 FE 和 CN。FE 管理事务与查询协调，CN 执行计算。共享存储里既有数据文件，也有 Tablet 元数据文件，因此“元数据都在 FE”并不准确。[StarRocks 架构](https://docs.starrocks.io/docs/introduction/Architecture/)、[Shared-data FAQ](https://docs.starrocks.io/docs/faq/shared_data_faq/)

Doris 则单独引入 Meta Service 管理数据层元数据，BE 通过它获取 Tablet、Rowset 等信息。FE 仍保留 SQL 层的表结构和权限等职责。Meta Service 本身无状态，持久状态落在 FoundationDB，不能因为服务进程可替换，就把 FDB 也当成缓存。[Doris 系统架构](https://doris.apache.org/docs/4.x/features-architecture/system-architecture/)、[Meta Service 部署配置](https://doris.apache.org/docs/install/deploy-on-kubernetes/separating-storage-compute/config-ms/)

这会直接影响恢复方案。Doris 的 FE 与 FDB 是两个元数据持久化域，只备份对象存储不够，独立备份两边也可能拿到不同时间点。4.0.8 引入的元数据备份接口专门提供同步点，就是为了解决对齐问题。[Doris Meta Backup Action](https://doris.apache.org/docs/4.x/admin-manual/open-api/fe-http/meta-backup-action/)

## 上传完成，为什么还不能查

对象存储能看到文件，不代表数据库查询就该看到它。否则一次导入上传十个文件，传完第一个就被查询读走，事务的原子性就没了。

StarRocks Shared-data 可以按下面的顺序理解：

```text
开启导入事务
  → CN 生成并持久化数据文件及相关事务信息
  → FE 提交事务
  → 协调 Publish，生成新 Tablet 版本元数据
  → 事务变为 VISIBLE，查询使用新版本
```

这里“写文件”是执行阶段，不另造一个名为 WRITE 的事务状态。Commit 和 Publish 也要分开观察：数据已经提交，仍可能在等发布。StarRocks 的 Compaction 本身也走事务提交、发布流程，FE 调度 Tablet 子任务，收集结果后提交，再协调发布。[Shared-data Compaction 流程](https://docs.starrocks.io/docs/administration/management/compaction/)

Doris Cloud Mode 的数据事务由 Meta Service 管理，借助 FoundationDB 完成相应的元数据事务操作。BE 先持久化数据文件，再提交 Rowset 等元数据信息。这里不能直接照搬 StarRocks 的 FE Commit、Tablet Metadata Publish 状态表；两边要保证的文件与元数据一致性相似，具体协议和可见性推进路径不同。[Doris 导入机制与调优](https://doris.apache.org/docs/dev/data-operate/import/load-best-practices/)

对查询而言，关键是按所需的可见版本找到文件引用，而不是对着 S3 目录做一次全量枚举。目录里既可能有待发布的新文件，也可能有等待回收的旧文件。

## 缓存只改变从哪里取文件

同一份 Segment，可能在本机 SSD 上，也可能需要从对象存储读取。启用相应能力时，还可以从其他计算节点的缓存获取。无论命中哪一级缓存，查询需要的数据集合仍由版本元数据决定。

所以扩容时不需要先把全量历史数据搬到新节点，节点可以直接访问共享存储。但新节点的缓存是冷的，接手任务后可能产生大量远端读取。计算资源增加了，查询速度也未必马上增加。

Query Cache 又是另一回事。它缓存符合条件的聚合中间结果，不是 Segment 文件。StarRocks 在存算一体下从 2.5 支持 Query Cache，在 Shared-data 下从 3.4.0 才支持，命中还受查询形态和版本校验等条件限制。不能因为表在对象存储里，就默认所有查询都有结果缓存可用。[StarRocks Query Cache](https://docs.starrocks.io/docs/using_starrocks/caching/query_cache/)

## Compaction 合到一半，节点没了

合并会读取旧 Rowset，生成新 Rowset，而不会直接把旧文件覆盖掉。新输出还没有成为有效版本的一部分时，旧输入仍然承担查询读取。

```text
原文件集合：R1 + R2 + R3
                  ↓ 读取、合并
新输出：C，先持久化
                  ↓ 更新有效版本的文件引用
后续查询使用 C
                  ↓ 满足旧版本与回收条件
清理不再需要的 R1、R2、R3
```

但“还没发布”不能一概理解成孤儿文件。尤其要分清以下几种情况：

| 故障时点 | 应该如何理解 |
| --- | --- |
| 只有本地临时结果 | 任务可能要重做，旧文件集合仍然有效 |
| 部分文件上传，事务尚未成功提交 | 先确认事务最终状态；失败或超时清理按系统规则进行 |
| 已提交，仍在等待发布 | 持久结果属于待完成事务，不能因为暂时不可见就判为孤儿 |
| 发布完成，响应丢失 | 先查事务状态，不能仅凭客户端超时认定失败 |
| 旧输入不再被新版本使用 | 仍需满足系统的版本保留与回收条件，不能立即手工删除 |

这张表说明的是恢复时要辨认的阶段。具体重试由哪个服务接手、是否重做计算，要看两家的事务和任务实现。“其他节点可以访问同一份持久数据”，不等于“每个中断任务都会在另一台机器上无缝续跑”。

所谓无状态计算节点，允许丢的是缓存和可重建的执行状态。一个节点坏掉，仍可能导致正在跑的查询失败、任务重试和缓存重新预热。

## S3 上的合并还是要付 I/O

假设一轮合并读取约 1 GB 数据，输出也约 1 GB。输入全在本地缓存时，主要远端流量是写出；输入全没缓存，就还要增加约 1 GB 的远端读取。这只是忽略压缩变化、索引和协议开销的估算。

如果同一批数据经历多轮合并，它会被多次读取和重写。再加上旧文件要延后删除，存储占用会暂时高于只算有效版本时的大小。对象存储费用因此不能只看最后留下了多少 GB，还要看请求数量、网络流量和回收速度。

StarRocks 从 4.0 提供 File Bundling，把多个逻辑文件组织到更少的物理对象里，降低对象 API 访问成本。4.0 及以后新建表默认启用，升级前已有表默认仍关闭，手动开启还有条件限制。它解决的是对象数量和请求开销，合并需要处理的字节并不会因此凭空消失。[File Bundling 建表属性](https://docs.starrocks.io/docs/sql-reference/sql-statements/table_bucket_part_index/CREATE_TABLE/)

任务落点也会改变这笔账。刚写完的数据留在某组节点的缓存里，合并却安排到另一组没有缓存的节点，输入可能又要远端读一遍。做资源隔离时，需要把缓存局部性一起算进去，不能只算隔离出了多少 CPU。

## 真正要运维的是哪些状态

从部署组件看，StarRocks 的主要进程类型更少；Doris 把数据元数据事务拆给 Meta Service 和 FDB，职责更独立，也多出了一套需要维护的持久状态。这只是架构差异，不能据此直接推出哪家性能更高。

我会把验证重点放在故障和冷缓存上：计算节点重启后能否正常接手任务，发布延迟在哪里观察，对象存储变慢时写入和查询各自怎样退化，元数据备份能否恢复到与数据一致的状态。只跑一次缓存已经热好的查询，回答不了这些问题。

前两篇讲的数据布局和 Compaction，在这里仍然适用。高频小事务、过度分桶和历史数据反复改写，都会继续产生合并负担，只是其中一部分成本转移到了共享存储和网络。采用存算分离之前，这部分也要按实际写入方式测出来。

**相关**：[Doris 的数据组织](/others/doris/data-layout) · [Doris Compaction](/others/doris/compaction) · [存算分离横评](/clickhouse/comparison/storage-compute-separation) · [Doris 存储策略与 S3](/others/doris/storage-policy-s3)
