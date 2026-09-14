# NAS / 群晖部署说明

> 适用：群晖 DSM（Container Manager / 套件版 Docker）、以及任何支持 Compose 的 NAS 或 Linux 主机。
>
> 相关文件：`docker-compose.yml`、`Dockerfile`、`.env`。镜像由 GitHub Actions 推送到 GHCR。

---

## 1. 前置准备

1. 在 NAS 上新建目录，例如 `/docker/hollymusic`，用于放置 `docker-compose.yml` 与 `.env`。
2. 生成 `AUTH_SECRET`（**至少 32 位**），在能执行 `openssl` 的机器上运行：

   ```bash
   openssl rand -hex 32
   ```

3. 确认数据卷目录可写。容器把 SQLite 数据写到 `./prisma_data`（对应容器内
   `/app/prisma/prisma/data`）。**这一份就是你的全部歌单、用户、收藏、播放历史，务必备份。**

---

## 2. docker-compose.yml 示例

```yaml
services:
  hollymusic:
    image: ghcr.io/riggestou/hollymusic_docker_lxmusic:latest
    container_name: hollymusic
    # 关键：latest 必须每次拉取，否则本地有旧镜像时不会更新
    pull_policy: always
    restart: unless-stopped
    ports:
      - '3099:3000'
    env_file:
      - .env
    volumes:
      - ./prisma_data:/app/prisma/prisma/data
      # 自定义粒子图片（第 5 项完成后启用）
      # - ./uploads:/app/uploads
```

`.env` 至少包含：

```env
AUTH_SECRET=这里填刚才生成的 32 位以上随机串
```

> 端口说明：容器内 nginx 监听 `3000`，上面映射为主机的 `3099`。改主机端口时只改冒号左边。

---

## 3. 首次启动

```bash
cd /docker/hollymusic
docker compose up -d
docker compose logs -f --tail=100 hollymusic
```

看到服务就绪后访问 `http://<NAS 的 IP>:3099`。

---

## 4. 日常更新

```bash
cd /docker/hollymusic
docker compose pull          # 拉最新镜像
docker compose up -d         # 重建并替换容器
docker image prune -f        # 可选：清理旧镜像释放空间
```

**不要用 GUI 的「重新启动容器」来代替更新**——它只是重启现有容器，不会重新拉取镜像。

判断到底有没有更新成功，用这个决定性检查：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<NAS 的 IP>:3099/api/status
```

返回 `404` 说明跑的还是旧镜像（该端点在新版本才有）；非 404 即已更新。

---

## 5. 数据备份与恢复

- **备份**：停机后打包整个 `prisma_data` 目录（或直接拷贝 `prisma_data/*.db*`）。
- **恢复**：把备份放回同一路径，再 `docker compose up -d`。
- 不要在容器运行时直接拷贝 db 文件，SQLite 可能处于写入中间态；先 `docker compose stop`。

---

## 6. 无法直连 GHCR 时的离线导入

若 NAS 访问 `ghcr.io` 被重置或限速，可用 GitHub Release 上的固定预发布 **image-latest**
（内含 `docker save` 出的 tar 包）：

1. 在能联网的机器上下载 `hollymusic-image-latest.zip`，解压得到 tar。
2. 传到 NAS 后导入：

   ```bash
   docker load -i hollymusic-image-latest.tar
   docker images | grep hollymusic   # 确认镜像已存在
   ```

3. 把 compose 里的 `pull_policy: always` 临时改为 `pull_policy: never`，
   或给镜像打上 `:latest` 标签后 `docker compose up -d`。

---

## 7. 常见问题

| 现象 | 排查 |
|---|---|
| 打不开页面 | `docker compose ps` 看是否 Up；`docker compose logs` 看有无 `AUTH_SECRET` 缺失报错 |
| 端口冲突 | 改 compose 里的主机端口（如 `3199:3000`） |
| 更新后界面没变化 | 浏览器强刷（Ctrl/Cmd+Shift+R）；确认 `/api/status` 非 404 |
| 提示权限不足 | 检查 `prisma_data` 目录对容器用户可写（群晖上通常用 `Everyone` 读写或 `PUID/PGID` 对齐） |
| 桌面端（Windows exe） | 在 GitHub Release 的 `desktop-latest` 中取安装包；版本号固定 0.0.1 |

---

## 8. 让浏览器用上 WebGPU（粒子界面）

粒子界面优先走 **WebGPU（Compute Shader）**，不支持时自动降级 **WebGL 2.0**。
但浏览器的规范限制是：**`navigator.gpu` 只在安全上下文（HTTPS 或 localhost）下才存在**。
用 `http://<NAS的IP>:3099` 这类地址访问时，WebGPU API 根本不会暴露，因此必然降级 ——
这与代码无关。

界面上可以随时确认：歌词面板粒子界面右上角会显示 **绿色 WebGPU** 或灰色 **WebGL 2.0** 徽标。

### 方式一：Chrome / Edge 把该来源标记为「安全」（最快，无需改动部署）

1. 浏览器打开 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`（Edge 同地址）
2. 在下拉框里填入你的访问地址，例如 `http://192.168.1.10:3099`
3. 把它设为 **Enabled**，按提示重启浏览器
4. 重新打开粒子界面 → 徽标应变为 WebGPU

> 仅对本机浏览器生效；Safari / iOS 没有等价开关。

### 方式二：用 localhost 访问（SSH 端口转发）

```bash
# 在你自己的电脑上执行，把 NAS 的 3099 映射到本机 localhost:3099
ssh -L 3099:localhost:3099 用户名@NAS地址
# 然后浏览器打开
http://localhost:3099
```

localhost 天然属于安全上下文 → 直接可用 WebGPU。适合临时验证。

### 方式三：给 NAS 配 HTTPS（推荐长期方案）

群晖「控制面板 → 登录门户 → 高级 → 反向代理」新增一条：

- 来源：`HTTPS` / 端口 `3443`（或你已有的证书域名）
- 目标：`HTTP` / `localhost` / 端口 `3099`

再配 Let's Encrypt 证书（或群晖自带的自签证书）。之后用 `https://域名` 访问即可，
手机 Safari、iPad 也会一并获得 WebGPU（iOS 26+ 支持）。

### 方式四：Tauri 桌面端（无需任何配置）

桌面端页面地址是 `http://localhost`，本身就在安全上下文里 ——
**桌面粒子壁纸 / 悬浮歌词默认就会走 WebGPU**，这是验证 WebGPU 版本最直接的场合。

### Firefox 的情况（2026-09 现状）

Firefox 的 WebGPU 已进入「桌面基本齐全」状态，但**分平台**：

| 平台 | 状态 |
|---|---|
| Windows | 自 **Firefox 141** 起默认开启 |
| Apple Silicon Mac | 自 **Firefox 145** 起默认开启 |
| Intel Mac | 未默认开启（需 flag） |
| Linux | 仍在推进中，需在 about:config 打开 `dom.webgpu.enabled` |
| Android | 仍在 flag 后面，预计 2026 年内 |

**同样受安全上下文限制**：用 `http://<局域网IP>:3099` 访问时，Firefox 一样不会暴露
`navigator.gpu` —— 这条规则所有浏览器都一样，与浏览器品牌无关。

Firefox 的对等做法（相当于 Chrome 的 unsafely-treat-insecure-origin-as-secure）：

1. 地址栏打开 `about:config`，接受风险提示
2. 搜索 `securecontext`
   - 新版是 `dom.securecontext.allowlist`
   - 旧版是 `dom.securecontext.whitelist`
3. 值填**主机名（不带端口、不带协议）**，例如 `192.168.1.10`；多个用逗号分隔
4. 重启浏览器 → 该来源被视为安全上下文 → WebGPU 可用

> 结论：最省事的仍是 **HTTPS 反代** 或 **localhost**（见方式二/三），
> 这两种对所有浏览器一次到位，不用逐浏览器改 settting。
