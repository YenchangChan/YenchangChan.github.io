# 系统底层

比 ClickHouse 更下面的那一层。

这些问题大多是在采集场景下暴露的 —— 采集器跑在客户的业务机上，资源被业务挤压，出了事进不去现场。但问题本身往往不在采集器。

<div class="entries">

<a class="entry" href="/systems/kernel/">
<h3>内核问题定位</h3>
<p>crash 解析 vmcore、比对发行版内核 diff，再用上游同型补丁交叉验证。</p>
</a>

<a class="entry" href="/systems/resources/">
<h3>资源与容器</h3>
<p>cgroup 实际生效的 quota/period，往往比查应用更快指向根因。</p>
</a>

<a class="entry" href="/systems/agent/">
<h3>采集器工程</h3>
<p>跑在别人业务机上的程序：要高性能，又不能喧宾夺主。</p>
</a>

<a class="entry" href="/systems/k8s/">
<h3>K8s 与容器采集</h3>
<p>容器日志、对象与事件、容器指标，以及混合环境下的口径统一。</p>
</a>

</div>
