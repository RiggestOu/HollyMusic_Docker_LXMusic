FROM node:22-alpine AS builder

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制应用代码
COPY src ./src

# 生产阶段
FROM node:22-alpine AS runner

WORKDIR /app

# 安装 Chromium 依赖
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont

# 复制应用
COPY --from=builder /app ./

# 创建数据目录
RUN mkdir -p /data/config
VOLUME ["/data/config"]

# 暴露端口
EXPOSE 3080

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3080/api/health || exit 1

# 环境变量
ENV NODE_ENV=production
ENV PORT=3080

# 启动脚本
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
