# 关于

陈衍长，网名禹鼎侯。做 ClickHouse 的存储与集群运维，主要场景是金融和信创。

十年后端与基础平台，前半程在银行核心系统与支付清算领域，后半程做可观测性产品的采集与存储层。这个站上的东西基本都来自那段时间的生产现场，所以偏运维、偏故障、偏版本和环境差异，架构讲解反而不多。

我做判断时有个习惯：确定性优先于最优性。一个边界清楚、能回滚的方案，比一个理论上更优但说不准的方案有用。这也谈不上什么主张，是被变更窗口和回滚要求磨出来的。

---

## 开源

| 项目 | 角色 | |
|---|---|---|
| [ckman](https://github.com/housepower/ckman) | 第一作者 · 485★ · Apache 2.0 | ClickHouse 集群可视化管理工具。收录进 ClickHouse 官方 GUI 工具文档（[文档站](https://housepower.github.io/ckman/)）|
| [clickhouse_sinker](https://github.com/housepower/clickhouse_sinker) | 主要维护者 · 533★ | Kafka → ClickHouse 高速导入（[文档站](https://housepower.github.io/clickhouse_sinker)）|
| [ClickHouse](https://github.com/ClickHouse/ClickHouse) | Contributor | 主仓库 |
| [clickhouse-go](https://github.com/ClickHouse/clickhouse-go) / [ch-go](https://github.com/ClickHouse/ch-go) | Contributor | 官方 Go 客户端 |

### 上游：9 个 PR 已合并，覆盖三个官方仓库

ClickHouse/ClickHouse：

| | |
|---|---|
| [#88746](https://github.com/ClickHouse/ClickHouse/pull/88746) | clickhouse-keeper 开机自启。被标记 `must-backport`，已回移至多个稳定分支与 ClickHouse Cloud |
| [#61969](https://github.com/ClickHouse/ClickHouse/pull/61969) | `numbers` / `numbers_mt` / `zeros` / `zeros_mt` 表函数的零参数变体 |
| [#61622](https://github.com/ClickHouse/ClickHouse/pull/61622) | 清理 `copyS3File` 重复代码 |
| [#112910](https://github.com/ClickHouse/ClickHouse/pull/112910) | 修正 26.3 changelog 与实际发布内容不符 |
| [#60394](https://github.com/ClickHouse/ClickHouse/pull/60394) | 推动 ckman 收录进官方 GUI 工具文档 |

clickhouse-go / ch-go：

| | |
|---|---|
| [#1011](https://github.com/ClickHouse/clickhouse-go/pull/1011) | 修复 `startAutoCloseIdleConnections` 导致的 goroutine 泄漏 |
| [#1230](https://github.com/ClickHouse/clickhouse-go/pull/1230) | 修复 LZ4 压缩下 HTTP 协议的隐蔽错误 |
| [#1217](https://github.com/ClickHouse/clickhouse-go/pull/1217) | 修复列名含双引号导致 `PrepareBatch` 失败，问题是我自己提的 [#1216](https://github.com/ClickHouse/clickhouse-go/issues/1216) ，顺手修了 |
| [ch-go #390](https://github.com/ClickHouse/ch-go/pull/390) | 修复 DateTime / DateTime64 在 epoch 零值下的协议序列化 |

### 缺陷定位

不是每个问题都以我的 PR 收尾，有些是把问题讲清楚，交给更合适的人去修。

[#112711](https://github.com/ClickHouse/ClickHouse/issues/112711)：26.3 LTS 的 text index tokenizer 跨版本兼容缺陷。26.3 发布次日 `unicode_word` 在 master 被改名，导致 26.3 建立的索引在 26.4 无法加载，而且因为附表校验拒绝未知 tokenizer，连 `DROP INDEX` 都执行不了，表进去就出不来。我梳理了版本时间线，提了四条建议，其中一条是流程层面的：标识符重命名应受发布门禁约束、必须保留别名。核心维护者次日实现并合入 [#113061](https://github.com/ClickHouse/ClickHouse/pull/113061)。

[#89841](https://github.com/ClickHouse/ClickHouse/issues/89841)：aarch64 上的 `Illegal instruction`。反汇编 `aarch64v80compat` 构建 payload 的全部 8948 万条指令并对齐符号表，证明当前构建中不存在未被运行时保护的 LSE 指令；进而定位真正的失败在 `LDAPRB`（FEAT_LRCPC），来自默认构建的 `-march=armv8.2-a+...+rcpc+bf16`。同时指出 `EnvironmentChecks.cpp` 的指令集自检既无 `__aarch64__` 分支，又因 `init_priority(101)` 晚于 priority-100 的静态初始化器永远不会在崩溃前触发，这一整类报告没法 triage，原因就在这。（[完整分析](/clickhouse/vendor/kylin-arm-instruction-baseline)）

[#1637](https://github.com/ClickHouse/clickhouse-go/issues/1637)：ARM + HTTP 协议下批量写入的内存堆积。上游至今没有结论，生产上改走 TCP 规避了（[完整经过](/clickhouse/vendor/huawei-mrs-protocol-trap)）。

---

## 这些内容来自哪里

站上的排障与横评不是实验室产物。主要来源：

- 大型金融机构的日志实时分析平台：万级 Agent 接入、日增数百 TB；clickhouse_sinker 在该类环境承担全量写入，日增合计达 PB 级（日志、指标与 APM），底层为托管版 ClickHouse
- 金融行业日志平台：日增百 TB 级，落地 Apache Doris
- 金融云的云日志 / 云监控：多租户隔离、多集群 + 容灾，日增百亿级指标
- 借助 ckman、clickhouse_sinker 等，协助上百家客户完成 ClickHouse 存储方案落地，覆盖金融、信创、政企

客户名称、机构类型和精确的业务规模都做了脱敏或模糊处理，保留量级，是为了说明这些结论适用于什么场景。涉及具体环境的技术细节（操作系统、CPU 架构、托管服务）是复现和判断所必需的，予以保留。

---

## 专利

发明专利公开 **CN120541047A**，第一发明人，内容是海量小文件采集优化。

实测用 C 系统调用扫描 100 万文件，CentOS 7.9 的 x86 物理机上约 1.4 秒，AIX 上要 288 秒（POWER5 架构、AIX 6.1、2 核 4G、100G HDD）。两台机器的配置差得很远，这组数不是同等硬件的对比，只说明在那类老机器上扫描有多贵。而且每个受监控的文件都要维持采集状态，内存和扫描 CPU 随文件数线性膨胀。方案是「文件过期」与「目录遗忘」：把监控全量降为监控活跃量。日增 10 万文件、保留一个月的场景下，扫描对象从 300 万降到 10 万级。

---

## 最近在做

### Iceberg调研

#### 为什么值得做

这几年随着AI的爆发式增长，存储成本居高不下。很多客户都在寻求更便宜的存储方式，存算分离架构也成了大家这一年来最容易提到的话题之一。我前面所做的那些工作，包括S3冷盘，backup/restore， chdb+parquet，以及doris、openobserve、greptimedb的存算分离现状调研等，都是在这条路上的探索。目前来看，走得最稳的应该还是chdb+parquet。但parquet对于查询本身还是有些重了，尤其是涉及到带过滤的查询，因此，需要有一种更高效，更通用的数据格式。

#### 我在做什么

在调研 Iceberg，看它能不能接替现在这套冷数据方案。现在的做法是把冷数据从 ClickHouse 导成 Parquet 放进 S3，再拿 chDB 当一个独立的查询端，写在 [chDB + S3 Parquet](/clickhouse/cold-storage/chdb) 里。裸 Parquet 没有表一级的元数据，查询能裁掉多少，全看路径怎么分区、文件内的统计信息有多准，有点吃建表时的手艺。我想看看换成 Iceberg，靠它的快照和清单统计能不能把冷查询再提一截，前提是冷查询这套系统仍然独立于 ClickHouse 集群，不要又把依赖绕回去。还在看文档和搭环境的阶段，有结论了再写。

### ARM信创版本发布渠道

#### 为什么值得做

国内信创的deadline是2027年12月，现在该上信创的企业基本都上了，而clickhouse在信创硬件上的适配是出了名的差，除非clickhouse打算彻底放弃信创这块大市场了，否则这是一个不得不面对的死结。你不做兼容，逼迫用户倒向doris/starrocks等支持信创硬件的数据库的怀抱，做兼容，得手动编译，官方不提供这条路。

#### 我在做什么

因此，我想把 ARM 的 ClickHouse 安装包分发这件事做起来。官方 CI 一直在构建 `aarch64v80compat`，可它只活在流水线产物里，能拉到的永远是 master，没有任何 release 或者 LTS 渠道。信创项目要的是明确的版本号和支持周期，这个渠道不存在，这个能力对生产就等于不存在。来龙去脉写在 [ARM 上一跑就 SIGILL](/clickhouse/vendor/kylin-arm-instruction-baseline) 里，整个编译验证流程我已经跑通了，现在在评估具体的分发途径和渠道。

<!-- 半年更一次。别空着，空着说明这人已经停了。 -->

---

## 联系

知乎 [禹鼎侯](https://www.zhihu.com/people/yu-ding-hou) · 公众号 ClickHome · <chenyanchang1990@163.com> · [GitHub](https://github.com/YenchangChan)

站上内容如有错漏，欢迎提 issue 或直接来信指出。
