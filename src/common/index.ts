/**
 * HollyMudic - 音乐播放器
 * 
 * 基于 LX Music 音源加载逻辑移植
 * 目标：Docker 容器化部署的音乐播放应用
 */

// ============================================================
// 项目说明
// ============================================================
// 
// 本项目将 LX Music 的音源加载机制移植到 Docker 环境中：
// 
// 1. 音源系统
//    - 支持多音源：酷我、腾讯、酷狗、咪咕、网易云
//    - 自定义音源导入/导出
//    - 脚本 gzip 压缩存储
//    - BrowserWindow 沙箱隔离执行
//    - IPC 双向事件通信
//    - 并发请求队列 + 20秒超时
// 
// 2. Docker 部署
//    - 基于 Alpine Linux 的轻量镜像
//    - Chromium 无头模式运行
//    - 持久化 Volume 存储配置
//    - 健康检查与自动重启
// 
// 3. 核心文件
//    - src/main/modules/source/ - 音源管理模块
//    - src/main/ipc/source.ts - IPC 处理器注册
//    - src/renderer/core/source/ - 渲染进程音源逻辑
//    - Dockerfile - 容器构建配置
//    - docker/docker-compose.yml - 容器编排
//
// ============================================================

export const PROJECT_NAME = 'HollyMudic'
export const VERSION = '1.0.0'
export const DOCKER_PORT = 3080
