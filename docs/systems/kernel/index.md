# 内核问题定位

两起金融客户的整机 hang 死 / soft lockup。共同点是：**事故初期，采集器都被认定为元凶。**

方法是一样的 —— `crash` 解析 vmcore 调用栈，比对发行版内核源码 diff，再结合上游同型补丁交叉验证。

<div class="posts">

<a class="post" href="/systems/kernel/ext3-jbd-memcg-oom-deadlock">
<span class="post-t">采集器被两家客户判了死刑，然后我们翻了案</span>
<span class="post-d">jbd 事务与 memory cgroup OOM 互锁。根因是 RedHat 在 3.10.0-862.el7 移植补丁时，把 <code>__GFP_NOFAIL</code> 在 <code>__add_to_page_cache_locked()</code> 里按位与掉了。</span>
</a>

<a class="post" href="/systems/kernel/xfs-soft-lockup-cond-resched">
<span class="post-t">限了 CPU 配额，它还是把整机卡死了 22 秒</span>
<span class="post-d">XFS 在 extent 遍历路径上缺 <code>cond_resched()</code>，非抢占内核下单次调用自旋 22 秒；持有 <code>XFS_ILOCK_EXCL</code> 把单核故障放大成整机夯死。附证据边界说明：这次没拿到栈级实锤。</span>
</a>

</div>

<div class="soon">

两起都写完了。这一栏接下来会补资源与容器方向的内容。

</div>

<!-- TODO：两起金融客户的整机 hang 死 / soft lockup。
     事故初期客户和云厂商的内核团队都归因于采集器。

  方法：crash 解析 vmcore 调用栈 → 比对发行版内核源码 diff
        → 结合上游同型补丁交叉验证

  ① jbd 日志事务与 memory cgroup OOM 互锁
     发行版移植补丁时在 __add_to_page_cache_locked() 抹掉了 __GFP_NOFAIL，
     导致 __getblk 的分配仍受 cgroup 约束。

  ② XFS extent 遍历路径缺失 cond_resched()
     非抢占内核下内核态自旋超过 watchdog 阈值，
     且持有 XFS_ILOCK_EXCL，引发全系统级联 D 状态。

  两次结论都获客户与云厂商内核团队认可，
  分别促成内核热补丁和生产环境内核升级。

  【写法】函数名、锁名、标志位全部保留 —— 这一段是门槛，不要稀释。
  看不懂的人会划过去，看懂的人会停下来。
-->
