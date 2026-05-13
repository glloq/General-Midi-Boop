# Stage 1: Build dependencies
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Stage 2: Production image
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY migrations/ ./migrations/
COPY locales/ ./locales/

# Create data and log directories with proper ownership
RUN mkdir -p data logs backups && \
    adduser --disabled-password --gecos '' appuser && \
    chown -R appuser:appuser /app

USER appuser

ENV NODE_ENV=production
ENV PORT=8080
# Sized for a Pi 4 / Pi 5 default. Override at run time with
# `-e NODE_HEAP_MB=256` on a Pi 3, or by passing NODE_OPTIONS.
ENV NODE_HEAP_MB=512

EXPOSE 8080

# Faster healthcheck cycle so PM2 / k8s notice a hung event loop quickly.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# --max-old-space-size: cap the V8 heap to keep RSS predictable on Pi.
# --expose-gc:          lets the benchmark suite trigger major GC between runs.
# --enable-source-maps=false: stack traces still readable from raw .js;
#                             skipping source-map resolution saves CPU.
CMD ["sh", "-c", "exec node --max-old-space-size=${NODE_HEAP_MB} --expose-gc --enable-source-maps=false server.js"]
