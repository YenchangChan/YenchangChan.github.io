---
title: text 索引的 GRANULARITY：写了 1，为什么变成一亿
description: 从 SQL 解析和倒排索引布局解释 ClickHouse 为什么忽略 text 索引的用户粒度，以及 whole-part 索引为什么仍能定位候选行。
---

# text 索引的 GRANULARITY：写了 1，为什么变成一亿

建表时明明写的是：

```sql
INDEX content_idx content
TYPE text(tokenizer = splitByNonAlpha)
GRANULARITY 1
```

执行 `SHOW CREATE TABLE`，却变成了 `GRANULARITY 100000000`。

第一反应很容易是：ClickHouse 把索引粒度调大了一亿倍，还能跳过数据吗？但对 `text` 索引来说，这个数字表达的是另一件事：**倒排索引按整个 data part 组织，用户填写的 `GRANULARITY` 会被忽略。** 它没有根据行数、字段基数或 token 数量自动调参。

本文在 **ClickHouse local 26.3.3.20 官方构建**上验证了小写 `TYPE text` 的建表和元数据结果。源码解释固定到上游 commit [`1d607cb1acf3`](https://github.com/ClickHouse/ClickHouse/tree/1d607cb1acf38d775f27ecdc8fd263082a921a8e)。文末的大写类型问题来自上游修复与回归测试，没有在本机复现；对应的发行版修复范围也未核实，不能把这份源码当成所有 26.3 构建的行为。

## 先看单位：一亿个 granule，不是一亿行

跳数索引的 `GRANULARITY` 表示一个索引 granule 覆盖多少个 MergeTree 数据 granule。mark 用来定位这些数据 granule，平时也常用“多少个 mark”来描述这个跨度。

在每个数据 granule 约有 8192 行的情况下：

| 索引定义 | 一个索引 granule 大致覆盖 |
|---|---:|
| `minmax GRANULARITY 1` | 8192 行 |
| `minmax GRANULARITY 4` | 32768 行 |
| `GRANULARITY 100000000` | 8192 亿行 |

这是帮助理解量级的换算。实际行数还受自适应粒度和 `index_granularity_bytes` 影响，不能拿 8192 当成每个 granule 的固定行数。

一亿个数据 granule 已经远大于正常单个 part 的规模。用这么大的粒度，实际效果就是：一个 part 结束时，整个 text 索引仍属于同一个索引 granule。**范围是单个 part，不是整张表，也不是整个分区。**

## SQL 解析时，1 就被改掉了

源码在 [`ASTIndexDeclaration.h`](https://github.com/ClickHouse/ClickHouse/blob/1d607cb1acf38d775f27ecdc8fd263082a921a8e/src/Parsers/ASTIndexDeclaration.h#L18) 中定义了固定值：

```cpp
static constexpr auto DEFAULT_TEXT_INDEX_GRANULARITY = 100'000'000uz;
```

[`getSecondaryIndexGranularity`](https://github.com/ClickHouse/ClickHouse/blob/1d607cb1acf38d775f27ecdc8fd263082a921a8e/src/Parsers/ASTIndexDeclaration.cpp#L224) 的关键判断如下，省略了其他索引类型的分支：

```cpp
const String type_name = type ? Poco::toLower(type->name) : String{};

if (type_name == "text")
    return ASTIndexDeclaration::DEFAULT_TEXT_INDEX_GRANULARITY;

if (granularity)
    return granularity->as<ASTLiteral &>().value.safeGet<UInt64>();
```

顺序决定了行为：先判断是不是 `text`，再读取用户指定的粒度。只要进入第一个分支，写 1、64 还是 999 都不会影响返回值。

建表解析器读取 `GRANULARITY` 后，就把这个函数的结果赋给索引 AST 的 `granularity` 字段，见 [`ParserCreateQuery.cpp`](https://github.com/ClickHouse/ClickHouse/blob/1d607cb1acf38d775f27ecdc8fd263082a921a8e/src/Parsers/ParserCreateQuery.cpp#L205)。因此，不需要等到插入数据或后台 merge，刚建好的空表就能在 `SHOW CREATE TABLE` 中看到一亿。

虽然常量名字里有 `DEFAULT`，这里却不只是“没填才使用默认值”。对于 text 索引，它会覆盖显式输入。

## 覆盖整个 part，为什么还找得到行

普通 `minmax` 索引保存的是一段数据的摘要。假设三个索引 granule 的价格范围分别是：

```text
granule 0: [1,   100]
granule 1: [101, 200]
granule 2: [201, 300]
```

查询 `price = 150`，可以排除第 0 和第 2 段。要是整个 part 只记一个 `[1, 300]`，索引就没法在 part 内继续区分这些范围。普通跳数索引的粒度会直接影响这种排除能力。

text 索引保存的信息更具体。它的倒排列表（posting list）可以理解为：

```text
一个 part 内：
"clickhouse" -> [1, 8, 15, 42]
"database"   -> [2, 8, 31]
"index"      -> [5, 15, 31, 42]
```

数字是 part 内部的行号，不是表的业务主键。查找 token 时，索引已经能给出候选行；多个 token 的条件还可以通过倒排列表的组合来收窄候选集合。它不需要靠“每 8192 行再切一份索引”才获得这种信息。

所以，**索引覆盖整个 part，不等于命中一个 token 就必须扫描整个 part。** 不过，能定位候选行也不代表所有查询都只读这些行：实际读取仍受数据块布局、查询执行路径以及是否需要回列校验影响。token 出现在哪一行，与多个词是否相邻，也不是同一个问题。

[日志检索三家实测](/clickhouse/comparison/log-search-ck-doris-es)里讨论了短语检索和读取量，这里解释的是索引的组织范围，不能据此推导所有文本查询的性能。

## whole-part 是布局约定，不是可随意调小的参数

[`MergeTreeIndexText.h`](https://github.com/ClickHouse/ClickHouse/blob/1d607cb1acf38d775f27ecdc8fd263082a921a8e/src/Storages/MergeTree/MergeTreeIndexText.h#L35) 的类注释把这种布局称为无限粒度，并说明 text 索引可以在 data part 合并时合并已有索引，而不是重新构建。

从数据结构上也能理解这项选择：如果按每个数据 granule 单独建词典，同一个高频 token 可能反复出现在多份词典里；按 part 组织则有机会减少这种重复。这是理解设计的一个角度，不能直接当成压缩率或查询延迟的实测结论。倒排列表内部仍可分块，whole-part 也不意味着查询时必须把整个索引一次读入内存。

更直接的约束是：**元数据里的粒度必须与索引文件的布局一致。** 上游曾修复过一个大小写问题，恰好说明这件事。

修复前，粒度判断直接比较小写字符串 `text`。用户写成大写 `TYPE TEXT` 时，这一步没有命中，显式填写的 `GRANULARITY 1` 被保留；后续处理却仍把它识别为 text 索引，文件按 whole-part 布局写入。

读取方按小粒度期待多份 mark，文件却按整个 part 写了一份。上游[修复提交](https://github.com/ClickHouse/ClickHouse/commit/6a356549b50c2f00bd0072a4eb9d57b51cf0192d)和[回归测试](https://github.com/ClickHouse/ClickHouse/blob/1d607cb1acf38d775f27ecdc8fd263082a921a8e/tests/queries/0_stateless/02346_text_index_uppercase_type_granularity.sql)记录了两类后果：mark cache 预热报 `CANNOT_READ_ALL_DATA` 或 `CORRUPTED_DATA`，以及使用索引的查询比全表扫描返回更少的行。

前面源码里的 `Poco::toLower` 就是这项修复的关键。这里能确认修复机制和对应提交，尚未确认它被回移到了哪些发行版。检查具体环境时，应核对自己的版本与表元数据，不能仅凭 `26.3` 这样的版本前缀判断是否包含修复。

至于为什么偏偏是一亿，而不是 `UInt64` 最大值，本文核对的代码没有给出选值理由。能够确认的是：它用一个有限的大整数表达实践中的 whole-part 粒度。再往下解释为避免溢出或某种性能权衡，就需要额外的设计记录。

## 在自己的版本上验证

下面是本次在独立临时目录中运行的 `clickhouse local` SQL。某些版本仍要求打开实验开关，本次验证显式开启了它。复现表名需未被占用。

```sql
SELECT version();

SET allow_experimental_full_text_index = 1;

CREATE TABLE text_index_demo
(
    id UInt64,
    content String,
    INDEX content_idx content
        TYPE text(tokenizer = splitByNonAlpha)
        GRANULARITY 1
)
ENGINE = MergeTree
ORDER BY id;

SHOW CREATE TABLE text_index_demo;

SELECT name, type, granularity
FROM system.data_skipping_indices
WHERE database = currentDatabase()
  AND table = 'text_index_demo';
```

本机返回版本 `26.3.3.20`，`SHOW CREATE TABLE` 中的索引定义为：

```sql
INDEX content_idx content
TYPE text(tokenizer = splitByNonAlpha)
GRANULARITY 100000000
```

系统表结果也一致：

```text
content_idx    text    100000000
```

本次实测只验证了小写 text 索引的建表与元数据改写，没有测索引查询性能、merge 行为或大写类型故障。上游另有[默认粒度测试](https://github.com/ClickHouse/ClickHouse/blob/1d607cb1acf38d775f27ecdc8fd263082a921a8e/tests/queries/0_stateless/02346_text_index_default_granularity.sql)，覆盖不同创建路径。

遇到这个数字时，先确认索引类型和版本。对这里验证过的小写 `text` 而言，把 `GRANULARITY 1` 改成 4 或 64 都不会改变最终粒度；应当根据实际查询去检查分词器、谓词能否使用索引，以及回列读取的成本。
