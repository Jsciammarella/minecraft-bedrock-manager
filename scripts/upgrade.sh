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
#   ./scripts/upgrade.sh --no-backup
#   ./scripts/upgrade.sh --mode docker|native
#   ./scripts/upgrade.sh --branch release/0.2.1 --yes --mode docker
#   ./scripts/upgrade.sh --tag v0.2.0 --yes --mode docker
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=manager-urls.sh
source "${SCRIPT_DIR}/manager-urls.sh"
BACKUP_ROOT="${APP_DIR}/upgrade-backups"
KEEP_UPGRADE_BACKUPS=2
ASSUME_YES=0
SKIP_BACKUP=0
RESUME=0
MODE_OVERRIDE=""
TARGET_BRANCH=""
TARGET_TAG=""

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
  --no-backup      Do not copy data to upgrade-backups/
  --skip-backup    Same as --no-backup
  --mode docker    Force Docker Compose upgrade
  --mode native    Force native (systemd / Node) upgrade
  --branch NAME    Fetch and check out a remote branch (for testing)
  --tag NAME       Fetch and check out a release tag (detached HEAD)
  -h, --help       Show this help
EOF
}

log() { echo -e "${GREEN}$*${NC}"; }
warn() { echo -e "${YELLOW}$*${NC}"; }
die() { echo -e "${RED}$*${NC}" >&2; exit 1; }

# Reject option-like names, path tricks, and shell metacharacters so the
# value can be interpolated into git refspecs.
validate_git_ref() {
    local kind="$1"
    local ref="$2"
    [[ -n "${ref}" ]] || die "--${kind} requires a value."
    if [[ "${ref}" == -* ]]; then
        die "--${kind} '${ref}' must not start with a dash."
    fi
    case "${ref}" in
        HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD)
            die "--${kind} '${ref}' is not a valid ${kind} name."
            ;;
    esac
    if [[ ! "${ref}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
        die "--${kind} '${ref}' contains invalid characters."
    fi
    if [[ "${ref}" == *..* || "${ref}" == *//* || "${ref}" == */ || "${ref}" == *. ]]; then
        die "--${kind} '${ref}' is not a valid ${kind} name."
    fi
    if [[ "${ref}" == refs/* ]]; then
        die "--${kind} '${ref}' must be a ${kind} name, not a raw refs/ path."
    fi
}

require_origin() {
    git remote get-url origin >/dev/null 2>&1 \
        || die "The origin remote is required so this checkout can fetch updates."
}

current_branch_or_die() {
    local name
    name="$(git rev-parse --abbrev-ref HEAD)"
    [[ "${name}" != "HEAD" ]] \
        || die "Checkout is in a detached HEAD state. Check out a branch such as main, or pass --branch or --tag."
    echo "${name}"
}

describe_checkout() {
    local name
    name="$(git rev-parse --abbrev-ref HEAD)"
    if [[ "${name}" != "HEAD" ]]; then
        echo "${name}"
        return 0
    fi
    git describe --tags --exact-match 2>/dev/null \
        || git rev-parse --short HEAD
}

# Fast-forward or create the local branch. Never force-reset a diverged branch.
ensure_local_branch() {
    local name="$1"
    local local_sha remote_sha current
    git show-ref --verify --quiet "refs/remotes/origin/${name}" \
        || die "origin/${name} was not fetched. The remote branch may not exist."
    remote_sha="$(git rev-parse "refs/remotes/origin/${name}")"
    if ! git show-ref --verify --quiet "refs/heads/${name}"; then
        git branch --track "${name}" "origin/${name}"
        log "Created local branch ${name} tracking origin/${name}."
        return 0
    fi
    local_sha="$(git rev-parse "refs/heads/${name}")"
    if [[ "${local_sha}" == "${remote_sha}" ]]; then
        return 0
    fi
    if git merge-base --is-ancestor "${local_sha}" "${remote_sha}"; then
        current="$(git rev-parse --abbrev-ref HEAD)"
        if [[ "${current}" == "${name}" ]]; then
            git merge --ff-only "origin/${name}"
        else
            git update-ref "refs/heads/${name}" "${remote_sha}" "${local_sha}"
        fi
        log "Fast-forwarded local ${name} to origin/${name}."
        return 0
    fi
    if git merge-base --is-ancestor "${remote_sha}" "${local_sha}"; then
        die "Local branch ${name} is ahead of origin/${name}. Push or move those commits before upgrading."
    fi
    die "Local branch ${name} has diverged from origin/${name}. Refusing to overwrite local commits."
}

fetch_and_checkout_branch() {
    local name="$1"
    log "Fetching origin/${name}..."
    git fetch origin "refs/heads/${name}:refs/remotes/origin/${name}" \
        || die "Could not fetch branch '${name}' from origin."
    ensure_local_branch "${name}"
    git checkout "${name}"
}

fetch_and_checkout_tag() {
    local name="$1"
    log "Fetching tag ${name}..."
    if git show-ref --verify --quiet "refs/tags/${name}"; then
        if ! git fetch origin "refs/tags/${name}:refs/tags/${name}"; then
            die "Local tag ${name} exists and differs from origin. Refusing to move an existing tag."
        fi
    else
        git fetch origin "refs/tags/${name}:refs/tags/${name}" \
            || die "Could not fetch tag '${name}' from origin."
    fi
    git checkout --detach "refs/tags/${name}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes|-y) ASSUME_YES=1 ;;
        --no-backup|--skip-backup) SKIP_BACKUP=1 ;;
        --resume) RESUME=1 ;;
        --mode)
            MODE_OVERRIDE="${2:-}"
            [[ "$MODE_OVERRIDE" == "docker" || "$MODE_OVERRIDE" == "native" ]] \
                || die "--mode must be docker or native"
            shift
            ;;
        --branch)
            TARGET_BRANCH="${2:-}"
            validate_git_ref branch "${TARGET_BRANCH}"
            shift
            ;;
        --tag)
            TARGET_TAG="${2:-}"
            validate_git_ref tag "${TARGET_TAG}"
            shift
            ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown option: $1" ;;
    esac
    shift
done

if [[ -n "${TARGET_BRANCH}" && -n "${TARGET_TAG}" ]]; then
    die "Use --branch or --tag, not both."
fi

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

# Keep only the newest timestamped backup directories (YYYYMMDD-HHMMSS).
prune_upgrade_backups() {
    local keep="${KEEP_UPGRADE_BACKUPS}"
    [[ -d "${BACKUP_ROOT}" ]] || return 0
    local dir count=0
    while IFS= read -r dir; do
        [[ -n "${dir}" && -d "${dir}" ]] || continue
        count=$((count + 1))
        if (( count > keep )); then
            log "Removing old upgrade backup $(basename "${dir}")"
            rm -rf "${dir}"
        fi
    done < <(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d \
        -name '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]' \
        | sort -r)
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
            log "Manager is healthy."
            return 0
        fi
        sleep 2
    done
    warn "Timed out waiting for the manager health check. Check logs."
    return 1
}

MODE="$(detect_mode)"

if (( RESUME )); then
    BACKUP_DIR="${MC_UPGRADE_BACKUP_DIR:-}"
    log "Continuing upgrade with the scripts from $(describe_checkout)..."
else
    require_origin
    if [[ -z "${TARGET_BRANCH}" && -z "${TARGET_TAG}" ]]; then
        TARGET_BRANCH="$(current_branch_or_die)"
    fi

    STAMP="$(date +%Y%m%d-%H%M%S)"
    BACKUP_DIR="${BACKUP_ROOT}/${STAMP}"

    echo
    log "Minecraft Bedrock Server Manager in-place upgrade"
    echo "Install directory: $APP_DIR"
    echo "Detected mode:     $MODE"
    if [[ -n "${TARGET_TAG}" ]]; then
        echo "Target:            tag ${TARGET_TAG}"
    else
        echo "Target:            branch ${TARGET_BRANCH}"
    fi
    echo
    echo "This keeps:"
    echo "  - .env"
    echo "  - Docker volumes mc-data and mc-logs (Docker installs)"
    echo "  - data/ worlds, SQLite, mods, Git catalog clone, and player files (native installs)"
    echo
    echo "This will:"
    if [[ -n "${TARGET_TAG}" ]]; then
        echo "  - fetch tag ${TARGET_TAG} and check it out (detached HEAD)"
    else
        echo "  - fetch and check out branch ${TARGET_BRANCH}"
    fi
    echo "  - rebuild and restart the manager"
    echo "  - stop running Bedrock servers for the restart (start them again from the dashboard)"
    if (( SKIP_BACKUP )); then
        echo "  - skip the local backup copy"
    else
        echo "  - copy current data to ${BACKUP_DIR}"
    fi
    echo "  - keep at most ${KEEP_UPGRADE_BACKUPS} timestamped copies under upgrade-backups/"
    echo
    echo "This will not:"
    echo "  - run docker compose down -v"
    echo "  - delete named volumes or data/"
    echo "  - overwrite existing .env values"
    echo "  - force-reset a local branch that has diverged from origin"

    confirm || die "Upgrade cancelled."

    if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
        git status --porcelain --untracked-files=no
        die "Tracked files have local changes. Commit, stash, or revert them, then rerun."
    fi

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
    else
        BACKUP_DIR=""
    fi
    prune_upgrade_backups

    if [[ -n "${TARGET_TAG}" ]]; then
        fetch_and_checkout_tag "${TARGET_TAG}"
    else
        fetch_and_checkout_branch "${TARGET_BRANCH}"
    fi

    log "Reloading the upgrade script so the messages match this checkout..."
    resume_cmd=(bash "$APP_DIR/scripts/upgrade.sh" --yes --resume --skip-backup)
    if [[ -n "$MODE_OVERRIDE" ]]; then
        resume_cmd+=(--mode "$MODE_OVERRIDE")
    fi
    export MC_UPGRADE_BACKUP_DIR="${BACKUP_DIR}"
    exec "${resume_cmd[@]}"
fi

# shellcheck source=manager-urls.sh
source "${SCRIPT_DIR}/manager-urls.sh"

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
print_manager_connect_urls "$(manager_port)"
echo
echo "Start Bedrock servers from the dashboard if they were running before the upgrade."
if [[ -n "${BACKUP_DIR:-}" ]]; then
    echo "Backup kept at: $BACKUP_DIR"
    echo "At most ${KEEP_UPGRADE_BACKUPS} timestamped copies are kept under upgrade-backups/."
fi
