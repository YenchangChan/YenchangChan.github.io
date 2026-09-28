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
      { text: 'ClickHouse', link: '/clickhouse/', activeMatch: '/clickhouse/' },
      { text: '系统底层', link: '/systems/', activeMatch: '/systems/' },
      { text: 'Field Notes', link: '/notes/', activeMatch: '/notes/' },
      { text: '关于', link: '/about/' },
    ],

    sidebar: {
      '/clickhouse/': [
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
            { text: '物化视图', link: '/clickhouse/deep-dive/materialized-view' },
            { text: '字典', link: '/clickhouse/deep-dive/dictionary' },
            { text: '到底要不要写 UDF', link: '/clickhouse/deep-dive/udf' },
          ],
        },
        {
          text: '工具与设计',
          collapsed: false,
          items: [
            { text: '概览', link: '/clickhouse/tooling/' },
            { text: '扩容后为什么不自动均衡', link: '/clickhouse/tooling/why-not-auto-rebalance' },
            { text: '集群机房搬迁实战', link: '/clickhouse/tooling/datacenter-migration' },
          ],
        },
        {
          text: '信创与异构环境',
          collapsed: false,
          items: [
            { text: '概览', link: '/clickhouse/vendor/' },
            { text: 'ARM 上一跑就 SIGILL', link: '/clickhouse/vendor/kylin-arm-instruction-baseline' },
            { text: '华为 MRS 的连接协议陷阱', link: '/clickhouse/vendor/huawei-mrs-protocol-trap' },
            { text: '并发 INSERT 串表', link: '/clickhouse/vendor/mrs-http-prepare-cache' },
          ],
        },
        {
          text: '选型与横评',
          collapsed: false,
          items: [
            { text: '概览与立场', link: '/clickhouse/comparison/' },
            { text: 'ClickHouse 和 Doris 怎么选', link: '/clickhouse/comparison/clickhouse-vs-doris' },
            { text: '存算分离横评', link: '/clickhouse/comparison/storage-compute-separation' },
            { text: 'OpenObserve：源码深挖', link: '/clickhouse/comparison/openobserve-internals' },
            { text: 'OpenObserve：压测实录', link: '/clickhouse/comparison/openobserve-benchmark' },
          ],
        },
      ],
      '/systems/': [
        { text: '概览', link: '/systems/' },
        {
          text: '内核问题定位',
          collapsed: false,
          items: [
            { text: '概览', link: '/systems/kernel/' },
            { text: '采集器被两家客户判了死刑，然后我们翻了案', link: '/systems/kernel/ext3-jbd-memcg-oom-deadlock' },
            { text: '限了 CPU 配额，它还是把整机卡死了 22 秒', link: '/systems/kernel/xfs-soft-lockup-cond-resched' },
          ],
        },
        { text: '资源与容器', link: '/systems/resources/' },
        { text: '采集器工程', link: '/systems/agent/' },
        { text: 'K8s 与容器采集', link: '/systems/k8s/' },
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
