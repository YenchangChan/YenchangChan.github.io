---
title: Fluent Bit 源码笔记（三）：采集器怎么记住自己读到了哪里
---

# Fluent Bit 源码笔记（三）：采集器怎么记住自己读到了哪里

> 采集器重启之后能接着读，靠的是一张 offset 表。这张表要回答两个问题：**这条记录是哪个文件的**（身份），以及 **这条记录属于谁、什么时候可以删**（归属与生命周期）。
>
> Fluent Bit `in_tail` 的 SQLite offset 表在这两个问题上各有一个漏洞：身份只用了 inode，跨挂载点会撞；多个 input 共用一个库时，会互相删掉对方的记录。两个漏洞都不报错，表现都是「重启之后，有些文件读错了位置」。
>
> 第二个漏洞上游两年前就有人报过，被 stale 机器人关掉；现在有一个在途的修复 PR，**修的方向和我最初建议的正好相反** —— 这一节值得单独看。

::: info Fluent Bit 源码笔记
读 `in_tail` 与引擎源码的四篇笔记。源码基线 v5.1.1，发布前复核至上游 master `a92d414c1`。

- （一）[先不伤害宿主，再谈不丢数据](/systems/agent/fluent-bit-backpressure-delivery)　·　背压与投递
- （二）[百万个只写一次的文件](/systems/agent/fluent-bit-million-files)　·　规模天花板
- **（三）采集器怎么记住自己读到了哪里**　·　offset 存储
- （四）[GBK 日志丢了 27.4%，读取边界上的数据丢失](/systems/agent/fluent-bit-read-boundary)　·　编码与压缩
:::

源码基线 v5.1.1（`a31cf11a2`），发布前在上游 master `a92d414c1`（2026-10-09）上复核过，下文涉及的代码均未改动。判定标准和立场见[第一篇](/systems/agent/fluent-bit-backpressure-delivery)。

---

## 一、身份：inode 只在一个文件系统里唯一

`in_tail` 的 offset 表长这样（`plugins/in_tail/tail_sql.h`）：

```sql
CREATE TABLE IF NOT EXISTS in_tail_files (
    id, name, offset, inode, created, rotated,
    offset_marker, offset_marker_size
);

SELECT ... FROM in_tail_files WHERE inode=@inode ORDER BY id DESC;
```

**只有 inode，没有设备号。** 而 inode 只在单个文件系统内唯一，两块盘上的文件完全可以有相同的 inode。

### 一个用户无法规避的场景

一台宿主机上跑多个 MySQL 容器，每个实例挂一块独立的盘：

```
/var/inst-a/mysql-slow.log     dev=8:17   inode=11
/var/inst-b/mysql-slow.log     dev=8:33   inode=11    ← 不同的盘，同一个 inode
```

新建的 ext4 / xfs 上，第一批文件的 inode 号高度可预测，多个实例同构部署时，**碰撞是必然的，不是偶然的**。

而用户在配置上没有任何办法绕开：

- 不能按实例拆采集任务 —— 中间那段路径是容器 ID，动态生成，下发配置时不知道
- 不能把 glob 写得更精确 —— `/var/*/mysql-slow.log` 已经是最精确的写法
- 不能不配 DB —— 慢日志重复采集会污染分析结果

### 运行时正常，重启后错乱

有意思的是，**`in_tail` 的内存层是对的**。它在内存里用来索引文件的 key 是 `设备号:inode`（`tail_file.c` 的 `stat_to_hash_key()`），结构体里也专门有一个 `dev_id` 字段。所以运行期间，两个文件各采各的，互不干扰。

问题出在重启：恢复 offset 时走的是 `WHERE inode=@inode`，两个文件查到的是**同一条记录**。

| 情况 | 结果 |
|---|---|
| 记录的 offset 小于本文件大小 | 从错误的位置开始读，中间的日志静默丢失 |
| 记录的 offset 大于本文件大小 | 触发保护，从 0 开始重读，数据重复 |
| 两个文件轮流写回 offset | offset 持续乱跳 |

上游今年 4 月加过一个内容指纹（`offset_marker`，`22f8800ff`）：重启时校验 offset 之前的一小段内容，对不上就不信任这个位置。它能挡住一部分 —— 但那是把「读错位置」降级成「重复采集」，不是「正确采集」；而且慢日志这种格式高度一致的文件，指纹撞上的概率并不低。

**同一个模块里，内存层和持久层用了两套文件身份。** 这不是设计者没想到 —— 内存层证明他们清楚 inode 不够 —— 而是持久层的表结构落后于内存实现：DB 是早期功能，`dev_id` 是后来补的。

修法是给表加一个 `dev` 列，查询条件改成 `inode=@inode AND dev=@dev`。在线迁移的套路代码里现成就有（`offset_marker` 两列就是这么加的）；老库里 `dev=0` 的记录可以当「未知设备」兼容匹配一次，再写回真实的设备号。顺带一提，`inode` 列上目前既没有唯一约束也没有索引，`WHERE inode=@inode` 是全表扫描，可以一起建一个 `(dev, inode)` 复合索引。

### Windows 上设备号恒为 0

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

注释本身就在征集这个功能。而数据其实早就在手边：`plugins/in_tail/win32/stat.c` 里已经在调 `GetFileInformationByHandle` 取文件索引当 inode，**同一个结构体里的卷序列号（`dwVolumeSerialNumber`）没有被取用**。APR 的 `APR_FINFO_IDENT` 就是这么做的：卷序列号当设备号，文件索引当 inode。

移植时有两个 APR 也踩过的坑：ReFS 上 64 位文件索引不够用，应该优先用 `GetFileInformationByHandleEx(FileIdInfo)` 拿 128 位 ID；SMB 网络路径上卷序列号可能是 0 或不稳定，这时要退化成现在的行为，而不是拒绝采集。

两个修法的关系：只修 Windows 不修表结构，Linux 上照样撞；只修表结构不修 Windows，Windows 上等于现状，但不会更糟。**表结构是主要矛盾，可以独立先行。**

上游目前没有查到这方面的报告。

## 二、归属：多个 input 共用一个库时互相删记录

### 为什么会共用

`in_tail` 的所有配置项都是 input 实例级的，没有任何按路径的粒度。所以下面这些差异，只能靠拆成多个 `[INPUT]` 段：

| 拆分理由 | 相关配置 |
|---|---|
| 字符编码不同（A 系统 UTF-8，B 系统 GBK） | `generic.encoding` / `unicode.encoding` |
| 轮转方式不同 | `Rotate_Wait`、`Refresh_Interval` |
| 多行合并规则不同 | `multiline.parser`、`Parser` |

单节点多个 tail input 是常态。而拆段最常见的做法是**复制配置模板，改 `Path`，忘了改 `DB`** —— 批量下发的场景里几乎必然发生。

### 共享连接，但表里没有归属

`flb_sqldb_open()`（`src/flb_sqldb.c`）打开数据库前，会遍历全局已打开的库，**主动比对路径**：

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

检测能力是有的，只是检测到之后选择了共享。共用同一个连接，连 SQLite 的文件锁冲突都不会发生 —— 「database is locked」这种间接线索都没有。

而 offset 表里**没有任何标识 input 实例的列**。启动时每个 input 各自做一次陈旧记录清理：

```sql
DELETE FROM in_tail_files
WHERE inode NOT IN (SELECT inode FROM in_tail_current_inodes);
```

`in_tail_current_inodes` 里只装了**当前这个 input** 扫到的 inode —— 于是 input A 启动时，会把 input B 的记录全当成陈旧记录删掉。更极端的是，某个 input 的 glob 一个文件都没匹配到时（`tail_db.c`）：

```c
/* If there are no monitored files, delete everything from the DB table. */
if (file_count == 0) {
    flb_sqldb_query(ctx->db, "DELETE FROM in_tail_files;", NULL, NULL);
}
```

**无条件清空整张表**。全程没有 error，也没有 warn。表现就是重启之后，部分路径从文件头（或文件尾，取决于 `Read_From_Head`）重新读起。

### 上游的历史

这个问题有完整的来龙去脉：

- **3.0.2**：PR [#8062](https://github.com/fluent/fluent-bit/pull/8062) 引入了「启动时清理不再监控的记录」，问题从这里开始
- **2024-06**：[#8928](https://github.com/fluent/fluent-bit/issues/8928)「Tail plugin incorrectly removing entries from the database file during startup」，复现配置和本文几乎一样。陆续有用户确认遇到同样的问题，其中一位说「文档里并没有说清楚多个 input 共用一个库到底支不支持」
- **2025-05**：被 stale 机器人关闭。关闭之后仍有用户留言说在遇到
- **2026-08**：PR [#12242](https://github.com/fluent/fluent-bit/pull/12242)「make stale database cleanup safe for shared databases」，`Fixes #8928`。写作时还没有合入

### 两种修法，方向相反

我读源码时给出的修法是**拒绝**：`flb_sqldb_open()` 的调用方都把插件名传进来了，信息是现成的 —— 不同插件共享同一个库文件，可疑但放行；**同一种插件的两个实例**共享同一个库，几乎必然是复制模板时的笔误，直接报错拒绝启动。

PR #12242 选的是**支持**：清理不再按「当前 input 扫到了哪些文件」来做，而是对整个库只做一次，逐条拿记录里的路径和 inode 去文件系统上核对 —— 路径不存在了、或者 inode 变了，才删；核对出错时保留。它同时删掉了「一个文件都没匹配到就清空整张表」那个分支。

两个方向都能消除这个 bug，代价不同：

| | 拒绝共享 | 让共享变安全（#12242） |
|---|---|---|
| 对已有配置 | 不兼容：已经在共享的用户升级后起不来 | 兼容 |
| 对「复制模板忘改 DB」 | 启动时就暴露出来 | 静默地变成了合法用法 |
| 陈旧记录的判定 | 不变 | 更可靠：看文件系统，不看「我这次扫到了什么」 |

我现在认为 #12242 的方向更好。拒绝共享会让一批原本能跑的配置在升级后起不来，而「我这次扫到了什么」本来就不是判断一条记录是否陈旧的正确依据 —— 换成去文件系统上核对，单 input 场景也受益。

但有一点要注意：**#12242 没有触及第一节的身份问题。** 查询仍然是 `WHERE inode=@inode`。共享同一个库，意味着更多来自不同路径、不同挂载点的文件挤在同一张只认 inode 的表里，第一节的碰撞概率只会更高。所以即便它合入了，**每个 input 用自己的库**仍然是更稳妥的做法。

## 三、默认不记

前两节的前提是配了 `DB`。而 `DB` 默认是不配的（`plugins/in_tail/tail.c` 的配置表里，`db` 的默认值是 `NULL`）。

不配的时候，offset 只在内存里。进程重启后，新发现的文件直接 `lseek(fd, 0, SEEK_END)` —— **从文件末尾开始读，停机期间写进来的日志全部丢失，没有任何提示。**

这一条我归为健壮性缺口，而不是缺陷，因为有一个站得住的反对理由：在容器里，默认写一个 DB 反而有害 —— 容器的文件系统是临时的，重启就没了，默认值只会给人虚假的安全感。所以「默认关闭」可能是有意的。

但如果要加默认值，**默认路径的基准选什么**很关键：

- **不能用工作目录**：systemd 拉起时 cwd 是 `/`，手工启动时随目录变化，重启后 DB 路径漂移，比不配更糟
- **不能用配置段的序号**：配置文件中间插一个新段，后面所有 input 的序号都会漂移，DB 全部错位
- 合理的形式是 `<状态目录>/tail/<别名 或 hash(路径)>.db`

而这些基础设施项目里**全都有，只是没接起来**：全局状态目录 `storage.path`（filesystem 模式的 chunk 在用）、input 实例的稳定别名 `alias`，`in_tail` 都没有用到。这更像历史遗留 —— `in_tail` 的 DB 比 `storage.path` 出现得早。

## 四、托管平台该怎么命名

如果你在做托管 Fluent Bit 的采集平台，DB 路径建议由平台生成，不暴露给使用者：

```
<状态目录>/tail_db/<任务 ID>_<hash(路径)>.db
```

三个要素缺一不可：

- **状态目录**：不能是工作目录，要和采集器的生命周期绑定
- **任务 ID**：隔离任务，第二节的问题从根上就不会出现
- **路径哈希**：隔离同一任务里的多条路径；增删一条路径时，其他路径的 DB 不受影响 —— 这正是不能用序号的原因

多任务是常态时，还有四件事要平台来管：

1. **孤儿清理**：任务删除后 DB 文件不会自己消失，要按当前任务列表比对清理，**连 `-wal` 和 `-shm` 一起删**
2. **文件句柄**：每个 DB 是一个常驻连接（一个 DB fd、一个 WAL fd、一段 shm 映射），加上每个被采集文件一个 fd，几十个任务就可能撞上 `ulimit -n`
3. **目录分层**：上百个 DB 文件不要平铺在一个目录里
4. **预先创建父目录**：`flb_sqldb_open()` 只调 `sqlite3_open()`，**不会创建目录**；目录不存在就直接启动失败，报错只有一句「cannot open database」，不会告诉你是目录的问题

## 五、我们自己也选错过身份

公平起见：身份选错的代价，我们自己的采集器上也出现过。[上一篇](/systems/agent/fluent-bit-million-files)第五节写过，我们给「已过期文件」打的持久化标记，key 是**文件路径**，不是 `设备号:inode`。同一路径的文件被删掉重建时，会命中旧标记被误跳过。

在那一处，Fluent Bit 反而做对了：它在扫描时比对 inode，不一致就清掉旧记录。

两边的问题是镜像的：**Fluent Bit 的持久层只认 inode，丢了设备和路径；我们的过期标记只认路径，丢了 inode。** 文件的身份至少要 `设备号 + inode` 才能在单机上唯一，再加上路径，才能识别「同一个位置换了一个文件」。少任何一个，都会在某个场景下认错。

## 上游状态汇总

截至 2026-10-12，上游 master `a92d414c1`：

| 问题 | 代码状态 | 上游动态 |
|---|---|---|
| 持久层只用 inode，跨挂载点碰撞 | 未变 | 未见报告 |
| Windows 上设备号恒为 0 | 未变 | 代码注释在征集贡献 |
| 多个 input 共用一个库时互删记录 | 未变 | [#8928](https://github.com/fluent/fluent-bit/issues/8928)（2024-06 报告，stale 关闭）；[#12242](https://github.com/fluent/fluent-bit/pull/12242)（在途修复） |
| `DB` 默认不配，重启从文件尾开始 | 未变 | —— |

## 留给读者的

1. **文件身份至少要 `设备号 + inode`**；要识别「同一位置换了文件」，还得加上路径
2. **Fluent Bit 的内存层用 `dev:inode`，持久层只用 inode** —— 运行时正常、重启后错乱，多挂载点部署必然触发
3. **每个 tail input 用自己的 DB 文件**，即便 #12242 合入之后也是如此
4. **陈旧记录的判断依据应该是文件系统，不是「我这次扫到了什么」** —— 这是 #12242 比「拒绝共享」更好的地方
5. **托管时由平台生成 DB 路径**：状态目录 + 任务 ID + 路径哈希，并负责孤儿清理和父目录创建

---

**相关**：[采集器工程](/systems/agent/)
