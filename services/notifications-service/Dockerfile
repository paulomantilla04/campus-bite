FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production

COPY tsconfig.json ./
COPY src ./src

ENV PORT=3003 DB_PATH=/data/notifications.db
RUN mkdir -p /data

EXPOSE 3003

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3003/health > /dev/null || exit 1

CMD ["bun", "run", "src/index.ts"]
