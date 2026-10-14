---
title: Fluent Bit 源码笔记（三）：采集器怎么记住自己读到了哪里
---

# Fluent Bit 源码笔记（三）：采集器怎么记住自己读到了哪里

::: info Fluent Bit 源码笔记
读 `in_tail` 与引擎源码的四篇笔记。源码基线 v5.1.1，发布前复核至上游 master `a92d414c1`。

- （一）[背压与投递，先不伤害宿主](/systems/agent/fluent-bit-backpressure-delivery)　·　背压与投递
- （二）[百万个只写一次的文件](/systems/agent/fluent-bit-million-files)　·　规模天花板
- **（三）采集器怎么记住自己读到了哪里**　·　offset 存储
- （四）[读取边界上的数据丢失，GBK 日志丢了 27.4%](/systems/agent/fluent-bit-read-boundary)　·　编码与压缩
:::

采集器重启以后能接着读，靠的是一张 offset 表。这张表得回答两个问题：这条记录是哪个文件的，这是身份；这条记录归谁、什么时候能删，这是归属和生命周期。

Fluent Bit `in_tail` 的 SQLite offset 表，在这两个问题上各有一个漏洞。身份只用了 inode，跨挂载点会撞；多个 input 共用一个库的时候，会互相删对方的记录。两个都不报错，表现都是重启以后有些文件读错了位置。第二个漏洞上游两年前就有人报过，被 stale 机器人关了，现在有一个在途的修复 PR，修的方向跟我一开始想的正好相反。

源码基线 v5.1.1（`a31cf11a2`），发布前在上游 master `a92d414c1`（2026-10-09）上复核过，下面涉及的代码都没变。判定标准和立场见[第一篇](/systems/agent/fluent-bit-backpressure-delivery)。

## inode 只在一个文件系统里唯一

`in_tail` 的 offset 表长这样（`plugins/in_tail/tail_sql.h`）：

```sql
CREATE TABLE IF NOT EXISTS in_tail_files (
    id, name, offset, inode, created, rotated,
    offset_marker, offset_marker_size
);

SELECT ... FROM in_tail_files WHERE inode=@inode ORDER BY id DESC;
```

只有 inode，没有设备号。可 inode 只在单个文件系统里唯一，两块盘上的文件完全可以是同一个 inode 号。

举个用户根本绕不开的场景。一台宿主机上跑多个 MySQL 容器，每个实例挂一块独立的盘：

```
/var/inst-a/mysql-slow.log     dev=8:17   inode=11
/var/inst-b/mysql-slow.log     dev=8:33   inode=11    ← 不同的盘，同一个 inode
```

新建的 ext4、xfs 上，第一批文件的 inode 号是高度可预测的，多个实例同构部署，撞上是必然的。用户在配置上也没有办法躲：按实例拆采集任务不行，中间那段路径是容器 ID，动态生成的，下发配置的时候还不知道；把 glob 写得更精确也不行，`/var/*/mysql-slow.log` 已经是最精确的写法了；不配 DB 更不行，慢日志重复采集会把分析结果搞脏。

有意思的是，`in_tail` 的内存层是对的。它在内存里索引文件用的 key 是 `设备号:inode`（`tail_file.c` 的 `stat_to_hash_key()`），结构体里也专门有个 `dev_id` 字段。所以运行期间两个文件各采各的，互不干扰。

问题出在重启。恢复 offset 走的是 `WHERE inode=@inode`，两个文件查到的是同一条记录：

| 情况 | 结果 |
|---|---|
| 记录的 offset 小于本文件大小 | 从错误的位置开始读，中间的日志静默丢失 |
| 记录的 offset 大于本文件大小 | 触发保护，从 0 开始重读，数据重复 |
| 两个文件轮流写回 offset | offset 持续乱跳 |

上游今年 4 月加过一个内容指纹（`offset_marker`，`22f8800ff`），重启时校验 offset 前面的一小段内容，对不上就不信这个位置。它能挡住一部分，但只是把读错位置降成了重复采集，算不上正确采集；而且慢日志这种格式高度一致的文件，指纹撞上的概率并不低。

同一个模块里，内存层和持久层用了两套文件身份。设计者不是没想到，内存层就说明他们清楚 inode 不够用。更像是持久层的表结构落在了内存实现后面：DB 是早期的功能，`dev_id` 是后来才补的。

修起来就是给表加一个 `dev` 列，查询条件改成 `inode=@inode AND dev=@dev`。在线迁移的套路代码里现成就有，`offset_marker` 那两列就是这么加的；老库里 `dev=0` 的记录，可以当未知设备兼容匹配一次，再写回真实的设备号。顺带说一句，`inode` 列上现在既没有唯一约束也没有索引，`WHERE inode=@inode` 是全表扫描，可以一起建一个 `(dev, inode)` 的复合索引。

### Windows 上设备号永远是 0

```c
static uint64_t stat_get_st_dev(struct stat *st)
{
#ifdef FLB_SYSTEM_WINDOWS
    /* do you want to contribute with a way to extract volume serial number ? */
    return 0;
#else
    return st->st_dev;
#endif
}
```

注释自己就在征集这个功能。数据其实早就在手边了：`plugins/in_tail/win32/stat.c` 里已经在调 `GetFileInformationByHandle` 取文件索引当 inode，同一个结构体里的卷序列号 `dwVolumeSerialNumber` 却没拿来用。APR 的 `APR_FINFO_IDENT` 就是这么干的，卷序列号当设备号，文件索引当 inode。

移植的时候有两个 APR 也踩过的坑。ReFS 上 64 位的文件索引不够用，应该优先用 `GetFileInformationByHandleEx(FileIdInfo)` 拿 128 位的 ID；SMB 网络路径上卷序列号可能是 0，或者不稳定，这时候要退回现在的行为，而不是拒绝采集。

这两处的关系是：只修 Windows 不修表结构，Linux 上照样撞；只修表结构不修 Windows，Windows 上维持现状，但也不会更糟。所以表结构是主要矛盾，可以单独先修。这方面上游我目前没查到有人报过。

## 多个 input 共用一个库，互相删记录

先说为什么会共用。`in_tail` 的配置项全是 input 实例级的，没有按路径的粒度。字符编码不一样（A 系统 UTF-8，B 系统 GBK，对应 `generic.encoding` / `unicode.encoding`），轮转方式不一样（`Rotate_Wait`、`Refresh_Interval`），多行合并规则不一样（`multiline.parser`、`Parser`），都只能拆成多个 `[INPUT]` 段。所以单节点上跑好几个 tail input 是常态。而拆段最常见的做法，是复制一份配置模板，改了 `Path`，忘了改 `DB`，批量下发的时候这几乎是必然的。

`flb_sqldb_open()`（`src/flb_sqldb.c`）打开数据库之前，会遍历全局已经打开的库，主动去比对路径：

```c
if (strcmp(db_temp->path, path) == 0) {
    ...
}
if (db_temp) {                         /* 找到同路径的库 → 共享，不报错 */
    db_temp->users++;
    db->handler = db_temp->handler;    /* 共用同一个 sqlite3 连接 */
    db->shared  = FLB_TRUE;
}
```

它是能发现的，只是发现了以后选择了共享。共用同一个连接，连 SQLite 的文件锁冲突都不会有，「database is locked」这种间接线索都看不到。

可 offset 表里没有任何一列标识这条记录是哪个 input 实例的。启动的时候，每个 input 各自做一次陈旧记录清理：

```sql
DELETE FROM in_tail_files
WHERE inode NOT IN (SELECT inode FROM in_tail_current_inodes);
```

`in_tail_current_inodes` 里只装了当前这个 input 扫到的 inode。于是 input A 启动的时候，会把 input B 的记录全当成陈旧记录删掉。更狠的是，某个 input 的 glob 一个文件都没匹配上的时候（`tail_db.c`）：

```c
/* If there are no monitored files, delete everything from the DB table. */
if (file_count == 0) {
    flb_sqldb_query(ctx->db, "DELETE FROM in_tail_files;", NULL, NULL);
}
```

整张表无条件清空。全程没有 error，也没有 warn，表现出来就是重启以后，有些路径从文件头（或者文件尾，看 `Read_From_Head`）重新读起。

这个问题在上游有完整的来龙去脉。3.0.2 的 PR [#8062](https://github.com/fluent/fluent-bit/pull/8062) 引入了启动时清理不再监控的记录，问题就是从这开始的。2024 年 6 月有人报了 [#8928](https://github.com/fluent/fluent-bit/issues/8928)「Tail plugin incorrectly removing entries from the database file during startup」，复现配置跟我这里写的几乎一样，后来陆续有用户确认碰到了，其中一位说文档里并没讲清楚多个 input 共用一个库到底支不支持。2025 年 5 月，它被 stale 机器人关了，关了以后还有用户留言说在碰到。2026 年 8 月，PR [#12242](https://github.com/fluent/fluent-bit/pull/12242)「make stale database cleanup safe for shared databases」出来了，标着 `Fixes #8928`，我写这篇的时候还没合进去。

### 两种修法，方向相反

我读源码时想到的修法是拒绝。`flb_sqldb_open()` 的调用方都把插件名传进来了，信息是现成的：不同插件共享一个库文件，可疑，但放行；同一种插件的两个实例共享一个库，几乎肯定是复制模板时的笔误，直接报错，拒绝启动。

PR #12242 选的是支持。清理不再按「当前 input 扫到了哪些文件」来做，而是整个库只做一次，一条条拿记录里的路径和 inode 去文件系统上核对，路径不在了，或者 inode 变了，才删；核对出错就保留。它还顺手删掉了一个文件都没匹配到就清空整张表的那个分支。

两个方向都能把这个 bug 消掉，代价不一样：

| | 拒绝共享 | 让共享变安全（#12242） |
|---|---|---|
| 对已有配置 | 不兼容：已经在共享的用户升级后起不来 | 兼容 |
| 对「复制模板忘改 DB」 | 启动时就暴露出来 | 静默地变成了合法用法 |
| 陈旧记录的判定 | 不变 | 更可靠：看文件系统，不看「我这次扫到了什么」 |

我现在觉得 #12242 的方向更好。拒绝共享，会让一批原来能跑的配置升级以后起不来；而「我这次扫到了什么」本来就不该拿来判断一条记录是不是陈旧的，换成去文件系统上核对，单 input 的场景也跟着受益。

不过要注意，#12242 没碰上一节说的身份问题，查询还是 `WHERE inode=@inode`。共享同一个库，意味着更多来自不同路径、不同挂载点的文件挤在同一张只认 inode 的表里，撞上的概率只会更高。所以就算它合进去了，我还是建议每个 input 用自己的库。

## 默认根本不记

前面两节的前提是配了 `DB`。可 `DB` 默认是不配的，`plugins/in_tail/tail.c` 的配置表里，`db` 的默认值是 `NULL`。

不配的话，offset 只在内存里。进程重启以后，新发现的文件直接 `lseek(fd, 0, SEEK_END)`，从文件末尾开始读，停机期间写进来的日志全丢了，什么提示都没有。

这一条我算作健壮性上的缺口，不算缺陷，因为有个站得住的反对理由：在容器里，默认写一个 DB 反而有害，容器的文件系统是临时的，重启就没了，默认值只会给人一种虚假的安全感。所以默认关着，可能是有意为之。

可要是真要加默认值，默认路径拿什么当基准就很关键了。不能用工作目录，systemd 拉起来的时候 cwd 是 `/`，手工启动又随目录变，重启以后 DB 路径一漂，比不配还糟。也不能用配置段的序号，配置文件中间插一段，后面所有 input 的序号都跟着漂，DB 全部错位。合理的形式是 `<状态目录>/tail/<别名 或 hash(路径)>.db`。

而这些东西项目里其实都有，只是没接上。全局状态目录 `storage.path`，filesystem 模式的 chunk 在用；input 实例的稳定别名 `alias` 也有；`in_tail` 一个都没用上。这更像是历史遗留，`in_tail` 的 DB 比 `storage.path` 出现得早。

## 托管平台该怎么起名

如果你在做托管 Fluent Bit 的采集平台，DB 路径我建议由平台来生成，别暴露给使用者：

```
<状态目录>/tail_db/<任务 ID>_<hash(路径)>.db
```

这三样一个都不能少。状态目录不能是工作目录，得跟采集器的生命周期绑在一起；任务 ID 把任务隔开，上一节那个互删的问题从根上就不会出现；路径哈希把同一个任务里的多条路径隔开，增删一条路径，其他路径的 DB 不受影响，这也正是不能用序号的原因。

任务一多，还有几件事得平台来管。任务删了，DB 文件不会自己消失，得按当前的任务列表比对着清理，`-wal` 和 `-shm` 要一起删。每个 DB 是一个常驻连接，一个 DB fd、一个 WAL fd、一段 shm 映射，再加上每个被采集的文件一个 fd，几十个任务下来就可能撞上 `ulimit -n`。上百个 DB 文件也别平铺在一个目录里，分分层。还有，父目录要提前建好，`flb_sqldb_open()` 只调 `sqlite3_open()`，不会建目录，目录不存在就直接启动失败，报错只有一句「cannot open database」，不会告诉你是目录的问题。

## 我们自己也选错过身份

公平起见，身份选错的代价，我们自己的采集器上也有过。[上一篇](/systems/agent/fluent-bit-million-files)写过，我们给已过期文件打的持久化标记，key 是文件路径，不是 `设备号:inode`。同一个路径的文件被删了重建，会撞上旧标记，被误跳过。在那一处，Fluent Bit 反倒做对了，它扫描时会比对 inode，对不上就清掉旧记录。

两边的问题刚好是镜像的。Fluent Bit 的持久层只认 inode，丢了设备号和路径；我们的过期标记只认路径，丢了 inode。在单机上，文件的身份至少得是 `设备号 + inode` 才唯一，再加上路径，才能认出同一个位置换了一个文件。少了哪一样，都会在某个场景下认错。

## 上游现在的状态

截至 2026-10-12，上游 master `a92d414c1`：

| 问题 | 代码状态 | 上游动态 |
|---|---|---|
| 持久层只用 inode，跨挂载点碰撞 | 未变 | 未见报告 |
| Windows 上设备号恒为 0 | 未变 | 代码注释在征集贡献 |
| 多个 input 共用一个库时互删记录 | 未变 | [#8928](https://github.com/fluent/fluent-bit/issues/8928)（2024-06 报告，stale 关闭）；[#12242](https://github.com/fluent/fluent-bit/pull/12242)（在途修复） |
| `DB` 默认不配，重启从文件尾开始 | 未变 | 无 |

## 最后

用 Fluent Bit 的话，**每个 tail input 一个自己的 DB 文件**，#12242 合进去以后也照样这么配。多挂载点、同构部署的机器上，inode 碰撞是迟早的事，运行时一切正常，到了重启那一下才出错，很难第一时间想到是 offset 表的问题。

---

**相关**：[采集器工程](/systems/agent/)
