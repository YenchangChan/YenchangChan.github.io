---
title: ARM 上一跑就 SIGILL，以及为什么这类问题查不出来
---

# ARM 上一跑就 SIGILL，以及为什么这类问题查不出来

> 国产 ARM 上跑 ClickHouse，经常是下载、执行、`Illegal instruction (core dumped)`，没有任何其他信息。
>
> 这篇记录三件事：**它不是「包下错了」**；**真正缺的指令不是大家以为的那个**；以及 —— **ClickHouse 明明写了指令集自检，却永远不会在这个场景里触发。**

## 一、先纠正一个误导性的前提

这类 issue 的标题常常写成「下错了包」，而这个措辞会让它一直没人接（[#89841](https://github.com/ClickHouse/ClickHouse/issues/89841) 就是这样）。

但日志显示，**官方那条一行安装脚本自己选的就是兼容构建**：

```
curl https://clickhouse.com/ | sh
Will download https://builds.clickhouse.com/master/aarch64v80compat/clickhouse
```

报告者没有手动挑 master、也没挑错 flavour —— **`aarch64v80compat` 就是官方安装器在 aarch64 上的选择**。任何照着官网首页操作的机器，落到的都是这条路径。

## 二、当前的 v80compat 构建其实是干净的

把当前 `master/aarch64v80compat` 的自解压二进制拆开，对 payload 的整个 `.text` 段做扫描 —— **89,489,881 条指令** —— 搜 LSE 原子指令（`ldadd` / `ldclr` / `ldeor` / `ldset` / `ldsmax` / `ldsmin` / `ldumax` / `ldumin` / `swp` / `cas` / `casp`）。

结果：**25 个命中，25 个全部落在 libgcc 的 outline-atomics helper 里**（`__aarch64_cas1_relax`、`__aarch64_swp8_acq_rel`、`__aarch64_ldadd4_relax` …），每一个都被 `__aarch64_have_lse_atomics` 运行时标志保护，且带 LL/SC 回退：

```asm
__aarch64_cas1_relax:
  adrp x16, ...              // __aarch64_have_lse_atomics
  ldrb w16, [x16, #0xa90]
  cbz  w16, <fallback>       // 运行时没有 LSE → 根本走不到下一条
  casb w0, w1, [x2]
  ...
  ldxrb / stxrb              // ARMv8.0 安全路径
```

**没有任何一条未被保护的 LSE 指令。** 另有同事在物理 aarch64 机器上跑当前构建（26.8.1.515），启动正常、查询正常。

2025 年 11 月那次是什么状况已经无法直接验证 —— `builds.clickhouse.com` 只保留最新的 master。

::: warning 一条给同类排查的方法论警告
**把二进制 grep 一遍 `ldadd` / `cas` / `swp`，见到就判定「需要 ARMv8.1」，会产生大量假阳性。**

每个现代 GCC / Clang 编译的 aarch64 二进制都含有这些指令 —— 它们在 outline-atomics helper 里，而这些 helper 存在的目的**恰恰就是让二进制能在 ARMv8.0 上工作**。

有意义的问题是：**这条指令有没有出现在运行时保护的 helper 之外。** 这需要把每个命中拿去和符号表对齐，而不是看一眼汇编就下结论。
:::

## 三、那到底是什么在挂？不是 LSE，是 `rcpc`

在验证上面那件事的过程中，撞到了一个相关的失败 —— **它才是这个问题的真面目。**

一台 CPU flags 如下的机器：

```
fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp
cpuid asimdrdm jscvt fcma dcpop
```

注意：**`atomics` 有，`lrcpc` 没有。**

在它上面跑**常规** aarch64 包 `clickhouse-common-static-26.3.17.56`，立刻死：

```
Program received signal SIGILL, Illegal instruction.
0x00000000206ef8f4 in global constructors keyed to 000100 ()
(gdb) x/i $pc
=> 0x206ef8f4 <_GLOBAL__I_000100+20>:   .inst   0x38bfc108 ; undefined
```

`0x38bfc108` 解码出来是 **`LDAPRB`** —— 属于 **FEAT_LRCPC，ARMv8.3，不是 LSE**。

和 CPU flags 完全对得上。默认 ARM 构建用的是（`cmake/cpu_features.cmake`）：

```
-march=armv8.2-a+simd+crypto+dotprod+ssbs+rcpc+bf16
```

而这颗 CPU 没有 `rcpc`。

> **所以「ARM 二进制起不来」根本不只是 LSE 的事 —— `dotprod`、`rcpc`、`bf16` 里任何一个缺失，症状完全一样。**

（[#121161](https://github.com/ClickHouse/ClickHouse/issues/121161) 又补了一个维度：官方 arm64 **Docker 镜像**按 ARMv8.2-A SVE 编译，不支持 SVE 的 aarch64 处理器上同样 SIGILL。）

## 四、最深的一层：自检存在，但永远不会触发

ClickHouse 是**写了**指令集自检的。`src/Common/EnvironmentChecks.cpp` 会在启动时打印一句人类可读的：

> `Instruction check fail. The CPU does not support <X> instruction set.`

**但有两个问题：**

### ① 它只覆盖 x86

从 SSE3 到 AVX512 都有 —— **完全没有 `__aarch64__` 分支。**

### ② 就算加上 ARM 分支，它在这个场景里也不会触发

崩溃发生在一个 **priority-100 的静态初始化器**里，而 `Checker` 是 `init_priority(101)`（`EnvironmentChecks.cpp:181`）—— **检查严格地在崩溃之后才运行。**

而代码自己的注释已经写明了要求：

> This function must be called as early as possible, even before main, because static initializers may use unavailable instructions.

**意图是对的，`init_priority(101)` 只是不够早** —— 因为优先级 0–100 是保留给实现的，没法再往前排。

### 这就是为什么这类报告无从下手

[#89841](https://github.com/ClickHouse/ClickHouse/issues/89841)、以及更早的 #19028 —— 最后手里只剩一句光秃秃的 `Illegal instruction`，然后被关成 `st-need-info`。

**不是报告者不配合，是这个系统在这种失败模式下失去了解释自己的能力。**

### 提议的修复

把检查移进 **`.preinit_array`**（它确实运行在所有静态初始化器之前），并用 `getauxval(AT_HWCAP)` 覆盖这个构建实际需要的 ARM 特性。

双向验证：在受影响的 CPU 上它要带着清晰的消息触发；在 `-DNO_ARMV81_OR_HIGHER=1` 构建上它不该触发。

---

## 看起来有三条路，生产上只有两条

### ❌ 官方 `aarch64v80compat`：拿不到能上生产的包

这是最容易被误判的一条。前面说了它当前的构建是干净的 —— 但那和能不能用是两回事：

```
https://builds.clickhouse.com/master/aarch64v80compat/clickhouse
                              ↑
                            master
```

**`aarch64v80compat` 只存活于流水线产物。** 你拉到的永远是**基于最新 master** 的包。

而生产环境要的是 **LTS 版本，至少是 release 版本** —— 需要确定的版本号、确定的支持周期、确定的补丁回移路径。**master 构建一样都给不了。**

> **没有任何渠道提供 LTS / release 的 `aarch64v80compat` 包。**

所以这不是「成本低但有回归风险」，而是**对生产场景根本不可选**。它能用来验证一下「我的 CPU 到底行不行」，但不能拿去部署。

::: danger 真正的缺口不是编译选项，是发布渠道
`-DNO_ARMV81_OR_HIGHER=1` 这个选项一直都在，官方也一直在构建 v80compat —— **缺的是把它作为发布产物交付出来。**

[#121161](https://github.com/ClickHouse/ClickHouse/issues/121161) 请求官方发布 ARMv8.0 基线的 **Docker 镜像**，方向是对的，但缺口比 Docker 更宽：**二进制包、`.deb` / `.rpm`、以及最关键的 —— 带 LTS 版本号的那一份，全都没有。**
:::

### 🟡 停在实测可用的老版本

`22.3.10.22` / `23.3.9.55` —— 成本低，但要放弃后续所有特性与修复。对需要长期维护的生产集群通常不可接受。

### ✅ `-DNO_ARMV81_OR_HIGHER=1` 自编译

**不是"三选一里最重的那个"，是唯一真正可用的那个。**

| | 自编译 |
|---|---|
| 版本 | 自己定，可以盯着 LTS 走 |
| 可控性 | 不受上游构建口径变化影响 |
| 代价 | 每次升级都要重编；要自己做包管理、分发和版本追踪 |

这条路已经实际走通，不是理论推导。

<!-- TODO: 降基线之后的性能代价 —— 丢掉 LSE / rcpc / dotprod / bf16，
     实测查询与写入差多少？既然自编译已经是唯一选择，
     这个数字就不再是"选不选"的依据，而是"要不要上 ARM"的依据。 -->

## 留给读者的

1. **ARM 上 SIGILL 通常不是「下错了包」** —— 官方安装器在 aarch64 上选的就是 v80compat
2. **别用 grep 判断二进制要不要 ARMv8.1** —— outline-atomics helper 会给你一堆假阳性，要对符号表
3. **默认 ARM 构建要的远不止 LSE** —— `-march=armv8.2-a+simd+crypto+dotprod+ssbs+rcpc+bf16`，任一缺失症状相同；Docker 镜像还额外要 SVE
4. **`EnvironmentChecks` 救不了你** —— 无 ARM 分支，且 `init_priority(101)` 晚于崩溃现场
5. **`aarch64v80compat` 只有 master 构建，没有 LTS / release 渠道** —— 对生产而言等于不存在
6. 所以**自编译不是"最重的选项"，是唯一的选项**

---

**相关**：[信创与异构环境](/clickhouse/vendor/) · [#89841](https://github.com/ClickHouse/ClickHouse/issues/89841) · [#121161](https://github.com/ClickHouse/ClickHouse/issues/121161)
