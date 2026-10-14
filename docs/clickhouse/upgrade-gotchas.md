---
title: ClickHouse 版本升级避坑清单
---

# ClickHouse 版本升级避坑清单

<!-- 标题候选（按中文搜索习惯挑的，"升级"这个词必须在）：
     · ClickHouse 版本升级避坑清单
     · ClickHouse 跨版本行为变更备忘
     英文版：ClickHouse Upgrade Gotchas / Breaking Behavior Changes in ClickHouse
-->

这里记的是 ClickHouse 跨版本的行为变更。新功能不在这里，这里只收那些上个版本能用、这个版本不能用，或者改了配置却不生效的东西。会一直更新，有补充欢迎提 issue。

## 为什么要有这份东西

升级这个动作很便宜，在 ckman 上不过是点一下按钮。那个按钮是我做的，我知道它有多简单。

贵的是决定要不要按下去，而且代价几乎都藏着。merge 性能悄悄变差，默认算法换了，指标要过几天才看得出来；znode 不声不响地堆高，两个默认值一合流，Keeper 用几周时间就到了百万级；查询语法忽然不支持了，或者语义变了，不报错，只是结果不一样了。这几类都有个特点，不翻 changelog、不追源码，往往发现不了。

更麻烦的是，ClickHouse 其实做了兼容，只是兼容的成本落到了用户头上。开关往往是有的，`%M` 可以拨回分钟，`insert_deduplication_version` 在 26.7 甚至加了不迁移就拒绝启动的保护，可要发现这些开关，得去读源码。`%M` 那个开关，我是在 `FunctionFormatDateTime` 的构造函数里翻出来的，文档里没有。

所以这份清单想做的，就是把读源码才知道的事，变成查一下就能知道的事。

每条尽量写四样东西：症状、影响版本、怎么确认自己中招了、怎么处理。能追到源码和 PR 的，标出出处；只有实测结论的，就说明是实测。

---

## 按症状查

<!-- 总览表：一行一条，能扫。详情在下面展开。
     「症状」那列写用户实际会搜的话，不要写技术术语。 -->

| 症状 | 影响版本 | 类型 | 静默 | 详情 |
|---|---|---|:--:|---|
| `formatDateTime` 的分钟位置输出了月份名 | 23.4+ | 格式符语义变更 | 是 | [↓](#gotcha-formatdatetime) |
| 改了 `background_fetches_pool_size` 不生效 | 22.5+ | 配置作用域 | | [↓](#gotcha-fetches-pool) |
| 设置了 `replicated_max_parallel_fetches` 但没有任何效果 | 21.10+ | 配置废弃 | | [↓](#gotcha-deprecated-fetches) |
| S3 不可达时起不来，报「metadata 找不到」但 metadata 明明在本地 | 23.0+ | 副作用消失 | | [↓](#gotcha-skip-access-check) |
| 进程起来了、端口通了，但一查表就报错 | 24.6+ | 默认值变更 | | [↓](#gotcha-async-load) |
| 26.3 建的 text index 在 26.4 打不开，且无法 DROP | 26.3 → 26.4 | 标识符重命名 | | [↓](#gotcha-tokenizer) |
| `async_insert_deduplicate=0` 显示为关，实际仍在去重 | 26.2+ | 旧开关被架空 | 是 | [↓](#gotcha-dedup-insert) |
| Keeper znode 暴涨到百万级，`async_blocks` 占 90% | 26.2.4+ | 两次默认值叠加 | | [↓](#gotcha-async-blocks) |
| 23.8 直接升 26.3，复制异常 / 无法回退 | 23.8 → 26.3 | 升级路径约束 | | [↓](#gotcha-upgrade-path) |
| `Nullable(String)` / `Array(String)` 在回退后读不了 | 26.3 | 序列化格式 | | [↓](#gotcha-upgrade-path) |
| 22.8 升 23.8 后 merge 变得极慢 | 22.8 → 23.8 | 默认算法变更 | | [↓](#gotcha-22-8-to-23-8) |
| 升级后想回滚，旧版本读不了新写的数据 | 22.8 → 23.8 | 格式单向变更 | 是 | [↓](#gotcha-22-8-to-23-8) |
| 国产 ARM 上一跑就 SIGILL，且看不到任何原因 | 不限版本 | 指令集基线 | | [→](/clickhouse/vendor/kylin-arm-instruction-baseline) |
| 华为 MRS + HTTP：并发 INSERT 数据串到别的表 | MRS 特有 | 交互缺陷 | 是 | [→](/clickhouse/vendor/mrs-http-prepare-cache) |
| ARM + HTTP 下 clickhouse-go 批量写入内存堆积 | 不限版本 | 架构 × 协议组合 | | [↓](#gotcha-arm-http) |
| <!-- TODO --> | | | | |

「静默」那列标了「是」的，是不抛错、不中断的那几条，查询照常返回，任务照常跑完，只是结果不对。这几条**最值得在升级前逐条对一遍**，自动化链路不会替你停下来。

---

## 按版本查（升级 checklist）

<!-- 这个视图给做升级评估的人用。
     同一批条目按"从哪个版本升到哪个版本会遇到什么"重排。
     等条目攒够 15+ 条再做，现在先占位。 -->

<!-- 21.x → 22.x -->
<!-- 22.x → 23.x -->
<!-- 23.x → 24.x -->
<!-- 24.x → 25.x -->
<!-- 25.x → 26.x -->

---

## 详情

<!-- 每条的写法固定成这个格式。不要省「怎么确认」那一节 ——
     它是这份清单区别于 changelog 的地方：changelog 告诉你变了什么，
     这里告诉你怎么知道自己中招了。 -->

### <a id="gotcha-formatdatetime"></a>`formatDateTime` 的 `%M` 从「分钟」变成了「月份名」

**影响版本**：<span class="ver break">23.4</span> 及以后
**变更类型**：格式符语义变更
**是否静默**：是，不抛错、不中断，自动化链路会带着错误结果一路跑下去

| | `%M` 的含义 | 分钟怎么写 |
|---|---|---|
| < 23.4 | 分钟，`[0, 59]` | `%M` |
| ≥ 23.4 | 月份名，`January` 到 `December` | `%i` |

#### 会发生什么

升级之后，`'%Y-%m-%d %H:%M:%S'` 的输出变成：

```
2025-12-28 22:December:16
```

月份名直接杵在分钟的位置上。查询成功返回，ClickHouse 一点提示都没有。

有人盯着看，一眼就能发现；没人看的地方，比如物化视图、分区键、归档报表，就一直错下去，已经写进去的数据也不会自己改回来。

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

注释写得很清楚，取决于一个设置，`%M` 要么是 `[January-December]` 的月份，要么是 `[0-59]` 的分钟。也就是说，哪怕在最新的代码里，`%M` 仍然可以表示分钟，把开关拨回去就行。开关在构造函数里追得到：

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

就是 `formatdatetime_parsedatetime_m_is_month_name`。实测：

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

顺带说一句，上面那个构造函数一口气读了五个 `formatdatetime_*` 设置：

| 设置 | 管什么 |
|---|---|
| `formatdatetime_parsedatetime_m_is_month_name` | `%M` 是月份名还是分钟 |
| `formatdatetime_f_prints_single_zero` | `%f` 的零值输出形态 |
| `formatdatetime_f_prints_scale_number_of_digits` | `%f` 按 scale 输出位数 |
| `formatdatetime_format_without_leading_zeros` | `%c` `%k` `%l` 是否去掉前导零 |
| `formatdatetime_e_with_space_padding` | `%e` 是否空格补位 |

每个开关背后都是一次行为变更，这一族里可能还藏着别的坑。

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

一是改写法，把取分钟的 `%M` 全换成 `%i`，干净，但得改全。二是拨开关，`formatdatetime_parsedatetime_m_is_month_name = 0`，保持旧行为，存量 SQL 太多、一时改不完的时候可以这么办，升级窗口里先止血也行。

已经落进物化视图或分区键的，改定义只能管以后，存量数据要单独评估。

#### 为什么要改

为了向 MySQL 的 `DATE_FORMAT` 对齐，见 [#47246](https://github.com/ClickHouse/ClickHouse/pull/47246)。

MySQL 里 `%i` 是分钟，`%M` 是月份名，ClickHouse 以前的 `%M` 是分钟，正好和 MySQL 反着。`formatDateTime` 既然用的是 MySQL 风格的格式符，对齐也说得过去，官方并不是乱改。只是对已经在用旧写法的人来说，语义说变就变了，还没有任何提示，那个兼容开关就是给这批人留的。

#### 出处

- [#47246](https://github.com/ClickHouse/ClickHouse/pull/47246)：向 MySQL `DATE_FORMAT` 对齐

<!-- TODO: 你实际踩到这条时是怎么发现的？在哪个环节暴露的？
     静默型故障的发现过程本身就是方法论，值得单独写一段。 -->

---

### <a id="gotcha-dedup-insert"></a>`async_insert_deduplicate=0` 显示为关，实际仍在去重

**影响版本**：<span class="ver break">26.2</span> 及以后
**变更类型**：旧开关被新开关架空
**是否静默**：是，设置值显示为 0，行为却是开着的

26.2 引入了统一开关 `deduplicate_insert`，它会覆盖旧的 `insert_deduplicate` 和 `async_insert_deduplicate`。所以 `async_insert_deduplicate = 0` 这个值已经不代表实际行为了，它就是个被架空的老开关。

排障时信了它，追查就断在这儿了。新旧要一起查：

```sql
SELECT name, value, default, changed
FROM system.settings
WHERE name IN ('async_insert', 'wait_for_async_insert', 'deduplicate_insert',
               'insert_deduplicate', 'async_insert_deduplicate')
ORDER BY name;
```

官方确认见 [Issue #91596](https://github.com/ClickHouse/ClickHouse/issues/91596)。

完整的追查过程见 [126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks#我没开过异步插入)。

---

### <a id="gotcha-async-blocks"></a>Keeper znode 暴涨，90% 在 `async_blocks`

**影响版本**：<span class="ver break">v26.2.4.23-stable</span> ～ 26.5（含整个 26.3 LTS）
**变更类型**：两次默认值变更叠加

26.2 把 `deduplicate_insert` 默认改成了 `enable`，26.3 把 `async_insert` 默认打开了，还回移到了 26.2.4.17。两个默认值撞在一起，用户什么都不用做，集群就会不停地往 `async_blocks` 里写节点，每条表分片路径 10000 个，保留一周。

```
async_blocks 上限 ≈ 活跃表分片路径数 × 10000
```

606 条路径，理论上限就是 606 万 znode。现场 94 小时涨了 48.7 万，Keeper 平均延迟 165～185 ms。

止血的办法是把 `replicated_deduplication_window_for_async_inserts` 调小或者设成 0；写入方本来就攒大批的（sinker、Kafka 引擎、ETL），更好的办法是对它们的 profile 关掉 `async_insert`。根治要升到 `v26.6.1.1193-stable`，默认换成了统一 hash。

完整的追查、三种止血办法怎么选、清理时差点丢了 quorum，见 [126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks)。

---

### <a id="gotcha-arm-http"></a>ARM + HTTP：clickhouse-go 批量写入内存堆积

**影响范围**：ARM（鲲鹏 / KylinV10）+ HTTP 协议 + clickhouse-go 批量写入
**状态**：[clickhouse-go #1637](https://github.com/ClickHouse/clickhouse-go/issues/1637)，未解决

现场是 sinker 跑两个小时内存涨到 60G，可日增只有 1 亿条。pprof 看，内存集中在 `Int64` 和 `String` 的列编码上。

只有一个组合会触发：

| 架构 | 协议 | 结果 |
|---|---|---|
| x86_64 | HTTP | 正常（200M）|
| aarch64 | TCP | 稳定运行数年 |
| aarch64 | HTTP | 两小时 60G |

上游的回复是，TCP 那条路径确定做了变量复用，HTTP 那条不确定。有人推测和 ARM 的弱内存序、更大的 cache line 让 Go GC 回收不及时有关，但没有证实。

规避办法是 ARM 环境走 TCP。

完整的排查过程，以及我们一开始为什么以为 ARM 上只能用 HTTP，见 [华为 MRS 那篇](/clickhouse/vendor/huawei-mrs-protocol-trap)。

---

### <a id="gotcha-22-8-to-23-8"></a>22.8 → 23.8：merge 变慢，而且可能退不回去

**影响版本**：<span class="ver break">22.8 → 23.8</span>
**变更类型**：默认 merge 算法变更 + 存储格式单向变更

这一跳要处理两组默认值，性质完全不一样。

#### 第一组：merge 性能

```xml
<merge_max_block_size_bytes>0</merge_max_block_size_bytes>
<allow_vertical_merges_from_compact_to_wide_parts>0</allow_vertical_merges_from_compact_to_wide_parts>
```

23.x 改了默认的 merge 算法，直接升级，merge 性能会变得非常差。把这两项按上面的值固定住，就能保持 22.8 的 merge 行为。

这一组是可逆的，发现变慢了再改回来也来得及，代价只是这段时间 merge 效率低一点。

#### 第二组：回退兼容性

```xml
<compress_marks>0</compress_marks>
<compress_primary_key>0</compress_primary_key>
<ratio_of_defaults_for_sparse_serialization>1.0</ratio_of_defaults_for_sparse_serialization>
```

这一组关系到的是能不能退回去。23.x 默认会压缩 mark 文件和主键索引，对默认值占比高的列启用稀疏序列化，这些格式 22.8 都读不了。

格式类的开关管的是新写入的数据用什么格式。新版本一旦已经用新格式写了数据，再把开关关掉，已经写出去的那些 part 也救不回来，它们的 mark、主键索引、稀疏列还是新格式，旧版本照样读不了。所以这组开关**必须在新版本第一次写数据之前设好**，事后再设没用。

两组放一起对比一下：

| | 第一组 | 第二组 |
|---|---|---|
| 性质 | 性能退化 | 回退能力丧失 |
| 发现时机 | 升级后观察 merge 指标 | 可能几周后想回滚时才发现 |
| 事后补救 | 改回来即可 | 已写数据无法挽回 |
| 决策时点 | 可以边跑边调 | 必须在第一次写入前决定 |

下一跳也是一样的情况：[23.8 → 26.3 升级路径评估](/clickhouse/upgrade-23-8-to-26-3) 里有五项同类的格式单向变更，其中 25.10 的 `storage_metadata_write_full_object_key` 连开关都没有。

---

### <a id="gotcha-upgrade-path"></a>23.8 不能直接升 26.3，升了也退不回来

**影响版本**：<span class="ver break">23.8 → 26.3</span>
**变更类型**：升级路径约束 + 存储格式单向变更

升不上去，是因为 25.10 的 Keeper 变更要求来源版本不低于 23.9，25.2 把 `format_alter_operations_with_parentheses` 默认改成 true，会破坏和 24.3 之前节点的复制。能走的路径是 `23.8 LTS → 24.3 LTS → 26.3 LTS`。

退不回来，是因为 25.8、25.10、25.11、26.1、26.3 一共五项存储格式的默认值变了，其中 25.10 的 `storage_metadata_write_full_object_key` 关不掉，而且只向前兼容 25.x。回退目标最低只能到 25.x，退不到 23.8。

还有个名字容易看错：`propagate_types_serialization_versions_to_nested_types` 里的 nested 不是指 `Nested` 类型，而是容器的内部类型，`Nullable(String)`、`Array(String)` 都受影响。

完整的评估见 [23.8 → 26.3 升级路径评估](/clickhouse/upgrade-23-8-to-26-3)。

---

### <a id="gotcha-fetches-pool"></a>改了 `background_fetches_pool_size` 不生效

**影响版本**：<span class="ver break">22.5.1.20.2079</span> 及以后
**变更类型**：配置作用域
**触发条件**：从 22.5 之前升级上来，配置仍留在 `users.xml`

#### 这个参数是干什么的

fetch 线程池扫到 queue 里有任务要处理，就按顺序从 queue 里取出来执行。这是多个任务并行跑的，并行度取决于线程池有多大，由 `background_fetches_pool_size` 配置。

#### 演进

| 版本 | 变更 |
|---|---|
| <span class="ver">20.12.1.5236</span> | 引入。此前 fetch 与 merge 共用一个线程池，引入该配置的本意是把复制拉取的线程独立出来。默认值 `3` |
| <span class="ver">21.2.10.48</span> | 官方意识到 3 个线程在生产环境数据量较大时根本不够用，默认值改为 `8` |
| <span class="ver break">22.5.1.20.2079</span> | 由用户级配置提升为全局配置，此前在 `users.xml` 中修改，此后在 `config.xml` 中修改 |
| <span class="ver">23.11.1.2711</span> | 官方认为默认值 8 仍不能满足某些大数据量场景，改为 `16`，沿用至今 |

官方自己都改了好几回默认值，可见默认值不见得适合所有场景，还是得按实际数据量去调。

#### 会发生什么

22.5 以后，改在 `users.xml` 里不报错，就是不生效。看到的现象是副本同步队列一直在堆，而你以为参数已经调过了。

#### 怎么确认

改了不生效，先别问为什么不生效，先问它到底生效了没有。ClickHouse 的设置散在 `system.settings`、`system.server_settings`、`system.merge_tree_settings` 几张表里，不确定在哪张，就都查一遍。

`system.replication_queue` 的 `reason` 字段会直接写明 fetch 线程数已达上限，不用猜。

#### 怎么处理

移到 `config.xml` 的 server 级。

<!-- TODO: 补你的推荐取值 max(numcpu/4, 16) 和依据 ——
     fetch 是 IO 密集，卡在网络传输和落盘，给太多线程既抢不到额外 IO 带宽，
     还会增加上下文切换；下界取官方 23.11 的默认值。
     另外补一句判断前提：线程池满但 CPU 很闲 = 并发度问题，不是资源问题 -->

#### 出处

- ClickHouse Issue [#43351](https://github.com/ClickHouse/ClickHouse/issues/43351)：background_fetches_pool_size is capped by the profile setting

---

### <a id="gotcha-deprecated-fetches"></a>`replicated_max_parallel_fetches` 设了没用

**影响版本**：<span class="ver break">21.10</span> 及以后
**变更类型**：配置废弃

网上不少资料说设置 `replicated_max_parallel_fetches` 可以改 fetch 的并发。这个配置 21.10 以后就废弃了，能设，设了没效果。

它和上一条正好凑一对，都是改了不生效，原因却不一样。上一条是参数改对了，位置改错了；这一条是参数本身已经作废了。排查的时候，先确认自己改的那个参数在当前版本还活着。

改 `background_fetches_pool_size`，见 [上一条](#gotcha-fetches-pool)。

---

### <a id="gotcha-skip-access-check"></a>`skip_access_check` 救不了 S3 不可达

**影响版本**：<span class="ver break">23.0</span> 及以后
**变更类型**：副作用消失（22.x 上的救场能力本来是 bug，23.x 修掉了）

22.x 上，把 S3 endpoint 故意改错，再加上 `skip_access_check=true`，能让卡住的 server 起来，这个偏方在运维圈里传得很广。23.x 以后就完全不灵了，而且报错还会把人带偏，它说 S3 上的 metadata 找不到，可 `metadata_path` 明明配在本地。

原因是 ClickHouse 的 metadata 有两层，disk 级的在本地，part 级的在 S3 上。`skip_access_check` 只管启动时创建 disk 的 access check，真正卡住的是后面 attach part 那一步，那一步必须去 S3 上 GET `checksums.txt`。

跟版本无关的救法是把表的 SQL 元数据文件挪走，先启动，等 S3 恢复了再 `ATTACH`。

完整的分析见 [S3 不可达时起不来：metadata 明明在本地，它却说 S3 上找不到](/clickhouse/troubleshooting/s3-unreachable-startup)。

---

### <a id="gotcha-async-load"></a>`async_load_databases` 24.6 起默认开启

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

这份清单只收我实际踩过的，你的版本组合多半不在里面。不过默认值变更这一类，是可以自己算出来的。

### 设置散在三张表里

这是排查时最先踩的坑：改了不生效，去 `system.settings` 里一查没这个名字，就以为配错了，其实它在另一张表里。

| 表 | 管什么 |
|---|---|
| `system.settings` | 会话 / 查询级（`users.xml` 的 profile）|
| `system.merge_tree_settings` | MergeTree 表引擎级 |
| `system.server_settings` | 服务端级（`config.xml`）|

不确定就三张都查。`background_fetches_pool_size` 那个坑，说白了就是它从第一张挪到了第三张。

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

系统表自己也会变。`system.server_settings` 是 23.x 以后才有的，`is_obsolete` 这类列也是后加的，跨度大的版本做对比，先确认两边都有你要的列，不然查询直接报错。

### diff 出来之后怎么读

不是所有差异都危险，按风险从高到低：

| 差异类型 | 风险 | 说明 |
|---|:--:|---|
| 默认值变了 | 最高 | 你什么都没改，行为就变了。这份清单里绝大多数坑是这一类 |
| 设置换了表 / 作用域 | 高 | 改在旧位置不报错，只是不生效，最难查 |
| 设置被移除 | 中 | 配置里还留着的话，可能启动失败，也可能被静默忽略 |
| 设置被标记 obsolete | 中 | 可以设置，但没有效果（`replicated_max_parallel_fetches` 就是）|
| 新增设置 | 低 | 通常是新特性，不动它就没事 |

重点看前两类，尤其是那些从来没手工配过的。正因为没配过，它变了你也不会知道。

### 升级后自查：我有哪些配置已经白写了

上面那套 Docker diff 是升级前做评估用的。升级之后还有一步，简单到可以直接在生产上跑：

```sql
SELECT name, value, description
FROM system.settings
WHERE changed AND is_obsolete;
```

`changed` 是这个值被显式设过、不等于默认值，`is_obsolete` 是这个设置已经被标记废弃。两个条件一交，捞出来的就是你以为在生效、其实已经在空转的配置。ClickHouse 对这类设置通常不报错，悄悄忽略掉，精心调过的参数升完版就成了摆设，也不会有任何提示。

三张表都该过一遍：

```sql
SELECT name, value, description FROM system.settings            WHERE changed AND is_obsolete;
SELECT name, value, description FROM system.merge_tree_settings WHERE changed AND is_obsolete;
-- system.server_settings 有没有 is_obsolete 列，按你的版本确认
```

有两个限制。`system.settings` 的 `changed` 只反映当前会话，服务端级（`config.xml`）的设置在 `system.server_settings` 里，得单独查。`is_obsolete` 这一列是后加的，老版本上会直接报 `Unknown identifier`。

#### 它只覆盖三种「改了不生效」里的一种

这份清单攒到现在，改了不生效已经有三种不同的情况：

| 形态 | 例子 | 这条 SQL 捞得到吗 |
|---|---|:--:|
| 改对了参数，改错了位置 | [`background_fetches_pool_size` 22.5 挪到全局](#gotcha-fetches-pool) | 捞不到，参数还在，只是改的地方不对 |
| 参数本身已废弃 | [`replicated_max_parallel_fetches` 21.10](#gotcha-deprecated-fetches) | 捞得到 |
| 被新开关架空 | [`async_insert_deduplicate` 被 `deduplicate_insert` 覆盖](#gotcha-dedup-insert) | 捞不到，它没被标 obsolete，只是被覆盖了 |

排查的时候按这个顺序过一遍：先用这条 SQL 确认参数在当前版本还活着，再查三张表确认值真的生效了，最后把新旧开关一起查，确认它没被别的开关盖掉。

---

### 这个方法捞不到什么

下面这几类，diff 系统表是完全看不见的：

| 捞不到 | 例子 |
|---|---|
| 语义变更 | `formatDateTime` 的 `%M` 从分钟变成月份名，设置名没变，默认值也没变，变的是函数行为 |
| 函数行为与返回值 | 同上。`system.functions` 能看到增删，看不到行为 |
| 存储格式 / 序列化 | `compress_marks`、`storage_metadata_write_full_object_key` 这类，diff 出来只是一个布尔值翻了，看不出它意味着回不去了 |
| 协议与客户端行为 | 托管版的差异更是完全看不到 |
| 默认值组合效应 | 26.2 的默认去重加 26.3 的默认异步，单看每一条都平平无奇，撞在一起就是百万 znode |

所以 diff 只能帮你把要关注的候选从几千个设置缩到几十个，剩下的还得靠读 changelog、读源码，再到测试环境里实际跑一遍。

---

## 关于这份清单

这里的条目都是生产上碰到的，不是读 changelog 读出来的，每一条背后都有一次真实的排查，有的还连着一次事故。所以它不打算覆盖全部 Backward Incompatible Change，官方的 release note 已经在做这件事了，这里只收真会把人绊倒的那些。

客户信息都脱敏了，规模数字保留。

会一直更新。你要是踩到了这里没有的坑，欢迎提 issue，尤其是不报错、悄悄出错的那种，最值得写下来。
