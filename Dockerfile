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

# Install system dependencies required for native modules and BDS zips
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    g++ \
    make \
    curl \
    wget \
    tar \
    unzip \
    git \
    git-lfs \
    default-jre-headless \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install --system

WORKDIR /app

# Copy package files and install backend dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy backend source
COPY server/ ./server/
COPY vendor/ ./vendor/

# Copy built frontend from Stage 1
COPY --from=frontend-build /app/public ./public

# Create data directories
RUN mkdir -p /app/data/servers /app/data/mods /app/data/mods/thumbs /app/data/logs /app/data/uploads /app/data/git-catalog /app/data/bedrock-connect /app/data/phantom

# Stay root in the image. Game UDP ports are unprivileged (>1024), but this
# process writes the named volume, copies Phantom, and spawns Bedrock / Java /
# Phantom children on the host network. A non-root image user caused permission
# failures on a clean Docker volume. Native installs still run as mcmanager.
USER root

# Expose port
EXPOSE ${PORT}
EXPOSE 53/udp
EXPOSE 53/tcp

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:${PORT}/api/health || exit 1

# Start the application
CMD ["node", "server/index.js"]
