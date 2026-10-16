# 采集器工程

跑在别人业务机上的程序：要高性能，又不能喧宾夺主。出了问题进不去现场，所以很多手段得提前做进程序里。

<div class="posts">

<a class="post" href="/systems/agent/memory-leak-tool-blind-spots">
<span class="post-t">内存泄漏排查：为什么 valgrind 查不出内存池里的泄漏</span>
<span class="post-d">valgrind、mtrace、bcc <code>memleak</code>、自己写 hook，各自漏在哪。用 <code>apr_pool</code> 的常驻进程，退出时一查干干净净，跑起来却在涨。</span>
</a>

<a class="post" href="/systems/agent/dwarf-version-mismatch">
<span class="post-t">明明加了 -gdwarf-4，core 里还是没有行号</span>
<span class="post-d">gcc 11 默认 DWARF 5，客户机的 gdb 7.6 只认到 4。全局设了 <code>CC</code>，bzip2 的 Makefile 把它覆盖了，7 个编译单元让整个静态链接二进制的调试信息作废。</span>
</a>

</div>

## Fluent Bit 源码笔记

读 Fluent Bit `in_tail`、`filter_kubernetes` 与 K8s 采集架构的五篇笔记。它是我们的同类产品，所以只写有代码位置和实测支撑的东西，每篇都对照上游 master 和在途 PR 复核过，并单独写「哪些不算缺陷」。

<div class="posts">

<a class="post" href="/systems/agent/fluent-bit-backpressure-delivery">
<span class="post-t">（一）背压与投递，先不伤害宿主</span>
<span class="post-d">默认配置内存无上界；offset 记的是「已读取」不是「已投递」；轮转和删除放弃未读数据，丢了多少没有指标。</span>
</a>

<a class="post" href="/systems/agent/fluent-bit-million-files">
<span class="post-t">（二）百万个只写一次的文件</span>
<span class="post-d"><code>ignore_older</code> 只看 mtime 不看读完没有；淘汰记录表永不淘汰。长期持有 fd 是架构取舍，fd 无上限是实现缺失。附「文件过期」的另一种模型。</span>
</a>

<a class="post" href="/systems/agent/fluent-bit-offset-identity">
<span class="post-t">（三）采集器怎么记住自己读到了哪里</span>
<span class="post-d">内存层用 <code>dev:inode</code>、持久层只用 inode；多个 input 共用一个库时互删记录，上游在途的修复和我一开始想的方向相反。</span>
</a>

<a class="post" href="/systems/agent/fluent-bit-read-boundary">
<span class="post-t">（四）读取边界上的数据丢失，GBK 日志丢了 27.4%</span>
<span class="post-d">物理位置与逻辑位置混用：GBK 实测丢 27.4%、UTF-16 每个边界丢一行、<code>.gz</code> 中断后永远读不出来。三个预测都被实测推翻过。</span>
</a>

<a class="post" href="/systems/agent/fluent-bit-kubernetes-logging">
<span class="post-t">（五）Kubernetes 日志采集，身份从文件路径里猜</span>
<span class="post-d"><code>filter_kubernetes</code> 的身份机制与时效暗坑（TTL 默认 0 永不过期）、六种挂载方式矩阵、symlink 断链、hostPath 混写；再拿 loggie 过同一张问题清单：discovery 专业、文件采集外行、上游断更，选型结论落在最后。</span>
</a>

</div>

<!-- TODO：
  · 海量小文件：AIX(POWER5) 扫 100 万文件 288 秒 vs Linux 1.4 秒
    （「文件过期」、专利 CN120541047A 和这组数据都已写进 fluent-bit-million-files，
      测试条件：POWER5 / AIX 6.1 / 2c4G / 100G HDD）
  · 多平台移植：AIX / HP-UX / ARM 鲲鹏 / PowerPC
  · 长连接下的负载倾斜：为什么水平扩容没有转化成有效吞吐
  · Go → Java/Netty → Rust 三轮重构：20万 → 120万 ops，内存 7GB → 400MB
-->
