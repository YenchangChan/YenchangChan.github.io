---
title: ClickHouse 到底要不要写 UDF
---

# ClickHouse 到底要不要写 UDF

想把业务逻辑塞进 ClickHouse 的人，迟早会问到 UDF。我的看法是，ClickHouse 里的三种 UDF 能力差着一个数量级，而大多数「需要 UDF」的场景，其实不该用 UDF 去解决。这篇先把三种 UDF 讲清楚，再讲什么时候该把逻辑放进数据库、什么时候该留在应用层。

## 三种 UDF

ClickHouse 的 User Defined Function 不是一个东西，是三套机制摆在一起：

| 形态 | 引入时间 | 本质 | 成熟度 |
|---|---|---|---|
| SQL UDF | 21.10 前后 | AST 表达式宏，查询分析期展开 | 完全成熟 |
| Executable / Executable Pool UDF | 2021 | 外挂子进程，通过 stdin/stdout 通信 | 生产可用，有工程负担 |
| WASM UDF | 26.3 | 嵌入 Wasmtime 沙箱，加载 .wasm 模块 | 实验阶段，不推荐生产关键链路 |

它们跑在哪、性能在什么档次，完全不一样，大致的量级是这样：

```
内置函数             ▮▮▮▮▮▮▮▮▮▮  baseline (SIMD + C++)
SQL UDF              ▮▮▮▮▮▮▮▮▮▮  等价于内置（展开后向量化）
WASM UDF             ▮▮▮▮▮▮▮       2~3x 慢于内置
executable_pool      ▮▮▮            10~50x 慢（Go/Rust + RowBinary）
executable (Python)  ▮              百倍以上慢
```

SQL UDF 算是 ClickHouse 本身的一部分，该用就用。executable 和 WASM 是往外延伸能力的口子，是实在没办法时的退路，不该是首选。

## 先跟几个相近的东西分开

UDF 经常被跟几样东西混在一起，先掰扯清楚。

它不是存储过程。存储过程是命令式的，有 `BEGIN/END`、变量、`IF/WHILE`、多条语句，还有副作用。ClickHouse 压根就没有存储过程这个概念，OLAP 也用不上。SQL UDF 是把一个表达式绑在一个名字上，更像 C 里的 `#define`，或者 SQL 标准里的 inline scalar function，跟 PL/pgSQL 不是一回事。从 PostgreSQL、MySQL 转过来的人最容易在这上面想岔。

它也不是字典。字典是 ClickHouse 拿来查外部数据的，KV、外部数据库、HTTP 都行，用 `dictGet` 访问。凡是想在 UDF 里查另一张表、查外部 KV 的，都应该用字典，字典有缓存、有生命周期、有刷新策略，UDF 一样都没有。

它也不是 macros。ClickHouse 的 `macros` 是字符串级别的模板替换，主要用在 DDL 里：

```xml
<macros>
  <shard>01</shard>
  <replica>node-a</replica>
</macros>
```

```sql
CREATE TABLE t ON CLUSTER '{cluster}' (...)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/t', '{replica}');
```

每个节点用自己的 `macros` 值去展开，替换发生在 DDL 解析期。

它也不是 named collection。named collection 是有名字的参数包，主要用来管理 S3、HDFS、外部数据源的连接凭据：

```xml
<named_collections>
  <my_s3>
    <url>https://...</url>
    <access_key_id>...</access_key_id>
  </my_s3>
</named_collections>
```

```sql
SELECT * FROM s3(my_s3);
```

它更像 `.env` 文件或者 Ansible 的 vars，解决的是凭据别到处散落、权限好控、好轮换，跟代码复用没关系。

这三样都是在执行之前做替换，只是替换的东西不一样：

```
macros            → 字符串模板替换，DDL 解析期（像 envsubst）
SQL UDF           → AST 表达式替换，查询分析期（像 C 的 #define）
named collection  → 参数包查表 + kwargs 合并，分析期（像 .env）
```

## SQL UDF：几乎零成本

```sql
CREATE FUNCTION linear_eq AS (x, k, b) -> k*x + b;
SELECT linear_eq(number, 3, 7) FROM numbers(10);
```

SQL UDF 其实不是函数调用，是语法替换。`linear_eq(number, 3, 7)` 在分析阶段就被换成了 `3*number + 7`，到了执行器那里，跟你手写这个表达式完全一样。所以它没有运行时开销，照样向量化、照样吃 SIMD，profile 里的各种限制对它一样生效，也能被优化器下推、折叠。

限制也很明确：函数体只能是一个表达式，不能写多条语句；不能递归；不能引用表，也就是没有 `SELECT ... FROM`；不能有副作用。

比起性能，它更有用的地方是把业务口径集中维护起来。GMV 怎么算、活跃用户怎么定义、留存怎么算，封装成 SQL UDF 以后，全公司的报表用同一套定义，改一处，处处生效。我觉得这是 ClickHouse 里最被低估的一个特性，SQL UDF 几乎不需要犹豫，该用就用。

创建、查看、替换、删除：

```sql
-- 创建
CREATE FUNCTION mask_phone AS (p) ->
    concat(substring(p, 1, 3), '****', substring(p, 8, 4));

-- 集群范围创建（走 Keeper DDL 队列）
CREATE FUNCTION mask_phone ON CLUSTER my_cluster AS (p) ->
    concat(substring(p, 1, 3), '****', substring(p, 8, 4));

-- 如果存在则替换
CREATE OR REPLACE FUNCTION mask_phone AS (p) ->
    concat(substring(p, 1, 3), '****', substring(p, 8, 4));

-- 查看所有 UDF(包括内置)
SELECT name, origin, create_query
FROM system.functions
WHERE origin = 'SQLUserDefined';

-- 删除
DROP FUNCTION mask_phone;
DROP FUNCTION IF EXISTS mask_phone ON CLUSTER my_cluster;
```

配合 lambda 和数组可以玩出不少花样：

```sql
-- 1. 业务口径：订单金额 → 阶梯佣金
CREATE FUNCTION commission AS (amount) ->
    multiIf(
        amount < 100,    amount * 0.05,
        amount < 1000,   amount * 0.08,
        amount < 10000,  amount * 0.10,
                         amount * 0.12
    );

SELECT order_id, amount, commission(amount) AS fee
FROM orders;

-- 2. 数组处理：对数组里每个元素应用脱敏
CREATE FUNCTION mask_phones AS (phones) ->
    arrayMap(p -> concat(substring(p, 1, 3), '****', substring(p, 8, 4)), phones);

SELECT user_id, mask_phones(phone_list) AS masked
FROM users;

-- 3. 多参数 + 复合判定：判定是否"高价值流失用户"
CREATE FUNCTION is_churned_vip AS (last_login_days, ltv) ->
    last_login_days > 30 AND ltv > 10000;

SELECT count() FROM users
WHERE is_churned_vip(dateDiff('day', last_login, today()), lifetime_value);

-- 4. 嵌套调用其他 UDF(可以，但小心展开后的 AST 体积)
CREATE FUNCTION fee_after_tax AS (amount, tax_rate) ->
    commission(amount) * (1 + tax_rate);
```

SQL UDF 本身不支持默认参数之类的设置，但可以用表达式绕一下：

```sql
-- 数据口径切换：线上 / 测试环境用不同标准
CREATE FUNCTION revenue_with_env AS (amount, env) ->
    if(env = 'prod', amount, amount * 0.1);
```

生产上 SQL UDF 常见的用处：

| 类别 | 例子 |
|---|---|
| 业务口径 | GMV / 活跃 / 留存 / LTV 计算 |
| 单位换算 | 时间戳 → 日期、字节 → MB、美分 → 美元 |
| 复合判定 | 「是否会员」、「是否高价值」、「是否风险订单」 |
| 字段标准化 | 大小写、trim、URL 归一化 |
| 脱敏 | 手机号、邮箱、身份证（可表达的算法）|
| 数组聚合 | 配合 `arrayMap` / `arrayFilter` 做行内聚合 |

## Executable UDF

```xml
<function>
  <type>executable_pool</type>
  <name>py_score</name>
  <return_type>Float64</return_type>
  <argument><type>String</type></argument>
  <format>TabSeparated</format>
  <command>python3 /var/lib/clickhouse/user_scripts/score.py</command>
  <pool_size>16</pool_size>
  <send_chunk_header>true</send_chunk_header>
  <max_command_execution_time>10</max_command_execution_time>
</function>
```

### 它是管道，不是调用

```
CH 主进程                   子进程
   │                          │
   │ ──── block of N rows ──→ │   (stdin)
   │                          │   处理…
   │ ←── block of N rows ──── │   (stdout)
   │                          │
   │ ──── 下一个 block ────→ │
```

数据是按 block 流过去的，一个查询可能传好几个 block。输入多少行，输出就必须是多少行，顺序一一对应，多一行少一行，查询失败，worker 的状态也乱了。开了 `send_chunk_header=true`，每个 chunk 前面会先发一行行数，脚本就知道这一批有几行，可以按 chunk 来处理；不开的话，脚本就只能读一行写一行，边读边回。pool 模式下我建议开着，脚本的边界清楚得多。

一个 Python worker 的模板：

```python
#!/usr/bin/env python3
import sys

# 1. 关闭 stdout 缓冲，否则 CH 永远收不到回包，query 挂死
sys.stdout.reconfigure(line_buffering=True)
# 或者启动时加 python3 -u

for size_line in sys.stdin:               # 2. 外层是 chunk 循环
    n = int(size_line.strip())
    for _ in range(n):                    # 3. 内层精确读 N 行
        line = sys.stdin.readline().rstrip('\n')
        print(do_something(line))         # 行数必须 == n
    sys.stdout.flush()                    # 4. 每个 chunk 手动 flush
```

这四点少一个，pool 模式下就会出各种诡异的问题，挂住、行错位、偶发崩溃都有。

### format 怎么选

format 对吞吐的影响是数量级的：

| format | 何时用 | 注意 |
|---|---|---|
| `TabSeparated` | 调试、字段全是简单标量 | 字符串里的 `\t` `\n` 要转义 |
| `JSONEachRow` | 字段多、有嵌套 | 解析慢，但 Python 写起来最舒服 |
| `RowBinary` | 高吞吐、字段类型固定 | Python 慢，Go/Rust/C++ 友好 |

经验上，Python 用 `JSONEachRow`，Go 和 Rust 用 `RowBinary`，`TabSeparated` 就留给 demo。

### executable 还是 executable_pool

| | `executable` | `executable_pool` |
|---|---|---|
| 每次 query 行为 | fork+exec 新进程 | 从池里拿空闲 worker |
| 冷启动 | 50–200ms（Python 更糟）| 0 |
| 适合 | 一次性 ETL | 高 QPS、低延迟 |
| 崩溃影响 | 仅当前 query | worker 出池，池子补人 |
| 状态污染 | 无 | 有，全局变量、缓存跨 query 残留 |

生产上基本只用 `executable_pool`。非 pool 的只适合一次性的离线 ETL，冷启动慢点无所谓的那种。

### 用什么语言写

Executable UDF 不挑语言，能读 stdin、写 stdout 就行。可部署起来差别很大：

| 语言 | 默认产物 | 能否完全静态 | 体感 |
|---|---|---|---|
| Go | 基本静态 | `CGO_ENABLED=0` → 单文件，连 glibc 都不要 | 部署最干净 |
| Rust | 默认动态链接 glibc | 加 `--target x86_64-unknown-linux-musl` 即可全静态 | 一行 flag 的事 |
| C++ | 默认动态链接 glibc | 静态可以但坑多（libstdc++、TLS、DNS）| glibc 兼容性最麻烦 |
| Python | 依赖解释器 + .so | 不可能 | 部署最重 |
| Java/JVM | 依赖 JRE | GraalVM native-image 可以 | JVM 冷启动 + 常驻内存让它不合适，除非 native-image |

不管哪种原生二进制，x86_64 和 aarch64 都得各出一份，Python 的 wheel 也一样。

### 调试

子进程的 stderr 默认会进 ClickHouse 的 server log：

```bash
grep -i 'user_scripts\|executable' /var/log/clickhouse-server/clickhouse-server.log
```

更靠谱的是让脚本自己写一个独立的日志文件（注意 systemd 的 PrivateTmp），而且让脚本能脱离 ClickHouse 单独跑：

```bash
printf '3\nfoo\nbar\nbaz\n' | python3 -u /var/lib/clickhouse/user_scripts/score.py
```

查询卡死了，按这个顺序查：`SHOW PROCESSLIST` 看查询还活着没有；`ps -ef | grep your_script` 看 worker 进程有几个；`strace -p <pid>` 看它是卡在 `read()` 等输入，还是卡在 `write()` 管道满了。十有八九是 stdout 没 flush，或者脚本按 chunk 读、XML 里却没开 send_chunk_header。

### 从配置到调用走一遍

下面从零部署一个 executable UDF，功能是给手机号做格式保留的脱敏，假设这个算法复杂到 SQL UDF 写不出来。

先确认主配置 `/etc/clickhouse-server/config.xml` 里有这两项，默认都有，确认一下就行：

```xml
<clickhouse>
    <!-- UDF 配置文件目录（默认就有，确认一下） -->
    <user_defined_executable_functions_config>
        *_function.xml
    </user_defined_executable_functions_config>

    <!-- 子进程脚本根目录（默认就有，确认一下） -->
    <user_scripts_path>/var/lib/clickhouse/user_scripts/</user_scripts_path>
</clickhouse>
```

通配符 `*_function.xml` 的意思是，ClickHouse 会扫所有以 `_function.xml` 结尾的文件，放在 `/etc/clickhouse-server/` 下面就行。

然后写 UDF 的 XML，`/etc/clickhouse-server/mask_phone_function.xml`：

```xml
<clickhouse>
    <function>
        <type>executable_pool</type>
        <name>mask_phone_ext</name>
        <return_type>String</return_type>
        <argument>
            <type>String</type>
            <name>phone</name>
        </argument>

        <!-- 高吞吐场景用 RowBinary; 这里为了脚本简单用 TabSeparated -->
        <format>TabSeparated</format>

        <!-- pool 必备 -->
        <send_chunk_header>true</send_chunk_header>
        <pool_size>16</pool_size>

        <!-- 超时保护 -->
        <max_command_execution_time>10</max_command_execution_time>
        <command_read_timeout>10000</command_read_timeout>
        <command_write_timeout>10000</command_write_timeout>

        <command>python3 /var/lib/clickhouse/user_scripts/mask_phone.py</command>
    </function>
</clickhouse>
```

再写子进程脚本，`/var/lib/clickhouse/user_scripts/mask_phone.py`：

```python
#!/usr/bin/env python3
"""
mask_phone: 对 11 位手机号做"保留前 3 + 中间 4 *  + 后 4"脱敏。
真实场景下这里会是你内部的脱敏算法(如 FPE / 自定义置换)。
"""
import sys
import os

# 密钥/盐从环境变量读，不要 hardcode
SALT = os.environ.get('MASK_SALT', '')

def mask(phone: str) -> str:
    phone = phone.strip()
    if len(phone) != 11 or not phone.isdigit():
        return '***INVALID***'
    return f"{phone[:3]}****{phone[7:]}"

def main():
    # 关键 1: 行缓冲，否则 CH 会一直等回包
    sys.stdout.reconfigure(line_buffering=True)

    # 关键 2: 外层 chunk 循环（因为 XML 里开了 send_chunk_header）
    for size_line in sys.stdin:
        try:
            n = int(size_line.strip())
        except ValueError:
            continue

        # 关键 3: 精确读 N 行
        for _ in range(n):
            line = sys.stdin.readline()
            if not line:
                return
            print(mask(line.rstrip('\n')))

        # 关键 4: 每个 chunk 处理完手动 flush
        sys.stdout.flush()

if __name__ == '__main__':
    main()
```

脚本必须是 clickhouse 用户能执行的：

```bash
sudo chown clickhouse:clickhouse \
    /var/lib/clickhouse/user_scripts/mask_phone.py
sudo chmod 0750 /var/lib/clickhouse/user_scripts/mask_phone.py
```

脚本要用的 salt，通过 systemd 的 EnvironmentFile 注进去：

```ini
# /etc/systemd/system/clickhouse-server.service.d/secrets.conf
[Service]
EnvironmentFile=/etc/clickhouse-server/secrets.env
```

```bash
# /etc/clickhouse-server/secrets.env  (chmod 0600, owner root:clickhouse)
MASK_SALT=your-real-salt-here
```

先脱离 ClickHouse 把脚本跑一遍，免得查询挂了再回头排查：

```bash
printf '3\n13800138000\n13912345678\n12345\n' \
    | python3 -u /var/lib/clickhouse/user_scripts/mask_phone.py

# 期待输出：
# 138****8000
# 139****5678
# ***INVALID***
```

XML 是自动监听的，几秒以后就生效了，也可以手动触发一下：

```sql
SYSTEM RELOAD FUNCTIONS;
```

executable UDF 不用 `CREATE FUNCTION`，XML 加载完它就是 SQL 里能直接用的函数：

```sql
-- 直接调用
SELECT mask_phone_ext('13800138000');
-- ┌─mask_phone_ext('13800138000')─┐
-- │ 138****8000                   │
-- └───────────────────────────────┘

-- 在查询里用
SELECT user_id, mask_phone_ext(phone) AS masked_phone
FROM users
WHERE register_date >= today() - 7
LIMIT 100;

-- 跟 SQL UDF 混用没问题
SELECT mask_phone_ext(phone) AS phone,
       commission(amount) AS fee
FROM orders;
```

确认一下 worker 池起来了：

```bash
# 应该看到 16 个常驻 python3 进程
ps -ef | grep mask_phone.py | grep -v grep | wc -l

# 看是否出现在 ClickHouse 的函数列表
clickhouse-client --query "
    SELECT name, origin
    FROM system.functions
    WHERE name = 'mask_phone_ext'
"
-- ┌─name──────────────┬─origin──────────────┐
-- │ mask_phone_ext    │ ExecutableUserDefined │
-- └───────────────────┴─────────────────────┘
```

权限上要知道一件事：ClickHouse 现在没有按函数控制谁能调用的权限，能管的只是谁能 `CREATE FUNCTION`、`DROP FUNCTION`，谁能 `SYSTEM RELOAD FUNCTION`。executable UDF 一旦加载上，所有能查询的用户都能调它。这一点在多租户的集群上很要命，后面还会说。

最后是更新。只改了 Python 脚本、XML 没动的话，ClickHouse 不会自己 reload，它只盯 XML，得手动执行 `SYSTEM RELOAD FUNCTIONS;`，它会把 pool 里的 worker 换掉，新 worker 跑的就是新脚本。改了 XML 的，比如调大 `pool_size`、换了 `command` 的路径，会自动 reload。

## WASM UDF

ClickHouse 在 26.3 里加了 WASM UDF，现在还是实验特性，要在 server 配置里打开：

```xml
<allow_experimental_webassembly_udf>true</allow_experimental_webassembly_udf>
<webassembly_udf_engine>wasmtime</webassembly_udf_engine>
```

### 外挂进程换成了内嵌沙箱

```
旧：  CH 进程  ──管道──►  python3 子进程
新：  CH 进程 ─函数调用─► Wasmtime VM(同进程内)
```

运行时是 Bytecode Alliance 的 Wasmtime，这是个生产级的东西。.wasm 是字节码，但它不走 JVM 那种解释加热点 JIT 的路子，Wasmtime 在模块实例化的时候就用 Cranelift 把整个模块编成机器码，之后跑的就是原生代码。

可以把 WASM 模块理解成一个关在沙箱里的动态库：

| 传统动态库 | WASM UDF |
|---|---|
| `.so` / `.dll` | `.wasm` 模块 |
| `ld.so` 动态加载器 | Wasmtime 运行时 |
| `dlopen` + `dlsym` | INSERT 进系统表 + `CREATE FUNCTION ... LANGUAGE WASM` |
| 跟 host 共享地址空间 | 独立 linear memory，host/guest 互不可见 |
| 跟 host 同权限 | 零默认权限，无 syscall、fs、net |
| 架构 + libc + 符号版本三重锁定 | 架构无关、无 libc 依赖 |

用起来是这么个流程：

```sql
-- 1. 把 .wasm 二进制灌进系统表（FORMAT RawBlob 流式上传）
INSERT INTO system.webassembly_modules (name, code) FORMAT RawBlob;

-- 2. 注册函数，绑到模块里 export 的符号
CREATE FUNCTION greet
LANGUAGE WASM
ARGUMENTS (name String)
RETURNS String
FROM 'my_module' :: 'greet';

-- 3. 像普通函数一样用
SELECT greet(user_name) FROM users;
```

Rust 那边用官方的 SDK，crate 叫 `clickhouse-wasm-udf`（仓库是 `clickhouse-wasm-udf-rs`）：

```rust
#[clickhouse_udf]
fn greet(name: String) -> Result<String, String> {
    Ok(format!("Hello, {name}!"))
}
```

target 用 `wasm32-unknown-unknown`，不是 wasi，模块必须是不依赖操作系统和标准库的 freestanding wasm32，`cargo build --release` 出 .wasm。宏和 import 的路径，官方文档里前后写得不太一致，以 SDK 仓库的 README 为准。

### 同一个脱敏函数，用 WASM 写一遍

拿前面那个手机号脱敏，用 WASM 再实现一遍，正好对比一下。

server 配置里打开实验特性：

```xml
<clickhouse>
    <allow_experimental_webassembly_udf>true</allow_experimental_webassembly_udf>
    <webassembly_udf_engine>wasmtime</webassembly_udf_engine>
</clickhouse>
```

资源限制是查询级的 setting，可以 `SET`，也可以写进用户的 profile：

```sql
SET webassembly_udf_max_memory = 67108864;          -- 每个实例的内存上限（字节）
SET webassembly_udf_max_fuel = 10000000;            -- 指令配额，防死循环
SET webassembly_udf_max_input_block_size = 65536;
SET webassembly_udf_max_instances = 16;
```

在开发机上建一个 Rust 项目：

```bash
cargo new --lib mask_phone_wasm
cd mask_phone_wasm
```

`Cargo.toml`：

```toml
[package]
name = "mask_phone_wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]    # 关键：必须是 cdylib

[dependencies]
clickhouse-wasm-udf = "0.1"    # 实际版本以 crates.io 为准
serde = { version = "1", features = ["derive"] }

[profile.release]
opt-level = "z"      # 体积优化（WASM 模块越小越好）
lto = true
codegen-units = 1
strip = true
```

`.cargo/config.toml`（项目本地）：

```toml
[build]
target = "wasm32-unknown-unknown"
```

`src/lib.rs`：

```rust
use clickhouse_wasm_udf::clickhouse_udf;

#[clickhouse_udf]
fn mask_phone(phone: String) -> Result<String, String> {
    let p = phone.trim();
    if p.len() != 11 || !p.chars().all(|c| c.is_ascii_digit()) {
        return Ok("***INVALID***".to_string());
    }
    Ok(format!("{}****{}", &p[..3], &p[7..]))
}

// 一个模块可以 export 多个函数
#[clickhouse_udf]
fn mask_email(email: String) -> Result<String, String> {
    match email.split_once('@') {
        Some((local, domain)) if local.len() >= 2 => {
            Ok(format!("{}***@{}", &local[..2], domain))
        }
        _ => Ok("***INVALID***".to_string()),
    }
}
```

编译，顺便瘦个身：

```bash
# 装 wasm32 target(只需一次)
rustup target add wasm32-unknown-unknown

# 编译
cargo build --release

# 产物
ls -lh target/wasm32-unknown-unknown/release/mask_phone_wasm.wasm
# -rwxr-xr-x ... 80K mask_phone_wasm.wasm   (例)

# 可选：进一步用 wasm-opt 瘦身
wasm-opt -Oz \
    target/wasm32-unknown-unknown/release/mask_phone_wasm.wasm \
    -o mask_phone.wasm
```

把 .wasm 灌进系统表：

```bash
clickhouse-client --query "
    INSERT INTO system.webassembly_modules (name, code)
    FORMAT RawBlob
" < mask_phone.wasm
```

`FORMAT RawBlob` 的意思是把整个二进制流当成一行的 `code` 列灌进去，不做任何分隔符解析。`name` 字段别忘了，具体写法以你用的 26.x 版本的文档为准。

注册 SQL 函数。这一点 WASM 跟 SQL UDF 一样，要 `CREATE FUNCTION`，跟 executable 装好 XML 就能用不一样：

```sql
CREATE FUNCTION mask_phone_w
LANGUAGE WASM
ARGUMENTS (phone String)
RETURNS String
FROM 'mask_phone_wasm' :: 'mask_phone';
--    模块名                模块里 export 的符号名

CREATE FUNCTION mask_email_w
LANGUAGE WASM
ARGUMENTS (email String)
RETURNS String
FROM 'mask_phone_wasm' :: 'mask_email';
```

也可以 ON CLUSTER，函数的元数据走 Keeper 的 DDL 队列，但模块本身还是得自己分发到每个节点，哪个副本上没有这个模块，那个副本上的 `CREATE FUNCTION` 就会失败：

```sql
CREATE FUNCTION mask_phone_w ON CLUSTER my_cluster
LANGUAGE WASM
ARGUMENTS (phone String)
RETURNS String
FROM 'mask_phone_wasm' :: 'mask_phone';
```

用起来就是普通函数：

```sql
SELECT mask_phone_w('13800138000');
-- ┌─mask_phone_w('13800138000')─┐
-- │ 138****8000                 │
-- └─────────────────────────────┘

SELECT user_id,
       mask_phone_w(phone) AS phone,
       mask_email_w(email) AS email
FROM users
LIMIT 100;
```

查看和管理：

```sql
-- 看有哪些模块
SELECT name,
       length(code) AS bytes,
       hex(sha256(code)) AS sha
FROM system.webassembly_modules;

-- 看函数有没有注册上
SELECT name, origin, create_query
FROM system.functions
WHERE name IN ('mask_phone_w', 'mask_email_w');

-- 更新模块（同名 INSERT，新 hash 会被识别为新版本）
clickhouse-client --query "
    INSERT INTO system.webassembly_modules (name, code) FORMAT RawBlob
" < mask_phone_v2.wasm

-- 删除函数 / 模块（模块还被函数引用时删不掉，要先 DROP FUNCTION）
DROP FUNCTION mask_phone_w;
DELETE FROM system.webassembly_modules WHERE name = 'mask_phone_wasm';
```

同一个功能，两种实现放一起比：

| 维度 | Executable 版本 | WASM 版本 |
|---|---|---|
| 部署内容 | XML 配置 + 脚本文件 + Python 解释器 | 一个 .wasm 文件 |
| 注册方式 | XML 自动扫描，无需 SQL | INSERT 模块 + `CREATE FUNCTION` |
| 跨节点 | 文件每台节点都要有 | 模块要分发到每个节点 |
| 资源限制 | OS 层（cgroup / ulimit）| CH 内置（查询级 setting）|
| 沙箱 | 无 | 强沙箱 |
| 改实现后生效 | `SYSTEM RELOAD FUNCTIONS` | 重新 INSERT 新 .wasm + 可能 DROP/CREATE |
| 性能 | Python 慢、Go/Rust 中 | 接近原生 70–95% |
| 失败时 | 子进程崩，worker 被替换 | trap，query 失败，主进程没事 |

### 资源限制由 ClickHouse 自己管

跟 executable 不一样，WASM 的限制是在 ClickHouse 自己的体系里的，死循环会撞上 fuel 配额，被 trap 掉；内存爆了会撞上 `webassembly_udf_max_memory`，也是 trap；主进程不受影响。而且这些都是查询级的 setting，能按用户写进 profile。

### 模块不会自动跨节点分发

这是 26.3 实验阶段一个很容易踩的坑。`system.webassembly_modules` 是每个实例自己的表，不走 Keeper 复制，INSERT 只落在你连上的那一台：

```
你 → 节点 A INSERT system.webassembly_modules
                │
                ▼
    只有节点 A 有这个模块
    其他节点  全都没有
                │
                ▼
    查询命中其他节点 → "module not found"，失败
```

要全集群可用，得自己挨个节点灌，比如遍历 `system.clusters` 逐台 INSERT：

```bash
for host in $(clickhouse-client -q "SELECT host_name FROM system.clusters WHERE cluster='my_cluster'"); do
    clickhouse-client -h $host --query "
        INSERT INTO system.webassembly_modules (name, code) FORMAT RawBlob
    " < mask_phone.wasm
done
```

文档里也提了用 `INSERT INTO FUNCTION cluster(...)` 一次分发，但只有 `internal_replication=false` 时才能覆盖到每个副本，否则还是得逐台插。另一个办法是把 .wasm 文件直接拷到每台机器的 `user_scripts/wasm/` 目录下。新加进集群的节点也不会自动拿到已有的模块，扩容的时候别忘了。

所以 WASM UDF 在运维上的改善是有的，用 SQL 来表达、可以审计，但还远没到 INSERT 一次全集群可见的程度。

### 现在的短板

还是实验特性，别放进关键链路。模块必须是 freestanding 的 wasm32，没有操作系统和标准库，Python 这种带解释器的语言基本用不上，WASI 的文件、时间、环境变量也都没有。生态很薄，官方 SDK 只有 Rust 一个。没有跨实例共享的状态缓存，[#99645](https://github.com/clickhouse/clickhouse/issues/99645) 还在讨论。可观测性也差，目前只有 SDK 里的 log 宏。ClickHouse Cloud 上也不支持。

## 热加载：文件变了，行为不一定变

executable UDF 的 XML 是热加载的。ClickHouse 盯着 `user_defined_executable_functions_config` 指定的那些文件，改、加、删都会自动重载，不用重启。文件监听不灵的时候，`SYSTEM RELOAD FUNCTIONS` 可以手动强制重载。

可脚本文件改了，是不会自动生效的。生产上最常见的问题就是：「我改了 Python 脚本，XML 没动，为什么查出来还是老逻辑？」

```
CH 监听：  XML 配置文件     是
CH 不监听：<command> 指向的脚本文件本身    否
```

因为 pool 里的 worker 是常驻进程。worker 启动那一刻，Python 已经把 `score.py` 编译成字节码装进内存了，之后没有任何进程再去读磁盘上的那个文件。改了源文件不等于改了正在跑的代码，这是 Unix 进程模型的常识。要让 worker 跑新代码，就得 `SYSTEM RELOAD FUNCTIONS`，让 ClickHouse 把 worker 换掉。

删 UDF 也有顺序，别上来就 `rm`。先从 XML 里把这个函数的定义去掉，或者删掉整个 XML 文件；等 ClickHouse 自动 reload，或者手动 `SYSTEM RELOAD FUNCTIONS`，这个函数的 worker 会被优雅地停掉；确认没有查询还在用了，再去删脚本文件。反过来先删脚本再 reload，就是给自己埋雷：已经在跑的 worker 还活着，看起来没事，可一旦有 worker 崩了要补，或者哪次部署触发了 reload，新 worker 就起不来，几个小时以后突然全部失败。

各类资源的热加载情况：

| 资源类型 | 监听机制 | 兜底命令 | 需要重启吗 |
|---|---|---|---|
| executable UDF 的 XML | 自动文件监听 | `SYSTEM RELOAD FUNCTIONS` | 不需要 |
| executable UDF 的脚本 | 不监听 | `SYSTEM RELOAD FUNCTIONS`（踢 worker）| 不需要，但要手动 reload |
| WASM 模块（INSERT 路径）| INSERT 即生效（本节点）| 无需 | 不需要 |
| SQL UDF (`CREATE FUNCTION`) | DDL 即时生效 | 无需 | 不需要 |
| 主 `config.xml` 多数字段 | 自动文件监听 | `SYSTEM RELOAD CONFIG` | 部分字段需要 |
| `users.xml` | 自动文件监听 | `SYSTEM RELOAD CONFIG` | 不需要 |

ClickHouse 在配置和函数注册这一层，几乎什么都设计成了热加载，需要重启的只剩端口绑定、磁盘路径这类根本性的东西。

## Profile 限制和安全盲区

三种 UDF 在这上面的差别很大。

| UDF 类型 | profile 限制是否生效 |
|---|---|
| SQL UDF | 完全生效，跟普通查询无差别 |
| executable / executable_pool | 部分生效，时间类生效，内存/CPU 完全管不住 |
| WASM UDF | 有专门的查询级限制（内存、fuel、实例数），可以写进 profile |

executable UDF 最大的盲区是内存：

```
max_memory_usage         不生效
   ↑ 这个限制只管 ClickHouse 主进程内存，
     subprocess 是另一个 PID，跟 CH 的内存账户没关系。
```

一个能调用 executable UDF 的用户，理论上把 Python 子进程写烂一点（比如 `x = [0] * 10**10`），就能把整台机器 OOM 掉，而 ClickHouse 的内存监控完全看不到这部分。ClickHouse 自己给的限制写在 UDF 的 XML 里：

```xml
<max_command_execution_time>10</max_command_execution_time>
<command_read_timeout>10000</command_read_timeout>
<command_write_timeout>10000</command_write_timeout>
```

可这些都是全局的，没法按用户配，而且没有内存上限。再加上前面说的，ClickHouse 没有按函数授权调用的权限，谁能查询谁就能调。

所以生产上跑 executable UDF，却不配 cgroup 总内存上限，就是在埋雷。兜底只能靠操作系统：

```
1. cgroups / systemd       → 给 clickhouse-server.service 一个总内存上限，
                              UDF 子进程也被框在 cgroup 里
2. ulimit / prlimit         → 在启动脚本前置 `prlimit --as=...`,
                              给子进程独立设内存上限
3. 监控                     → 看子进程 RSS，不只是看 CH 的内存指标
```

WASM 在这点上好得多，`webassembly_udf_max_memory` 和 fuel 是在 VM 里强制执行的，这是它相对 executable 最根本的架构优势。

多租户共享的集群，我的建议是 executable UDF 干脆禁掉，只留 SQL UDF、内置函数和字典。

## 逻辑放应用层还是放数据库

我的默认偏好是放在应用侧。只有三种情况，才把逻辑下推到 ClickHouse：逻辑能大幅减少返回的数据量，比如过滤、聚合、JOIN 之后只取几列，这种必须下推；逻辑能用内置函数或 SQL UDF 表达，没有成本，没理由不推；逻辑承担着合规或者治理的职责，必须集中维护，比如脱敏、加解密、统一口径。除此之外，都更倾向于放应用侧，尤其是 executable UDF。

为什么默认偏应用侧？ClickHouse 集群是全公司共享的地基，算力是稀缺的。你在自己的服务里开 100 个线程算东西，是你自己的事；推到 ClickHouse 上，全公司的查询都跟着卡。应用层是无状态的，加机器便宜，ClickHouse 不是。

但应用侧处理，绝不等于把全量数据拉出来自己算。真正的瓶颈在网络，不在 CPU：

```
正确分工：
   CH 扫 10 亿行，过滤 + 聚合 → 返回 1000 行 → 应用做展示
   网络：KB 级，可忽略

反模式：
   CH 返回 10 亿行原始数据 → 应用自己 group by
   网络：TB 级，死透
```

ClickHouse 负责扫描、过滤、聚合，应用负责最后一公里。下推有没有收益，看计算的形态：

| 计算形态 | 推荐位置 |
|---|---|
| 过滤 (`WHERE complex(x)`) | CH |
| 聚合 (`SUM/AVG/quantile`) | CH |
| 关联 (JOIN / dictGet) | CH |
| 逐行映射（不改行数）| 看情况（常常应该左移到 ETL）|
| 复杂业务规则（if/else 多分支）| 应用 |
| ML 推理 | 应用 |
| 调外部 IO(HTTP/LLM) | 应用 |

最常被错误下推的就是逐行映射。它没减少数据量，只是把应用的 CPU 悄悄搬到了共享的 ClickHouse 节点上。

我自己判断的顺序是这样的：

```
Step 1: 这个逻辑能用 CH 内置函数表达吗？
  能 → 内置（可包成 SQL UDF），结束。

Step 2: 能在 ETL(Spark/Flink)入库前算好吗？
  能 → 推到 ETL,CH 只存结果。结束。
       这一步能解决的问题比大多数人以为的多。

Step 3: 会显著减小返回数据量吗？
  会 → 必须下推到 CH，哪怕用 executable_pool 也值。

Step 4: 数据量绝对值大吗？
  大 → CH 流式返回，应用流式/分页处理。
  小 → 应用层处理，最简单。

Step 5(只对"必须 CH 端 + 不能用内置"的剩余场景):
  单租户、能配 cgroup、团队有运维能力 → executable_pool
  否则 → 重新审视架构，90% 情况都能绕过去
```

比较好的分工有这么几种。一种是 ClickHouse 粗筛加聚合，应用做精算和业务：

```
CH:    扫 10 亿行 → 过滤到 100 万 → group by 到 1 万 → 返回
应用： 对这 1 万行做评分、排序、业务规则、渲染
```

一种是把业务逻辑沉到 ETL 里：

```
Flink:  消费 Kafka，实时算特征/规则 → 写宽表进 CH
CH:     存宽表，只做过滤聚合
应用：  query 后直接用
```

这种架构下 UDF 用得最少。还有一种是用 SQL UDF 把口径固化下来：

```
SQL UDF:        公司口径（GMV、活跃、留存）统一封装
executable_pool: 只用在"必须 CH 端 + 减数据量 + 无法用 SQL 表达"的窄场景
```

## 三个例子

### APM 调用链生成：不用 UDF

数据是一行一个 span，有 `trace_id`、`span_id`、`parent_id`，要还原出调用树。

这个场景不该用 UDF。按 `trace_id` 过滤以后，数据自然就缩到了几百到几千行，返回的是 KB 级，网络可以忽略，UDF 减数据量的价值在这儿根本不存在。重建一棵树天生就是命令式的逻辑，Python 或者 Go 二十行就写完了，SQL 的 `WITH RECURSIVE` 写出来没法维护。下游消费的形态又五花八门，甘特图、火焰图、服务拓扑、关键路径，每种要的 JSON 都不一样，写成 UDF 就把形态绑死了。

所以 ClickHouse 只负责过滤：

```sql
SELECT span_id, parent_id, service, operation,
       start_ts, duration_us, status, tags
FROM spans
WHERE trace_id = ? AND start_ts BETWEEN ? AND ?
ORDER BY start_ts;
```

树在应用层构：

```python
spans = ch.query(...)
by_id = {s.span_id: s for s in spans}
children = defaultdict(list)
for s in spans: children[s.parent_id].append(s)
def build(span_id, depth=0):
    span = by_id[span_id]
    return {**span, "depth": depth,
            "children": [build(c.span_id, depth+1) for c in children[span_id]]}
tree = build(root_id)
```

反过来，APM 里适合交给 ClickHouse 的是跨 trace 的东西：p99、错误率、按服务 group by，服务依赖图，关键路径的占比统计（用内置的 array 函数就行，还是用不着 UDF），以及找慢的长尾 trace 做采样。跨 trace 的统计聚合下推，单个 trace 内部怎么组织，放应用层。

### 把查询结果塞给 LLM 做分析：坚决不用 UDF

设想中的写法是这样的：

```sql
SELECT ai_analyze(error_log) FROM errors WHERE day = today();
```

这在架构上每一层都是塌的：

| 维度 | OLAP query | LLM 调用 |
|---|---|---|
| 单次延迟 | ms 级 | 秒级到分钟级 |
| 失败模式 | 几乎不失败 | 429 / timeout / 5xx 常态 |
| 重试 | 不需要 | 必须指数退避 |

还不止这些。UDF 的协议是一批进一批出，流式输出、熔断、分级超时、可观测性，全都做不了。LLM 按 token 计费，ClickHouse 的 quota 管不了这个，在 UDF 里调 LLM，账单烧爆了都没人知道。LLM 应用最要紧的是不停地调 prompt，UDF 改一次就要 reload 一次，A/B 测试根本没法做。生产上 LLM 的结果一定要缓存，放在 UDF 里就成了一个黑盒。

正确的做法是 ClickHouse 只负责把喂给 LLM 的素材准备好，调用放在应用层或者专门的 AI 服务里：

```
1. CH 端：把"喂给 LLM 的素材"准备好
   SELECT error_log, service, count() AS occ,
          groupArray(stack_trace)[1:5] AS samples
   FROM errors
   WHERE day = today() AND severity = 'critical'
   GROUP BY error_log, service
   ORDER BY occ DESC LIMIT 50

2. 应用层（或专门的 AI service）:
   for row in rows:
       prompt = render_template(row)
       response = llm_client.chat(prompt, stream=True, retry=...)
       store_back_to_db(row, response)  # 回写 CH 做审计

3. (可选)回写表 ai_analysis_results,
   AI 结果本身又成为 CH 里可查询的数据。
```

LLM 的产出本身就是一份新数据，让它回写成 ClickHouse 里的一张表，比塞进 UDF 合适得多。

### 自定义脱敏算法：UDF 的合理场景

这个适合用 UDF，但也得先试 SQL UDF 加内置函数，executable 是最后的手段。

| 判据 | 脱敏函数 |
|---|---|
| pure function | 是，确定性、无 IO |
| 内置函数表达不了 | 是（如果算法真的是自定义）|
| 稳定迭代慢 | 是，合规驱动，几个月才改 |
| 需要集中治理 | 是，这是核心动机，全公司同一份口径，合规可审计 |

脱敏是一对一的逐行映射，不满足减数据量这一条，但它满足必须集中维护这一条，两条满足一条就够了。

先试 SQL UDF 加内置函数：

```sql
CREATE FUNCTION mask_phone AS (p) ->
    concat(substring(p, 1, 3), '****', substring(p, 8, 4));

CREATE FUNCTION mask_email AS (e) ->
    concat(substring(splitByChar('@', e)[1], 1, 2),
           '***@', splitByChar('@', e)[2]);

CREATE FUNCTION pseudonymize AS (id) ->
    lower(hex(cityHash64(concat('your-salt', id))));

CREATE FUNCTION enc AS (s) -> hex(encrypt('aes-256-gcm', s, key, iv));
```

只有算法是 FPE（格式保留加密）这种内置函数没有的方案，或者涉及自定义的状态机，或者必须用公司现成的某个加密库，才值得升级到 executable 或者 WASM。

还有一条安全红线：**密钥和 salt 永远不要写死在脚本里**，从环境变量或者 KMS 读，配合权限 0600 的 systemd EnvironmentFile。

## 最后怎么判断

只有下面这些条件全都满足，才值得考虑 executable 或 WASM UDF：

1. 复杂业务逻辑里的非业务部分，业务流转、规则、外部集成、AI 调用统统放应用层
2. 剩下的这部分是 pure function，确定、无外部依赖、无副作用、能批处理
3. 内置函数加 array/lambda 组合确实拼不出来（先认真翻一遍文档）
4. 没法在 ETL 入库的时候算好
5. 能显著减少数据量（过滤、聚合），或者承担合规治理职责、必须集中维护
6. 逻辑稳定，按月迭代而不是按天
7. 部署环境是单租户，或者用户都可信

条件都满足了，再按 SQL UDF、WASM UDF、executable_pool、executable 的顺序，挑最克制的那个。

反过来，查询里只要有下面任何一种意图，就默认别写 UDF，搬到应用层去：调用慢 IO（LLM、HTTP API、外部数据库）；给某个 UI 重组数据结构（树、图、嵌套对象）；跑容易变的业务规则；需要重试、流式、容错的逻辑；涉及计费、配额、多租户独立资源管理。

绕了一大圈，结论其实挺朴素的：ClickHouse 该干的是把数据量降下来，过滤、聚合、关联，剩下的交给应用层。真要动手写 executable UDF 之前，我建议先把前面那几步再走一遍，内置函数真拼不出来吗，ETL 入库的时候真算不了吗，数据量真的减下来了吗。这三问过不去，写出来的东西早晚还得拆。

---

## 参考资料

- [WebAssembly User Defined Functions | ClickHouse Docs](https://clickhouse.com/docs/sql-reference/functions/wasm_udf)
- [User Defined Functions (UDFs) | ClickHouse Docs](https://clickhouse.com/docs/sql-reference/functions/udf)
- [ClickHouse Release 26.3](https://clickhouse.com/blog/clickhouse-release-26-03)
- [ClickHouse/clickhouse-wasm-udf-rs (Rust SDK)](https://github.com/ClickHouse/clickhouse-wasm-udf-rs)
- [Support WASM plugins for UDF/TableFunctions/more · Issue #36892](https://github.com/ClickHouse/ClickHouse/issues/36892)
- [Cache for shared/reused data of WASM UDF · Issue #99645](https://github.com/clickhouse/clickhouse/issues/99645)
- [Executable user defined functions · PR #28803](https://github.com/ClickHouse/ClickHouse/pull/28803)

**相关**：[字典：省掉的 JOIN，多付的内存](/clickhouse/deep-dive/dictionary) · [物化视图：三种机制，以及 100T 表上的 POPULATE](/clickhouse/deep-dive/materialized-view)
