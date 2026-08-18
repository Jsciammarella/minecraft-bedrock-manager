# Windows (Docker Desktop)

Most people should install this on Windows with **Docker Desktop** and a PowerShell one-liner. You do not need to open Ubuntu or learn WSL. Docker Desktop uses a Linux engine in the background; the manager and Minecraft Bedrock Dedicated Server still run as Linux containers.

There is no `setup.exe`. An unsigned installer would trigger Windows SmartScreen warnings, and a signed one needs a code-signing certificate this project does not ship. The PowerShell script after `git clone` is the supported Windows install, same idea as the Linux bash one-liner.

## Prerequisites

1. **[Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)** — install it, start it, and leave it on **Linux containers** (the default). Wait until the whale icon says Docker is running.
2. **[Git for Windows](https://git-scm.com/downloads/win)** — needed for the clone one-liner.

Windows containers cannot run this app. If Docker Desktop was switched to Windows containers, switch back to Linux containers first.

## Install

In **PowerShell** (Administrator if you want the script to open Windows Firewall automatically):

```powershell
git clone https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git; powershell -ExecutionPolicy Bypass -File .\minecraft-bedrock-manager\scripts\install-docker.ps1
```

That script copies `.env`, sets `CONNECT_HOST` to this PC's LAN IPv4, sets `TZ` from Windows, writes `COMPOSE_FILE=docker-compose.wsl.yml`, tries to add firewall rules, then runs `docker compose up -d --build`. The first build can take several minutes.

Open `http://localhost:3000`.

`-ExecutionPolicy Bypass` applies only to that run. It does not permanently change your PC's script policy.

If Windows blocked the script because it came from the internet (zip download), unblock it once:

```powershell
Unblock-File .\scripts\install-docker.ps1
```

## Update

From the same folder you cloned into (do not clone a second copy):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upgrade.ps1 -Yes
```

Never run `docker compose down -v`. That deletes worlds and the mod library.

## Everyday commands

Run these in the checkout folder. `.env` points Compose at `docker-compose.wsl.yml`.

```powershell
docker compose logs -f mc-manager mc-curseforge-fetch
docker compose restart mc-manager
docker compose down
```

## What works on Docker Desktop

- Web UI, creating servers, mods, CurseForge/MCPEDL URL import
- Joining with the tile address (`LAN-IP:game-port`)
- Bedrock Connect as a unicast list on UDP `19132` (if that port is free)

**LAN Games** (UDP broadcast) often does not leave Docker Desktop. Join with the tile address instead. DNS port `53` is not published; Windows commonly already owns it.

If tiles show a `172.x` address, set `CONNECT_HOST` in `.env` to this PC's IPv4 (for example `192.168.1.50`) and recreate: `docker compose up -d`.

## Advanced: Ubuntu WSL

If you already use Ubuntu in WSL and want Linux host networking (closer to a real Ubuntu host, including LAN listing when WSL networking is mirrored), see [wsl.md](wsl.md). That path is optional. Typical Windows desktops should stay on this Docker Desktop flow.
