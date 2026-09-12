FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY src ./src

FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache wget

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
