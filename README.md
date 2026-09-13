# HollyMudic - Docker Music Player

基于 LX Music 音源加载逻辑的 Docker 化音乐播放器。

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# Docker 部署
npm run docker:build
npm run docker:run
```

## Docker 部署

```bash
docker-compose up -d
```

访问 http://localhost:3080

## 功能特性

- 🎵 多音源支持（酷我、腾讯、酷狗、咪咕、网易云）
- 🐳 Docker 容器化部署
- 📦 自定义音源导入/导出
- 🔒 沙箱隔离执行
- 💾 持久化配置存储

## 项目结构

```
src/
├── common/          # 公共类型和常量
├── main/           # Electron 主进程
│   └── modules/source/  # 音源管理模块
└── renderer/       # Vue 渲染进程
```
