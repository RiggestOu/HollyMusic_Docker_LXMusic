# HollyMudic - Docker Music Player

基于 LX Music 音源加载逻辑的 Docker 化音乐播放器。

## 项目结构

```
E:\WorkBuddy\HollyMudic\
├── src/
│   ├── common/
│   │   ├── types/
│   │   │   └── user_api.d.ts          # 音源类型定义
│   │   ├── constants.ts               # 常量定义
│   │   └── ipcNames.ts                # IPC 事件名称
│   ├── main/
│   │   ├── index.ts                   # 主进程入口
│   │   ├── preload.ts                 # 预加载脚本
│   │   ├── modules/
│   │   │   └── source/
│   │   │       ├── index.ts           # 音源模块入口
│   │   │       ├── utils/
│   │   │       │   └── index.ts       # 音源 CRUD + 脚本压缩
│   │   │       ├── main.ts            # BrowserWindow 管理
│   │   │       └── rendererEvent/
│   │   │           ├── name.ts        # IPC 事件名
│   │   │           └── rendererEvent.ts  # IPC 通信 + 请求队列
│   │   └── ipc/
│   │       └── source.ts              # IPC 注册
│   └── renderer/
│       ├── main.ts                    # 渲染进程入口
│       ├── App.vue                    # 根组件
│       ├── index.html                 # HTML 模板
│       └── core/
│           └── source/
│               ├── index.ts           # Store 状态
│               └── apiSource.ts       # 音源切换逻辑
├── docker/
│   ├── docker-compose.yml             # Docker Compose 配置
│   └── entrypoint.sh                  # 启动脚本
├── Dockerfile                         # Docker 构建文件
├── package.json
├── tsconfig.json
├── tsconfig.main.json
├── tsconfig.renderer.json
└── vite.config.ts
```

## 核心功能移植

| 功能 | 状态 |
|------|------|
| 音源类型定义 | ✅ |
| 音源导入/导出 | ✅ |
| 脚本 gzip 压缩 | ✅ |
| BrowserWindow 沙箱 | ✅ |
| IPC 双向通信 | ✅ |
| 请求队列 + 超时 | ✅ |
| Docker 容器化 | ✅ |
| 数据持久化 | 🔄 待实现 |

## 快速启动

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# Docker 构建
npm run docker:build

# Docker Compose 启动
npm run docker:compose
```

## 端口说明

- `3080` - Web UI 端口
