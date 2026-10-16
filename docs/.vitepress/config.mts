import { defineConfig } from 'vitepress'

const SITE = 'https://yenchangchan.github.io'

/**
 * 中英混排的字数与阅读时长估算。
 * CJK 按 450 字/分钟，西文按 200 词/分钟 —— 技术文档比散文慢，
 * 代码块和表格照常计入，因为读者确实要在上面花时间。
 */
function readingStats(src: string) {
  const cjk = (src.match(/[\u4e00-\u9fa5]/g) || []).length
  const latin = (src.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9_.\-]+/g) || []).length
  const words = cjk + latin
  return { words, minutes: Math.max(1, Math.round(cjk / 450 + latin / 200)) }
}

// ClickHouse 的侧边栏。Doris 等其他引擎单独一套（见 OTHERS_SIDEBAR）
const CH_SIDEBAR = [
        { text: '版本升级避坑清单', link: '/clickhouse/upgrade-gotchas' },
        { text: '23.8 → 26.3 升级路径评估', link: '/clickhouse/upgrade-23-8-to-26-3' },
        {
          text: '生产排障',
          collapsed: false,
          items: [
            { text: '概览', link: '/clickhouse/troubleshooting/' },
            { text: '126 万 znode 是怎么长出来的', link: '/clickhouse/troubleshooting/keeper-async-blocks' },
            { text: 'S3 不可达时起不来', link: '/clickhouse/troubleshooting/s3-unreachable-startup' },
            { text: 'znode 爆炸与线程池', link: '/clickhouse/troubleshooting/znode-explosion' },
          ],
        },
        {
          text: '冷热分层',
          collapsed: false,
          items: [
            { text: '概览与选型', link: '/clickhouse/cold-storage/' },
            { text: 'S3 Disk 会遇到什么', link: '/clickhouse/cold-storage/s3-disk' },
            { text: 'BACKUP 超冷归档', link: '/clickhouse/cold-storage/backup-restore' },
            { text: '为什么要转 Parquet', link: '/clickhouse/cold-storage/parquet' },
            { text: '冷数据上的 ALTER', link: '/clickhouse/cold-storage/alter' },
            { text: '应用平台的 S3 冷盘', link: '/clickhouse/cold-storage/platform' },
            { text: 'chDB + S3 Parquet', link: '/clickhouse/cold-storage/chdb' },
          ],
        },
        {
          text: '一次讲透',
          collapsed: false,
          items: [
            { text: '概览', link: '/clickhouse/deep-dive/' },
            { text: 'Too many parts', link: '/clickhouse/deep-dive/too-many-parts' },
            { text: 'Too many partitions', link: '/clickhouse/deep-dive/too-many-partitions' },
            { text: '同一条 SQL 结果不一样', link: '/clickhouse/deep-dive/inconsistent-query-results' },
            { text: 'FINAL 查询优化', link: '/clickhouse/deep-dive/final-query' },
            { text: '物化视图', link: '/clickhouse/deep-dive/materialized-view' },
            { text: '字典', link: '/clickhouse/deep-dive/dictionary' },
            { text: '到底要不要写 UDF', link: '/clickhouse/deep-dive/udf' },
            { text: '副本表 readonly', link: '/clickhouse/deep-dive/replica-readonly' },
          ],
        },
        {
          text: '工具与设计',
          collapsed: false,
          items: [
            { text: '概览', link: '/clickhouse/tooling/' },
            { text: '为什么推荐一机一副本', link: '/clickhouse/tooling/deployment-topology' },
            { text: '扩容后为什么不自动均衡', link: '/clickhouse/tooling/why-not-auto-rebalance' },
            { text: '指标 schema 改了三次', link: '/clickhouse/tooling/metric-schema-evolution' },
            { text: '集群机房搬迁实战', link: '/clickhouse/tooling/datacenter-migration' },
          ],
        },
        {
          text: '信创与异构环境',
          collapsed: false,
          items: [
            { text: '概览', link: '/clickhouse/vendor/' },
            { text: 'ARM 上一跑就 SIGILL', link: '/clickhouse/vendor/kylin-arm-instruction-baseline' },
            { text: 'x86 老 CPU 一 import chdb 就 SIGILL', link: '/clickhouse/vendor/chdb-avx-baseline' },
            { text: 'systemd AmbientCapabilities', link: '/clickhouse/vendor/systemd-ambient-capabilities' },
            { text: '华为 MRS 的连接协议陷阱', link: '/clickhouse/vendor/huawei-mrs-protocol-trap' },
            { text: '并发 INSERT 串表', link: '/clickhouse/vendor/mrs-http-prepare-cache' },
          ],
        },
        {
          text: '选型与横评',
          collapsed: false,
          items: [
            { text: '概览与立场', link: '/clickhouse/comparison/' },
            { text: '为什么不用 Kafka engine', link: '/clickhouse/comparison/why-not-kafka-engine' },
            { text: 'ClickHouse 和 Doris 怎么选', link: '/clickhouse/comparison/clickhouse-vs-doris' },
            { text: '日志检索三家实测', link: '/clickhouse/comparison/log-search-ck-doris-es' },
            { text: '存算分离横评', link: '/clickhouse/comparison/storage-compute-separation' },
            { text: 'OpenObserve：源码深挖', link: '/clickhouse/comparison/openobserve-internals' },
            { text: 'OpenObserve：压测实录', link: '/clickhouse/comparison/openobserve-benchmark' },
          ],
        },
]

// 其他引擎（ClickHouse 之外在生产里跑过的）。以后加 StarRocks 等往这里塞。
const OTHERS_SIDEBAR = [
        { text: '概览', link: '/others/' },
        {
          text: 'Doris',
          collapsed: false,
          items: [
            { text: '概览', link: '/others/doris/' },
            { text: '存储策略与 S3', link: '/others/doris/storage-policy-s3' },
            { text: '跨数据中心查询', link: '/others/doris/cross-datacenter-query' },
          ],
        },
]

export default defineConfig({
  lang: 'zh-CN',
  title: '禹鼎侯',
  description: 'ClickHouse 与系统底层：生产环境里的排障、设计与取舍',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,

  sitemap: { hostname: SITE },

  markdown: {
    config(md) {
      // 在 h1 之后插一行「字数 · 阅读时长」。
      // 概览页和短页不插：一眼能看完的页面，标时长不是信息。
      md.core.ruler.push('reading_time', (state: any) => {
        const env = state.env || {}
        if (env.frontmatter?.readingTime === false) return false
        if (/(^|\/)index\.md$/.test(env.relativePath || '')) return false

        const stats = readingStats(state.src || '')
        if (stats.words < 800) return false

        const i = state.tokens.findIndex(
          (t: any) => t.type === 'heading_close' && t.tag === 'h1'
        )
        if (i === -1) return false

        const tok = new state.Token('html_block', '', 0)
        tok.content = `<p class="reading-time">${stats.words} 字 · 约 ${stats.minutes} 分钟</p>\n`
        state.tokens.splice(i + 1, 0, tok)
        return true
      })

      // 表格套一层可横向滚动的壳。站点 CSS 把表格改回了 display:table + width:100%
      // （默认样式太松散），代价是宽表不再能自己滚动，会一路顶到右侧目录上。
      // 壳负责滚动，表格照旧撑满正文列。
      md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
        '<div class="table-wrap">\n' + self.renderToken(tokens, idx, options)
      md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
        self.renderToken(tokens, idx, options) + '</div>'
    },
  },

  head: [
    ['meta', { name: 'author', content: '陈衍长 / 禹鼎侯' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: '禹鼎侯' }],
    ['meta', { name: 'keywords', content: 'ClickHouse,ckman,clickhouse_sinker,OLAP,可观测性,Linux内核,排障' }],
  ],

  themeConfig: {
    nav: [
      { text: '<svg viewBox="0 0 24 24" fill="currentColor" style="width:15px;height:15px;vertical-align:-2px;margin-right:6px" xmlns="http://www.w3.org/2000/svg"><path d="M21.333 10H24v4h-2.667ZM16 1.335h2.667v21.33H16Zm-5.333 0h2.666v21.33h-2.666ZM0 22.665V1.335h2.667v21.33zm5.333-21.33H8v21.33H5.333Z"/></svg>ClickHouse', link: '/clickhouse/', activeMatch: '/clickhouse/' },
      { text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;vertical-align:-2px;margin-right:6px" xmlns="http://www.w3.org/2000/svg"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>其他引擎', link: '/others/', activeMatch: '/others/' },
      { text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;vertical-align:-2px;margin-right:6px" xmlns="http://www.w3.org/2000/svg"><path d="M12 20v2"/><path d="M12 2v2"/><path d="M17 20v2"/><path d="M17 2v2"/><path d="M2 12h2"/><path d="M2 17h2"/><path d="M2 7h2"/><path d="M20 12h2"/><path d="M20 17h2"/><path d="M20 7h2"/><path d="M7 20v2"/><path d="M7 2v2"/><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/></svg>系统底层', link: '/systems/', activeMatch: '/systems/' },
      { text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;vertical-align:-2px;margin-right:6px" xmlns="http://www.w3.org/2000/svg"><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/></svg>Field Notes', link: '/notes/', activeMatch: '/notes/' },
      { text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;vertical-align:-2px;margin-right:6px" xmlns="http://www.w3.org/2000/svg"><path d="M18 20a6 6 0 0 0-12 0"/><circle cx="12" cy="10" r="4"/><circle cx="12" cy="12" r="10"/></svg>关于', link: '/about/' },
    ],

    sidebar: {
      '/clickhouse/': CH_SIDEBAR,
      '/others/': OTHERS_SIDEBAR,
      '/systems/': [
        { text: '概览', link: '/systems/' },
        {
          text: '内核问题定位',
          collapsed: false,
          items: [
            { text: '概览', link: '/systems/kernel/' },
            { text: 'ext3 + memcg 的 OOM 死锁', link: '/systems/kernel/ext3-jbd-memcg-oom-deadlock' },
            { text: 'XFS soft lockup 卡死整机', link: '/systems/kernel/xfs-soft-lockup-cond-resched' },
          ],
        },
        {
          text: '采集器工程',
          collapsed: false,
          items: [
            { text: '概览', link: '/systems/agent/' },
            { text: '内存泄漏：valgrind 的盲区', link: '/systems/agent/memory-leak-tool-blind-spots' },
            { text: 'DWARF 版本不匹配，core 没有行号', link: '/systems/agent/dwarf-version-mismatch' },
            {
              text: 'Fluent Bit 源码笔记',
              collapsed: false,
              items: [
                { text: '（一）背压与投递', link: '/systems/agent/fluent-bit-backpressure-delivery' },
                { text: '（二）规模天花板', link: '/systems/agent/fluent-bit-million-files' },
                { text: '（三）offset 存储', link: '/systems/agent/fluent-bit-offset-identity' },
                { text: '（四）编码与压缩', link: '/systems/agent/fluent-bit-read-boundary' },
                { text: '（五）K8s 采集与选型', link: '/systems/agent/fluent-bit-kubernetes-logging' },
              ],
            },
          ],
        },
      ],
      '/notes/': [{ text: 'Field Notes', link: '/notes/' }],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/YenchangChan' }],

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
          modal: {
            noResultsText: '没有找到',
            resetButtonTitle: '清除',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdatedText: '最后更新',
    returnToTopLabel: '回到顶部',
    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '目录',
    footer: {
      message: '内容来自一线生产环境，客户信息均已脱敏',
      copyright: '© 陈衍长 (禹鼎侯)',
    },
  },
})
