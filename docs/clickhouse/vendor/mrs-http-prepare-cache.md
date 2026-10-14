---
title: 并发 INSERT 串表：HTTP 下 prepare 语句的缓存陷阱
---

# 并发 INSERT 串表：HTTP 下 prepare 语句的缓存陷阱

华为 MRS 的 ClickHouse，走 HTTP 协议的时候，几条不同的 INSERT 一并发，数据会落到别的表上去。同样的写法，换官方版本就复现不出来。

## 症状

两条结构不同的 INSERT 并发执行：

```sql
INSERT INTO a VALUES (c1, c2);
INSERT INTO b VALUES (c3, c4, c5);
```

结果表 `b` 收到的是 `c1, c2`，那是表 `a` 的数据。

能不能发现，全看运气。像上面这样，两条 INSERT 列数不一样，2 列对 3 列，大概率会报错，这还算幸运，至少知道出事了。要是列数一样、类型也兼容，那就是**静默写错**，不报错，不失败，数据就是落到了错的地方。可观测场景的表结构往往都差不多，时间戳加标签加值，列数撞上的概率并不低。

## 怎么串的

```
连接池把同一条连接复用给不同的 INSERT 语句      ← 连接池的正常设计
            ×
服务端按连接缓存了 prepare 语句的结构            ← 一种服务端优化
            ↓
复用过来的连接，带着上一条语句的缓存 → 串了
```

连接池复用连接，这是它的本分，没毛病；服务端按连接缓存 prepare 语句的结构，作为一种优化也说得过去。两边单拎出来都符合设计，凑到一块就出事了。这也是它难查的原因，往哪一层里挖，挖到最后都会觉得这一层是对的。

## 为什么只有 MRS

官方版本复现不出来。修复的 commit message 里写的是「针对 ClickHouse 23.1 及更早版本」，可实际上只在华为 MRS 上碰到过，只能说明 MRS 的 HTTP 处理和官方版不一样。

<!-- TODO: 如果后来确认了 MRS 具体改了什么，补在这里 -->

再加上[上一篇](/clickhouse/vendor/huawei-mrs-protocol-trap)里，新版 MRS 改了连接协议、开源客户端走 TCP 连不上的事，MRS 的协议层和官方有差异，这已经不是孤证了。

## 怎么修

既然两层各自都没错，那就哪一层都不动，改它们接触的方式。

第一步，按 SQL 哈希给每条语句一个专用连接池（[`a2e9c57`](https://github.com/housepower/clickhouse_sinker/commit/a2e9c5735f2a3e23a95f72af44dc36f09b10d963)）。新加了一个 `SQLPoolManager`，每一种不同的 INSERT 语句分到一个自己的连接池，这样一条连接永远只会见到一种 INSERT。`write_v1()` 改名叫 `write_v1_isolated()`，HTTP 协议走这条新路径。池子不能无限涨，所以用了 LRU 缓存，上限 100 个池，TTL 1 小时。表超过 100 张的场景会有淘汰和重建，拿一点重建的开销，换来隔离。

第二步，修隔离方案自己带出来的问题（[`1c40254`](https://github.com/housepower/clickhouse_sinker/commit/1c40254e07a8910387ccc5bee553cf072b149b9d)，`fix: dedicatedDB EOF issue`）。池子能活一个小时，可池里的连接可能早就断了，取池的时候直接返回，拿到的就是一个 EOF 的连接。改成取出已有的池以后先 `Ping()` 一下，不通就剔掉，走新建的逻辑。

第三步，配置没复用（[`419205c`](https://github.com/housepower/clickhouse_sinker/commit/419205cc76968b31d833a93ad90289995ce57b2c)，`fix: reuse clickhouse.options in http pool`）。新建池的时候手搓 `clickhouse.Options`，会漏掉配置，改成直接复用 `baseOpts`。顺手给新建的池也加上了 `Ping()`，第二步只校验了已有的池。

这三步连起来看，第一步解决了串表，可专用池这个新东西带来了生命周期管理的麻烦：池能活多久和池里的连接能活多久，根本不是一回事，这个差别到第二步才冒出来；第二步只顾了已有的池，新建的那条路径上配置和校验也有缺口，又到第三步才补上。

## 最后

华为 MRS 加 HTTP 协议，多张表并发写入，数据可能串表，官方版本复现不出来。列数不同会报错，那算运气好；列数相同，可能就悄无声息地写错了。

如果你在 MRS 上用 HTTP 批量写多张表，要么按 SQL 把连接池隔离开，要么干脆改用 TCP。[上一篇](/clickhouse/vendor/huawei-mrs-protocol-trap)说过，MRS 上 TCP 是能用的，服务端开个开关就行。

---

**相关**：[托管版差异](/clickhouse/vendor/) · [sinker 在华为 MRS 上内存涨到 60G](/clickhouse/vendor/huawei-mrs-protocol-trap)
