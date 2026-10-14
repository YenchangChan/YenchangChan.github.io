---
title: S3 Disk：把对象存储当慢盘用，会遇到什么
---

# S3 Disk：把对象存储当慢盘用，会遇到什么

ClickHouse 拿来做日志、监控、行为分析、审计，最常碰到的矛盾是：近期的数据要查得快，历史数据又不能删。

全放本地 NVMe，成本很快就失控了；全放对象存储，查询延迟和稳定性又扛不住。于是很多团队选了 ClickHouse 原生的 S3 Disk，用 storage policy 把数据从热盘一层层沉到 S3 上去。

S3 Disk 的好处是改造成本低。表还是 MergeTree，查询 SQL 基本不用动，写几条 TTL 规则就能做冷热迁移。

问题也恰恰出在这。ClickHouse 是想把 S3 包装成一块慢盘，可 S3 不是本地盘，没有低延迟的随机 IO，rename、list、delete 都不便宜，也不适合频繁 merge。数据量小的时候看不出来，规模一上来，很多默认行为都成了坑。

这篇只说 S3 Disk 这一条路：它怎么工作，生产上最容易在哪儿栽跟头，该怎么管。

## S3 Disk 是怎么工作的

ClickHouse 的存储抽象有三层。Disk 是物理存储，可以是本地目录、S3、HDFS；Volume 是一个或几个 Disk 的组合；Storage Policy 是一串有先后顺序的 Volume，决定数据在各层之间怎么流转。

典型的冷热分层配置长这样：

```xml
<storage_configuration>
  <disks>
    <hot>
      <path>/data/ch/hot/</path>
    </hot>
    <warm>
      <path>/data/ch/warm/</path>
    </warm>
    <s3_cold>
      <type>s3</type>
      <endpoint>https://bucket.s3-internal.example.com/cluster1/</endpoint>
      <metadata_path>/data/ch/s3_meta/</metadata_path>
      <access_key_id>xxx</access_key_id>
      <secret_access_key>xxx</secret_access_key>
    </s3_cold>
    <s3_cached>
      <type>cache</type>
      <disk>s3_cold</disk>
      <path>/data/ch/s3_cache/</path>
      <max_size>500Gi</max_size>
    </s3_cached>
  </disks>

  <policies>
    <tiered>
      <volumes>
        <hot><disk>hot</disk></hot>
        <warm><disk>warm</disk></warm>
        <cold>
          <disk>s3_cached</disk>
          <prefer_not_to_merge>true</prefer_not_to_merge>
        </cold>
      </volumes>
      <move_factor>0.1</move_factor>
    </tiered>
  </policies>
</storage_configuration>
```

表上配 TTL：

```sql
CREATE TABLE logs (...)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (user_id, event_time)
SETTINGS storage_policy = 'tiered'
TTL
  event_time + INTERVAL 7 DAY  TO VOLUME 'warm',
  event_time + INTERVAL 30 DAY TO VOLUME 'cold',
  event_time + INTERVAL 365 DAY DELETE;
```

关键在于，part 放到 S3 上以后，仍然是一组 ClickHouse 自己的文件，`.bin`、`.mrk2`、`.idx`、`checksums.txt`、`columns.txt` 这些一个不少。本地的 `metadata_path` 记着逻辑文件名到 S3 object key 的映射。

这就带来三个直接的后果。本地这个 `metadata_path` 是要命的数据，丢了就很难恢复。part 越多，S3 上的对象就越多，list、delete、备份都跟着变贵。启动、ATTACH、校验的时候，都可能要去 S3 上读 part 的自描述文件。

生产上一般还会在 S3 Disk 上面再叠一层 `cache` disk。同一段冷数据被反复查，体验好不好基本就看 cache 命中率；要是只为合规归档、几乎不查，cache 也就没多大用。

整个 storage policy 的数据流向是这样的：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/s3-disk-01.light.svg" alt="S3 Disk 的数据流向：数据按时间从热盘、温盘下沉到带 cache 的 S3 冷盘，查询按需打到对应层">
<img class="dfig-d" src="/diagrams/s3-disk-01.dark.svg" alt="S3 Disk 的数据流向：数据按时间从热盘、温盘下沉到带 cache 的 S3 冷盘，查询按需打到对应层">
</figure>

数据按时间往下沉，查询按需打到对应的那一层。这套方案能不能用，关键看冷查询的体验。cache 命中率低的话，冷查询就又回到了直接裸打 S3 的状态，后面冷查询那一节会细说。

## 它适合多大的规模

S3 Disk 比较适合这样的场景：数据在几十 TB 到 PB 以内，热数据还在本地盘，冷数据偶尔回溯一下、不是高频交互式查询，团队想尽量保住 MergeTree 的查询体验，暂时也不想引入 Parquet、Iceberg、Trino、Spark 这一套。

它最划算的区间大概是 100TB 到 1PB。低于这个也能用，不过更多就是省点存储钱，用不着一整套工程化的东西；高于这个，merge、元数据、对象数量、冷查询治理会慢慢变成主要成本。

这个区间也别当成硬杠杠。真正决定选型的是查询频率、保留期、副本数、对象存储的价格和运维团队的能力，光看数据量是不够的。

## 历史数据直接落冷盘，在 S3 上 merge

最常见的事故出在历史数据回灌上。比如业务规定 90 天以前的数据进冷盘。新系统上线，一次性导入一年前的历史数据。这些数据在 INSERT 的时候就已经满足 TTL 了，ClickHouse 可能直接把它们写进 cold volume。

要是写入批次又小，S3 上就会冒出一大堆小 part，接着后台 merge 就在 S3 上跑起来了：

```text
GET 多个小 part -> 本地合并 -> PUT 大 part -> DELETE 小 part
```

结果就是 S3 的 GET、PUT、DELETE 请求数、网络带宽、对象数和账单一起往上涨。

关键参数是这个：

```xml
<merge_tree>
  <perform_ttl_move_on_insert>0</perform_ttl_move_on_insert>
</merge_tree>
```

把 INSERT 阶段直接按 TTL 移动关掉，让所有数据先进热层；cold volume 上设 `prefer_not_to_merge=true`；历史回灌走一张专用的本地表，先在本地把 part 合到合适的大小，再手动 MOVE 到 S3 上去。

冷盘上能不 merge 就别 merge，S3 上 merge 一次要付的请求数和带宽代价太容易失控。

## 冷查询打爆带宽和内存

冷数据查得慢，不光是因为 S3 慢，还因为冷查询往往没人管。

一个用户查 7 天的历史明细，预估 70GB，看着就是一次大查询而已。实际上它可能把 S3 出口带宽打满，让 ClickHouse 去读一大堆远端对象，查询里要是有全局 ORDER BY、GROUP BY 或者 JOIN，内存还会暴涨；客户端拉得慢，服务端的 buffer 就跟着堆，最后连同集群其他的热查询也一起受影响。

扫 70GB 本身不一定 OOM。真正容易 OOM 的，是全量 ORDER BY 或者高基数 GROUP BY 没有落盘，JOIN 方式不对，结果格式或者客户端的行为让服务端一直在攒 buffer，再加上用户 profile 根本没限制扫描量、内存和并发。

第一层是 profile 的硬限制：

```xml
<profiles>
  <restricted>
    <max_memory_usage>10000000000</max_memory_usage>
    <max_memory_usage_for_user>20000000000</max_memory_usage_for_user>
    <max_bytes_to_read>50000000000</max_bytes_to_read>
    <max_rows_to_read>2000000000</max_rows_to_read>
    <max_bytes_before_external_group_by>5000000000</max_bytes_before_external_group_by>
    <max_bytes_before_external_sort>5000000000</max_bytes_before_external_sort>
    <max_execution_time>1800</max_execution_time>
    <max_concurrent_queries_for_user>2</max_concurrent_queries_for_user>
    <max_threads>4</max_threads>
    <force_index_by_date>1</force_index_by_date>
    <force_primary_key>1</force_primary_key>
    <readonly>1</readonly>

    <constraints>
      <max_memory_usage>
        <max>10000000000</max>
      </max_memory_usage>
      <max_bytes_to_read>
        <max>50000000000</max>
      </max_bytes_to_read>
    </constraints>
  </restricted>
</profiles>
```

`constraints` 一定要配，不然用户在查询里写个 `SETTINGS` 就把限制覆盖掉了。

第二层是查询分流。近实时的查询走热表，趋势类的走预聚合表，大范围的冷明细走异步导出，审计探索类的查询走独立的 reader 节点或者查询网关。

异步导出，就是把「用户实时查 100GB 冷数据」变成「跑个批处理任务，完了离线下载」。SLA 从秒级降到小时级，但生产集群不受影响。典型的流程是用户提单，Airflow 跑一句 `INSERT INTO FUNCTION s3('s3://exports/.../result.parquet.gz', 'Parquet') SELECT ...`，跑完发邮件通知下载链接。设计上要注意几点：结果直接流式写进 S3，不经过客户端；按天拆开并行跑；用 `max_threads` 和 `s3_max_get_rps` 限速；输出 Parquet，别输出 CSV。

要是用户要的是交互式探索，比如 BI 钻取，异步导出的体验还是太差，那还有第三种思路，流式查询。在查询代理这一层，把大查询按时间自动拆成很多小查询，挨个执行，结果流式拼起来返回。7 天的明细查询拆成 168 个 1 小时的子查询，低并发地跑，用户看到的是数据源源不断地进来，首字节秒级返回，随时可以中断。

流式查询有个前提，查询得有能拆的维度。`SELECT *` 加时间过滤的明细、SUM/COUNT/AVG/MIN/MAX 这种能累加的聚合、`GROUP BY` 时间维度，都适合拆；`DISTINCT count`、`quantile`、复杂 JOIN、全局 `ORDER BY` 就拆不了，或者得特殊处理。实现上可以放在 SDK 里、代理网关里，或者 BI 工具那一层，金融、政企一般倾向在 chproxy 外面再加一层查询拆分网关统一管。

三种思路按用户有多少耐心、查询是什么模式来搭配：

<figure class="dfig">
<img class="dfig-l" src="/diagrams/s3-disk-02.light.svg" alt="冷查询的三种分流思路：预聚合、异步导出、流式查询，按用户耐心和查询模式搭配">
<img class="dfig-d" src="/diagrams/s3-disk-02.dark.svg" alt="冷查询的三种分流思路：预聚合、异步导出、流式查询，按用户耐心和查询模式搭配">
</figure>

这三种并不互斥，不同业务线可以各用各的。预聚合最适合趋势分析，异步导出做合规批量查询最稳，流式查询做交互式探索体验最好。不管用哪种，都别默认用户可以实时查冷数据。

第三层是网络和对象存储的隔离。ClickHouse 用专门的 bucket、专门的 endpoint、专门的 IAM，冷查询的用户单独限流，S3 的 GET、PUT 请求速率在 ClickHouse 这边和对象存储那边都要设上限。

### 一次真实的事故

有个 110TB 的集群出过这么一回事。审计这块本身是设计过治理的，可别的部门有个用户用普通账号查 7 天的历史数据，预计返回 70GB。结果 ClickHouse 内存被打爆，OOM 了；S3 出口带宽也被占满了，走的是公网，没有专线；同机房其他部门访问 S3 也跟着受了影响。

事后复盘，缺了四样东西：用户级 profile 没设 `max_memory_usage` 和 `max_bytes_to_read`；S3 走的是公网，没走 VPC endpoint；没有设 `s3_max_get_rps`；没开 `force_index_by_date`，全分区扫描也放行了。

修的时候按这个顺序来：

| 优先级 | 动作 | 工时 | 效果 |
|---|---|---|---|
| P0 | 给非核心用户加 `restricted` profile | 1 小时 | 立刻防 OOM |
| P0 | 加 server 级 `s3_max_get_rps` | 30 分钟 | 立刻防 S3 打爆 |
| P1 | 改 S3 endpoint 为 VPC endpoint | 半天 | 解决 80% 网络问题 |
| P1 | 加 quota 配额 | 1 小时 | 防止累积打爆 |
| P2 | `force_index_by_date = 1` + row policy | 1 天 | 拦住灾难查询 |
| P2 | 异步导出工具 | 1 周 | 引导大查询走正确路径 |
| P3 | 独立 reader 节点 | 2 周 | 彻底隔离 |

这次事故里，storage policy、cache、TTL 都是照设计配好的，缺的只是账号上的那几条限制。

## S3 不可达，启动卡住

S3 Disk 还有个典型的风险：S3 短暂不可达，按理说只该影响冷数据，结果 ClickHouse 一重启就卡在启动阶段，热数据也跟着用不了。

原因是启动过程中不光做 access check，attach part 的时候还可能去读 S3 上的 `checksums.txt`、`columns.txt` 这些 part 自描述文件。

应急的时候别再指望「改错 endpoint 加 `skip_access_check`」这种 22.x 时代的偏方了。更稳的顺序是：

1. 23.11 及以后的版本，提前启用 `async_load_databases=1`（24.6 起默认已开）
2. 必要时物理移走表 SQL 元数据文件，让 server 先起来
3. S3 恢复后再显式 ATTACH

`skip_access_check` 就是跳过启动时对 S3 的那次检查，别把它当成 S3 完全不可达时的救命稻草。

这个话题细节很多，我单独写了一篇：[S3 不可达时起不来：metadata 明明在本地，它却说 S3 上找不到](/clickhouse/troubleshooting/s3-unreachable-startup)。

## 副本各存一份，加副本很贵

开源 ClickHouse 的 S3 Disk 走的还是 Shared-Nothing 的路子。每个副本一般有自己的 S3 路径，ReplicatedMergeTree 的 part 同步照旧通过 Keeper 协调、interserver HTTP 传输。

也就是说，2 副本在 S3 上就是两份数据。新加一个副本，可能要从源副本把 part 下载下来，再上传到新副本的 S3 路径，带宽、时间、对象存储请求数都要花不少。

zero-copy replication 曾经想解决这个问题，让多个副本共享 S3 上的同一份 part。可它有引用计数的 bug，22.8 以后默认就关了（`allow_remote_fs_zero_copy_replication=0`），24.x 以后官方文档也明说不建议用在生产上。开源社区基本已经放弃这条路了。

所以生产上更常见的做法是：认了副本各存一份，换个稳定；副本数在集群初始化的时候就定好，别老动态扩；读要扩展，优先靠加 shard、reader 节点和 Distributed 查询层，而不是一个劲地加副本；真需要共享存储的架构，就去考虑 ClickHouse Cloud 的 SharedMergeTree 或者别的存算分离系统。

## 参数清单

### 写入和 TTL

| 参数 | 类型 | 推荐 | 说明 |
|---|---|---|---|
| `perform_ttl_move_on_insert` | MergeTree setting | `0` | 历史数据不要 INSERT 时直接落冷盘 |
| `prefer_not_to_merge` | volume 选项 | `true`（仅冷盘）| 冷盘上不再 merge，见下文 |
| `merge_with_ttl_timeout` | MergeTree setting | 适当拉长（默认 14400s = 4h）| 控制 TTL merge 频率 |
| `max_data_part_size_bytes` | volume 选项 | 按业务设定 | 限制该 volume 上单个 part 的最大字节 |

`prefer_not_to_merge` 这个选项，官方文档里有一句很重的警告：「You should not use this setting. It disables merging of data parts on this volume (this is harmful and leads to performance degradation).」可在 S3 冷盘这个场景下，社区还是普遍在用，因为 S3 上 merge 一次要 GET 旧 part、PUT 新 part、再 DELETE 旧 part，代价比不 merge 留一堆小文件高得多。用它有几个前提：part 数量本身得控制住，靠的就是前面说的先在本地合好再 MOVE 到冷盘；查询不依赖大 part 的顺序扫描；能接受 part 多一点。热盘、温盘上千万别开。

### S3 限速

`s3_max_get_rps` 这几个是查询级的设置，可以放在 profile 里对用户生效，也可以写在 S3 disk 的配置里，对这块盘上的所有读写生效：

```xml
<s3_cold>
  <type>s3</type>
  ...
  <s3_max_get_rps>500</s3_max_get_rps>
  <s3_max_get_burst>1000</s3_max_get_burst>
  <s3_max_put_rps>200</s3_max_put_rps>
</s3_cold>
```

这只是 ClickHouse 这边的自我约束，生产上还得配合查询入口的限流和对象存储那边的隔离。

### 缓存

```xml
<s3_cached>
  <type>cache</type>
  <disk>s3_cold</disk>
  <path>/data/ch/s3_cache/</path>
  <max_size>500Gi</max_size>
  <max_file_segment_size>8Mi</max_file_segment_size>
  <cache_on_write_operations>1</cache_on_write_operations>
  <enable_filesystem_cache_log>1</enable_filesystem_cache_log>
</s3_cached>
```

看命中率。`system.filesystem_cache_log` 里没有现成的 hits、misses 字段，要用 `read_type` 来算：

```sql
SELECT
  countIf(read_type = 'READ_FROM_CACHE') / count() AS hit_ratio,
  sumIf(size, read_type = 'READ_FROM_CACHE') / sum(size) AS byte_hit_ratio
FROM system.filesystem_cache_log
WHERE event_time > now() - INTERVAL 1 HOUR;
```

### 启动

`async_load_databases` 是服务端的顶层配置，直接写在 `config.xml` 的根下，不在 `<merge_tree>` 里：

```xml
<clickhouse>
  <async_load_databases>1</async_load_databases>
</clickhouse>
```

它修不好 S3，但能避免某几张表 attach 慢或者失败的时候把整个 server 拖住。23.11 起有这个参数，24.6 起默认配置里已经开了。

## 监控看什么

看哪些查询在拉 S3：

```sql
SELECT user, query_id,
       ProfileEvents['S3GetObject'] AS gets,
       formatReadableSize(ProfileEvents['ReadBufferFromS3Bytes']) AS s3_bytes,
       query_duration_ms / 1000 AS duration_s
FROM system.query_log
WHERE event_time > now() - INTERVAL 1 HOUR
  AND ProfileEvents['S3GetObject'] > 1000
ORDER BY gets DESC
LIMIT 20;
```

看内存压力：

```sql
SELECT user, max(memory_usage), avg(memory_usage)
FROM system.query_log
WHERE event_time > now() - INTERVAL 1 DAY
GROUP BY user
ORDER BY max(memory_usage) DESC;
```

看 S3 报错：

```sql
SELECT name, value, last_error_time, last_error_message
FROM system.errors
WHERE name LIKE 'S3_%';
```

除了 S3 读了多少字节，还要盯着 `system.parts` 的行数、单表的 active part 数、Keeper 的节点数、filesystem cache 命中率，以及冷查询用户的扫描量和失败率。

## 什么时候别再往 S3 Disk 上打补丁

冷数据几乎没人查，只是为了合规留着；保留期从 1 年拉长到 5 年、7 年、10 年；Keeper 元数据和 part 数开始成了瓶颈；大量数据要给 Spark、Trino、DuckDB 或者别的团队用；冷明细要在线查，可 ClickHouse 主集群已经被拖累了；运维的大把时间都花在 S3 Disk 的对账、缓存、启动、TTL 调度上。碰到这些情况，就该考虑换路了。

常见的出路有两条。超冷的合规归档，走 [BACKUP/RESTORE](/clickhouse/cold-storage/backup-restore)；冷数据还要在线查、还要给别的引擎用，走 [S3 Engine + Parquet](/clickhouse/cold-storage/parquet)。

## 最后

S3 Disk 是个很好的过渡方案，它让 ClickHouse 用户花不多的成本就做成了冷热分层，不用一上来就引入一整套数据湖。

可它的代价也摆在那儿：你还是在用 MergeTree 那一套去管 S3 上的数据。merge、mutation、副本、part、metadata、启动校验，这些在本地盘上都很合理，搬到对象存储上，每一样都得额外去管。

所以别以为配个 storage policy 就完事了。S3 Disk 是一套生产系统，查询治理、网络隔离、缓存策略、元数据保护、应急流程，缺了哪样都可能出事。
