#!/bin/sh
set -e

<<<<<<< HEAD
export NODE_ENV=${NODE_ENV:-production}
mkdir -p /data/config

=======
echo "Starting HollyMudic..."

# 设置环境变量
export NODE_ENV=${NODE_ENV:-production}

# 创建数据目录
mkdir -p /data/config

# 启动应用
>>>>>>> 1b38fd4b04e7cbf531f3a798999c9e2423015967
exec node src/main/server.js
