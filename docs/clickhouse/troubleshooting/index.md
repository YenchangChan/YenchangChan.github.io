# 生产排障

真实事故的完整复盘。

写的时候尽量保留过程：最初的判断、走错的弯路、反馈不符合预期时怎么办。只写「我定位到了 → 我解决了」的复盘没什么价值，因为现实里从来不是那样的。

客户信息全部脱敏，规模数字保留。

## 文章

<div class="posts">

<a class="post" href="/clickhouse/troubleshooting/keeper-async-blocks">
<span class="post-t">126 万 znode 是怎么长出来的</span>
<span class="post-d">26.3 上异步插入和插入去重两个默认值撞在一起，<code>async_blocks</code> 占了九成。还有清理时差点丢掉 quorum。</span>
</a>

<a class="post" href="/clickhouse/troubleshooting/s3-unreachable-startup">
<span class="post-t">S3 不可达时起不来：metadata 明明在本地，它却说 S3 上找不到</span>
<span class="post-d">改错 endpoint 加 <code>skip_access_check</code> 的偏方，22.8 上好使，23.x 就不灵了。各版本该怎么救。</span>
</a>

<a class="post" href="/clickhouse/troubleshooting/znode-explosion">
<span class="post-t">znode 爆炸：根子在 ClickHouse 的后台线程池</span>
<span class="post-d">ZK 扩容重启后 znode 冲到 2700 万，四个月后又在 fetch 池上积压了一次。里面有我远程给错的那条建议。</span>
</a>

</div>

<!-- TODO：
  - 写入积压的几种形态
  - 集群失衡与数据重分布
-->
