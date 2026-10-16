---
title: chdb 在老 CPU 上 SIGILL：同一台机器，clickhouse 却跑得好好的
---

# chdb 在老 CPU 上 SIGILL：同一台机器，clickhouse 却跑得好好的

同一台机器、同一个操作系统上，`clickhouse` 二进制运行得好好的，Python 里 `import chdb` 进程直接崩掉：SIGILL，退出码 132，没有任何 Python 层的报错，也没有 ClickHouse 日志。

受害环境是一台 VMware 虚拟机，宿主机 Xeon E5-2620 v4 (Broadwell)，但通过 EVC 以 Westmere 基线暴露给 guest，`/proc/cpuinfo` 里看不到 `avx` 和 `xsave`。

奇怪的点就在这对照上：chdb 是把 ClickHouse 嵌进 Python 的库，底层同一份代码，凭什么 clickhouse 能跑、chdb 必死？排查下来，答案是一行编译参数，上游把基线抬到了 AVX。

## 不是指令更多，是基线更高

这两个说法经常混着用，其实是两回事：

| | ClickHouse 官方二进制 | chdb 上游（x86_64） |
|---|---|---|
| 来源 | `cmake/cpu_features.cmake` 默认值 | `chdb/build.sh` 显式覆盖 |
| 基线 | SSSE3 / SSE4.1 / SSE4.2 / PCLMULQDQ / POPCNT | 以上全部 + `-mavx` |
| AVX 的存在形式 | 只出现在热点函数的 target 特化版本里，运行时按 CPUID 分发 | 全局 `-mavx`，所有代码都在 AVX 基线上编译 |

`cmake/cpu_features.cmake:126-134` 里 `ENABLE_AVX` 默认是 0，`chdb/build.sh` 却在 x86_64 分支传了 `-DENABLE_AVX=1`，clang 于是拿到全局 `-mavx`。病根就这一行。

## -mavx 真正阴的地方：它改编码

我一开始也往"二进制里多了几条 AVX 指令，老 CPU 不认识"上想。真相比这个糟得多。

**`-mavx` 会把所有 SSE 指令改发成 VEX 编码**，`movsd` 变 `vmovsd`，`addsd` 变 `vaddsd`，普通的浮点运算一个都不放过。而 VEX 编码的指令有一条硬件规则：操作系统没有启用 AVX 状态保存（XSAVE/YMM）的 CPU 上，它们直接按非法指令处理。EVC 面具里没有 AVX，这条规则就生效，于是二进制里几乎遍地都是会触发 #UD 的字节，连静态初始化器里的浮点运算都躲不掉。

崩溃时机就是这么不巧：`dlopen(libchdb.so)` 之后，动态链接器按 `.init_array` 挨个跑静态初始化器，第一个碰上浮点运算的初始化器，第一条 VEX 指令，SIGILL。这早于 `main()`，早于 ClickHouse 任何日志子系统的初始化，所以表现就是毫无声息地死掉，连调用栈都来不及建立。

`clickhouse` 二进制是独立进程，基线 SSE4.2，Westmere 原生支持，自然正常启动。同一个系统一个活一个死的错觉，根源就在这一行编译参数上。

## 怎么验证

受害机器上三步：

```bash
# CPU 确实没有 AVX
grep -o avx /proc/cpuinfo | head -1   # 无输出

# 复现：没有任何输出，死在 dlopen 阶段
python3 -c 'import chdb'

# 二进制里到处是 VEX 编码（v 前缀指令出现在普通函数里）
objdump -d path/to/libchdb.so | grep -m5 'vmovsd\|vaddsd'
```

更精确的做法是盯着 ELF 静态初始化器看：对 `libchdb.so` 跑 `objdump -d`，找 `.init_array` 引用的函数，补丁前里面能直接看到 `vmovsd` 这类 VEX 指令，补丁后应全部退回传统 SSE 编码。这个对照比扫全库更有说服力，因为它指认的正是崩溃现场。

## 修复就一行

`chdb/build.sh` 的 x86_64 分支：

```diff
-        CPU_FEATURES="-DENABLE_AVX=1 -DENABLE_AVX2=0"
+        CPU_FEATURES="-DENABLE_AVX=0 -DENABLE_AVX2=0"
```

基线回落到 SSE4.2，与 ClickHouse 官方发行版一致。看代码，AVX 关掉以后 `cmake/cpu_features.cmake:209` 也不会再给 Rust 部件追加 `target-feature=+avx`，`RUSTFLAGS_CPU` 这条链跟 C++ 是同源的，两侧一起受控，不会出现 C++ 降了、Rust 还抬着的半吊子状态。

配套做了个 `Dockerfile.compat-builder`，把官方 CI 的工具链（clang-19、rust nightly-2025-07-07 这些）固化成可复现的容器构建环境，保证改完基线以后能稳定地重编出 `libchdb.so`。

## 性能会损失吗

基本不会。x86 上的向量化热点本来就不是靠基线拿到的：

`ENABLE_MULTITARGET_CODE` 默认开着，编译器会用 `__attribute__((target("avx2")))` 这类属性给同一个热点函数生成多份指令集特化版本，运行时在函数入口按 CPUID 选最优的一份分发。说白了，**基线决定"任何 CPU 都能跑"，multitarget 决定"新 CPU 跑得快"**。把基线从 AVX 降回 SSE4.2，只动前者，AVX2、AVX512 机器上的热点路径一条不少。

反过来看，把基线抬到 AVX 换来的"性能"是什么？只是编译器在所有冷路径上用 VEX 编码发 SSE 指令，实际收益微乎其微，代价是整块老 CPU 的兼容性。这笔账怎么算都是亏的。

## 最后

这次的有用经验有三条。判断一个二进制能不能在老 CPU 上跑，别看"有没有 AVX 指令"，要看编译基线，`-mavx` 的语义是改编码，不只是开指令。嵌入式库比独立进程对基线敏感得多，独立进程好歹能跑到 `main()` 再打印日志，库的静态初始化器在加载阶段就执行，崩的时候用户进程里什么都没留下。还有一条默认值：嵌入式 ClickHouse 的兼容性承诺应该跟官方二进制对齐，SSE4.2 基线是官方趟出来的安全线，自行抬高之前得想清楚换来什么。

跟麒麟 ARM 上那篇是同一族问题。那边是官方构建要了 `rcpc`、自检排在崩溃之后；这边是上游一行参数抬了基线，死得比所有初始化都早。两头合起来就一句话：碰上 SIGILL，先问基线，别问包。

---

**相关**：[信创与异构环境](/clickhouse/vendor/) · [ARM 上一跑就 SIGILL：缺的是 rcpc，自检又来不及报](/clickhouse/vendor/kylin-arm-instruction-baseline)
