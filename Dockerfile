# ── Stage 1: Instalar dependencias ──
FROM oven/bun:1 AS deps

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# ── Stage 2: Producción ──
FROM oven/bun:1-slim

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Puerto (Railway inyecta PORT en runtime)
ENV PORT=4000
EXPOSE 4000

# Bun ejecuta TypeScript directamente, sin compilación
CMD ["bun", "run", "src/index.ts"]
