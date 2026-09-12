#!/bin/sh
set -e

# HollyMudic Docker Entrypoint Script

echo "Starting HollyMudic..."

# 设置 Chromium 环境变量
export CHROME_BIN=/usr/bin/chromium
export CHROME_FLAGS="${CHROME_FLAGS} --no-sandbox"

# 创建必要的目录
mkdir -p /data/config
mkdir -p /tmp/holly-mudic

# 检查数据目录权限
if [ ! -w /data/config ]; then
  echo "Warning: /data/config is not writable"
fi

# 执行应用启动
exec node dist/main/index.js "$@"
