# 信创与异构环境

同一个 ClickHouse，换一个运行环境，行为不一定一样 —— 换发行方（华为 MRS 这类托管版）、换 CPU 架构（国产 ARM）、换操作系统（麒麟）。

这类问题比版本变更更难查，因为**它连 changelog 都没有**：官方文档不会写，开源社区没人遇到过，厂商文档里也往往找不到。而且很多根本不算 bug —— 官方的选择是合理的，只是和国产化环境的约束对不上。

踩到之后，第一反应通常是怀疑自己。

## 硬件与指令集

- [ARM 上一跑就 SIGILL，以及为什么这类问题查不出来](/clickhouse/vendor/kylin-arm-instruction-baseline)
  —— 反汇编 8900 万条指令之后发现：缺的不是 LSE 是 rcpc，而 ClickHouse 的指令集自检永远不会触发

## 华为 MRS

- [sinker 在华为 MRS 上内存涨到 60G，最后发现和内存没关系](/clickhouse/vendor/huawei-mrs-protocol-trap)
  —— 一个被错误归因三次的连接协议问题
- [并发 INSERT 串表：HTTP 下 prepare 语句的缓存陷阱](/clickhouse/vendor/mrs-http-prepare-cache)
  —— 两层各自都没错，合起来数据落到了别的表上

<!-- TODO：阿里云 / 腾讯云托管版的差异；其他国产 OS / CPU 的适配 -->
