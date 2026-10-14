# Doris

站上大部分内容是 ClickHouse，但我手里有一个金融行业的日志平台跑在 Apache Doris 上，日增百 TB 级。这一栏放的是在那上面实测出来的东西。

和[选型与横评](/clickhouse/comparison/)那一栏的分工：那边是把 Doris 和 ClickHouse 放在一起比，回答该选哪个；这边不比，就是把 Doris 自己的某个机制拆开看，它怎么运作，边界在哪。

我做 ClickHouse 更多，所以写 Doris 的时候会忍不住拿 ClickHouse 做参照，看到这类对照你打个折。有些地方确实是 ClickHouse 做得更顺手，也有些可能只是我用 Doris 用得不够深。

## 文章

<div class="posts">

<a class="post" href="/doris/storage-policy-s3">
<span class="post-t">Doris 的存储策略：冷数据转 S3 之后，这几件事得先知道</span>
<span class="post-d">策略建了就删不掉，换个 S3 得重建表，cooldown 算的是写入时间不是业务时间。好消息是 S3 挂了不影响集群健康。</span>
</a>

<a class="post" href="/doris/cross-datacenter-query">
<span class="post-t">Doris 跨数据中心查询：查视图还是查底表，差别在执行计划里</span>
<span class="post-d">同一个聚合查询，查视图只有过滤能下沉，23 万行全量跨机房；查底表自己写两层聚合，跨机房的只有 19 行。</span>
</a>

</div>

<!-- TODO 选题储备：
  · BE 打机房标签做写入隔离：建表 tag、副本分布、扩缩容时标签怎么变
  · Merge-on-Write 的 delete bitmap：写入放大、compaction 时机
  · FE 元数据与 FDB：存算分离模式下的运维负担
-->
