# 生产排障

真实事故的完整复盘。

写的时候尽量保留过程：最初的判断、走错的弯路、反馈不符合预期时怎么办。只写「我定位到了 → 我解决了」的复盘没什么价值，因为现实里从来不是那样的。

客户信息全部脱敏，规模数字保留。

## 文章

<div class="posts">

<a class="post" href="/clickhouse/troubleshooting/keeper-async-blocks">
<span class="post-t">126 万 znode 是怎么长出来的</span>
<span class="post-d">从「数字反常」到「源码实锤」，以及清理时差点丢掉 quorum。</span>
</a>

<a class="post" href="/clickhouse/troubleshooting/s3-unreachable-startup">
<span class="post-t">metadata 明明在本地，为什么 ClickHouse 说 S3 上找不到</span>
<span class="post-d">S3 不可达时的救援，以及一个偏方跨三个大版本的失效史。</span>
</a>

<a class="post" href="/clickhouse/troubleshooting/znode-explosion">
<span class="post-t">znode 爆炸与线程池</span>
<span class="post-d">ZK 扩容重启引爆 2700 万 znode，以及我远程给错的那条建议。</span>
</a>

</div>

<!-- TODO：
  - 写入积压的几种形态
  - 集群失衡与数据重分布
-->
