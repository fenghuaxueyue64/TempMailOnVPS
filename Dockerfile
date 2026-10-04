# Dockerfile
# ① 后端依赖
FROM oven/bun:1.1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# ② 前端构建（SvelteKit → adapter-static 静态产物）
FROM oven/bun:1.1-alpine AS web-builder
WORKDIR /app/web
COPY web/package.json web/bun.lock* ./
RUN bun install --frozen-lockfile
COPY web/ .
RUN bun run build

# ③ 运行时镜像
FROM oven/bun:1.1-alpine
WORKDIR /app

# sqlite-libs：bun:sqlite 运行时依赖；sqlite：CLI（scripts/backup.sh 用 .backup 安全备份）
# curl：HEALTHCHECK 探测 /api/health
RUN apk add --no-cache sqlite-libs sqlite curl

COPY --from=deps /app/node_modules ./node_modules
COPY --from=web-builder /app/web/build ./web/build
COPY src/ ./src/
COPY package.json tsconfig.json ./

# 运行时数据目录（由 docker-compose volumes 挂载）
RUN mkdir -p /app/data/db /app/data/att /app/data/backup

EXPOSE 25 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["bun", "run", "src/main.ts"]
