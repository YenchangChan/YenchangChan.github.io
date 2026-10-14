# 一次讲透

挑一个 ClickHouse 的功能，或者一类反复碰到的问题，从它内部怎么运作，一直讲到生产上的边界在哪。

## 和官方文档的分界

官方文档告诉你一个参数叫什么。这一栏想讲的是它的默认值为什么是这个，什么时候会反咬你一口，到了什么规模它就不成立了。

怎么用就不写了，那部分官方文档比我写得全，也比我更新得快。

## 一个话题一篇，不拆

栏目叫一次讲透，拆成六篇就是自己打自己的脸。

代价是单页很长，字典那篇一万五千字。右边的目录就是为这个准备的，这类文章本来也不是让人从头读到尾的，是等你真撞上问题的时候，直接跳到那一节去看。

## 和别的栏目的分界

这几栏都会往深里讲，区别在于从哪儿起头：

| 栏目 | 起点 |
|---|---|
| [生产排障](/clickhouse/troubleshooting/) | 一起真实事故，讲到哪儿由那次踩到的东西决定 |
| [工具与设计](/clickhouse/tooling/) | 一个产品决策，为什么值得做成能力，或者为什么不做 |
| [选型与横评](/clickhouse/comparison/) | 一次跨产品对比 |
| 一次讲透 | 一个功能或一类问题本身，不等事故发生，先把它摊开 |

排障篇受事故的限制，只能讲到踩中的那一块；这边可以整个摊开讲，反过来也能给排障篇做个背书。

像 Too many parts 这种，不是哪一次事故的复盘，是这些年被问了太多遍攒出来的，所以放在这一栏。

## 版本

行为会随版本变。文章里凡是某个版本起才这样的，都标了版本号；读源码得出来的，标了位置；没实测过的，会说一句是推断。

## 文章

<div class="posts">

<a class="post" href="/clickhouse/deep-dive/too-many-parts">
<span class="post-t">Too many parts：merge 追不上写入的时候</span>
<span class="post-d">改上限是自欺欺人，OPTIMIZE 是饮鸩止渴。能做的只有两件事：少产生 part，让 merge 跑得动。</span>
</a>

<a class="post" href="/clickhouse/deep-dive/too-many-partitions">
<span class="post-t">Too many partitions：和 Too many parts 一词之差，处理方式截然相反</span>
<span class="post-d">一个要把 batch 调大，一个要把 batch 调小。临时导入可以放宽上限，常态写入不行。</span>
</a>

<a class="post" href="/clickhouse/deep-dive/inconsistent-query-results">
<span class="post-t">同一条 SQL 每次查出来不一样：先看它是怎么变的</span>
<span class="post-d">表引擎用错、副本同步延迟、去重引擎没加 FINAL、TTL，四种原因看结果怎么变就能分开。</span>
</a>

<a class="post" href="/clickhouse/deep-dive/materialized-view">
<span class="post-t">物化视图：三种机制，以及 100T 表上的 POPULATE</span>
<span class="post-d">传统 MV、TO TABLE、Refreshable 到底差在哪，大表怎么选，回填、修数据和 schema 演化怎么做。</span>
</a>

<a class="post" href="/clickhouse/deep-dive/dictionary">
<span class="post-t">字典：省掉的 JOIN，多付的内存</span>
<span class="post-d">刷新时 2.2~2.5 倍的内存尖刺、LAYOUT 怎么选，以及到了什么规模就不该再用字典。</span>
</a>

<a class="post" href="/clickhouse/deep-dive/udf">
<span class="post-t">到底要不要写 UDF</span>
<span class="post-d">SQL、Executable、WASM 三种形态性能差着一个数量级，而大多数「需要 UDF」的场景其实用不着。</span>
</a>

</div>

<!-- TODO 选题储备：
  · 副本同步机制：ReplicatedMergeTree 的 log / queue / znode 结构，
    fetch 与 merge 怎么分线程池，副本落后的几种形态怎么区分。
    写完后与 /clickhouse/troubleshooting/keeper-async-blocks 互链 ——
    那篇追到了异步插入去重的 znode，但没法展开整体结构，正好各补各的。
  · merge 机制：为什么 OPTIMIZE 不解决 too many parts（Too many parts 那篇给了结论，这里给全论证）、
    merge_selecting 的挑选策略、TTL merge 与普通 merge 抢线程池。
  · 窗口函数：CH 的实现与标准 SQL 的差异、内存模型、
    什么时候该用它、什么时候该退回聚合 + JOIN。

  【写法】和排障栏的分工：这里写机制，那里写事故。
        同一个话题两边都有的时候，机制篇在前，事故篇内链回来。
-->
