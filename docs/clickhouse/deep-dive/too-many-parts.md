---
title: Too many parts：merge 追不上写入的时候
---

# Too many parts：merge 追不上写入的时候

这个报错一般出现在数据高速写入的时候，merge 的速度赶不上 part 产生的速度，导致 part 数量堆积过多。报错提示一般是这样的：

```
DB::Exception: Too many parts (300). Parts cleaning are processing significantly slower than inserts
```

在 ClickHouse 里，MergeTree 家族的引擎为了尽量保证写入速度，每次插入都会产生一个 part，同一个 partition 内的多个 part 再在后台进行 merge，合并成一个更大的 part。

我们知道，所谓的 partition，是逻辑上的概念，part 才是看得见摸得着的实体（也就是磁盘上的文件和目录）。因此，part 数目并不是越多越好。part 数目一多，小文件数量跟着暴增，文件系统压力大；merge 的次数也变多，CPU 消耗跟着涨；查询时一条 SQL 可能命中大量 part，有些 part 里还有相同数据交叉，开销少不了。

因此，ClickHouse 为了避免单表产生过多的 part 影响性能，设置了一个单表最多的 part 数量上限，配置在 `max_parts_in_total` 中，默认值是 10 万。

对于正常的写入场景来说，一般不太容易达到这个上限。如果频繁达到这个上限，那说明要么是表分区不合理，要么是数据不合理。比如我曾遇到过单次 insert 插入了 180 个 partition 的数据，结果不到两个小时就把表的 part 数量干到了 10 万以上，这明显是数据本身不合理导致的。

当然还有一种可能会出现 Too many parts 的场景。

ClickHouse 除了控制单表的 part 数量之外，为了减轻 merge 压力（merge 一般是在同一个 partition 内进行的），同样还会控制单个 partition 内的 part 数目。道理和前面一样，单个 partition 内的 part 数目过多，自然要经过很多轮 merge 才能形成最终态，这个过程是非常吃 CPU 的，势必会影响到写入和查询。

这个上限由 `parts_to_throw_insert` 控制，单个 partition 内的 part 数量超过它，同样会报 Too many parts。默认值是 3000，23.6 之前是 300，上面那条报错里的 `(300)` 就是老版本的这个值。在它之前还有一道 `parts_to_delay_insert`（默认 1000，23.6 之前是 150），超过了，INSERT 会被故意放慢。

## 改上限？强制 merge？

以上讲了半天，是这个错误产生的原因及背景。那么该如何解决呢？

肯定有大聪明提出来了：既然这个上限可以通过配置文件来改，那我改大一点不就行了吗？

当然行，要不然怎么说是大聪明呢？

官方给出的建议是这个值不要轻易去修改，因为这个上限起的其实是一个警示的作用，就是要告诉你：你的表快写不动了，赶紧采取措施。你把警示的水位线改了，这就相当于你高考考不上二本，就去修改本科分数线，自欺欺人嘛这不是？

当然还有另一种饮鸩止渴的改法。不就是我的 part 数目太多了来不及 merge 么，那我就强制让它去 merge 掉，把 part 数量降下来不就行了吗？

不好意思，人家官方直接把这条路给堵死了。`OPTIMIZE` 的文档里专门用一个提示框写着：*OPTIMIZE can't fix the Too many parts error*。

为什么呢？这不科学啊。

如果你在官方文档里搜「Too many parts」，会发现除了上面两个设置之外，还有一个设置和这个错误有关，叫 `inactive_parts_to_throw_insert`。从字面意思上来看，它是单个 partition 内非活动的 part 数量上限。所谓非活动的 part，是 merge 完之后留下的冗余。

比如原来有三个 part，分别是 `all_0_0_0`、`all_1_1_0`、`all_2_2_0`，发生了一次 merge，变成了 `all_0_2_1`。那么很容易知道，`all_0_2_1` 这个 part 里包含了之前三个 part 的全量数据，查询时直接查 merge 之后的这个大 part 就行，不需要再查之前的三个小 part 了。这三个小 part 就是 inactive 的 part，它们会在一段时间之后由 ClickHouse 从磁盘上删除。

因此，即使我们执行了 `OPTIMIZE` 强制合并了数据，inactive 的 part 并不会减少，反而会变多，当 inactive 达到上限，同样会出现上述错误。

不过好消息是，这个上限默认是 0，也就是不限制。

但是你三营长也别嘴咧得跟荷花似的，它不限制，也并不意味着你可以无限制地作，因为这毕竟是饮鸩止渴的解法。

为什么呢？因为它在某些时候确实有效，但不解决根本。你就想嘛，inactive 的 part 到底还是占据了磁盘空间，虽然不参与查询了，但给文件系统带来的压力不会丝毫减少半分。否则人家干嘛闲着撑得慌提供这么个配置出来呢？

有人就吐槽了，左也不是右也不是，你 ClickHouse 这么大一数据库，咋这么娇气呢？

对，人家还就是这么娇气，你爱用不用。

## 那该怎么办

说了半天，我们应该如何解决这类错误呢？

其实官方早已给我们提供了解决方案：

https://clickhouse.com/docs/knowledgebase/exception-too-many-parts

咳咳，我就知道肯定有人不会去看上面链接里的英文，所以我就干脆好人做到底，直接言简意赅地大致总结一下。

先判断是单表的总 part 数目到上限了，还是单 partition 内的 part 数目到上限了？

三条 SQL 搞定：

```sql
--- 查配置（表级 SETTINGS 会覆盖这里的全局值）
SELECT name, value
FROM system.merge_tree_settings
WHERE name IN ('max_parts_in_total', 'parts_to_throw_insert', 'inactive_parts_to_throw_insert');

┌─name───────────────────────────┬─value──┐
│ parts_to_throw_insert          │ 3000   │
│ inactive_parts_to_throw_insert │ 0      │
│ max_parts_in_total             │ 100000 │
└────────────────────────────────┴────────┘

--- 查单表的总 part 数目
SELECT count()
FROM system.parts
WHERE database = '<database>' AND table = '<table>' AND active;

┌─count()─┐
│  131150 │
└─────────┘

--- 查 part 数目最多的 partition
SELECT partition, count() AS cnt
FROM system.parts
WHERE database = '<database>' AND table = '<table>' AND active
GROUP BY partition
ORDER BY cnt DESC
LIMIT 10;
```

这类问题出现的关键，就是 merge 速度跟不上 part 产生的速度。那么解决思路也就很明确：控制 part 产生的速度，提高 merge 的速度。

### 控制 part 产生的速度

要控制 part 生成的速度，就要知道 part 是怎么来的。

前面提到过，每次 insert 都会产生一个 part。所以如果你仍然像操作 MySQL 等关系型数据库一样一条一条地插入数据，那么必然会产生茫茫多的 part，这显然不是一个科学的写入方案。

事实上，ClickHouse 官方建议对于 MergeTree 家族的表，提倡大批量的数据插入，比如一次插入 10 万条。你就想嘛，同样 100 万条数据，你一次插入 10 万条，10 次 insert 搞定，也就产生 10 个 part；但是你一次插入 100 条，那就需要 1 万次 insert，也就会产生 1 万个 part。

当然账不能这样简单地去算，否则小学生都能来搞 ClickHouse 了，我的天。

比如我从 `query_log` 里随便捞出一条 insert 语句，看它的 profile，这次 insert 一共 172699 条数据，但是却产生了 8 个 part。

那为什么一次 insert 产生了 8 个 part 呢？

注意，part 其实是按 block 产生的，每个 block 在它涉及的每个 partition 里各落一个 part。所以一次 insert 拆成多个 part，有好几种可能。

最容易被忽略的，是这批数据本身跨了多个 partition，每个 partition 都会各落一个 part。

还有就是一次 insert 并不一定是单个线程。可以通过 `max_insert_threads` 看当前插入可以使用的最大线程数（默认单线程），`INSERT ... SELECT` 开了多线程，每个线程各自产出 part。

另外还有一个搞事情的配置叫 `max_insert_block_size`，默认 1048449 行，差不多 100 万。服务端自己解析数据的时候，比如走 HTTP 接口往里灌 CSV、JSONEachRow，攒够这么多行就切出一个 block，一个 block 就落一个 part。用 clickhouse-client 导文件时，数据是客户端自己解析的，切 block 用的是客户端这边的同名设置，服务端上配的值管不着。用原生协议的驱动（比如 clickhouse-go）写入就更不归它管了，应用攒成多大的 block 发过来就是多大，太小的 block 服务端会按 `min_insert_block_size_rows` / `min_insert_block_size_bytes` 往一起拼。不过默认 100 万行这个量级，上面那条 17 万行的 insert 是碰不到的，那 8 个 part 不是它切出来的。

到底是哪一种，可以用 `system.part_log` 按 `query_id` 看一下这次 insert 产生的 part 都落在了哪些 partition：

```sql
SELECT partition_id, count() AS parts, sum(rows) AS rows
FROM system.part_log
WHERE query_id = '<query_id>' AND event_type = 'NewPart'
GROUP BY partition_id
ORDER BY parts DESC;
```

所以总结一下，控制 part 产生的速度，说白了就是要控制单次插入数据的 batch 的大小。那么这个 batch 大小该如何参考呢？官方给的建议是，一次插入 1~2 秒，并且每次插入的数据量在 10000~500000 条之间。要是写入端实在攒不了批，也可以打开 `async_insert`，让服务端把多个小 insert 攒成一个 part。

### 提高 merge 的速度

讲完了控制 part 产生速度，再来讲讲提高 merge 速度。

很多熟悉 ClickHouse 的人都知道 merge 是在后台悄悄做的。但很多人不知道的是，merge 速度和哪些东西有关。

有卧龙凤雏不服了：我当然知道，和空闲的 CPU 有关，空闲的 CPU 越多，merge 自然越快。

对对对，你说的都对。但你怎么定义空闲的 CPU 呢？有时候你明明看到 CPU 还有空余，但它就是不 merge，阁下又将如何应对呢？

ClickHouse 为了保证有足够的资源去完成这些后台操作，定义了一个后台任务池子，这个池子有大小，每个 merge 都是一个后台任务，占用池子的一个额度。我们可以通过下面的语句来查看池子大小和当前后台已经运行的任务：

```sql
SELECT metric, value
FROM system.metrics
WHERE metric LIKE 'BackgroundMergesAndMutationsPool%';

┌─metric───────────────────────────────┬─value─┐
│ BackgroundMergesAndMutationsPoolTask │     0 │
│ BackgroundMergesAndMutationsPoolSize │    64 │
└──────────────────────────────────────┴───────┘
```

`BackgroundMergesAndMutationsPoolSize` 就是池子大小，`BackgroundMergesAndMutationsPoolTask` 就是当前任务个数。如果当前任务个数已经把池子撑满了，那么即使 CPU 再有空闲，也是无法 merge 了。

细心的老铁肯定注意到了，这个池子除了给 merge 用，还会给 mutation 用。而 mutation 里有一个臭名昭著的恶心人玩意，叫 `MATERIALIZE TTL`。这个东西不仅耗时，还如附骨之疽，甩都甩不掉，恶心的一批。

所谓的 `MATERIALIZE TTL`，就是你的表设置了 TTL 生命周期，比如配置了冷热分离，达到一定时间的数据要转移到冷盘上去，这个动作也是后台做的。但是你并不知道它什么时候去做，有可能你正想 merge 数据呢，这老哥慢悠悠地来了，占着池子吭哧吭哧地搬那转移数据，一搞就是几个小时，等它完事，黄花菜都凉了。

ClickHouse 开发人员不是傻子，这么明显的性能问题肯定注意到了，所以自然也提供了解决方案。有一个神奇的配置叫 `number_of_free_entries_in_pool_to_execute_mutation`，它的意思是你执行 mutation 可以，但至少池子里给我保留一点空闲的额度，留给我 merge 用。这个空闲额度默认是 20。

所以碰到 Too many parts，除了回头看写入端的 batch，也去 `system.mutations` 里看看有没有长时间挂着的 mutation，池子是不是被它们占着。

---

**相关**：[Too many partitions：和 Too many parts 一词之差，处理方式截然相反](/clickhouse/deep-dive/too-many-partitions) · [Too many parts — ClickHouse Knowledge Base](https://clickhouse.com/docs/knowledgebase/exception-too-many-parts)
