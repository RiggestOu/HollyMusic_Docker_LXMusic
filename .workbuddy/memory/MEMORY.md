# HollyMusic Docker 项目记忆

## 项目方向

基于 LX Music 音源加载逻辑的 Docker 化音乐播放器，支持 GitHub Actions CI/CD 自动构建和部署。

## 技术栈

- **后端**: Node.js 22 + Express
- **前端**: 纯 HTML/CSS/JavaScript
- **部署**: Docker + Alpine Linux
- **CI/CD**: GitHub Actions (build.yml + ci.yml)

## 核心模块

### 音源系统 (src/main/server.js)
- REST API 服务 (端口 3080)
- 音源导入/导出/删除功能
- gzip 压缩存储音源脚本
- JSON 文件持久化存储

### Docker 配置
- 多阶段构建优化镜像大小
- 仅包含运行时依赖 (node:22-alpine)
- 数据持久化 Volume (/data/config)
- 健康检查端点 (/api/health)

### CI/CD
- push 到 main/master 触发 Docker 镜像构建
- 自动推送到 GitHub Container Registry (ghcr.io)
- CI workflow 检查代码语法

## 开发约定

- 服务器入口: `src/main/server.js`
- API 端口: 3080
- 数据存储: `/data/config/sources.json`
- CI/CD 配置: `.github/workflows/`

## 关键文件

- `Dockerfile` - 多阶段构建配置
- `docker/entrypoint.sh` - 容器启动脚本
- `.github/workflows/build.yml` - Docker 镜像构建推送
- `.github/workflows/ci.yml` - 代码检查
- `src/main/server.js` - Express 服务器主程序

## 注意事项

1. **避免 merge conflict 标记**: 提交前务必检查所有文件，确保没有 `<<<<<<<` / `>>>>>>>` 标记残留
2. **Docker 构建环境**: 不需要 GUI 依赖（如 Chromium），仅使用 Alpine Linux 基础镜像
3. **Node.js 版本**: 使用 Node.js 22 LTS，避免使用已废弃的 Node.js 20
4. **权限配置**: GitHub Actions 需要 `packages: write` 权限才能推送镜像
5. **邮箱验证**: GitHub Actions 需要已验证的邮箱地址才能运行
