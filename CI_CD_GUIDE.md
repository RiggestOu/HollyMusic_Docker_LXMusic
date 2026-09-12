# HollyMusic Docker CI/CD

## 工作流程

### 1. 代码推送触发构建
当代码推送到 `main` 或 `master` 分支时，自动触发 Docker 镜像构建和发布。

### 2. 镜像构建
- 使用多阶段构建优化镜像大小
- 支持多平台: linux/amd64, linux/arm64
- 缓存优化加速构建

### 3. 镜像推送
- 推送到 GitHub Container Registry (ghcr.io)
- 自动打标签: 分支名、版本号、commit SHA

## 使用方法

### 克隆仓库
```bash
git clone https://github.com/your-username/HollyMusic_Docker_LXMusic.git
cd HollyMusic_Docker_LXMusic
```

### 本地构建测试
```bash
# 构建开发版本
docker build -t holly-mudic:dev .

# 运行测试
docker run -p 3080:3080 holly-mudic:dev
```

### 推送代码触发 CI/CD
```bash
git add .
git commit -m "feat: add new source"
git push origin main
```

### 拉取镜像
```bash
# 从 ghcr.io 拉取
docker pull ghcr.io/your-username/hollymusic-docker-lxmusic:latest

# 运行容器
docker run -d \
  --name holly-mudic \
  -p 3080:3080 \
  -v $(pwd)/data:/data/config \
  ghcr.io/your-username/hollymusic-docker-lxmusic:latest
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NODE_ENV` | production | 运行环境 |
| `CHROME_BIN` | /usr/bin/chromium | Chromium 路径 |
| `CHROME_FLAGS` | --no-sandbox --disable-gpu | Chromium 启动参数 |

## 端口说明

- `3080` - Web UI 端口

## 数据持久化

使用 Docker Volume 存储配置数据:
```bash
docker run -v $(pwd)/data:/data/config ...
```
