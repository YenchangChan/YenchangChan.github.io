# 选型与横评

## 先把立场摆出来

**我是做 ClickHouse 的，我有偏向。**

所以这一栏不假装中立 —— 假装中立只有两种可能：要么我没有利害关系（那我的判断也就没什么分量），要么我在藏着。两种都不如直接说。

**但站队不等于回避缺点。** 恰恰相反：这一栏里 ClickHouse 的短处，我会说得比说对手的时候更狠。原因很简单 —— 一个明确站队、却主动讲自己这边短处的人，才是可以被检验的。你去验，验对了，你就知道我别的话也没骗你。

## 一个我必须先声明的偏差

我在 ClickHouse 上踩了十年坑，所以我知道它的坑在哪、有多深、怎么绕。

我在 Doris、StarRocks、GreptimeDB 这些上面的深度远不如 CK，所以我看到的主要是它们的优点，以及我碰巧踩到的那几个坑。

> **两边「已知坑的数量」不对等，不是因为对方坑少，是因为我在对方那里待得不够久。**

这是技术选型里最该警惕的偏差：**你总是低估你不熟悉的那套东西的运维成本，因为你还没为它熬过夜。**

我没法消除这个偏差，只能把它写在这里，让你在读我的结论时自己打个折。

## 这一栏怎么写

每篇大致四段：

1. **我的立场和偏向** —— 开篇就说
2. **需求到底是什么** —— 把「要某个功能」翻译成「要解决什么问题」。这两件事经常不一样
3. **各方案的代价** —— 包括我推荐的那个方案的代价，而且要算全：一个新组件带来的不只是它的能力，还有它的运维面、它的故障模式、以及你还没学会的那部分
4. **我会选什么，以及什么情况下我会改主意** —— 后半句不能省

::: tip 一个反复出现的判断
**「这个能力它没有」和「这个需求解决不了」不是一回事。**

存算分离是最典型的例子：Doris 有原生支持，ClickHouse 没有。但需求其实是「冷数据要便宜、还要能查」，不是「要一个叫存算分离的功能」。

定时导出 Parquet + chdb 就地查询解决了这个需求，代价是一个导出任务；上 Doris 也解决了，代价是 FDB + FE + BE 一整套新的运维面，外加一批你还没学会的故障模式。

**为一个能力引入一整套组件，账要算全。**
:::

## 证据分级

有实测的标出测试条件，没实测的标明是推断，读源码得出的标出版本和位置。

**别让读者替我承担判断成本** —— 这一栏的结论是主观的，但结论依赖的事实不该是。

---

## 文章

<div class="posts">

<a class="post" href="/clickhouse/comparison/clickhouse-vs-doris">
<span class="post-t">2026 年 ClickHouse 和 Doris 怎么选</span>
<span class="post-d">CK 的主要对手已经从 Elasticsearch 换成了 Doris。基础属性、性能、运维、生态四个维度，外加一份「过时论调」清单 —— 包括我自己此前判断错的那几条。</span>
</a>

<a class="post" href="/clickhouse/comparison/storage-compute-separation">
<span class="post-t">存算分离横评：谁真的做到了</span>
<span class="post-d">四个系统用同一把尺子量，结论来自官方原句与源码。以及我的立场：这道题也可以不做 —— 「能力缺失 ≠ 需求无解」最完整的一个案例。</span>
</a>

<a class="post" href="/clickhouse/comparison/openobserve-internals">
<span class="post-t">拆解 OpenObserve 的 140x 压缩神话</span>
<span class="post-d">系列第一篇。源码级深挖 O2 的存储与查询内核，营销话术单独核验，没扛住的标记「已证伪」。</span>
</a>

<a class="post" href="/clickhouse/comparison/openobserve-benchmark">
<span class="post-t">OpenObserve 压测实录：27.3 亿行下的真实表现</span>
<span class="post-d">系列第二篇。同数据、同压缩级别、功能对等、口径一致，已知的公平性缺口一并写在文里。</span>
</a>

</div>

::: tip 冷数据方案对比在哪
「S3 冷盘 TTL / BACKUP / Parquet + chDB 怎么选」这个题目单独成栏了，在 [冷热分层](/clickhouse/cold-storage/) —— 因为它展开之后有七篇，塞在横评里装不下。
:::

<!-- TODO：
  - ClickHouse vs Elasticsearch：日志场景
  - ClickHouse vs StarRocks：sharding 所有权的架构假设差异
    （内链到 /clickhouse/tooling/why-not-auto-rebalance）
-->
