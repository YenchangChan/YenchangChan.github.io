# 生产排障

真实事故的完整复盘。

写的时候尽量保留过程：最初的判断、走错的弯路、反馈不符合预期时怎么办。只写「我定位到了 → 我解决了」的复盘没什么价值，因为现实里从来不是那样的。

客户信息全部脱敏，规模数字保留。

## 文章

- [126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks)
  —— 从「数字反常」到「源码实锤」，以及清理时差点丢掉 quorum
- [metadata 明明在本地，为什么 ClickHouse 说 S3 上找不到](/clickhouse/troubleshooting/s3-unreachable-startup)
  —— S3 不可达时的救援，以及一个偏方跨三个大版本的失效史
- [znode 爆炸与线程池](/clickhouse/troubleshooting/znode-explosion)

<!-- TODO：
  - 写入积压的几种形态
  - 集群失衡与数据重分布
-->
