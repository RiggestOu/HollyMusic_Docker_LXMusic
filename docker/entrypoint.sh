#!/bin/sh
set -e

<<<<<<< HEAD
=======
<<<<<<< HEAD
export NODE_ENV=${NODE_ENV:-production}
mkdir -p /data/config

=======
>>>>>>> bf185f39444327d258f2b47f98f45554ae793021
echo "Starting HollyMudic..."

# 设置环境变量
export NODE_ENV=${NODE_ENV:-production}

# 创建数据目录
mkdir -p /data/config

# 启动应用
<<<<<<< HEAD
=======
>>>>>>> 1b38fd4b04e7cbf531f3a798999c9e2423015967
>>>>>>> bf185f39444327d258f2b47f98f45554ae793021
exec node src/main/server.js
