---
title: ARM 上一跑就 SIGILL：缺的是 rcpc，自检又来不及报
---

# ARM 上一跑就 SIGILL：缺的是 rcpc，自检又来不及报

ClickHouse 在大部分操作系统上的兼容性都还不错，可在麒麟 ARM 上奇差。绝大多数版本，直接用官方的 ARM 包，一运行就 coredump，屏幕上只有一句 `Illegal instruction (core dumped)`，别的什么信息都没有。我们实测能用的只有两个版本，`22.3.10.22` 和 `23.3.9.55`。

这类问题在社区里也一直有人报，可基本都是不了了之。我顺着查了一遍，发现报的人和看的人，都把方向带偏了。

## 不是下错了包

这类 issue 的标题经常写成「下错了包」，这个说法让它一直没人接，[#89841](https://github.com/ClickHouse/ClickHouse/issues/89841) 就是这样。

可看日志，官方那条一行安装脚本自己选的就是兼容构建：

```
curl https://clickhouse.com/ | sh
Will download https://builds.clickhouse.com/master/aarch64v80compat/clickhouse
```

报告的人既没有手动去挑 master，也没挑错 flavour，`aarch64v80compat` 就是官方安装器在 aarch64 上自己选的。照着官网首页操作的机器，落到的都是这一条。

## 现在的 v80compat 构建是干净的

我把当前 `master/aarch64v80compat` 的自解压二进制拆开，对 payload 的整个 `.text` 段扫了一遍，一共 89,489,881 条指令，搜 LSE 原子指令（`ldadd` / `ldclr` / `ldeor` / `ldset` / `ldsmax` / `ldsmin` / `ldumax` / `ldumin` / `swp` / `cas` / `casp`）。

命中 25 个，25 个全在 libgcc 的 outline-atomics helper 里（`__aarch64_cas1_relax`、`__aarch64_swp8_acq_rel`、`__aarch64_ldadd4_relax` 这些），每一个前面都有 `__aarch64_have_lse_atomics` 这个运行时标志挡着，后面还带着 LL/SC 的回退：

```asm
__aarch64_cas1_relax:
  adrp x16, ...              // __aarch64_have_lse_atomics
  ldrb w16, [x16, #0xa90]
  cbz  w16, <fallback>       // 运行时没有 LSE → 根本走不到下一条
  casb w0, w1, [x2]
  ...
  ldxrb / stxrb              // ARMv8.0 安全路径
```

没有一条是裸露在外、没被保护的 LSE 指令。另外有同事在物理 aarch64 机器上跑了当前的构建（26.8.1.515），启动正常，查询也正常。至于 2025 年 11 月那次报告时是什么情况，已经没法直接验证了，`builds.clickhouse.com` 只保留最新的 master。

这里顺带说一下，排查这类问题，千万别把二进制 grep 一遍 `ldadd`、`cas`、`swp`，看见了就认定它需要 ARMv8.1。现在 GCC、Clang 编出来的 aarch64 二进制都带这些指令，它们就待在 outline-atomics helper 里，而这些 helper 存在的目的，恰恰是让二进制能在 ARMv8.0 上跑。真正要问的是，这条指令有没有出现在受运行时保护的 helper 之外，这得把每个命中拿去和符号表对一遍，看一眼汇编下不了结论。

## 那到底挂在哪？是 rcpc

验证上面这件事的时候，我撞上了另一个相关的失败，它才是这个问题的真面目。

一台 CPU flags 是这样的机器：

```
fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp
cpuid asimdrdm jscvt fcma dcpop
```

`atomics` 有，`lrcpc` 没有。在它上面跑常规的 aarch64 包 `clickhouse-common-static-26.3.17.56`，当场就死：

```
Program received signal SIGILL, Illegal instruction.
0x00000000206ef8f4 in global constructors keyed to 000100 ()
(gdb) x/i $pc
=> 0x206ef8f4 <_GLOBAL__I_000100+20>:   .inst   0x38bfc108 ; undefined
```

`0x38bfc108` 解码出来是 `LDAPRB`，属于 FEAT_LRCPC，是 ARMv8.3 的东西，跟 LSE 没关系。这和 CPU flags 完全对得上：默认的 ARM 构建在 `cmake/cpu_features.cmake` 里用的是

```
-march=armv8.2-a+simd+crypto+dotprod+ssbs+rcpc+bf16
```

而这颗 CPU 没有 `rcpc`。

所以 ARM 二进制起不来，压根就不只是 LSE 的事，`dotprod`、`rcpc`、`bf16` 缺了哪一个，症状都一模一样。[#121161](https://github.com/ClickHouse/ClickHouse/issues/121161) 又补了一个维度：官方的 arm64 Docker 镜像是按 ARMv8.2-A SVE 编译的，不支持 SVE 的 aarch64 处理器上照样 SIGILL。

## 自检写了，却永远赶不上

其实 ClickHouse 是写了指令集自检的。26.3 的 `src/Common/EnvironmentChecks.cpp` 会在启动时打出一句人能看懂的话：

> `Instruction check fail. The CPU does not support <X> instruction set.`

问题有两个。第一，它只管 x86，从 SSE3 到 AVX512 都有，`__aarch64__` 的分支一个都没有。

第二，就算补上 ARM 的分支，在这个场景里它也不会触发。崩溃发生在一个优先级 100 的静态初始化器里，而 `Checker` 是 `init_priority(101)`（`EnvironmentChecks.cpp:181`），检查是在崩溃之后才轮到的。代码自己的注释写得明明白白：

> This function must be called as early as possible, even before main, because static initializers may use unavailable instructions.

想法是对的，只是 `init_priority(101)` 不够早。优先级 0 到 100 是留给实现用的，没法再往前排了。

这就是这类报告为什么没法查。[#89841](https://github.com/ClickHouse/ClickHouse/issues/89841)，还有更早的 #19028，到最后手里都只剩一句光秃秃的 `Illegal instruction`，然后被打上 `st-need-info` 关掉。说起来也怪不得报告的人不配合，在这种失败方式下，程序自己就没留下任何能说明问题的信息。

我的建议是把检查挪进 `.preinit_array`，它确实在所有静态初始化器之前运行，再用 `getauxval(AT_HWCAP)` 把这个构建实际需要的 ARM 特性都检查一遍。验证要两头做：在受影响的 CPU 上，它得带着清楚的报错触发；在 `-DNO_ARMV81_OR_HIGHER=1` 的构建上，它不该触发。

## 看着有三条路，生产上能走的只有一条

最容易误判的是官方的 `aarch64v80compat`。前面说了它现在的构建是干净的，可干净和能不能用是两码事：

```
https://builds.clickhouse.com/master/aarch64v80compat/clickhouse
                              ↑
                            master
```

`aarch64v80compat` 只存在于流水线的产物里，拉到的永远是基于最新 master 的包。生产环境要的是 LTS，起码也得是 release 版本，要有确定的版本号、确定的支持周期、确定的补丁回移路径，master 构建一样都给不了。目前没有任何渠道提供 LTS 或者 release 的 `aarch64v80compat` 包，所以这条路对生产来说根本不可选，拿它验证一下自己的 CPU 行不行还可以，拿去部署不行。

说到底，缺的不是编译选项。`-DNO_ARMV81_OR_HIGHER=1` 一直都在，官方也一直在构建 v80compat，缺的是把它当成正式的发布产物交出来。[#121161](https://github.com/ClickHouse/ClickHouse/issues/121161) 请求官方发布 ARMv8.0 基线的 Docker 镜像，方向是对的，可缺口比 Docker 大得多，二进制包、`.deb`、`.rpm`，还有最要紧的带 LTS 版本号的那一份，全都没有。

第二条路是停在实测能用的老版本上，`22.3.10.22` 或者 `23.3.9.55`。成本低，可后面所有的新特性和修复都得放弃，需要长期维护的生产集群一般接受不了。

剩下的就是用 `-DNO_ARMV81_OR_HIGHER=1` 自己编译，版本自己定，可以一直盯着 LTS 走，也不受上游构建口径变化的影响。代价是每次升级都得重新编，包管理、分发和版本追踪也都得自己来。这条路我们已经实际走通了。所以它不是三条路里最重的那条，而是唯一真正能用的那条。

<!-- TODO: 降基线之后的性能代价：丢掉 LSE / rcpc / dotprod / bf16，
     实测查询与写入差多少？既然自编译已经是唯一选择，
     这个数字就不再是"选不选"的依据，而是"要不要上 ARM"的依据。 -->

## 最后

在麒麟 ARM 上碰到 SIGILL，先别怀疑是不是包下错了，官方安装器在 aarch64 上选的就是 v80compat。默认的 ARM 构建要的也远不止 LSE，`rcpc`、`dotprod`、`bf16` 缺一个都起不来，Docker 镜像还额外要 SVE。偏偏 ClickHouse 自己的指令集自检既没有 ARM 分支，又排在崩溃现场之后，出了事一句有用的话都留不下。官方又不提供 LTS 版本的兼容包，**生产上想用新版本，只能自己编**。

---

**相关**：[信创与异构环境](/clickhouse/vendor/) · [#89841](https://github.com/ClickHouse/ClickHouse/issues/89841) · [#121161](https://github.com/ClickHouse/ClickHouse/issues/121161)
