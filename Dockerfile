# syntax=docker/dockerfile:1

# ─── Stage 1: Install all dependencies (dev+prod for build) ──────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps

# ─── Stage 2: Build (Vite frontend + esbuild server) ─────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time variables embedded in the client bundle
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

RUN npm run build

# ─── Stage 3: Production dependencies only ───────────────────────────────────
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# ─── Stage 4: Runtime image ───────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Production node_modules (required: esbuild uses --packages=external)
COPY --from=prod-deps /app/node_modules ./node_modules

# Built artifacts (frontend SPA + compiled server)
COPY --from=builder /app/dist ./dist

# Pre-create writable directories for uploads and storage
RUN mkdir -p \
      data/uploads/pdfs \
      data/uploads/covers \
      data/uploads/thumbnails \
      data/uploads/temp \
      data/uploads/temp-chunks \
      data/uploads/categories \
      data/uploads/chunks \
      data/logs \
      storage

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "dist/server.cjs"]
