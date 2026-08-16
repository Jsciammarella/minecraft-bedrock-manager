#!/usr/bin/env bash
# ============================================
# One-step native Ubuntu install for Minecraft Bedrock Server Manager
# ============================================
# Usage:
#   sudo git clone <repo> /opt/mc-manager && sudo bash /opt/mc-manager/scripts/install-native.sh
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
SKIP_FIREWALL=0
SERVICE_USER="mcmanager"

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
Install Minecraft Bedrock Server Manager as a native systemd service.

This script is meant to be run with sudo from a git checkout:

  git clone https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git
  sudo bash minecraft-bedrock-manager/scripts/install-native.sh

Preferred (avoids systemd ProtectHome issues under /home):

  sudo git clone https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git /opt/mc-manager
  sudo bash /opt/mc-manager/scripts/install-native.sh

It installs Node.js 20, build tools, Java, Git LFS, firewall rules, and a
systemd unit that runs as mcmanager. The unit is written for this checkout
path, so you can clone into /opt/mc-manager or any other directory.

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
[[ -f "${APP_DIR}/package.json" && -f "${APP_DIR}/server/index.js" ]] \
    || die "Run this from a Minecraft Bedrock Server Manager checkout."
command -v apt-get >/dev/null 2>&1 || die "Native install currently supports apt-based Ubuntu hosts."

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl python3 make g++ wget tar unzip git git-lfs ufw default-jre-headless

need_node=1
if command -v node >/dev/null 2>&1; then
    node_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "${node_major}" == "20" ]]; then
        need_node=0
    else
        warn "Found Node.js $(node -v); this app is tested on 20.x. Installing Node.js 20."
    fi
fi
if [[ "${need_node}" -eq 1 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
git lfs install --system >/dev/null 2>&1 || true

NODE_BIN="$(command -v node)"
[[ -x "${NODE_BIN}" ]] || die "Node.js 20 was not installed."
node_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
[[ "${node_major}" == "20" ]] || die "Node.js 20.x is required (found $(node -v))."

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

log "Installing Node dependencies and building the UI..."
npm ci
npm --prefix frontend ci
npm run build

if [[ "${SKIP_FIREWALL}" -eq 0 ]]; then
    "${APP_DIR}/scripts/configure-ubuntu-firewall.sh"
else
    warn "Skipped firewall configuration."
fi

if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"

unit_path="/etc/systemd/system/mc-manager.service"
sed \
    -e "s#WorkingDirectory=/opt/mc-manager#WorkingDirectory=${APP_DIR}#" \
    -e "s#EnvironmentFile=/opt/mc-manager/.env#EnvironmentFile=${APP_DIR}/.env#" \
    -e "s#ReadWritePaths=/opt/mc-manager/data#ReadWritePaths=${APP_DIR}/data#" \
    -e "s#ExecStart=/usr/bin/node server/index.js#ExecStart=${NODE_BIN} server/index.js#" \
    "${APP_DIR}/scripts/mc-manager.service" > "${unit_path}"

if [[ "${APP_DIR}" == /home/* ]]; then
    warn "Checkout is under /home; disabling systemd ProtectHome so mcmanager can read it."
    sed -i 's/^ProtectHome=true/ProtectHome=false/' "${unit_path}"
fi

systemctl daemon-reload
systemctl enable --now mc-manager
systemctl --no-pager --full status mc-manager || true

log "Install complete."
echo "Open http://<this-host>:${PORT}"
echo "Service: systemctl status mc-manager"
echo "Later updates from ${APP_DIR}: sudo ./scripts/upgrade.sh --mode native"
