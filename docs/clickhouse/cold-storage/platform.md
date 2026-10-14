---
title: 应用平台的 S3 冷盘：先把队列分开
---

# 应用平台的 S3 冷盘：先把队列分开

这个系列前面几篇，基本都在讲 S3 Disk 哪里不好：单租户百 TB 的集群里 merge 爆炸、启动卡死、副本翻倍、schema 难演进。结论也偏向能不上就不上，能转 Parquet 就转 Parquet。

可回到 S3 Disk 本身，它确实有几样别的方案替代不了的好处。

一是零改造。表还是 MergeTree，SQL 一行不用改，配个 TTL 表达式就能冷热下沉。别的方案，Parquet 也好，BACKUP 也好，都要动数据格式、改查询路径、换工具链。

二是存和查在一起。冷数据就是能直接查的 MergeTree part，不用再起一个 Spark、Trino 或者 chDB 来查，冷查询走的还是 ClickHouse 原来那套主键索引、列裁剪、过滤下推。

三是 MergeTree 的索引体系整个保留了下来。稀疏主键索引按 granule 跳读，8192 行一个粒度，比 Parquet 的 row group 细一个数量级；跳数索引 minmax、set、bloom_filter、ngrambf、tokenbf；Projection，同一份数据存几种排序，查询自动挑最合适的；列级 codec，DoubleDelta、Gorilla、T64 这些专用编码，到了 S3 上照样工作。S3 上的冷查询能做到只下载需要的列，而且只下载需要的那几个 granule 的字节范围。Parquet 要叠上 Iceberg、Hudi 这类湖仓格式，才追得上这套索引能力。

四是运维上只有一套东西。所有数据都在 ClickHouse 里，监控、备份、权限、schema 管理都是一套，不用同时维护热表和冷文件两套抽象。

五是存储成本马上就降。S3 的单位存储价格一般是本地 NVMe 的五分之一到十分之一，用多少付多少，不用提前规划盘位。

六是副本和高可用机制不变。ReplicatedMergeTree 照常工作，Keeper 协调还在，可用性模型不用重新设计。

这些加起来，冷热分层就从一次架构改造变成了一次配置变更，对一个已经在跑的 ClickHouse 系统来说，改动最小。

代价就是前几篇讲的那些。S3 不是本地盘，把它当成一块慢盘来用，merge、启动、副本、schema 演进上都要付出代价。所以要回答的是，用它的时候怎么不被它拖垮。

我的看法是，跟 S3 有关的那些爆炸，根子上都是队列没分开，光加限流不管用。队列分开了，ClickHouse 在自己的队列里慢慢排，外面感觉不到。

这篇写给在做应用平台的人，日志、可观测性、数据分析、SaaS 之类，要给用户提供 S3 冷盘能力，或者已经提供了、又担心被它拖垮的。

## ClickHouse 在 S3 上的数据是怎么放的

后面很多结论，为什么 metadata_path 的备份必须排第一优先级、为什么对象数容易爆、为什么能按 granule 跳读、为什么禁 merge 能省钱，都建立在 ClickHouse 的物理数据布局上，所以先把这一层讲清楚。

### part 是一个目录

一个 MergeTree part 在磁盘上是一个目录，里面十几个独立的文件：

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

放到 S3 上，每个文件就是一个独立的 S3 对象，本地的 `metadata_path` 维护着逻辑文件路径到 S3 object key 的映射。这和 Parquet 那种一个文件、尾部带 footer 自己描述自己，是完全不同的两种模型。

### 查询时怎么走索引

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
<p class="sk-cap">颜色从中性走到琥珀再到赤红，对应 S3 IO 代价逐级升高</p>
</div>

关键的差别在于 ClickHouse 不需要读 footer 这一步。Parquet 每个文件一般要先 HEAD 或者 GET 一下尾部，解析 footer 才知道里面有什么（成熟的引擎会缓存 footer，少读几次）；ClickHouse 本地的 `metadata_path` 里有全局的 part 清单和文件映射，这一步在本地就做完了，一次 S3 IO 都不用。

### 好处

一是按 granule 精确跳读。稀疏主键索引加上 granule（默认 8192 行），跳读的粒度比 Parquet 的 row group（128MB）细一个数量级。按主键过滤的查询，一般只下载几个 granule，几百 KB 的 IO。

二是整套索引在 S3 上都能用。稀疏主键索引、minmax、跳数索引（bloom_filter、ngrambf、tokenbf）、Projection、列级 codec，都是 ClickHouse 自带的，不靠外部的湖仓格式。Parquet 要追上这些，得叠一层 Iceberg、Hudi 这样的元数据层。

三是加索引不用重写数据。`ALTER TABLE ... ADD INDEX` 只往 S3 写新的 `skp_idx_*.idx` 文件，已有 part 的 `.bin` 不动。Parquet 要加统计信息，得把整个文件重写一遍。

四是列出 part 几乎不花钱。读本地 metadata_path 就行，秒级。S3 上的 Parquet 要 `LIST` 整个 bucket，或者靠 Iceberg 的 manifest，又慢又贵。

### 代价

对象数会爆。一个 50 列的 part 放到 S3 上就是 100 多个对象，每列一个 `.bin` 一个 `.mrk2`，再加索引和元数据。100T 数据按 1GB 一个 part 算，总对象数轻轻松松上千万。LIST、生命周期管理、备份都贵，merge 高峰时的 PUT 还容易撞上 prefix 限流。后面讲 Compact part，就是为了对冲这个。

`metadata_path` 是唯一的真相来源。S3 上的文件名是 hash，也没有 footer 可以解析，**本地 metadata 一丢，S3 上的对象就全成了孤儿**，不知道哪个对象属于哪个 part、哪一列、哪个 granule。所以 metadata_path 的备份必须排在第一优先级，它其实就是 ClickHouse 在 S3 上的 footer，只不过物理上挪到了本地。

删一个 part 要发很多次 DELETE。drop 一个 part，等于删掉它那 100 多个对象，生命周期清理时 DELETE 的数量比 part 数多两个数量级。

文件名不可读。S3 上 ClickHouse 的对象名都是 hash，肉眼看不出属于哪张表、哪一列、哪个 part，对账、回溯、判断归属，都得回本地 `metadata_path` 去反查。所以 metadata_path 不光是数据能不能找到的单点，实际上也是唯一能把 S3 对象映射回业务含义的索引。理论上靠 S3 inventory 加对象内容自检也能重建，但代价极高，算不上日常可用的办法。

后面的结论和这些物理事实是这么对应的：

| 后面的论点 | 对应物理事实 |
|---|---|
| 「完整保留 MergeTree 索引体系」是优势 | 查询怎么走索引、好处 |
| `metadata_path` 备份必须 P0 | 代价 |
| 禁 S3 上 merge | part 是目录（per-column 多文件 + merge 要 GET/PUT 全套） |
| Compact part 对冲 | 代价（对象数爆炸的根因） |
| S3 上文件名不可读不是问题 | 代价（本来就靠 metadata_path） |

## 四件不能接受的事，其实是一件事

应用平台对 S3 冷盘的需求其实很朴素，就是给客户一个开关：过了 X 天的数据沉到 S3，存储便宜，查起来慢点没关系。

可作为平台方，下面四件事出了任何一件都是事故：某个用户的大查询把 S3 拉挂了，或者触发了限流，平台其他业务访问 S3 失败；大查询把查询网关拉爆了，buffer 撑满、连接数耗尽，所有用户都连不上；大查询把 ClickHouse 打爆了，OOM、影响写入、影响别的用户查询；最严重的，大查询影响到了平台之外用 S3 的业务，这就是跨产品的事故了。

很多团队第一反应是上限流：给 ClickHouse 配 `s3_max_get_rps`，给查询配 `max_memory_usage`，给用户配并发上限。方向都对，可解决的不是同一个问题。

限流不等于隔离。限流说白了就是让请求排队。ClickHouse 的请求队列要是和其他业务的请求队列在某个共享的下游汇到了一起，ClickHouse 一堆积几千个请求，那个下游队尾等着的就是别的业务。ClickHouse 自己慢没关系，可它会让所有共用这个下游的人一起慢。

四件事归到一起，就是冷查询天然没有边界，用户随便选个时间范围就能扫几十 GB；S3 又没有天然的背压，不像 TCP 有流控。队列只要在某处合流，背压就传过去了。

## 共享资源上有几层队列

把 ClickHouse 查 S3 的路径展开，看看每一层在哪里排队：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/platform-02.light.svg" alt="ClickHouse 查 S3 的路径上各层的队列">
<img class="dfig-d" src="/diagrams/platform-02.dark.svg" alt="ClickHouse 查 S3 的路径上各层的队列">
</figure>

每一层都有自己的队列：

| 层 | 队列实质 | 满了会发生什么 |
|---|---|---|
| HTTP 连接池 | TCP 连接队列 | 后续请求等待空闲连接 |
| VPC endpoint / NAT | endpoint 带宽 + 连接表 | endpoint 整个慢下来 |
| AWS 账号 | API quota | 同账号 API 调用慢 |
| S3 bucket | bucket 级聚合 quota | 整桶慢 |
| S3 prefix | per-prefix 令牌桶 | 该 prefix 返回 503 SlowDown |

ClickHouse 这个 S3 重度用户，哪一层是共享的，就在哪一层污染别人。

最容易被忽略的是 VPC endpoint 或 NAT 这一层。很多团队独立的 bucket 都分好了，endpoint 却是共享的，结果业务一上传大文件，就被 ClickHouse 的 GET 流量挤到超时。AWS PrivateLink endpoint 的带宽是按 endpoint 实例算的，bucket 分得再细也救不了。

## 第一道防线：把队列分开

套上队列模型，隔离这件事就收敛成一条原则：共享什么都行，只要 ClickHouse 的队列和别人的队列不合流。

物理上是不是同一个 AWS 账号、同一个 VPC、同一台机器，都不重要。只要在共享下游那一层队列分得开，ClickHouse 在自己的队列里怎么排队、怎么限流、甚至雪崩，外面都感觉不到。

拿这条原则把隔离手段筛一遍，必须做的只剩两件：

| 项 | 必要性 | 解决哪一层队列 |
|---|---|---|
| 独立 S3 bucket（或独立 prefix） | 必须 | per-prefix 令牌桶分离 |
| 独立 VPC endpoint 或 NAT | 必须 | 出口带宽 + 连接表分离 |
| 独立 IAM / AK | 推荐（审计、紧急封禁） | 不影响队列 |
| 独立 AWS 账号 / sub-account | 可省 | 数据平面队列已分开 |
| 独立 VPC / subnet | 可省 | 跟 endpoint 重叠 |
| 独立查询网关（chproxy 等） | 可省 | CK 本身是独立进程，自带 HTTP client |

两件加起来，基础设施成本极低，一个 bucket 加一个 endpoint，一个月几十块钱，和独立账号加独立 VPC 那种几千块的方案隔离效果一样。

最后的物理路径是这样：

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

这条路径上没有一段是共享的。ClickHouse 在自己那条管道上怎么排队、限流、雪崩，业务的请求走的是另一条管道，物理上不可能排到 ClickHouse 后面去。

这个前提立住了，下面那些 ClickHouse 内部的参数才有意义。对外隔离的责任已经交给了基础设施，它们管的只是 ClickHouse 别把自己搞雪崩。

## ClickHouse 自己别崩

队列分开以后，ClickHouse 自己也不能爆。这部分和单租户集群的治理思路一样，只是目标变了，不再是别影响别的业务，那个基础设施已经搞定了，而是别影响别的用户、别把自己拖垮。

### 集群保持同构，靠 profile 和路由做软隔离

理论上更彻底的做法，是把副本节点改成专门跑冷查询的 reader 池：主节点只挂热盘，负责写入和热查询；reader 节点挂全套 storage policy，处理冷查询，OOM 也传不到写入路径上。

可这套架构运维代价不小。节点角色不一样，配置就不一样，扩容就是加同样的节点这个简单性没了。主节点和 reader 上的 storage policy 不一致，表的 TTL 规则要按节点角色区分，否则 MOVE 到 cold volume 时主节点上找不到这个 volume。滚动升级要分两组按顺序来。监控、告警、容量规划都得按角色分开维护。

我推荐集群保持同构，所有节点配置完全一样，都挂全套 storage policy。冷查询和写入物理上共用节点，靠下面这些机制做软隔离：网关层把大查询路由去异步导出，这一条最有效，大查询压根进不了集群；profile 硬约束，`max_memory_usage=8G` 让单个查询没法把一台 64G 以上的机器搞 OOM；`max_concurrent_queries_for_user=2` 加 `max_threads=4` 限制冷查询总共能占多少资源；再加上队列已经分开，ClickHouse 节点自己慢不会污染别的业务。

要接受的代价是，一个坏的冷查询会让所在节点的写入短暂变慢，但不会让节点 OOM，也不会让集群挂。这个影响范围一般能接受，写入那边本来就有 buffer table 和重试，慢几秒不会丢数据。

### 禁止在 S3 上 merge，禁止直接落冷

S3 Disk 的头号坑：历史数据 INSERT 时如果已经满足 TTL，可能直接落到冷盘，然后在 S3 上 merge，GET、PUT、DELETE 一起放大。

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

`prefer_not_to_merge` 在官方文档里是带着警告的（「You should not use this setting」），但在 S3 的 cold volume 上算是公认的例外，S3 上 merge 一次要 GET 旧 part、PUT 新 part、DELETE 旧 part，代价比不 merge 留下一些小文件高得多。只在冷盘上开，热盘、温盘开了会反噬。

配套还有几条工程上的约束。写入路径上，所有用户都必须走平台的 ingest（Kafka 或者 HTTP gateway），由平台攒成批再写，不许用户直连 INSERT，不然就是一片小 part 的海。历史数据回灌走平台提供的批量导入 API，背后是先落到本地的 staging 表，merge 到 1GB 以上的 part，再 `ALTER MOVE PART` 到冷盘，小 part 绝不能直接 MOVE 上 S3。平台代码也不生成 mutation 类的 SQL。

为什么禁 mutation？mutation 是 ClickHouse 里按行重写 part 的机制，`ALTER UPDATE/DELETE`、`MODIFY COLUMN` 改类型、`MATERIALIZE COLUMN`、`DROP COLUMN`、`DELETE FROM` 都走这条路。在 100T 冷数据上，它会让每个 part 都重新读、重新写、重新上传 S3，几周到几个月不等，是 S3 Disk 上最贵的一类操作。

加列不是 mutation，只要 DEFAULT 是常量或者列是 Nullable，就是个纯元数据操作，瞬间完成，没有 S3 IO，这是平台可以放心提供的 schema 演进能力。所以禁 mutation 具体是指：平台的 schema 演进模块只暴露安全的方法，带常量 DEFAULT 的 `add_column`、`rename_column`、`drop_partition`，不提供 `modify_column_type` 和 `drop_column`。真要删一列，代码里标成 deprecated 就行，老数据靠 TTL 自然过期。真要改类型，走加新列、双写、按分区回填、删老列这四步，作为运维工单流程，而不是日常 API。

每种 ALTER 在冷数据上的代价，见 [ClickHouse 冷数据三种方案下的 ALTER TABLE 行为](/clickhouse/cold-storage/alter)。

### profile 硬约束

冷查询走单独的 user profile，所有限制都要带上 `<constraints>`，不然用户在 `SETTINGS` 里一写就覆盖掉了：

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

`max_threads=4` 主要不是为了控 CPU，是为了控 S3 并发。单个查询的 S3 GET 并发大约是 `max_threads × parts`，线程越多，越容易把自己的 prefix 打出 503。压小它，内存翻倍和自己把自己限流这两件事一起解决了。`force_index_by_date=1` 防的是有人写 `WHERE col=x` 这种不带时间过滤的查询，把所有分区扫一遍。`max_bytes_before_external_*` 一定要开，不然 ORDER BY、GROUP BY 的大查询很容易 OOM。

spill 的路径要给一块单独的 SSD 做 `tmp_path`：

```xml
<tmp_path>/data/ch/tmp_ssd/</tmp_path>
```

不然一个大 SORT spill 出几十 GB 写在数据盘上，把热盘的 IO 打满，反倒影响了热查询。

### S3 客户端自己限速

限速和重试的参数全部放在 S3 disk 的定义里（server 配置级别），别放进 `<profiles>`。`s3_retry_attempts` 作为查询或 profile 级的设置，在新版本里已经是 `MAKE_DEPRECATED_BY_SERVER_CONFIG` 了，写在 profile 里会被忽略或者报告警。

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

最容易反咬一口的是 `retry_attempts`。这个值在不同版本之间变得很厉害，早期默认 10，现在默认已经拉到了 500（`src/IO/S3Defines.h` 里的 `DEFAULT_RETRY_ATTEMPTS`）。具体默认是多少不重要，要命的是 500 这个量级，碰上 503 SlowDown 会把流量放大几百倍，稳定复现雪崩。压到 3，让失败尽快暴露出来，再配上熔断和退避。

这些 S3 配置能放在哪一层，22.x、23.x、24.x、25.x 之间迁移过好几次，有的连名字和归属层级都改了。落地之前，一定要对照目标版本的官方文档，再看一眼 `Settings.cpp` 里的 `MAKE_DEPRECATED_BY_SERVER_CONFIG` 列表。

### 服务器级兜底

```xml
<!-- config.xml 顶层 -->
<max_server_memory_usage_to_ram_ratio>0.8</max_server_memory_usage_to_ram_ratio>
<max_concurrent_queries>50</max_concurrent_queries>
<async_load_databases>1</async_load_databases>
```

`async_load_databases=1` 是 23.11 引入的启动优化（24.6 起默认配置里打开，25.2 起不写配置也默认开启），S3 抖动时 server 照样能起来，不会因为某几张表 attach 得慢卡住整个集群。注意它是 server 顶层的配置，不在 `<merge_tree>` 下面。

启动时 S3 不可达怎么救，见 [S3 不可达时起不来：metadata 明明在本地，它却说 S3 上找不到](/clickhouse/troubleshooting/s3-unreachable-startup)，这里不重复了。

### Compact part 对冲小文件

MergeTree 每列一个文件的设计，在本地盘上是优点，IO 独立、codec 独立、加列灵活；到了 S3 上就成了 PUT 量爆炸。一个 50 列的表，每个 part 上 S3 就是 100 多个对象，100T 数据按 1GB 一个 part 算，总对象数轻松上千万，merge 高峰期很容易撞上 PUT 限流（默认每个 prefix 每秒 3500 次）。

Compact part 格式可以对冲这个问题。它其实早在 20.x 就有了，part 小于 `min_bytes_for_wide_part`（默认 10 MB）时自动用 Compact 格式，冷盘场景要做的是把这个阈值调大。两个相关参数放在不同的层级：

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

效果是 100 列的 part 从 200 多个文件降到 10 个出头（`data.bin`、`data.mrk3`、元数据、跳数索引），S3 对象数少了一个数量级，PUT 量也跟着降。

代价在这个场景下都很小：Compact part 没法按列缓存，没上 cache disk 就没影响；单列查询要对 data.bin 做局部的 Range GET，S3 上本来就是 Range GET，几乎没差别；老版本上 vertical merge 的行为不一样，上生产前在自己的版本上验证一下。

它和禁 S3 merge 是一对：禁了 merge，part 不会在 S3 上被重写；用了 Compact part，每个 part 在 S3 上的对象少。两条加在一起，冷盘上的 S3 IO 量才算真正管住了。

## cache 默认不上

cache disk 只解决一件事：同一段冷数据被反复查，第二次起不用再打 S3。它解决不了大查询防爆，解决不了限流，也解决不了多用户隔离。所以要不要上 cache，就看冷查询有没有重复访问。

日志平台的冷查询大致三类：

| 模式 | 重复访问 | Cache 收益 |
|---|---|---|
| 故障调查（开一个时间窗反复改 WHERE） | 高 | 大 |
| 批量导出（一次扫一个月） | 接近 0 | 几乎为负（污染 cache） |
| BI / 趋势查询 | 该走预聚合，根本不该打冷盘 | 不适用 |

只有第一类能拿到收益，可它占冷查询总量的多少，事先是不知道的。

我默认不上，理由有这么几个。多一块要管的盘，会满、要监控命中率，还出过 cache 格式版本不兼容的坑。多一种失败的方式，cache 写满时会有 eviction storm。短时间的重复访问，操作系统的 page cache 已经免费帮你缓存了。多挂一块盘就多一个磁盘故障域，节点恢复时间也变长。用户已经接受了冷查询慢，cache 本来就不在关键路径上。

怎么决定：上线时不配 cache，`s3_cached` 这一层直接不要，cold volume 直接挂 `s3_cold`。跑上两到四周，从 query_log 里看冷查询有没有重复访问的迹象：

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

要是有些用户每周都反复读同一段冷数据好几次，S3 出口的字节大头又集中在他们身上，这时候再上 cache 才划算：

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

两个参数要注意。`cache_on_write_operations=0`，part MOVE 上 S3 这一步不写进 cache，刚挪上去的数据短期内不会有人查，进 cache 纯属污染。`enable_cache_hits_threshold=2`，一个文件要被访问两次以上才进 cache，一次性扫描的批量导出就不会把 cache 搞脏。集群同构的话，所有节点都开 cache，写入路径的污染靠 `cache_on_write_operations=0` 挡住。

还有个反直觉的信号：cache 命中率长期在八成以上，不是好事。这说明所谓的冷数据其实访问很频繁，分层分错了，应该把它挪回热盘或者加一个 warm 层，而不是拿 cache 装作它是冷的。

## 让坏查询写不出来

前面那些防线，队列分开也好，ClickHouse 内部的约束也好，都是在扛坏查询。最理想的是坏查询根本进不来。

日志平台的用户，一小部分是懂 SQL 的 SRE 和运维，一大部分是不懂的业务人员。业务人员能写出来的最坏的查询长这样：

```sql
SELECT * FROM big_table WHERE timestamp BETWEEN '2024-01-01' AND '2024-06-30' AND message LIKE '%xx%' ORDER BY timestamp LIMIT 1000;
```

没有过滤，没有分页，跨半年。直接进 ClickHouse，扫几百 GB，OOM 或者把网关 buffer 撑爆是必然的。

### 两个很自然但不够的办法

第一个是限制时间范围，比如最多 7 天。可这很容易绕过，写 7 个查询就查了 49 天；会误伤合规的月度报表；更关键的是时间范围代表不了数据量，高流量的表一个小时可能比低流量的表一个月还多。

第二个是按时间切片，流式返回。适用面有限，`SUM/COUNT/AVG/MIN/MAX` 和按时间 `GROUP BY` 能拆，`DISTINCT count`、`quantile`、JOIN、全局 `ORDER BY` 拆不了；而且单片照样可能爆，高流量的表一个小时本身就有 50GB。

### 执行前预估，分档路由

应用层最有效的办法，是不让坏查询开始跑。预估之所以走得通，是因为日志数据有两个天然的属性：按时间分区，分区裁剪以后 part 数就定了；列存的压缩比比较稳定。

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

三个数，part 数、行数、mark 数。它不真的读数据，只走主键索引和分区裁剪。

行数换算成字节，每张表算一次缓存起来：

```sql
SELECT
  table,
  sum(data_compressed_bytes) / sum(rows) AS bytes_per_row_compressed
FROM system.parts
WHERE active AND database = 'logs_db'
GROUP BY table;
```

`预估扫描字节 ≈ ESTIMATE.rows × bytes_per_row_compressed × SELECT 列占比`

预估出来以后分三档：

| 预估扫描 | 路由 | SLA |
|---|---|---|
| < 1 GB | 同步执行 | 秒级 |
| 1 GB ~ 100 GB | 自动切片 + 流式 | 首字节秒级、可中断 |
| > 100 GB | 拒绝同步，转异步导出 | 分钟到小时级，Parquet 落 S3 |

业务人员写了个跨半年的 `WHERE BETWEEN`，预估 5 TB，网关弹窗提示查询过大、已转异步导出、完成后邮件通知下载，这条查询根本进不了 ClickHouse。

`EXPLAIN ESTIMATE` 有用，但也有它的边界。它不是免费的，要读相关 part 的主键索引和 mark，part 几百个时秒回，几万个时 ESTIMATE 自己就要几秒，所以别所有查询都跑一遍，要留个快速通道，时间窗不超过一天、带主键过滤的小查询直接放行。它只估外层，子查询和 CTE 看不见，得解析 SQL，把内层的裸表拎出来单独估。分布式表上它只估本地，数据分到不同 shard 上，估得不准，虽然每个 shard 的计算量相对均衡，但对 S3 的读写压力是实打实的。JOIN 估不准，右表扫描量和 hash 表大小都估得很差，新版本有改善但仍不可靠，实际做法是网关层直接禁止冷数据上的 JOIN，比想办法估准容易。它也估不出内存，只估读多少，不估用多少，得再叠加对 SQL 形状的判断，`ORDER BY` 非主键、`DISTINCT/uniq`、高基数 `GROUP BY` 都加风险分。

### 业务人员最好别写 SQL

不太懂的用户，最好压根碰不到 SQL，给他们一个 UI：时间范围拖一拖，实时显示预计扫描多少（「预计扫描 12 GB」）；用户标识、时间、至少一个过滤条件是必填的；聚合是预置的下拉框，count、sum、avg，加上按时间粒度 group by；查询一大，按钮自动变成提交导出任务。

这一条比后端所有限制都管用，业务人员根本写不出灾难性的查询。SQL 入口只留给少数高级用户，他们也走同一套预估和路由。

网关层落下来大概是这个样子：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/platform-04.light.svg" alt="网关层：SQL 解析、预估、按档路由到同步、切片或异步导出">
<img class="dfig-d" src="/diagrams/platform-04.dark.svg" alt="网关层：SQL 解析、预估、按档路由到同步、切片或异步导出">
</figure>

预估结果可以按查询模板加时间窗缓存 5 分钟，再省一点负载。

### 用户反复点：要的是去重，不是限流

预估和分档解决的是单次的坏查询。实际业务里还有一种更隐蔽的情况，用户等得不耐烦，反复点：

```
T=0    用户点查询  → CK 开始跑 query_A，扫 S3
T=10s  没等到结果  → 又点 → query_A' 进入队列
T=20s  还没出来    → 又点 → query_A''
T=30s  query_A 跑完 → query_A' 立刻接着跑 → 用户以为这次"快"
T=40s  query_A' 跑完 → query_A'' 接着跑 → 用户感觉"又慢了"
```

用户觉得时快时慢，莫名其妙，其实是同一个查询跑了 3 遍，ClickHouse 做了 3 倍的冗余工作。最糟的时候几个查询一起跑，profile 里 `max_concurrent_queries_for_user=2` 会让第 3 个排队，可前 2 个是并发执行的，内存直接翻倍，雪崩。一个查询 S3 和 ClickHouse 勉强扛得住，几个一样的同时来，就崩了。

很多人第一反应是调 `max_concurrent_queries_for_user`，这个参数解决不了问题。它管的是并发，不是去重，5 次重复提交排着队执行，CPU 和 S3 的总工作量还是 5 倍，用户体验更差。

要的是去重，而且必须在服务端做。客户端 UI 上的防抖只是礼貌，算不上防御，用户可以重开浏览器、开隐身窗口、手机电脑一起点、绕过 UI 直接调 API，任何依赖客户端状态的去重都拦不住。客户端那层也不能省，它能挡掉大部分无意识的误操作，剩下的那 5% 加上全部恶意和异常的情况，才轮到服务端。落地的时候我会组合五样东西。

UI 防抖加进度提示，在客户端。提交按钮点了以后就禁用，直到返回结果、用户取消或者超时。再配上实时进度（从 `system.processes` 拉 `read_rows / total_rows_approx`），让用户知道后端在干活，大部分重复点击都是以为卡死了。

网关层按指纹去重，在服务端，这是核心的防御。每个查询算一个指纹：

```
fingerprint = hash(normalized_sql + user_id)
```

去重的边界是 `user_id`，不是 `session_id` 或者 `connection_id`。这样同一个用户在 5 个浏览器里同时点、用 curl 直接调 API、手机电脑一起操作，都映射到同一个指纹上。

网关维护一个 `in_flight_queries: fingerprint → {query_id, stream_handle, ref_count}`，新查询进来时：

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

`user_id` 从 auth token 里取，客户端伪造不了。

ClickHouse 这一层用 `replace_running_query` 兜底，再加上 `cancel_http_readonly_queries_on_client_close`。都是 profile 或用户级的设置，放在 `users.xml` 的 profile 下面：

```xml
<profiles>
  <default>
    <replace_running_query>1</replace_running_query>
    <replace_running_query_max_wait_ms>5000</replace_running_query_max_wait_ms>
    <cancel_http_readonly_queries_on_client_close>1</cancel_http_readonly_queries_on_client_close>
  </default>
</profiles>
```

`query_id` 设成 `{user_id}_{fingerprint}_{5min_bucket}`，同一个用户 5 分钟内把同一个查询点了 3 次，`query_id` 一样，ClickHouse 会自动杀掉旧的、接受新的。这个 `query_id` 必须由后端来构造，不能让客户端自己提交，客户端能改的东西就一定会有人改。`cancel_http_readonly_queries_on_client_close=1` 的作用是客户端断开 TCP，关了页签或者刷新了，ClickHouse 立刻 KILL 掉查询，防的是用户已经走了，ClickHouse 还在替他烧 S3 流量。

最根本的是大查询异步化。回到前面的分档路由，预估超过 1GB 的强制转异步。走异步的话，重复点击这件事天然就不存在了，用户一提交马上拿到 task_id，没有同步等待这个状态，也就没有不耐烦的机会。

| 层 | 性质 | 部署位置 | 必要性 |
|---|---|---|---|
| UI 防抖 + 进度提示 | 礼貌 | 客户端 | 强烈建议 |
| 网关指纹去重（key = user + sql） | 防御 | 服务端 | 必须 |
| `replace_running_query` | 防御兜底 | CK | 必须（一行配置） |
| `cancel_http_readonly_queries_on_client_close` | 防御 | CK | 必须（一行配置） |
| 大查询异步化 | 防御（消除同步等待） | 网关 + 异步系统 | 必须 |

ClickHouse 的两条是两行配置，马上就能上。前端防抖大多数框架都自带。网关去重是工程上的核心。异步化在主架构里本来就有。

网关 attach 模式下有个隐藏的坑，是取消的语义。用户点一次，一个流、一个底层查询；又点一次，网关 attach 到同一个查询上，两个流在听。这时候用户点取消，取消的是他自己的流，还是底层的查询？正确的做法是只取消他自己的流，所有 attach 上来的流都取消了，才 KILL 底层查询。这是引用计数的事，漏了就会出现用户都取消了，ClickHouse 还在烧 S3。

还有个可选的优化，租户级的软去重。同一个租户里不同的人同时点了同一条 SQL，比如运营团队 3 个人同时在排查同一起事故，技术上是 3 个不同的 user_id，可对 ClickHouse 来说是同一份活干了 3 遍。可以加一层按租户的去重，相同租户、相同 SQL（指纹里不含 user_id），第 2 个起 attach 到第 1 个的流上。前提是这个查询不涉及用户级的 row policy，查询结果要是和用户身份有关，跨用户 attach 就把权限泄露了。做不做看数据，租户内重复查询的占比超过两成再做。这是优化，不做平台也照样能跑。

## 四层防御

把前面的东西串起来，是四层，每层独立工作：

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
<p class="sk-cap">每一层拦不住的，交给下一层；箭头标的是「穿透方式」，不是正常流程</p>
</div>

任何一层失守了，下面那层还顶得住。业务人员跨半年的 `WHERE BETWEEN` 在 UI 层就被拦了；高级用户绕到 SQL 接口，网关的预估拦住；老的 API 没接预估，ClickHouse profile 里的 `max_bytes_to_read` 拦住；profile 配漏了，物理隔离至少保证不会污染别的业务。

四层里物理隔离的优先级最高。前三层拦不住，受影响的是平台自己；物理隔离没做，受影响的是平台之外的业务，也就是开头说的那种跨产品事故。

## 哪些事不用做

按队列分开、模型从简这个思路，下面这些常见的做法可以不做：

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

## 最后

应用平台要是非得提供 S3 冷盘这个按钮，我建议先把独立 bucket 和独立 endpoint 配好，再去调 ClickHouse 的参数。限流、profile、spill、cache、预估、UI 引导这些，管的是 ClickHouse 自己别雪崩；别影响别人这件事它们管不了，只能靠基础设施把队列分开。

前几篇的态度是 S3 Disk 这条路不好走，能转 Parquet 就转。这篇的态度是这条路要走就走稳，先认清队列模型，再把基础设施和工程治理分两层来做。两个态度并不矛盾。能选的话，优先考虑 BACKUP 做合规归档，或者 [chDB + S3 Parquet](/clickhouse/cold-storage/chdb) 走湖仓化，把 S3 从 ClickHouse 运行时的关键路径上摘掉；选不了的话，就照这篇的思路把 S3 Disk 跑稳。

还有一句建议写进产品文档：冷盘承诺的是冷数据存得起、查得到，慢了也不影响别人，不承诺查起来跟热数据一样快。跟用户把这句讲清楚，比调哪个参数都管用。

---

**相关**：[冷热分层概览](/clickhouse/cold-storage/) · [S3 Disk 会遇到什么](/clickhouse/cold-storage/s3-disk) · [S3 不可达时起不来](/clickhouse/troubleshooting/s3-unreachable-startup) · [BACKUP 超冷归档](/clickhouse/cold-storage/backup-restore) · [为什么要转 Parquet](/clickhouse/cold-storage/parquet) · [冷数据上的 ALTER](/clickhouse/cold-storage/alter) · [chDB + S3 Parquet](/clickhouse/cold-storage/chdb)
