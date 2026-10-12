---
title: 进程退出时一个字节都没漏，跑起来却一直在涨
---

# 进程退出时一个字节都没漏，跑起来却一直在涨

> 采集器是 C 写的，常驻在客户的业务机上，内存靠 `apr_pool` 内存池管理。它的内存问题有个让人难受的特点：**退出时 valgrind 报告干干净净，运行时 RSS 一路往上走。**
>
> 这篇不是工具教程。valgrind、mtrace、bcc `memleak`、手写 hook 的用法网上一搜一大把。这篇只回答一个问题：**每种工具结构上看不见什么**，以及为什么「内存池 + 常驻进程」恰好落在大多数工具的盲区里。
>
> 文中示例都是最小复现程序，不是现场代码。

## 一、先把「泄漏」说窄一点

教科书定义是：申请了、没释放、指针丢了。这个定义能指导你读代码，但指导不了你选工具。选工具要先问两件事：

| | 问题 |
|---|---|
| **什么时候看** | 进程退出那一刻看「还剩什么」，还是运行中看「什么在涨」 |
| **在哪一层看** | `malloc/free` 这一层，`mmap/munmap` 这一层，还是内存池自己那一层 |

后面所有工具的取舍，都落在这两条轴上。

还有一个容易混的前提：**RSS 在涨，不等于泄漏。** glibc 的多 arena、碎片、`free` 之后不还给内核，都会让 RSS 只升不降，而这些内存在分配器眼里是空闲的（可以先 `malloc_trim(0)` 看看能还回去多少）。反过来，内存池里「没还给池子」的块，在分配器眼里是**正在使用**的。两头都会骗人。

所以判断依据要写得更严一点：**数据量恒定的前提下，持续、线性、不回落的增长**，才值得怀疑泄漏。

## 二、退出时检查：valgrind 和 mtrace

这两个工具的原理不同，判据一样 —— **进程结束时，还有哪些块没被释放。**

### valgrind memcheck

memcheck 把程序跑在一个合成 CPU 上，为每个字节维护「是否可寻址」「是否已初始化」两类影子状态，所以它不只查泄漏，越界、use-after-free、double free、未初始化读都能报。

```c
int main(void) {
    void *p1 = malloc(10);
    void *p2 = malloc(20);   // 没有 free
    free(p1);
    return 0;
}
```

```
$ valgrind --leak-check=full ./a.out
==229181== 20 bytes in 1 blocks are definitely lost in loss record 1 of 1
==229181==    at 0x4C29F73: malloc (vg_replace_malloc.c:309)
==229181==    by 0x40059C: main (leak.c:3)
```

带完整调用栈，带行号，定位非常准。代价是**跑得慢一个数量级以上**，生产环境基本不可能挂着它跑。

### mtrace

mtrace 是 **glibc** 的功能（不是内核的）：程序里调一次 `mtrace()`，之后每次 `malloc/realloc/free` 都往 `$MALLOC_TRACE` 指向的文件记一行，退出后用 `mtrace` 脚本对账：

```
$ mtrace ./main_mtrace mtrace.log
Memory not freed:
-----------------
           Address     Size     Caller
0x00007f78508cb010 0x100000  at main_mtrace.c:24
0x00007f78509cc010 0x100000  at main_mtrace.c:24
...
```

它比 valgrind 轻得多，但有三个硬限制：

- **只记一层调用者。** `allocation()` 被 `func1` 和 `func2` 同时调用时，日志里只有 `allocation` 那一行，分不出是谁引起的。工程封装一深，这条信息几乎没用。
- **看不见 `mmap`。** 它挂在 `malloc` 上。
- **实现依赖 `__malloc_hook`，而 glibc 2.34 已经移除了这组 hook。** 新版本里要 `LD_PRELOAD=libc_malloc_debug.so` 才能用。老系统上随手可用，新系统上要多一步。

### 它们为什么对内存池无效

内存池的生命周期是：启动时向系统要一大块，运行中从池子里切，**退出时整池销毁**。

```
启动   apr_pool_create()          → 从系统拿内存
运行   apr_palloc(pool, n)  × N   → 只切不还（这就是泄漏）
退出   apr_pool_destroy()         → 一次性全部还给系统
```

在退出那一刻对账，**每一个字节都被还回去了**。valgrind 会报 0 泄漏；即便不销毁池子，池子还持有指针，也只会被归为 *still reachable*，不是 *definitely lost*。

::: warning
**退出时检查的工具，判据是「指针丢没丢」。内存池泄漏的特征是「指针一直都在，只是该还的时候没还」。**

这不是工具不够好，是判据从根上就对不上。
:::

另一条更隐蔽：`apr_pool` 对大块申请直接走 `mmap`。挂在 `malloc` 上的工具，连这部分内存的申请都看不到。

## 三、运行时观测：bcc memleak

既然要看的是「运行中什么在涨」，就需要一个能挂到活进程上、按时间窗口报告的工具。bcc 的 `memleak` 就是这样：用 uprobe 挂住分配/释放函数，周期性打印**尚未释放的分配，按调用栈聚合**。

```c
void func1() {
    char *str = malloc(64 * 1024);   // 每 100ms 漏 64K
    usleep(100000);
}
int main() { while (1) func1(); }
```

```
$ memleak.py -p $(pidof bcc_test) 10
[10:10:43] Top 10 stacks with outstanding allocations:
        6225920 bytes in 95 allocations from stack
                func1+0x1a [bcc_test]
                main+0x19 [bcc_test]
[10:10:53] Top 10 stacks with outstanding allocations:
        12779520 bytes in 195 allocations from stack
                ...
[10:11:03] Top 10 stacks with outstanding allocations:
        19333120 bytes in 295 allocations from stack
```

每 10 秒多出 100 次分配、6400 KB，栈始终是同一条 —— 和代码完全吻合。**判据从「指针丢没丢」换成了「同一个栈上的未释放量是否单调上涨」**，这才是常驻进程该用的判据。

对我们来说它还有一条决定性的优势：**同事给 `memleak` 加上了 `mmap/munmap` 跟踪**（[iovisor/bcc#3866](https://github.com/iovisor/bcc/pull/3866)），`apr_pool` 走 `mmap` 的那部分大块分配因此也能被看到。

它的代价同样要写清楚：

- **环境门槛高。** eBPF 要较新的内核；CentOS 7 的 3.10 内核是靠 RHEL 的 backport 才勉强可用，bcc 还得用 `devtoolset` + `llvm-toolset` 自己编。
- **开销不小。** 每次 `malloc/free` 都要陷入一次 uprobe。实测挂上之后，目标进程的 CPU 占用翻了一倍以上。在别人的业务机上，这一条足以让它只能短时间开、开完就撤。
- **只给符号加偏移，不给行号。** 需要再用 `addr2line` 自己换算。
- **必须是活进程**，要有 PID。跑完就退的程序用不了 —— 不过那类程序本来也不是这个问题的主角。

## 四、自己 hook：把检测做进程序里

前面的工具都是「出了问题再从外面挂上去」。对一个要部署到上百种客户环境里的采集器，更实际的做法是**把检测做成程序自带的、默认关闭的开关**：怀疑泄漏时打开，不依赖目标机器装了什么。

原理就是让对 `malloc/free` 的调用先经过自己的函数，记一笔账再转给真正的实现。三种做法，覆盖面依次变化：

| 做法 | 覆盖面 | 代价 |
|---|---|---|
| **宏替换**：头文件里 `#define malloc(n) malloc_hook(n, __FILE__, __LINE__)` | 只有 include 了这个头文件的编译单元 | 第三方库完全看不见；只有一层调用者 |
| **符号劫持**：`LD_PRELOAD` 一个 so，内部用 `dlsym(RTLD_NEXT, "malloc")` 拿到原函数 | 进程内所有动态链接的调用，含第三方库 | GNU 扩展，换到 AIX / HP-UX 要另写一套 |
| **C++ 重载** `operator new/delete` | 所有走 `new` 的分配，包括 `std::string`、容器、智能指针内部 | 只管 C++ 这一侧 |

宏替换是三者里唯一不依赖平台特性的方案，对要同时跑在 Linux、AIX、HP-UX 上的程序最省事 —— 代价是只能看见自己的代码。

几个实现时必然踩到的坑：

- **记账本身也要分配内存。** 用 `std::map` 记 `new` 的账，`map` 插入节点又会调 `operator new`，于是无限递归。要么用一个标志位在记账期间旁路，要么给记账容器单独配一个不走 hook 的分配器。标志位是全局的，**多线程下它就不成立了**，必须换成 thread-local。
- **记账结构要能 O(1) 删除。** 链表在每次 `free` 时线性扫描，用在高频分配的程序上，hook 本身就成了性能问题。用哈希表，以地址为键。
- **`realloc` 要先删旧地址再记新地址**，而且要处理返回 `NULL` 时旧块仍有效的情况。
- **只记文件行号不够。** 和 mtrace 一样，封装一深就分不出调用方。要在记账时用 `backtrace()` 抓几层栈，按栈聚合 —— 这其实就是在自己重做一个 `memleak`。

最重要的一条：**hook 到 `malloc` 这一层，对内存池泄漏依然无效** —— 理由和第二节一样。要抓池子的泄漏，记账得做在池子的接口上（`apr_palloc` / `apr_pool_clear`），按池子统计「只增不清」的那些。

## 五、怎么选

```
程序会退出吗？
├─ 会，且能在测试环境复现  → valgrind，信息最全
└─ 不会（常驻进程）
    │
    内存经过内存池吗？
    ├─ 不经过 → 运行时按栈看增长：memleak / tcmalloc heap profiler 做前后 diff
    └─ 经过   → malloc 层的工具都会漏
               ├─ 池子走 mmap 的那部分 → memleak（带 mmap 跟踪）
               └─ 根本办法 → 在池子接口上记账，看哪个池只增不清
```

两条轴拆开来看就清楚了：

- **时间轴：** 退出时对账的工具，判据是「指针丢没丢」；常驻进程要的判据是「同一个栈上的未释放量是否单调上涨」。
- **层次轴：** 工具挂在哪一层，就只能看见那一层。泄漏发生在池子里，挂在 `malloc` 上的工具看见的只是池子在正常地向系统要内存。

::: tip
**选工具之前先问：泄漏发生在哪一层、什么时候才表现出来。**

valgrind 在它的判据下没有出错 —— 它准确地报告了「退出时没有丢失的指针」。
是我们问错了问题。
:::
