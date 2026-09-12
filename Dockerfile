FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY src ./src

FROM node:22-alpine AS runner

WORKDIR /app

# wget 用于 HEALTHCHECK
RUN apk add --no-cache wget

COPY --from=builder /app ./

# 预先创建 docker-compose 中会被挂载的目录，
# 避免 Docker 自动以 root 属主创建、便于排查
RUN mkdir -p \
      /app/config \
      /app/custom-sources \
      /app/logs \
      /app/.cache \
      /app/prisma/prisma/data

VOLUME ["/app/config"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/api/health || exit 1

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/config

COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
