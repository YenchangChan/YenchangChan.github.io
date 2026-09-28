---
title: 三种冷数据方案下，ALTER TABLE 会发生什么
---

# 三种冷数据方案下，ALTER TABLE 会发生什么

> 冷热分层是一次性架构选择，schema 演化却是常态运维。100T 冷数据下，一句普通的 ADD COLUMN 可能是瞬时操作，也可能是持续几周的灾难 —— 差别全在你走的哪条路线、用的哪种语义。
>
> **阅读对象**：冷热分层已经上线、接下来要长期维护 schema 的团队。

---

## 引言

冷热分层是个一次性架构选择，但 schema 演化是**常态运维**——业务每隔几个月加列、改类型、删列是再正常不过的事。在 100T 量级的冷数据下，一句普通的 `ALTER TABLE ADD COLUMN` 可能是瞬时操作，也可能是持续几周的灾难，差别全在于你走的是哪种存储方案、用了哪种 ALTER 语义。

本文是 [冷热分层实战](/clickhouse/cold-storage/) 的横向补充——不再讨论「该选哪种方案」，而是讨论「方案选好之后，schema 怎么演化才不出事」。重点是三种主流冷数据方案：

- **S3 Disk**：ClickHouse 原生冷热分层，part 还是 ClickHouse 的 part，受 ClickHouse 完整管控
- **BACKUP/RESTORE**：合规归档专用，backup 文件是脱离 live 表的自描述快照
- **S3 Engine + Parquet**：湖仓化路径，数据用 Parquet 这种业界开放格式存储

阅读对象：已经在跑这三种方案之一、被业务催着加列改字段的工程师。

---

## 一、ALTER 的两条执行路径

讨论任何场景前，先讲清楚 ClickHouse 的 ALTER 在内部是怎么走的——这个分流是后面所有结论的基础。

### 1.1 瞬时元数据路径

```sql
ALTER TABLE t ADD COLUMN foo String DEFAULT '';
ALTER TABLE t ADD COLUMN bar Nullable(Int64);
ALTER TABLE t RENAME COLUMN old_name TO new_name;
```

行为：
- 改 schema metadata（`metadata/<db>/<t>.sql`）
- 通知所有副本（ZK 协调）
- **不动任何 part 文件**

读时合成（read-time synthesis）：
- 老 part 没这列文件，查询命中时由 DEFAULT 表达式现算
- 性能损耗 ≈ 单次表达式求值（可忽略）
- 100T 数据加列 → 完成时间毫秒级，零 S3 IO

### 1.2 Mutation 路径

```sql
ALTER TABLE t MATERIALIZE COLUMN foo;          -- 显式
ALTER TABLE t MODIFY COLUMN x Int64;            -- 改类型
ALTER TABLE t UPDATE col = v WHERE ...;         -- 数据变更
```

行为：
- 每个 part 跑一次 mutation，产出新 part
- 老 part 标记删除（异步清理）
- 重写量取决于 ALTER 类型：MATERIALIZE 只写新列；MODIFY type 重写整列；UPDATE 可能重写多列

### 1.3 关键分流

<figure class="dfig">
<img class="dfig-l" src="/diagrams/alter-01.light.svg" alt="1.3 关键分流">
<img class="dfig-d" src="/diagrams/alter-01.dark.svg" alt="1.3 关键分流">
</figure>

记住这条分流——后面三个场景的所有讨论都围绕「你的 ALTER 落在哪一条路径上」展开。

---

## 二、全景对照表

先给出最终结论。三种典型 ALTER × 三种方案的代价矩阵：

| ALTER 类型 | S3 Disk（在线） | BACKUP（已归档） | Parquet（已写入 S3） |
|---|---|---|---|
| `ADD COLUMN` 默认（不 MATERIALIZE）| ✅ 瞬时，零 IO | ✅ 不影响 backup | ✅ 老 Parquet 缺列读时返回 DEFAULT |
| `ADD COLUMN` + `MATERIALIZE COLUMN` | ❌ 全 part mutation，几天~几周 | ✅ 不影响 backup（live 的 mutation 不写 backup） | N/A（Parquet 由外部生产，无 ClickHouse mutation 概念） |
| `MODIFY COLUMN type` | ❌ 全表 mutation，TB 级 IO | ⚠️ 路径 A 可还原；路径 B 失败 | ⚠️ Parquet 读时支持有限的类型升降 |
| `DROP COLUMN` | ✅ 元数据 + 异步清理 | ⚠️ 路径 B schema 不匹配 | ✅ 老 Parquet 仍有该列文件，新查询不读 |
| `RENAME COLUMN` | ✅ 瞬时（现代版本） | ⚠️ 路径 B schema 不匹配 | ⚠️ 列名映射断了，老 Parquet 该列读不到 |
| `MODIFY ORDER BY`（追加列） | ✅ 瞬时 | ❌ 两条路径都麻烦 | N/A（外部表无 ORDER BY 概念） |
| `MODIFY TTL` | ⚠️ 部分版本触发全表重评估 | ✅ 不影响 backup | N/A |

三个一眼可见的结论：

1. **S3 Disk 是 schema 演化代价最不确定的方案**——同样是 ADD COLUMN，加 vs 不加 MATERIALIZE 差三个数量级
2. **BACKUP 是最「洁净」的方案**——live 表的 ALTER 完全不影响已归档的 backup，因为 backup 是自描述快照
3. **Parquet 是 schema 演化最友好的方案**——绝大多数 ALTER 在 Parquet 上「自动兼容」

下面分场景细讲。

---

## 三、场景一：S3 Disk 上的 ALTER

### 3.1 ADD COLUMN：默认路径与陷阱

默认行为（不带 MATERIALIZE）就是上面的瞬时元数据路径。读时合成兜住所有老 part。

但这条路径上有几个**容易被误触发 MATERIALIZE 的陷阱**：

1. **DDL 自动化工具**：很多团队的发布流水线在 `ADD COLUMN` 后跟一句 `MATERIALIZE COLUMN`，作为「同步落盘」步骤。在小表上无所谓，在 100T 表上是核灾难
2. **`mutations_sync=2`**：让 ALTER 同步等 mutation 完成。如果 DDL 不小心加了 MATERIALIZE，ALTER 调用会「卡几天」，看起来像挂了
3. **业务团队主动要求 materialize**：理由通常是「想让老数据也压缩成新 codec」。在 100T 上代价远大于收益

### 3.2 MATERIALIZE COLUMN 在 100T S3 上的具体代价

假设 part 平均 200MB → **50w 个 part**。每个 part 走 mutation：

- 算 DEFAULT（如果依赖其它列要先从 S3 读这些列）
- 老列 hard-link 到新 part（S3 disk 上是更新本地 metadata 映射，不复制 S3 对象）
- 新列写 S3
- 老 part 标记删除

**S3 写入量**：

- DEFAULT 是常量：只写新列。压缩后假设 10B/行 × 千亿行 → 约 1TB 写入
- DEFAULT 是表达式 `DEFAULT user_id % 100`：要全表读 user_id 列从 S3 → 几 TB ~ 几十 TB 出口流量

**S3 请求量（更隐形）**：

- 50w part × 每 part 5~10 次 PUT（新列 .bin/.mrk + 更新 columns.txt/checksums.txt/count.txt）
- ≈ 几百万次 PUT，按 $0.005/1000 算 ≈ $25
- 钱不多，**但触发 S3 限流**（默认每 prefix 3500 PUT/s）会拖到几天

**Storage Policy 漂移（最容易被忽略）**：

- 理论上 mutation 输出保留原 part 的 disk
- **但版本相关**：21.x 早期上 mutation 输出按当前 storage policy 重新分配，可能把冷 part mutation 结果写到热盘——你几百 GB 的热盘瞬间被几十 TB mutation 输出打爆
- **强烈建议在影子表上验证当前版本的行为**

**ZK 元数据膨胀**：

- 每个 mutation 生成 ZK 节点
- 50w part × 副本数 = 巨量 ZK 写入
- 跨副本协调容易僵死，需 `SYSTEM SYNC REPLICA` 救

### 3.3 MODIFY COLUMN type：永远走 mutation

```sql
ALTER TABLE t MODIFY COLUMN x Int64;  -- 原本 Int32
```

这条没有「轻量路径」——必然全表 mutation。代价比 MATERIALIZE 还大，因为不止写新列，是**读老列 + 转换 + 写新列**：

- 100T 全表读 → 出口 100T 流量
- 转换后写入 → 入口 100T 流量
- 时间：完全受 S3 带宽和 background_pool_size 限制，按 1Gbps 入出算 ≈ 几周

**实操替代方案**：能不改类型就别改。真要改，常见 workaround：

```sql
-- 1. 加新列(瞬时,不 MATERIALIZE)
ALTER TABLE t ADD COLUMN x_v2 Int64 DEFAULT toInt64(x);

-- 2. 业务双写改造期间写 x_v2

-- 3. 老数据按月分批 materialize(避免一次性扫全表)
ALTER TABLE t MATERIALIZE COLUMN x_v2 IN PARTITION '202401';
ALTER TABLE t MATERIALIZE COLUMN x_v2 IN PARTITION '202402';
-- ... 按月推进

-- 4. 全部 materialize 完后 DROP 老列
ALTER TABLE t DROP COLUMN x;
ALTER TABLE t RENAME COLUMN x_v2 TO x;
```

这个流程把「一次性 100T 重写」打散成「每月几 TB」，单次代价可控，可以排进维护窗口。

### 3.4 DROP COLUMN：元数据 + 异步清理

DROP COLUMN 的执行：

- 立即更新 schema metadata（这一列从 SELECT * 中消失）
- 调度 mutation 物理删除该列的 .bin/.mrk 文件
- 异步执行，不阻塞业务

S3 上的表现：

- 元数据更新瞬时
- 列文件删除在后台慢慢做
- 期间该列文件还在 S3 上占空间，删除完成后释放

**陷阱**：如果该列体积巨大（比如某 String 列占了 30T），异步删除期间 S3 用量看上去没下降，运维会以为「没生效」。要查 `system.mutations` 看进度，必要时调大 `background_pool_size` 加速清理。

### 3.5 MODIFY ORDER BY：在线无感的隐形破坏

```sql
ALTER TABLE t MODIFY ORDER BY (existing_pk_col, new_col);
```

ClickHouse 只允许「追加非主键列到 ORDER BY 末尾」，不能修改现有顺序。在线代价：

- 只改元数据
- 老 part 的物理排序不变
- 新写入的 part 按新 ORDER BY 排序

看起来很美。但代价转移到了：

- **新老 part 排序不一致**，部分查询走不上 primary index 加速
- **BACKUP 兼容性破坏**：老 backup 还原到当前 schema 的 live 表会失败（schema 不匹配，详见第四章）

### 3.6 MODIFY TTL：版本相关的炸弹

部分版本上 `ALTER MODIFY TTL` 会触发**所有 part** 的 TTL 表达式重评估：

```sql
ALTER TABLE t MODIFY TTL event_time + INTERVAL 60 DAY TO VOLUME 'cold';
```

理论上：只影响「未来何时移到冷盘」的判断。实际行为：

- 23.x 之前部分版本上会扫所有 part 重新评估 TTL move 条件
- 重评估期间可能触发 part 在 hot/cold 之间反复横跳——再次警告 storage policy 漂移
- 24.x+ 改善但仍要在测试集群上验证

**实操建议**：MODIFY TTL 之前先看具体版本的行为，必要时 `SYSTEM STOP MOVES` 防漂移，TTL 调整完再 `SYSTEM START MOVES`。

---

## 四、场景二：BACKUP/RESTORE 上的 ALTER

### 4.1 核心模型：BACKUP 是自描述快照

BACKUP 文件包含：

```
backup_2026_01.zip / backup_2026_01/
├── metadata/<db>/<table>.sql        # 当时的 CREATE TABLE 完整定义
├── data/<db>/<table>/<part>/        # 每个 part 目录
│   ├── columns.txt                  # part 自己的列清单
│   ├── checksums.txt
│   └── *.bin / *.mrk2
└── .backup                          # 全局描述
```

这个结构有两个关键属性：

1. **每个 part 自描述**：`columns.txt` 记录这个 part 物理存了哪些列
2. **整个 backup 自描述**：`<table>.sql` 是当时的完整 schema

这意味着 **live 表的任何 ALTER 都不会写到 backup 里**——backup 是冷数据的快照，写完就只读。

### 4.2 三条 RESTORE 路径与各自的 schema 兼容性

**路径 A：还原到新表名（最安全，总能成功）**

```sql
RESTORE TABLE default.events AS default.events_restored
  FROM S3('s3://bucket/backup_2026_01/', '...');
```

- ClickHouse 用 backup 里的老 SQL 创建 `events_restored`
- 表结构 = 老 schema
- 老数据原样还原
- 不依赖当前 live 表是什么样

**适用场景**：合规审计、历史数据查询、任何「我只想看老数据」的场景。这是最稳的路径。

**路径 B：合并进当前 live 表**

```sql
RESTORE TABLE default.events FROM S3(...)
  SETTINGS allow_non_empty_tables = 1;
```

ClickHouse 行为：

- 比较 backup schema (S0) vs 当前表 schema (S1)
- 差异**只是 live 表多了几个有 DEFAULT/Nullable 的列**：通过，老 part 走读时合成
- 差异是 MODIFY type / DROP COLUMN / MODIFY ORDER BY：失败

**适用场景**：很少。大多数情况下走路径 A 更稳。

**路径 C：只还原结构 + 选择性 ATTACH PART**

```sql
RESTORE TABLE default.events_restored
  FROM S3(...)
  SETTINGS structure_only = 1;

ALTER TABLE events_restored ATTACH PART '20260101_1_100_2';
```

精细化操作，适合「我只想要某几个分区」。和路径 A 是同源思路，操作粒度更细。

### 4.3 哪些 ALTER 真正破坏 backup 可恢复性

**完全不破坏**（路径 A 永远能用）：

- ADD COLUMN（不 MATERIALIZE）
- MATERIALIZE COLUMN（live 表的 mutation 不影响 backup）
- DROP COLUMN
- 任何对 live 表的 ALTER

只要走路径 A 用 backup 自带的 schema 还原到新表名，永远成功——backup 是独立宇宙。

**只破坏路径 B**：

- MODIFY COLUMN type
- DROP COLUMN（schema 不再匹配）
- RENAME COLUMN

**严重情况下两条路径都受影响**：

- 表 RENAME（backup 文件名 vs live 表名对不上，可手工修元数据但麻烦）
- MODIFY ENGINE
- MODIFY ORDER BY 后想还原回原表

### 4.4 演练原则：破坏性 ALTER 之前重做 base BACKUP

合规归档场景下，**真正的安全保证不是「backup 文件存在」，而是「恢复演练能跑通」**。建议的节奏：

1. 每次破坏性 ALTER（MODIFY type / MODIFY ORDER BY / 改引擎）之前
2. 做一次完整 base BACKUP，标记 「post-alter-X」
3. 在测试集群上做一次完整 RESTORE 演练
4. 演练通过后才执行生产 ALTER
5. ALTER 完成后再做一次 base BACKUP

这样不管什么时候出事，最近的 base BACKUP 都和当前 live 表 schema 兼容。

### 4.5 Glacier 取回的连带成本

如果 backup 已经在 Glacier Deep Archive 上：

- 真正还原前还有 12-48h 的 `restore-object` 等待
- 这个等待期是做演练和准备的最佳窗口
- 老 backup 的 schema 可能和当前 live 表早就漂得很远，演练阶段必须确认走哪条 RESTORE 路径

---

## 五、场景三：S3 Engine + Parquet 上的 ALTER

### 5.1 模型差异：ClickHouse 是查询者，不是数据 owner

S3 Engine + Parquet 的核心差异是：**Parquet 文件不属于 ClickHouse**。它们由业务通过 `INSERT INTO FUNCTION s3()` 或外部工具（Spark / Flink / 自研管道）生产，ClickHouse 只是个查询前端。

这意味着：

- **ClickHouse 端的 ALTER 几乎不影响 S3 上的 Parquet 文件**——因为 ClickHouse 根本不管这些文件
- **Schema 演化的真正机制在 Parquet 文件本身**

### 5.2 Parquet 的 schema 自描述与列名映射

Parquet 在文件 footer 里完整存了 schema：列名、类型、压缩 codec、统计信息。

ClickHouse 读取时**按列名匹配** ClickHouse 表的列定义和 Parquet 文件里的列。这是 schema 演化最关键的一点。

```sql
-- ClickHouse 表定义
CREATE TABLE events_archive (
  event_time DateTime,
  user_id UInt64,
  event_type String,
  new_field String DEFAULT ''   -- 新加的
) ENGINE = S3('s3://bucket/events/*.parquet', 'Parquet')
SETTINGS use_hive_partitioning = 1;
```

读老 Parquet 文件时：

- `event_time / user_id / event_type` 在 Parquet 里有对应列 → 直接读
- `new_field` 在老 Parquet 里没有 → 用 DEFAULT 填充（NULL 或空字符串）

**这就是 Parquet 方案 schema 演化的核心机制——和 ClickHouse 自己的「读时合成」是同一个语义，只是发生在文件格式层。**

### 5.3 三种 ALTER 在 Parquet 方案上的具体表现

**ADD COLUMN**：

- 在 ClickHouse 的 S3 Engine 表上 ADD COLUMN：纯元数据，瞬时
- 老 Parquet 文件没有这列：读时返回 DEFAULT
- 新写入的 Parquet 文件：取决于业务的写入逻辑——一般业务管道会同步加这列写出来
- **完美兼容**

**MODIFY COLUMN type**：

- 在 ClickHouse 表上改类型：纯元数据
- Parquet 文件本身的列类型没变
- 读时 ClickHouse 尝试把 Parquet 的类型转成 ClickHouse 表声明的类型
- 类型转换支持范围：Int 之间扩位（Int32 → Int64）安全；Int → Float、String → Int 这种转换**会失败或截断**
- 实操中：能转的（升精度、Nullable 加减）走 ClickHouse 自动；不能转的，业务需要在写出端把 Parquet 的列类型也改了，或者另起一列

**DROP COLUMN**：

- 在 ClickHouse 表上 DROP：纯元数据
- 老 Parquet 还有这列文件，但 ClickHouse 不读了
- 新 Parquet 不写这列了
- 老 Parquet 上这列的存储**继续占着 S3 空间**——这是和 S3 Disk 不同的地方，Parquet 没有 ClickHouse 的异步清理机制
- 真要释放空间：业务自己重写老 Parquet 文件（partition compaction）

**RENAME COLUMN**：

- 在 ClickHouse 表上改列名：纯元数据
- 但 Parquet 是按列名匹配的——改了列名后老 Parquet 里这列就读不到了
- 实操：要么改 Parquet 写出端同步改名（新文件用新列名），要么用视图层做映射

### 5.4 与 Hive Partitioning 的协同

`use_hive_partitioning=1` 模式下，分区列从路径解析：

```
s3://bucket/events/dt=2026-04-29/hour=10/file.parquet
                  ^^^^^^^^^^^^^^^ ^^^^^^^^
                       dt=2026-04-29  hour=10
```

加分区列、改分区方式时：

- ClickHouse 端 ADD COLUMN dt 即可
- **老 Parquet 文件路径不变**——它们的 dt 还是按老路径解析
- 完美兼容，无需重写文件

这是 Parquet 方案的一个**结构性优势**：分区演化也几乎零代价。

### 5.5 Parquet 方案的 schema 演化局限

并不是所有 ALTER 都自动友好：

1. **复杂类型变更**：`String` → `LowCardinality(String)` 这种 ClickHouse 特有类型，Parquet 没法表达，只能在 ClickHouse 侧做声明
2. **嵌套结构改造**：Parquet 支持嵌套（Struct/List），但跨版本演化比扁平列复杂
3. **业务双写期成本**：如果你想让「新写入的 Parquet 文件有新列」，必须改业务管道。这个改造的工作量是真实存在的，只是它发生在 ClickHouse 之外

---

## 六、三种方案的 schema 演化友好度对比

<figure class="dfig">
<img class="dfig-l" src="/diagrams/alter-02.light.svg" alt="六、三种方案的 schema 演化友好度对比">
<img class="dfig-d" src="/diagrams/alter-02.dark.svg" alt="六、三种方案的 schema 演化友好度对比">
</figure>

排序结论：**Parquet > BACKUP > S3 Disk**，但每种方案都有不同维度的代价转移。

**为什么 Parquet 最友好**：

- 数据文件自描述 + 按列名读取，是 schema evolution 这个工程问题的**架构级解决方案**
- ClickHouse 端只是个 reader，ALTER 不需要管数据
- 这恰恰是 Iceberg / Delta Lake / Hudi 等湖仓格式诞生的核心动机

**为什么 BACKUP 次之**：

- backup 是冷数据的冻结快照，与 live 表完全解耦
- 代价不是「不存在」，而是「转移到了恢复演练」——必须确保关键时刻能用某条路径恢复
- 路径 A（恢复到新表名）几乎万能，但需要业务侧做适配以读老 schema

**为什么 S3 Disk 最不友好**：

- 数据本质上还是 ClickHouse 自己的 part，schema 演化要走 ClickHouse 自己的 mutation 路径
- mutation 在 100T S3 上代价巨大且不确定（带宽、限流、ZK、storage policy 漂移）
- 等于把「业务管道演化的复杂度」转移到了「运维窗口的 mutation 调度」

---

## 七、实操建议

### 7.1 通用原则

1. **加列首选 Nullable 或 DEFAULT 常量**——三个方案下都是「瞬时元数据 + 读时合成兜底」
2. **永远不在 100T 表上跑 MATERIALIZE COLUMN**——除非按分区拆成多次
3. **结构性 ALTER（MODIFY type / MODIFY ORDER BY / 改引擎）按月度排期**——不是「想改就改」，而是评估、演练、维护窗口、重做 backup 的完整流程

### 7.2 DDL 工具治理

很多团队的 DDL 工具是「加列 + 立即 MATERIALIZE」的组合。在冷热分层场景下必须改造：

- 加列只发 `ADD COLUMN`，不带 `MATERIALIZE`
- 如果业务真要 materialize（少见），走单独审批，按分区批量执行
- DDL 工具上线一个 lint 规则：100T 以上的表禁用 `MODIFY COLUMN type` 和无作用域限定的 `MATERIALIZE COLUMN`，要做必须人工审批

### 7.3 影子表演练

每次破坏性 ALTER 之前：

1. 在测试集群上建一张同结构的影子表，灌 1% 抽样数据（覆盖热 + 冷）
2. 执行计划中的 ALTER，观察 mutation 进度、S3 IO 模式、storage policy 行为
3. 估算扩展到生产 100T 的代价
4. 确认 RESTORE 兼容性（如果有 backup）

### 7.4 三种方案的 schema 漂移管理

| 方案 | 漂移管理重点 |
|---|---|
| S3 Disk | 控制 mutation 频次，记录历次结构性 ALTER 的版本号 |
| BACKUP | 每次破坏性 ALTER 前后做 base BACKUP，定期演练恢复 |
| Parquet | 业务管道双写期管理，老文件的 schema 元数据归档 |

### 7.5 几个具体技术点

- 加列前后 `SELECT * FROM system.mutations WHERE NOT is_done` 检查无 in-flight mutation
- MODIFY type 用「加新列 + 双写 + 分区 materialize + 删老列」四步法替代直接改
- 定期对冷数据执行 `OPTIMIZE TABLE ... FINAL DEDUPLICATE` 是禁忌——会触发全表 mutation
- ZooKeeper 上 `/clickhouse/tables/.../mutations/` 节点定期清理，避免 ZK 元数据膨胀
- `system.mutations` 是 ALTER 是否真在改数据的唯一可靠信号源——任何「ALTER 卡住」问题先查这张表

---

## 八、一句话总结

**Schema 演化的难度，等于「老数据存在哪里」的函数。**

S3 Disk 把数据放在 ClickHouse 的管控范围内，演化要走 ClickHouse 的 mutation 机制，在大数据量下代价高且不确定；BACKUP 把冷数据冻结成自描述快照，演化与 live 表完全解耦，代价转移到演练频次；Parquet 把数据放在开放格式里，schema 演化是文件格式自带的能力，代价转移到业务管道改造。

冷热分层的真正成本不是写入和查询，而是「3 年后我加一列时，会不会出事」。提前想清楚这一点再选方案，比 100T 数据已经落地之后再后悔，便宜 3 个数量级。
