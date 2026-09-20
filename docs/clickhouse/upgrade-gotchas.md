# ClickHouse 版本升级避坑清单

<!-- 标题候选（按中文搜索习惯挑的，"升级"这个词必须在）：
     · ClickHouse 版本升级避坑清单
     · ClickHouse 跨版本行为变更备忘
     英文版：ClickHouse Upgrade Gotchas / Breaking Behavior Changes in ClickHouse
-->

> 记录 ClickHouse 跨版本的**行为变更** —— 不是新功能，是那些「上个版本能用、这个版本不能用」「改了配置却不生效」的东西。
> 持续更新。有补充欢迎提 issue。

## 为什么需要这份东西

升级这个**动作**很便宜。在 ckman 上不过是点一下按钮 —— 那个按钮是我做的，我知道它有多简单。

**昂贵的从来不是动作，是决定要不要按下去。** 而代价几乎都是隐性的：

- **merge 性能悄悄变差** —— 默认算法换了，指标要过几天才看得出来
- **znode 静默堆高** —— 两个默认值一合流，Keeper 用几周时间走向百万级
- **查询语法忽然不支持，或者语义变了** —— 不报错，只是结果不一样了

这三类有个共同点：**不翻 changelog、不追源码，往往捉不到。**

而更麻烦的是，**ClickHouse 并不是不做兼容，是把兼容的成本转嫁给了用户。** 开关往往是存在的 —— `%M` 可以拨回分钟、`insert_deduplication_version` 甚至在 26.7 做了拒绝启动的迁移守卫 —— 但**发现这些开关的代价是读源码**。上面那个 `%M` 的开关，我是在 `FunctionFormatDateTime` 的构造函数里翻出来的，不在文档里。

所以这份清单做的事情很简单：**把「读源码才能知道的事」，变成「查一下就能知道的事」。**

每条尽量给到四样东西：症状、影响版本、**怎么确认自己中招了**、怎么处理。能追到源码和 PR 的标出出处，只有实测结论的标明是实测 —— 证据分级，别让读者替我承担判断成本。

---

## 一、按症状查

<!-- 总览表：一行一条，能扫。详情在下面展开。
     「症状」那列写用户实际会搜的话，不要写技术术语。 -->

| 症状 | 影响版本 | 类型 | 静默 | 详情 |
|---|---|---|:--:|---|
| **`formatDateTime` 的分钟位置输出了月份名** | 23.4+ | 格式符语义变更 | ⚠️ | [↓](#gotcha-formatdatetime) |
| 改了 `background_fetches_pool_size` 不生效 | 22.5+ | 配置作用域 | | [↓](#gotcha-fetches-pool) |
| 设置了 `replicated_max_parallel_fetches` 但没有任何效果 | 21.10+ | 配置废弃 | | [↓](#gotcha-deprecated-fetches) |
| S3 不可达时起不来，报「metadata 找不到」但 metadata 明明在本地 | 23.0+ | 副作用消失 | | [↓](#gotcha-skip-access-check) |
| 进程起来了、端口通了，但一查表就报错 | 24.8+ | 默认值变更 | | [↓](#gotcha-async-load) |
| 26.3 建的 text index 在 26.4 打不开，且无法 DROP | 26.3 → 26.4 | 标识符重命名 | | [↓](#gotcha-tokenizer) |
| **`async_insert_deduplicate=0` 显示为关，实际仍在去重** | 26.2+ | 旧开关被架空 | ⚠️ | [↓](#gotcha-dedup-insert) |
| Keeper znode 暴涨到百万级，`async_blocks` 占 90% | 26.2.4+ | 两次默认值叠加 | | [↓](#gotcha-async-blocks) |
| 23.8 直接升 26.3，复制异常 / 无法回退 | 23.8 → 26.3 | 升级路径约束 | | [↓](#gotcha-upgrade-path) |
| `Nullable(String)` / `Array(String)` 在回退后读不了 | 26.3 | 序列化格式 | | [↓](#gotcha-upgrade-path) |
| 22.8 升 23.8 后 merge 变得极慢 | 22.8 → 23.8 | 默认算法变更 | | [↓](#gotcha-22-8-to-23-8) |
| 升级后想回滚，旧版本读不了新写的数据 | 22.8 → 23.8 | 格式单向变更 | ⚠️ | [↓](#gotcha-22-8-to-23-8) |
| 国产 ARM 上一跑就 SIGILL，且看不到任何原因 | 不限版本 | 指令集基线 | | [→](/clickhouse/vendor/kylin-arm-instruction-baseline) |
| **华为 MRS + HTTP：并发 INSERT 数据串到别的表** | MRS 特有 | 交互缺陷 | ⚠️ | [→](/clickhouse/vendor/mrs-http-prepare-cache) |
| ARM + HTTP 下 clickhouse-go 批量写入内存堆积 | 不限版本 | 架构 × 协议组合 | | [↓](#gotcha-arm-http) |
| <!-- TODO --> | | | | |

> **「静默」那列标 ⚠️ 的，是不抛错、不中断的那几条 —— 查询照常返回、任务照常跑完，只是结果不对。**
> 这类最值得在升级前逐条对，因为自动化链路不会替你停下来。

---

## 二、按版本查（升级 checklist）

<!-- 这个视图给做升级评估的人用。
     同一批条目按"从哪个版本升到哪个版本会遇到什么"重排。
     等条目攒够 15+ 条再做，现在先占位。 -->

<!-- 21.x → 22.x -->
<!-- 22.x → 23.x -->
<!-- 23.x → 24.x -->
<!-- 24.x → 25.x -->
<!-- 25.x → 26.x -->

---

## 三、详情

<!-- 每条的写法固定成这个格式。不要省「怎么确认」那一节 ——
     它是这份清单区别于 changelog 的地方：changelog 告诉你变了什么，
     这里告诉你怎么知道自己中招了。 -->

### <a id="gotcha-formatdatetime"></a>`formatDateTime` 的 `%M` 从「分钟」变成了「月份名」

**影响版本**：<span class="ver break">23.4</span> 及以后
**变更类型**：格式符语义变更
**是否静默**：⚠️ **不抛错、不中断。** 自动化链路会带着错误结果一路跑下去

| | `%M` 的含义 | 分钟怎么写 |
|---|---|---|
| < 23.4 | **分钟**，`[0, 59]` | `%M` |
| ≥ 23.4 | **月份名**，`January`–`December` | `%i` |

#### 会发生什么

升级之后，`'%Y-%m-%d %H:%M:%S'` 的输出变成：

```
2025-12-28 22:December:16
```

月份名直接杵在分钟的位置上。查询**成功返回**，ClickHouse 不给任何提示。

有人盯着看就立刻发现；没人看的地方 —— 物化视图、分区键、归档报表 —— 就一直错下去，而且**已经写进去的数据不会自己修**。

#### 但它有开关

读一下 `FunctionFormatDateTime` 的源码，分支写得很明白：

```cpp
// Depending on a setting
// - Full month [January-December] OR
// - Minute of hour range [0, 59]
case 'M':
{
    Instruction<T> instruction;
    if (mysql_M_is_month_name)
    {
        instruction.setMysqlFunc(&Instruction<T>::mysqlMonthOfYearTextLong);
        instructions.push_back(std::move(instruction));
        out_template += "September"; /// longest possible month name
    }
    else
    {
        static constexpr std::string_view val = "00";
        add_time_instruction(&Instruction<T>::mysqlMinute, val);
        out_template += val;
    }
    break;
}
```

这个注释挺意味深长 —— **依赖配置，表示 `[January-December]` 的月份，或者 `[0-59]` 的分钟。**

也就是说，**即使在最新代码里，`%M` 仍然可以表示分钟**，只要把开关拨回去。开关从构造函数追得到：

```cpp
explicit FunctionFormatDateTimeImpl(ContextPtr context)
    : mysql_M_is_month_name(context->getSettingsRef()[Setting::formatdatetime_parsedatetime_m_is_month_name])
    , mysql_f_prints_single_zero(context->getSettingsRef()[Setting::formatdatetime_f_prints_single_zero])
    , mysql_f_prints_scale_number_of_digits(context->getSettingsRef()[Setting::formatdatetime_f_prints_scale_number_of_digits])
    , mysql_format_ckl_without_leading_zeros(context->getSettingsRef()[Setting::formatdatetime_format_without_leading_zeros])
    , mysql_e_with_space_padding(context->getSettingsRef()[Setting::formatdatetime_e_with_space_padding])
{
}
```

即 **`formatdatetime_parsedatetime_m_is_month_name`**。实测：

```sql
SELECT formatDateTime(now(), '%Y-%m-%d %H:%M:%S')
SETTINGS formatdatetime_parsedatetime_m_is_month_name = 0
```

```
   ┌─formatDateTi⋯ %H:%M:%S')─┐
1. │ 2025-12-28 22:49:16      │
   └──────────────────────────┘
```

分钟回来了。

::: tip 顺带：这不止一个开关
上面那个构造函数一口气读了五个 `formatdatetime_*` 设置：

| 设置 | 管什么 |
|---|---|
| `formatdatetime_parsedatetime_m_is_month_name` | `%M` 是月份名还是分钟 |
| `formatdatetime_f_prints_single_zero` | `%f` 的零值输出形态 |
| `formatdatetime_f_prints_scale_number_of_digits` | `%f` 按 scale 输出位数 |
| `formatdatetime_format_without_leading_zeros` | `%c` `%k` `%l` 是否去掉前导零 |
| `formatdatetime_e_with_space_padding` | `%e` 是否空格补位 |

**有开关，说明每一个都对应过一次行为变更。** 这一族里可能还藏着别的坑。
:::

#### 怎么确认

升级前全量检索，重点是会固化进表定义的那些：

```sql
SELECT database, name, engine, create_table_query
FROM system.tables
WHERE create_table_query ILIKE '%formatDateTime%'
  AND create_table_query LIKE '%\%M%';
```

应用侧 SQL 和 BI 报表里的 ClickHouse 看不见，得另外捞。

#### 怎么处理

两条路，看你的处境：

1. **改写法**：把取分钟语义的 `%M` 全部换成 `%i`。干净，但要改全。
2. **拨开关**：`formatdatetime_parsedatetime_m_is_month_name = 0`，保持旧行为。适合存量 SQL 太多、一时改不完的场景，也适合升级窗口里先止血。

已经落进物化视图或分区键的，改定义只能止血 —— **存量数据要单独评估**。

#### 为什么要改

**向 MySQL 的 `DATE_FORMAT` 对齐** —— 见 [#47246](https://github.com/ClickHouse/ClickHouse/pull/47246)。

MySQL 里 `%i` 就是分钟、`%M` 是月份名，ClickHouse 此前的 `%M`（分钟）和 MySQL 语义相反。既然 `formatDateTime` 走的是 MySQL 风格的格式符，对齐是合理的 —— 但对已经在用旧语义的人来说，这是一次无声的语义翻转。

**所以这条不是官方乱改，是一次迟到的对齐。** 那个兼容开关就是为这批人准备的。

#### 出处

- [#47246](https://github.com/ClickHouse/ClickHouse/pull/47246) — 向 MySQL `DATE_FORMAT` 对齐

<!-- TODO: 你实际踩到这条时是怎么发现的？在哪个环节暴露的？
     静默型故障的发现过程本身就是方法论，值得单独写一段。 -->

---

### <a id="gotcha-dedup-insert"></a>`async_insert_deduplicate=0` 显示为关，实际仍在去重

**影响版本**：<span class="ver break">26.2</span> 及以后
**变更类型**：旧开关被新开关架空
**是否静默**：⚠️ **是。设置值显示为 0，行为却是开启的。**

26.2 引入统一开关 `deduplicate_insert`，它**覆盖**旧的 `insert_deduplicate` 和 `async_insert_deduplicate`。也就是说 —— `async_insert_deduplicate = 0` 这个值**已经不代表实际行为**，它只是一个被架空的历史遗留开关。

排障时如果信了它，追查会在这里断掉。必须**新旧一起查**：

```sql
SELECT name, value, default, changed
FROM system.settings
WHERE name IN ('async_insert', 'wait_for_async_insert', 'deduplicate_insert',
               'insert_deduplicate', 'async_insert_deduplicate')
ORDER BY name;
```

官方确认见 [Issue #91596](https://github.com/ClickHouse/ClickHouse/issues/91596)。

→ **[完整追查过程](/clickhouse/troubleshooting/keeper-async-blocks#第四幕-我没开过异步插入-它凭什么在跑)**

---

### <a id="gotcha-async-blocks"></a>Keeper znode 暴涨，90% 在 `async_blocks`

**影响版本**：<span class="ver break">v26.2.4.23-stable</span> ～ 26.5（含整个 **26.3 LTS**）
**变更类型**：两次默认值变更叠加

**26.2** 把 `deduplicate_insert` 默认改为 `enable`，**26.3** 把 `async_insert` 默认开启（并回移到 26.2.4.17）。两个默认值合流之后，**用户什么都不用做**，集群就会持续往 `async_blocks` 写节点 —— 每条表分片路径 10000 个，保留**一周**。

```
async_blocks 上限 ≈ 活跃表分片路径数 × 10000
```

606 条路径 = 606 万 znode 的理论上限。现场实测 94 小时涨 48.7 万，Keeper 平均延迟 165～185 ms。

**止血**：把 `replicated_deduplication_window_for_async_inserts` 调小或设 0；若写入方本来就攒大批（sinker / Kafka 引擎 / ETL），更优解是对该 profile 关掉 `async_insert`。

**根治**：升到 `v26.6.1.1193-stable`，默认切换统一 hash。

→ **[126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks)** —— 完整追查、三个止血方案的取舍、清理时差点丢 quorum 的教训

---

### <a id="gotcha-arm-http"></a>ARM + HTTP：clickhouse-go 批量写入内存堆积

**影响范围**：ARM（鲲鹏 / KylinV10）+ HTTP 协议 + clickhouse-go 批量写入
**状态**：[clickhouse-go #1637](https://github.com/ClickHouse/clickhouse-go/issues/1637)，**未解决**

现场表现：sinker 运行两小时内存涨到 **60G**，而日增只有 1 亿条。pprof 显示内存集中在 `Int64` 和 `String` 的列编码上。

**只有这一个组合会触发：**

| 架构 | 协议 | 结果 |
|---|---|---|
| x86_64 | HTTP | ✅ 正常（200M）|
| aarch64 | TCP | ✅ 稳定运行数年 |
| **aarch64** | **HTTP** | 🔴 **两小时 60G** |

上游回复：TCP 路径确定使用了变量复用，**HTTP 路径不确定**。推测与 ARM 的弱内存序和更大的 cache line 导致 Go GC 回收不及时有关，但未经证实。

**规避方式：ARM 环境走 TCP 协议。**

→ **[完整排查过程](/clickhouse/vendor/huawei-mrs-protocol-trap)** —— 以及为什么我们一开始以为 ARM 上只能用 HTTP

---

### <a id="gotcha-22-8-to-23-8"></a>22.8 → 23.8：merge 变慢，而且可能退不回去

**影响版本**：<span class="ver break">22.8 → 23.8</span>
**变更类型**：默认 merge 算法变更 + 存储格式单向变更

这一跳要处理**两组性质完全不同**的默认值。

#### 第一组：merge 性能

```xml
<merge_max_block_size_bytes>0</merge_max_block_size_bytes>
<allow_vertical_merges_from_compact_to_wide_parts>0</allow_vertical_merges_from_compact_to_wide_parts>
```

23.x 改了默认的 merge 算法。**直接升级，merge 性能会变得非常差。** 把这两项按上面的值固定住，可以保持 22.8 的 merge 行为。

这组是**可逆**的 —— 发现变慢了再改回来也来得及，代价只是这段时间 merge 效率低。

#### 第二组：回退兼容性 ⚠️

```xml
<compress_marks>0</compress_marks>
<compress_primary_key>0</compress_primary_key>
<ratio_of_defaults_for_sparse_serialization>1.0</ratio_of_defaults_for_sparse_serialization>
```

**这组不是性能问题，是回退能力问题。** 23.x 默认会压缩 mark 文件和主键索引，并对高默认值占比的列启用稀疏序列化 —— **这些格式 22.8 读不了。**

::: danger 这组开关必须在升级前设，事后设无效
格式类开关控制的是**「新写入的数据用什么格式」**。

一旦新版本已经用新格式写了数据，**再把开关关掉也救不回已经写出去的部分** —— 那些 part 的 mark、主键索引、稀疏列仍然是新格式，旧版本依旧读不了。

所以判断标准不是「升级时要不要设」，而是 **「新版本第一次写数据之前有没有设」**。
:::

#### 两组的区别，是升级评估里最该分清的一件事

| | 第一组 | 第二组 |
|---|---|---|
| 性质 | 性能退化 | **回退能力丧失** |
| 发现时机 | 升级后观察 merge 指标 | **可能几周后想回滚时才发现** |
| 事后补救 | 改回来即可 | **已写数据无法挽回** |
| 决策时点 | 可以边跑边调 | **必须在第一次写入前决定** |

**→ 同样的结构在下一跳重演**：[23.8 → 26.3 升级路径评估](/clickhouse/upgrade-23-8-to-26-3) 里有五项同类的格式单向变更，其中 25.10 的 `storage_metadata_write_full_object_key` **连开关都没有**。

---

### <a id="gotcha-upgrade-path"></a>23.8 不能直接升 26.3，升了也退不回来

**影响版本**：<span class="ver break">23.8 → 26.3</span>
**变更类型**：升级路径约束 + 存储格式单向变更

**升不上去**：25.10 的 Keeper 变更要求来源版本 ≥ 23.9；25.2 的 `format_alter_operations_with_parentheses` 默认 true 会破坏与 24.3 之前节点的复制。可行路径是 `23.8 LTS → 24.3 LTS → 26.3 LTS`。

**退不回来**：25.8 / 25.10 / 25.11 / 26.1 / 26.3 共五项存储格式默认值变更，其中 **25.10 的 `storage_metadata_write_full_object_key` 不可关闭**，且只向前兼容 25.x。**回退目标最低只能到 25.x，不能是 23.8。**

⚠️ `propagate_types_serialization_versions_to_nested_types` 里的 nested **不是指 `Nested` 类型**，而是容器内部类型 —— `Nullable(String)`、`Array(String)` 都受影响。

→ **[完整评估：23.8 → 26.3 升级路径](/clickhouse/upgrade-23-8-to-26-3)**

---

### <a id="gotcha-fetches-pool"></a>改了 `background_fetches_pool_size` 不生效

**影响版本**：<span class="ver break">22.5.1.20.2079</span> 及以后
**变更类型**：配置作用域
**触发条件**：从 22.5 之前升级上来，配置仍留在 `users.xml`

#### 这个参数是干什么的

fetch 的线程池扫描到 queue 中有任务需要处理时，会按顺序从 queue 里取任务执行。这个过程是多任务并行的，**并行度取决于线程池的大小**，由 `background_fetches_pool_size` 配置。

#### 演进

| 版本 | 变更 |
|---|---|
| <span class="ver">20.12.1.5236</span> | 引入。此前 fetch 与 merge 共用一个线程池，引入该配置的本意是把复制拉取的线程独立出来。默认值 `3` |
| <span class="ver">21.2.10.48</span> | 官方意识到 3 个线程在生产环境数据量较大时根本不够用，默认值改为 `8` |
| <span class="ver break">22.5.1.20.2079</span> | **由用户级配置提升为全局配置** —— 此前在 `users.xml` 中修改，此后在 `config.xml` 中修改 |
| <span class="ver">23.11.1.2711</span> | 官方认为默认值 8 仍不能满足某些大数据量场景，改为 `16`，沿用至今 |

**从官方反复调整默认值这件事本身可以看出：所谓默认值并不一定适用于所有场景，应该根据实际数据量动态调整。**

#### 会发生什么

22.5 之后，改在 `users.xml` 里**不报错**，只是不生效。表现为副本同步队列持续堆积，而你以为参数已经调过了。

#### 怎么确认

先查值到底有没有生效 —— 改了不生效，先别问「为什么不生效」，先问「它到底生效了没有」。ClickHouse 的 settings 散在 `system.settings`、`system.server_settings`、`system.merge_tree_settings` 几张表里，不确定就都查一遍。

`system.replication_queue` 的 `reason` 字段会直接写明 fetch 线程数已达上限，不用猜。

#### 怎么处理

移到 `config.xml` 的 server 级。

<!-- TODO: 补你的推荐取值 max(numcpu/4, 16) 和依据 ——
     fetch 是 IO 密集，卡在网络传输和落盘，给太多线程既抢不到额外 IO 带宽，
     还会增加上下文切换；下界取官方 23.11 的默认值。
     另外补一句判断前提：线程池满但 CPU 很闲 = 并发度问题，不是资源问题 -->

#### 出处

- ClickHouse Issue [#43351](https://github.com/ClickHouse/ClickHouse/issues/43351) — background_fetches_pool_size is capped by the profile setting

---

### <a id="gotcha-deprecated-fetches"></a>`replicated_max_parallel_fetches` 设了没用

**影响版本**：<span class="ver break">21.10</span> 及以后
**变更类型**：配置废弃

网上不少资料说设置 `replicated_max_parallel_fetches` 可以修改 fetch 的并发。**该配置在 21.10 之后已经过时，不再使用 —— 你可以设置，但设置后没有效果。**

这条和上一条构成一对：同样是「改了不生效」，但原因完全不同 —— 上一条是改对了参数、改错了位置，这一条是参数本身已经作废。排查时值得先确认自己改的那个参数在当前版本还活着。

改 `background_fetches_pool_size`，见 [上一条](#gotcha-fetches-pool)。

---

### <a id="gotcha-skip-access-check"></a>`skip_access_check` 救不了 S3 不可达

**影响版本**：<span class="ver break">23.0</span> 及以后
**变更类型**：副作用消失（22.x 的救场能力本是 bug，23.x 修掉了）

22.x 上「把 S3 endpoint 故意改错 + `skip_access_check=true`」能让卡住的 server 起来，这个偏方在运维圈广为流传。**23.x 之后完全失效**，而且报错信息会把你带偏 —— 它说「S3 上的 metadata 找不到」，但你的 `metadata_path` 明明配在本地。

原因是 ClickHouse 的 metadata 有**两层**：disk-level 在本地，part-level 在 S3 上。`skip_access_check` 只影响启动流程的第 2 步（access check），而真正卡住的是第 5 步（part attach），那一步必须 GET S3 上的 `checksums.txt`。

**版本无关的救援姿势**：物理移走表的 SQL 元数据文件，启动，等 S3 恢复后再 `ATTACH`。

→ **[完整分析：metadata 明明在本地，为什么 ClickHouse 说 S3 上找不到](/clickhouse/troubleshooting/s3-unreachable-startup)**

---

### <a id="gotcha-async-load"></a>`async_load_databases` 24.8 起默认开启

<!-- TODO 按格式填。核心结论先写出来：
     「起来了」≠「可用了」。进程起了、端口通了、探活绿了，但表还没加载完，一查就报错。
     这比起不来更危险 —— 它骗过了所有常规健康检查。
     
     立场要写清楚：异步加载本身没问题，甚至好用（大集群启动快、S3 不可达也不卡死）。
     缺的是配套的可观测性。
     任何把同步变异步的改动，都在制造一个新的中间状态；不配套观测，
     就是用"明确的失败"换"模糊的成功"。
     
     怎么确认：system.asynchronous_loader -->

---

### <a id="gotcha-tokenizer"></a>text index 的 tokenizer / 索引名改过三次

<!-- TODO 按格式填。要点：
     · 26.3 发布次日，unicode_word 在 master 被改名为 asciiCJK
     · 26.3 建的 text index 在 26.4 无法加载
     · 附表校验拒绝未知 tokenizer，连 DROP INDEX 都执行不了 —— 表进去就出不来
     · 26.3 的 changelog 描述的是一个该版本从未包含的 tokenizer 名字
     · 链 issue #112711 和修复 PR #113061 -->

---

### <!-- TODO: 你手上那批硬货，按同样格式往下加 -->

---

## 没找到你那条？自己捞

这份清单只收录我实际踩过的。**你的版本组合大概率不在里面** —— 但默认值变更这一类，是可以自己算出来的。

### 设置散在三张表里

这是排查时最先踩的坑：改了不生效，去查 `system.settings` 发现没这个名字，就以为配错了 —— 其实它在另一张表里。

| 表 | 管什么 |
|---|---|
| `system.settings` | 会话 / 查询级（`users.xml` 的 profile）|
| `system.merge_tree_settings` | MergeTree 表引擎级 |
| `system.server_settings` | 服务端级（`config.xml`）|

**不确定就三张都查。** 而 `background_fetches_pool_size` 那条坑的本质，就是它从第一张挪到了第三张。

### 导出两个版本，diff 一下

```bash
for v in 23.8 24.3 26.3; do
  docker run --rm clickhouse/clickhouse-server:$v \
    clickhouse local --query "
      SELECT name, toString(\`default\`) AS def, type
      FROM system.settings ORDER BY name FORMAT TSV
    " > settings-$v.tsv
done

diff settings-23.8.tsv settings-26.3.tsv
```

`system.merge_tree_settings` 同理。`system.server_settings` 可能需要起完整 server 而不是 `local`，按你的版本试。

::: warning 系统表自己也会变
`system.server_settings` 是 23.x 之后才有的，`is_obsolete` 这类列也是后加的 —— **跨度大的版本对比时，先确认两边都有你要的列**，否则查询直接报错。

这件事本身有点讽刺：**你要用来排查版本差异的工具，自己也有版本差异。**
:::

### diff 出来之后怎么读

不是所有差异都危险。按风险排：

| 差异类型 | 风险 | 说明 |
|---|:--:|---|
| **默认值变了** | 🔴 **最高** | 你什么都没改，行为就变了。本清单里绝大多数坑属于这一类 |
| **设置换了表 / 作用域** | 🔴 高 | 改在旧位置**不报错，只是不生效** —— 最难查的一种 |
| 设置被移除 | 🟡 中 | 配置里还留着的话，可能启动失败，也可能被静默忽略 |
| 设置被标记 obsolete | 🟡 中 | 可以设置，但没有效果（`replicated_max_parallel_fetches` 就是）|
| 新增设置 | 🟢 低 | 通常是新特性，不动它就没事 |

**重点看前两类。** 尤其是那些你从来没手工配过的 —— 正因为没配过，它变了你也不会知道。

### 升级后自查：我有哪些配置已经白写了

上面那套 Docker diff 是**升级前**做评估的。升级**之后**还有一步，门槛低到可以立刻在生产上跑：

```sql
SELECT name, value, description
FROM system.settings
WHERE changed AND is_obsolete;
```

- `changed` —— 这个值被显式设过，不等于默认
- `is_obsolete` —— 这个设置已被标记废弃

两个条件一交，捞出来的就是：**你以为在生效、实际已经是空转的配置。**

ClickHouse 对这类设置通常**不报错，只是静默忽略** —— 所以你精心调过的参数在升完版之后变成 no-op，不会有任何提示。

三张表都该过一遍：

```sql
SELECT name, value, description FROM system.settings            WHERE changed AND is_obsolete;
SELECT name, value, description FROM system.merge_tree_settings WHERE changed AND is_obsolete;
-- system.server_settings 有没有 is_obsolete 列，按你的版本确认
```

::: warning 两个限制
1. **`system.settings` 的 `changed` 只反映当前会话上下文。** 服务端级（`config.xml`）的设置在 `system.server_settings` 里，要单独查。
2. **`is_obsolete` 这列是后加的**，老版本上会直接报 `Unknown identifier` —— 又一次撞上「用来排查版本差异的工具，自己也有版本差异」。
:::

#### 它只覆盖三种「改了不生效」里的一种

这份清单攒到现在，「改了不生效」已经有三种不同的形态：

| 形态 | 例子 | 这条 SQL 捞得到吗 |
|---|---|:--:|
| 改对了参数，**改错了位置** | [`background_fetches_pool_size` 22.5 挪到全局](#gotcha-fetches-pool) | ❌ 参数还在，只是你改的地方不对 |
| **参数本身已废弃** | [`replicated_max_parallel_fetches` 21.10](#gotcha-deprecated-fetches) | ✅ |
| **被新开关架空** | [`async_insert_deduplicate` 被 `deduplicate_insert` 覆盖](#gotcha-dedup-insert) | ❌ 它没被标 obsolete，只是被覆盖了 |

**排查时值得按这三种顺序过一遍**：先确认参数在当前版本还活着（这条 SQL），再确认改对了地方（查三张表看值有没有生效），最后确认它没被别的开关覆盖（新旧开关一起查）。

---

### ⚠️ 这个方法捞不到什么

**知道一个方法的盲区，比知道它能做什么更重要。** 以下几类 diff 系统表完全看不见：

| 捞不到 | 例子 |
|---|---|
| **语义变更** | `formatDateTime` 的 `%M` 从分钟变月份名 —— 设置名没变、默认值没变，**变的是函数行为** |
| **函数行为与返回值** | 同上。`system.functions` 能看到增删，看不到行为 |
| **存储格式 / 序列化** | `compress_marks`、`storage_metadata_write_full_object_key` 这类，diff 得到的只是一个布尔值翻转，**看不出它意味着"回不去了"** |
| **协议与客户端行为** | 托管版的差异更是完全不可见 |
| **默认值组合效应** | 26.2 的默认去重 + 26.3 的默认异步，**单看每一条都平平无奇，撞一起才是百万 znode** |

所以它是**起点，不是终点**：帮你把「需要关注的候选」从几千个设置收敛到几十个，剩下的判断还得靠读 changelog、读源码，以及在测试环境实际跑一遍。

---

## 关于这份清单

这里的条目**来自一线生产，不是读 changelog 读出来的** —— 每一条背后都有一次真实的排查，有些还附带着一次事故。所以它不追求覆盖全部 Backward Incompatible Change（官方 release note 已经在做那件事），只收录**会真的把人绊倒**的那些。

客户信息均已脱敏，规模数字保留。

持续更新。如果你踩到了这里没有的坑，欢迎提 issue 补充 —— 尤其是**静默型**的那些，它们最值得被写下来。
