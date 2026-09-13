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
