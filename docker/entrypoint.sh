#!/bin/sh
set -e

export NODE_ENV=${NODE_ENV:-production}
mkdir -p /data/config

exec node src/main/server.js
