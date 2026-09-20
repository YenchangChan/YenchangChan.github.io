import { defineConfig } from 'vitepress'

const SITE = 'https://yenchangchan.github.io'

export default defineConfig({
  lang: 'zh-CN',
  title: '禹鼎侯',
  description: 'ClickHouse 与系统底层：生产环境里的排障、设计与取舍',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,

  sitemap: { hostname: SITE },

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
          text: '工具与设计',
          collapsed: false,
          items: [
            { text: '概览', link: '/clickhouse/tooling/' },
            { text: '扩容后为什么不自动均衡', link: '/clickhouse/tooling/why-not-auto-rebalance' },
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
          items: [{ text: '概览', link: '/clickhouse/comparison/' }],
        },
      ],
      '/systems/': [
        { text: '概览', link: '/systems/' },
        { text: '内核问题定位', link: '/systems/kernel/' },
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
