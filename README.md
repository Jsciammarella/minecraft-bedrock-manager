# Minecraft Bedrock Server Manager

A one-stop self-hosted console for Minecraft Bedrock. One Linux host can run multiple dedicated servers, **forward play to a Bedrock server on another host** (LAN, Tailscale, or similar), keep add-ons and worlds in a library, let consoles join through [Bedrock Connect](https://github.com/Pugmatt/BedrockConnect), optionally rewrite featured-server DNS, and list games on the LAN — without a cloud panel.

> [!IMPORTANT]
> This application does not currently provide login or role-based access control. Keep it on a trusted LAN or behind an authenticated reverse proxy. Do not expose the management port or DNS port `53` to the internet.

Release development uses separate baseline, open-source, Pro, and Enterprise branches. See [docs/release-model.md](docs/release-model.md).

## Quick start

Target: **Ubuntu 24.04 x86-64**. You need `git` and `sudo`. Clone with HTTPS if you do not have SSH keys for the Git host.

### Docker (recommended)

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git && sudo bash minecraft-bedrock-manager/scripts/install-docker.sh
```

SSH clone instead: `GIT_LFS_SKIP_SMUDGE=1 git clone git@sci-gitlab-01.sciamfam.com:jamey/minecraft-bedrock-manager.git`.

The script installs Docker Compose if needed, creates `.env` from `.env.example`, adds UFW rules (it does **not** enable UFW), then runs `docker compose up -d --build`. Open `http://<this-host>:3000`.

### Native Ubuntu

```bash
sudo env GIT_LFS_SKIP_SMUDGE=1 git clone https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git /opt/mc-manager && sudo bash /opt/mc-manager/scripts/install-native.sh
```

The script installs Node.js **20.x**, build tools, Java, Git LFS, firewall rules, and a `mcmanager` systemd service for that checkout. Open `http://<this-host>:3000`.

### Windows

A native Windows x64 installer (no WSL, no Docker) lives on a separate packaging path and does **not** change the Linux Docker or native installers. The manager web UI is the same on Linux and Windows.

Download the latest `MinecraftBedrockManager-*.exe` from [GitHub Releases](https://github.com/Jsciammarella/minecraft-bedrock-manager/releases), or build it. The repository copy under [`dist/windows/`](dist/windows/) uses Git LFS. See [docs/windows-msi.md](docs/windows-msi.md).

### After install

- Create a Bedrock server from the dashboard. The tile shows **Building Server** while the official Linux zip downloads.
- Use the **Remote** toggle on Create Server to advertise a Bedrock world that already runs on another pingable host.
- Use **Bedrock Connect** on the dashboard if consoles need a custom server list, then open **BedrockConnect** in the sidebar for DNS instructions.
- Optional: **Mod Catalog → Settings** for CurseForge, a Git catalog, or a file catalog.
- Later updates: use `upgrade.sh` below. Never run `docker compose down -v`.

### Update (keep production data)

Do **not** re-run the install one-liner and do **not** clone into a new folder. A second clone can attach new Docker volumes and look like a blank install. Use the original checkout:

Docker, from the directory you cloned into:

```bash
sudo ./scripts/upgrade.sh --yes
```

Native:

```bash
sudo /opt/mc-manager/scripts/upgrade.sh --yes
```

`upgrade.sh` asks the manager to stop running Bedrock servers so worlds can save, copies data to `upgrade-backups/`, keeps at most **two** timestamped backups, fast-forwards git, adds any new `.env` keys without changing existing values, then rebuilds. Pass `--no-backup` to skip the copy. Docker uses `docker compose up -d --build` and never `down -v`. Native runs `npm ci`, rebuilds the UI, and restarts `mc-manager`. Start game servers again from the dashboard after the health check succeeds.

To test another branch or an exact release without recloning, pass `--branch` or `--tag`. The script fetches that ref, switches to it, then rebuilds. It will not force-reset a local branch that has diverged from origin. Backup and server shutdown happen before the checkout.

```bash
sudo ./scripts/upgrade.sh --branch release/0.2.1 --yes --mode docker
sudo ./scripts/upgrade.sh --tag v0.2.0 --yes --mode docker
```

If you re-run `install-docker.sh` or `install-native.sh` in that same checkout, they detect `.env` and hand off to `upgrade.sh` instead of treating it as a new install.

---

## A one-stop Bedrock host

Most home setups split this work across a dedicated-server zip, a DNS trick, a LAN proxy, and a folder of `.mcaddon` files. This manager keeps that in one UI, including a path most Bedrock panels do not offer: listing a world that is not running on this host.

- **PC and mobile** join with the tile address (`LAN-IPv4:game-port`).
- **Xbox, PlayStation, Windows, iOS, and Android** on the same LAN can also find a server under Friends → LAN Games when that server's LAN toggle is on.
- **Nintendo Switch** (and any console that cannot type `IP:port`) uses Bedrock Connect on UDP `19132`, optionally with this host as the console's only DNS server.
- **Another host's Bedrock server** can appear as a normal tile and LAN game on *this* machine. Players still connect here; UDP is forwarded to the remote IP and ports you configure.

Host firewall rules, not Docker port mappings, control access. Production Docker uses Linux **host networking** so each Bedrock process binds its UDP port on the Ubuntu host as soon as it starts. Adding a server does not require editing Compose or recreating the container.

## Capabilities

### Servers

Create as many Bedrock Dedicated Server instances as the host can run. Each one gets its own world, `server.properties`, allowlist, and live console. The dashboard refreshes about every five minutes; a server detail page refreshes about every minute.

Start, stop, restart immediately, or use a five-minute **warned restart** that announces in chat at five, two, and one minute. Installing add-ons or changing properties marks the server as restart-required.

Minecraft Bedrock Dedicated Server is licensed by Mojang/Microsoft and is **not** shipped in this repo. Creating a server downloads the official Linux zip in the background. Start and LAN stay locked until that finishes. If the download cannot be resolved, the tile stays offline with an error instead of a fake binary. `ALLOW_STUB_SERVER=1` is only for development.

The process is `bedrock_server` with `LD_LIBRARY_PATH=.`. In Docker, instance directories live in the `mc-data` volume at `/app/data/servers/<server-name>`.

Dashboard tiles show `version • IP:port` using this host's LAN IPv4 so consoles do not depend on home DNS. `CONNECT_HOST` is used only when it is already an IPv4. Hostnames are ignored. Docker bridge addresses such as `172.17.0.2` are not advertised. The sidebar shows the machine hostname.

Search, type filter (local or remote), and sort sit above the tiles.

### Remote servers

A remote server is a local UDP front door for a Bedrock Dedicated Server that already runs somewhere else — another PC on the LAN, a box on Tailscale, or any host this machine can ping. This manager does not start or stop that remote process. It listens on local ports here, advertises the world like a normal tile, and forwards RakNet traffic to the address you enter.

On **Create Server**, turn **Remote** on (to the right of the name). You set:

| Field | Meaning |
| --- | --- |
| Server name | Tile name on this manager |
| Local IPv4 / IPv6 ports | Where *this* host listens. **Not** UDP `19132` or `19133` — those stay free for LAN discovery and Bedrock Connect |
| Remote IP or hostname | The other Bedrock host (IPv4, IPv6, or a hostname such as a Tailscale name) |
| Remote IPv4 / IPv6 ports | The game ports on that host. Those *may* be `19132` / `19133` |

At most **10** remotes. Extra latency is expected: every packet takes an extra hop through this host, and a VPN adds more. Direct play to the other box will always feel snappier. The Xbox LAN path has been playable in practice.

Start and stop on the tile control the local forwarder, not Minecraft on the far side. If the remote Bedrock process is down, the LAN name can still appear and joins fail. Version, players, mods, gamemode, difficulty, auto-update, and created time show as N/A. Properties besides local ports and the remote host/ports stay disabled and **do not** reflect the real `server.properties` on the other machine.

With LAN listing on (the default for a new remote), consoles find it under Friends → LAN Games on this host. The game port on the tile is the local port, not `19132`. Remotes never use native LAN on `19132`. If Bedrock Connect is occupying `19132`, LAN listing pauses like any other server; PC and Bedrock Connect list joins still use the local game port.

Remotes appear in the Bedrock Connect in-game list with this host's LAN IPv4 and the local game port. They do not get a live console, mods, warned restarts, or player management.

An upgrade or restart should not require recreating a remote. Start it again from the dashboard after `upgrade.sh` finishes.

### Plugins

Drop-in folders can add their own sidebar items and pages. They cannot change Dashboard, server details, catalog, library, players, BedrockConnect, or ports. Copy a folder into `data/plugins/` and restart. See [docs/plugins.md](docs/plugins.md) and the [hello-world example](examples/plugins/hello-world).

### Players and access

Per-server allowlists, operator permissions, and bans. Scan running servers (Bedrock `list`) to pick up who is online. Allow and ban pickers can create a missing player when you type a name. Bans are enforced by the manager when it sees a join; Bedrock Dedicated Server does not ship a Java-style ban list file.

### Add-ons, worlds, and catalog

Upload `.mcpack`, `.mcaddon`, `.mcworld`, `.mctemplate`, `.mcstructure`, and `.zip` files into the mod library, then install them onto a server. Archives are extracted: behavior/resource packs go into the correct folders and world pack JSON is updated; worlds and templates replace `level-name`; structure files go into the world's `structures/` folder.

**Mod Catalog** can search CurseForge (an API key is recommended), an optional Git repository of packs, and optional local or network folders. Configure those on **Mod Catalog → Settings**. Git URL, branch, token, and Test stay disabled until **Enable Git catalog** is on. **Sync Now** stays disabled until the Git catalog is enabled and an access token has been saved. See [docs/git-mod-catalog.md](docs/git-mod-catalog.md) and [docs/file-mod-catalog.md](docs/file-mod-catalog.md).

### Ports

Bedrock needs a **distinct** IPv4 UDP port (`server-port`) and IPv6 UDP port (`server-portv6`). The same number for both, or a missing IPv6 port, prevents a correct bind. The manager keeps those numbers in separate ranges:

| Family | Game ranges | Notes |
| --- | --- | --- |
| IPv4 | `19132-19199`, `25565-25665`, `30000-30100` | UDP `19133` is not offered as an IPv4 game port |
| IPv6 | `18132-18199`, `24565-24665`, `29000-29100` | Each IPv4 range minus 1000 |
| LAN proxy | `19200-19299` | IPv4 only; not shown in the game-port dropdowns |
| DNS | TCP/UDP `53` | Optional Bedrock Connect DNS proxy |

New servers default to the next free IPv4 port. IPv6 defaults to 1000 below that IPv4 port when it is free. **Port Manager** can filter IPv4, IPv6, or all. Dropdowns combine the database with a live host UDP bind check so occupied ports are not offered.

You can change a regular server's ports on its Properties page. Changes apply on the next restart unless Bedrock Connect creation moved IPv4 `19132` immediately. Remote servers can change local and remote ports there, but they cannot take local `19132` or `19133`.

### Console LAN listing

Consoles look for LAN games by pinging UDP `19132` (and `19133` for IPv6). Current Bedrock Dedicated Server (1.26.30+) sends empty RakNet pongs unless `enable-lan-visibility=true`, so the manager leaves that on. To keep listing under the per-server **LAN** toggle, it occupies `19132`/`19133` while each dedicated server starts, then runs [Phantom](https://github.com/jhead/phantom) only for servers whose LAN toggle is on.

Direct joins still use the tile address (`LAN-IPv4:game-port`), for example `10.0.1.142:19134`, not `19132`. A **local** dedicated server whose game port is already `19132` is visible on the LAN without Phantom. Remote servers are never placed on `19132`, so they always use Phantom for console LAN listing. Nintendo Switch is **not** supported by this method.

Phantom (MIT) ships under `vendor/phantom/` (currently `v0.5.3`) and is copied into `data/phantom/` on first use. Proxied game traffic for a local dedicated server uses UDP `19200-19299`. A remote with LAN listing on reuses that remote's local game port as the Phantom bind port so Xbox and PC share one proxy. Several Phantom processes can share discovery on `19132`.

### Bedrock Connect

Consoles cannot add a custom Bedrock `IP:port`. [Bedrock Connect](https://github.com/Pugmatt/BedrockConnect) is a Java service that shows an in-game server list when the console is sent to this host on UDP `19132`. The manager can create **one** instance. The dashboard button greys out after it exists, and that tile stays first.

Bedrock Connect always uses UDP `19132` (IPv4) and `19133` (IPv6). If another managed server occupies `19132`, the manager asks you to move it (immediate restart or five-minute warned restart). The JAR is started as `java -jar BedrockConnect-1.0-SNAPSHOT.jar nodb=true port=19132 bindip=0.0.0.0 featured_servers=false custom_servers=custom_servers.json`. A current release is bundled under `vendor/bedrock-connect/` so first install does not need GitHub. The manager checks GitHub daily and can store newer JARs. Auto-update on the Properties page works the same as a normal server.

The in-game list is filled automatically from this manager: every dedicated server **and every remote** appears with this host's LAN IPv4 and that tile's local game port. Featured servers (Hive, Mineville, and the rest) are hidden because those redirects only land on Bedrock Connect itself. Creating, deleting, or changing a server's port rewrites `custom_servers.json` and restarts Bedrock Connect if it is running, so consoles see the new list. Players can still add extra addresses in the Bedrock Connect UI.

**Bedrock Connect and LAN listing cannot share `19132`/`19133` while Bedrock Connect is running.** Starting it stops every Phantom process. The dashboard header shows that LAN proxy is paused. A stopped or removed Bedrock Connect instance does not block LAN listing.

#### DNS proxy

After Bedrock Connect exists, the **BedrockConnect** sidebar page can enable a local DNS proxy on this host's LAN IPv4 port `53`. It:

- Answers up to **20** hostname overrides (usually featured-server names pointing at this host)
- Forwards every other lookup to the host resolver, or up to **three** upstream IPv4 DNS servers you enter
- Lists currently documented featured-server names (Hive, Mineville, Lifeboat, Galaxite, Enchanted). Those public addresses change; verify them before relying on a redirect. CubeCraft is omitted on purpose.

Set each console's **primary DNS only** to this host's LAN IPv4. Leave secondary/alternate DNS **empty** so the device cannot skip the overrides. The page includes Switch, Switch 2, PlayStation, Xbox, and PC steps.

**If consoles use this host as DNS, this manager must stay online, or those devices must be set back to automatic DNS. If this host goes offline and DNS is not reverted, those systems will not reach the internet.** Keep UDP/TCP `53` on the LAN only. Docker already runs as root so it can bind port `53`. Native systemd grants `CAP_NET_BIND_SERVICE` to `mcmanager`.

### Live console

Each server detail page has a live console capped at the last **200** lines, plus per-server command history. Bedrock Connect does not accept console commands.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | Runtime mode |
| `PORT` | `3000` | Web interface and API port |
| `CONNECT_HOST` | empty | Optional IPv4 shown as the Minecraft connect address; hostnames are ignored |
| `LOG_LEVEL` | `info` | Application logging level |
| `TZ` | unset | Leave unset to follow the host timezone (`/etc/localtime`). Set only to override |
| `AUTO_UPDATE_CHECK_INTERVAL` | `86400` | Update-check interval in seconds |
| `CURSEFORGE_API_KEY` | empty | Optional; can also be set in Catalog Settings |
| `GIT_CATALOG_*` | empty | Optional Git catalog; preferred configuration is **Mod Catalog → Settings** |
| `FILE_CATALOG_*` | empty | Optional file catalog (local / SMB / NFS); preferred configuration is **Mod Catalog → Settings** |

Never commit `.env`. Values saved in the UI override these environment variables.

The Docker image runs as root because it writes the data volume, copies Phantom, and spawns Bedrock, Java, and Phantom children on the host network. Native installs run as `mcmanager`. Docker Compose also starts `mc-curseforge-fetch`, a small Ubuntu 26.04 helper for CurseForge and MCPEDL URL imports. It listens on `127.0.0.1:37851` only.

Docker follows the host timezone via `/etc/localtime`. Do not set `TZ` in Compose unless you need to override the host.

## Everyday operation

```bash
docker compose logs -f mc-manager mc-curseforge-fetch   # follow manager and CurseForge fetch logs
docker compose restart mc-manager   # restart the manager
docker compose down                 # stop it without deleting data
sudo ./scripts/upgrade.sh --yes     # pull, rebuild, keep volumes and .env
```

Native:

```bash
sudo systemctl status mc-manager
sudo journalctl -u mc-manager -f
sudo ./scripts/upgrade.sh --yes --mode native
```

If a release adds UDP ranges or DNS `53`, rerun `sudo ./scripts/configure-ubuntu-firewall.sh`. The firewall script adds UFW rules but does not enable UFW, so you cannot lock yourself out of SSH by accident.

When upgrading an older **bridge-network** Docker deploy, run `docker compose down` (no `-v`) and `docker compose up -d --build` after the firewall rules so the container uses host networking. The named data volume is retained.

## Public API

There is no authentication. Treat these endpoints like the web UI: LAN-only or behind a proxy that you trust.

Base URL: `http://<this-host>:3000`

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Manager health, hostname, LAN IPv4 |
| `GET` | `/api/v1/health` | Same idea, plus process uptime |
| `GET` | `/api/v1/overview` | Every server: status, connect address, online players, uptime |
| `GET` | `/api/v1/server/:id` | One server's status and online players |

Example:

```bash
curl -sS "http://127.0.0.1:3000/api/health"
curl -sS "http://127.0.0.1:3000/api/v1/overview"
curl -sS "http://127.0.0.1:3000/api/v1/server/1"
```

`overview` and `server/:id` include `connectHost` and `connectAddress` (`LAN-IPv4:port`) so another app can show the same join string as the dashboard tiles. Online player names and XUIDs are included when the manager knows them.

The web UI also calls `/api/servers`, `/api/mods`, `/api/players`, `/api/ports`, and `/api/bedrock-connect`. Those are the same-origin control API (create, start, stop, catalog, DNS settings) and are equally unauthenticated. Live console output uses Socket.IO; that is not a documented integration API.

## Data and backups

Runtime state is not in Git:

| Path / volume | Contents |
| --- | --- |
| Docker `mc-data` or native `data/servers/` | SQLite, worlds, properties, binaries |
| `data/mods/` | Library packs and thumbnails |
| `data/git-catalog/` | Cloned Git catalog |
| `~/Minecraft Bedrock Manager/catalog/` (Windows: Public Documents) | Default local file catalog |
| `data/bedrock-connect/` | Runtime Bedrock Connect JAR archive |
| `data/phantom/` | Runtime Phantom binary |
| `data/plugins/` | User-installed plugin folders |
| `data/plugin-data/` | Private files for plugin backends |
| `data/logs/` | Application logs |
| `.env` | Local configuration |

Stop active servers before a consistent backup. Restore the whole data directory or Docker volume together. `scripts/upgrade.sh` copies data to `upgrade-backups/<timestamp>/` and keeps the two newest copies. Pass `--no-backup` to skip the copy.

## Known limitations

- No built-in authentication.
- CurseForge catalog is more reliable with an API key; a Git catalog or file catalog can be used instead or as well.
- Official Bedrock zip download can fail; the manager will not pretend a stub is a real server unless `ALLOW_STUB_SERVER=1`.
- Player bans are manager-enforced from observed connections.
- LAN listing does not support Nintendo Switch and cannot share UDP `19132`/`19133` with a **running** Bedrock Connect instance.
- Remote servers add a UDP hop (and VPN delay if you use one). They do not start the far-side Bedrock process, and they cannot bind local `19132`/`19133`. Cap is 10 remotes.
- Devices that use this host as DNS lose internet if the manager is offline and DNS is not set back to automatic.

## Build, develop, and fork

Fork or clone the repository, then use Node.js **20.x** (24 and newer are not supported).

```bash
git clone https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git
cd minecraft-bedrock-manager
cp .env.example .env
npm ci
npm --prefix frontend ci
npm run build
npm test
```

| Command | Purpose |
| --- | --- |
| `npm start` | Run the production server (`server/index.js`) |
| `npm run dev` | Backend with nodemon |
| `npm run frontend` | Vite UI on the frontend port |
| `npm test` | Smoke tests (`scripts/smoke-test.js`) |
| `docker compose -f docker-compose.dev.yml up --build` | Dev container with hot reload |

Production image: `docker compose up -d --build` (Linux host networking). The image includes Git, Git LFS, `unzip`, and a Java runtime for Bedrock Connect.

Native package set if you are not using `install-native.sh`: `python3`, `make`, `g++`, `git`, `git-lfs`, `wget`, `tar`, `unzip`, `default-jre-headless`, Node.js 20.

Windows MSI packaging (optional, Windows packager only): [docs/windows-msi.md](docs/windows-msi.md).

Keep runtime data, worlds, add-on packages, logs, and `.env` out of commits. See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues using [SECURITY.md](SECURITY.md), not a public issue.

No open-source license has been selected yet. Unless a license is added, the repository remains under the copyright holder's default rights.
