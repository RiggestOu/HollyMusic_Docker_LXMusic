#!/bin/sh
set -e

echo "Starting HollyMudic..."

# 设置环境变量
export NODE_ENV=${NODE_ENV:-production}

# 创建数据目录
mkdir -p /data/config

# 启动应用
exec node src/main/server.js
