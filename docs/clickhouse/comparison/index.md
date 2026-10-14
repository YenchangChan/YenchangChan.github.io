# 选型与横评

这一栏放的是选型和横评：ClickHouse 和 Doris 怎么选、日志检索三家实测、存算分离谁真的做到了、OpenObserve 到底怎么样，还有写入链路为什么不用 Kafka engine。

每篇都会给结论，读完得知道该选哪个，不然就只是科普。结论是主观的，但结论依赖的事实不该是：有实测的写清楚测试条件，没实测的说明是推断，读源码得出的标出版本和位置，厂商自测的数字单独标出来。

有一点得先交代。我是做 ClickHouse 的，在它上面踩了十年坑，知道它的坑在哪、有多深、怎么绕。Doris、StarRocks、GreptimeDB 这些，我的深度远不如 CK，看到的主要是它们的优点，加上碰巧踩到的那几个坑。两边已知的坑数量不对等，不一定是对方坑少，更可能是我在那边待得不够久，没为它熬过夜。我没法消除这个偏差，只能写在这里，你读结论的时候自己打个折。

## 文章

<div class="posts">

<a class="post" href="/clickhouse/comparison/clickhouse-vs-doris">
<span class="post-t">2026 年 ClickHouse 和 Doris 怎么选</span>
<span class="post-d">从出身、查询、存储、运维到生态一项项比下来，最后给出我的选择：推 ClickHouse，以及哪几种情况该直接上 Doris。</span>
</a>

<a class="post" href="/clickhouse/comparison/log-search-ck-doris-es">
<span class="post-t">日志检索三家实测：压缩比差距有一半不是日志本身</span>
<span class="post-d">CK / Doris / ES，2 亿行、558 条等价查询、三批中位数。ES 正向检索快一个数量级，但取反和全扫上排名会翻转；CK 与 ES 的压缩比差距只存正文时从 1.88 倍缩到 1.34 倍。</span>
</a>

<a class="post" href="/clickhouse/comparison/storage-compute-separation">
<span class="post-t">存算分离横评：谁真的做到了</span>
<span class="post-d">用同一把尺子量 ClickHouse、OpenObserve、Doris、GreptimeDB 和 ByConity，再算存算分离没写进宣传的那些账。最后是我的选择：冷数据要便宜、能查，不一定非得存算分离。</span>
</a>

<a class="post" href="/clickhouse/comparison/openobserve-internals">
<span class="post-t">OpenObserve 的 140x 压缩：源码里的分母是什么</span>
<span class="post-d">系列第一篇。从源码看 O2 的存储与查询内核，营销说法逐条核对，对不上的标出来。</span>
</a>

<a class="post" href="/clickhouse/comparison/openobserve-benchmark">
<span class="post-t">OpenObserve 压测实录：27.3 亿行下的真实表现</span>
<span class="post-d">系列第二篇。同数据、同压缩级别、功能对等、口径一致，已知的不公平之处也写在文里。</span>
</a>

<a class="post" href="/clickhouse/comparison/why-not-kafka-engine">
<span class="post-t">为什么不用 Kafka engine，也不写分布式表</span>
<span class="post-d">两个问题其实是一个：Kafka 到 ClickHouse 这条写入路径该由谁控制。也写了写本地表自己的代价，以及什么时候该换回 engine。</span>
</a>

</div>

S3 冷盘 TTL、BACKUP、Parquet + chDB 这几种冷数据方案怎么选，单独放在了 [冷热分层](/clickhouse/cold-storage/) 那一栏，展开有七篇，塞在这里装不下。

<!-- TODO：
  - ClickHouse vs StarRocks：sharding 所有权的架构假设差异
    （内链到 /clickhouse/tooling/why-not-auto-rebalance）
-->
