#!/bin/bash
# ============================================
# Minecraft Bedrock Server Manager
# Startup Script for Ubuntu 24.04
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="${APP_DIR}/data"
LOG_DIR="${DATA_DIR}/logs"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} Minecraft Bedrock Server Manager${NC}"
echo -e "${GREEN}========================================${NC}"

# Check Node.js version
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    echo "Install Node.js 20+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}Error: Node.js 20+ required (found: $(node -v))${NC}"
    exit 1
fi

echo -e "${YELLOW}Node.js version: $(node -v)${NC}"
echo -e "${YELLOW}Platform: $(uname -s) $(uname -m)${NC}"

# Create required directories
mkdir -p "${DATA_DIR}/servers"
mkdir -p "${DATA_DIR}/mods"
mkdir -p "${DATA_DIR}/mods/thumbs"
mkdir -p "${DATA_DIR}/git-catalog"
mkdir -p "${DATA_DIR}/bedrock-connect"
mkdir -p "${LOG_DIR}"
mkdir -p "${DATA_DIR}/uploads"

if command -v java >/dev/null 2>&1; then
    echo -e "${YELLOW}Java: $(java -version 2>&1 | head -n 1)${NC}"
else
    echo -e "${YELLOW}Warning: Java was not found. Bedrock Connect will not start until a JRE is installed.${NC}"
fi

# Load environment variables
if [ -f "${APP_DIR}/.env" ]; then
    echo -e "${GREEN}Loading .env file${NC}"
    set -a
    source "${APP_DIR}/.env"
    set +a
fi

# Set defaults
export PORT="${PORT:-3000}"
export NODE_ENV="${NODE_ENV:-production}"

# Install dependencies if needed
if [ ! -d "${APP_DIR}/node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    cd "${APP_DIR}" && npm ci --omit=dev
fi

# Start the application
echo -e "${GREEN}Starting Minecraft Bedrock Server Manager...${NC}"
echo -e "${YELLOW}Listening on port ${PORT}${NC}"
echo -e "${YELLOW}API: http://localhost:${PORT}/api${NC}"
echo -e "${YELLOW}Web UI: http://localhost:${PORT}${NC}"
echo -e "${YELLOW}Public API: http://localhost:${PORT}/api/v1${NC}"
echo ""

cd "${APP_DIR}"
exec node server/index.js
