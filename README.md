# yenchangchan.github.io

个人技术站点。VitePress + GitHub Pages。

```bash
pnpm install
pnpm dev       # 本地 http://localhost:5173
pnpm build     # 产物在 docs/.vitepress/dist
```

推到 `main` 自动部署（见 `.github/workflows/deploy.yml`）。
首次需要在仓库 Settings → Pages → Source 选 **GitHub Actions**。
