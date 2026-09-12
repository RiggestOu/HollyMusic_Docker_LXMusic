# HollyMusic

Docker 化音乐播放器 —— 基于 [redcatH/HollyMusic](https://github.com/redcatH/HollyMusic) 官方源码，
在此基础上增加本仓库的定制功能。

## 定制内容（相对官方源码）

| 功能 | 状态 | 说明 |
|------|------|------|
| 歌单歌曲右键菜单「移出歌单」 | ✅ 已完成 | 仅在歌单详情页右键时出现；后端按 position 删除，菜单自动查出 position；删除后列表自动刷新 |
| 歌单页「导入 / 导出」按钮 | ⏳ 待开发 | 安排在「AI 建歌单」左侧 |
| LX Music 加载/搜索/播放/下载后端整合 | ⏳ 待移植 | 引擎代码已备好，待并入 |

改动文件（均为增量，未改动官方 UI 风格配色）：
- `lib/store/context-menu-store.ts` — 菜单状态增加 `playlistId`
- `components/shared/SongRow.tsx` — 新增可选 `playlistId` 属性
- `components/shared/SongList.tsx` — 新增可选 `playlistId` 属性
- `components/shared/SongContextMenu.tsx` — 新增「移出歌单」菜单项
- `frontend/src/routes/PlaylistDetailPage.tsx` — 传入 `playlistId`，监听刷新事件

## 部署

```bash
# 1. 生成鉴权密钥（必填）
openssl rand -hex 32    # 写入 .env 的 AUTH_SECRET

# 2. 启动
docker compose up -d
```

访问 <http://localhost:3099>

> `.env` 至少要有 `AUTH_SECRET=...`。首次启动会自动建库并运行 Prisma 迁移。

### 数据持久化

| 宿主机目录 | 容器内路径 | 内容 |
|-----------|-----------|------|
| `./config` | `/app/config` | `music-sources.json` 等运行时配置 |
| `./custom-sources` | `/app/custom-sources` | 音源脚本（后台上传，热重载） |
| `./prisma_data` | `/app/prisma/prisma/data` | **SQLite 数据库**（歌单、收藏等，重要） |
| `./cache_data` | `/app/.cache` | 音频磁盘缓存 |
| `./app_logs` | `/app/logs` | 日志 |

### 镜像与更新

镜像：`ghcr.io/riggestou/hollymusic_docker_lxmusic`

每次 push 到 `main`/`master` 自动构建并推送 3 个 tag：`latest`、`<commit-sha>`、`build-<N>`。

```bash
docker compose pull && docker compose up -d      # 不要加 --force-recreate
```

> compose 中已设 `pull_policy: always`，每次重建都会核对 digest（digest 未变时不下载任何层）。
> 群晖 Container Manager 不会为 ghcr.io 镜像提示更新，GUI 流程见下方注意事项。

## 技术栈

- Next.js（后端 + standalone） + Vite/React SPA（前端） + nginx
- Prisma + SQLite
- Node.js 20（Debian bookworm-slim）
- pnpm

## 项目结构

```
app/            Next.js API 路由
components/     共享组件（右键菜单等）
frontend/       前端 SPA（React + Vite）
lib/            后端核心（音源引擎、服务、store、subsonic 等）
prisma/         数据库 schema 与迁移
config/         运行时配置
lx-env-simulator/  LX Music 自定义源环境模拟器
scripts/        启动脚本等
```

## 许可证

跟随上游 HollyMusic（详见 `LICENSE`）。
