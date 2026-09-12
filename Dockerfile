FROM node:22-alpine AS builder

WORKDIR /app

# 安装 Chromium 依赖
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# 复制 package 文件
COPY package*.json ./

# 安装依赖（不使用 npm ci，避免需要 package-lock.json）
RUN npm install --legacy-peer-deps

# 复制源代码
COPY src ./src

# 构建应用
RUN npm run build

# 生产阶段
FROM node:22-alpine AS runner

WORKDIR /app

# 安装 Chromium（无头模式运行需要）
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont

# 复制构建产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# 创建数据目录
RUN mkdir -p /data/config
VOLUME ["/data/config"]

# 暴露端口
EXPOSE 3080

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3080/ || exit 1

# 环境变量
ENV NODE_ENV=production
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROME_FLAGS="--no-sandbox --disable-gpu --disable-dev-shm-usage"

# 启动脚本
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
