# 一次讲透

挑一个 ClickHouse 的功能，从它内部怎么运作，一直讲到生产上的边界在哪。

## 和官方文档的分界

官方文档告诉你这个参数**叫什么**。这一栏告诉你它的默认值**为什么是这个**、什么时候会反咬你一口、以及到了什么规模它不再成立。

写「怎么用」没有意义 —— 那部分官方文档比我写得全，也比我更新得快。

## 一个功能一篇，不拆

栏目叫「一次讲透」，拆成六篇就是自己打自己脸。

代价是单页很长，字典那篇一万五千字。右侧目录是为这个准备的 —— 这类文章本来也不是用来从头读到尾的，是用来在你真撞上问题时，跳到那一节的。

## 和别处的分界

这几栏都会「讲深」，区别在**从哪里起头**：

| 栏目 | 起点 |
|---|---|
| [生产排障](/clickhouse/troubleshooting/) | 一起真实事故 —— 边界由那次踩到的东西决定 |
| [工具与设计](/clickhouse/tooling/) | 一个产品决策 —— 为什么值得做成能力，或者为什么不做 |
| [选型与横评](/clickhouse/comparison/) | 一次跨产品对比 |
| **一次讲透** | **一个功能本身** —— 不等事故发生，先把它摊开 |

两边是互补的：排障篇受事故边界限制，只能讲到踩中的那一块；机制篇可以把整个功能摊开，反过来给排障篇当背书。

## 证据与版本

行为会随版本变。每篇里凡是「某版本起如此」的判断，都标出版本号；读源码得出的标出位置；没实测的标明是推断。

**别让读者替我承担判断成本。**

## 文章

<div class="posts">

<a class="post" href="/clickhouse/deep-dive/materialized-view">
<span class="post-t">物化视图：三种机制，和那个在 100T 上必炸的关键字</span>
<span class="post-d">传统 MV / TO TABLE / Refreshable 的本质区别，大表怎么选，回填、修数据与 schema 演化。</span>
</a>

<a class="post" href="/clickhouse/deep-dive/dictionary">
<span class="post-t">字典：省掉的 JOIN，多付的内存</span>
<span class="post-d">双缓冲刷新的 2.2~2.5 倍内存尖刺、LAYOUT 选型，以及什么规模下就不该再用字典。</span>
</a>

<a class="post" href="/clickhouse/deep-dive/udf">
<span class="post-t">到底要不要写 UDF</span>
<span class="post-d">SQL / Executable / WASM 三种形态差着一个数量级，以及大多数「需要 UDF」的场景其实不需要。</span>
</a>

</div>

<!-- TODO 选题储备：
  · 副本同步机制：ReplicatedMergeTree 的 log / queue / znode 结构，
    fetch 与 merge 怎么分线程池，副本落后的几种形态怎么区分。
    写完后与 /clickhouse/troubleshooting/keeper-async-blocks 互链 ——
    那篇追到了异步插入去重的 znode，但没法展开整体结构，正好各补各的。
  · merge 机制：为什么 OPTIMIZE 不解决 too many parts（首页已有结论，这里给全论证）、
    merge_selecting 的挑选策略、TTL merge 与普通 merge 抢线程池。
  · 窗口函数：CH 的实现与标准 SQL 的差异、内存模型、
    什么时候该用它、什么时候该退回聚合 + JOIN。

  【写法】和排障栏的分工：这里写机制，那里写事故。
        同一个话题两边都有的时候，机制篇在前，事故篇内链回来。
-->
