# HollyMudic - Docker 版

基于 LX Music 音源加载逻辑的 Docker 化音乐播放应用。

## 功能特性

- 🎵 支持多音源（酷我、腾讯、酷狗、咪咕、网易云）
- 🐳 Docker 容器化部署
- 📦 自定义音源导入/导出
- 🔒 沙箱隔离的音源执行环境
- 💾 持久化配置存储

## 快速开始

### 使用 Docker Compose 启动

```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

### 直接运行 Docker 镜像

```bash
docker build -t holly-mudic .
docker run -d \
  --name holly-mudic \
  -p 3080:3080 \
  -v $(pwd)/data:/data/config \
  holly-mudic
```

## 端口说明

- `3080` - Web UI 端口

## 数据持久化

配置文件存储在 Docker Volume 中，默认路径：
- `/data/config` - 应用配置和数据

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NODE_ENV` | `production` | 运行环境 |
| `CHROME_FLAGS` | `--no-sandbox --disable-gpu` | Chromium 启动参数 |
| `HTTP_PROXY` | - | HTTP 代理 |
| `HTTPS_PROXY` | - | HTTPS 代理 |

## 构建选项

### 多架构支持

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t holly-mudic:latest \
  --push .
```

### 开发模式

```bash
docker-compose -f docker-compose.dev.yml up
```

## 健康检查

```bash
curl http://localhost:3080/health
```

## 许可证

Apache License 2.0
