#!/usr/bin/env bash
# ============================================
# Print LAN URLs for the manager web UI.
# Sourced by install-docker.sh, install-native.sh, and upgrade.sh.
# Never prints 127.0.0.1, localhost, or 0.0.0.0.
# ============================================

_manager_skip_iface() {
    case "$1" in
        lo|lo:*|docker*|br-*|veth*|cni*|flannel*|virbr*|tunl*|Loopback*) return 0 ;;
    esac
    return 1
}

_manager_is_usable_ipv4() {
    local ip="$1"
    local a b c d
    [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    IFS=. read -r a b c d <<<"$ip"
    if (( a > 255 || b > 255 || c > 255 || d > 255 )); then
        return 1
    fi
    if (( a == 127 || a == 0 )); then
        return 1
    fi
    if (( a == 169 && b == 254 )); then
        return 1
    fi
    return 0
}

_manager_score_ipv4() {
    local ip="$1"
    local a b
    IFS=. read -r a b _ _ <<<"$ip"
    if (( a == 192 && b == 168 )); then
        echo 100
    elif (( a == 10 )); then
        echo 90
    elif (( a == 172 && b == 17 )); then
        echo 1
    elif (( a == 172 && b >= 16 && b <= 31 )); then
        echo 40
    else
        echo 50
    fi
}

detect_manager_lan_ipv4() {
    local best_ip="" best_score=0
    local idx iface family cidr rest ip score
    if ! command -v ip >/dev/null 2>&1; then
        echo ""
        return 0
    fi
    while read -r idx iface family cidr rest; do
        iface="${iface%:}"
        ip="${cidr%%/*}"
        if _manager_skip_iface "$iface"; then
            continue
        fi
        if ! _manager_is_usable_ipv4 "$ip"; then
            continue
        fi
        score="$(_manager_score_ipv4 "$ip")"
        if (( score > best_score )); then
            best_score=$score
            best_ip=$ip
        fi
    done < <(ip -4 -o addr show scope global 2>/dev/null || true)
    if (( best_score <= 1 )); then
        echo ""
        return 0
    fi
    echo "$best_ip"
}

detect_manager_hostname() {
    local host
    host="$(hostname -s 2>/dev/null || true)"
    if [[ -z "$host" ]]; then
        host="$(hostname 2>/dev/null || true)"
        host="${host%%.*}"
    fi
    host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    case "$host" in
        ''|localhost|localhost.*|127.0.0.1|0.0.0.0)
            echo ""
            return 0
            ;;
    esac
    if _manager_is_usable_ipv4 "$host"; then
        echo ""
        return 0
    fi
    echo "$host"
}

# Print a FQDN only when the host has a real domain, not Ubuntu's
# localhost / *.localdomain placeholders from /etc/hosts.
detect_manager_fqdn() {
    local short="$1"
    local fqdn domain
    fqdn="$(hostname -f 2>/dev/null || true)"
    fqdn="$(printf '%s' "$fqdn" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    domain="$(dnsdomainname 2>/dev/null || true)"
    domain="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

    case "$fqdn" in
        ''|localhost|localhost.*|*.localdomain|*.local)
            echo ""
            return 0
            ;;
    esac
    if [[ "$fqdn" != *.* ]]; then
        echo ""
        return 0
    fi
    case "$domain" in
        ''|'(none)'|localdomain|local)
            echo ""
            return 0
            ;;
    esac
    if [[ -n "$short" && "$fqdn" == "$short" ]]; then
        echo ""
        return 0
    fi
    echo "$fqdn"
}

print_manager_connect_urls() {
    local port="${1:-${PORT:-3000}}"
    local host ip fqdn
    host="$(detect_manager_hostname)"
    ip="$(detect_manager_lan_ipv4)"
    fqdn="$(detect_manager_fqdn "$host")"

    echo
    echo "Connect to the manager using one of the following:"
    if [[ -n "$host" ]]; then
        echo "http://${host}:${port}"
    fi
    if [[ -n "$ip" ]]; then
        echo "http://${ip}:${port}"
    fi
    if [[ -n "$fqdn" && "$fqdn" != "$host" ]]; then
        echo "http://${fqdn}:${port}"
    fi
    if [[ -z "$host" && -z "$ip" && -z "$fqdn" ]]; then
        echo "http://<this-host-LAN-IP>:${port}"
        echo "Could not detect a hostname or LAN IPv4. Use this machine's network address, not 127.0.0.1."
    fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    print_manager_connect_urls "${1:-${PORT:-3000}}"
fi
