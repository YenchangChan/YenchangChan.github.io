---
title: S3 不可达时起不来：metadata 明明在本地，它却说 S3 上找不到
---

# S3 不可达时起不来：metadata 明明在本地，它却说 S3 上找不到

有一个百 TB 规模的 ClickHouse 集群，版本 22.8，用 S3 Disk 做冷热分层。某天出了这么一次事故。

ClickHouse 把 S3 的 IO 打爆了，影响到了同一个账号下的其他业务。S3 的维护团队为了止血，直接把 ClickHouse 用的 access key 给停了。几个小时后 ClickHouse 节点例行重启，连不上 S3，server 启动卡住了。

运维当时的救命操作是这样的：把配置里的 S3 endpoint 故意改错，指向一个不存在的域名，同时打开 `skip_access_check=true`。server 居然就起来了。然后把 S3 disk 上的表 `DETACH` 掉，等 access key 重新启用，改回正确的配置，重启，再 `ATTACH` 回来。

这一套在 22.8 上好使得很。

可等这个集群升到 23.3，再碰上类似的情况，同样的操作就不灵了。同样是改错 endpoint 加 `skip_access_check`，server 还是起不来，报错说 S3 上的 metadata 找不到。

这就怪了，`metadata_path` 明明配在本地，ClickHouse 怎么说 S3 上找不到 metadata？

## 启动的时候 ClickHouse 在干嘛

要弄清楚一个参数为什么失效，得先知道 ClickHouse 启动时都做了些什么。大致是这么几步：先加载 `config.xml`，里面有 disks、policies、users；然后创建 disk，对每个 disk 做 access check，也就是写一个测试文件再删掉，确认可写，`skip_access_check` 管的就是这一步；接着扫 `/var/lib/clickhouse/metadata/` 目录加载 database，对每张表执行 `ATTACH TABLE`；再往下是 attach part，要读 part 的自描述文件，其中就包括 S3 上的 `checksums.txt` 这些；之后是 `ReplicatedMergeTree` 跟 ZK 的副本协调；最后监听端口，对外提供服务。

哪一步失败都可能让启动卡住。`skip_access_check` 管的是创建 disk 时的那个检查，可生产上真正卡住的，多半是后面 attach part 那一步。后面所有的困惑，都出在这两步没对上。

## metadata 有两层

ClickHouse 的 metadata 其实有两层，很多人排查时把这两层混在一起，方向一开始就错了。

第一层是 disk 级的，就在本地 `<metadata_path>` 配的那个目录里，存的是逻辑文件名到 S3 object key 的映射。每个本地文件其实只是个占位，内容就几行文本，大致是这样：

```
3
1   1234   xxx/yyy/zzzobj1
```

意思是这个文件 1234 字节，在 S3 上的 object key 是 `xxx/yyy/zzzobj1`。读这个本地文件，是不需要访问 S3 的。

第二层是 part 级的。每个 part 都有几个描述自己的文件：`columns.txt` 是列定义，`checksums.txt` 是每个文件的校验和，`count.txt` 是行数，`primary.idx` 是主键索引，`partition.dat` 是分区信息，还有 `minmax_*.idx` 和 `default_compression_codec.txt`。这些文件是放在 S3 上的，本地那一层只存了指向它们的指针。attach part 的时候，必须把它们 GET 下来，才能校验 part 是不是完整。

所以那句「S3 上的 metadata 找不到」，说的是第二层，是某个 part 的 `checksums.txt` 之类的文件 GET 失败了。本地那一层好好的，只是它指向的 S3 对象够不着。所以这个报错很容易把人往 `<metadata_path>` 的配置上带，其实跟那儿没关系。

## skip_access_check 怎么一步步不灵的

22.x 的时候，ClickHouse 的 disk 抽象比较扁平，一个 `IDisk` 接口，每种 disk 自己实现，`S3Disk` 是个比较独立的实现。

`skip_access_check` 设计上只是跳过 access check 这一步。它在 22.x 上能救场，按我的理解是沾了副作用的光：endpoint 不可达，S3 client 创建失败，这个 disk 就被标成 broken；broken disk 上的 part 走的是延迟 attach，被推后处理；延迟 attach 不会马上去读 S3 上的那些 part 文件，attach part 那一步就被悄悄跳过了，启动得以继续。参数本来不是为这个设计的，只是那时候对 broken disk 的处理比较宽松，它就阴差阳错成了一个 S3 不可达时的救命开关。

改错 endpoint 的偏方就是借的这个劲。把 endpoint 改成一个不存在的域名，比如 `https://nonexistent.invalid/`，DNS 解析失败，S3 client 初始化失败，access check 必然失败；有 `skip_access_check=true`，这一步被跳过；disk 进入 broken 状态，上面所有的 part 都走延迟 attach，server 就起来了。这时候表是 broken 的，`DETACH` 是合法操作。等 S3 好了，改回正确的 endpoint，重启，再 `ATTACH`，一切照常。这个流程在 22.x 上严丝合缝，运维圈里传得很广。

从 23.x 开始，ClickHouse 的远端存储逐步引入了 `IObjectStorage` 这些抽象，把 disk 拆成了更清楚的两层：逻辑上的 disk 是 `DiskObjectStorage`，底下的物理存储是 `S3ObjectStorage`、`AzureObjectStorage`、`LocalObjectStorage` 这些。

从生产上的表现看，变化有三点。`skip_access_check` 基本就只管启动时的读写探测了，不再稳定地带出 disk broken 以后跳过 attach 的副作用。attach part 更严格了，启动时更容易在校验 active part 的阶段真的去访问 S3 上那些 part 文件。出错的时候也更保守了，远端对象够不着、不存在或者没权限，更倾向于直接报错，而不是把相关的表悄悄往后放。

于是同一套操作在 23.x 上就变成了：endpoint 错，S3 client 初始化失败，access check 失败；`skip_access_check=true` 把这一步跳过了，没问题；可接下来进了 attach part，ClickHouse 顺着本地那层 metadata 去找 S3 对象，S3 不可达，GET `checksums.txt` 失败，抛出 metadata not found，启动失败。

`skip_access_check` 在 23.x 上还是有效的，只是它管不到 attach part 那一步。22.x 上那个误打误撞的副作用，不能再写进生产的应急手册里了。

再往后，ClickHouse 在故障处理上把机制慢慢补齐了，`skip_access_check` 也就越来越边缘。23.11 加了 `async_load_databases`，表在后台异步加载，某张表加载失败，只是查这张表时报错，不会把整个 server 卡住；24.6 起它在默认配置里就是打开的，25.2 起哪怕配置文件没更新也默认开启。失败的表、detached 的 part、启动日志，定位入口也比以前清楚了。S3 相关的限速、重试、连接池参数也更细了，能从源头上少挨对象存储那边的限流和封禁。现在 `skip_access_check` 还在，但作用回到了它本来的意思，就是跳过启动时写测试文件那一下，已经没什么人靠它救场了。

按版本排一下：

| 版本 | `skip_access_check` 的实际效果 | 改错 endpoint 偏方 |
|---|---|:--:|
| 22.x | 跳过 access check，副作用让 disk 进入延迟 attach | 有效 |
| 23.0 ~ 23.10 | 只跳过 access check，attach part 仍然访问 S3 | 失效 |
| 23.11 ~ 24.5 | 同上，但可以手动开 `async_load_databases` | 失效，有更好的办法 |
| 24.6+ | 同上，`async_load_databases` 默认开启 | 失效，有更好的办法 |

说白了，`skip_access_check` 在 22.x 上那点救场的本事，是 bug 带来的，不是设计出来的功能，23.x 把这个 bug 修了，偏方也就跟着没了。

## 各个版本怎么救

### 哪个版本都能用：把表的 SQL 文件挪走

这是从 22.x 到 24.x 都好使的硬办法，也是最靠得住的应急手段。

```bash
# 1. 停 ClickHouse
systemctl stop clickhouse-server

# 2. 把出问题的表的 SQL 元数据文件移到暂存目录
mkdir -p /tmp/ch_pending/
mv /var/lib/clickhouse/metadata/db_name/big_table.sql /tmp/ch_pending/

# 如果有多个表受影响，全部移走
mv /var/lib/clickhouse/metadata/db_name/*.sql /tmp/ch_pending/

# 3. 启动 server
systemctl start clickhouse-server

# 4. server 起来了，等 S3 恢复
# ...

# 5. S3 恢复后，移回 SQL 文件并 ATTACH
mv /tmp/ch_pending/big_table.sql /var/lib/clickhouse/metadata/db_name/
clickhouse-client -q "ATTACH TABLE db_name.big_table"
```

道理很简单，ClickHouse 启动时只处理 `metadata/` 目录里能看到的 SQL 文件，文件不在了，就不会去 attach 这张表，也就不会去碰 S3，跟版本没关系。

有几点得小心。挪的是 `/var/lib/clickhouse/metadata/` 下面的 SQL 文件，`/var/lib/clickhouse/data/` 千万别碰，那里是真正的本地数据，包括 S3 disk 本地那一层 metadata，动了它是真会丢数据的。挪走的 SQL 文件最好先备份一份再 `ATTACH`。如果是 ReplicatedMergeTree，恢复时要确认 ZK 上的路径还在。

这个办法我建议每个 ClickHouse 运维团队都写进自己的 runbook。

### 只适用于 22.x：改错 endpoint 加 skip_access_check

留着当个历史记录，23.x 以后别再用了：

```xml
<disks>
    <s3_cold>
        <type>s3</type>
        <endpoint>https://nonexistent.invalid/</endpoint>
        <skip_access_check>true</skip_access_check>
    </s3_cold>
</disks>
```

集群还在 22.x 的话，这招照样管用。可要是在讲 23.x 以后版本的文章里看到有人推荐这个偏方，多半是作者没在新版本上试过。

### 23.11 以后：async_load_databases

```xml
<async_load_databases>1</async_load_databases>
```

开了以后，数据库和表在启动后异步加载，加载失败的表只影响查它的查询，server 照样起来对外服务，可以在 `system.asynchronous_loader` 里看加载进度。24.6 起默认配置里已经是开着的了。

注意 23.3 和 23.8 这两个 LTS 都还没有这个参数，老偏方又已经失效了，S3 一断，能指望的就只有上面挪 SQL 文件那一招。还卡在这两个版本上的，我建议尽快往 24.x 的 LTS 升。

起来以后，配合启动日志和系统表去找哪些表还没加载好。不同版本暴露的字段不完全一样，先用宽松一点的查询看看当前版本有什么：

```sql
DESCRIBE TABLE system.tables;
DESCRIBE TABLE system.detached_parts;

SELECT database, table, engine, total_rows, total_bytes
FROM system.tables
WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
ORDER BY database, table;

SELECT database, table, name, reason
FROM system.detached_parts
WHERE reason != ''
ORDER BY database, table, name;
```

别把某个小版本里的字段名写死在自动化脚本里。

### 24.x 以后：查状态，别猜参数

到了 24.x，定位的思路应该从猜参数换成查状态：

```sql
-- 看被移动到 detached 的坏 part
SELECT database, table, name, reason
FROM system.detached_parts
WHERE reason LIKE '%broken%' OR reason != '';

-- 看最近的启动 / attach 相关错误，具体日志表是否开启取决于配置
SELECT event_time, level, message
FROM system.text_log
WHERE event_time > now() - INTERVAL 1 HOUR
  AND (message ILIKE '%attach%' OR message ILIKE '%s3%' OR message ILIKE '%metadata%')
ORDER BY event_time DESC
LIMIT 100;
```

表已经 detached 了，就等 S3 恢复后再显式 `ATTACH TABLE`。server 已经起来、只是某张表一直失败的，按表去处理，别为了一张表把整个集群重启一遍。

### 不建议：只读 disk 加一个临时的空 bucket

网上还传过一种做法，把 endpoint 临时指到一个连得上的空 bucket，再设 `readonly=true` 和 `skip_access_check=true`，想让 server 先起来。

这种做法我不建议写进生产手册。它换了对象存储的根路径，ClickHouse 可能把对象不存在误判成 part 损坏，进而弄出一堆 detached 或者 broken 的 part，恢复起来更麻烦。除非你在同版本、同引擎、同表结构的测试环境里完整演练过，否则别在生产故障里临时拿来用。

## 最后

S3 断了、ClickHouse 起不来的时候，我的顺序是：版本支持就先靠 `async_load_databases` 让 server 起来；不支持或者还是起不来，就把受影响的表的 SQL 文件挪走；等 S3 恢复，再一张张 `ATTACH` 回来。

偏方这东西，往往是靠某个版本的副作用撑着的，升级以后那个副作用一修，偏方就失效了，还没人通知你。22.8 上那套操作没毛病，可要是没人知道它为什么能用，升到 23.3 那天就只能对着一句 metadata not found 发愣。

---

**相关**：[版本升级避坑清单](/clickhouse/upgrade-gotchas) · [`async_load_databases` 24.6 起默认开启](/clickhouse/upgrade-gotchas#gotcha-async-load)
