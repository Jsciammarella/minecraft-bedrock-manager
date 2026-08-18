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
# shellcheck source=wsl.sh
source "${SCRIPT_DIR}/wsl.sh"
mc_prepend_docker_cli_path
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

On Windows, use PowerShell instead (Docker Desktop must already be installed):

  git clone https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git
  powershell -ExecutionPolicy Bypass -File .\minecraft-bedrock-manager\scripts\install-docker.ps1

See docs/windows.md. Advanced Ubuntu WSL: docs/wsl.md.

Options:
  --skip-firewall   Do not add UFW / Windows Firewall rules
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
[[ "$(uname -s)" == "Linux" ]] || die "This script is for Ubuntu. On Windows use scripts/install-docker.ps1 with Docker Desktop (docs/windows.md)."

if mc_is_wsl; then
    if mc_is_docker_desktop_distro; then
        die "This is Docker Desktop's internal WSL distro, not Ubuntu. Install Ubuntu from the Microsoft Store, run wsl --set-default Ubuntu, then clone and install there. See docs/wsl.md."
    fi
    log "WSL detected. See docs/wsl.md for Docker Desktop vs Docker Engine and Windows Firewall."
    case "${APP_DIR}" in
        /mnt/[a-z]/*)
            warn "This checkout is on /mnt/*. Clone into the Linux home directory for usable Docker performance."
            ;;
    esac
fi

if [[ "$(uname -m)" != "x86_64" && "$(uname -m)" != "amd64" ]]; then
    warn "This project targets Linux x86-64. Continuing anyway."
fi

export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y ca-certificates curl git ufw
fi

if ! command -v docker >/dev/null 2>&1; then
    mc_prepend_docker_cli_path
fi
if ! command -v docker >/dev/null 2>&1; then
    if mc_is_wsl && mc_docker_desktop_present; then
        die "Docker Desktop is present but the docker CLI is not in this distro. Enable the distro under Docker Desktop → Settings → Resources → WSL."
    fi
    if mc_is_wsl && ! mc_systemd_running; then
        die "Docker is not installed. Enable systemd in /etc/wsl.conf (see docs/wsl.md) or install Docker Desktop with the WSL backend."
    fi
    command -v apt-get >/dev/null 2>&1 || die "Docker is not installed and this host is not apt-based."
    log "Installing Docker..."
    apt-get install -y docker.io
    apt-get install -y docker-compose-v2 || apt-get install -y docker-compose-plugin || true
    if mc_systemd_running; then
        systemctl enable --now docker
    else
        die "Docker was installed but systemd is not running, so the daemon cannot start. Enable systemd (docs/wsl.md) or use Docker Desktop."
    fi
fi

if mc_docker_is_desktop; then
    log "Using Docker Desktop. Game UDP ports are published from docker-compose.wsl.yml."
fi

docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)."

cd "${APP_DIR}"
if [[ -f .env ]]; then
    log "Existing .env found. Running an in-place upgrade so worlds, mods, and settings are kept."
    echo "Do not clone into a new directory to update. That can create new Docker volumes."
    exec "${APP_DIR}/scripts/upgrade.sh" --yes --mode docker
fi
if [[ ! -f .env ]]; then
    cp .env.example .env
    log "Created .env from .env.example. Edit it later if you need CONNECT_HOST or a different PORT."
fi

set -a
# shellcheck disable=SC1091
source "${APP_DIR}/.env"
set +a
export PORT="${PORT:-3000}"

mc_configure_firewall

if mc_is_wsl; then
    detected="$(mc_ensure_connect_host || true)"
    if [[ -n "${detected}" ]]; then
        log "Set CONNECT_HOST=${detected} (Windows LAN IPv4) so tiles are not a 172.x address."
        CONNECT_HOST="${detected}"
    fi
    hostname_set="$(mc_ensure_manager_hostname || true)"
    if [[ -n "${hostname_set}" ]]; then
        log "Set MANAGER_HOSTNAME=${hostname_set} so the sidebar matches this WSL distro."
    fi
fi

log "Building and starting the manager..."
compose_file="$(mc_compose_file)"
mc_ensure_compose_file_env "${compose_file}"
if [[ "$(basename "${compose_file}")" == "docker-compose.wsl.yml" ]]; then
    tz_set="$(mc_ensure_tz || true)"
    if [[ -n "${tz_set}" ]]; then
        log "Set TZ=${tz_set} (docker-compose.wsl.yml cannot mount /etc/localtime on Windows)."
    fi
fi
log "Compose file: ${compose_file}"
docker compose -f "${compose_file}" up -d --build

log "Install complete."
# shellcheck source=manager-urls.sh
source "${SCRIPT_DIR}/manager-urls.sh"
print_manager_connect_urls "${PORT:-3000}"
echo
echo "Data is stored in Docker volumes mc-data and mc-logs. Never run docker compose down -v."
echo "Later updates from this checkout: sudo ./scripts/upgrade.sh --yes"
