---
title: Fluent Bit 源码笔记（五）：Kubernetes 日志采集，身份从文件路径里猜
---

# Fluent Bit 源码笔记（五）：Kubernetes 日志采集，身份从文件路径里猜

::: info Fluent Bit 源码笔记
读 `in_tail`、`filter_kubernetes` 与 K8s 采集架构的五篇笔记。源码基线 v5.1.1；loggie 侧基于我们内部维护的 fork，行号与上游主线可能略有出入。

- （一）[背压与投递，先不伤害宿主](/systems/agent/fluent-bit-backpressure-delivery)　·　背压与投递
- （二）[百万个只写一次的文件](/systems/agent/fluent-bit-million-files)　·　规模天花板
- （三）[采集器怎么记住自己读到了哪里](/systems/agent/fluent-bit-offset-identity)　·　offset 存储
- （四）[读取边界上的数据丢失，GBK 日志丢了 27.4%](/systems/agent/fluent-bit-read-boundary)　·　编码与压缩
- **（五）Kubernetes 日志采集，身份从文件路径里猜**　·　K8s 与选型
:::

前面四篇都在读 `in_tail`：背压、规模、offset、读取边界，全是单机视角。可 Fluent Bit 在生产里大多以 DaemonSet 跑在 Kubernetes 节点上，光会把文件读出来，决定不了这条日志是谁的。

给每条日志填上 pod 名、namespace、labels，是 `filter_kubernetes` 的活，前面没展开过，这一篇把它补齐。K8s 场景绕不开的几个老问题也一起过：元数据怎么来、多久刷新一次、stdout 之外的日志采不采得到、pod"漂移"了怎么办。

只看一家容易自我陶醉，后半篇拿 loggie 过同一张问题清单。loggie 是网易数帆开源的 Go 云原生日志采集器，跟 Fluent Bit 是两条相反的架构路线，同一把尺子量下来，答案比单看一家有意思得多。

Fluent Bit 侧的锚点基于 v5.1.1 本地构建，不是文档转述；哪些是实测、哪些是看代码的判断，文中分别注明。

## 元数据从哪来：路径猜身份，API Server 换元数据

`filter_kubernetes` 在每条记录上补一个 `kubernetes` map，字段分三类来源：

```json
{
  "log": "原始内容...",
  "kubernetes": {
    "pod_name": "my-app-7d9f4b8c5-x2v1k",     // ① tag 正则拆出
    "namespace_name": "default",              // ①
    "container_name": "app",                  // ①
    "docker_id": "3fac...",                   // ①（containerd 下是 container id）
    "pod_id": "7f8c9d2e-...",                 // ② API Server 返回的 metadata.uid
    "host": "node-3",                         // ③ 节点名
    "container_image": "...",                 // ② status 里补
    "labels":    { "app": "my-app" },         // ② 默认全量，可白名单裁剪
    "annotations": { ... }                    // ② 默认全丢，开白名单才有
  }
}
```

| 类 | 字段 | 机制 |
|---|---|---|
| ① | pod/ns/container/docker_id | tag 正则硬猜，只猜出"你是谁"（`plugins/filter_kubernetes/kube_regex.h:27` 的 `KUBE_TAG_TO_REGEX`） |
| ② | pod_id/labels/annotations/image | 拿①拼出 namespace+pod 查缓存，miss 就发 HTTPS 到 apiserver 换（`kube_meta.c` 的 `get_pod_api_server_info()`） |
| ③ | host | 节点名（`meta_to_msgpack()`） |

labels 和 annotations 的默认值方向相反，最容易记混：labels 默认全带，配白名单才裁；annotations 默认全丢，开白名单才带。

Deployment 维度在标准输出里没有。源码里唯一的 deploy 反推在 AWS 模式下：`search_workload()`（`kube_meta.c:886`）从返回的 ownerReferences 找 ReplicaSet，用 `DEPLOYMENT_REGEX`（`kube_regex.h:29`，剥掉 `[bcdfghjklmnpqrstvwxz2456789]{6,10}$` 后缀）推出 deploy 名。结果只接进 `aws_entity_workload` 字段（`kube_meta.c:1624`），开源版的输出里没有。这个推导本身是好的，后面还会提到它。

## 元数据多久刷新：没有 watch，纯 TTL 被动刷新

`filter_kubernetes` 对 pod 变更没有任何事件感知能力。缓存命中就不查，刷新只靠"条目过期、读时 miss、重查"（`src/flb_hash_table.c:509-515`，`expiration = entry->created + ttl`，从创建时刻算，不是滑动窗口）。

而默认配置下，TTL 是 0，永不过期。`kube_meta_cache_ttl` 默认 0（`kubernetes.c:1232`），配 0 时 `kube_conf.c:128-138` 走 `flb_hash_table_create()`，这张表没有 TTL、淘汰策略是 EVICT_RANDOM，条目永不过期。后果是：pod 一直产日志，缓存就一直命中，`kubectl label pod` 原地改 label 对采集器不可见，直到 fluent-bit 重启、表满随机驱逐、或者 pod 重建产生新 key。namespace 那张缓存默认 TTL 是 15 分钟（`kubernetes.c:1242`），pod 和 namespace 两张表分开建（`kube_conf.c:128-152`）。

三种"变更"各自的感应时延：

| 变更类型 | 感应时延 | 原因 |
|---|---|---|
| 原地 `kubectl label pod`（默认配置） | 永不 | TTL=0 |
| 原地改 label（显式配了 TTL） | 最差 = TTL，平均 = TTL/2 | 读时过期重查 |
| 改 Deployment template（滚动更新） | 即时 | 新 pod 即新缓存 key，首条日志即查 |

同名 pod 还有个小坑。StatefulSet 重建出同名 pod、CronJob 冒出同名 Job，旧缓存条目会被同名新 pod 复用，新 pod 短暂带着旧 labels。`cache_use_docker_id`（默认 false，`kubernetes.c:1186`）打开后缓存 key 拼上 docker_id 把不同容器隔开，代价是条目数膨胀。这是个真实权衡：默认选了命中率，放弃了重启瞬间的精确性。

所以下游业务要是依赖 label 时效（按 label 路由、按版本计费），必须显式配 `Kube_Meta_Cache_TTL`，按"能接受多久的旧标签"选值。而且没有任何指标能暴露"元数据已陈旧"，这个问题足够立一条上游 issue，后文给候选。

## 想按 deploy 圈日志，先得接受一件事

Fluent Bit 不认识 Deployment，deploy 到 RS 到 Pod 这条链不出现在任何一层。实际可配的粒度有三档。

锁死单个 pod，input 层按文件名就行：

```ini
[INPUT]
    Name tail
    Path /var/log/containers/my-pod-7d9f4b8c5-x2v1k_default_nginx-*.log
```

文件名即身份，但 pod 重启后 container_id 段会变、重建后名字会变，只适合临时捞数，进不了长期配置。按 `^my-deploy-` 前缀正则匹配某个 deploy 的 pod 也行，可每次发版 RS 哈希都变，还容易跟其他 deploy 撞前缀（`my-deploy` 对 `my-deploy-v2`），是反模式。

正经做法是用 label 过滤：

```ini
[FILTER]
    Name   grep
    Match  kube.*
    Regex  $kubernetes['labels']['app']  my-app
```

要单独路由到专属 output，用 rewrite_tag（`Rule $kubernetes['labels']['app'] ^my-app$ special.my-app true`）比 grep 丢弃好，其他记录不受影响。

反选排除有两条路：input 的 `Exclude_Path` 按文件名排掉整个文件；pod 注解 `fluentbit.io/exclude: true` 加 filter 的 `K8S-Logging.Exclude on`。注解这条有个总开关，默认关，注解不生效先查这道 gate（`kube_property.c:31-67`）。

还有个物理约束躲不掉：DaemonSet 形态下每个 agent 只挂本节点的 `/var/log`，"某个 deploy 的日志"天然散落在多个节点，每个 agent 只采得到本机那份。想只采一个 pod 的时候，其余节点都在白扫，到 grep 阶段才丢，量大时输入侧 CPU 是浪费。这种场景应该考虑 sidecar。

## 日志不止 stdout：六种挂载方式的支持矩阵

判据只有一条：DaemonSet 形态的 Fluent Bit 只能读到"出现在节点文件系统、且挂进了它自己容器"的路径。

| 方式 | 支持 | 读法 |
|---|---|---|
| stdout | ✅ 零配置 | 标准场景，整条富化链路自动生效 |
| 容器内文件，不挂载 | ❌ 架构无解 | 文件在容器 overlayfs 里，宿主机不可见；改 stdout 或 sidecar 共享卷 |
| emptyDir | ✅ 有条件 | 实体在 `<kubelet root>/pods/<uid>/volumes/kubernetes.io~empty-dir/`；挂该目录或用 sidecar |
| hostPath | ✅ 最干净 | hostPath 挂进 fluent-bit 容器直接 tail |
| PVC | ⚠️ 基本不行 | CSI 驱动在节点上多数没有可读路径；官方立场不支持，走 sidecar 同 pod 共享 |
| NFS | 看主体 | 宿主机直接 mount 等同 hostPath；pod 内挂同 PVC |

方式三到六就算读得到，filter_kubernetes 的自动身份解析也失效，默认正则只认 `/var/log/containers/<pod>_<ns>_<container>-<id>.log` 这一种形态。emptyDir 的路径里带 pod uid，写个自定义 `Regex_Parser` 能救；hostPath 和 NFS 完全没有 k8s 语义，身份注入得自己来：文件名约定、record_modifier 打静态标签，或者干脆放弃粒度。

选型上我的排序：能 stdout 就 stdout；必须写文件就走 sidecar 加共享卷；hostPath 和 NFS 是兜底，得接受没有自动身份。

## stdout 的格式谁说了算

有一对变量容易记反：

| 变量 | 由谁决定 | 说明 |
|---|---|---|
| stdout 内容格式 | container runtime | docker 是 JSON `{"log","stream","time"}`；containerd/CRI-O 是 CRI 格式 `时间戳 stdout F 内容`，超 16KB 切分 partial 行（P/F 标志） |
| stdout 分水岭 | k8s 1.24 | 删 dockershim 后 runtime 收敛到 CRI，"格式跟 k8s 版本走"是时间线巧合 |
| stdout 路径 | 两时代稳定 | `/var/log/containers/<pod>_<ns>_<container>-<id>.log` 的 symlink scheme 不变，默认正则通吃；差异在 symlink 背后（docker 是 `pods/<uid>/<container>_0.log`，containerd 是 `pods/<uid>/<container>/0.log`），fluent-bit 追 symlink，透明 |
| emptyDir 路径 | kubelet，与 runtime 无关 | `<kubelet root>/pods/<uid>/volumes/kubernetes.io~empty-dir/<vol>/`；`medium: Memory` 是 tmpfs，路径不变 |

对采集器的实际影响在 CRI 时代：parser 要用 cri 多行 parser 或 in_tail 的 `Docker_Mode`（`tail_config.c:280`）把 partial 行重组，配错了就是带着 P/F 标志的裸日志，或者切散的堆栈。

## symlink 再套一层，就断了

官方 DaemonSet 挂的是整个 `/var/log`，`/var/log/pods` 作为子目录顺带带入，另有 `/var/lib/docker/containers` 的挂载（docker 时代遗留，containerd 下可以省）。

坑在这：有的宿主机根分区小，`/var/log/pods` 本身是 symlink，链到 `/data/k8s/logs`。symlink 解析发生在 fluent-bit 容器的 mount namespace 里：

```
容器内: /var/log/containers/x.log → /var/log/pods/... → /data/k8s/logs/...  ← 不存在，ENOENT
```

glob 能列出文件，一打开就报错，采不到任何数据。inode 身份和轮转检测不受影响（作用在最终目标上），断的只是最后一跳。

两个修法。推荐的那个：把 `/data` 也 hostPath 挂进容器，绝对路径保持跟宿主机一致，其余配置全不动。绕过的那个：input 的 `Path` 指真实路径，但必须同步改 Tag 和 `Kube_Tag_Prefix`：

```ini
Path  /data/k8s/logs/containers/*.log
Tag   kube.data.k8s.logs.containers.
# filter 侧：Kube_Tag_Prefix kube.data.k8s.logs.containers.
```

忘改前缀，身份解析直接失败，记录静默丢掉 `kubernetes` 字段。排障就一条命令：`kubectl exec ds/fluent-bit -- stat -L /var/log/containers/<file>.log`，容器内 ENOENT 而宿主机成功，就是"最后一跳没挂进容器"。

## pod"漂移"与逻辑身份

先纠正一个说法：pod 从不跨节点漂移，生命周期内绑死一个节点。看到的"漂移"是 pod 销毁重建，新名字新 uid，落到了新节点。

采集连续性反而是天然无缝的：新节点的 agent 自动发现新文件、照常富化，老节点的 agent 继续读完清理前的文件，各节点 agent 各自为政在这一刻是优点。唯一的漏洞是节点宕机式的"漂移"：老节点 fluent-bit 积压的 chunk 随节点一起消失，`storage.type filesystem` 加 `DB` 只防 agent 重启，防不了节点死亡。

聚合身份有四条路，按推荐排序：

1. labels（正解）：`template.labels` 不随重建和漂移变，新 pod 原样继承，`kubernetes.labels.app` 就是稳定逻辑身份。避开 `pod-template-hash`。
2. pod_id(uid) 加下游 join：对 kube-state-metrics 或 API 查 ownerReferences，严格但重，计费审计场景用。
3. AWS 模式白嫖：`aws_entity_workload` 里已有 deploy 推导，开源版没接线。
4. pod_name 去尾两段：纯约定，StatefulSet、Job、裸 pod 都会推错，只作兜底。

## hostPath 多副本混写：采一份，但不知道是谁的

场景很常见：3 节点、deploy 5 副本，某个节点上落了 2 个 pod，日志写 hostPath。

hostPath 没有命名空间隔离，同节点多 pod 挂同一个卷，应用再写固定文件名，就是写同一个 inode。O_APPEND 的话行级交错，不是 O_APPEND 就互相覆盖损坏。而且不同节点是不同的文件，pod 重建还换文件，逻辑上连续的日志物理上碎在多台机器。

对采集器来说，文件只有一份，tail 一份，不重复。但每一行没有任何字段表明归属哪个 pod，hostPath 没有 k8s 语义，自动富化失效。得到的是"某节点某时刻来源不明的混合物"，对排查来说比"两份带身份的数据"更没用。

修法有四个：改 stdout；hostPath 配 `subPathExpr: $(POD_NAME)`（downward API），每 pod 一个目录，采集侧还能从路径解析身份；emptyDir 加 sidecar；应用自证，JSON 里写上 pod 名。这是结构性缺陷，配置修不好。

## 流传度较高的那个总结，我给前半 8 分后半 4 分

网上流传度较高的一个总结是：fluent-bit"默认部署开箱即用、应采尽采、主打省心，但场景不全覆盖，下游查日志麻烦，不能快速定位业务 pod"。

"省心、应采尽采"成立，但范围是 stdout。它采的是"节点视角落到 /var/log 的一切"，不是"应用视角的一切"。写文件的、挂 PVC 的、埋进容器内部的，都不在这个圈里。

"场景不全覆盖"也成立，而且这是架构原罪：节点代理只看得见节点文件系统，跟用不用心没关系。

"不能快速定位 pod"这条我不认。pod_name、labels、uid、image 全在，按 label 过滤是下游标准操作，定位单个 pod 恰是这个方案最强的一环。

真正麻烦的是另外三件事：Deployment 维度不存在，业务按 deploy 聚合得自建映射；身份数据有时效暗坑，前面说过，TTL 默认 0，短 Job 可能整条没有元数据字段；身份来自路径约定，约定一变元数据静默消失，symlink 那节就是例子。

放到设计取向的坐标系里看：Filebeat autodiscover 是 watch 控制面的路线，感知 pod 生命周期，覆盖好但耦合重；OTel 的 k8sattributes 走中间路线，也是 watch；fluent-bit 是零控制面依赖的节点哑管道。**它的所有优点和所有缺陷，都是"零控制面"这一个选择的投影。**这句话是这一篇的纲，loggie 那半是同一个纲的镜像。

## 换 loggie 过同一张清单

loggie 是网易数帆开源的 Go 云原生日志采集器。读它的动机很直接：fluent-bit 把控制面依赖降到零，换来的短板清单很长，那如果一家采集器反着选，强耦合控制面，同一张清单会交出什么样的答案？我们内部维护了它的一个 fork，下面的锚点以 fork 为准。

| | fluent-bit | loggie |
|---|---|---|
| 身份来源 | 文件路径命名约定 + tag 正则硬猜 | informer list-watch 本节点 pod（`pkg/discovery/kubernetes/kubernetes.go:135-137`，按 `spec.nodeName` 过滤） |
| 配置形态 | 静态文件，重启生效 | CRD（LogConfig/ClusterLogConfig/Sink/Interceptor），controller reconcile 渲染 pipeline 写文件，reloader 10 秒轮询热加载（`controller/reconcile.go:341-370`、`pkg/core/reloader/reload.go:60-111`） |
| 元数据获取 | 惰性查 apiserver 加 TTL 缓存，默认 0 | informer 本地缓存；生成 pipeline 时把元数据写死进 source 的 fields（`controller/selectpodhandler.go:399-469`） |
| 控制面耦合 | 零 | 强：list-watch、CRD、写权限都要 |

### workload 维度是一等公民

这是我们生产环境里的实测字段：

```json
{
  "kube_pod_name": "web-5dbf59bdfb-6mwz5",
  "kube_pod_uid": "0403dcf4-...",
  "kube_namespace": "app",
  "kube_node_name": "node-49",
  "container_name": "web",
  "container_id": "b5876e54...",
  "image_name": "registry.local/web:1.0",
  "workload_kind": "Deployment",
  "workload_name": "web",
  "app": "web",
  "pod-template-hash": "5dbf59bdfb"
}
```

最后两列 labels 是全量带上的（selector 配了 labelKey `["*"]`）。`workload_kind` 和 `workload_name` 是 fluent-bit 开源版给不了的：推导逻辑在 `helper/workload.go:15-48`，解析 ownerReferences，Deployment 走"RS 名剥 template hash 后缀"，跟 fluent-bit AWS 模式里的 `DEPLOYMENT_REGEX` 是同一种思路，StatefulSet、DaemonSet、Job 直接取 owner。CronJob 没解析（`workload.go:45` 留着一行 `// TODO: parse cronjob`，只给到 Job 名）。

对照 fluent-bit 那半的清单：Deployment 维度没人给、漂移聚合四选一，这两个问题在 loggie 里根本不存在，`workload_name` 直接就是稳定逻辑身份，重建漂移自动跟随。

### label 时效：殊途同归，两家都不刷新

这条最不显眼，可能也是对比里最有意思的一条。

loggie 的 informer 确实能感知 pod label 更新，事件会进 workqueue。可 `typePodIndex.IsPodUpdated()` 只在 pod 不在索引、或容器 ID 变化时才判更新（`pkg/discovery/kubernetes/index/typepod_extension.go:9-27`）。label 值是生成 pipeline 时写死在 fields 里的静态快照，pod 更新不会触发重渲染。只有 LogConfig/ClusterLogConfig 本身变更（selector 变化会先删旧 pipeline 再重建，`controller.go:358-400`）或者 pod 删除重建，字段才刷新。

| 变更类型 | fluent-bit | loggie |
|---|---|---|
| 原地 `kubectl label pod` | 默认永不（TTL=0）；显式配 TTL 后最差 TTL | 同样永不，且无配置项 |
| 影响 selector 匹配关系的 label 变更 | 无 CRD 概念，grep 过滤即时生效 | LogConfig 不变就不重渲染，匹配关系也不变 |
| 滚动更新产生新 pod | 即时，新缓存 key | 即时，Delete+Add 事件触发重渲染 |

fluent-bit 的陈旧是"刷新机制存在、默认值是坑"；loggie 的陈旧是"架构上就没有这条刷新通道"。下游按 label 路由、按 label 计费的场景，两家都靠不住。

### CRD 圈选是正规军，但有三个缺口

`ClusterLogConfig.spec.selector`（`vendor/.../k8s-crd/loggie/apis/loggie/v1beta1/clusterlogconfig_types.go:54-62`）支持 workload 圈选（Deployment/StatefulSet/DaemonSet/Job 乘 name 列表乘 namespace 黑白名单）、labelSelector（等值加 exists，我们的 fork 还扩了 In/NotIn）、node 圈选和整集群，container 名还能精确、正则包含、正则排除（`selectpodhandler.go:49-76`）。

对照 fluent-bit 的三档粒度：单 pod 用 labelSelector 加 pod_name，label 圈选原生，deploy 圈选是一等公民。

缺口也摆出来。没有 pod 级 exclude 注解，fluent-bit 的 `fluentbit.io/exclude` 加总开关这套，loggie 没有对应物。空 selector 默认全选（`helper/pods_filter.go:61-73`），漏写 selector 就是集群级误采。workload 匹配在 reconcile 时同步 GET ReplicaSet（`helper/filter_cache_checker.go:171-187`；`controller.go:79-84` 声明了 lister 但没接线），apiserver 一抖，静默不采。

### 六种挂载方式全支持，靠渲染自动化

`helper/kube.go:164-227` 的 `PathsInNode` 负责把容器内路径翻译成节点路径：

| 场景 | 渲染结果 | 说明 |
|---|---|---|
| stdout | `/var/log/pods/{uid或ns_name_uid}/{container}/*.log` | 两条 glob 同时下，覆盖 1.14 前后两种 scheme；静态 pod 的 uid 取注解 `kubernetes.io/config.hash` |
| 容器内文件 | docker 走 overlay UpperDir；cri 走 `/proc/{pid}/root` | 要开 `rootFsCollectionEnabled`；只能采容器运行期新生成的文件，镜像自带的采不到 |
| emptyDir | `/var/lib/kubelet/pods/{uid}/volumes/kubernetes.io~empty-dir/{vol}` | |
| hostPath | 原样 | 业务 pod 和 loggie 容器都要挂这个目录 |
| PVC | `/var/lib/kubelet/pods/{uid}/volume-subpaths/{pvName}/{container}/{序号}` | 按 docker inspect Mounts 规则 |
| NFS | `/var/lib/kubelet/pods/{uid}/volumes/kubernetes.io~nfs/{vol}/{subPath}` | 要求各节点已 mount NFS |

关键差异是：任何挂载方式，身份字段都由 discovery 静态注入。fluent-bit 那半"换挂载方式就断元数据自动解析"的问题不存在。例外是节点文件（selector type: node），只带 `kube_node_name`，不带 pod 和 label，这跟 fluent-bit 相同，物理决定的。

symlink 上的取舍不同：loggie 不追 `/var/log/containers` 的 symlink，直接 glob `/var/log/pods` 实体（`helper/kube.go:229-237`），少一层解析断裂面。但如果宿主机把 `/var/log/pods` 链到 `/data` 且 `/data` 没挂进容器，loggie 同样采不到，glob 和 stat 直接失败。那个坑两家都在，只是触发面大小不同。

### 多副本重采：有标准解法，还剩一个死角

生产实测：6 节点、deploy 8 副本，同节点落 2 个 pod，业务侧用

```yaml
subPathExpr: $(NAMESPACE)/$(POD_NAME)    # env 来自 downward API
```

loggie 渲染出的路径自动按 pod 隔开，不重采，身份保留。fluent-bit 那半"采一份但无法溯源"的窘境直接不存在。

残余死角是共享 PVC/NFS 里的静态文件：镜像自带、多个 pod 同读的那种，必然重采。同一个文件被挂进多个 pod 路径，subPathExpr 也分不开。正解只有"采集节点文件"，放弃 pod 粒度。

### 文件采集的工程账

| 项 | fluent-bit in_tail | loggie file source | 评价 |
|---|---|---|---|
| offset 语义 | 已读取即落盘（系列第一篇：终止即丢内存积压） | 已投递：ack 链连续才写 `NextOffset`（`pkg/source/file/ack.go:222-248`、`persistence.go:288`） | loggie 优 |
| 文件身份 | inode 加 st_dev；SQLite 主键只 inode（系列第三篇） | dev+inode+前 256B 内容 MD5（`job.go:249-290`） | loggie 抗 inode 复用；代价是重命名识别要算 hash |
| 超长行 | 超 32KB 默认移除整个文件 | 累积，EOF 加 inactiveTimeout 后作末行发出，超 1MB 截断标记 `...[truncated]`（`process/lastline.go:33-73`、`truncate.go:16-26`） | loggie 优 |
| 背压 | 三态闸门；背压期文件删除立即放弃 | `tryRead` 非阻塞投递，满则释放 fd 转 zombie 重试（`job.go:300`、`watch.go:341-346`） | loggie 优 |
| 轮转检测 | inotify 事件加定时 stat 双保险 | 只 10 秒扫描，active 文件不走 fsnotify（`config.go:108`、`watch.go:187-214`） | fluent-bit 优：快轮转窗口 loggie 有丢尾风险 |
| CRI partial 行 | Docker_Mode 或 cri multiline 重组 P/F | 不重组：logtag 捕获即丢弃（`selectpodhandler_extension.go:283-292`、`codec/stdregex/stdregex.go:61-107`） | fluent-bit 优：loggie 长行、大 JSON 会碎，生产隐患 |

这张表读下来，loggie 在数据完整性的账面上占优，fluent-bit 在 partial 行重组和轮转检测上占优。partial 那行值得展开说一句：CRI 时代超 16KB 的行被 runtime 切成多条 P/F 记录，loggie 的 codec 把 logtag 抓到就扔，不拼。Java 的大日志、大 JSON 必碎。这是 fork 修补的第一优先级。

### 短生命周期 pod：链条环环丢尾部

Job 和 CronJob 的尾部日志，loggie 是结构性丢失，链条上一环扣一环：只处理 Ready pod，且 `IsPodReady` 要求 ContainerID 已上报（`helper/kube.go:44-56`），秒级 Job 可能从 Ready 到删除都赶不上一次 reconcile；Delete 事件一到立刻删 pipeline 配置（`reconcile.go:323-338`）；`JobStop` 状态的 job 不读到 EOF 直接忽略（`process.go:38-44`）；reloader 默认 10 秒轮询，再多一层延迟。

没有优雅收尾，finalizer 和 grace 配合这套是没有的。

### 大集群资源账要单独算

每 pod 一个 source，每次变更重写配置文件加 10 秒 reload。1000 以上 pod 的节点上，配置量和 reload 频率都很可观，`dynamicContainerLog` 模式能缓解（动态路径索引替代静态渲染，`index/typepod.go:231-300`）。pod informer、路径索引、typePodIndex 全是本地全量内存结构，短生命周期 pod 高频增删场景的内存和 reload 开销需要压测验证，我们没有数据。

### discovery 写得漂亮，文件采集透着外行

说点代码层面的整体印象。

discovery 这一套是真漂亮。informer 按节点过滤建本地索引、CRD reconcile 到渲染 pipeline 的职责划分、PathsInNode 的路径翻译、typePodIndex 的维护，模块边界清楚，该走的分支都走到了，一看就是专业的。

文件采集那一半是另一个水平。工程账那张表上 loggie 赢的四行，赢的是设计取向，投递才算数、内容指纹防 inode 复用、超长行累积，真落到实现细节，处处是没做完的痕迹：lister 声明了没接线，拿同步 GET 顶着；logtag 抓到就扔，partial 不重组；JobStop 的文件不读到 EOF；active 文件不走 fsnotify，靠 10 秒轮询扫。这些不是架构取舍能解释的，是文件采集这摊活的功夫没下够。单看 file source，我给勉强及格。

## 该选哪个

绕了这么大一圈，给个明确的说法。

纯 stdout 采集、想要零控制面依赖、apiserver 压力敏感的集群，fluent-bit 够用。in_tail 的工程细节糙，但生态和资料成熟，采 stdout 这条主路上没有硬伤。

需要 workload 维度做业务聚合、stdout 之外的日志形态多、想要 CRD 化圈选，loggie 的架构是对的方向。CRD 加 informer 把 fluent-bit 的三个结构性短板（deploy 维度、挂载覆盖、多副本隔离）从根上补掉了，这是架构选择的红利，不是堆功能堆出来的。

上游的维护状态绕不开。截至 2026-10，loggie 的 main 分支最后一次提交停在 2024 年 4 月，release 停在 v1.5.0，两年半没有动静。所以我的建议很直白：不要把上游直接引进生产，引进来就是你自己的了，bug 自己修、依赖自己升、漏洞自己补。它真正值得拿走的是设计思想，CRD 圈选、informer 本地索引、路径翻译渲染、workload 推导，这些搬到自己采集器里都成立。

真要用，就得像我们这样用 fork，把维护成本认下来，连同三条数据完整性短板一起：CRI partial 不重组、短 Job 丢尾、label 时效没有刷新通道。按业务影响排，我们的 fork 修补顺序是：① CRI partial 重组（Java 大日志必碎，最痛）＞ ② 短 Job 尾部（删 pod 前保留 source 读到 EOF 或超时）＞ ③ label 时效（IsPodUpdated 加 label 比对，下游按 label 计费路由时才痛）。

**我们自己的生产在 loggie 这一侧，跑的是内部 fork，理由很朴素：日志形态杂，stdout 之外写文件的多，workload 维度是硬需求，我们也愿意养它。**fluent-bit 那半我没放下，in_tail 的轮转双保险和 partial 重组，是 loggie 该抄的作业。

## 值得提上去的地方

fluent-bit 侧，三个候选 issue：

| # | 现象 | 锚点 | 修法方向 |
|---|---|---|---|
| 1 | `buffer_size` 默认 32K，label/annotation 多的 pod 元数据响应被截断，merge 出残缺的 `kubernetes` 字段 | `kubernetes.c:941` | 调默认值、超限重试、加可观测 |
| 2 | `kube_meta_cache_ttl` 默认 0，元数据永不过期，label 变更不可见，无指标可察觉 | `kubernetes.c:1232`、`kube_conf.c:134` | 非零默认值，加 stale 指标 |
| 3 | `search_workload()` 的 deploy 推导只接 AWS 字段，开源版没有 workload 维度 | `kube_meta.c:886,1624` | 通用化为可配置输出字段 |

loggie fork 侧，五个修补候选（前三个就是上面的排序）：

| # | 问题 | 锚点 | 方向 |
|---|---|---|---|
| 1 | CRI P/F partial 行不重组，16KB 以上行碎成多条 | `selectpodhandler_extension.go:283-292`、`codec/stdregex/stdregex.go:61-107` | codec 层按 logtag 重组，参考 fluent-bit 的 cri multiline |
| 2 | 短 Job：Ready 门槛、JobStop 不读 EOF、10 秒 reload 三叠加 | `helper/kube.go:44-56`、`process.go:38-44`、`reloader/reload.go:44-48` | 删除宽限：pod 删后保留 source 至 EOF 或超时 |
| 3 | label 原地变更不重渲染 | `index/typepod_extension.go:9-27` | IsPodUpdated 增 label 比对，或文档明示限制 |
| 4 | workload 匹配同步 GET RS，lister 声明了没接线 | `filter_cache_checker.go:171-187`、`controller.go:79-84` | 接 informer lister，失败重试而非静默不采 |
| 5 | 空 selector 默认全选 | `helper/pods_filter.go:61-73` | 空 selector 拒绝建任务，或显式 confirm |

## 排查入口速查

| 症状 | 第一站 |
|---|---|
| 记录没有 `kubernetes` 字段 | tag 是否含 Kube_Tag_Prefix → 正则是否匹配 → merge 失败（`kubernetes.c:841-860`）→ pod 已删 404 |
| 注解 `fluentbit.io/exclude` 不生效 | `K8S-Logging.Exclude` 总开关（`kube_property.c`） |
| 换了挂载路径后元数据消失 | `Kube_Tag_Prefix` 没同步改（symlink 那节） |
| `stat -L` 容器内 ENOENT | symlink 最后一跳没挂进容器（symlink 那节） |
| 按 label 过滤结果偏少 | TTL=0 元数据陈旧 / 短 Job 无元数据 / annotation 没开白名单 |
| merge 配置看着对但字段缺失 | merge_parser 解析失败走 NOTOUCH（`kubernetes.c:841-860`），查 fluent-bit 自身日志 |

## 最后

写完这一篇，我自己印象最深的不是哪个坑，是两家的对称性。fluent-bit 的每个短板都长在"零控制面"上，loggie 的每个短板都长在"控制面驱动"上，没有一条踩出自己架构的例外。K8s 采集器选到最后，功能清单都会越补越齐，真正拉开差距的是身份能力和数据完整性怎么取舍。而清单会宣传，坑不会，这一篇的坑，每一个都落在实测数据或行号上。

---

**相关**：[采集器工程](/systems/agent/)
