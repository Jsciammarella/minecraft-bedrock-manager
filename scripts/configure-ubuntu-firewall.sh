#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
    echo "Run this script with sudo." >&2
    exit 1
fi

MANAGER_PORT="${PORT:-3000}"
BEDROCK_RANGES=("18132:18199" "19132:19199" "19200:19299" "24565:24665" "25565:25665" "29000:29100" "30000:30100")

if ! [[ "${MANAGER_PORT}" =~ ^[0-9]+$ ]] || (( MANAGER_PORT < 1 || MANAGER_PORT > 65535 )); then
    echo "PORT must be a number between 1 and 65535." >&2
    exit 1
fi

if ! command -v ufw >/dev/null 2>&1; then
    echo "UFW is not installed. Install it with: sudo apt install ufw" >&2
    echo "Then rerun this script. It will not enable UFW automatically." >&2
    exit 1
fi

ufw allow "${MANAGER_PORT}/tcp" comment "Minecraft Manager web interface"
ufw allow 53/udp comment "Minecraft Manager Bedrock Connect DNS"
ufw allow 53/tcp comment "Minecraft Manager Bedrock Connect DNS"
for range in "${BEDROCK_RANGES[@]}"; do
    ufw allow "${range}/udp" comment "Minecraft Manager Bedrock servers"
done

echo
echo "Firewall rules added for TCP ${MANAGER_PORT}, DNS 53, and the manager's Bedrock UDP ranges."
if ufw status | grep -q "Status: inactive"; then
    echo "UFW is currently inactive. Review SSH access before enabling it with 'sudo ufw enable'."
else
    ufw status
fi
