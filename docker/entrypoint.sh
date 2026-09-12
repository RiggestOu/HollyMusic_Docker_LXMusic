#!/bin/sh
set -e

echo "Starting HollyMudic..."

# 环境变量默认值（与 Dockerfile 中 ENV 保持一致）
export NODE_ENV=${NODE_ENV:-production}
export PORT=${PORT:-3000}
export DATA_DIR=${DATA_DIR:-/app/config}

# 确保数据目录存在
mkdir -p "$DATA_DIR"

# 启动应用
exec node src/main/server.js
