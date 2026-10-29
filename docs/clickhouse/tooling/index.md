# 工具与设计

这里不写功能怎么用，那些官方文档里都有。这一栏写的是做工具时的取舍：一个问题为什么值得做成产品能力，碰到第三次以后为什么不能再靠写个脚本对付过去，做了什么、没做什么，以及做完之后又暴露出了什么新问题。有些能力我选择不做，也会讲为什么。

## 项目

| | | 文档 |
|---|---|---|
| [ckman](https://github.com/housepower/ckman) | ClickHouse 集群可视化管理工具。第一作者。收录进 ClickHouse 官方 GUI 工具文档 | [housepower.github.io/ckman](https://housepower.github.io/ckman/) |
| [clickhouse_sinker](https://github.com/housepower/clickhouse_sinker) | Kafka → ClickHouse 高速导入工具。主要维护者 | [housepower.github.io/clickhouse_sinker](https://housepower.github.io/clickhouse_sinker) |

## 文章

<div class="posts">

<a class="post" href="/clickhouse/tooling/deployment-topology">
<span class="post-t">ClickHouse 集群部署拓扑对比：为什么推荐「一机一副本」</span>
<span class="post-d">环形部署、轮转多集群技术上都走得通。可同样的机器，双机故障时分片不可用的概率翻倍，写本地表的工具还会静默写错分片。这也是 ckman 只支持一机一副本的原因。</span>
</a>

<a class="post" href="/clickhouse/tooling/keeper-deployment">
<span class="post-t">ClickHouse Keeper 部署对比：为什么生产推荐独立部署</span>
<span class="post-d">内置部署省一套服务，但和 ClickHouse 共用进程资源和生命周期，日志还混进同一个文件，issue #31860 至今 not planned。生产副本集群的基线应该是独立三节点仲裁集群。</span>
</a>

<a class="post" href="/clickhouse/tooling/why-not-auto-rebalance">
<span class="post-t">扩容之后为什么不自动做数据均衡</span>
<span class="post-d">技术上做得到。可 sharding 规则很多时候是写入端定的，存储层不知道它有没有业务含义，搬错了还不报错。</span>
</a>

<a class="post" href="/clickhouse/tooling/datacenter-migration">
<span class="post-t">ClickHouse 集群机房搬迁实战</span>
<span class="post-d">中小客户跨云搬迁怎么选方案、什么时候必须 reshard、sharding key 为什么锁死了合并型引擎，以及物化视图、字典、UDF 的迁移顺序。</span>
</a>

<a class="post" href="/clickhouse/tooling/metric-schema-evolution">
<span class="post-t">指标表 schema 演进：一个会让数据悄悄断流的设计</span>
<span class="post-d">业务标签参与了 <code>__series_id</code> 的计算，有人在业务系统里改了个标签，监控就断流了，哪个系统都没报错。</span>
</a>

</div>

<!-- TODO：
  - 线程池监控与合并指标：起点是我自己因为看不见而给了错误建议
  - 为什么工具该替用户记住版本差异
  - 备份与归档：三阶段论证为什么落在 Parquet + chdb
  - AI 运维助手：哪些运维场景适合交给 Agent，哪些不适合
-->
