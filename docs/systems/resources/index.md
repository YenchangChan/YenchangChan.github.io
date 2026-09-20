# 资源与容器

<!-- TODO：
  · 超分集群叠加 cgroup CPU 限额是反模式
    实际核 1 × 物理核 5 ÷ 超分 32 vcore = 15.625%，与 cgroup 实测值完全吻合。
    方法：遇到 CPU 被压在某个固定百分比，从 cgroup 实际生效的 quota/period
          反推资源模型，通常比查应用快。
  · 采集器在别人业务机上的资源约束：要高性能，又不能喧宾夺主
  · YARN resource-calculator 未按配置生效
-->
