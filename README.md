# HollyMudic Docker Music Player

基于 LX Music 音源加载逻辑的 Docker 化音乐播放器。

## 快速开始

### Docker 部署（推荐）
```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

### 本地运行
```bash
# 安装依赖
npm install

# 启动开发服务器
npm start
```

访问 http://localhost:3080

## 功能特性

- 🎵 多音源支持（酷我、腾讯、酷狗、咪咕、网易云）
- 🐳 Docker 容器化部署
- 📦 自定义音源导入/导出
- 🔒 数据持久化存储
- 💾 SQLite 数据库支持

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
| PORT | 3080 | 服务端口 |
| DATA_DIR | /data/config | 数据存储目录 |

## 项目结构

```
src/
├── main/
│   ├── server.js        # Express 服务器
│   └── modules/source/  # 音源管理模块
└── renderer/
    └── index.html       # Web UI
```

## 许可证

Apache License 2.0
