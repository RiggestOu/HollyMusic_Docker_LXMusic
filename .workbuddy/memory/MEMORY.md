# HollyMudic 项目记忆

## 项目方向

基于 LX Music 音源加载逻辑的 Docker 化音乐播放应用。

## 技术栈

- **前端**: Vue 3 + TypeScript + Vite
- **后端**: Electron + Node.js
- **部署**: Docker + Docker Compose
- **架构**: 主进程 + 渲染进程 + BrowserWindow 沙箱

## 核心模块

### 音源系统 (source system)
- 支持多音源：酷我、腾讯、酷狗、咪咕、网易云
- 自定义音源导入/导出
- 脚本 gzip 压缩存储
- BrowserWindow 沙箱隔离执行
- IPC 双向事件通信
- 并发请求队列 + 20秒超时

### Docker 化
- Alpine Linux 基础镜像
- Chromium 无头模式
- 持久化 Volume 存储
- 健康检查
- 多架构支持

## 开发约定

- 音源模块路径：`src/main/modules/source/`
- IPC 事件命名：`source_*`
- 数据持久化：electron-store（主进程）
- 端口：3080

## 关键文件

- `src/main/modules/source/utils.ts` - 音源 CRUD
- `src/main/modules/source/main.ts` - Window 管理
- `src/main/modules/source/rendererEvent/rendererEvent.ts` - IPC 通信
- `Dockerfile` - Docker 构建
- `docker/docker-compose.yml` - 容器编排
