---
title: 先不伤害宿主，再谈不丢数据：读 Fluent Bit 背压与投递路径
---

# 先不伤害宿主，再谈不丢数据：读 Fluent Bit 背压与投递路径

> 读 Fluent Bit `in_tail` 和引擎的源码，顺着「下游堵住之后会发生什么」这一条线往下走，得出一组结论：**默认配置下内存没有上界；限了内存，进程一被杀就丢掉全部积压；日志轮转或被删除时，没读完的数据会被放弃 —— 而这几种丢失，大多不会留下 warn 以上的日志，也没有对应的指标。**
>
> 这篇不是缺陷清单。它想回答的是一个所有采集器都绕不开的问题：**下游出问题的时候，采集器该把代价留给自己，还是转嫁给宿主？**
>
> **我的立场**：我们自己做采集器，和 Fluent Bit 是同类产品。所以这篇只写有代码位置和实测支撑的东西，并单独写一节「哪些不算缺陷」。

---

## 读之前先说清楚

**版本**。源码研读基于 v5.1.1（`a31cf11a2`），发布前在上游 master `a92d414c1`（2026-10-09，v5.1.3 之后）上逐条复核：本文涉及的 `plugins/in_tail/` 下各文件在这 400 多个提交里只有一个 Windows 专属改动，下文引用的函数和判断逻辑全部原样存在。

**什么算缺陷**。下面四条同时满足才算，否则归为「设计取舍」：

1. 在**常见**使用场景下会触发，不是边缘 case
2. 失败是**静默的** —— 没有报错，或者只有默认看不到的 debug 日志
3. 没有任何检测或告警的闸门
4. 后果是数据丢失、损坏，或者宿主资源被耗尽

**证据分级**。标「实测」的在本地 Debug 构建上复现过；没标的是读源码得出的结论，代码位置都给了，可以自己核对。

**Fluent Bit 的目标场景**。它的主战场是 K8s DaemonSet：一份配置、由懂行的人写、全集群通用。在这个前提下，很多「不配就有风险」的选项做成默认关闭是合理的 —— 配置者被假定读过文档。本文讨论的是另一种用法：**把它当成被平台托管的采集引擎，配置由前端下发，使用者不了解内部机制。** 后者恰恰是很多企业内部采集平台的形态。

## 一、默认配置下，两道闸门都关着

下游堵住时，`in_tail` 是否暂停读文件，取决于两个判断（`src/flb_input_chunk.c`）：

```c
static inline int flb_input_chunk_is_mem_overlimit(struct flb_input_instance *i)
{
    if (i->mem_buf_limit <= 0) {
        return FLB_FALSE;          /* Mem_Buf_Limit 没配 → 永远不算超限 */
    }
    ...
}

static inline int flb_input_chunk_is_storage_overlimit(struct flb_input_instance *i)
{
    if (storage->type == FLB_STORAGE_FS) {                       /* 必须是 filesystem 模式 */
        if (i->storage_pause_on_chunks_overlimit == FLB_TRUE) {  /* 且显式打开，默认 off */
            ...
```

默认 `storage.type memory`、默认不配 `Mem_Buf_Limit` —— **两个判断都恒为 false，input 永远不会暂停。**

于是下游一堵，路径是确定的：

```
下游不可用（ES 挂了、Kafka 不可达、连接建不起来……）
  → output 持续返回 FLB_RETRY，chunk 不释放
  → 两道闸门恒为 false，in_tail 继续读、继续 append
  → 内存 chunk（memfs）按需 realloc，没有上限
  → OOM，进程被杀
```

全程只有 output 的 retry 日志，看起来像网络问题，排查方向很容易跑到下游去。按 10 MB/s 的采集量算，下游故障 10 分钟就是 6 GB。

一个反直觉的推论：**默认的 `memory` 模式，内存风险反而比 `filesystem` 模式大。** 因为 filesystem 模式下的内存驻留有一个带默认值的硬上限（`storage.max_chunks_up`，默认 64），而 `Mem_Buf_Limit` 没有默认值。

## 二、限了内存，进程一死还是丢

给 `Mem_Buf_Limit` 设上值，OOM 解决了。但还有一个更深的问题：**offset 记的是「已读取」，不是「已投递」。**

`plugins/in_tail/tail_file.c` 里，数据交给管道（`flb_input_log_append_records()`，只是放进 chunk）之后，紧接着就调 `update_resumable_offset_state()` 把 offset 写进 SQLite —— 不等 output 的结果。之后的 router → task → flush 全是异步的，任何路径下 offset 都不会回退。

所以进程的死法决定了数据的命运：

| | `Mem_Buf_Limit` 触发 | 正常终止（SIGTERM） | 被杀（OOM / SIGKILL） |
|---|---|---|---|
| 动作 | 暂停读文件 | 停 input，在 `Grace` 期内尽力排空 | 立即死亡 |
| 内存里的数据 | 保留，继续发 | 下游通就发完；堵着就排不空 | **全部丢失** |
| offset | 停在暂停处 | 已推进，不回退 | 已推进，不回退 |
| 丢失量 | 0 | 0，或 `Grace` 到期时的残留 | **全部积压** |
| 能看到什么 | pause / resume 日志 | `pending chunk count`，**info 级别** | 只有一个 OOMKilled 事件 |

两件事值得单独拎出来。

**cgroup 内存限制是陷阱。** 它保护宿主，不保护数据：`Mem_Buf_Limit` 触发的是暂停，数据还在；cgroup 触发的是 SIGKILL，积压全丢，而且看不出丢了多少。所以容器的 `limits.memory` 应该是最后一道防线，不是主要手段 —— 经验上设到 `Mem_Buf_Limit` 的 3～4 倍（还要算行缓冲 × 文件数、协程栈、连接池、SQLite 缓存）。

**最危险的组合是「下游堵了 + 重启试试」。** 现象在采集侧（数据采不上来了），根因在下游。运维的第一反应是重启采集器 → SIGTERM → `Grace` 期里下游还是堵的，排不空 → 退出，内存里的积压全部丢掉 → 重启后从已经推进的 offset 继续读。**重启没解决任何问题，还把唯一还能救的那批数据弄丢了。** 而「即将丢弃 N 个 chunk」这条唯一的线索，打的是 `flb_info`。

重启前先看一眼 `retries_total` 是不是在涨。在涨，就是下游的问题，重启只会丢数据。

这也是 `Mem_Buf_Limit` 比「防 OOM」更重要的价值：**它把「无界丢失」变成「有界丢失 + 可补采」。** input 暂停后，源文件原封不动，offset 停在暂停处；重启最多丢掉内存里那一份（≤ `Mem_Buf_Limit`），暂停期间的日志一条没读，还在源文件里。

> 上游有一个在途的 PR [#11269](https://github.com/fluent/fluent-bit/pull/11269)，在退出时把 offset 回退「读缓冲里还没处理的长度」。它补的是 `in_tail` 自己的行缓冲，**不覆盖已经进入 chunk、在引擎里排队的数据** —— 本节说的这部分仍然成立。

## 三、文件在源头就没了：轮转和删除

前两节的数据至少已经读进了进程。还有一类丢失发生在更早的地方：**文件还没读完，就被放弃了。**

### 轮转：`Rotate_Wait` 到期就关

文件被 rename 之后，`in_tail` 会再盯它 `Rotate_Wait` 秒（默认 5 秒），到期就关闭 fd、移出监控 —— **不管读完没有**（`flb_tail_file_purge()`）。

到期时如果还有没读的数据，代码里有一句 warn，但它的条件是 `pending_bytes > 0 && flb_input_buf_paused(ins)`：**只有在背压暂停时才打。**

| 没读完的原因 | 有 warn 吗 |
|---|---|
| 下游堵，input 被暂停 | 有：「consider increasing rotate_wait」 |
| **纯粹读得慢**（CPU 不够、解析重、文件多） | **没有，只有 debug** |

逻辑是拧着的：那句 warn 建议调大 `rotate_wait`，这恰恰是治「读得慢」的手段，可读得慢的时候它不打；背压的时候它打了，但背压持续多久不可预测，调大 `rotate_wait` 治标不治本。

这个现象上游有人报过：[#10414](https://github.com/fluent/fluent-bit/issues/10414)「Rotate_Wait should not abandon log file if it still has pending_bytes」，2025 年 6 月提出，报告者在 K8s 上一次突发 100 万行、稳定丢掉后半段。这个 issue 在 15 个月里被 stale 机器人标记了四次，报告者两次回复「still relevant」，还提到新版本里不得不把 `rotate_wait` 设得越来越大；另有用户留言说这和他理解的行为不一样，「是个严重的 bug」。**最后在 2026-08-28 被机器人自动关闭，全程没有维护者回复。** 它的关闭状态不代表问题被否决，只代表没人接。

还有一个容量规划上的坑：**`in_tail` 默认 `threaded false`，跑在主事件循环里，单线程。** 「读得慢」时给容器加 CPU 核数基本无效，有效的是减轻解析开销、按路径拆多个 input 实例并打开 `threaded`。

### 删除：没有宽限期，连 DB 记录一起抹掉（实测）

如果文件不是被 rename，而是被直接 `rm`（运维清盘、应用自己删日志、某些轮转工具不 rename 直接删），走的是另一个函数 `check_purge_deleted_file()`：

```c
if (st.st_nlink == 0) {
    flb_plg_debug(ctx->ins, "purge: monitored file has been deleted: %s", file->name);
    if (ctx->db) {
        flb_tail_db_file_delete(file, file->config);   /* DB 记录一起删 */
    }
    flb_tail_file_remove(file);                        /* 无条件，不看还有没有没读的 */
    return FLB_TRUE;
}
```

**没有宽限期，不看还剩多少没读，日志是 debug 级别。**

本地实测：output 指向一个不可达端口制造真实背压，`mem_buf_limit=1M` 让 input 进入暂停；10 个 2.3 MB 的文件此时各自只读了 **4.2%**。把它们 `rm` 掉之后，fd 立即关闭，DB 里的记录变成 **0 条** —— 剩下 95.8% 的数据永久丢失，不留任何痕迹。

| | 轮转（rename） | 删除（rm） |
|---|---|---|
| 宽限期 | `rotate_wait`，默认 5 秒 | **无，立即清理** |
| 背压时的提示 | warn | **debug，默认不可见** |
| DB 记录 | 保留到宽限期结束 | **同步删除，事后无从追溯** |

修法方向是给删除路径补一个和 `rotate_wait` 对等的宽限期，并在 `pending_bytes > 0` 时把日志提到 warn。

## 四、丢了多少，看不出来

前面几种丢失有一个共同点：**事后没法回答「这次丢了多少」。**

`in_tail` 的全部指标是 6 个计数器（`plugins/in_tail/tail_config.h`）：打开、关闭、轮转的文件数，多行截断、长行截断、长行跳过的次数。**全是「次数」，没有「字节数」或「记录数」**，也没有任何一个对应「purge 时放弃了多少没读的数据」。相比之下，output 侧的丢弃指标同时有记录数和字节数 —— input 侧的可观测性明显弱于 output 侧。

上游已经有人在补：在途的 PR [#12361](https://github.com/fluent/fluent-bit/pull/12361) 给 `in_tail` 加了两个按原始字节计的计数器，`fluentbit_input_files_processed_bytes_total` 和 `fluentbit_input_files_abandoned_bytes_total`，后者统计「文件被终结性移除时放弃的未读字节」。它的动机描述和本文第三节的分析几乎一致，包括「warn 只在暂停时打」这一点。写作时（2026-10-12）这个 PR 还没有合入。

### fd 耗尽：看起来像下游问题

还有一种更难认出来的连锁。`in_tail` 对打开的文件数没有上限，代码里也不检查 `RLIMIT_NOFILE`；`open()` 失败时只打一句通用的 `cannot open`，不像 inotify 那边会专门提示 `max_user_watches`。而 fd 是采集和发送**共享**的资源：

```
in_tail 吃光 fd
  → output 建不了新连接，全部 FLB_RETRY
  → chunk 不释放，内存涨，触发背压，input 暂停
```

**「文件太多」被放大成「整条管道停摆」**，现场表现却是「内存在涨 + 大量 retry」，第一反应仍然是查下游。排查时对比一下 `lsof -p <pid> | wc -l` 和 `/proc/<pid>/limits`。

上游近期也有了动静：[#12432](https://github.com/fluent/fluent-bit/issues/12432)（Windows 上监控的文件超过约 8200 个就报 `Too many open files`，其中大部分是早已读完、只为审计留在盘上的历史文件）和在途的 PR [#12441](https://github.com/fluent/fluent-bit/pull/12441)（给所有 tail input 加一个进程级共享的 `max_open_files` 预算，75% 时告警，回收休眠文件的 fd）。

## 五、背压怎么选：限内存，还是落磁盘

前面的问题，Fluent Bit 给了两条出路。这是使用方式的选择，不是缺陷，但选哪个要看代码行为。

**方案 A：限内存。** 配 `Mem_Buf_Limit` + `DB`。内存到上限就暂停读文件，fd 和 offset 都保留，下游恢复后从暂停处续读。

- 丢的是「暂停期间还没采的新数据」，它们还在源文件里，事后可以补采
- 唯一的风险窗口是源文件在暂停期间被轮转清理掉 —— 这可以用调大 `Mem_Buf_Limit`、延长业务侧日志保留时间来控制，两个都是可量化的旋钮
- **不占宿主磁盘，不产生额外 IO**

**方案 B：落磁盘。** `storage.type filesystem`。听起来更安全，但有三个必须知道的代码行为：

1. **磁盘满了不是暂停，是驱逐。** 到 `storage.total_limit_size` 之后，`flb_input_chunk.c` 会把最老的 chunk 从队列里驱逐掉给新数据腾地方，只打一条 warn。被驱逐的是「已经采上来、排在队列里、离发送成功最近」的那批数据 —— 而它们对应的源文件这时很可能已经被轮转清理，**永远补不回来**。这比方案 A 更难解释。
2. **写盘时机不可控。** chunk 走 mmap，什么时候真正落盘由内核脏页回写决定，攒到阈值时会集中回写，是脉冲式的突发 IO。`storage.sync` 默认 `normal`，不 fsync；改成 `full` 则每次写都 msync，机械盘上代价极高。
3. **没有水位线。** 只有硬上限，没有「到 80% 提醒」，告警要在监控侧自己建。

方案 B 要成立，需要五个前提：独立磁盘或分区、监控侧有水位告警、`total_limit_size` 留足余量、保持 `storage.sync normal`、团队清楚驱逐语义。**五条里有三条是环境约束，不是配置能解决的。** 它把采集器从「只读业务日志」变成了「在业务机上争抢 IO 和磁盘的写入方」。

::: tip 采集器的第一原则
**采集器的第一原则是不伤害宿主，「不丢数据」排在它后面。**

Fluent Bit 的两条默认路径都会伤害宿主，区别只是伤在哪：`memory` 模式不配上限 → 内存无界 → OOM；`filesystem` 模式 → 争 IO、占磁盘，满了之后静默驱逐。

零侵入的组合只有方案 A：**划一个明确的内存上界，超了就停止采集并告警** —— 把「数据延迟」这个可控的代价留给自己，而不是把「资源耗尽」这个不可控的代价转嫁给宿主。
:::

## 六、哪些不算缺陷

下面这些「不配就有风险」的默认值，在 Fluent Bit 的目标场景下是合理的设计取舍：

| 配置项 | 默认值 | 不配的后果 |
|---|---|---|
| `Mem_Buf_Limit` | 不限 | 无界内存（第一节） |
| `DB` | 不配 | offset 只在内存，重启从文件末尾开始，停机期间的日志全部丢失 |
| `Skip_Long_Lines` | Off | 一条超长行导致整个文件停止采集 |
| `Rotate_Wait` | 5 秒 | 高写入量下轮转时尾部数据丢失（第三节） |

引擎给足旋钮，由懂行的人按需配置 —— 这是 DaemonSet 场景的合理分工。**问题在于托管场景：配置由前端下发，使用者不了解这些旋钮。这时「安全默认值」应该由托管平台提供，而不是指望引擎。**

如果你在做这样的托管平台，下面这些建议固化，不暴露给使用者：

```
Mem_Buf_Limit      必配，有明确数值依据
DB                 <状态目录>/tail_db/<任务ID>_<hash(路径)>.db
Skip_Long_Lines    On
Buffer_Max_Size    按最长行设
Grace              略小于容器的 terminationGracePeriodSeconds
```

`DB` 路径的三个要素缺一不可：状态目录（不能用工作目录，systemd 拉起时 cwd 是 `/`）、任务 ID（隔离任务）、路径哈希（不能用配置段的序号，中间插一段，后面的全部错位）。

还有一个架构选择：**一个任务一个进程，还是一个进程跑多个任务？** 倾向前者。背压是按 input 触发的，但影响是全局的：一个任务的下游堵住 → chunk 不释放 → 内存涨 → 同一进程里所有 input 一起暂停。一个后端的故障，就能拖垮整台机器上的采集。

## 上游状态汇总

截至 2026-10-12，上游 master `a92d414c1`：

| 问题 | 代码状态 | 上游动态 |
|---|---|---|
| 默认配置下内存无上界 | 未变 | —— |
| offset 记「已读取」而非「已投递」 | 未变 | [#11269](https://github.com/fluent/fluent-bit/pull/11269)（在途）只覆盖行缓冲部分 |
| 轮转放弃未读数据，warn 只覆盖背压 | 未变 | [#10414](https://github.com/fluent/fluent-bit/issues/10414) 被 stale 机器人关闭 |
| 删除时立即放弃未读数据（实测） | 未变 | 未见报告 |
| 丢失量没有指标 | 未变 | [#12361](https://github.com/fluent/fluent-bit/pull/12361)（在途） |
| fd 无上限，耗尽后连锁停摆 | 未变 | [#12432](https://github.com/fluent/fluent-bit/issues/12432)、[#12441](https://github.com/fluent/fluent-bit/pull/12441)（在途） |

## 留给读者的

1. **`Mem_Buf_Limit` 必配**。它不只防 OOM，更是把「无界丢失」变成「有界丢失 + 可补采」
2. **cgroup 内存限制保护宿主，不保护数据** —— 它是最后一道防线，设到 `Mem_Buf_Limit` 的 3～4 倍
3. **采集不上来时，先看 `retries_total` 再决定要不要重启** —— 下游堵着时重启，丢的是唯一还能救的那批数据
4. **轮转和删除都会放弃没读完的数据**，后者没有宽限期、没有 warn；读得慢时加 CPU 核数无效，`in_tail` 默认单线程
5. **落磁盘不等于不丢数据**：磁盘满了驱逐的是离成功最近的那批，而且会和业务争 IO
6. **托管 Fluent Bit 时，安全默认值由平台固化**，别指望使用者读过文档

---

**相关**：[采集器工程](/systems/agent/) · [百万个只写一次的文件](/systems/agent/fluent-bit-million-files)（系列第二篇） · [offset 存储](/systems/agent/fluent-bit-offset-identity)（系列第三篇） · [限了 CPU 配额，它还是把整机卡死了 22 秒](/systems/kernel/xfs-soft-lockup-cond-resched)（另一种「限额保护不了什么」）
