---
title: metadata 明明在本地，为什么 ClickHouse 说 S3 上找不到
---

# metadata 明明在本地，为什么 ClickHouse 说 S3 上找不到

> S3 不可达时 ClickHouse 起不来该怎么办，以及一个广为流传的偏方，是怎么跨三个大版本失效的。
>
> **阅读对象**：维护过 ClickHouse + S3 Disk 生产集群、对启动期行为有过困惑、或经历过 S3 不可达故障的工程师。

## 引言：一个真实事故

某个百 TB 规模的 ClickHouse 集群，22.8 版本，用 S3 Disk 做冷热分层。某天发生了这样一次事故：

1. ClickHouse 集群把 S3 的 IO 打爆，影响到了同账号下其他业务
2. S3 维护团队为了止血，直接把 ClickHouse 用的 access key 失效了
3. ClickHouse 节点几小时后例行重启，连不上 S3，server 启动卡住
4. 运维当时的「救命」操作：把配置里的 S3 endpoint **故意改错**（指向一个不存在的域名），同时打开 `skip_access_check=true`
5. 这套组合拳让 server 起来了，`DETACH` 掉 S3 disk 上的表
6. 等 access key 重新启用后改回正确配置，重启，重新 `ATTACH`

**这个 trick 在 22.8 上完美工作。**

但是 —— 当这个集群升级到 23.3 之后，再发生类似情况，同样的操作**完全失效**了。同样的「改错 endpoint + `skip_access_check`」组合，server 还是起不来，报错信息里说「S3 上的 metadata 找不到」。

很多人会困惑：**我的 `metadata_path` 不是配在本地吗？为什么 ClickHouse 说在 S3 上找不到 metadata？**

这背后涉及一系列从 22.x 到 24.x 的行为变迁：对象存储抽象变化、metadata 双层结构、启动期 attach 行为变严。下面把这个故事讲清楚，并给出每个版本相对稳妥的救援姿势。

---

## 一、启动期 ClickHouse 到底在做什么

要理解为什么某个参数失效，先要理解 ClickHouse 启动时的完整流程。按顺序经过这几个阶段：

<div class="flow">
<div class="flow-step"><span class="flow-n">1</span><span class="flow-t">读取并解析配置</span></div>
<div class="flow-step hl-a"><span class="flow-n">2</span><span class="flow-t">初始化 disk，做 <strong>access check</strong>（写一个测试文件再删掉）<em>← <code>skip_access_check</code> 作用于此</em></span></div>
<div class="flow-step"><span class="flow-n">3</span><span class="flow-t"><!-- TODO --></span></div>
<div class="flow-step"><span class="flow-n">4</span><span class="flow-t">加载 <code>metadata/</code> 下的表定义 SQL</span></div>
<div class="flow-step hl-b"><span class="flow-n">5</span><span class="flow-t"><strong>Part attach</strong> —— 校验 active part 的完整性<em>← 生产中真正卡住的地方</em></span></div>
<div class="flow-step"><span class="flow-n">6</span><span class="flow-t">对外提供服务</span></div>
</div>

<!-- TODO: 第 3 步和第 6 步我不知道你原图里写的是什么，按你的图补准确 -->

任何一步失败都可能让启动卡住。`skip_access_check` 影响的是**第 2 步**，但实际生产中启动卡住更常见的是**第 5 步 —— part attach 阶段**。

**这个错位，是后面所有困惑的根源。**

---

## 二、Metadata 的两层结构

要理解为什么 `skip_access_check`「看起来该有效但其实没用」，必须先搞清楚 ClickHouse 的 metadata 实际上有**两层**。很多人混淆了这两层，导致排查时方向就错了。

### 第一层：Disk-level metadata（在本地）

`<metadata_path>` 配置的本地目录，存的是「逻辑文件名 → S3 object key」的映射。

每个本地「文件」其实是个 stub，内容是几行文本：

```
3
1   1234   xxx/yyy/zzzobj1
```

意思是「这个文件大小 1234 字节，在 S3 上的 object key 是 `xxx/yyy/zzzobj1`」。

**读这个本地文件不需要访问 S3。**

### 第二层：Part-level metadata（在 S3 上）

每个 ClickHouse part 有几个自描述文件，记录 part 自己的元信息：

| 文件 | 内容 |
|---|---|
| `columns.txt` | part 包含的列定义 |
| `checksums.txt` | 每个文件的 hash 校验 |
| `count.txt` | part 的行数 |
| `primary.idx` | 主键索引 |
| `partition.dat` | 分区信息 |
| `minmax_*.idx` | minmax 索引 |
| `default_compression_codec.txt` | 压缩编解码器 |

这些文件本身**存在 S3 上** —— disk-level metadata 里有指针指向它们。**Part attach 阶段必须 GET 这些文件才能验证 part 完整性。**

所以「S3 上的 metadata 找不到」这个报错，指的是**第二层 part-level metadata**，是某个 part 的 `checksums.txt` 之类的文件 GET 失败了。本地的 disk-level metadata 仍然好好的，只是**它指向的 S3 对象不可达**。

理解了这点，下面的版本变迁就好理解了。

---

## 三、`skip_access_check` 的版本变迁

### 22.x：副作用大于本意

22.x 时代 ClickHouse 的 disk 抽象比较扁平 —— 一个 `IDisk` 接口，每个 disk 类型自己实现，`S3Disk` 是个相对单一的实现。

`skip_access_check` 设计上**只跳过第 2 步**。但因为 22.x 的几个特点，它意外获得了「救场」能力：

1. **Disk 创建失败导致整个 disk 进入 broken 状态** —— S3 endpoint 不可达 → S3 client 创建失败 → 该 disk 被标记 broken
2. **Broken disk 上的 part 走 lazy attach 路径** —— 22.x 的 part attach 是 lazy 的，broken disk 上的 part 会被推迟处理
3. **Lazy attach 不立即读 S3 metadata** —— 第 5 步被静默跳过，启动可以继续

结果：access check 失败 + skip 掉 → disk broken → part 全部 lazy → server 起来了。

**副作用救场。** 参数本来不是为这个设计的，但因为内部的 broken disk 处理逻辑足够宽松，它意外变成了一个「S3 不可达救命开关」。

### 22.x 的「改错 endpoint」偏方为什么管用

把 endpoint 改成不存在的域名（比如 `https://nonexistent.invalid/`）：

```
DNS 解析失败 → S3 client 初始化失败 → access check 必然失败
   ↓
配合 skip_access_check=true，跳过这一步
   ↓
Disk 进入 broken 状态
   ↓
该 disk 上所有 part 走 lazy attach
   ↓
Server 起来了
   ↓
DETACH 表（这时表是 broken 的，DETACH 是合法操作）
   ↓
改回正确 endpoint，重启
   ↓
重新 ATTACH，正常工作
```

这个流程在 22.x 完美闭环，运维圈广为流传。

### 23.x：对象存储抽象变化，副作用消失

从 23.x 开始，ClickHouse 的远端存储实现逐步引入 `IObjectStorage` 等抽象，把 disk 拆成更清晰的两层：

- **逻辑 disk**：`DiskObjectStorage`
- **物理存储**：`S3ObjectStorage` / `AzureObjectStorage` / `LocalObjectStorage` / ...

从生产表现看，这一阶段有三个值得关注的变化：

1. **access check 作用域更接近原始语义** —— `skip_access_check` 主要影响启动时的读写探测，不再稳定地产生「disk broken 后跳过后续 attach」的副作用
2. **Part attach 行为更严格** —— 启动过程中更容易在 active part 校验阶段真实访问 S3 上的 part 自描述文件
3. **错误处理更保守** —— 远端对象不可达、缺失或权限错误时，更倾向于显式报错，而不是把相关表静默延后

所以同样的组合在 23.x 上的执行路径变成：

```
endpoint 错 → S3 client 初始化失败 → access check 失败
   ↓
skip_access_check=true 让这一步跳过 ✓
   ↓
但是！进入第 5 步 part attach
   ↓
ClickHouse 试图通过 disk-level metadata 找 S3 object
   ↓
S3 不可达 → GET checksums.txt 失败
   ↓
抛错 "metadata not found" → 启动失败
```

`skip_access_check` 在 23.x **还有效，但它救不了 part attach 阶段**。22.x 那个「误打误撞」的副作用，不能再作为生产 SOP 依赖。

::: warning 错误信息会误导你
`"metadata not found"` 容易让人去检查 `<metadata_path>` 配置，但问题其实在 **part-level metadata**。
:::

### 24.x：进一步退化为「小开关」

24.x 在故障处理上继续补齐机制，让 `skip_access_check` 的角色进一步边缘化：

- `async_load_databases` 在 **23.8 加入并稳定**（并在 **24.8 成为默认**），让 attach 失败的表不阻塞 server
- 失败表、detached part、启动日志提供了更明确的定位入口，具体系统表和字段要以当前版本为准
- S3 相关限速、重试、连接池等参数更细，能从源头降低被对象存储侧限流或封禁的概率
- 启动期加载和校验能力持续优化，避免少数慢表拖住整个 server

`skip_access_check` 在 24.x 仍然存在，但作用**回归到「跳过启动时的写测试文件」这个原始语义**。几乎没人靠它救场。

### 一张表总结演变

| 版本 | `skip_access_check` 的实际效果 | 改错 endpoint 偏方 |
|---|---|:--:|
| <span class="ver">22.x</span> | 跳 access check + 副作用让 disk 进入 lazy 模式 | ✅ 有效 |
| <span class="ver break">23.0 ~ 23.7</span> | 只跳 access check，part attach 仍然访问 S3 | ❌ 失效 |
| <span class="ver">23.8 LTS+</span> | 同上，但有 `async_load_databases` 替代方案 | ❌ 失效，但有更好的方案 |
| <span class="ver">24.x</span> | 同上，配合 detached parts、启动日志和状态表定位 | ❌ 失效，方案更完善 |

**核心结论：`skip_access_check` 从「屠龙刀」退化为「指甲刀」。22.x 时代它的救场能力是 bug 而不是 feature，23.x 把这个 bug 修了。**

---

## 四、各版本的正确救援姿势

### 通用方案：物理移走 metadata SQL 文件

从 22.x 到 24.x 都好使的「硬绕过」，也是最可靠的应急手段。

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

**为什么这个方法可靠**：ClickHouse 启动时只会处理 `metadata/` 目录里看到的 SQL 文件。文件不在了，就不会尝试 attach 这个表，也就不会去访问 S3。这是**版本无关**的硬绕过。

::: danger 关键注意点
- 移走的是 `/var/lib/clickhouse/metadata/` 里的 **SQL 文件**，**不要碰 `/var/lib/clickhouse/data/`**
- `data/` 目录里是真正的本地数据（包括 S3 disk 的 disk-level metadata），动了它会**真的丢数据**
- `ATTACH` 之前最好先 backup 一份移走的 SQL 文件
- 如果这个表是 ReplicatedMergeTree，恢复时要确认 ZK 路径还在
:::

**这个方法应该被列为标准应急 SOP —— 每个 ClickHouse 运维团队都该写进 runbook。**

### 22.x 专属：改错 endpoint + `skip_access_check`

仅作历史记录，**不推荐在 23.x 之后使用**：

```xml
<disks>
    <s3_cold>
        <type>s3</type>
        <endpoint>https://nonexistent.invalid/</endpoint>
        <skip_access_check>true</skip_access_check>
    </s3_cold>
</disks>
```

如果你的集群还在 22.x，这个 trick 仍然有效。但**如果在 23.x+ 上看到这个偏方推荐，警惕作者可能没在新版本验证过**。

### 23.8 LTS+ 推荐：`async_load_databases`

```xml
<async_load_databases>1</async_load_databases>
```

启动时数据库 attach 异步进行，attach 失败的表标记 broken，server 立即可用。23.8 LTS 之后稳定。

配合启动日志和系统表定位哪些表还没 attach 完。**不同版本暴露的字段不完全一致**，建议先用「宽松查询」看当前版本有哪些可用信息：

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

如果某个版本提供异步加载或 broken table 相关系统表，再优先使用对应系统表。**不要把某个小版本里的字段名直接写死到自动化脚本里。**

::: tip 23.3 是个尴尬版本
新机制刚开始引入，还不稳定；老 trick 已失效。如果还卡在 23.3，建议直接升 23.8 LTS。
:::

### 24.x 兜底：用状态表和日志定位失败对象

24.x 之后，建议把定位入口从「猜参数」切到「查状态」：

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

如果表已经处于 detached 状态，可以等 S3 恢复后再显式 `ATTACH TABLE`。如果 server 已经启动、但某张表持续失败，**优先按表处理，不要为了单表问题重启整个集群**。

### 不推荐：readonly disk + 临时空 bucket

网上还流传过一种做法：把 endpoint 临时指向一个能连上的**空 bucket**，并设置 `readonly=true` 和 `skip_access_check=true`，试图让 server 先起来。

**这类做法不建议写进生产 SOP。** 它改变了对象存储根路径，可能让 ClickHouse 把「对象缺失」误判成 part 损坏，进而产生 detached / broken parts，**扩大恢复复杂度**。除非你在同版本、同引擎、同表结构的测试环境完整演练过，否则不要在生产故障中临时使用。

---

## 生产优先级

> **`async_load_databases` → 物理移走表 SQL 元数据文件 → S3 恢复后显式 `ATTACH`**

---

**相关**：[版本升级避坑清单](/clickhouse/upgrade-gotchas) · [`async_load_databases` 24.8 起默认开启](/clickhouse/upgrade-gotchas#gotcha-async-load)
