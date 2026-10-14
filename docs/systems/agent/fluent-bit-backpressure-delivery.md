---
title: Fluent Bit 源码笔记（一）：背压与投递，先不伤害宿主
---

# Fluent Bit 源码笔记（一）：背压与投递，先不伤害宿主

::: info Fluent Bit 源码笔记
读 `in_tail` 与引擎源码的四篇笔记。源码基线 v5.1.1，发布前复核至上游 master `a92d414c1`。

- **（一）背压与投递，先不伤害宿主**　·　背压与投递
- （二）[百万个只写一次的文件](/systems/agent/fluent-bit-million-files)　·　规模天花板
- （三）[采集器怎么记住自己读到了哪里](/systems/agent/fluent-bit-offset-identity)　·　offset 存储
- （四）[读取边界上的数据丢失，GBK 日志丢了 27.4%](/systems/agent/fluent-bit-read-boundary)　·　编码与压缩
:::

我们自己也做采集器，和 Fluent Bit 算是同类产品。做这行的，迟早都要回答一个问题：下游出问题的时候，采集器该把代价留给自己，还是转嫁给宿主？

带着这个问题，我去读了 Fluent Bit `in_tail` 和引擎的源码，顺着「下游堵住以后会发生什么」这一条线往下走。读完的结论不太好看：默认配置下内存没有上界；限了内存，进程一被杀，积压就全丢了；日志轮转或者被删的时候，没读完的数据会被直接放弃。而这几种丢失，大多不会留下 warn 以上的日志，也没有对应的指标。

同行评同行，容易被说成拉踩，所以这篇只写有代码位置或者实测撑着的东西，后面也专门写了一节哪些不算缺陷。

## 先交代几件事

源码是照着 v5.1.1（`a31cf11a2`）读的。发布前我又在上游 master `a92d414c1`（2026-10-09，v5.1.3 之后）上逐条对了一遍，`plugins/in_tail/` 下的文件在这 400 多个提交里只有一个 Windows 专属的改动，下面引用的函数和判断逻辑都原样还在。标了「实测」的，是在本地 Debug 构建上复现过的；没标的是读源码得出来的，代码位置都给了，可以自己对。

我算缺陷的标准是四条同时满足：在常见场景下就会触发，不是边缘 case；失败是静默的，要么不报错，要么只有默认看不到的 debug 日志；没有任何检测或告警的闸门；后果是数据丢失、损坏，或者把宿主的资源耗光。凑不齐四条的，我归为设计取舍。

还有一点得说在前面。Fluent Bit 的主战场是 K8s DaemonSet，一份配置，由懂行的人写好，全集群通用。在这个前提下，很多不配就有风险的选项默认关着，是说得通的，配置的人被假定读过文档。我这篇讨论的是另一种用法：把它当成一个被平台托管的采集引擎，配置由前端下发，用的人并不了解它内部怎么跑。很多企业内部的采集平台，恰恰就是这个样子。

## 默认配置下，两道闸门都关着

下游堵住的时候，`in_tail` 停不停下来读文件，取决于两个判断（`src/flb_input_chunk.c`）：

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

默认 `storage.type` 是 `memory`，默认也不配 `Mem_Buf_Limit`，这两个判断就恒为 false，input 永远不会暂停。

那下游一堵，后面的事就是注定的：

```
下游不可用（ES 挂了、Kafka 不可达、连接建不起来……）
  → output 持续返回 FLB_RETRY，chunk 不释放
  → 两道闸门恒为 false，in_tail 继续读、继续 append
  → 内存 chunk（memfs）按需 realloc，没有上限
  → OOM，进程被杀
```

整个过程里只有 output 的 retry 日志，看着像网络问题，排查的人很容易一头扎到下游去。按 10 MB/s 的采集量算，下游挂 10 分钟就是 6 GB。

这里还有个反直觉的地方：默认的 `memory` 模式，内存风险反而比 `filesystem` 模式大。filesystem 模式下驻留内存的 chunk 数有个带默认值的硬上限，`storage.max_chunks_up`，默认 64；而 `Mem_Buf_Limit` 是没有默认值的。

## 限了内存，进程一死还是丢

那给 `Mem_Buf_Limit` 设个值，OOM 是解决了。可还有个更深的问题：offset 记的是读到了哪，不是发到了哪。

`plugins/in_tail/tail_file.c` 里，数据交给管道以后（`flb_input_log_append_records()`，只是放进 chunk），紧接着就调 `update_resumable_offset_state()` 把 offset 写进 SQLite，并不等 output 的结果。后面的 router、task、flush 全是异步的，哪条路径下 offset 都不会往回退。

所以数据的命运，取决于进程是怎么死的：

| | `Mem_Buf_Limit` 触发 | 正常终止（SIGTERM） | 被杀（OOM / SIGKILL） |
|---|---|---|---|
| 动作 | 暂停读文件 | 停 input，在 `Grace` 期内尽力排空 | 立即死亡 |
| 内存里的数据 | 保留，继续发 | 下游通就发完；堵着就排不空 | 全部丢失 |
| offset | 停在暂停处 | 已推进，不回退 | 已推进，不回退 |
| 丢失量 | 0 | 0，或 `Grace` 到期时的残留 | 全部积压 |
| 能看到什么 | pause / resume 日志 | `pending chunk count`，info 级别 | 只有一个 OOMKilled 事件 |

有两件事我想单独说一下。

一是 cgroup 内存限制。它保护的是宿主，不是数据。`Mem_Buf_Limit` 触发的是暂停，数据还在；cgroup 触发的是 SIGKILL，积压全丢，丢了多少还看不出来。所以容器的 `limits.memory` 只能当最后一道防线，别拿它当主要手段。按经验设到 `Mem_Buf_Limit` 的 3～4 倍，行缓冲乘文件数、协程栈、连接池、SQLite 缓存这些都得算进去。

二是下游堵了、运维顺手重启一下，这是最危险的组合。现象在采集这边，数据采不上来了，根子却在下游。运维的第一反应是重启采集器，SIGTERM 发过去，`Grace` 期里下游还是堵着，排不空，进程退出，内存里的积压全部丢掉，重启以后从已经推进过的 offset 接着读。重启什么问题都没解决，倒把唯一还能救回来的那批数据弄丢了。而「即将丢弃 N 个 chunk」这唯一的一条线索，打的是 `flb_info`。

所以重启之前，先看一眼 `retries_total` 是不是在涨。在涨，那就是下游的问题，重启只会丢数据。

从这个角度看，`Mem_Buf_Limit` 的价值不只是防 OOM，它把无界的丢失变成了有界的丢失，而且能补采。input 暂停以后，源文件原封不动，offset 停在暂停的地方；重启最多丢掉内存里那一份，不超过 `Mem_Buf_Limit`，暂停期间的日志一条都没读，还好好地躺在源文件里。

上游有个在途的 PR [#11269](https://github.com/fluent/fluent-bit/pull/11269)，在退出时把 offset 往回退「读缓冲里还没处理的长度」。它补的是 `in_tail` 自己的行缓冲，已经进了 chunk、在引擎里排队的数据它管不到，所以这一节说的情况仍然成立。

## 文件还没读完就被放弃了

前面说的数据，好歹已经读进了进程。还有一类丢失发生得更早：文件还没读完，就被放弃了。

### 轮转：Rotate_Wait 一到就关

文件被 rename 以后，`in_tail` 会再盯它 `Rotate_Wait` 秒，默认 5 秒，到时间就关 fd、移出监控，读没读完它不管（`flb_tail_file_purge()`）。

到时间如果还有没读的数据，代码里是有一句 warn 的，可它的条件是 `pending_bytes > 0 && flb_input_buf_paused(ins)`，也就是只有在背压暂停的时候才打。下游堵、input 被暂停导致没读完，你能看到一句「consider increasing rotate_wait」；可要是纯粹读得慢，CPU 不够、解析太重、文件太多，那就什么都没有，只有一句 debug。

这个逻辑是拧着的。那句 warn 建议你调大 `rotate_wait`，这恰恰是治读得慢的办法，可读得慢的时候它偏偏不打；背压的时候它打了，可背压会持续多久谁也说不准，调大 `rotate_wait` 也是治标不治本。

上游有人报过这个问题，[#10414](https://github.com/fluent/fluent-bit/issues/10414)「Rotate_Wait should not abandon log file if it still has pending_bytes」，2025 年 6 月提的。报告者在 K8s 上一次突发 100 万行，后半段稳定地丢。这个 issue 在 15 个月里被 stale 机器人标了四次，报告者两次回复 still relevant，还说新版本里不得不把 `rotate_wait` 越设越大；另有用户留言说这跟他理解的行为不一样，是个严重的 bug。最后在 2026-08-28 被机器人自动关了，从头到尾没有一个维护者回复过。它关了，不代表问题被否了，只是没人接。

容量规划上还有个坑。`in_tail` 默认 `threaded false`，跑在主事件循环里，是单线程的。读得慢的时候给容器加 CPU 核数基本没用，有用的是减轻解析开销，按路径拆成多个 input 实例，再打开 `threaded`。

### 删除：没有宽限期，DB 记录一起抹掉（实测）

如果文件不是被 rename，而是被直接 `rm` 掉，比如运维清盘、应用自己删日志、有些轮转工具不 rename 直接删，走的是另一个函数 `check_purge_deleted_file()`：

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

没有宽限期，不看还剩多少没读，日志还是 debug 级别。

我在本地实测了一下。output 指向一个不可达的端口，制造真实的背压，`mem_buf_limit=1M` 让 input 进入暂停；这时候 10 个 2.3 MB 的文件，每个只读了 4.2%。把它们 `rm` 掉，fd 立刻就关了，DB 里的记录变成 0 条，剩下 95.8% 的数据就这么永久丢了，一点痕迹都不留。

| | 轮转（rename） | 删除（rm） |
|---|---|---|
| 宽限期 | `rotate_wait`，默认 5 秒 | 无，立即清理 |
| 背压时的提示 | warn | debug，默认不可见 |
| DB 记录 | 保留到宽限期结束 | 同步删除，事后无从追溯 |

修的方向应该是给删除这条路也补一个跟 `rotate_wait` 对等的宽限期，`pending_bytes > 0` 的时候把日志提到 warn。

## 丢了多少，看不出来

上面这几种丢失有个共同点，事后谁也说不清这次到底丢了多少。

`in_tail` 的指标一共就 6 个计数器（`plugins/in_tail/tail_config.h`）：打开、关闭、轮转的文件数，多行截断、长行截断、长行跳过的次数。全是次数，没有字节数，也没有记录数，更没有一个是对应「purge 时放弃了多少没读的数据」的。反观 output 那边，丢弃指标是记录数和字节数都有的，input 这边的可观测性明显差一截。

上游已经有人在补了。在途的 PR [#12361](https://github.com/fluent/fluent-bit/pull/12361) 给 `in_tail` 加了两个按原始字节计的计数器，`fluentbit_input_files_processed_bytes_total` 和 `fluentbit_input_files_abandoned_bytes_total`，后者统计的就是文件被终结性移除时放弃掉的未读字节。它的动机描述跟上一节的分析几乎一样，连「warn 只在暂停时打」都提到了。我写这篇的时候（2026-10-12），这个 PR 还没合进去。

### fd 耗尽，看着像下游的问题

还有一种连锁更难认出来。`in_tail` 打开的文件数没有上限，代码里也不检查 `RLIMIT_NOFILE`；`open()` 失败时只打一句笼统的 `cannot open`，不像 inotify 那边会专门提示 `max_user_watches`。可 fd 是采集和发送共用的：

```
in_tail 吃光 fd
  → output 建不了新连接，全部 FLB_RETRY
  → chunk 不释放，内存涨，触发背压，input 暂停
```

文件太多，被放大成了整条管道停摆，现场看到的却是内存在涨、一大堆 retry，第一反应照样是去查下游。排查的时候拿 `lsof -p <pid> | wc -l` 和 `/proc/<pid>/limits` 对比一下就知道了。

上游最近也有动静了。[#12432](https://github.com/fluent/fluent-bit/issues/12432) 报的是 Windows 上监控的文件超过 8200 个左右就报 `Too many open files`，其中大部分是早就读完、只是为了审计才留在盘上的历史文件；在途的 PR [#12441](https://github.com/fluent/fluent-bit/pull/12441) 给所有 tail input 加了一个进程级共享的 `max_open_files` 预算，到 75% 告警，并回收休眠文件的 fd。

## 背压怎么选：限内存，还是落磁盘

对上面这些问题，Fluent Bit 给了两条路。这是用法上的选择，谈不上缺陷，但选哪条，得看代码到底怎么做的。

一条是限内存，配 `Mem_Buf_Limit` 加 `DB`。内存到上限就暂停读文件，fd 和 offset 都留着，下游恢复了从暂停的地方接着读。丢的是暂停期间还没采的新数据，可它们还在源文件里，事后能补采。唯一的风险窗口，是源文件在暂停期间被轮转清理掉了，这个可以靠调大 `Mem_Buf_Limit`、延长业务那边日志的保留时间来控制，两个都是能量化的旋钮。而且它不占宿主的磁盘，也不产生额外的 IO。

另一条是落磁盘，`storage.type filesystem`。听着更保险，可有三个代码行为得心里有数。

第一，磁盘满了不是暂停，是驱逐。到了 `storage.total_limit_size`，`flb_input_chunk.c` 会把最老的 chunk 从队列里踢掉，给新数据腾地方，只打一条 warn。被踢掉的，是已经采上来、在队列里排着、离发送成功最近的那一批，而它们对应的源文件这时候很可能已经被轮转清掉了，再也补不回来。这比限内存那条路更难跟人解释。

第二，什么时候真正写盘不由你控制。chunk 走的是 mmap，什么时候落盘由内核的脏页回写决定，攒到阈值会集中回写，IO 是一阵一阵突发的。`storage.sync` 默认 `normal`，不 fsync；改成 `full` 就每次写都 msync，在机械盘上代价非常高。

第三，没有水位线。只有一个硬上限，没有到 80% 提醒一下这种东西，告警得自己在监控那边建。

落磁盘这条路要走得通，得同时满足五个前提：独立的磁盘或分区、监控侧有水位告警、`total_limit_size` 留足余量、`storage.sync` 保持 `normal`、团队清楚驱逐是怎么回事。五条里有三条是环境上的约束，光靠改配置解决不了。它等于把采集器从一个只读业务日志的程序，变成了一个在业务机器上抢 IO、抢磁盘的写入方。

所以我的看法是，采集器的第一原则是不伤害宿主，不丢数据得排在它后面。Fluent Bit 的两条默认路径都会伤到宿主，只是伤的地方不一样：`memory` 模式不配上限，内存无界，最后 OOM；`filesystem` 模式抢 IO、占磁盘，满了以后悄悄驱逐。真正零侵入的只有限内存这一条：给内存划一个明确的上界，超了就停止采集并告警。数据晚一点到，是采集器自己能兜住的代价；把宿主的资源耗光，那就不是采集器能兜住的了。

## 哪些不算缺陷

下面这些不配就有风险的默认值，放在 Fluent Bit 的目标场景里，是合理的设计取舍：

| 配置项 | 默认值 | 不配的后果 |
|---|---|---|
| `Mem_Buf_Limit` | 不限 | 无界内存 |
| `DB` | 不配 | offset 只在内存，重启从文件末尾开始，停机期间的日志全部丢失 |
| `Skip_Long_Lines` | Off | 一条超长行导致整个文件停止采集 |
| `Rotate_Wait` | 5 秒 | 高写入量下轮转时尾部数据丢失 |

引擎把旋钮给足，懂行的人按需去配，在 DaemonSet 场景下这是合理的分工。问题出在托管场景：配置是前端下发的，用的人不了解这些旋钮。这种时候，安全的默认值就该由托管平台来兜，不能指望引擎。

如果你在做这样的托管平台，下面这些我建议直接固化，不要暴露给使用者：

```
Mem_Buf_Limit      必配，有明确数值依据
DB                 <状态目录>/tail_db/<任务ID>_<hash(路径)>.db
Skip_Long_Lines    On
Buffer_Max_Size    按最长行设
Grace              略小于容器的 terminationGracePeriodSeconds
```

`DB` 路径里的三样东西一样都不能少。状态目录不能用工作目录，systemd 拉起来的时候 cwd 是 `/`；任务 ID 用来把任务隔开；路径要用哈希，不能用配置段的序号，不然中间插一段，后面的就全错位了。

还有一个架构上的选择：一个任务一个进程，还是一个进程跑多个任务？我倾向前者。背压是按 input 触发的，影响却是全局的：一个任务的下游堵住，chunk 不释放，内存涨，同一个进程里所有的 input 一起暂停。一个后端出故障，就能把整台机器上的采集都拖垮。

## 上游现在的状态

截至 2026-10-12，上游 master `a92d414c1`：

| 问题 | 代码状态 | 上游动态 |
|---|---|---|
| 默认配置下内存无上界 | 未变 | 无 |
| offset 记「已读取」而非「已投递」 | 未变 | [#11269](https://github.com/fluent/fluent-bit/pull/11269)（在途）只覆盖行缓冲部分 |
| 轮转放弃未读数据，warn 只覆盖背压 | 未变 | [#10414](https://github.com/fluent/fluent-bit/issues/10414) 被 stale 机器人关闭 |
| 删除时立即放弃未读数据（实测） | 未变 | 未见报告 |
| 丢失量没有指标 | 未变 | [#12361](https://github.com/fluent/fluent-bit/pull/12361)（在途） |
| fd 无上限，耗尽后连锁停摆 | 未变 | [#12432](https://github.com/fluent/fluent-bit/issues/12432)、[#12441](https://github.com/fluent/fluent-bit/pull/12441)（在途） |

## 最后

用 Fluent Bit 的话，如果只能记住一条，那就是 **`Mem_Buf_Limit` 一定要配**。采集不上来的时候先看 `retries_total`，下游堵着就别急着重启。至于落磁盘，它并不等于不丢数据，磁盘满了被驱逐的，恰恰是离发送成功最近的那一批。

---

**相关**：[采集器工程](/systems/agent/) · [XFS soft lockup：限了 CPU 配额，整机还是卡死 22 秒](/systems/kernel/xfs-soft-lockup-cond-resched)（另一种「限额保护不了什么」）
