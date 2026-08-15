# ============================================
# Minecraft Bedrock Server Manager - Dockerfile
# ============================================
# Multi-stage build for production deployment
# Target: Ubuntu 24.04

# ---- Stage 1: Frontend Build ----
FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend

# Copy frontend package files
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci && npm cache clean --force

# Copy frontend source
COPY frontend/ ./

# Build the frontend
RUN npm run build

# ---- Stage 2: Production ----
FROM node:20-bookworm-slim AS production

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Install system dependencies required for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    g++ \
    make \
    curl \
    wget \
    tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install backend dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy backend source
COPY server/ ./server/

# Copy built frontend from Stage 1
COPY --from=frontend-build /app/public ./public

# Create data directories
RUN mkdir -p /app/data/servers /app/data/mods /app/data/logs /app/data/uploads

# Create non-root user
RUN groupadd -r mcmanager && useradd -r -g mcmanager -d /app -s /bin/bash mcmanager \
    && chown -R mcmanager:mcmanager /app

USER mcmanager

# Expose port
EXPOSE ${PORT}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:${PORT}/api/health || exit 1

# Start the application
CMD ["node", "server/index.js"]
