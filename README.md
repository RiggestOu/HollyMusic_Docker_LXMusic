# HollyMusic Docker Music Player

基于 LX Music 音源加载逻辑的 Docker 化音乐播放器。

## 快速开始

### Docker 部署
```bash
docker build -t holly-mudic:latest .
docker run -d -p 3080:3080 -v $(pwd)/data:/data/config holly-mudic:latest
```

访问 http://localhost:3080

## API 接口

- `GET /api/sources` - 获取音源列表
- `POST /api/sources` - 导入音源
- `DELETE /api/sources` - 删除音源
- `GET /api/health` - 健康检查

## 技术栈

- Node.js 22
- Express.js
- Alpine Linux
