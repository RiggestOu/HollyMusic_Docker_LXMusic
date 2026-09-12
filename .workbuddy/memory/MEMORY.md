# HollyMusic Docker 项目记忆

## 项目方向

基于 LX Music 音源加载逻辑的 Docker 化音乐播放应用，支持 GitHub Actions CI/CD 自动构建 Docker 镜像。

## 技术栈

- **前端**: Vue 3 + TypeScript + Vite
- **后端**: Electron + Node.js
- **部署**: Docker + GitHub Actions
- **运行时**: Node.js 22 LTS

## 核心模块

### 音源系统 (source system)
- 支持多音源：酷我、腾讯、酷狗、咪咕、网易云
- 自定义音源导入/导出
- 脚本 gzip 压缩存储
- BrowserWindow 沙箱隔离执行
- IPC 双向事件通信
- 并发请求队列 + 20秒超时

### Docker 部署
- Alpine Linux 基础镜像（node:22-alpine）
- Chromium 无头模式
- 持久化 Volume 存储
- 健康检查
- 多架构支持 (linux/amd64, linux/arm64)

### CI/CD
- GitHub Actions 自动构建
- 推送到 GitHub Container Registry (ghcr.io)
- 支持分支、标签、PR 触发
- 多阶段构建优化

## 开发约定

- 音源模块路径：`src/main/modules/source/`
- IPC 事件命名：`source_*`
- 数据持久化：electron-store（主进程）
- 端口：3080
- CI/CD 配置：`.github/workflows/`

## 关键文件

- `src/main/modules/source/utils.ts` - 音源 CRUD
- `src/main/modules/source/main.ts` - Window 管理
- `src/main/modules/source/rendererEvent/rendererEvent.ts` - IPC 通信
- `Dockerfile` - Docker 构建（Node.js 22）
- `docker/docker-compose.yml` - 容器编排
- `.github/workflows/build.yml` - CI/CD 构建
- `.github/workflows/ci.yml` - CI/CD 测试

## 构建注意事项

1. 使用 `npm install --legacy-peer-deps` 而非 `npm ci`
2. 不需要 package-lock.json 文件
3. Node.js 版本必须使用 22 LTS
4. 多阶段构建：builder → runner
