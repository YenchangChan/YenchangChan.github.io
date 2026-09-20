# 关于

陈衍长，网名禹鼎侯。做 ClickHouse 的存储与集群运维，主要场景是金融和信创。

十年后端与基础平台，前半程在银行核心系统与支付清算领域，后半程做可观测性产品的采集与存储层。这个站上的东西基本都来自那段时间的生产现场 —— 所以它偏运维、偏故障、偏版本与环境差异，而不是偏架构讲解。

写在这里的判断，有一条贯穿始终：**确定性优先于最优性**。一个边界清楚、能回滚的方案，比一个理论上更优但说不准的方案有用。这不是什么主张，是被变更窗口和回滚要求磨出来的习惯。

---

## 开源

| 项目 | 角色 | |
|---|---|---|
| **[ckman](https://github.com/housepower/ckman)** | 第一作者 · 485★ · Apache 2.0 | ClickHouse 集群可视化管理工具。收录进 ClickHouse 官方 GUI 工具文档（[文档站](https://housepower.github.io/ckman/)）|
| **[clickhouse_sinker](https://github.com/housepower/clickhouse_sinker)** | 主要维护者 · 533★ | Kafka → ClickHouse 高速导入（[文档站](https://housepower.github.io/clickhouse_sinker)）|
| **[ClickHouse](https://github.com/ClickHouse/ClickHouse)** | Contributor | 主仓库 |
| **[clickhouse-go](https://github.com/ClickHouse/clickhouse-go)** / **[ch-go](https://github.com/ClickHouse/ch-go)** | Contributor | 官方 Go 客户端 |

### 上游：9 个 PR 已合并，覆盖三个官方仓库

**ClickHouse/ClickHouse**

| | |
|---|---|
| [#88746](https://github.com/ClickHouse/ClickHouse/pull/88746) | clickhouse-keeper 开机自启。被标记 `must-backport`，已回移至多个稳定分支与 ClickHouse Cloud |
| [#61969](https://github.com/ClickHouse/ClickHouse/pull/61969) | `numbers` / `numbers_mt` / `zeros` / `zeros_mt` 表函数的零参数变体 |
| [#61622](https://github.com/ClickHouse/ClickHouse/pull/61622) | 清理 `copyS3File` 重复代码 |
| [#112910](https://github.com/ClickHouse/ClickHouse/pull/112910) | 修正 26.3 changelog 与实际发布内容不符 |
| [#60394](https://github.com/ClickHouse/ClickHouse/pull/60394) | 推动 ckman 收录进官方 GUI 工具文档 |

**clickhouse-go / ch-go**

| | |
|---|---|
| [#1011](https://github.com/ClickHouse/clickhouse-go/pull/1011) | 修复 `startAutoCloseIdleConnections` 导致的 goroutine 泄漏 |
| [#1230](https://github.com/ClickHouse/clickhouse-go/pull/1230) | 修复 LZ4 压缩下 HTTP 协议的隐蔽错误 |
| [#1217](https://github.com/ClickHouse/clickhouse-go/pull/1217) | 修复列名含双引号导致 `PrepareBatch` 失败 —— 由本人提交的 [#1216](https://github.com/ClickHouse/clickhouse-go/issues/1216) 发现并自行修复 |
| [ch-go #390](https://github.com/ClickHouse/ch-go/pull/390) | 修复 DateTime / DateTime64 在 epoch 零值下的协议序列化 |

### 缺陷定位

不是每个发现都以 PR 收尾，有些是把问题讲清楚、交给更合适的人修。

**[#112711](https://github.com/ClickHouse/ClickHouse/issues/112711)** —— 26.3 LTS 的 text index tokenizer 跨版本兼容缺陷。26.3 发布次日 `unicode_word` 在 master 被改名，导致 26.3 建立的索引在 26.4 无法加载，而且因为附表校验拒绝未知 tokenizer，连 `DROP INDEX` 都执行不了 —— 表进去就出不来。梳理版本时间线后提出四条建议，其中一条是流程层面的：标识符重命名应受发布门禁约束、必须保留别名。核心维护者次日实现并合入 [#113061](https://github.com/ClickHouse/ClickHouse/pull/113061)。

**[#89841](https://github.com/ClickHouse/ClickHouse/issues/89841)** —— aarch64 上的 `Illegal instruction`。反汇编 `aarch64v80compat` 构建 payload 的全部 8948 万条指令并对齐符号表，证明当前构建中不存在未被运行时保护的 LSE 指令；进而定位真正的失败在 `LDAPRB`（FEAT_LRCPC），来自默认构建的 `-march=armv8.2-a+...+rcpc+bf16`。同时指出 `EnvironmentChecks.cpp` 的指令集自检既无 `__aarch64__` 分支，又因 `init_priority(101)` 晚于 priority-100 的静态初始化器而永远不会在崩溃前触发 —— 这是这一整类报告无从 triage 的原因。（[完整分析](/clickhouse/vendor/kylin-arm-instruction-baseline)）

**[#1637](https://github.com/ClickHouse/clickhouse-go/issues/1637)** —— ARM + HTTP 协议下批量写入的内存堆积。通过架构 × 协议 × 认证的三维排除矩阵收敛根因，上游至今未解决，已给出生产规避方案。

---

## 这些内容来自哪里

站上的排障与横评不是实验室产物。主要来源：

- **大型金融机构的日志实时分析平台**：万级 Agent 接入、日增数百 TB；clickhouse_sinker 在该类环境承担全量写入，日增合计达 PB 级（日志、指标与 APM），底层为托管版 ClickHouse
- **金融行业日志平台**：日增百 TB 级，落地 Apache Doris
- **金融云的云日志 / 云监控**：多租户隔离、多集群 + 容灾，日增百亿级指标
- 借助 ckman、clickhouse_sinker 等，**协助上百家客户完成 ClickHouse 存储方案落地**，覆盖金融、信创、政企

**客户名称、机构类型与精确业务规模均已脱敏或作模糊处理**，保留量级是为了说明这些结论的适用场景，不是为了证明什么。涉及具体环境的技术细节（操作系统、CPU 架构、托管服务）是复现和判断所必需的，予以保留。

---

## 专利

发明专利公开 **CN120541047A**，第一发明人 —— 海量小文件采集优化。

实测以 C 系统调用扫描 100 万文件，Linux 约 1.4 秒、AIX（POWER5）需 288 秒，且每个受监控文件都要维持采集状态，内存与扫描 CPU 随文件数线性膨胀。方案是「文件过期」与「目录遗忘」：把**监控全量**降为**监控活跃量**。日增 10 万文件、保留一个月的场景下，扫描对象从 300 万降到 10 万级。

---

## 最近在做

<!-- TODO 1-3 行，半年更一次。别空着 —— 空着说明这人已经停了。
     候选：
     · 想做一个 ARM（ARMv8.0 基线）的 ClickHouse LTS 包分发渠道 ——
       官方在 CI 里构建 aarch64v80compat，但只有 master，没有任何 release/LTS 渠道，
       对生产等于不存在。还在评估构建与分发怎么做。
     · 准备给 EnvironmentChecks 提 PR：移进 .preinit_array，用 getauxval(AT_HWCAP) 覆盖 ARM 特性
     · 存算分离方向的持续跟进
     挑一到两条写成人话，不要写成计划书。 -->

---

## 联系

知乎 [禹鼎侯](https://www.zhihu.com/people/yu-ding-hou) · 公众号 ClickHome · <chenyanchang1990@163.com> · [GitHub](https://github.com/YenchangChan)

站上内容如有错漏，欢迎提 issue 或直接来信指出。
