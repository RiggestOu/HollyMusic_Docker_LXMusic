# HollyMusic Docker Music Player

基于 LX Music 音源加载逻辑的 Docker 化音乐播放器。

## 快速开始

### Docker 部署
```bash
docker build -t holly-mudic:latest .
docker run -d -p 3080:3080 -v $(pwd)/data:/data/config holly-mudic:latest
```

### 本地运行
```bash
npm install
npm start
```

访问 http://localhost:3080

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

## 技术栈

- Node.js 22
- Express.js
- Alpine Linux

## 许可证

Apache License 2.0
