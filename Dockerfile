FROM node:22-alpine AS builder

WORKDIR /app

<<<<<<< HEAD
COPY package*.json ./

RUN npm install --production

COPY src ./src

=======
# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制应用代码
COPY src ./src

# 生产阶段
>>>>>>> 1b38fd4b04e7cbf531f3a798999c9e2423015967
FROM node:22-alpine AS runner

WORKDIR /app

<<<<<<< HEAD
RUN apk add --no-cache wget

=======
# 安装 Chromium 依赖
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont

# 复制应用
>>>>>>> 1b38fd4b04e7cbf531f3a798999c9e2423015967
COPY --from=builder /app ./

RUN mkdir -p /data/config
VOLUME ["/data/config"]

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3080/api/health || exit 1

ENV NODE_ENV=production
ENV PORT=3080

COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
