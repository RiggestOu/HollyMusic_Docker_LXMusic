# HollyMusic Docker Music Player

基于 LX Music 音源加载逻辑的 Docker 化音乐播放器。

## 快速开始

### 部署（拉取 CI 构建好的镜像）

```bash
# 1. 准备配置目录与 .env（compose 引用了 .env，缺失会启动失败）
mkdir -p config custom-sources cache_data app_logs prisma_data
touch .env

# 2. 启动
docker compose up -d

# 3. 查看状态 / 日志
docker compose ps
docker compose logs -f
```

访问 http://localhost:3099

### 本地构建镜像

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

### 不用 Docker，本地直接跑

```bash
npm install
npm start
```

访问 http://localhost:3000

## 镜像

- 地址：`ghcr.io/riggestou/hollymusic_docker_lxmusic:latest`
- 包页面：https://github.com/users/RiggestOu/packages/container/package/hollymusic_docker_lxmusic
- 公开可拉取，无需登录

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/sources | 获取音源列表 |
| POST | /api/sources | 导入音源 |
| DELETE | /api/sources | 删除音源 |
| GET | /api/health | 健康检查 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3000 | 容器内服务端口（不建议改，需与 compose 映射右侧一致） |
| DATA_DIR | /app/config | 数据存储目录（音源存为 `${DATA_DIR}/sources.json`） |
| NODE_ENV | production | 运行环境 |

> 说明：`DATABASE_URL` / `ENABLE_FILE_CACHE` / `AUDIO_CACHE_DIR` / `AUDIO_CACHE_QUOTA_GB`
> 为兼容原部署模板而保留，**当前版本尚未实现**（音源数据用 JSON 文件存储）。

## 项目结构

```
src/
├── main/
│   ├── server.js        # Express 服务器
│   └── modules/source/  # 音源管理模块
└── renderer/
    └── index.html       # Web UI
```

## 技术栈

- Node.js 22
- Express.js
- Alpine Linux

## 许可证

Apache License 2.0
