---
title: Too many partitions：和 Too many parts 一词之差，处理方式截然相反
---

# Too many partitions：和 Too many parts 一词之差，处理方式截然相反

是的，你没有看错，本文介绍的是「Too many partitions」，而不是「Too many parts」，这二者并不是一回事。如果你关心的是「Too many parts」，但是恰好点进了这篇文章，我只能说声抱歉：哥们，你跑错片场了。

当然了，哥也不会让你白跑一趟，「Too many parts」的解决思路都在这里了，拿走不谢：[Too many parts：merge 追不上写入的时候](/clickhouse/deep-dive/too-many-parts)。

我们知道，ClickHouse 为了保证数据的高效写入，每次写入都会产生一个 part。但这有个前提，就是 part 的概念是在 partition 之下的。也就是说，如果你一次写入涉及到多个 partition 的数据，它同样会产生多个 part，这就相当于把一个 batch 的数据需要再做一次分流，这个插入效率可想而知。

ClickHouse 对单表的分区个数是有一定限制的，单表的 partition 数目不宜过多（一般 1000 以下为宜，最多不建议超过 10000），如果分区数过多，会带来非常严重的性能问题。

对单次插入同样如此，如果单次插入的 partition 过多，那会带来非常沉重的 merge 成本。因此，ClickHouse 设定了单次 insert 的 partition 上限，这个上限由参数 `max_partitions_per_insert_block` 控制，默认是 100。如果超过这个上限，就会报「Too many partitions」错误。

```
Too many partitions for single INSERT block (more than 100). The limit is controlled by 'max_partitions_per_insert_block' setting ...
```

当然它也不是一定会报这个错误，到底是直接报错，还是只在日志里警告一下，由 `throw_on_max_partitions_per_insert_block` 来决定，默认是 true，也就是会直接报错。

看到没有，它还非常人性化地给你提供了选择，这只说明一个问题，就是这个错误并不是那么致命。

至少相对于「Too many parts」来说，它并不是那么严重。

其实仔细想想就很好理解，啥家庭啊，一次 insert 100 多个 partition？这绝对是一个不懂 ClickHouse 的外行才干得出来的事。

总结一下一次 insert 100 多个 partition 会有哪几种可能：

- 数据分区不合理，比如根据 id 分区
- 数据分区合理，但是数据本身不合理。比如按天分区，但是数据源存在几个月甚至几年的存量数据，并且数据是乱序存放
- 我实在是编不出来了

鉴于出现这种问题的原因都比较奇葩，所以解决这种报错通常也简单。

最简单粗暴的解决方式就是将 `max_partitions_per_insert_block` 调大。

为什么在解决「Too many parts」错误的时候不建议修改配置上限，而解决「Too many partitions」错误时却又建议改配置呢？

因为从上面可能出现该错误的几种可能来看，这个过程都是暂时性导入不合理数据造成的，那么这个过程并不是常态化的，因此修改配置快速将数据全部导入进来，也就完事儿了，不必考虑长久的性能优化问题。性能拉胯也就拉胯那么一会儿。

一个非常典型的例子，比如我们需要暂时性地造大批量的测试数据，比较容易使用下面的语句：

```sql
INSERT INTO test_table
SELECT * FROM generateRandom('a Array(Int8), d Decimal32(4), c Tuple(DateTime64(3), UUID)', 1, 10, 2)
LIMIT 1000000;
```

因为数据是随机生成的，我们无法控制一次 insert 会产生多少个 partition，这时候临时修改一下上限，还是非常有用的。

不过这里得多说一句，调大上限的前提，是这次导入真的是临时的。要是常态化的写入每次都跨一百多个 partition，那每次 insert 就是一百多个 part，用不了多久就会变成 Too many parts。上一篇里那个两小时干到 10 万个 part 的例子，就是单次 insert 写进了 180 个 partition。

第二种解法是将 batch 调小。比如数据源的数据无序存放，一次拉取 10 万条，可能包含 100 多个分区，但是如果我一次只拉取 1 万条，甚至 1000 条呢？包含的 partition 数量就降下来了。

看见没，同样是「Too many ...」的错，「Too many parts」要将 batch 尽可能调大，而「Too many partitions」则是要将 batch 适当调小。

当然最终的解法，就是重新规划分区，调整建表语句。

---

**相关**：[Too many parts：merge 追不上写入的时候](/clickhouse/deep-dive/too-many-parts) · [一次讲透](/clickhouse/deep-dive/)
