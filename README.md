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

## 镜像与版本

镜像地址：`ghcr.io/riggestou/hollymusic_docker_lxmusic`

每次 `push` 到 `main`/`master` 会自动构建并推送 **3 个 tag**（同一个包下新增"版本"，不会新增"包"）：

| Tag | 说明 |
|-----|------|
| `latest` | 永远指向最新构建 |
| `<commit-sha>` | 完整 40 位提交哈希，精确锁定某次提交，便于回滚排查 |
| `build-<N>` | 递增序号，每次推送都会多一条，最便于辨认"更新了哪一版" |

> **关于 GitHub Packages 页面**：该页面第一层列的是「包（package）」，
> 本项目始终只有 1 个包，所以条目数不会变。
> "更新"体现在**包详情页的版本列表**（Recent tagged image versions）与 **Last published** 时间上。
> 查看入口：<https://github.com/users/RiggestOu/packages/container/package/hollymusic_docker_lxmusic>

### 拉取与更新

**推荐做法**：compose 里保留 `:latest` 并加上 `pull_policy: always`，
每次 `up`／重建都会向注册表核对 digest，有新版本才下载：

```yaml
services:
  app:
    image: ghcr.io/riggestou/hollymusic_docker_lxmusic:latest
    pull_policy: always      # ★ 不加这行可能一直跑旧镜像
```

**`always` 的代价很小**：它只是请求 manifest 比对 digest（几 KB、1~2 秒）；
digest 未变时**不会重新下载任何层**，直接复用本地镜像。变化时也只下载差异层。

想更省，可用 `daily` / `weekly` / `every_12h`（距上次拉取超过该时长才核对一次），
但这些是较新的策略值，需较新的 Compose 版本支持，群晖上可能不认。

**正确的手动更新命令**（只有镜像真的变了才会重建容器）：

```bash
docker compose pull && docker compose up -d
```

> 注意：**不要加 `--force-recreate`** —— 它会无视镜像是否变化、强制重启容器，
> 与"只在有更新时才动"的目标相反。`docker compose up -d` 自身会在镜像 ID 或配置变化时才重建。

**⚠️ 为什么必须加 `pull_policy: always`**：Compose 默认策略是 `missing` ——
**本地已存在同名 tag 就不拉取**。所以"删除容器再重建"往往仍然是旧镜像。

**群晖 Container Manager 用户注意**：Container Manager **不会**为 ghcr.io（非 Docker Hub）
的镜像显示"有更新"提示，且点「重新启动容器」不会拉取镜像。可靠流程是：

1. 项目 → Action → **停止**
2. 项目 → Action → **清理**（Clean，删除容器，不影响数据卷）
3. **镜像** 标签页 → **删除** `hollymusic_docker_lxmusic` 镜像
4. 回到项目 → Action → **构建** → 此时本地无镜像，必然拉取最新

或者直接改用精确 tag，本地不存在该 tag 时必定拉取，不受 Compose 版本与策略影响：

```yaml
image: ghcr.io/riggestou/hollymusic_docker_lxmusic:build-11
```

### 全自动更新（可选）

**Watchtower 是「定时轮询」，不是「监听 GitHub 推送」** —— 它不知道你的构建何时完成，
而是按 `--interval` 周期性地去注册表核对镜像 digest：

```
git push → GitHub Actions 构建 → 推送新镜像到 GHCR
                                        ↓
                     （Watchtower 下一次轮询时才发现，延迟 ≤ 一个 interval）
                                        ↓
                            增量拉取差异层 → 重启容器
```

```bash
docker run -d --name watchtower --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower --interval 3600 --cleanup holly-music
```

- `--interval 3600` 每小时核对一次（想更快就调小，如 600 = 10 分钟）
- `--cleanup` 更新后清理旧镜像（**共享的基础层受引用计数保护，不会被删**，不影响下次增量拉取）
- 末尾 `holly-music` 是容器名，只管理这一个，不碰 NAS 上其他服务
- 没有新构建时**零下载**，只有一次 manifest 请求（几 KB）

#### 拉取是增量还是全量？

**只拉取差异层**，不是整个镜像重下。Docker 镜像由多个 content-addressed 层组成，
拉取时逐层比对本地是否已有该 digest 的层：已有则跳过（日志显示 `Already exists`），
没有才下载。本项目的 Dockerfile 中 `FROM node:22-alpine`、`apk add wget`、
`npm install --production` 这些层在代码改动时不会变，**会被完整复用**，
通常每次更新只下载几百 KB ～ 几 MB。

#### 想「构建成功即刻更新」（零延迟）

Watchtower 可开启 HTTP API，由 CI 在构建成功后直接回调触发：

```bash
# Watchtower 启动参数加上：
  --http-api-update --http-api-token <你的随机token>
```

```yaml
# .github/workflows/build.yml 末尾加一步
      - name: Trigger NAS update
        run: |
          curl -fsS -X POST \
            -H "Authorization: Bearer ${{ secrets.WATCHTOWER_TOKEN }}" \
            https://<你的域名>/v1/update || true
```

> ⚠️ **安全提醒**：这要求 GitHub 的 runner 能访问到你的 NAS，
> 意味着需要公网暴露或内网穿透 —— 请务必走 HTTPS 反代 + 强 Token，
> 并只暴露 `/v1/update` 这一个端点。若不希望暴露 NAS，
> **用群晖计划任务定时轮询是更安全的选择**。

> 群晖计划任务等价写法（定时执行）：
> `cd /volume1/docker/holly-music && docker compose pull && docker compose up -d`

### 验证更新是否生效

```bash
# 1) 容器里有没有新代码（旧镜像没有 lx 目录）
docker exec holly-music ls /app/src/main/

# 2) 接口（旧镜像没有 /api/status，会返回 404）
curl http://<NAS-IP>:3099/api/status

# 3) 看容器用的镜像 ID 与创建时间
docker inspect holly-music --format '{{.Image}} / {{.Created}}'
```

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
