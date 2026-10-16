# 信创与异构环境

同一个 ClickHouse，换一个运行环境，行为不一定一样：换个发行方（华为 MRS 这类托管版），换个 CPU 架构（国产 ARM），换个操作系统（麒麟）。

这类问题比版本变更还难查，因为它连 changelog 都没有。官方文档不会写，开源社区没人遇到过，厂商文档里也往往找不到。而且很多根本算不上 bug，官方的选择挺合理，只是和国产化环境的约束对不上。踩到的时候，往往先怀疑是自己配置写错了。

## 硬件与指令集

<div class="posts">

<a class="post" href="/clickhouse/vendor/kylin-arm-instruction-baseline">
<span class="post-t">ARM 上一跑就 SIGILL：缺的是 rcpc，自检又来不及报</span>
<span class="post-d">扫了 8900 万条指令，缺的其实是 rcpc，LSE 没问题。ClickHouse 的指令集自检又排在崩溃之后，出了事什么都不说。</span>
</a>

<a class="post" href="/clickhouse/vendor/chdb-avx-baseline">
<span class="post-t">chdb 在老 CPU 上 SIGILL：同一台机器，clickhouse 却跑得好好的</span>
<span class="post-d">chdb 编译时把基线从 SSE4.2 抬到 AVX，<code>-mavx</code> 把所有 SSE 指令改编成 VEX 编码，静态初始化器里第一条就死，早于 <code>main()</code>，无声无息。降回 SSE4.2，热点性能一条不少。</span>
</a>

</div>

## 操作系统与发行版

<div class="posts">

<a class="post" href="/clickhouse/vendor/systemd-ambient-capabilities">
<span class="post-t">systemd AmbientCapabilities：同一个 rpm，一台起得来一台起不来</span>
<span class="post-d">23.7 起官方 unit 加了 <code>AmbientCapabilities=</code>，依赖上游 4.3 的 <code>PR_CAP_AMBIENT</code>；RHEL 7 到 <code>3.10.0-514</code> 才 backport。版本号相同，功能集不同。</span>
</a>

</div>

## 华为 MRS

<div class="posts">

<a class="post" href="/clickhouse/vendor/huawei-mrs-protocol-trap">
<span class="post-t">华为 MRS 的连接协议陷阱：内存涨到 60G，根因不在内存</span>
<span class="post-d">以为是内存泄漏，查到最后是新版 MRS 改了连接协议，逼得我们只能走 HTTP。</span>
</a>

<a class="post" href="/clickhouse/vendor/mrs-http-prepare-cache">
<span class="post-t">并发 INSERT 串表：HTTP 下 prepare 语句的缓存陷阱</span>
<span class="post-d">连接池复用连接，服务端按连接缓存 prepare 语句，两边单看都没错，凑一块数据就落到了别的表上。</span>
</a>

</div>

<!-- TODO：阿里云 / 腾讯云托管版的差异；其他国产 OS / CPU 的适配 -->
