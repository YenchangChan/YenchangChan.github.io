# 采集器工程

跑在别人业务机上的程序：要高性能，又不能喧宾夺主。出了问题进不去现场，所以很多手段得提前做进程序里。

<div class="posts">

<a class="post" href="/systems/agent/memory-leak-tool-blind-spots">
<span class="post-t">进程退出时一个字节都没漏，跑起来却一直在涨</span>
<span class="post-d">valgrind、mtrace、bcc <code>memleak</code>、手写 hook 各自结构上看不见什么。常驻进程 + <code>apr_pool</code> 内存池，恰好落在退出时对账类工具的判据之外。</span>
</a>

<a class="post" href="/systems/agent/dwarf-version-mismatch">
<span class="post-t">明明加了 -gdwarf-4，core 里还是没有行号</span>
<span class="post-d">gcc 11 默认 DWARF 5，客户机的 gdb 7.6 只认到 4。全局设了 <code>CC</code>，bzip2 的 Makefile 把它覆盖了 —— 7 个编译单元，让整个静态链接二进制的调试信息作废。</span>
</a>

</div>

<!-- TODO：
  · 海量小文件：AIX(POWER5) 扫 100 万文件 288 秒 vs Linux 1.4 秒
    「文件过期」与「目录遗忘」——把监控全量降为监控活跃量
    （发明专利 CN120541047A）
  · 多平台移植：AIX / HP-UX / ARM 鲲鹏 / PowerPC
  · 长连接下的负载倾斜：为什么水平扩容没有转化成有效吞吐
  · Go → Java/Netty → Rust 三轮重构：20万 → 120万 ops，内存 7GB → 400MB
-->
