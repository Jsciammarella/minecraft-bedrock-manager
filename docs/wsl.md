# Ubuntu WSL (advanced)

Typical Windows desktops should use **Docker Desktop and PowerShell**. That path does not require opening Ubuntu. See [windows.md](windows.md).

Use this page only if you already run Ubuntu in WSL and want the Linux host-network install (same as a Ubuntu VM), including LAN Games when WSL networking is mirrored.

This manager is a Linux app. Minecraft Bedrock Dedicated Server is the official **Linux** zip. Do not install inside Docker Desktop's internal `docker-desktop` distro.

## Use Ubuntu, not `docker-desktop`

```powershell
wsl --install -d Ubuntu
wsl --set-default Ubuntu
wsl --shutdown
```

Open **Ubuntu** from the Start menu. In Docker Desktop: **Settings → Resources → WSL integration → enable Ubuntu** if you will use Desktop's engine from Ubuntu.

Clone into the Linux filesystem (`~/minecraft-bedrock-manager`), not `/mnt/c/...`.

## Which Docker in Ubuntu WSL?

| Setup | Compose file | What works |
| --- | --- | --- |
| **Docker Desktop** (WSL backend), install from Ubuntu | `docker-compose.wsl.yml` | Same published-port stack as [windows.md](windows.md). Prefer the PowerShell installer unless you already live in Ubuntu. |
| **Docker Engine in WSL** (`docker.io`) | `docker-compose.yml` | Same as a Linux VM **if** WSL uses [mirrored networking](https://learn.microsoft.com/windows/wsl/networking). LAN Games / Phantom broadcasts need that. |

`install-docker.sh` picks the compose file from the Docker it finds. Do not install `docker.io` next to Docker Desktop.

### Docker Engine inside WSL

Enable systemd in `/etc/wsl.conf`, then `wsl --shutdown` from Windows:

```ini
[boot]
systemd=true
```

Use **mirrored** networking in `.wslconfig` on Windows:

```ini
[wsl2]
networkingMode=mirrored
```

Then:

```bash
git clone https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git
cd minecraft-bedrock-manager
sudo bash scripts/install-docker.sh
```

UFW inside WSL does not control the Windows NIC. Open Windows Firewall with `scripts/configure-windows-firewall.ps1` as Administrator if the PowerShell installer was not used.

## Native install in WSL

`install-native.sh` works when systemd is enabled. Still open Windows Firewall and set `CONNECT_HOST` to the Windows LAN IPv4.

## Upgrade

```bash
sudo ./scripts/upgrade.sh --yes
```

Never `docker compose down -v`.
