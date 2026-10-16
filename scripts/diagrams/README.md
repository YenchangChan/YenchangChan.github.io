# 图示生成脚本

站点上的图都放在 `docs/public/diagrams/`，每张出明暗两个文件：`<名字>.light.svg` 和 `<名字>.dark.svg`。
文章里用 `.dfig` 引两张，主题切换时由 CSS 决定显示哪一张（`<img>` 引入的 SVG 是独立文档，
看不到页面上的 `.dark` class，所以不能靠改 SVG 内部选择器来适配暗色）。

两张 SVG 的背景都是透明的，露出站点底色。

## 这里的脚本

都是手写 SVG 的 Python，不依赖第三方库。用法一样，参数是输出目录：

```bash
python3 scripts/diagrams/logsearch.py        docs/public/diagrams
python3 scripts/diagrams/inconsistent.py     docs/public/diagrams
python3 scripts/diagrams/deploy-topology.py  docs/public/diagrams
```

| 脚本 | 生成 | 用在 |
|---|---|---|
| `logsearch.py` | `logsearch-01` ~ `logsearch-05` | [日志检索三家实测](../../docs/clickhouse/comparison/log-search-ck-doris-es.md) |
| `inconsistent.py` | `inconsistent-01`、`inconsistent-02` | [同一条 SQL 每次查出来不一样](../../docs/clickhouse/deep-dive/inconsistent-query-results.md) |
| `deploy-topology.py` | `deploy-topology-01` ~ `deploy-topology-03` | [集群部署拓扑对比](../../docs/clickhouse/tooling/deployment-topology.md) |

改完重跑一遍就覆盖了，脚本是确定性的，同样的输入出同样的字节。

颜色各脚本自带一份明暗两套的配色表（`TH`），改配色改那里。

## 其余的图是 d2 画的

`docs/public/diagrams/` 下带 `data-d2-version` 的 SVG 是用 [d2](https://d2lang.com/)
的 `--sketch` 渲染的（带分支汇合的拓扑图手写 HTML 装不下，会丢汇合关系）。
早期一批图的 `.d2` 源文件没有保留，改不了只能重画；之后的源文件都放在 `docs/.diagrams/`，
命名跟产物一致（`async-blocks-01.d2` → `async-blocks-01.light/dark.svg`，用在
[126 万 znode 是怎么长出来的](../../docs/clickhouse/troubleshooting/keeper-async-blocks.md)）。

渲染（d2 v0.9.0 实测）：

```bash
d2 --sketch --theme 0   docs/.diagrams/xxx.d2 docs/public/diagrams/xxx.light.svg
d2 --sketch --theme 200 docs/.diagrams/xxx.d2 docs/public/diagrams/xxx.dark.svg
# d2 会给画布铺一层不透明底色，不符合站点透明背景的约定，把背景 rect 的 fill 改掉：
sed -i 's/fill="#[0-9A-Fa-f]*" class=" fill-N7"/fill="transparent" class=" fill-N7"/' \
    docs/public/diagrams/xxx.light.svg docs/public/diagrams/xxx.dark.svg
```

注意 v0.9.0 里时序图的关键字是 `shape: sequence_diagram`，不是旧文档里的 `sequence`。
