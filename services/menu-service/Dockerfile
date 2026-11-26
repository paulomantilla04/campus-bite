FROM oven/bun:1-alpine
WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src
COPY tsconfig.json ./

ENV PORT=3001 DB_PATH=/data/menu.db
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["bun", "run", "src/index.ts"]
