# 内核问题定位

<div class="soon">

这一栏还没有文章。要写的是两起整机 hang 死的定位过程 —— 事故初期采集器被认定为元凶，最后根因在内核。

在那之前，[Field Notes](/notes/) 里有一些可以直接用的判断方法。

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
