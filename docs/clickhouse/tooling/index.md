# 工具与设计

不写功能怎么用 —— 官方文档有。这里写的是：**为什么这件事值得做成产品能力，以及为什么有些能力我选择不做。**

每篇大致五节：

1. 这个问题长什么样
2. 为什么它是普遍的（一次是个案，三次是模式）
3. 为什么不是写个脚本就完了 ← 这节决定文章的层次
4. 设计里的取舍：做了什么、没做什么、为什么
5. 做完之后：实际效果，以及暴露出的新问题

## 项目

| | | 文档 |
|---|---|---|
| **[ckman](https://github.com/housepower/ckman)** | ClickHouse 集群可视化管理工具。第一作者。收录进 ClickHouse 官方 GUI 工具文档 | [housepower.github.io/ckman](https://housepower.github.io/ckman/) |
| **[clickhouse_sinker](https://github.com/housepower/clickhouse_sinker)** | Kafka → ClickHouse 高速导入工具。主要维护者 | [housepower.github.io/clickhouse_sinker](https://housepower.github.io/clickhouse_sinker) |

官方文档讲的是**怎么用**。这一栏讲的是**为什么这么做** —— 两边内容不重复。

## 文章

<div class="posts">

<a class="post" href="/clickhouse/tooling/why-not-auto-rebalance">
<span class="post-t">扩容之后为什么不自动做数据均衡</span>
<span class="post-d">技术上完全做得到，但 sharding 的所有权假设决定了它不该由工具替你决定。</span>
</a>

</div>

<!-- TODO：
  - 线程池监控与合并指标：起点是我自己因为看不见而给了错误建议
  - 为什么工具该替用户记住版本差异
  - sinker 的多租户路由：为什么在写入时分流
  - 备份与归档：三阶段论证为什么落在 Parquet + chdb
  - AI 运维助手：哪些运维场景适合交给 Agent，哪些不适合
-->
