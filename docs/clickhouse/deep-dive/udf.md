---
title: ClickHouse 到底要不要写 UDF
---

# ClickHouse 到底要不要写 UDF

> 三种 UDF 形态能力差着一个数量级，而大多数「需要 UDF」的场景，其实不该用 UDF 解决。
>
> **阅读对象**：正在考虑把业务逻辑下沉进 ClickHouse，或者已经写了 UDF、但不确定它是不是反模式的工程师。

---

## 一、UDF 的三种形态

ClickHouse 的「User Defined Function」不是一个东西，而是**三种机制并存**，能力差异巨大：

| 形态 | 引入时间 | 本质 | 成熟度 |
|---|---|---|---|
| **SQL UDF** | ~2021 | AST 表达式宏，查询分析期展开 | 完全成熟 |
| **Executable / Executable Pool UDF** | 2021 | 外挂子进程，通过 stdin/stdout 通信 | 生产可用，有工程负担 |
| **WASM UDF** | 2026.3 | 嵌入 Wasmtime 沙箱，加载 .wasm 模块 | 实验阶段，不推荐生产关键链路 |

三者的运行位置和性能档次完全不同：

```
内置函数             ▮▮▮▮▮▮▮▮▮▮  baseline (SIMD + C++)
SQL UDF              ▮▮▮▮▮▮▮▮▮▮  等价于内置（展开后向量化）
WASM UDF             ▮▮▮▮▮▮▮       2~3x 慢于内置
executable_pool      ▮▮▮            10~50x 慢（Go/Rust + RowBinary）
executable (Python)  ▮              百倍以上慢
```

**核心认知**:SQL UDF 是 ClickHouse 的「组成部分」，该用就用；executable/WASM 是「能力延伸」，是逃生口，不是首选工具。

---

## 二、跟相关概念的区分

UDF 跟几个相邻概念经常被混淆，先把它们厘清：

### 不是存储过程

存储过程是命令式的：有 `BEGIN/END`、变量、`IF/WHILE`、多语句、副作用。**ClickHouse 根本没有存储过程这个概念**(OLAP 不需要)。

SQL UDF 是**单表达式 lambda 绑定**，更接近 C 的 `#define` 或 SQL 标准里的 inline scalar function，而不是 PL/pgSQL 那种东西。从 PostgreSQL / MySQL 背景过来的人最常踩这个认知差。

### 不是字典（Dictionary）

字典是 ClickHouse 用来做**外部数据源查找**的机制（KV、外部 DB、HTTP source），通过 `dictGet` 访问。

**任何「在 UDF 里查另一张表 / 查外部 KV」的需求，都应该用字典，不该用 UDF**。字典有缓存、生命周期管理、刷新策略，UDF 全没有。

### 不是 macros

ClickHouse 的 `macros` 是**字符串级模板替换**，主要用在 DDL 里：

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

这是真正的「宏」，每台节点用自己的 `macros` 值展开。

### 不是 named collection

named collection 是**命名的参数包**，主要用来管理 S3/HDFS/外部数据源的连接凭据：

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

它更像 `.env` 文件或 Ansible vars，解决的是「凭据不要散落 + 权限可控 + 易轮换」,**不是代码复用**。

### 三层「替换」机制的对照

```
macros            → 字符串模板替换，DDL 解析期（像 envsubst）
SQL UDF           → AST 表达式替换，查询分析期（像 C 的 #define）
named collection  → 参数包查表 + kwargs 合并，分析期（像 .env）
```

三者都是「运行前替换」，但替换的**单位**不同：字符串 / 表达式树 / 参数字典。

---

## 三、SQL UDF：被低估的「零成本」工具

```sql
CREATE FUNCTION linear_eq AS (x, k, b) -> k*x + b;
SELECT linear_eq(number, 3, 7) FROM numbers(10);
```

### 本质

SQL UDF **不是函数调用**，而是**语法替换**。`linear_eq(number, 3, 7)` 在分析期就被替换成 `3*number + 7`，从执行器视角看完全等价于手写表达式。因此：

- 零运行时开销
- 完全向量化、SIMD 加速
- profile 限制透明生效
- 可下推、可被优化器折叠

### 限制

- 函数体只能是**一个表达式**，不能是多语句
- 不能递归
- 不能引用表（没有 `SELECT ... FROM`）
- 不能有副作用

### 价值

SQL UDF 真正的价值不是性能（本来就没成本），而是**集中维护「业务口径」**:GMV 怎么算、活跃用户怎么定义、留存怎么口径化。把这些封装成 SQL UDF 后，全公司报表共用一套定义，改一次到处生效。

**这是 ClickHouse 里最被低估的特性。SQL UDF 几乎不需要「决策」，该用就用**。

### 完整用法示例

**创建、查看、替换、删除**:

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

**带 Lambda 和数组的进阶用法**:

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

**带默认 settings 的 UDF**(SQL UDF 本身不支持，但可以通过表达式技巧间接做):

```sql
-- 数据口径切换：线上 / 测试环境用不同标准
CREATE FUNCTION revenue_with_env AS (amount, env) ->
    if(env = 'prod', amount, amount * 0.1);
```

**生产里 SQL UDF 的常见用法分类**:

| 类别 | 例子 |
|---|---|
| 业务口径 | GMV / 活跃 / 留存 / LTV 计算 |
| 单位换算 | 时间戳 → 日期、字节 → MB、美分 → 美元 |
| 复合判定 | 「是否会员」、「是否高价值」、「是否风险订单」 |
| 字段标准化 | 大小写、trim、URL 归一化 |
| 脱敏 | 手机号、邮箱、身份证（可表达的算法）|
| 数组聚合 | 配合 `arrayMap` / `arrayFilter` 做行内聚合 |

---

## 四、Executable UDF 深入

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

### 通信协议：不是「调用」，是「管道」

```
CH 主进程                   子进程
   │                          │
   │ ──── block of N rows ──→ │   (stdin)
   │                          │   处理…
   │ ←── block of N rows ──── │   (stdout)
   │                          │
   │ ──── 下一个 block ────→ │
```

关键事实：

- 数据流是 **block 级别**，一个 query 可能传多个 block
- **输入行数必须等于输出行数**，顺序对应。少一行或多一行 → query 失败 + worker 状态污染
- `send_chunk_header=true` 时协议变为「先一行行数，再 N 行数据」,**这是 pool 模式下唯一能正确工作的方式**

### Python worker 模板（可直接用）

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

四个关键点缺一个，在 pool 模式下都会出诡异问题（挂起 / 行错位 / 偶发崩溃）。

### format 选型

对吞吐的影响是**数量级**的：

| format | 何时用 | 注意 |
|---|---|---|
| `TabSeparated` | 调试、字段全是简单标量 | 字符串里的 `\t` `\n` 要转义 |
| `JSONEachRow` | 字段多、有嵌套 | 解析慢，但 Python 写起来最舒服 |
| `RowBinary` | 高吞吐、字段类型固定 | Python 慢，Go/Rust/C++ 友好 |

经验值：**Python 用 `JSONEachRow`，Go/Rust 用 `RowBinary`，`TabSeparated` 只在 demo 里用**。

### Executable vs Executable Pool

| | `executable` | `executable_pool` |
|---|---|---|
| 每次 query 行为 | fork+exec 新进程 | 从池里拿空闲 worker |
| 冷启动 | 50–200ms（Python 更糟）| 0 |
| 适合 | 一次性 ETL | 高 QPS、低延迟 |
| 崩溃影响 | 仅当前 query | worker 出池，池子补人 |
| 状态污染 | 无 | **有** —— 全局变量、缓存跨 query 残留 |

**生产几乎只用 `executable_pool`**。非 pool 只在「一次性离线 ETL，冷启动可接受」的窄场景合理。

### 语言选型

Executable UDF 不挑语言，任何能读 stdin / 写 stdout 的进程都行。但部署性差异很大：

| 语言 | 默认产物 | 能否完全静态 | 体感 |
|---|---|---|---|
| **Go** | 基本静态 | `CGO_ENABLED=0` → 单文件，**连 glibc 都不要** | **部署最干净** |
| **Rust** | 默认动态链接 glibc | 加 `--target x86_64-unknown-linux-musl` 即可全静态 | 一行 flag 的事 |
| **C++** | 默认动态链接 glibc | 静态可以但坑多（libstdc++、TLS、DNS）| **glibc 兼容性最麻烦** |
| **Python** | 依赖解释器 + .so | 不可能 | 部署最重 |
| **Java/JVM** | 依赖 JRE | GraalVM native-image 可以 | **JVM 冷启动 + 常驻内存让它不合适**，除非 native-image |

平台/架构（x86_64 / aarch64）依赖所有原生二进制都有，Python wheel 也一样。

### 调试

子进程的 stderr 默认会进 CH server log:

```bash
grep -i 'user_scripts\|executable' /var/log/clickhouse-server/clickhouse-server.log
```

但更可靠的做法是脚本**自己写独立日志文件**(注意 systemd PrivateTmp)，以及**让脚本能离线跑**:

```bash
printf '3\nfoo\nbar\nbaz\n' | python3 -u /var/lib/clickhouse/user_scripts/score.py
```

query 卡死的排查顺序：

1. `SHOW PROCESSLIST` 看 query 是否还活
2. `ps -ef | grep your_script` 看 worker 进程数量
3. `strace -p <pid>` 看是卡在 `read()`（等输入）还是 `write()`（管道满）
4. 99% 是**没 flush stdout** 或**没开 send_chunk_header**

### 完整可跑示例：从配置到调用

下面是一个从零部署 executable UDF 的完整流程，功能是「对手机号做格式保留脱敏」(假设算法复杂到不适合用 SQL UDF 表达)。

#### 步骤 1:告诉 ClickHouse 去哪里找 UDF 配置

编辑主配置 `/etc/clickhouse-server/config.xml`，确保下面两项存在：

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

> 通配符 `*_function.xml` 意味着 CH 会扫描所有以 `_function.xml` 结尾的文件，放在 `/etc/clickhouse-server/` 下即可。

#### 步骤 2:写 UDF 的 XML 描述

`/etc/clickhouse-server/mask_phone_function.xml`：

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

#### 步骤 3:写子进程脚本

`/var/lib/clickhouse/user_scripts/mask_phone.py`：

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

设置权限（必须 clickhouse 用户可执行）：

```bash
sudo chown clickhouse:clickhouse \
    /var/lib/clickhouse/user_scripts/mask_phone.py
sudo chmod 0750 /var/lib/clickhouse/user_scripts/mask_phone.py
```

如果脚本依赖 salt，通过 systemd EnvironmentFile 注入：

```ini
# /etc/systemd/system/clickhouse-server.service.d/secrets.conf
[Service]
EnvironmentFile=/etc/clickhouse-server/secrets.env
```

```bash
# /etc/clickhouse-server/secrets.env  (chmod 0600, owner root:clickhouse)
MASK_SALT=your-real-salt-here
```

#### 步骤 4:离线先测脚本

**永远先脱离 ClickHouse 跑一次，免得 query 挂了再排查**:

```bash
printf '3\n13800138000\n13912345678\n12345\n' \
    | python3 -u /var/lib/clickhouse/user_scripts/mask_phone.py

# 期待输出：
# 138****8000
# 139****5678
# ***INVALID***
```

#### 步骤 5:让 ClickHouse 加载

XML 是被自动监听的，几秒后自动生效。也可以手动触发：

```sql
SYSTEM RELOAD FUNCTIONS;
```

#### 步骤 6:在 SQL 里调用

**注意**:executable UDF **不需要** `CREATE FUNCTION` —— XML 加载完它就是 SQL 里直接可用的函数。

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

#### 步骤 7:验证 worker 池已就位

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

#### 步骤 8:授权（生产必做）

默认所有用户都能调，生产里收紧：

```sql
-- 先 revoke 所有人
REVOKE EXECUTE ON FUNCTION mask_phone_ext FROM PUBLIC;

-- 只授权给特定角色
GRANT EXECUTE ON FUNCTION mask_phone_ext TO data_etl;
```

#### 步骤 9:更新流程（关键）

如果只是改 Python 脚本逻辑，**XML 没动，CH 不会自动 reload**(它只盯 XML)。必须手动：

```sql
SYSTEM RELOAD FUNCTIONS;
```

这会优雅替换 pool 里的 worker，新 worker 跑新脚本。

如果改了 XML(比如调大 `pool_size`、换 `command` 路径),**会自动 reload**，不用手动触发。

---

## 五、WASM UDF 现状

ClickHouse 在 **2026.3** 引入了 WASM UDF,**目前仍是 experimental**，需要显式开启：

```xml
<allow_experimental_webassembly_udf>true</allow_experimental_webassembly_udf>
<webassembly_udf_engine>wasmtime</webassembly_udf_engine>
```

### 本质：把「外挂进程」换成「嵌入沙箱」

```
旧：  CH 进程  ──管道──►  python3 子进程
新：  CH 进程 ─函数调用─► Wasmtime VM(同进程内)
```

运行时是 **Wasmtime**(BytecodeAlliance 出品，生产级)。.wasm 是字节码，但**不是 JVM 那种「解释 + JIT 热点」模型** —— Wasmtime 在模块实例化时通过 Cranelift **一次性把整个模块编译成机器码**，之后就是纯原生执行。

可以这么理解 WASM 模块：**它是「沙箱化的动态库」**:

| 传统动态库 | WASM UDF |
|---|---|
| `.so` / `.dll` | `.wasm` 模块 |
| `ld.so` 动态加载器 | Wasmtime 运行时 |
| `dlopen` + `dlsym` | INSERT 进系统表 + `CREATE FUNCTION ... LANGUAGE WASM` |
| 跟 host **共享地址空间** | **独立 linear memory**,host/guest 互不可见 |
| 跟 host 同权限 | **零默认权限**，无 syscall、fs、net |
| 架构 + libc + 符号版本三重锁定 | **架构无关、无 libc 依赖** |

### 工作流

```sql
-- 1. 开启实验特性
SET allow_experimental_webassembly_udf = 1;

-- 2. 把 .wasm 二进制灌进系统表（FORMAT RawBlob 流式上传）
INSERT INTO system.webassembly_modules (name, code) FORMAT RawBlob;

-- 3. 注册函数，绑到模块里 export 的符号
CREATE FUNCTION greet
LANGUAGE WASM
ARGUMENTS (name String)
RETURNS String
FROM 'my_module:greet';

-- 4. 像普通函数一样用
SELECT greet(user_name) FROM users;
```

Rust 侧用官方 SDK `clickhouse-wasm-udf-rs`：

```rust
#[clickhouse_udf]
fn greet(name: String) -> Result<String, String> {
    Ok(format!("Hello, {name}!"))
}
```

target 用 **`wasm32-unknown-unknown`**(不是 wasi)，`cargo build --release` 出 .wasm。

### 完整可跑示例：Rust + WASM 端到端

下面是同一个「手机号脱敏」功能用 WASM UDF 实现的全流程，可以跟前面 executable 版本对照看差异。

#### 步骤 1:开启实验特性

`/etc/clickhouse-server/config.xml`：

```xml
<clickhouse>
    <allow_experimental_webassembly_udf>true</allow_experimental_webassembly_udf>
    <webassembly_udf_engine>wasmtime</webassembly_udf_engine>

    <!-- 资源限制 -->
    <webassembly_udf_max_memory>67108864</webassembly_udf_max_memory>
    <webassembly_udf_max_fuel>10000000</webassembly_udf_max_fuel>
    <webassembly_udf_max_input_block_size>65536</webassembly_udf_max_input_block_size>
    <webassembly_udf_max_instances>16</webassembly_udf_max_instances>
</clickhouse>
```

或者用 user-level setting(临时验证):

```sql
SET allow_experimental_webassembly_udf = 1;
```

#### 步骤 2:在开发机上写 Rust 项目

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

#### 步骤 3:编译并瘦身

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

#### 步骤 4:把 .wasm 灌进系统表

```bash
clickhouse-client --query "
    INSERT INTO system.webassembly_modules (name, code)
    FORMAT RawBlob
" < mask_phone.wasm
```

注意 `FORMAT RawBlob` —— 这是把整个二进制流当成一行的 `code` 列灌进去，不做任何分隔符解析。同时**别忘了 `name` 字段** —— 如果只有 code，在某些版本里需要显式指定 name（可能要换写法），具体看你的 26.x 版本文档。

> 多节点集群必须 **fan-out**(`system.webassembly_modules` 不走 Keeper 自动复制):
>
> ```bash
> for host in $(clickhouse-client -q 「SELECT host_name FROM system.clusters WHERE cluster='my_cluster'」); do
>     clickhouse-client -h $host --query 「>         INSERT INTO system.webassembly_modules (name, code) FORMAT RawBlob
>」 < mask_phone.wasm
> done
> ```
>
> INSERT 对 `(name, hash)` 幂等，反复跑安全。

#### 步骤 5:注册 SQL 函数

WASM UDF **跟 SQL UDF 一样需要 `CREATE FUNCTION`**(跟 executable 不同，executable 装好 XML 就直接可用):

```sql
CREATE FUNCTION mask_phone_w
LANGUAGE WASM
ARGUMENTS (phone String)
RETURNS String
FROM 'mask_phone_wasm:mask_phone';
--    ^^^^^^^^^^^^^^^  ^^^^^^^^^^
--    模块名             模块里 export 的符号名

CREATE FUNCTION mask_email_w
LANGUAGE WASM
ARGUMENTS (email String)
RETURNS String
FROM 'mask_phone_wasm:mask_email';
```

ON CLUSTER 也行（函数元数据走 Keeper DDL，模块仍然要手动 fan-out）：

```sql
CREATE FUNCTION mask_phone_w ON CLUSTER my_cluster
LANGUAGE WASM
ARGUMENTS (phone String)
RETURNS String
FROM 'mask_phone_wasm:mask_phone';
```

#### 步骤 6:使用

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

#### 步骤 7:查看与管理

```sql
-- 看有哪些模块
SELECT name,
       length(code) AS bytes,
       hex(sha256(code)) AS sha
FROM system.webassembly_modules;

-- 看哪些函数引用了模块
SELECT name, create_query
FROM system.functions
WHERE origin = 'WASMUserDefined';

-- 更新模块（同名 INSERT，新 hash 会被识别为新版本）
clickhouse-client --query "
    INSERT INTO system.webassembly_modules (name, code) FORMAT RawBlob
" < mask_phone_v2.wasm

-- 删除函数 / 模块
DROP FUNCTION mask_phone_w;
DELETE FROM system.webassembly_modules WHERE name = 'mask_phone_wasm';
```

#### Executable vs WASM 同一功能的对照

| 维度 | Executable 版本 | WASM 版本 |
|---|---|---|
| 部署内容 | XML 配置 + 脚本文件 + Python 解释器 | 一个 .wasm 文件 |
| 注册方式 | XML 自动扫描，无需 SQL | INSERT 模块 + `CREATE FUNCTION` |
| 跨节点 | 文件每台节点都要有（或自动 reload）| 模块 INSERT 要 fan-out |
| 资源限制 | OS 层（cgroup / ulimit）| CH 内置（`max_memory` / `max_fuel`）|
| 沙箱 | 无 | 强沙箱 |
| 改实现后生效 | `SYSTEM RELOAD FUNCTIONS` | 重新 INSERT 新 .wasm + 可能 DROP/CREATE |
| 性能 | Python 慢、Go/Rust 中 | 接近原生 70–95% |
| 失败时 | 子进程崩，worker 被替换 | trap,query 失败，主进程没事 |

### 资源限制（WASM 的最大卖点）

跟 executable UDF 不同，WASM 有**真正在 CH 体系内**的限制：

```xml
<webassembly_udf_max_memory>67108864</webassembly_udf_max_memory>      <!-- 64MB linear memory -->
<webassembly_udf_max_fuel>10000000</webassembly_udf_max_fuel>          <!-- 指令数，防死循环 -->
<webassembly_udf_max_input_block_size>65536</webassembly_udf_max_input_block_size>
<webassembly_udf_max_instances>16</webassembly_udf_max_instances>
```

死循环 → 撞 fuel,trap;爆内存 → 撞 max_memory,trap;**主进程不受影响**。

### 一个反直觉的真相：WASM 模块**不会自动跨节点分发**

这是 26.3 实验阶段一个很容易踩的坑。

`system.webassembly_modules` 是 **per-instance 表**,**不走 Keeper 自动复制**。INSERT 只落在被连接的那一台副本上：

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

要全集群可用，必须**手动 fan-out**(遍历 `system.clusters` 挨个 `INSERT INTO FUNCTION remote(...)`)，或者用文件路径方式分发。好消息是 **INSERT 对 `(name, hash)` 幂等**，反复跑、补节点都安全。

也就是说，WASM UDF 解决了「运维痛点」是**部分的、不是质变的**：接口统一（用 SQL 表达）、幂等、可审计，但**不是「INSERT 一次全集群可见」** —— 那是 roadmap 项，不是当前能力。

### 当前明显短板

1. **Experimental，不能用于关键链路**
2. **Python 直接出局**(CPython 不能编 WASM)
3. **生态薄**,Rust SDK 是唯一官方 SDK
4. **没有 per-user 配额**，限制是 server 级
5. **没有共享状态缓存**(issue #99645 在讨论)
6. **WASI 支持有限**,fs/time/env 都不可用
7. **可观测性差**，目前只有 SDK 的 log 宏

---

## 六、热加载机制：文件变 ≠ 行为变

### Executable UDF 的 XML 是热加载的

CH server **默认监听 `user_defined_executable_functions_config` 指定的目录**，改文件、加文件、删文件**都会自动触发重载**，不需要重启。

兜底命令：`SYSTEM RELOAD FUNCTIONS`，在文件监听失灵时手动强制重载。

### 但脚本文件改了不会自动生效

**这是生产里最常踩的坑**:

```
CH 监听：  XML 配置文件     ✅
CH 不监听：<command> 指向的脚本文件本身    ❌
```

```
"我改了 Python 脚本，XML 没动，为什么 query 还是老逻辑？"
```

答案是 **pool worker 是长跑进程**:

- worker 启动那一刻，Python 已经把 `score.py` 编译成 bytecode 装进内存
- 之后**没有任何进程再去读磁盘上的脚本文件**
- 改源文件 ≠ 改运行中代码（这是 Unix 进程模型的基本常识）

要让 worker 跑新代码，必须 `SYSTEM RELOAD FUNCTIONS`（让 CH 优雅替换 worker）。

### 「删 UDF 文件」的安全顺序

不要直接 `rm`：

```
1. 从 XML 里把这个函数定义去掉（或删整个 XML 文件）
2. CH 自动 reload(或手动 SYSTEM RELOAD FUNCTIONS)
   → pool 里这个函数的 worker 被优雅终止
3. 确认没有 query 还在用 → 这时再 rm 脚本文件
```

反过来「先 rm 文件再 reload」，等于自己埋雷：**新 worker 起不来**(自然崩溃替补 / 部署触发 reload 都会撞上)，但已运行的 worker 还活着，看起来「先没事」——直到几小时后忽然全部失败。

### 各类资源的热加载对照

| 资源类型 | 监听机制 | 兜底命令 | 需要重启吗 |
|---|---|---|---|
| executable UDF 的 **XML** | 自动文件监听 | `SYSTEM RELOAD FUNCTIONS` | ❌ |
| executable UDF 的 **脚本** | **不监听** | `SYSTEM RELOAD FUNCTIONS`（踢 worker）| ❌ 但要手动 reload |
| WASM 模块（INSERT 路径）| INSERT 即生效（本节点）| 无需 | ❌ |
| SQL UDF (`CREATE FUNCTION`) | DDL 即时生效 | 无需 | ❌ |
| 主 `config.xml` 多数字段 | 自动文件监听 | `SYSTEM RELOAD CONFIG` | 部分字段需要 |
| `users.xml` | 自动文件监听 | `SYSTEM RELOAD CONFIG` | ❌ |

ClickHouse 在「配置和函数注册」层几乎所有东西都设计成热加载。需要重启的只剩端口绑定、磁盘路径这种本质性资源。

---

## 七、Profile 限制与安全盲区

这是生产里**真正决定 UDF 安全性**的一节，而且三种 UDF 表现差异巨大。

### 一句话先答

| UDF 类型 | profile 限制是否生效 |
|---|---|
| SQL UDF | ✅ **完全生效**，跟普通查询无差别 |
| executable / executable_pool | ⚠️ **部分生效** —— 时间类生效，**内存/CPU 完全失控** |
| WASM UDF | ⚠️ **部分生效** —— 有专门 server 级限制，但不挂 user profile |

### Executable UDF 的内存盲区

```
max_memory_usage         ❌ 不生效
   ↑ 这个限制只管 ClickHouse 主进程内存，
     subprocess 是另一个 PID，跟 CH 的内存账户没关系。
```

一个被授权调用 executable UDF 的用户，理论上可以通过把 Python 子进程写烂（`x = [0] * 10**10`）把整台机器 OOM 掉，**CH 的内存监控完全看不到这部分**。

CH 自己提供的限制写在 UDF 的 XML 里：

```xml
<max_command_execution_time>10</max_command_execution_time>
<command_read_timeout>10000</command_read_timeout>
<command_write_timeout>10000</command_write_timeout>
```

但这些是**全局的、不能 per-user**，而且**没有内存上限**。

### 必须用 OS 层兜底

生产里跑 executable UDF 而不配 cgroup 总内存上限，**就是埋雷**:

```
1. cgroups / systemd       → 给 clickhouse-server.service 一个总内存上限，
                              UDF 子进程也被框在 cgroup 里
2. ulimit / prlimit         → 在启动脚本前置 `prlimit --as=...`,
                              给子进程独立设内存上限
3. 监控                     → 看子进程 RSS，不只是看 CH 的内存指标
```

### WASM 修了「绝对资源失控」

WASM 的 `webassembly_udf_max_memory` 和 `max_fuel` 在 VM 级强制执行，**这是它相对 executable 的核心架构优势**。但目前仍**做不到按用户配额** —— 这是 roadmap 项。

### 多租户的结论

**多租户共享集群 → executable UDF 几乎应该禁用**，只允许 SQL UDF + 内置函数 + Dictionary。这是行业大厂 ClickHouse 平台的普遍做法。

---

## 八、架构决策：应用层 vs 数据库层

这是 UDF 讨论最重要的一节，因为它决定了**你的 UDF 写出来是优雅还是反模式**。

### 默认偏好

**默认偏好「应用侧处理」，只有三种情况才把逻辑下推到 CH:**

1. **逻辑能显著减小返回数据量**(过滤、聚合、JOIN 后取少量列)→ 必须下推
2. **逻辑能用内置函数 / SQL UDF 表达**(零成本)→ 下推没理由不
3. **逻辑承担合规/治理职责，必须集中维护**(脱敏、加解密、统一口径)→ 下推

**其他情况都倾向应用侧**，尤其是 executable UDF。

### 为什么默认偏应用侧？

#### (1) CH 算力是共享稀缺资源，应用算力是水平可扩展

CH 集群是公司的共享地基。你在自己的 service 里开 100 个线程算东西是你自己的事；推到 CH 上，**全公司查询跟着卡**。应用层是 stateless 的，加机器便宜；CH 不是。

#### (2) 网络是核心，不是 CPU

```
正确分工：
   CH 扫 10 亿行，过滤 + 聚合 → 返回 1000 行 → 应用做展示
   网络：KB 级，可忽略

反模式：
   CH 返回 10 亿行原始数据 → 应用自己 group by
   网络：TB 级，死透
```

**「应用侧处理」绝不等于「把全量数据拉出来」**。CH 完成扫描/过滤/聚合，应用做最后一公里。

#### (3) 计算形态决定下推有没有收益

| 计算形态 | 推荐位置 |
|---|---|
| 过滤 (`WHERE complex(x)`) | ✅ CH |
| 聚合 (`SUM/AVG/quantile`) | ✅ CH |
| 关联 (JOIN / dictGet) | ✅ CH |
| 逐行映射（不改行数）| ⚠️ 看情况（常常应该左移到 ETL）|
| 复杂业务规则（if/else 多分支）| ❌ 应用 |
| ML 推理 | ❌ 应用 |
| 调外部 IO(HTTP/LLM) | ❌ 应用 |

**最常错误下推的是「逐行映射」** —— 没减数据量，只是把应用的 CPU 偷偷搬到了共享的 CH 节点上。

### 决策树

```
Step 1: 这个逻辑能用 CH 内置函数表达吗？
  能 → 内置（可包成 SQL UDF），结束。

Step 2: 能在 ETL(Spark/Flink)入库前算好吗？
  能 → 推到 ETL,CH 只存结果。结束。
       这是最优解，被严重低估。

Step 3: 会显著减小返回数据量吗？
  会 → 必须下推到 CH，哪怕用 executable_pool 也值。

Step 4: 数据量绝对值大吗？
  大 → CH 流式返回，应用流式/分页处理。
  小 → 应用层处理，最简单。

Step 5(只对"必须 CH 端 + 不能用内置"的剩余场景):
  单租户、能配 cgroup、团队有运维能力 → executable_pool
  否则 → 重新审视架构，90% 情况都能绕过去
```

### 常见好实践

**模式 A:CH 粗筛 + 聚合，应用精算 + 业务**

```
CH:    扫 10 亿行 → 过滤到 100 万 → group by 到 1 万 → 返回
应用： 对这 1 万行做评分、排序、业务规则、渲染
```

**模式 B：把业务沉淀到 ETL**

```
Flink:  消费 Kafka，实时算特征/规则 → 写宽表进 CH
CH:     存宽表，只做过滤聚合
应用：  query 后直接用
```

这种架构 **UDF 用得最少**，也是大厂常见选择。

**模式 C:SQL UDF 固化口径**

```
SQL UDF:        公司口径（GMV、活跃、留存）统一封装
executable_pool: 只用在"必须 CH 端 + 减数据量 + 无法用 SQL 表达"的窄场景
```

---

## 九、案例分析

### 案例 1:APM Trace 调用链生成

**结论：不用 UDF。CH 过滤，应用层构树。**

数据形态：每行是一个 span，有 `trace_id / span_id / parent_id`，要重建调用树。

为什么不该用 UDF:

1. **数据已经被 `trace_id` 自动收缩**:WHERE 过滤后只剩几百~几千行，KB 级返回，网络可忽略 → UDF 的「减数据量」价值不存在
2. **树重建是天然命令式逻辑**:Python/Go 20 行能写完，SQL `WITH RECURSIVE` 难维护
3. **下游消费方多形态**:Gantt / Flame / Service Graph / 关键路径，每种要不同 JSON,UDF 把形态绑死

正确分工：

```sql
SELECT span_id, parent_id, service, operation,
       start_ts, duration_us, status, tags
FROM spans
WHERE trace_id = ? AND start_ts BETWEEN ? AND ?
ORDER BY start_ts;
```

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

**反过来，适合 CH 的 APM 场景**:

- 跨 trace 聚合：p99、错误率、按服务 group by
- 服务依赖图（跨 trace 的统计）
- 关键路径占比统计（可以用内置 array 函数，仍不需要 UDF）
- 找慢长尾 trace 做采样

规律：**跨 trace 的统计聚合下推到 CH;单 trace 内部的形态重组放应用层**。

### 案例 2:查询结果塞 LLM 上下文做 AI 分析

**结论：强烈不用 UDF。架构上每一层都塌。**

设想中的反模式：

```sql
SELECT ai_analyze(error_log) FROM errors WHERE day = today();
```

为什么是反模式：

| 维度 | OLAP query | LLM 调用 |
|---|---|---|
| 单次延迟 | ms 级 | **秒级到分钟级** |
| 失败模式 | 几乎不失败 | **429 / timeout / 5xx 常态** |
| 重试 | 不需要 | **必须指数退避** |

进一步问题：

- **流式输出 / 熔断 / 分级超时 / 可观测** —— UDF 协议是 batch 进 batch 出，全都做不了
- **成本归属和限速** —— LLM 按 token 计费，CH quota 系统不管这个，UDF 里调 LLM = 烧爆账单没人知道
- **Prompt 迭代** —— LLM 应用最重要的是 prompt engineering,UDF 改一次要 reload,A/B 没法做
- **结果缓存** —— 生产 LLM 必有缓存，UDF 里实现等于黑盒

正确架构：

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

**关键洞察**:**「AI 分析」不是计算，是「另一种数据来源」**。把它当成「另一个数据生产者」接到 CH 里，而不是 UDF。

### 案例 3:自定义脱敏算法 —— UDF 的合理场景

**结论：适合 UDF，但优先 SQL UDF + 内置函数，executable 是最后手段。**

为什么适合：

| 判据 | 脱敏函数 |
|---|---|
| pure function | ✅ 确定性、无 IO |
| 内置函数表达不了 | ✅(如果算法真的是自定义) |
| 稳定迭代慢 | ✅ 合规驱动，几个月才改 |
| **需要集中治理** | ✅ **核心动机** —— 全公司同一份口径，合规可审计 |

注意：脱敏**不满足「减数据量」判据**(1:1 行级映射)，但它满足「必须集中维护」判据。两个择一即可。

**先尝试 SQL UDF + 内置函数**:

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

只有以下情况才升级到 executable / WASM:

1. 算法是 FPE(format-preserving encryption)这类内置没有的复杂方案
2. 算法涉及自定义状态机
3. 必须用现成的某个内部加密库实现

**重要安全提醒：密钥 / salt 永远不要 hardcode 进脚本**。从环境变量 / KMS 读，配合 systemd EnvironmentFile（权限 0600 root）。这是脱敏类 UDF 唯一的安全红线。

---

## 十、最终决策框架

### 七条判据清单

**当且仅当下列条件全部满足，才考虑 executable / WASM UDF:**

1. 复杂业务逻辑的**非业务部分** —— 业务流转、规则、外部集成、AI 调用统统放应用层
2. 剩下这部分是 **pure function**(确定性、无外部依赖、无副作用、可批处理)
3. CH 内置函数 + array/lambda 组合**确实拼不出来**(先认真查文档)
4. 不能在 ETL 入库时算好
5. 能**显著减数据量**(filter / agg),**或者**承担合规/治理职责必须集中维护
6. 逻辑**稳定**，迭代频率以月计而不是天计
7. 部署环境是**单租户或可信用户**

满足条件后，按 **SQL UDF → WASM UDF → executable_pool → executable** 的顺序挑最克制的实现。

### 五条警示信号

**只要 query 里有以下任何一种意图，默认不要写 UDF，搬应用层：**

- 调用慢 IO（LLM、HTTP API、外部 DB）
- 重组数据结构（树、图、嵌套对象）给特定 UI
- 跑容易变的业务规则
- 处理需要重试 / 流式 / 容错的逻辑
- 涉及计费 / 配额 / 多租户独立资源管理

### 一句话总结

> **SQL UDF 是 ClickHouse 的组成部分，该用就用；executable / WASM UDF 是能力延伸，生产中是逃生口，不是首选 —— 用得越少，说明你的架构越健康**。绝大多数复杂业务，本来就不该在数据库里跑；CH 的正确分工是「减数据量（过滤/聚合/关联）」，剩下交给应用层。看一个团队的 ClickHouse 用得好不好，**UDF 数量是反向指标：优秀的部署里 executable UDF 几乎不存在**。

---

## 附录：参考资料

- [WebAssembly User Defined Functions | ClickHouse Docs](https://clickhouse.com/docs/sql-reference/functions/wasm_udf)
- [User Defined Functions (UDFs) | ClickHouse Docs](https://clickhouse.com/docs/sql-reference/functions/udf)
- [ClickHouse Release 26.3](https://clickhouse.com/blog/clickhouse-release-26-03)
- [ClickHouse/clickhouse-wasm-udf-rs (Rust SDK)](https://github.com/ClickHouse/clickhouse-wasm-udf-rs)
- [Support WASM plugins for UDF/TableFunctions/more · Issue #36892](https://github.com/ClickHouse/ClickHouse/issues/36892)
- [Cache for shared/reused data of WASM UDF · Issue #99645](https://github.com/clickhouse/clickhouse/issues/99645)
- [Executable user defined functions · PR #28803](https://github.com/ClickHouse/ClickHouse/pull/28803)
