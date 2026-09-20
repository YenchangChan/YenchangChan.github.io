---
title: 并发 INSERT 串表：HTTP 下 prepare 语句的缓存陷阱
---

# 并发 INSERT 串表：HTTP 下 prepare 语句的缓存陷阱

> 华为 MRS 的 ClickHouse，HTTP 协议下多条不同的 INSERT 并发写入时，**数据会落到错误的表上**。
>
> 官方版本复现不出来。

## 症状

两条结构不同的 INSERT 并发执行：

```sql
INSERT INTO a VALUES (c1, c2);
INSERT INTO b VALUES (c3, c4, c5);
```

结果：**表 `b` 收到的是 `c1, c2`** —— 属于表 `a` 的那份数据。

::: danger 它可不可见，取决于运气
| 两条 INSERT 的列数 | 后果 |
|---|---|
| **不同**（上面的例子，2 列 vs 3 列）| 大概率报错 —— 还算幸运，至少能发现 |
| **相同且类型兼容** | ⚠️ **静默写错。不报错、不失败，数据就是落到了错的地方** |

可观测场景的表结构往往高度相似（时间戳 + 标签 + 值），**列数撞上的概率并不低**。
:::

## 机制：两层各自都没错

```
连接池把同一条连接复用给不同的 INSERT 语句      ← 连接池的正常设计
            ×
服务端按连接缓存了 prepare 语句的结构            ← 一种服务端优化
            ↓
复用过来的连接，带着上一条语句的缓存 → 串了
```

**你没法说连接池有 bug，也没法说服务端缓存有 bug。** 它是个**交互缺陷** —— 两层各自都符合设计，合在一起才出错。

这也是它难以定位的原因：往任何一层里挖，都会得出「这层是对的」的结论。

## 为什么只有 MRS

官方版本复现不出来。修复的 commit message 里写的是「针对 ClickHouse 23.1 及更早版本」，但实际只在华为 MRS 上观测到 —— **MRS 的 HTTP 处理和官方版不一致。**

<!-- TODO: 如果后来确认了 MRS 具体改了什么，补在这里 -->

结合 [上一篇](/clickhouse/vendor/huawei-mrs-protocol-trap) 里那个「新版 MRS 改了连接协议、开源客户端 TCP 连不上」的发现，**MRS 的协议层和官方存在差异**这个判断已经不是孤证了。

## 修复：把两层的接触面切断

既然两层各自都没错，那就**不碰任何一层，改变它们的接触方式**。

### 第一步：按 SQL 哈希做专用连接池

[`a2e9c57`](https://github.com/housepower/clickhouse_sinker/commit/a2e9c5735f2a3e23a95f72af44dc36f09b10d963)

新增 `SQLPoolManager`：**每条不同的 INSERT 语句分配一个专用连接池**，让一条连接永远不会看到第二种 INSERT 语句。

`write_v1()` 重命名为 `write_v1_isolated()`，HTTP 协议走新路径。

**设计上的取舍**：不能让池子无限增长，所以用 LRU 缓存，**上限 100 个池、TTL 1 小时**。表数量超过 100 的场景会发生淘汰和重建 —— 这是用一点重建开销换取隔离性。

### 第二步：隔离方案自己带出的问题

[`1c40254`](https://github.com/housepower/clickhouse_sinker/commit/1c40254e07a8910387ccc5bee553cf072b149b9d) —— `fix: dedicatedDB EOF issue`

池子能活一小时，**但池里的连接可能早就断了**。取池时直接返回，就会拿到一个 EOF 的连接。

修法：取出已有池后先 `Ping()` 验证，失效就剔除、走新建逻辑。

### 第三步：配置没复用

[`419205c`](https://github.com/housepower/clickhouse_sinker/commit/419205cc76968b31d833a93ad90289995ce57b2c) —— `fix: reuse clickhouse.options in http pool`

新建池时手搓 `clickhouse.Options` 会漏配置，改成直接复用 `baseOpts`。同时给**新建的池**也加上 `Ping()` 验证 —— 第二步只校验了已有池。

---

## 这三步本身是个完整的弧线

```
隔离  →  发现隔离引入了陈旧连接  →  发现新建路径的配置和校验也有缺口
```

**一个解法会长出它自己的问题。** 第一步解决了串表，但「专用池」这个新概念带来了生命周期管理的负担 —— 池的存活时间和连接的存活时间不是一回事，这个差异在第二步才暴露出来。

## 留给读者的

1. **华为 MRS + HTTP 协议 + 多表并发写入 → 数据可能串表。** 官方版复现不出来。
2. **列数不同会报错，列数相同可能静默写错。** 前者是运气好。
3. **如果你在 MRS 上用 HTTP 批量写多张表**，要么按 SQL 隔离连接池，要么改用 TCP（见 [上一篇](/clickhouse/vendor/huawei-mrs-protocol-trap)，MRS 上 TCP 是可以用的，只需要服务端开个开关）。

---

**相关**：[托管版差异](/clickhouse/vendor/) · [sinker 在华为 MRS 上内存涨到 60G](/clickhouse/vendor/huawei-mrs-protocol-trap)
