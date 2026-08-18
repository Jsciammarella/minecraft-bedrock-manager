#!/usr/bin/env bash
# WSL / Docker Desktop helpers. Sourced by install-docker.sh, install-native.sh,
# and upgrade.sh. Expects APP_DIR to be set.

mc_is_wsl() {
    if [[ -n "${MC_WSL:-}" ]]; then
        [[ "${MC_WSL}" == "1" ]]
        return
    fi
    grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null && return 0
    grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null && return 0
    return 1
}

mc_is_docker_desktop_distro() {
    local name=""
    name="$(hostname 2>/dev/null || true)"
    [[ "${name}" == "docker-desktop" ]] && return 0
    grep -qi 'docker-desktop' /etc/hostname 2>/dev/null && return 0
    if [[ -f /etc/os-release ]] && grep -qiE 'docker desktop|linuxkit' /etc/os-release; then
        return 0
    fi
    return 1
}

mc_systemd_running() {
    [[ -d /run/systemd/system ]] || return 1
    command -v systemctl >/dev/null 2>&1 || return 1
    systemctl is-system-running >/dev/null 2>&1 || true
    [[ -d /run/systemd/system ]]
}

mc_prepend_docker_cli_path() {
    command -v docker >/dev/null 2>&1 && return 0
    local extra="/mnt/wsl/docker-desktop/cli-tools/usr/bin"
    if [[ -x "${extra}/docker" ]]; then
        PATH="${extra}${PATH:+:$PATH}"
        export PATH
    fi
}

mc_docker_is_desktop() {
    command -v docker >/dev/null 2>&1 || return 1
    docker info 2>/dev/null | grep -qiE 'Operating System:.*Docker Desktop'
}

mc_docker_desktop_present() {
    mc_docker_is_desktop && return 0
    [[ -d /mnt/wsl/docker-desktop ]] && return 0
    return 1
}

# Docker Desktop on Windows cannot use Linux host networking. Publish the
# manager's UDP ranges instead so adding a server still does not require
# editing Compose.
mc_needs_published_ports() {
    mc_docker_is_desktop && return 0
    [[ -d /mnt/wsl/docker-desktop ]] && return 0
    return 1
}

mc_compose_file() {
    local host_file="${APP_DIR}/docker-compose.yml"
    local wsl_file="${APP_DIR}/docker-compose.wsl.yml"
    local mode=""
    if command -v docker >/dev/null 2>&1 && docker inspect mc-server-manager >/dev/null 2>&1; then
        mode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' mc-server-manager 2>/dev/null || true)"
        if [[ "${mode}" == "host" ]]; then
            echo "${host_file}"
            return 0
        fi
        if [[ -n "${mode}" ]]; then
            echo "${wsl_file}"
            return 0
        fi
    fi
    if mc_needs_published_ports && [[ -f "${wsl_file}" ]]; then
        echo "${wsl_file}"
        return 0
    fi
    echo "${host_file}"
}

mc_compose() {
    docker compose -f "$(mc_compose_file)" "$@"
}

mc_warn() {
    if declare -F warn >/dev/null 2>&1; then
        warn "$*"
    else
        echo "$*"
    fi
}

mc_log() {
    if declare -F log >/dev/null 2>&1; then
        log "$*"
    else
        echo "$*"
    fi
}

mc_powershell() {
    if command -v powershell.exe >/dev/null 2>&1; then
        command -v powershell.exe
        return 0
    fi
    local candidate="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    if [[ -x "${candidate}" ]]; then
        echo "${candidate}"
        return 0
    fi
    return 1
}

mc_windows_lan_ipv4() {
    local ps
    ps="$(mc_powershell || true)"
    [[ -n "${ps}" ]] || return 0
    local ip
    ip="$("${ps}" -NoProfile -NonInteractive -Command '
$addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
    $_.IPAddress -notlike "127.*" -and
    $_.IPAddress -notlike "169.254.*" -and
    $_.PrefixOrigin -ne "WellKnown" -and
    $_.IPAddress -notmatch "^172\.(1[6-9]|2[0-9]|3[0-1])\."
})
$ranked = $addrs | Sort-Object {
    if ($_.IPAddress -like "192.168.*") { 0 }
    elseif ($_.IPAddress -like "10.*") { 1 }
    else { 3 }
}
($ranked | Select-Object -First 1).IPAddress
' 2>/dev/null | tr -d "\r" | tail -1)"
    [[ "${ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 0
    echo "${ip}"
}

mc_env_set_key() {
    local envfile="${APP_DIR}/.env"
    local key="$1"
    local value="$2"
    [[ -f "${envfile}" ]] || return 0
    [[ -n "${key}" && -n "${value}" ]] || return 0
    if grep -qE "^${key}=" "${envfile}"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "${envfile}"
    else
        printf '\n%s=%s\n' "${key}" "${value}" >> "${envfile}"
    fi
}

mc_ensure_connect_host() {
    local envfile="${APP_DIR}/.env"
    [[ -f "${envfile}" ]] || return 0
    if grep -qE '^CONNECT_HOST=[0-9]' "${envfile}"; then
        return 0
    fi
    local ip=""
    ip="$(mc_windows_lan_ipv4 || true)"
    [[ -n "${ip}" ]] || return 0
    mc_env_set_key CONNECT_HOST "${ip}"
    echo "${ip}"
}

mc_ensure_manager_hostname() {
    local envfile="${APP_DIR}/.env"
    [[ -f "${envfile}" ]] || return 0
    if grep -qE '^MANAGER_HOSTNAME=[A-Za-z0-9]' "${envfile}"; then
        return 0
    fi
    local name=""
    name="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"
    name="$(printf '%s' "${name}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    case "${name}" in
        ''|localhost|localhost.*|127.0.0.1|mc-server-manager) return 0 ;;
    esac
    [[ "${name}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || return 0
    mc_env_set_key MANAGER_HOSTNAME "${name}"
    echo "${name}"
}

mc_ensure_tz() {
    local envfile="${APP_DIR}/.env"
    [[ -f "${envfile}" ]] || return 0
    if grep -qE '^TZ=[^[:space:]#]+' "${envfile}"; then
        return 0
    fi
    local tz=""
    if [[ -r /etc/timezone ]]; then
        tz="$(tr -d '[:space:]' < /etc/timezone || true)"
    fi
    if [[ -z "${tz}" ]] && command -v timedatectl >/dev/null 2>&1; then
        tz="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"
    fi
    [[ -n "${tz}" && "${tz}" != "n/a" ]] || return 0
    mc_env_set_key TZ "${tz}"
    echo "${tz}"
}

mc_ensure_compose_file_env() {
    local envfile="${APP_DIR}/.env"
    local chosen="$1"
    [[ -f "${envfile}" && -n "${chosen}" ]] || return 0
    local name
    name="$(basename "${chosen}")"
    [[ "${name}" == "docker-compose.wsl.yml" ]] || return 0
    mc_env_set_key COMPOSE_FILE "${name}"
}

mc_configure_firewall() {
    local skip="${SKIP_FIREWALL:-0}"
    local port="${PORT:-3000}"
    if [[ "${skip}" -eq 1 ]]; then
        mc_warn "Skipped firewall configuration."
        return 0
    fi
    if ! mc_is_wsl; then
        "${APP_DIR}/scripts/configure-ubuntu-firewall.sh"
        return 0
    fi
    mc_warn "UFW inside WSL does not control the Windows firewall."
    local win_script=""
    local ps_exe=""
    if command -v wslpath >/dev/null 2>&1; then
        win_script="$(wslpath -w "${APP_DIR}/scripts/configure-windows-firewall.ps1" || true)"
    fi
    ps_exe="$(mc_powershell || true)"
    if [[ -n "${ps_exe}" && -n "${win_script}" ]]; then
        "${ps_exe}" -NoProfile -ExecutionPolicy Bypass -File "${win_script}" -Port "${port}" \
            || mc_warn "Could not add Windows Firewall rules. Run scripts/configure-windows-firewall.ps1 as Administrator."
    else
        mc_warn "Run scripts/configure-windows-firewall.ps1 as Administrator on Windows."
    fi
}
