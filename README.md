# HollyMusic - Docker Music Player

基于 LX Music 音源加载逻辑的 Docker 化音乐播放器。

## 快速开始

### Docker 部署

本项目提供两种部署方式：

#### 方式一：在线安装（推荐，需能访问 GHCR）

```bash
docker compose -f online/docker-compose.yml up -d
```

每次更新时执行 `docker compose -f online/docker-compose.yml pull && docker compose -f online/docker-compose.yml up -d` 即可。

访问 http://localhost:3099

#### 方式二：离线安装（NAS 无法直连 GHCR 时使用）

1. 打开 [GitHub Releases](https://github.com/RiggestOu/HollyMusic_Docker_LXMusic/releases) 页面，下载 `hollymusic_docker_lxmusic-latest.tar.gz`
2. 上传到本地或 NAS
3. 导入镜像：

   ```bash
   docker load -i hollymusic_docker_lxmusic-latest.tar.gz
   ```

4. 确认镜像存在：

   ```bash
   docker images | grep hollymusic_docker_lxmusic
   ```

5. 使用离线配置启动：

   ```bash
   docker compose -f offline/docker-compose.yml up -d
   ```

如需更新，重新下载新包并再次 `docker load`，然后重启 Compose。

## 功能特性

- 🎵 多音源支持（酷我、腾讯、酷狗、咪咕、网易云）
- 🐳 Docker 容器化部署
- 📦 自定义音源导入/导出
- 🔒 沙箱隔离执行
- 💾 持久化配置存储

## 项目结构

```
src/
├── common/          # 公共类型和常量
├── main/           # Electron 主进程
│   └── modules/source/  # 音源管理模块
└── renderer/       # Vue 渲染进程
```


---

# 本项目增强说明（HollyMusic_Docker_LXMusic）

在 HollyMusic（MIT）基础上做的增强。整体授权为 **GPL-3.0-only**（见 LICENSE 与 NOTICE.md），
原 HollyMusic 的 MIT 声明保留在 LICENSE-MIT.txt。

## 粒子视觉界面

- 歌词面板已替换为 Mineradio 风格的粒子界面（近黑背景 + 13 种视觉预设）。
- 渲染后端：**优先 WebGPU（Compute Shader）**，不支持时自动降级 WebGL 2.0，视觉与交互一致。
- 交互（Maya 风格）：
  - PC：滚轮 = 调节菜单滑块；Alt+中键 = 旋转；Alt+右键 = 推拉；单独中键 = 平移。
  - iOS / iPad：单指 = 旋转；双指 = 平移；三指 = 推拉。
- 设置卡（界面右上角）：视觉预设、粒子密度、帧率、粒子大小、AI 深度增强、自定义封面图片。
- 相机基线、密度（默认 119x119）、点大小、配色与亮度分组均对齐 Mineradio。

## PC 桌面端（Tauri 2.x）

- 开发：`npm run tauri dev`（或 `pnpm tauri dev`，以仓库脚本为准）
- 打包：`npm run tauri build`（NSIS 安装包，版本号固定 0.0.1）
- 功能：
  - 桌面动态壁纸（嵌入 WorkerW，鼠标穿透，全屏自动暂停）
  - 悬浮置顶歌词（工具窗口、鼠标穿透、字号/透明度可调）
  - 系统托盘（显示/隐藏主窗口、开关壁纸与歌词、退出）
  - 单实例运行（`tauri-plugin-single-instance`，重复启动激活已有主窗口）
- 音频频谱与歌词通过 Tauri IPC 分发给壁纸/歌词窗口。

## 下载到 NAS（服务端落盘）

- 全部前端下载入口（歌曲行、右键菜单、粒子界面、歌单批量）均调用
  `POST /api/download-to-nas`，把音频保存到**服务端目录**（不是浏览器下载）。
- 目录默认 `/app/prisma/prisma/data/music`，可用环境变量 `MUSIC_DOWNLOAD_DIR` 覆盖。
- 音质：默认取该曲目支持的**最高质量**（flac24bit > flac > 320k > 128k）。
- 已下载的歌**优先播放本地文件**：`/api/audio` 会先判断本地是否已有，
  命中则转 `/api/local-music/play`（支持 Range，可拖动进度）。
- **不写数据库**：所有新增接口仅读取 MusicInfo 或仅操作磁盘文件，遵守 HollyMusic 数据库保护条款。

## 本地音乐浏览

- 歌单页下方「本地音乐」区块列出 NAS 目录中的全部音频（文件名 / 大小 / 时间）。
- 相关环境变量：
  - `MUSIC_DOWNLOAD_DIR` —— 音乐落盘/浏览目录
  - `PARTICLE_IMAGE_DIR` —— 粒子自定义封面图片目录
  - `AUTH_SECRET` —— 登录密钥（>= 32 位）

## NAS / 群晖部署

见 [docs/NAS-DEPLOY.md](docs/NAS-DEPLOY.md)：compose 示例、更新流程、
`/api/status` 判定新旧镜像、ghcr 不可达时的离线导入。

## 开发辅助脚本

- `python scripts/verify-particle-shaders.py` —— 粒子着色器真机编译与绑定校验
- `.tmp-visual/run_visual_probe.py` —— 4K 渲染实测（逐预设可见性/节拍增益/宽高比锁定）

## 授权

- 本项目：GPL-3.0-only
- HollyMusic 上游：MIT（LICENSE-MIT.txt）
- Mineradio：GPL-3.0（粒子视觉与骷髅点云资源来源，详见 NOTICE.md）
