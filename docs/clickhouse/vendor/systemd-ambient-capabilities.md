---
title: systemd AmbientCapabilities：同一个 rpm，一台起得来一台起不来
---

# systemd AmbientCapabilities：同一个 rpm，一台起得来一台起不来

前段时间在一台机器上用 rpm 装 ClickHouse 26.3，启动时报了一个很诡异的错：

```
Failed at step CAPABILITIES spawning /usr/bin/clickhouse-server: Invalid argument
clickhouse-server.service: main process exited, code=exited, status=218/CAPABILITIES
```

诡异在于另一台机器上，同样的安装包、同样的配置文件、同样的 systemd 219，一切正常。两台的内核也都是 3.10：

| | 失败 | 正常 |
|---|---|---|
| 内核 | `3.10.0-123.el7` | `3.10.0-1160.119.1.el7` |
| systemd | 219 | 219 |
| ClickHouse | 26.3（rpm） | 26.3（rpm） |

规避办法倒是很直接，把 service 文件里这两行删掉，服务立刻就起来了：

```ini
CapabilityBoundingSet=CAP_NET_ADMIN CAP_IPC_LOCK CAP_SYS_NICE CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_IPC_LOCK CAP_SYS_NICE CAP_NET_BIND_SERVICE
```

可服务恢复了，事情还没完。为什么会失败？CAPABILITIES 这一步到底在干什么？删掉以后 ClickHouse 少了哪些能力？这几个问题不弄清楚，删配置心里是没底的。

## 真正出事的只有一行

这两行看着是一对，依赖的内核能力其实差了好几年：

| 指令 | 内核侧 | systemd 侧 |
|---|---|---|
| `CapabilityBoundingSet=` | bounding set，Linux 2.6.25（2008）起 | 很早就支持 |
| `AmbientCapabilities=` | `prctl(PR_CAP_AMBIENT, ...)`，Linux 4.3（2015-11）起 | 上游 v229（2016-02），[PR #2265](https://github.com/systemd/systemd/pull/2265) |

内核没有 `PR_CAP_AMBIENT` 的时候，systemd 调这个 `prctl` 会拿到 `EINVAL`，然后原样报出来，就是我们看到的那句 `Invalid argument`。所以只需要清空 `AmbientCapabilities=`，bounding set 根本不用动。

这里顺便能拿到一个挺好用的判别信号。如果是 systemd 自己不认识这个指令，日志里是 `Unknown lvalue 'AmbientCapabilities' in section 'Service'`，记一条 warning 就忽略过去了，服务照常启动。只有 systemd 认识、去调内核、内核又不支持的时候，才会报 `Failed at step CAPABILITIES ... Invalid argument`，以 `218/CAPABILITIES` 退出。我们碰到的是后一种。

## 都是 3.10，能力不一样

按上游版本号推，这事根本说不通。内核 3.10 小于 4.3，systemd 219 小于 229，两台都不该支持 ambient capabilities，那就不该有任何一台起得来才对。

问题出在 backport 上。Red Hat 在 RHEL 7 的整个生命周期里一直在往 3.10 上回填新特性，从 RHEL 7.3（`3.10.0-514.el7`）开始，内核就带上了这个上游 4.3 才有的能力。systemd 219 同样打了一堆 backport，认识这个指令。`3.10.0-123.el7` 是 RHEL / CentOS 7.0 的 GA 内核，比 514 早，没这项 backport；`1160` 是 7.9，有。

| 发行版 | systemd | 内核 | ambient capabilities |
|---|---|---|---|
| CentOS / RHEL 7.0–7.2 | 208 / 219 | `3.10.0-<514` | 不支持，内核缺 |
| CentOS / RHEL 7.3+ | 219（backport） | `3.10.0-514+` | 支持 |
| RHEL / CentOS 8+ | 239+ | 4.18+ | 支持 |
| Ubuntu 16.04+ | 229+ | 4.4+ | 支持 |
| Debian 9+ | 232+ | 4.9+ | 支持 |
| 自编译 / 定制 3.10.y | 任意 | 上游 3.10 | 不支持 |

所以别看 `uname -r`，直接看内核实际暴露了什么：

```bash
grep CapAmb /proc/self/status
# 有这一行 → 内核支持 ambient capabilities（值是不是 0 无所谓）
# 没有     → 不支持

systemctl show clickhouse-server -p AmbientCapabilities
# 能返回这个属性 → 当前 systemd 认识这个指令
```

这和内核栏那篇 [jbd 死锁](/systems/kernel/ext3-jbd-memcg-oom-deadlock)是一类事，方向反过来而已。那次是发行版移植补丁时带进了缺陷，这次是某个版本之前还没移植。

## 老版本的 ClickHouse 为什么没事

翻了一下 `packages/clickhouse-server.service` 的 git 历史：

| 时间 | commit | 变更 |
|---|---|---|
| 2018-05-17 | `bd4d8a6766e` | 首次出现 `CapabilityBoundingSet=CAP_NET_ADMIN` |
| 2022-02-08 | `342f7ba5671` | 迁到 nfpm，bounding set 扩到三项 |
| 2023-07-20 | [`1fe8076b942`](https://github.com/ClickHouse/ClickHouse/commit/1fe8076b942) | 加入 `AmbientCapabilities=`，两边补上 `CAP_NET_BIND_SERVICE` |

最后这个 commit 首次进的是 `v23.7.1.2470-stable`。也就是说，23.7 之前，这台 7.0 的机器装 ClickHouse 是没问题的，从 23.7 开始就起不来了。changelog 里不会写「不再支持 RHEL 7.0–7.2」，官方大概也没意识到会有这个后果。

那这一行是不是多余的？还真不是。作者 Azat Khuzhin 在提交说明里写了动机：

> `CapabilityBoundingSet` that contained in systemd unit before is about **allowing** to set some capabilities, not about **granting** them. To grant them you need to use `AmbientCapabilities`.
>
> ... Not a big deal, but still.

ClickHouse 是以 `User=clickhouse` 跑的。bounding set 只是个上限，对 root 进程它限制能用的能力范围，对非 root 进程它不会给你任何能力。换句话说，2018 到 2023 年之间 unit 里列的那几个能力，其实从来没真正授予过 ClickHouse 进程。

`AmbientCapabilities=` 才能让非 root 服务在 `execve` 之后还保留指定的能力。内核要求 ambient 里的能力同时出现在 permitted 和 inheritable 里，bounding set 也得放行，不过两行不要求一模一样，bounding set 可以更宽。

这么看，`1fe8076b942` 没改错，不加这一行，unit 里写的那几个能力等于白写。麻烦在于加了它以后，unit 就离不开内核的 `PR_CAP_AMBIENT` 了，514 之前的 RHEL 7 内核一碰就是 `218/CAPABILITIES`。

## 删掉以后少了什么

按 26.3 的代码和默认配置挨个看：

| 能力 | 代码落点 | 用途 | 没有会怎样 |
|---|---|---|---|
| `CAP_SYS_NICE` | `src/Common/OSThreadNiceValue.cpp`、`programs/server/Server.cpp` | 负 nice 值、部分 IO priority | 相关优先级设置不生效，可能记一条提示日志 |
| `CAP_IPC_LOCK` | `programs/server/Server.cpp` | `mlock_executable`，把代码段锁进物理内存 | 启用该设置时锁不住；默认值是 `false` |
| `CAP_NET_BIND_SERVICE` | 内核端口权限检查 | 非 root 绑定 1024 以下端口 | 绑定低端口失败；默认的 8123 / 9000 / 9440 不受影响 |
| `CAP_NET_ADMIN` | 无 | 曾用于 netlink taskstats | 26.3 上已经用不到了 |

`CAP_NET_ADMIN` 原本是用来走 netlink taskstats 采集线程级 OS 指标的，喂给 ProfileEvents 里的 `OSIOWaitMicroseconds`（真实 IO 等待，不含 page cache）、`OSCPUWaitMicroseconds`（就绪了但没被调度的时间）、`OSReadChars` 这些。没有它就降级成 `ProcfsMetricsProvider`，改读 `/proc/<tid>/{stat,io}`。

这是 23.7 那会儿的实现。2026-02-28 的 [`b503accc7f9`](https://github.com/ClickHouse/ClickHouse/commit/b503accc7f9)（*Remove NetlinkMetricsProvider, use procfs exclusively for taskstats*）把 netlink 这条路整个删了，26.3 的源码树里已经找不到 `NetlinkMetricsProvider`，选择逻辑只剩两种结果：

```cpp
if (ProcfsMetricsProvider::isAvailable())
    return MetricsProvider::Procfs;
return MetricsProvider::None;
```

再看 26.3 上 `hasLinuxCapability()` 的全部调用方：

```
src/Common/OSThreadNiceValue.cpp     → CAP_SYS_NICE
programs/server/Server.cpp           → CAP_IPC_LOCK  (mlock)
programs/server/Server.cpp           → CAP_SYS_NICE  (启动提示)
src/Common/ThreadProfileEvents.cpp   → CAP_SYS_ADMIN (perf events)
```

里面没有 `CAP_NET_ADMIN`。最后那个 `CAP_SYS_ADMIN` 倒是在用，可它又不在 unit 的列表里。unit 里那份能力清单停在了 2023 年，代码后来改了，打包配置没跟上。

所以在 26.3 上，只要用的是默认端口、没开 `mlock_executable`、也没配依赖 `CAP_SYS_NICE` 的线程或 IO 优先级，清空 `AmbientCapabilities=` 对基本服务没影响。要是用了这些配置，就别把它们当成可有可无的优化，要么升内核，要么另想办法把最小能力集授予进程。

## clickhouse-keeper 为什么没事

同一台机器上的 keeper 是正常启动的。打开它的 unit 一看，只有 bounding set，没有 `AmbientCapabilities=`。git 历史也只有两条，2023-01 新增，2023-03 修了一次注释。2023-07 改 server 的时候没顺手改 keeper，从提交记录上看不出是有意留着还是漏了。

那 keeper 要不要也补上？我对着 keeper 的代码挨个看了一遍。`mlock_executable` 属于 `ServerSettings`，keeper 用的是 `CoordinationSettings`，没有对应项；`os_thread_priority` 同样是 server 那边的，`CoordinationSettings` 里没有任何 nice 或 priority；默认端口 9181 和 9234 都在 1024 以上；taskstats 走的通用路径在 26.3 上已经是 procfs 了。

这四项 keeper 一个都用不上。为了跟 server 看起来一致就给它也加上 `AmbientCapabilities=`，什么也换不来，倒会让 keeper 在同样的老内核上也起不来。以后 keeper 真要绑低端口或者加 mlock，再按需配最小能力集就是了。

## 修法：用 drop-in，别改 vendor unit

`/usr/lib/systemd/system/clickhouse-server.service` 会被 rpm 升级覆盖，直接改了下次升级就没了。用 drop-in：

```bash
mkdir -p /etc/systemd/system/clickhouse-server.service.d
cat > /etc/systemd/system/clickhouse-server.service.d/no-ambient-caps.conf <<'EOF'
[Service]
# 本机内核无 PR_CAP_AMBIENT（上游 4.3+；RHEL 7.3 / 3.10.0-514 起 backport），
# 应用 ambient capabilities 时 prctl 返回 EINVAL，导致 218/CAPABILITIES。
# 空赋值即重置该指令；CapabilityBoundingSet 保留。
AmbientCapabilities=
EOF
systemctl daemon-reload && systemctl restart clickhouse-server
```

systemd 对列表型指令的空赋值就是重置。这个 drop-in 只清空 ambient，bounding set 留着，软件包升级也覆盖不到它。

ckman 在 RPM / DEB 部署的安装、升级、启动、重启几个阶段，都会做同样的运行时探测，逻辑等价于：

```bash
grep -q '^CapAmb:' /proc/self/status || <下发上面的 drop-in>
```

缺 `CapAmb` 就创建 `clickhouse-server.service.d/ckman-no-ambient-capabilities.conf`；内核支持的话，就把这个由 ckman 管的 drop-in 删掉。这样老内核节点不会再碰到 `218/CAPABILITIES`，哪天节点升级了内核，drop-in 会被删掉，官方 unit 的能力配置也就自动回来了。

回头看，这次就是被版本号骗了。两台机器 `uname -r` 都是 3.10，systemd 都是 219，按版本号看应该一模一样，实际上一台有这个能力一台没有。在 RHEL 系上排查这类问题，版本号只能当个参考，真正靠得住的是 `/proc/self/status`、systemd 属性，以及到底是哪一步失败的。

---

**相关**：[信创与异构环境](/clickhouse/vendor/) · [ClickHouse `1fe8076b942`](https://github.com/ClickHouse/ClickHouse/commit/1fe8076b942) · [ClickHouse `b503accc7f9`](https://github.com/ClickHouse/ClickHouse/commit/b503accc7f9) · [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) · [systemd#5000](https://github.com/systemd/systemd/issues/5000) · [scylladb#3176](https://github.com/scylladb/scylladb/issues/3176)（同一条 3.10.0-514 分界线） · [capabilities(7)](https://man7.org/linux/man-pages/man7/capabilities.7.html)
