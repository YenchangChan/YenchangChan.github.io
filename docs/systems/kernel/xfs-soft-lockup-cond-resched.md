---
title: XFS soft lockup：限了 CPU 配额，整机还是卡死 22 秒
---

# XFS soft lockup：限了 CPU 配额，整机还是卡死 22 秒

2026-04-29 凌晨一点前后，一台 16 vCPU 的机器上，所有业务服务同时夯死了。内核只留下了一行告警，括号里是我们的采集进程：

```
kernel: watchdog: BUG: soft lockup - CPU#10 stuck for 22s! [collector:783519]
```

系统日志里的时间戳是 03:16:11，那是延迟打印的，实际出事在一点左右。Web、数据库、日志服务全都没了响应。16 个核，卡死的只有 1 个，整机却不能用了。

业务路径、账号名和进程名都脱敏了，内核函数名、锁名、配置项和版本号保持原样。

## 现场

| | |
|---|---|
| 时间 | 2026-04-29 01:00 前后（系统日志时间戳 03:16:11 是延迟打印） |
| 现象 | 内核 soft lockup，CPU#10 卡死 22 秒，全部业务服务夯死 |
| 系统 | Kylin Linux Advanced Server V10 (Tercel) |
| 内核 | `4.19.90-23.52.v2101.ky10.x86_64` |
| 配置 | 16 vCPU |
| 关键进程 | 文件采集程序（PID 783519） |
| 被监控文件 | 位于 XFS 分区的一个 `monitor.log` |

再看采集器自己的日志。故障那段时间里，它以每秒 67 次左右的频率，对同一个文件反复打印：

```
[file_input] inode changed for '.../monitor.log': reopening possibly rotated file
```

每判定一次 inode 变了，就要走一遍完整的 `close → open → seek → read`。

## 限额为什么没用

看到采集进程把 CPU 卡了 22 秒，最自然的反应就是给它限 CPU。可这台机器上，采集器本来就有 cgroup CPU 限额，限额在，事照样出了。

问题在于 `cpu.cfs_quota_us` 管的是 CFS 调度器分给任务的运行时间总量，它没办法抢占内核态里不可抢占的那段代码。XFS 遍历 extent 恰好就是这么一段代码。哪怕把采集器限到单核 20%，一次 `xfs_iread_extents()` 调用照样可以在内核态连着跑 22 秒不撒手。进程一旦进了内核态的非抢占段，配额就形同虚设。反过来说，限额在这儿不起作用，恰恰说明该主动让出 CPU 的是内核，不是进程。

## 缺一个 cond_resched()

这是 4.19 内核 XFS 模块的一个已知缺陷。XFS 处理大量 extent 时，会走 in-core 加载和映射的那几条路径，包括但不限于：

```
xfs_iread_extents()
xfs_bmapi_read()
xfs_bmap_search_extents()
iomap_finish_ioend()
```

这些路径在循环遍历 extent 时，缺少主动让出 CPU 的 `cond_resched()`。在非抢占内核上（`CONFIG_PREEMPT_NONE=y` 或 `CONFIG_PREEMPT_VOLUNTARY=y`），碰上 extent 数量极大的文件，一次调用就能在内核态跑上几十秒。soft lockup 的判定阈值是 `watchdog_thresh` 的两倍，默认 20 秒，超过就会被报出来，日志里常见的就是这个 22s。

受影响的范围大致是：

| 来源 | 范围 |
|---|---|
| Linux 上游 | 4.19 / 5.x 部分 LTS 分支，直到 6.x 早期 |
| KylinOS | 4.19.90 系列（`4.19.90-25.26` 已合入修复） |
| OpenEuler | 20.03 LTS（4.19 系） |
| 其他 | 各厂商基于 `CONFIG_PREEMPT_NONE` 编译的内核（Alibaba Cloud Linux、Oracle UEK 等） |

那凭什么说是内核的锅，不是采集器的锅？内核态长时间不让出 CPU，是这次卡死 22 秒的直接原因，采集器高频访问只是把这条路走了很多遍。要是问题出在采集器占的 CPU 太多，限额应该管用才对，它不管用，说明问题不在占多少。换任何一个用户态程序，高频访问一个碎片化严重的 XFS 文件，都能复现。更何况新版内核已经加上 `cond_resched()`、或者改成增量加载把它修掉了，上游打了补丁，就等于认了这是内核的问题。

## 一个核卡住，16 个核全停

卡一个核，为什么整机都不行了？

一方面，CPU#10 进了内核态的不可抢占段，调度器在这个 CPU 上调度不了任何别的任务。它要是同时还攥着自旋锁、RCU、journal 这类全局资源，影响就会直接溢出到别的 CPU 上。

另一方面，`xfs_iread_extents()` 和部分 bmap 路径执行时，持有这个 inode 的排他锁 `XFS_ILOCK_EXCL`。这时候别的进程要读写这个文件、要做块映射，都得先拿这把锁，于是一个接一个进了不可中断的 D 状态。偏偏被监控的那个日志目录，又是好几个业务共用的。

```
CPU#10 在内核态自旋（22s）
        │  持有 XFS_ILOCK_EXCL
        ▼
业务进程 A  read()   → 等锁 → D
业务进程 B  write()  → 等锁 → D
业务进程 C  read()   → 等锁 → D
        ▼
所有依赖该 XFS 分区的服务全部夯死
```

## 这次的证据只到这一步

得交代一句，这次跟[那次 ext3 的事故](/systems/kernel/ext3-jbd-memcg-oom-deadlock)不一样。那次有 vmcore，可以一帧一帧地读栈；这次服务器恢复后已经重启了，`systemd-journald` 当时又没开持久化，soft lockup 之后的 Call Trace、可能有的 hung_task dump 和 RCU stall，全都找不回来了。所以到底是哪一个 XFS 函数在空转，没法从栈上直接坐实。

现场确实拿到手的，是那行 soft lockup 告警的原文（SSH 终端缓存、截图和工单记录里都有），还有采集器日志里 30 秒窗口内每秒 67 次左右的 reopen 循环，说明故障期间它确实在高频地 `close → open → seek → read`。

剩下的判断，靠的是同类问题的资料：上游有个 iomap 补丁，明确说给 XFS 的长循环加上 `cond_resched()` 就能解决 soft lockup，在 4.18、5.1、5.15 几个版本上都复现过（[lore.kernel.org](https://lore.kernel.org/all/20211230193522.55520-1-trondmy@kernel.org/)）；还有维护者讨论 `xfs/170` 测试触发 XFS soft lockup 的邮件（[lore.kernel.org](https://lore.kernel.org/all/YYaWma0v5qrECIts@mit.edu/T/)）；Red Hat 的几篇 KB，[System hangs due to XFS lockups](https://access.redhat.com/solutions/2964341)、[xfsdatad CPU stuck for 67s](https://access.redhat.com/solutions/447743)、[xfs_inode i_lock 死锁导致系统挂起](https://access.redhat.com/solutions/4742131)；OpenEuler 在同一个 4.19 分支上，有一个传播 `xfs_log_force` 返回值以避免 soft lockup 的补丁；KylinOS `4.19.90-23.8` 上也有 soft lockup 的处置案例。

故障文件当时的碎片化程度也没取证，复盘时应该补一下 `filefrag -v` 或者 `xfs_bmap -v`，确认高度碎片化这个前提是成立的。

## 什么情况下会撞上，怎么办

三个条件同时满足才会出事：

```
① 被监控文件位于 XFS 分区，且已高度碎片化（extent 数量极大）
② 用户态程序对该文件高频 reopen：close → open → seek → read，约 67 次/秒
③ 内核版本在受影响范围内（本例 4.19.90-23.52，未含修复补丁）
```

根治只能升级内核，用户态的规避手段都只是降低撞上的概率：

| 发行版 | 建议版本 |
|---|---|
| KylinOS V10 | ≥ `4.19.90-25.26.v2101.ky10` |
| OpenEuler 20.03 LTS | 最新 `4.19.90-2401.x.0` 或更高 |
| RHEL / Rocky 8 | `4.18.0-513` 之后含相关 XFS backport 的版本 |

内核升级到位之前，能做的有这么几件。升级采集器，改掉文件检测和重开的逻辑，把 `close → open → seek → read` 的频率降下来，这是打掉条件②。用 `xfs_fsr -v /被监控分区` 整理碎片，这是打掉条件①，不过 `xfs_fsr` 对持续高速写入的活跃文件效果有限，得连着上游的写入方式一起改。调 XFS 的挂载参数和预分配，比如 `noatime,nodiratime,allocsize=16m`，或者在应用侧用 `posix_fallocate()` 做连续预分配，别边写边生出一堆小 extent。

还有一件，是去查上游应用是怎么写日志的。先看看 inode 是不是真的在变：

```bash
for i in $(seq 1 20); do stat -c %i monitor.log; done
```

真在变的话，就去看写入端是不是用了删除再重建、或者 rename 之后再 create 这种会换 inode 的写法，建议改成 append 写入。

这件事我觉得最该做。采集器之所以疯狂 reopen，是因为它每次都真的检测到 inode 变了，它只是在如实反应，根子在写日志的那一头。

## 最后

这台机器上的 cgroup CPU 限额没拦住整机卡死。[ext3 那次](/systems/kernel/ext3-jbd-memcg-oom-deadlock)，cgroup 内存限额不但没保护住系统，还是死锁成立的前提。

两次想下来，cgroup 限额是有前提的。限内存，进程超限会被 OOM Killer 杀掉，可前提是它杀得掉，进程在 D 状态收不到信号的时候，这个前提就不成立。限 CPU，进程超限会被调度器挤下去，可前提是它能被抢占，进了内核态的非抢占段，这个前提也不成立。两次出事，都出在前提不成立的地方。所以一个进程占资源太多，限额是管用的；可它要是在内核里卡住出不来，限额拦不住，整机照样跟着一起倒。

---

**相关**：[ext3 + memcg 的 OOM 死锁：采集器差点背了锅](/systems/kernel/ext3-jbd-memcg-oom-deadlock)
