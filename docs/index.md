---
pageClass: home-page
---

# 禹鼎侯

<p class="hero-line">做 ClickHouse 的存储与集群运维，主要场景是金融和信创。</p>

<div class="home-lede">

这类环境有几个共同点：变更窗口是提前排期排出来的，出了事进不去现场，机器可能是 aarch64，网络大概率不通外网。所以判断标准和互联网侧不太一样 —— **确定性优先于最优性**。一个边界清楚、能回滚的方案，比一个理论上更优但说不准的方案有用。

这不意味着可以不要性能。只是当两者冲突时，知道该放弃哪个。

</div>

<div class="idlinks">
<span class="id"><a href="https://github.com/housepower/ckman">ckman</a><i>author</i></span>
<span class="id"><a href="https://github.com/housepower/clickhouse_sinker">clickhouse_sinker</a><i>maintainer</i></span>
<span class="id"><a href="https://github.com/ClickHouse/ClickHouse">ClickHouse</a><i>contributor</i></span>
<span class="id"><a href="https://github.com/ClickHouse/clickhouse-go">clickhouse-go</a><i>contributor</i></span>
</div>

<hr class="hr-soft" />

## 版本升级，哪些地方会崩

ClickHouse 的行为变更很少上头条，但每一条都能让你在升级当晚多待三个小时。下面是几条已经踩实的 —— 完整清单在 **[版本升级避坑清单](/clickhouse/upgrade-gotchas)**。

<ul class="timeline">
<li>
<span class="tl-v">20.12</span>
<span class="tl-d"><code>background_fetches_pool_size</code> 引入，此前 fetch 与 merge 共用线程池。默认值 <code>3</code></span>
</li>
<li>
<span class="tl-v">21.2</span>
<span class="tl-d">官方意识到 3 个线程在大数据量场景根本不够用，默认值提到 <code>8</code></span>
</li>
<li class="break">
<span class="tl-v">21.10</span>
<span class="tl-d"><strong><code>replicated_max_parallel_fetches</code> 废弃。</strong>网上还有大量资料在教人用它调 fetch 并发 —— 你可以设置，但没有任何效果</span>
</li>
<li class="break">
<span class="tl-v">22.5</span>
<span class="tl-d"><strong>从 profile 级升级为全局配置。</strong>改在旧位置不报错，只是不生效 —— 副本同步队列会一直堆，而你以为参数已经调过了</span>
</li>
<li class="break">
<span class="tl-v">23.4</span>
<span class="tl-d"><strong><code>formatDateTime</code> 的 <code>%M</code> 从「分钟」变成「月份名」，分钟改用 <code>%i</code>。</strong>查询照常返回 —— 只是 <code>22:49:16</code> 会输出成 <code>22:December:16</code>。有开关能拨回去，藏在源码里</span>
</li>
<li class="break">
<span class="tl-v">23.3</span>
<span class="tl-d"><strong><code>skip_access_check</code> 作用域收窄。</strong>依赖它在 S3 不可达时把服务救起来的手法，升级后失效</span>
</li>
<li class="break">
<span class="tl-v">24.8</span>
<span class="tl-d"><strong><code>async_load_databases</code> 默认开启。</strong>进程起了、端口通了、探活绿了 —— 一查表报错。「起来了」不等于「可用了」</span>
</li>
<li>
<span class="tl-v">23.11</span>
<span class="tl-d">官方认为 <code>8</code> 仍偏小，<code>background_fetches_pool_size</code> 默认值改为 <code>16</code>。三次调整（3 → 8 → 16）说明它本就没有普适最优解</span>
</li>
<li class="break">
<span class="tl-v">26.3 → 26.4</span>
<span class="tl-d"><strong>text index 的 <code>unicode_word</code> 在发布次日被改名。</strong>26.3 建的索引在 26.4 打不开，而且连 <code>DROP INDEX</code> 都执行不了 —— 表进去就出不来</span>
</li>
</ul>

<hr class="hr-soft" />

## 几条经验

<div class="note">

**`OPTIMIZE TABLE` 不解决 too many parts，而且通常会加剧。**

too many parts 判定的是 part 的**数量**，`OPTIMIZE` 优化的是**数据组织** —— 它会挑最大的那些 part 去合并，长任务占满线程池槽位，真正造成问题的小 part 反而排不上队。

</div>

<div class="note">

**改了不生效，先别问「为什么不生效」，先问「它到底生效了没有」。**

前者是个开放问题，后者是个能查的问题。ClickHouse 的 settings 散在 `system.settings`、`system.server_settings`、`system.merge_tree_settings` 几张表里，不确定就都查一遍。

</div>

<div class="note">

**副本不是备份。**

ReplicatedMergeTree 防的是节点故障，防不了误删和逻辑错误。这是从 Oracle 迁过来的团队最常见的认知盲区。

</div>

更多条目在 **[Field Notes](/notes/)**。

<hr class="hr-soft" />

## 其他

<div class="entries">

<a class="entry" href="/clickhouse/troubleshooting/">
<h3>生产排障</h3>
<p>真实事故的完整复盘，包括判断错的地方和走过的弯路。</p>
</a>

<a class="entry" href="/clickhouse/tooling/">
<h3>工具与设计</h3>
<p>为什么某个能力值得做进产品，以及为什么有些技术上完全做得到的事，我选择不做。</p>
</a>

<a class="entry" href="/clickhouse/vendor/">
<h3>信创与异构环境</h3>
<p>国产 ARM、麒麟、华为 MRS —— 换个运行环境，同一个 ClickHouse 行为不一定一样。这类差异连 changelog 都没有。</p>
</a>

<a class="entry" href="/clickhouse/comparison/">
<h3>选型与横评</h3>
<p>一手压测和源码级对比。有实测的标出条件，没实测的标明是推断。</p>
</a>

<a class="entry wide" href="/systems/">
<h3>系统底层</h3>
<p>内核、cgroup、采集器工程。比 ClickHouse 更下面的那一层。</p>
</a>

</div>

<hr class="hr-soft" />

<div class="whoami">

**陈衍长 / 禹鼎侯** —— 做 ClickHouse 的工具（[ckman](https://github.com/housepower/ckman) 第一作者、[clickhouse_sinker](https://github.com/housepower/clickhouse_sinker) 维护者），也扛 ClickHouse 的线上故障。2020 年起只做这一件事，场景集中在金融和信创。

这里写的都是自己踩过的：能复现的给命令，不能复现的说清楚边界，判断错的地方也留着不删。

[关于我](/about/) · [GitHub](https://github.com/YenchangChan) · [知乎](https://www.zhihu.com/people/yu-ding-hou)

</div>
