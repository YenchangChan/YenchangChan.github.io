---
title: ClickHouse Keeper 部署对比：为什么生产推荐独立部署
---

# ClickHouse Keeper 部署对比：为什么生产推荐独立部署

ClickHouse Keeper 是集群的协调服务，副本同步、分布式 DDL 背后的元数据和一致性协调都靠它。它有两种跑法：作为 `clickhouse-server` 的一部分启用，或者用独立的 `clickhouse-keeper` 进程。两种都能跑起来，这篇文章把两种方式的账各算一遍。

## 内置部署省下的和欠下的

内置部署不用额外起进程，初始部署简单，也少了一套要单独维护的服务，这个吸引力很直接。

代价是 Keeper 和 ClickHouse 共用同一份进程资源和生命周期。查询或后台任务把 CPU、内存、文件描述符吃紧的时候，协调服务跟着受影响；出了问题排查，得先搞清楚压力到底先出现在哪一侧。ClickHouse 节点重启、升级、下线，都得再多想一步：这台机器是不是还承担着 Keeper 仲裁职责。

集群拓扑会把这个问题放大。ClickHouse 常见每个分片部署两个副本，Keeper 通常要三个投票节点。「每个 ClickHouse 节点都内置一个 Keeper」显然不能当通用规则，就算只挑三个节点启用，这三个节点的维护计划也和仲裁集群绑在了一起。

官方自己的运维文章里也写过这类问题：自建副本集群意外进入只读状态，常见原因之一就是协调服务资源不足，其中包括把协调服务和 ClickHouse 放在同一批机器上。官方给的解决方向很明确：给协调服务配足专用的资源和机器。

## 日志混进同一个文件

内置部署还有一个容易被低估的运维细节：Keeper 的日志默认写进 `clickhouse-server.log`，和服务端日志混在同一个文件里，不只是同一个目录。

这不是凭配置猜的。[ClickHouse issue #31860](https://github.com/ClickHouse/ClickHouse/issues/31860) 明确记录了内置 Keeper 往 `clickhouse-server.log` 写日志的情况，有人提议把日志挪到独立文件。这个 issue 后来关了，标记是 not planned。仓库里的默认服务端配置，日志指向 `/var/log/clickhouse-server/clickhouse-server.log`；独立 Keeper 的示例配置用的则是 `/var/log/clickhouse-keeper/clickhouse-keeper.log`。

日志混写不代表没法监控，但日志要采集、要过滤，出了问题对时间线也更费劲。这笔成本应该算进内置部署的运维代价里。

## 独立部署换来的是什么

独立部署用单独的 `clickhouse-keeper` 进程。ClickHouse 扩容、缩容、滚动升级，Keeper 集群的成员都不用跟着动；升级、监控、故障处理，可以按自己的节奏单独安排。

「独立」有两个层次。一是独立进程、同一台机器：进程生命周期、日志配置隔离了，但 CPU、内存、磁盘还是和宿主机共享。二是独立机器，或者至少明确隔离的计算、内存与磁盘资源：ClickHouse 工作负载挤占 Keeper 资源的风险进一步降低，更贴近高可用生产集群的目标。

独立部署当然多了一套服务要维护：版本升级、成员变更、持久化数据保护、告警，一样都省不掉。但对本来就在维护 ZooKeeper 的团队来说，这些是熟活。

## Cloud 和公开案例怎么做

ClickHouse Cloud 公开过专用三节点 Keeper 服务的架构实例，每个节点 3 核、2 GB 内存。Cloud 自己的公开实践，也没有把 Keeper 塞进计算节点的进程里。

不过有个细节值得留意：早期文章里，专用 Keeper 归单个服务；到后来 Cloud 的 warehouse 架构，共享同一份数据的多个计算服务会共用一套 Keeper 集群。所以更准确的说法是 Keeper 与计算节点独立管理，而不是每个计算服务始终各有一套 Keeper。

公开的自建案例里，Bonree 披露把原来多个 ZooKeeper 节点组迁成了一套 ClickHouse Keeper 节点组，上面跑着超过 15 个分片。独立的 Keeper 节点组确实已经落地，只是文章没给足够的主机隔离细节，没法逐项核验。

## 我的建议

生产副本集群的部署基线：独立进程、独立三节点 Keeper 仲裁集群；业务可用性要求更高，再上独立机器。**成员变更要当作协调集群自己的操作单独规划，别跟着 ClickHouse 数据节点扩缩容顺带就做了。**

内置部署也不是不能用。小规模集群、验证环境，或者资源管得住、也接受两个服务共用维护窗口的场景，选它说得过去。只是动手之前，仲裁节点怎么挑、资源怎么限、告警和日志过滤怎么配，都得先想好。

说到底，要权衡的不是多一个进程本身，而是协调服务遇到资源争用、节点维护或故障时，还能不能做到可观察、可定位、可独立恢复。

## 参考

- ClickHouse 官方运维文章：[Common Getting Started Issues with ClickHouse](https://clickhouse.com/blog/common-getting-started-issues-with-clickhouse)
- [ClickHouse issue #31860](https://github.com/ClickHouse/ClickHouse/issues/31860)：内置 Keeper 日志写进 `clickhouse-server.log`，not planned
- ClickHouse Cloud Keeper 架构实例：[ClickHouse Keeper: a ZooKeeper alternative written in C++](https://clickhouse.com/blog/clickhouse-keeper-a-zookeeper-alternative-written-in-cpp)
- ClickHouse Cloud warehouse 架构：[Introducing Warehouses: Compute-Compute Separation in ClickHouse Cloud](https://clickhouse.com/blog/introducing-warehouses-compute-compute-separation-in-clickhouse-cloud)
- Bonree 迁移案例：[Bonree replaces ZooKeeper with ClickHouse Keeper](https://clickhouse.com/blog/bonree-replaces-zookeeper-with-clickhouse-keeper-for-drastically-improved-performance-and-reduced-costs)

---

**相关**：[为什么推荐一机一副本](/clickhouse/tooling/deployment-topology) · [126 万 znode 是怎么长出来的](/clickhouse/troubleshooting/keeper-async-blocks) · [znode 爆炸与线程池](/clickhouse/troubleshooting/znode-explosion) · [副本表 readonly](/clickhouse/deep-dive/replica-readonly)
