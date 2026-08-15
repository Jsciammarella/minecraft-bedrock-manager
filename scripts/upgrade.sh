#!/usr/bin/env bash
# ============================================
# In-place upgrade for Minecraft Bedrock Server Manager
# ============================================
# Pulls the latest application code and rebuilds the manager without deleting
# .env, Docker volumes, worlds, mods, catalog settings, or player data.
#
# Usage:
#   ./scripts/upgrade.sh
#   ./scripts/upgrade.sh --yes
#   ./scripts/upgrade.sh --skip-backup
#   ./scripts/upgrade.sh --mode docker|native
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_ROOT="${APP_DIR}/upgrade-backups"
ASSUME_YES=0
SKIP_BACKUP=0
MODE_OVERRIDE=""

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

usage() {
    cat <<'EOF'
Upgrade the Minecraft Bedrock Server Manager in place.

Preserved: .env, Docker volumes (mc-data, mc-logs), native data/, mods,
catalog settings, player records, allowlists, and worlds.

Not preserved across the restart: running Bedrock processes. Start them
again from the dashboard after the upgrade.

Options:
  --yes            Do not prompt for confirmation
  --skip-backup    Do not copy data to upgrade-backups/
  --mode docker    Force Docker Compose upgrade
  --mode native    Force native (systemd / Node) upgrade
  -h, --help       Show this help
EOF
}

log() { echo -e "${GREEN}$*${NC}"; }
warn() { echo -e "${YELLOW}$*${NC}"; }
die() { echo -e "${RED}$*${NC}" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes|-y) ASSUME_YES=1 ;;
        --skip-backup) SKIP_BACKUP=1 ;;
        --mode)
            MODE_OVERRIDE="${2:-}"
            [[ "$MODE_OVERRIDE" == "docker" || "$MODE_OVERRIDE" == "native" ]] \
                || die "--mode must be docker or native"
            shift
            ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown option: $1" ;;
    esac
    shift
done

cd "$APP_DIR"

[[ -f "$APP_DIR/docker-compose.yml" || -f "$APP_DIR/package.json" ]] \
    || die "Run this script from a Minecraft Bedrock Server Manager checkout."

command -v git >/dev/null 2>&1 || die "git is required."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "This directory is not a git checkout."

detect_mode() {
    if [[ -n "$MODE_OVERRIDE" ]]; then
        echo "$MODE_OVERRIDE"
        return
    fi

    local compose_running=0 systemd_active=0
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        if docker compose -f "$APP_DIR/docker-compose.yml" ps -q mc-manager 2>/dev/null | grep -q .; then
            compose_running=1
        fi
    fi
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet mc-manager 2>/dev/null; then
        systemd_active=1
    fi

    if (( compose_running )); then
        echo docker
    elif (( systemd_active )); then
        echo native
    elif [[ -f "$APP_DIR/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1; then
        echo docker
    else
        echo native
    fi
}

manager_port() {
    local port="3000"
    if [[ -f "$APP_DIR/.env" ]]; then
        local value
        value="$(grep -E '^PORT=' "$APP_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '[:space:]' | tr -d '"' | tr -d "'")"
        [[ -n "$value" ]] && port="$value"
    fi
    echo "$port"
}

confirm() {
    (( ASSUME_YES )) && return 0
    echo
    read -r -p "Continue with the in-place upgrade? [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]]
}

stop_managed_servers() {
    local port base
    port="$(manager_port)"
    base="http://127.0.0.1:${port}"
    if ! curl -sf --max-time 3 "${base}/api/health" >/dev/null 2>&1; then
        warn "Manager API is not reachable; Bedrock processes will stop when the manager restarts."
        return 0
    fi
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$base" <<'PY'
import json, sys, urllib.error, urllib.request

base = sys.argv[1]
try:
    with urllib.request.urlopen(base + "/api/servers", timeout=10) as response:
        servers = json.load(response)
except Exception as exc:
    print(f"Could not list servers: {exc}", file=sys.stderr)
    sys.exit(0)

for server in servers:
    if server.get("status") not in ("running", "starting"):
        continue
    name = server.get("name") or server.get("id")
    req = urllib.request.Request(f"{base}/api/servers/{server['id']}/stop", method="POST")
    try:
        urllib.request.urlopen(req, timeout=60).read()
        print(f"Stopped {name}")
    except urllib.error.HTTPError as exc:
        print(f"Could not stop {name}: HTTP {exc.code}", file=sys.stderr)
    except Exception as exc:
        print(f"Could not stop {name}: {exc}", file=sys.stderr)
PY
        sleep 2
    else
        warn "python3 is not available; skipping graceful Bedrock stop."
    fi
}

backup_native() {
    local dest="$1"
    mkdir -p "$dest" || return 1
    [[ -f "$APP_DIR/.env" ]] && cp -a "$APP_DIR/.env" "$dest/env"
    if [[ -d "$APP_DIR/data" ]]; then
        cp -a "$APP_DIR/data" "$dest/data" || return 1
    fi
}

backup_docker() {
    local dest="$1"
    mkdir -p "$dest" || return 1
    [[ -f "$APP_DIR/.env" ]] && cp -a "$APP_DIR/.env" "$dest/env"
    if docker compose -f "$APP_DIR/docker-compose.yml" ps -aq mc-manager 2>/dev/null | grep -q .; then
        docker compose -f "$APP_DIR/docker-compose.yml" cp mc-manager:/app/data "$dest/data" || return 1
        return 0
    fi
    local volume
    volume="$(docker volume ls -q | grep -E '_mc-data$' | head -1 || true)"
    if [[ -n "$volume" ]]; then
        docker run --rm \
            -v "${volume}:/data:ro" \
            -v "${dest}:/backup" \
            alpine:3.20 \
            sh -c "cp -a /data /backup/data" || return 1
        return 0
    fi
    warn "No running manager container or mc-data volume found; skipped data copy."
}

merge_new_env_keys() {
    local example="$APP_DIR/.env.example"
    local envfile="$APP_DIR/.env"
    [[ -f "$example" && -f "$envfile" ]] || return 0
    local added=0 line key
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[A-Z_][A-Z0-9_]*= ]] || continue
        key="${line%%=*}"
        if grep -qE "^${key}=" "$envfile"; then
            continue
        fi
        printf '\n%s\n' "$line" >> "$envfile"
        warn "Added new .env key ${key} from .env.example (existing values were not changed)."
        added=1
    done < "$example"
    (( added )) || true
}

wait_for_health() {
    local port base i
    port="$(manager_port)"
    base="http://127.0.0.1:${port}"
    for i in $(seq 1 30); do
        if curl -sf --max-time 3 "${base}/api/health" >/dev/null 2>&1; then
            log "Manager is healthy at ${base}"
            return 0
        fi
        sleep 2
    done
    warn "Timed out waiting for ${base}/api/health. Check logs."
    return 1
}

MODE="$(detect_mode)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/${STAMP}"

echo
log "Minecraft Bedrock Server Manager in-place upgrade"
echo "Install directory: $APP_DIR"
echo "Detected mode:     $MODE"
echo
echo "This keeps:"
echo "  - .env"
echo "  - Docker volumes mc-data and mc-logs (Docker installs)"
echo "  - data/ worlds, SQLite, mods, Git catalog clone, and player files (native installs)"
echo
echo "This will:"
echo "  - git pull --ff-only the current branch"
echo "  - rebuild and restart the manager"
echo "  - stop running Bedrock servers for the restart (start them again from the dashboard)"
if (( SKIP_BACKUP )); then
    echo "  - skip the local backup copy"
else
    echo "  - copy current data to ${BACKUP_DIR}"
fi
echo
echo "This will not:"
echo "  - run docker compose down -v"
echo "  - delete named volumes or data/"
echo "  - overwrite existing .env values"

confirm || die "Upgrade cancelled."

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    git status --porcelain --untracked-files=no
    die "Tracked files have local changes. Commit, stash, or revert them, then rerun."
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" != "HEAD" ]] || die "Checkout is in a detached HEAD state. Check out a branch such as main."

log "Stopping managed Bedrock servers (if the API is up)..."
stop_managed_servers || true

if (( ! SKIP_BACKUP )); then
    log "Backing up configuration and data to ${BACKUP_DIR}"
    mkdir -p "$BACKUP_DIR"
    if [[ "$MODE" == "docker" ]]; then
        backup_docker "$BACKUP_DIR" || die "Backup failed; upgrade aborted so application files were not changed."
    else
        backup_native "$BACKUP_DIR" || die "Backup failed; upgrade aborted so application files were not changed."
    fi
    log "Backup complete."
fi

log "Fetching ${BRANCH}..."
git fetch origin "$BRANCH"
git pull --ff-only origin "$BRANCH"

merge_new_env_keys

if [[ "$MODE" == "docker" ]]; then
    command -v docker >/dev/null 2>&1 || die "docker is required for a Docker upgrade."
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
    log "Rebuilding and recreating the manager container (volumes are left in place)..."
    docker compose -f "$APP_DIR/docker-compose.yml" up -d --build
else
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files mc-manager.service >/dev/null 2>&1; then
        log "Stopping mc-manager.service..."
        sudo systemctl stop mc-manager || true
    fi
    command -v node >/dev/null 2>&1 || die "Node.js 20.x is required for a native upgrade."
    log "Installing dependencies and rebuilding the UI..."
    npm ci
    npm --prefix frontend ci
    npm run build
    if [[ -f /etc/systemd/system/mc-manager.service ]]; then
        sudo cp "$APP_DIR/scripts/mc-manager.service" /etc/systemd/system/mc-manager.service
        sudo systemctl daemon-reload
        log "Starting mc-manager.service..."
        sudo systemctl start mc-manager
    else
        warn "systemd unit not installed. Start the manager with ./scripts/start.sh"
    fi
fi

wait_for_health || true

echo
log "Upgrade finished."
echo "Start Bedrock servers from the dashboard if they were running before the upgrade."
if (( ! SKIP_BACKUP )); then
    echo "Backup kept at: $BACKUP_DIR"
fi
echo "Remove old copies under upgrade-backups/ when you no longer need them."
