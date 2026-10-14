---
title: 明明加了 -gdwarf-4，core 里还是没有行号
---

# 明明加了 -gdwarf-4，core 里还是没有行号

我有一个C语言写的采集器程序，生产环境 coredump 了。coredump本身并不可怕，它反而更好的留存了现场快照，调试就是了。但是core 拿回来，用 gdb 一打开，第一屏就是一行报错，`bt` 出来只有光秃秃的函数名，参数、行号一概没有：

```
Reading symbols from ./collector...Dwarf Error: wrong version in compilation unit header
(is 5, should be 2, 3, or 4) [in module ./collector]
(no debugging symbols found)...done.

(gdb) bt
#0  0x00007f13b9ae7a35 in pthread_cond_wait@@GLIBC_2.3.2 () from /lib64/libpthread.so.0
#1  0x00000000004117d5 in nxlog_worker_thread ()
#2  0x000000000040cdd5 in _thread_helper ()
```

我第一反应是符号表丢了。这种情况一般就两个原因：编译时没加 `-g`，或者 DWARF 版本不对。编译脚本是我自己写的，`-g` 肯定有，那就只剩 DWARF 版本了。

事后回头看，「符号表丢了」这个说法其实不太准。函数名还在，说明 ELF 的符号表 `.symtab` 好好的，丢的是 DWARF 里的参数、局部变量和行号，它更像是程序被strip过。这次因为 `-g` 是我自己加的，整个编译流程我全盘掌控，就没往 strip 那边绕；如果换个人接手，很可能先去查是不是被 strip 了。

## 原因不难猜

为了顺带编译另一个 C++17 的项目，我把整个编译环境做成了容器，里面装的是 gcc 11.3。可生产环境是 CentOS 7，自带的 gdb 是 `7.6.1-120.el7`。

gcc 11 开始，大多数目标的默认 DWARF 版本从 4 变成了 5，而 GCC 文档里写得明明白白：v5 需要 GDB 8.0 以上。报错里那句 `is 5, should be 2, 3, or 4` 说的就是这个。

那怎么办？难不成把 gcc 降回去？那个 C++17 项目就编不了了。总不能逼着客户去升级生产环境的 gdb 吧？采集器跑在人家的业务机上，那台机器装什么调试工具，轮不到我们说了算。

好在 gcc 可以指定 DWARF 版本，让编译器去迁就调试器：

```bash
gcc -g -gdwarf-4 -gstrict-dwarf -fvar-tracking-assignments ...
```

- `-gdwarf-4`：输出 DWARF 4
- `-gstrict-dwarf`：不要在 v4 里夹带 v5 的扩展，不然老 gdb 照样可能读不懂
- `-fvar-tracking-assignments`：GCC 文档对 v4 的建议，改善优化后代码里变量的调试信息（带 `-O -g` 时其实默认就开着）

我写了个往字符串常量里写字节、必然 core 的小 demo，容器里编译、宿主机上调试，`bt` 正常了。于是在 Dockerfile 里把这几个参数全局设上：

```dockerfile
ENV CC="gcc -gdwarf-4 -gstrict-dwarf -fvar-tracking-assignments" \
    CXX="g++ -gdwarf-4 -gstrict-dwarf -fvar-tracking-assignments"
```

如果事情到这里就结束了，这篇文章也就没必要写了。正式程序重新编译，gdb 报的还是那句 `is 5`。

## 玄之又玄

先用objdump确认参数到底生没生效。DWARF 里每个编译单元（CU）都带一个 `DW_AT_producer` 属性，把编译它时的命令行原样记了下来：

```
 Compilation Unit @ offset 0x0:
   Version:       4
   DW_AT_producer : GNU C17 11.3.0 -mtune=generic -march=x86-64 -g -gdwarf-4 -gstrict-dwarf -O2 -fPIC
   DW_AT_name     : src/core/protocol.c
```

是 4，没毛病。那 gdb 嘴里的 5 是从哪来的？

我的代码都是 4，那会不会是链接进来的第三方库？带着这个疑问，我把整个二进制里所有 CU 的版本号都数了一遍：

```
$ objdump --dwarf=info ./collector | grep -n 'Version: *5'
754527:   Version:       5
760323:   Version:       5
760406:   Version:       5
760489:   Version:       5
764421:   Version:       5
766682:   Version:       5
769783:   Version:       5
```

果然有 7 个是 5。跳到第一处看看：

```
 Compilation Unit @ offset 0x1807e4:
   Version:       5
   DW_AT_producer : GNU C17 11.3.0 -mtune=generic -march=x86-64 -g -O2
   DW_AT_name     : bzlib.c
   DW_AT_comp_dir : /tmp/bzip2-1.0.8
```

`DW_AT_producer` 里根本没有 `-gdwarf-4`，是静态链接进来的 bzip2。到容器里对一下依赖库，它果然就是罪魁祸首：

```
$ objdump --dwarf=info libssl.a | grep Version   →  全是 4
$ objdump --dwarf=info libbz2.a | grep Version   →  全是 5
```

那问题又来了：Dockerfile 里是先设的 `CC`，再依次编 openssl、apr、bzip2，为什么别人都好好的，偏偏 bzip2 不认？

## 为什么偏偏是 bzip2

openssl 和 apr 走的是 `configure`，会去读环境变量里的 `CC`。我重新解开 bzip2 的源码包，发现它压根没有 `configure`，只有一个手写的 Makefile，一打开就看出了端倪：

```makefile
# To assist in cross-compiling
CC=gcc
AR=ar
RANLIB=ranlib
LDFLAGS=

CFLAGS=-Wall -Winline -O2 -g $(BIGFILES)
```

make 的变量优先级是这样的：

```
命令行  make CC=...   >   Makefile 里的赋值  CC=gcc   >   环境变量  CC=...
```

Makefile 里一句普通赋值，就把我在外面设的 `CC` 盖掉了，换回了光秃秃的 `gcc`，用的自然是 gcc 11 的默认值 DWARF 5。

一开始我觉得是 bzip2 的作者偷了个懒，稳妥的写法应该是 `CC ?= gcc`。不过再看一眼上面那行注释 "To assist in cross-compiling"，人家设想的用法其实是 `make CC=xxx` 从命令行传进去，只是没想到有人会靠环境变量。所以两种改法都行：

```makefile
CC ?= gcc            # 改 Makefile：只在没设置时才用默认值
```

```bash
make CC="$CC"        # 不改源码：从命令行传，优先级最高
```

我当时是直接改的 Makefile。现在回头看，第二种更好：不用给第三方源码打补丁，以后升级 bzip2 也不会忘了再打一遍。

重新编译，`libbz2.a` 全变成了 4，gdb 加载不再报错，`bt` 终于拿到了完整的参数和行号：

```
#1  0x000000000049b731 in apr_file_open (new=0x7f7034003320, fname=0x7f7034002ad0 "...",
    flag=1, perm=<optimized out>, pool=0x7f7034003288) at file_io/unix/open.c:176
#2  0x000000000041c1b9 in im_file_ext_input_open (module=0x2313a00, ...)
    at src/modules/input/fileExt/im_fileExt.c:976
...
#7  0x00000000004118da in nxlog_worker_thread (thd=0x22f1c08, data=<optimized out>)
    at src/core/nxlog.c:552
```

## 7 个 CU，拖垮了整个二进制

问题解决以后再回头看开头那个 `bt`，有个地方当时没注意：`nxlog_worker_thread` 在 `src/core/nxlog.c` 里，是我自己的代码，明明是按 v4 编的，可它的行号也没了。

出问题的只是 bzip2 那 7 个 CU，可 gdb 7.6 读到第一个不认识的 CU 头就报 `Dwarf Error`，然后把整个模块的 DWARF 信息全扔了。输出里那句 `(no debugging symbols found)` 说的是整个 `./collector`，不是 bzlib.c。

也就是说，静态链接的时候，调试信息能不能用，取决于最差的那一个编译单元。自己的代码写得再规矩也没用，只要哪个 `.a` 里混进一个老 gdb 不认识的 CU，整个二进制的调试信息就跟着陪葬，而且报错里不会告诉你是哪一个。所以只看第一个 CU 是 4 不够，得全量数一遍才算数。

## 出厂前就拦住它

core 是在客户那边出的，等发现调试信息没法用，现场往往早就没了。所以这个检查应该放进构建流水线，而不是等出了事再查：

```bash
# 二进制里不允许出现 DWARF 5 的编译单元
n=$(readelf --debug-dump=info ./collector 2>/dev/null | grep -c 'Version: *5')
[ "$n" -eq 0 ] || { echo "found $n DWARF5 CUs"; exit 1; }
```

真报了错，就用 `DW_AT_producer` 和 `DW_AT_comp_dir` 去找是哪个库、用什么参数编的。二进制自己把每个编译单元的编译命令都记着，比翻构建日志靠谱多了。

第三方依赖也别指望环境变量一定传得进去。`configure` 那一类会读，手写 Makefile 的就不好说了，对这类库，稳妥的做法是统一用 `make CC="$CC" CFLAGS="..."` 从命令行显式传。

DWARF Error 这个问题，网上很多资料说得都比较含糊，大多停在「gcc 和 gdb 版本不匹配，加 `-gdwarf-4`」这一步。这一步当然没错，可它只管得了你自己的代码。编译环境可以随便升级，客户机上的 gdb 是什么版本，是客户说了算。core 出在别人的机器上，能用的往往只有那台机器上原本就装着的工具，所以产物得按调试器能接受的最低版本来编，而且出厂前要把所有编译单元都过一遍，光看一个不够。

**相关**：[内存泄漏排查：为什么 valgrind 查不出内存池里的泄漏](/systems/agent/memory-leak-tool-blind-spots)
