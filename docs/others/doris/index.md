# Doris

站上大部分内容是 ClickHouse，但我手里有一个金融行业的日志平台跑在 Apache Doris 上，日增百 TB 级。这一栏既放实际排查和测试，也整理数据组织、Compaction 和存算分离机制，归在[其他引擎](/others/)底下。

和[选型与横评](/clickhouse/comparison/)那一栏的分工：那边是把 Doris 和 ClickHouse 放在一起比，回答该选哪个；这边把 Doris 的具体机制拆开看，必要时拿 StarRocks 或 ClickHouse 作对照，解释它怎么运作、边界在哪。

我做 ClickHouse 更多，所以写 Doris 的时候会忍不住拿 ClickHouse 做参照，看到这类对照你打个折。有些地方确实是 ClickHouse 做得更顺手，也有些可能只是我用 Doris 用得不够深。

## 文章

<div class="posts">

<a class="post" href="/others/doris/data-layout">
<span class="post-t">Doris 的数据组织：Partition、Tablet、Rowset 分别管什么</span>
<span class="post-d">顺着一批日志走完写入路径，解释分区、分桶、版本，以及 Tablet 为什么不能等同于 ClickHouse Part。</span>
</a>

<a class="post" href="/others/doris/compaction">
<span class="post-t">Doris Compaction：小批写入为什么会拖慢查询</span>
<span class="post-d">Score 不等于文件数。先找到积压的 Tablet，再分清排队、合并和发布，最后决定该改批量还是加并发。</span>
</a>

<a class="post" href="/others/doris/shared-data">
<span class="post-t">Doris 与 StarRocks 的存算分离：元数据放在哪里，版本如何可见</span>
<span class="post-d">FE、Meta Service 和 FDB 各管什么，已上传为什么还不能查，以及计算节点故障后哪些状态必须保住。</span>
</a>


<a class="post" href="/others/doris/storage-policy-s3">
<span class="post-t">Doris 的存储策略：冷数据转 S3 之后，这几件事得先知道</span>
<span class="post-d">策略建了就删不掉，换个 S3 得重建表，cooldown 算的是写入时间不是业务时间。好消息是 S3 挂了不影响集群健康。</span>
</a>

<a class="post" href="/others/doris/cross-datacenter-query">
<span class="post-t">Doris 跨数据中心查询：查视图还是查底表，差别在执行计划里</span>
<span class="post-d">同一个聚合查询，查视图只有过滤能下沉，23 万行全量跨机房；查底表自己写两层聚合，跨机房的只有 19 行。</span>
</a>

</div>

<!-- TODO 选题储备：
  · BE 打机房标签做写入隔离：建表 tag、副本分布、扩缩容时标签怎么变
  · Merge-on-Write 的 delete bitmap：写入放大、compaction 时机
-->
