#!/usr/bin/env bash
# ============================================
# One-step Docker install for Minecraft Bedrock Server Manager
# ============================================
# Usage:
#   git clone <repo> && sudo bash <checkout>/scripts/install-docker.sh
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
SKIP_FIREWALL=0

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}$*${NC}"; }
warn() { echo -e "${YELLOW}$*${NC}"; }
die() { echo -e "${RED}$*${NC}" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-firewall) SKIP_FIREWALL=1 ;;
        -h|--help)
            cat <<'EOF'
Install Minecraft Bedrock Server Manager with Docker Compose.

This script is meant to be run with sudo from a git checkout:

  git clone https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git
  sudo bash minecraft-bedrock-manager/scripts/install-docker.sh

Options:
  --skip-firewall   Do not add UFW rules
  -h, --help        Show this help
EOF
            exit 0
            ;;
        *) die "Unknown option: $1" ;;
    esac
    shift
done

[[ "${EUID}" -eq 0 ]] || die "Run this script with sudo."
[[ -f "${APP_DIR}/docker-compose.yml" ]] || die "Run this from a Minecraft Bedrock Server Manager checkout."
[[ "$(uname -s)" == "Linux" ]] || die "Docker production uses Linux host networking. Install on Ubuntu 24.04."

if [[ "$(uname -m)" != "x86_64" && "$(uname -m)" != "amd64" ]]; then
    warn "This project targets Linux x86-64. Continuing anyway."
fi

export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y ca-certificates curl git ufw
fi

if ! command -v docker >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 || die "Docker is not installed and this host is not apt-based."
    log "Installing Docker..."
    apt-get install -y docker.io
    apt-get install -y docker-compose-v2 || apt-get install -y docker-compose-plugin || true
    systemctl enable --now docker
fi

docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)."

cd "${APP_DIR}"
if [[ ! -f .env ]]; then
    cp .env.example .env
    log "Created .env from .env.example. Edit it later if you need CONNECT_HOST or a different PORT."
fi

set -a
# shellcheck disable=SC1091
source "${APP_DIR}/.env"
set +a
export PORT="${PORT:-3000}"

if [[ "${SKIP_FIREWALL}" -eq 0 ]]; then
    "${APP_DIR}/scripts/configure-ubuntu-firewall.sh"
else
    warn "Skipped firewall configuration."
fi

log "Building and starting the manager..."
docker compose up -d --build

log "Install complete."
echo "Open http://<this-host>:${PORT}"
echo "Data is stored in Docker volumes mc-data and mc-logs. Never run docker compose down -v."
echo "Later updates: sudo ./scripts/upgrade.sh"
