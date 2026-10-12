---
title: 同一个 rpm 包、同一个 systemd 219，一台起得来一台起不来
---

# 同一个 rpm 包、同一个 systemd 219，一台起得来一台起不来

> rpm 装 ClickHouse 26.3，一台机器启动失败，`status=218/CAPABILITIES`。另一台机器装的是同一个包、同样的配置、同一个 systemd 219，一切正常。两台都是 Linux 3.10。
>
> 删掉 unit 里两行 capability 配置，服务马上就起来了。但这只是让服务恢复，还有三个问题没回答：**为什么失败**，**为什么老版本没事**，**删掉之后少了什么**。
>
> 这篇的结论放在前面：**发行版内核和 systemd 都大量 backport，主版本号不能代表实际的功能集。** 判断依据只能是运行时探测出来的结果。

## 一、现场

```
Failed at step CAPABILITIES spawning /usr/bin/clickhouse-server: Invalid argument
clickhouse-server.service: main process exited, code=exited, status=218/CAPABILITIES
```

| | 失败 | 正常 |
|---|---|---|
| 内核 | `3.10.0-123.el7` | `3.10.0-1160.119.1.el7` |
| systemd | 219 | 219 |
| ClickHouse | 26.3（rpm） | 26.3（rpm） |

手工试出来的规避办法是删掉这两行：

```ini
CapabilityBoundingSet=CAP_NET_ADMIN CAP_IPC_LOCK CAP_SYS_NICE CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_IPC_LOCK CAP_SYS_NICE CAP_NET_BIND_SERVICE
```

## 二、只有一行是罪魁

两行依赖的内核能力并不一样：

| 指令 | 内核侧 | systemd 侧 |
|---|---|---|
| `CapabilityBoundingSet=` | bounding set，Linux 2.6.25（2008）起 | 很早就支持 |
| `AmbientCapabilities=` | `prctl(PR_CAP_AMBIENT, ...)`，**Linux 4.3**（2015-11）起 | 上游 **v229**（2016-02），[PR #2265](https://github.com/systemd/systemd/pull/2265) |

内核没有 `PR_CAP_AMBIENT` 时，systemd 调这个 `prctl` 拿到 `EINVAL`，原样报出来 —— 就是那句 `Invalid argument`。**只需要清空 `AmbientCapabilities=`，bounding set 不用动。**

这里有一个很好用的判别信号，能区分两种完全不同的故障：

| 症状 | 含义 | 后果 |
|---|---|---|
| `Unknown lvalue 'AmbientCapabilities' in section 'Service'` | **systemd** 不认识这个指令 | 记一条 warning，忽略，照常启动 |
| `Failed at step CAPABILITIES ... Invalid argument` | systemd 认识，**内核**不支持 | 启动失败，`218/CAPABILITIES` |

这次是第二种。**报错的是 systemd，缺的却是内核。**

## 三、同样是 3.10，功能集不一样

两台都是 3.10、都是 systemd 219 —— 如果按上游版本号推理，两台都不该支持 ambient capabilities（内核 < 4.3，systemd < 229），也就不该有任何一台起得来。

实际情况是 Red Hat 在 RHEL 7 的生命周期里持续回填新特性。**从 RHEL 7.3（`3.10.0-514.el7`）起，内核带上了这个上游 4.3 才有的能力**；systemd 219 同样打了大量 backport，认识这个指令。

`3.10.0-123.el7` 是 RHEL / CentOS **7.0** 的 GA 内核，早于 514，没有这项 backport。`1160` 是 7.9，有。

| 发行版 | systemd | 内核 | ambient capabilities |
|---|---|---|---|
| CentOS / RHEL 7.0–7.2 | 208 / 219 | `3.10.0-<514` | ❌ 内核缺 |
| CentOS / RHEL 7.3+ | 219（backport） | `3.10.0-514+` | ✅ |
| RHEL / CentOS 8+ | 239+ | 4.18+ | ✅ |
| Ubuntu 16.04+ | 229+ | 4.4+ | ✅ |
| Debian 9+ | 232+ | 4.9+ | ✅ |
| 自编译 / 定制 3.10.y | 任意 | 上游 3.10 | ❌ |

所以判断方法是：**不看 `uname -r`，看内核实际暴露了什么。**

```bash
grep CapAmb /proc/self/status
# 有这一行 → 内核支持 ambient capabilities（值是不是 0 无所谓）
# 没有     → 不支持

systemctl show clickhouse-server -p AmbientCapabilities
# 能返回这个属性 → 当前 systemd 认识这个指令
```

::: tip
和[内核栏那篇 jbd 死锁](/systems/kernel/ext3-jbd-memcg-oom-deadlock)是同一类问题，只是方向相反：
那次是发行版**移植补丁时引入了缺陷**，这次是发行版**某个版本之前没移植**。

两次都说明一件事：**在 RHEL 系上，`3.10` 这个数字几乎不携带功能信息。**
:::

## 四、为什么老版本 ClickHouse 没事

看 `packages/clickhouse-server.service` 的 git 历史：

| 时间 | commit | 变更 |
|---|---|---|
| 2018-05-17 | `bd4d8a6766e` | 首次出现 `CapabilityBoundingSet=CAP_NET_ADMIN` |
| 2022-02-08 | `342f7ba5671` | 迁到 nfpm，bounding set 扩到三项 |
| 2023-07-20 | [`1fe8076b942`](https://github.com/ClickHouse/ClickHouse/commit/1fe8076b942) | **加入 `AmbientCapabilities=`**，两边补上 `CAP_NET_BIND_SERVICE` |

最后这个 commit 首次进入 `v23.7.1.2470-stable`。**23.7 之前，这台 7.0 的机器装 ClickHouse 不会出问题；从 23.7 起就会。** changelog 里不会写「不再支持 RHEL 7.0–7.2」，因为官方也没有意识到这个后果。

加这一行并不是多余的。提交说明里解释了动机：

> `CapabilityBoundingSet` that contained in systemd unit before is about **allowing** to set some capabilities, not about **granting** them. To grant them you need to use `AmbientCapabilities`.

ClickHouse 跑在 `User=clickhouse` 下。**bounding set 是上限，不是授予**：对 root 进程，它限制可用的能力范围；对非 root 进程，它不会给进程任何能力。也就是说，**2018 到 2023 年间 unit 里列出的那几个能力，从来没有真正授予过 ClickHouse 进程。**

`AmbientCapabilities=` 让非 root 服务在 `execve` 之后仍然保留指定的能力。内核要求 ambient 里的能力同时在 permitted 和 inheritable 里，bounding set 也必须允许 —— 两行不要求完全一致，bounding set 可以更宽。

所以 `1fe8076b942` 修的是一个真问题，**代价是引入了一个对内核接口的硬依赖**。

## 五、删掉之后少了什么

按 26.3 的代码和默认配置逐项看：

| 能力 | 代码落点 | 用途 | 没有会怎样 |
|---|---|---|---|
| `CAP_SYS_NICE` | `src/Common/OSThreadNiceValue.cpp`、`programs/server/Server.cpp` | 负 nice 值、部分 IO priority | 相关优先级设置不生效，可能记一条提示日志 |
| `CAP_IPC_LOCK` | `programs/server/Server.cpp` | `mlock_executable`，把代码段锁进物理内存 | 启用该设置时锁不住；默认值是 `false` |
| `CAP_NET_BIND_SERVICE` | 内核端口权限检查 | 非 root 绑定 1024 以下端口 | 绑定低端口失败；默认的 8123 / 9000 / 9440 不受影响 |
| `CAP_NET_ADMIN` | —— | 曾用于 netlink taskstats | 26.3 上已无用途，见下 |

### `CAP_NET_ADMIN` 在 26.3 上已经没用了

它原本的用途是通过 **netlink taskstats** 采集线程级 OS 指标，喂给 ProfileEvents 里的 `OSIOWaitMicroseconds`（真实 IO 等待，不含 page cache）、`OSCPUWaitMicroseconds`（就绪但没被调度的时间）、`OSReadChars` 等。没有它就降级到 `ProcfsMetricsProvider`，改读 `/proc/<tid>/{stat,io}`。

2026-02-28 的 [`b503accc7f9`](https://github.com/ClickHouse/ClickHouse/commit/b503accc7f9)（*Remove NetlinkMetricsProvider, use procfs exclusively for taskstats*）删掉了 netlink 这条路径。26.3 的源码树里已经没有 `NetlinkMetricsProvider`，选择逻辑只剩两种结果：

```cpp
if (ProcfsMetricsProvider::isAvailable())
    return MetricsProvider::Procfs;
return MetricsProvider::None;
```

26.3 上 `hasLinuxCapability()` 的全部调用方：

```
src/Common/OSThreadNiceValue.cpp     → CAP_SYS_NICE
programs/server/Server.cpp           → CAP_IPC_LOCK  (mlock)
programs/server/Server.cpp           → CAP_SYS_NICE  (启动提示)
src/Common/ThreadProfileEvents.cpp   → CAP_SYS_ADMIN (perf events)
```

没有 `CAP_NET_ADMIN`。最后一项 `CAP_SYS_ADMIN` 反而不在 unit 的列表里 —— **unit 里的能力清单停在 2023 年的实现上，代码后来变了，打包配置没跟上。**

**结论**：在 26.3 上，只要用的是默认端口、没开 `mlock_executable`、没配依赖 `CAP_SYS_NICE` 的线程或 IO 优先级功能，清空 `AmbientCapabilities=` 不影响基本服务。用了这些配置的，就不能把它们当成「可选优化」，要么升内核，要么另想办法授予最小能力集。

## 六、为什么 clickhouse-keeper 没事

同一台机器上的 keeper 正常启动。它的 unit 里只有 bounding set，没有 `AmbientCapabilities=`；git 历史只有 2023-01 的新增和 2023-03 的一次注释修复。**2023-07 改 server 时没同步改 keeper**，从提交记录看不出是有意还是遗漏。

逐项对照 keeper 的代码：

| 能力 | keeper 的情况 |
|---|---|
| `CAP_IPC_LOCK` | `mlock_executable` 属于 `ServerSettings`，keeper 用的 `CoordinationSettings` 里没有对应项 |
| `CAP_SYS_NICE` | `os_thread_priority` 同属 server 侧，`CoordinationSettings` 里没有 nice / priority 项 |
| `CAP_NET_BIND_SERVICE` | 默认端口 9181 / 9234，都在 1024 以上 |
| `CAP_NET_ADMIN` | 走通用 taskstats 路径，26.3 上已是 procfs |

所以**不应该为了和 server 保持形式一致，给 keeper 也加上 `AmbientCapabilities=`**：目前没有需要它的功能，加了反而会让 keeper 在同样的老内核上起不来。这个判断基于对已知代码路径的检查，不能排除所有间接依赖；以后 keeper 真要绑低端口或加 mlock，再按需配置最小能力集。

## 七、修复：drop-in，不改 vendor unit

`/usr/lib/systemd/system/clickhouse-server.service` 会被 rpm 升级覆盖，改了也会丢。用 drop-in：

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

systemd 对列表型指令的空赋值表示重置。这个 drop-in 只清空 ambient，保留 bounding set，而且不会被软件包升级覆盖。

ckman 在 RPM / DEB 部署的安装、升级、启动、重启阶段都会做同样的运行时探测：

```bash
grep -q '^CapAmb:' /proc/self/status || <下发上面的 drop-in>
```

缺 `CapAmb` 时创建 `clickhouse-server.service.d/ckman-no-ambient-capabilities.conf`；内核支持时**删掉这个由 ckman 管理的 drop-in**。这样老内核节点不会出 `218/CAPABILITIES`，节点升级内核后也能自动恢复官方 unit 的能力配置 —— 规避措施不会比需要它的条件活得更久。

## 留给读者的

1. **`218/CAPABILITIES` + `Invalid argument` 是内核缺能力，不是 systemd 不认识指令** —— 后者只是 warning
2. **RHEL 系上不要用版本号推断功能** —— 内核看 `/proc/self/status` 里有没有 `CapAmb`，systemd 看 `systemctl show -p`
3. **ClickHouse 23.7 起的官方 unit 不能在 RHEL / CentOS 7.0–7.2 上直接启动** —— changelog 里没写
4. **只清空 `AmbientCapabilities=`，不要连 bounding set 一起删**；用 drop-in，不改 vendor unit
5. **清空前先确认没用低端口、`mlock_executable` 和优先级功能** —— 用了就不是「可选优化」

---

**相关**：[信创与异构环境](/clickhouse/vendor/) · [ClickHouse `1fe8076b942`](https://github.com/ClickHouse/ClickHouse/commit/1fe8076b942) · [ClickHouse `b503accc7f9`](https://github.com/ClickHouse/ClickHouse/commit/b503accc7f9) · [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) · [systemd#5000](https://github.com/systemd/systemd/issues/5000) · [scylladb#3176](https://github.com/scylladb/scylladb/issues/3176)（同一条 3.10.0-514 分界线） · [capabilities(7)](https://man7.org/linux/man-pages/man7/capabilities.7.html)
