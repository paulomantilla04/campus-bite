# Build context: raíz del repo (.)

# ---- Stage 1: build del frontend React ----
FROM oven/bun:1-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY index.html vite.config.ts tsconfig*.json ./
COPY public ./public
COPY src ./src
RUN bun run build

# ---- Stage 2: Nginx (gateway + estáticos) ----
FROM nginx:1.27-alpine

COPY gateway/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/api/health || exit 1
