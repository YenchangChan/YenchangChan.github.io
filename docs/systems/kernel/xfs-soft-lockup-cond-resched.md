---
title: 限了 CPU 配额，它还是把整机卡死了 22 秒
---

# 限了 CPU 配额，它还是把整机卡死了 22 秒

> 凌晨一点，一台 16 vCPU 的机器上所有业务服务同时夯死。内核只留下一行告警：`soft lockup - CPU#10 stuck for 22s!`，括号里是我们的采集进程。
>
> 这篇记录两件事：**根因是 XFS 在 extent 遍历路径上缺 `cond_resched()`**；以及 —— **为什么给采集器设的 cgroup CPU 限额，一点忙都没帮上。**
>
> 同时它是一篇**证据不完整**的复盘：现场重启后内核日志已不可恢复，栈级定位是推断而非实锤。这一点我在第五节里原样写出来了。
>
> 业务路径、账号名与进程名已脱敏；内核函数名、锁名、配置项与版本号一律保留。

## 一、现场

| | |
|---|---|
| 时间 | 2026-04-29 01:00 前后（系统日志时间戳 03:16:11 是延迟打印） |
| 现象 | 内核 soft lockup，CPU#10 卡死 22 秒，全部业务服务夯死 |
| 系统 | Kylin Linux Advanced Server V10 (Tercel) |
| 内核 | `4.19.90-23.52.v2101.ky10.x86_64` |
| 配置 | 16 vCPU |
| 关键进程 | 文件采集程序（PID 783519） |
| 被监控文件 | 位于 **XFS** 分区的一个 `monitor.log` |

内核的全部产出就这一行：

```
kernel: watchdog: BUG: soft lockup - CPU#10 stuck for 22s! [collector:783519]
```

Web、数据库、日志服务全部无响应。**16 个核，卡死的只有 1 个，但整机不可用。**

采集器自己的日志里，故障窗口内以约 **67 次/秒**的频率针对同一个文件反复输出：

```
[im_file_ext] inode changed for '.../monitor.log': reopening possibly rotated file
```

每一次「inode 变化」判定，都会触发一遍完整的 `close → open → seek → read`。

## 二、第一反应是错的

看到「采集进程把 CPU 卡死了 22 秒」，最自然的处置是：**给它限 CPU。**

这台机器上采集器本来就有 cgroup CPU 限额。**限额在，故障照样发生。**

原因是 `cpu.cfs_quota_us` 的作用域被普遍误解了：

::: warning
`cpu.cfs_quota_us` 约束的是 **CFS 调度器分配给任务的运行时间总量**。
它**无法抢占内核态中被标记为不可抢占的代码段**。

XFS 的 extent 遍历正是这样一段代码。**即便把采集器限到单核 20%，
一次 `xfs_iread_extents()` 调用仍然可以在内核态连续自旋 22 秒。**
:::

换句话说：**限额限的是「你能跑多久」，不是「你能不让出 CPU 多久」。** 一旦进程进入内核态的非抢占段，配额就失去了意义 —— 而这本身就是内核应当主动让出 CPU 而没有让出的表现。

## 三、根因：缺一个 `cond_resched()`

这是 4.19 内核 XFS 模块的一个已知缺陷。

**缺陷位置**：XFS 处理大量 extent 时走的 in-core 加载与映射路径，包括但不限于

```
xfs_iread_extents()
xfs_bmapi_read()
xfs_bmap_search_extents()
iomap_finish_ioend()
```

**缺陷性质**：这些路径在循环遍历 extent 时**缺少主动让出 CPU 的 `cond_resched()`**。

在非抢占内核上（`CONFIG_PREEMPT_NONE=y` 或 `CONFIG_PREEMPT_VOLUNTARY=y`），一旦遇到 extent 数量极大的文件，**单次调用就能在内核态自旋数十秒**，超过 watchdog 默认阈值（约 22 秒）后被报为 soft lockup。

**影响范围**

| 来源 | 范围 |
|---|---|
| Linux 上游 | 4.19 / 5.x 部分 LTS 分支，直到 6.x 早期 |
| KylinOS | 4.19.90 系列（`4.19.90-25.26` 已合入修复） |
| OpenEuler | 20.03 LTS（4.19 系） |
| 其他 | 各厂商基于 `CONFIG_PREEMPT_NONE` 编译的内核（Alibaba Cloud Linux、Oracle UEK 等） |

## 四、为什么定性为内核缺陷，而不是采集器缺陷

这是整份报告里最需要站住的一步。四条依据：

1. **内核态长时间不让出 CPU，是这次 22 秒卡死的直接物理机制。** 采集器的高频访问只是把这条路径走了很多次。
2. **cgroup 限额无法覆盖这个场景**（见第二节）。如果问题出在采集器占用太多 CPU，限额应该有效；它无效，说明问题不在「占多少」。
3. **任何用户态程序高频访问碎片化的 XFS 文件都能复现**，不限于这个采集器。
4. **该缺陷已在新版内核中以加 `cond_resched()` 或重写为增量加载的方式正式修复** —— 社区自己认可了这是内核问题。

第 4 条是最硬的：**上游打了补丁，就等于上游承认了归属。**

## 五、扩散：1 个核卡死，为什么 16 个核全停

soft lockup 期间同时发生两件事：

**① CPU#10 进入内核态不可抢占段**
调度器无法在这个 CPU 上调度任何其他任务。如果它同时持有全局资源（自旋锁、RCU、journal），影响会直接溢出到其他 CPU。

**② 持有 `XFS_ILOCK_EXCL`**
`xfs_iread_extents()` 与部分 bmap 路径在执行期间持有该 inode 的排他锁。此时**任何其他进程对这个 inode 的访问 —— 包括只读、`stat`、`open` —— 都要先拿这把锁**，于是全部进入不可中断的 D 状态。

而被监控的那个日志目录又被多个业务共用。

```
CPU#10 在内核态自旋（22s）
        │  持有 XFS_ILOCK_EXCL
        ▼
业务进程 A  stat()  → 等锁 → D
业务进程 B  open()  → 等锁 → D
业务进程 C  read()  → 等锁 → D
        ▼
所有依赖该 XFS 分区的服务全部夯死
```

**一把 inode 锁，把单核故障放大成了整机故障。**

## 六、证据到哪一步为止（这一节不能省）

::: danger 取证局限
服务器在故障恢复后**已经重启**，且 `systemd-journald` 当时**未启用持久化模式**。

重启前的内核完整日志 —— soft lockup 之后的 Call Trace、可能存在的
hung_task dump、RCU stall —— **全部不可恢复**。
:::

所以要分清这次拿到的是什么：

**直接证据（现场确有）**
- 内核 soft lockup 告警原文（SSH 终端缓存 / 截图 / 工单记录）
- 采集器日志：30 秒窗口内约 67 次/秒的 reopen 循环，证明故障期间确实在高频 `close → open → seek → read`

**推断依据（同型机制证据）**
- 上游 iomap 补丁，明确指出 XFS 长循环加 `cond_resched()` 即可解决 soft lockup，已在 4.18 / 5.1 / 5.15 多版本复现 —— [lore.kernel.org](https://lore.kernel.org/all/20211230193522.55520-1-trondmy@kernel.org/)
- `xfs/170` 测试触发 XFS soft lockup 的维护者讨论 —— [lore.kernel.org](https://lore.kernel.org/all/YYaWma0v5qrECIts@mit.edu/T/)
- Red Hat KB：[System hangs due to XFS lockups](https://access.redhat.com/solutions/2964341) · [xfsdatad CPU stuck for 67s](https://access.redhat.com/solutions/447743) · [xfs_inode i_lock 死锁导致系统挂起](https://access.redhat.com/solutions/4742131)
- OpenEuler 内核补丁：`xfs_log_force` 返回值传播以避免 soft lockup（同 4.19 分支）
- KylinOS `4.19.90-23.8` soft lockup 处置案例

**没能拿到的**
- 故障时刻的完整 Call Trace，因此**无法从栈上直接坐实是哪一个 XFS 函数在自旋**
- 故障文件的 `filefrag -v` / `xfs_bmap -v` 取证 —— 复盘时应补，用来确认「高度碎片化」这个前提

也就是说：**触发链的每一环都有独立证据支持，但没有一次端到端的栈级实锤。** 这个结论的强度是「同型机制 + 现场行为吻合」，不是「我看见了」。

::: tip
和[隔壁那篇](/systems/kernel/ext3-jbd-memcg-oom-deadlock)对比着看会更清楚：
那次有 vmcore，可以逐帧读栈，根因是**实锤**；这次现场没了，根因是**推断**。

**把这两者的差别写出来，比把两者都写成「我定位到了根因」有用得多。**
读的人需要知道该对这个结论下多大的注。
:::

## 七、触发条件与处置

三个条件同时成立才会发生：

```
① 被监控文件位于 XFS 分区，且已高度碎片化（extent 数量极大）
② 用户态程序对该文件高频 reopen：close → open → seek → read，约 67 次/秒
③ 内核版本在受影响范围内（本例 4.19.90-23.52，未含修复补丁）
```

### 根治：升级内核

**这是唯一能彻底消除重现可能的方案。任何用户态规避都只是降低触发概率。**

| 发行版 | 建议版本 |
|---|---|
| KylinOS V10 | ≥ `4.19.90-25.26.v2101.ky10` |
| OpenEuler 20.03 LTS | 最新 `4.19.90-2401.x.0` 或更高 |
| RHEL / Rocky 8 | `4.18.0-513` 之后含相关 XFS backport 的版本 |

### 缓解：在内核升级到位前

> 以下措施**不消除**内核缺陷，只降低命中概率。

1. **升级采集器**，优化文件检测与重开逻辑，降低 `close → open → seek → read` 的循环频率 —— 打掉条件 ②
2. **整理碎片**：`xfs_fsr -v /被监控分区` —— 打掉条件 ①
   注意：`xfs_fsr` 对**持续高速写入的活跃文件**效果有限，必须连同上游写入模式一起改
3. **调整 XFS 挂载参数与预分配**：`noatime,nodiratime,allocsize=16m`；或在应用侧用 `posix_fallocate()` 做连续预分配，避免边写边产生大量小 extent
4. **排查上游应用的写入模式**：先验证 inode 是否真的在变

   ```bash
   for i in $(seq 1 20); do stat -c %i monitor.log; done
   ```

   如果确实在变，检查写入端是否用了「删除-重建」或「rename-then-create」这类会换 inode 的写法，**建议改为 append 写入**。

第 4 条值得多说一句：采集器高频 reopen，是因为它**真的**每次都检测到 inode 变了。**采集器的行为是结果，不是起因** —— 起因在写日志的那一端。只改采集器，是在治症状。

## 尾声：两次事故，同一个误解

这台机器上的 cgroup CPU 限额没拦住整机卡死。[另一起事故](/systems/kernel/ext3-jbd-memcg-oom-deadlock)里，cgroup 内存限额不但没保护住系统，反而是死锁成立的**前提条件**。

::: tip
**cgroup 限额约束的是资源用量，不是故障影响范围。**

- 限内存：进程超限会被 OOM Killer 杀掉 —— 前提是它**能被杀掉**。
  处在 D 状态收不到信号时，这个前提不成立。
- 限 CPU：进程超限会被调度器挤下去 —— 前提是它**能被抢占**。
  进了内核态非抢占段时，这个前提不成立。

两次都是：**限额机制依赖一个内核前提，而故障恰好发生在那个前提不成立的地方。**

所以「给它加个限额」这个动作，解决的是「它占太多」，
解决不了「它把内核带进了一个出不来的状态」。这是两类完全不同的问题。
:::
