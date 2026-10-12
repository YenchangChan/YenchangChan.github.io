---
title: 明明加了 -gdwarf-4，core 里还是没有行号
---

# 明明加了 -gdwarf-4，core 里还是没有行号

> 采集器在生产环境 coredump 了。把 core 拿到手，`bt` 只有函数名，没有参数，没有行号。
>
> 第一层原因很快就找到了：**编译机的 gcc 太新，客户机上的 gdb 太老。** 按官方文档加上 `-gdwarf-4`，demo 立刻好了。正式程序没好。
>
> 第二层原因藏在一个第三方库的 Makefile 里，而且只占全部编译单元里的 7 个。这篇主要讲第二层：**为什么 7 个编译单元能让整个二进制的调试信息作废**，以及怎么在出厂前就发现它。

## 一、现场

| | |
|---|---|
| 编译环境 | 容器内 gcc 11.3（为了同时编译另一个 C++17 项目，编译环境整体容器化） |
| 调试环境 | CentOS 7，系统自带 gdb `7.6.1-120.el7` |
| 依赖 | openssl、apr、bzip2 等，全部在容器内从源码编译成静态库，链接进二进制 |

gdb 加载时的原话：

```
Reading symbols from ./flow...Dwarf Error: wrong version in compilation unit header
(is 5, should be 2, 3, or 4) [in module ./flow]
(no debugging symbols found)...done.

(gdb) bt
#0  0x00007f13b9ae7a35 in pthread_cond_wait@@GLIBC_2.3.2 () from /lib64/libpthread.so.0
#1  0x00000000004117d5 in nxlog_worker_thread ()
#2  0x000000000040cdd5 in _thread_helper ()
```

注意 `bt` 里**还有函数名**。函数名来自 ELF 的符号表 `.symtab`，它没丢；丢的是 DWARF 调试信息 —— 参数、局部变量、文件和行号。「符号表丢了」是常见的说法，但不准确，排查方向会因此偏掉：这时候该查的不是有没有 strip，而是 DWARF 本身。

## 二、第一层：DWARF 版本对不上

DWARF 是 ELF 上的调试信息格式，从 v2 到 v5 每一版的编码都有变化，老的调试器不认识新版本。gcc 11 开始，**大多数目标的默认版本从 4 改成了 5**；而 GCC 文档写明 v5 需要 GDB 8.0 以上。CentOS 7 的 gdb 是 7.6。

两条路都走不通：降级编译器，另一个 C++17 项目就编不了；让客户升级 gdb，不现实 —— 采集器跑在别人的业务机上，那台机器上有什么调试工具，我们决定不了。

剩下的办法是让编译器迁就调试器：

```bash
gcc -g -gdwarf-4 -gstrict-dwarf -fvar-tracking-assignments ...
```

- `-gdwarf-4`：输出 DWARF 4
- `-gstrict-dwarf`：不在 v4 里夹带 v5 的扩展，否则老 gdb 仍可能读不懂
- `-fvar-tracking-assignments`：GCC 文档对 v4 的建议，改善优化代码里变量的调试信息（带 `-O -g` 时其实默认就开着）

用一个最小程序验证，容器里编译、宿主机上调试，问题消失。

于是在 Dockerfile 里全局设上：

```dockerfile
ENV CC="gcc -gdwarf-4 -gstrict-dwarf -fvar-tracking-assignments" \
    CXX="g++ -gdwarf-4 -gstrict-dwarf -fvar-tracking-assignments"
```

**正式程序重新编译，gdb 报的还是同一句话：`is 5`。**

## 三、第二层：二进制里不止一种版本

先确认自己的代码确实是 v4。DWARF 里每个编译单元（CU）都带一个 `DW_AT_producer` 属性，**原样记录了编译它时的命令行参数**：

```
 Compilation Unit @ offset 0x0:
   Version:       4
   DW_AT_producer : GNU C17 11.3.0 -mtune=generic -march=x86-64 -g -gdwarf-4 -gstrict-dwarf -O2 -fPIC
   DW_AT_name     : src/core/protocol.c
```

没问题。那就不该只看第一个 CU，而是把整个二进制里的版本号全部数一遍：

```
$ objdump --dwarf=info ./flow | grep -n 'Version: *5'
754527:   Version:       5
760323:   Version:       5
760406:   Version:       5
760489:   Version:       5
764421:   Version:       5
766682:   Version:       5
769783:   Version:       5
```

7 个 v5 的编译单元。跳到第一处：

```
 Compilation Unit @ offset 0x1807e4:
   Version:       5
   DW_AT_producer : GNU C17 11.3.0 -mtune=generic -march=x86-64 -g -O2
   DW_AT_name     : bzlib.c
   DW_AT_comp_dir : /tmp/bzip2-1.0.8
```

`DW_AT_producer` 里**没有 `-gdwarf-4`**。是静态链接进来的 bzip2，环境变量 `CC` 对它没生效。

到容器里对照依赖库：

```
$ objdump --dwarf=info libssl.a | grep Version   →  全是 4
$ objdump --dwarf=info libbz2.a | grep Version   →  全是 5
```

### 为什么偏偏是 bzip2

openssl、apr 走的是 `configure`，会读环境变量里的 `CC`。bzip2 没有 `configure`，只有一个手写的 Makefile：

```makefile
# To assist in cross-compiling
CC=gcc
AR=ar
RANLIB=ranlib
LDFLAGS=

CFLAGS=-Wall -Winline -O2 -g $(BIGFILES)
```

这是 make 的变量优先级：

```
命令行  make CC=...   >   Makefile 里的赋值  CC=gcc   >   环境变量  CC=...
```

**Makefile 里的普通赋值会覆盖同名的环境变量。** Dockerfile 里设的 `CC` 一进 bzip2 的 Makefile 就被换回了 `gcc`，带的是 gcc 11 的默认值 —— DWARF 5。

注释写的是 "To assist in cross-compiling"：作者设想的用法是 `make CC=xxx` 从命令行传进来，而不是靠环境变量。所以有两种改法：

```makefile
CC ?= gcc            # 改 Makefile：只在没设置时才用默认值
```

```bash
make CC="$CC"        # 不改源码：从命令行传，优先级最高
```

第二种更好 —— 不用给第三方源码打补丁，升级 bzip2 时也不会忘。

改完重编，`libbz2.a` 全部变成 v4，gdb 加载不再报错，`bt` 拿到了完整的参数和行号：

```
#1  0x000000000049b731 in apr_file_open (new=0x7f7034003320, fname=0x7f7034002ad0 "...",
    flag=1, perm=<optimized out>, pool=0x7f7034003288) at file_io/unix/open.c:176
#2  0x000000000041c1b9 in im_file_ext_input_open (module=0x2313a00, ...)
    at src/modules/input/fileExt/im_fileExt.c:976
...
#7  0x00000000004118da in nxlog_worker_thread (thd=0x22f1c08, data=<optimized out>)
    at src/core/nxlog.c:552
```

## 四、为什么 7 个 CU 能毁掉整个二进制

回头看第一节的 `bt`：`nxlog_worker_thread` 在 `src/core/nxlog.c` 里，是 v4 编译的，**它的行号也没了。**

出问题的只是 bzip2 那 7 个编译单元，可 gdb 7.6 读到第一个不认识的 CU 头就报 `Dwarf Error`，然后放弃了**整个模块**的 DWARF 信息 —— 输出里那句 `(no debugging symbols found)` 说的是整个 `./flow`，不是 bzlib.c。

::: warning
**静态链接时，调试信息的可用性取决于最差的那个编译单元。**

你自己的代码全对没用，只要链接进来的任何一个 `.a` 里混了一个老 gdb 不认识的 CU，
老 gdb 就会把整个二进制的调试信息丢掉。而且它报错时不会告诉你是哪个 CU。
:::

这也是为什么验证「第一个 CU 是 v4」不够，必须全量数一遍。

## 五、出厂前就拦住它

core 是在客户那里出的，发现调试信息没用的时候，现场往往已经没了。所以这个检查要放在构建流水线里，而不是等出事以后：

```bash
# 二进制里不允许出现 DWARF 5 的编译单元
n=$(readelf --debug-dump=info ./flow 2>/dev/null | grep -c 'Version: *5')
[ "$n" -eq 0 ] || { echo "found $n DWARF5 CUs"; exit 1; }
```

报错之后，用 `DW_AT_producer` 和 `DW_AT_comp_dir` 定位是哪个库、用什么参数编的 —— **二进制自己记着每个编译单元的编译命令**，这比翻构建日志可靠。

第三方依赖的构建方式也要统一：**不要假设环境变量能传进去。** `configure` 系的会读，手写 Makefile 的不一定。对这类库，统一用 `make CC="$CC" CFLAGS="..."` 从命令行显式传参。

::: tip
**调试信息是写给客户机上那个调试器看的，不是写给编译机看的。**

编译环境可以随便升级，部署环境里的 gdb 版本由客户决定。
在别人的机器上出了 core，能用的往往只有那台机器上原本就有的工具 ——
所以产物要按调试器能接受的**最低**版本来编，并且在出厂前验证全部编译单元，而不是只看一个。
:::
