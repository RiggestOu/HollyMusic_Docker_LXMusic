# HollyMusic

Docker 化音乐播放器，完整实现 **LX Music 自定义源（自定义音源）规范**，支持搜索、在线播放、下载、歌词、封面与歌单管理。

## 快速开始

```bash
# 拉取 CI 构建好的镜像
docker compose up -d
```

访问 <http://localhost:3099>

> `docker-compose.yml` 引用了 `.env`，若文件不存在会启动失败，先 `touch .env`。

本地开发：

```bash
npm install
npm start          # http://localhost:3000
```

## 功能

- **音源引擎**：`vm` 沙箱执行 LX Music 音源脚本，支持 `musicUrl` / `musicSearch` / `lyric` / `pic` 全部动作
- **搜索**：优先调用音源自带的 `musicSearch`；音源不提供时自动回退到内置逐平台检索（kw / kg / tx / wy / mg）
- **播放**：服务端代理音频流，支持 HTTP Range 断点续传，绕开 CORS / Referer 限制
- **音质**：自动音质协商（`flac24bit` ↔ `24bit` ↔ `hires` 等命名差异自动匹配，并支持逐级降档重试）
- **多音源回退**：同一平台有多个音源时逐个尝试，失败自动切换
- **下载**：原文件下载，自动按音质推断扩展名
- **歌单**：服务端持久化；歌曲右键菜单支持「移出歌单」「下一首播放」等
- **歌单导入 / 导出**：一键导出全部歌单为 JSON 文件（浏览器直接下载），导入时自动去重
- **音源管理**：导入 / 删除 / 启停，脚本 gzip 压缩存储

## 歌单导入 / 导出

歌单列右上角有 **导入** / **导出** 两个按钮。

### 导出

点击「导出」即通过浏览器下载一个 JSON 文件：

```json
{
  "type": "hollymusic-playlist",
  "version": 1,
  "exportedAt": "2026-09-12T14:46:22.000Z",
  "count": 1,
  "songs": [
    {
      "source": "kw",
      "name": "晴天",
      "singer": "周杰伦",
      "albumName": "叶惠美",
      "albumId": "1293",
      "songmid": "228908",
      "hash": "228908",
      "copyrightId": "228908",
      "id": "228908",
      "interval": 269,
      "img": "https://…",
      "addedAt": 1789224344925,
      "uid": "2e7af8493d31c8f0"
    }
  ]
}
```

**为什么用 JSON 而不是 m3u/csv**：m3u 只存播放地址（音源直链有 Referer/时效限制，换个环境就失效），
csv 无法表达嵌套字段。JSON 能完整保留平台与歌曲 ID（`source` + `songmid`），
因此导出的文件**换机器、重启服务后仍能直接播放**。

### 导入

点击「导入」选择之前导出的 JSON 文件即可，**自动去重**：

- 按 `uid`（服务端算法，由 `平台 + 歌曲ID + 歌名 + 歌手` 生成）比对
- 同时按 `平台::歌曲ID` 比对，可识别「同一首歌但歌名略有差异」的情况
- 结果会提示：`新增 N 首，自动去重跳过 M 首，忽略无效 K 条`
- 默认**合并**到现有歌单；接口传 `replace: true` 可整体替换（恢复备份用）

导入的歌曲会立即注册到播放缓存，无需重新搜索即可播放。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/status` | 音源/歌单/平台总览 |
| GET | `/api/platforms` | 可用平台与音质 |
| GET | `/api/sources` | 音源列表 |
| POST | `/api/sources` | 导入音源 `{script}` |
| PATCH | `/api/sources` | 启用/停用 `{id, enabled}` |
| DELETE | `/api/sources` | 删除音源 `{ids}` |
| POST | `/api/sources/reload` | 重载全部音源 |
| GET | `/api/search` | 搜索 `?keyword=&source=&page=&limit=` |
| GET | `/api/music-url` | 取播放地址 `?uid=&quality=` |
| GET | `/api/audio` | 音频流代理（支持 Range）`?uid=&quality=` |
| GET | `/api/download` | 下载（附件）`?uid=&quality=` |
| GET | `/api/lyric` | 歌词 `?uid=` |
| GET | `/api/cover` | 封面 `?uid=` 或 `?url=` |
| GET | `/api/playlist` | 歌单 |
| GET | `/api/playlist/export` | **导出歌单**（JSON 附件下载） |
| POST | `/api/playlist/import` | **导入歌单**（自动去重）`{songs:[…]}` 或 `{text:"…"}`，可加 `replace:true` |
| POST | `/api/playlist` | 添加 `{songs:[…]}` |
| DELETE | `/api/playlist` | **移出歌单** `{uids:[…]}` |
| PUT | `/api/playlist` | 重排/清空 `{uids:[…]}` |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 容器内服务端口（需与 compose 映射右侧一致） |
| `DATA_DIR` | `/app/config` | 数据目录（音源 `sources.json`、歌单 `playlist.json`） |
| `NODE_ENV` | `production` | 运行环境 |

> `DATABASE_URL` / `ENABLE_FILE_CACHE` / `AUDIO_CACHE_DIR` / `AUDIO_CACHE_QUOTA_GB`
> 为兼容原部署模板而保留，当前版本未使用。

## 项目结构

```
src/
├── main/
│   ├── server.js              # Express 服务与全部 API
│   └── lx/                    # LX 音源引擎
│       ├── sandbox.js         # vm 沙箱 + lx API（console/utils/request/on/send）
│       ├── runner.js          # 单音源：加载 → 初始化握手 → 动作分发
│       ├── manager.js         # 多音源调度、音质协商、失败回退、歌曲缓存
│       ├── builtin-search.js  # 内置逐平台检索（音源无 musicSearch 时的回退）
│       ├── quality.js         # 音质档位归一化与协商
│       └── http.js            # HTTP 客户端（含流式转发）
└── renderer/
    └── index.html             # 单页前端：搜索 / 播放器 / 歌单（含右键菜单）
```

## 实现要点

1. **必须用 vm 沙箱**：部分音源带反调试自毁代码（`process.kill(process.pid)`），
   直接在主进程执行会杀死服务；沙箱内没有 `process`，自毁代码成为空操作。
2. **console 必须完整**：音源会调用 `console.group` / `groupEnd` / `assert` 等，
   沙箱 console 缺方法会抛 `xxx is not a function` 直接导致**播放失败**。
3. **音质命名不统一**：音源可能声明 `24bit` 而非 `flac24bit`，
   请求音质必须协商后再传给音源，否则被拒。
4. **音频必须服务端代理**：音源返回的直链通常有 Referer / CORS 限制，
   浏览器直接播放会失败，需服务端带 Referer 转发并支持 Range。

## 使用建议

- 音源脚本放在「音源管理」中导入（粘贴全文即可）
- 若某首歌无法播放，先换音源或切换音质（右键 → 复制播放链接可验证直链是否可用）
- 部分音源的上游 API 会按 IP 限制，换网络环境或更换音源即可

## 许可证

Apache License 2.0
