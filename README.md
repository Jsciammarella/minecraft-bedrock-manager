# Minecraft Bedrock Server Manager

A self-hosted web console for creating and operating multiple Minecraft Bedrock Dedicated Server instances from one dashboard.

## What it provides

- Server creation with an available-port selector
- Start, stop, immediate restart, and five-minute warned restart controls
- A server-specific live console with per-server command history
- Per-server allowlists, player permissions, and ban lists
- Bedrock add-on upload, installation, removal, and restart-required notices
- Mod catalog with CurseForge and an optional Git repository source
- Editable `server.properties`
- Dashboard status refresh every five minutes and server-detail refresh every minute
- Persistent SQLite configuration and server data

> [!IMPORTANT]
> This application does not currently provide login or role-based access control. Keep it on a trusted network or put it behind an authenticated reverse proxy. Do not expose the management port directly to the internet.

## Requirements

The recommended installation uses Docker:

- A Linux x86-64 host (Ubuntu 24.04 is the primary target)
- Docker Engine 24 or newer with Docker Compose v2
- At least 2 GB RAM, plus memory required by each Bedrock server
- TCP access to the management port (default `3000`)
- Host firewall access to the Bedrock UDP ranges used by the port selector (`19132-19199`, `25565-25665`, and `30000-30100`)

The production image already includes Git and Git LFS for the optional Git mod catalog.

For a native installation:

- Node.js **20.x** (the app is tested on 20; 24 and newer are not supported)
- Python 3, `make`, and a C++ compiler (`g++`) for native modules such as `better-sqlite3` and `node-pty`
- `git` for cloning and for the Git catalog; `git-lfs` if that catalog stores packs or thumbnails in Git LFS
- `wget` and `tar` if you want the manager to attempt Bedrock binary downloads

## Install with Docker (recommended)

1. Clone the repository and enter it:

   ```bash
   git clone git@sci-gitlab-01.sciamfam.com:jamey/minecraft-bedrock-manager.git
   cd minecraft-bedrock-manager
   ```

   If you do not have SSH access to the Git host, use HTTPS instead:

   ```bash
   git clone https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git
   cd minecraft-bedrock-manager
   ```

2. Create your local configuration:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` as needed:

   | Setting | When to change it |
   | --- | --- |
   | `TZ` | Host timezone, for example `America/Denver` |
   | `PORT` | Web UI port if `3000` is already in use |
   | `CONNECT_HOST` | LAN IP or DNS name players should use. Leave empty on Linux host networking to auto-detect. Set it on Docker Desktop / bridge networks so tiles do not show a container IP |
   | `CURSEFORGE_API_KEY` | Optional. You can also paste this later in **Mod Catalog → Settings** |
   | `GIT_CATALOG_*` | Optional. Preferred configuration is **Mod Catalog → Settings** |

3. Configure the Ubuntu host firewall for the web interface and all ports offered by the server-creation dropdown:

   ```bash
   sudo ./scripts/configure-ubuntu-firewall.sh
   ```

   The script adds UFW rules but deliberately does not enable UFW, because enabling it without an SSH rule could lock you out. If UFW is not installed, install it with `sudo apt install ufw` or create equivalent rules on your firewall.

4. Build and start the manager:

   ```bash
   docker compose up -d --build
   ```

5. Confirm it is healthy, then open the UI:

   ```bash
   docker compose ps
   docker compose logs -f mc-manager
   ```

   Browse to `http://<server-address>:3000`.

6. First-run checks in the UI:

   - Create a Bedrock server from the dashboard
   - Open **Mod Catalog → Settings** if you want CurseForge or a Git catalog
   - Confirm each server tile shows the address players should use (`version • IP:port`)

Application data is stored in the `mc-data` Docker volume and survives container replacement. Back up this volume before upgrades.

The production Compose file uses Linux host networking. Each Bedrock process therefore binds its selected UDP port directly on the host as soon as the server starts; adding a server does not require editing Compose or recreating the manager container. Host networking is intentional and is supported by the documented Linux deployment target. Firewall rules, not Docker port mappings, control external access.

Dashboard tiles show `version • IP:port` using, in order: `CONNECT_HOST`, the hostname from the browser request (when it is not localhost), then a detected LAN IPv4. Docker bridge addresses such as `172.17.0.2` are not advertised. On Linux host networking and on a native install, auto-detection normally finds the host LAN IP. Docker Desktop and other bridge-network setups should set `CONNECT_HOST` to the host's LAN IP or DNS name.

When upgrading an older bridge-network deployment, run `docker compose down` followed by `docker compose up -d --build` after adding the firewall rules. This recreates only the manager container; the named data volume is retained.

### Bedrock Dedicated Server binary

Minecraft Bedrock Dedicated Server is licensed and distributed separately by Mojang/Microsoft, so it is not included in this repository or image. Server creation attempts to provision it; if the official download cannot be resolved, the manager creates a development stub so the UI can still be tested.

For a real server, download the current Linux Bedrock Dedicated Server from the [official Minecraft server download page](https://www.minecraft.net/en-us/download/server/bedrock), stop the instance, and place the extracted files in that instance's data directory. The executable must be named `bedrock_server`, be executable, and be owned by the account running the manager. In Docker, the instance directories are inside the `mc-data` volume at `/app/data/servers/<server-name>`.

## Native Ubuntu installation

1. Install Node.js 20 and build prerequisites:

   ```bash
   sudo apt update
   sudo apt install -y ca-certificates curl python3 make g++ wget tar git git-lfs ufw
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   sudo git lfs install --system
   ```

   Confirm `node -v` reports v20.x.

2. Clone the repository, install locked dependencies, and build the UI. The backend serves the built files from `public/`.

   ```bash
   sudo mkdir -p /opt/mc-manager
   sudo git clone git@sci-gitlab-01.sciamfam.com:jamey/minecraft-bedrock-manager.git /opt/mc-manager
   cd /opt/mc-manager
   cp .env.example .env
   npm ci
   npm --prefix frontend ci
   npm run build
   ```

   Use the HTTPS clone URL if SSH is not configured: `https://sci-gitlab-01.sciamfam.com/jamey/minecraft-bedrock-manager.git`.

3. Add firewall rules for the management interface and all UDP ports offered in the server dropdown:

   ```bash
   sudo ./scripts/configure-ubuntu-firewall.sh
   ```

   If UFW is inactive, review and allow SSH access before enabling it. If the host uses another firewall, create equivalent rules for TCP `3000` and UDP `19132:19199`, `25565:25665`, and `30000:30100`.

4. Start it interactively for an initial check:

   ```bash
   ./scripts/start.sh
   ```

   Then browse to `http://<server-address>:3000`. If you cloned with `sudo`, either run `sudo ./scripts/start.sh` for this check or continue to the systemd service below.

5. For a persistent service, create a dedicated user, install the unit, and start it:

   ```bash
   sudo useradd --system --home /opt/mc-manager --shell /usr/sbin/nologin mcmanager
   sudo chown -R mcmanager:mcmanager /opt/mc-manager
   sudo cp scripts/mc-manager.service /etc/systemd/system/mc-manager.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now mc-manager
   sudo systemctl status mc-manager
   ```

   Review `scripts/mc-manager.service` before copying it if your install path, Node binary, or user differs. The unit loads `/opt/mc-manager/.env`, so that file must exist.

On a native install there is no separate publishing step: every managed Bedrock process binds its configured UDP port directly on the Ubuntu host. The firewall rules above cover every port that the manager offers. Server creation also checks that the selected UDP port is not already bound by another process.

The available-port dropdown combines the manager database with a live host UDP bind check. Ports assigned to another managed server or occupied by another host process are not offered, and availability is checked again during creation to prevent races.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | Runtime mode |
| `PORT` | `3000` | Web interface and API port |
| `CONNECT_HOST` | empty | Hostname or IP shown as the Minecraft connect address; auto-detected when empty |
| `LOG_LEVEL` | `info` | Application logging level |
| `TZ` | `UTC` | Container timezone |
| `AUTO_UPDATE_CHECK_INTERVAL` | `86400` | Update-check interval in seconds |
| `CURSEFORGE_API_KEY` | empty | Optional CurseForge API credential; can also be set in Catalog Settings |
| `GIT_CATALOG_ENABLED` | empty | Optional Git catalog enable flag when no UI value exists |
| `GIT_CATALOG_URL` | empty | Optional Git catalog clone URL |
| `GIT_CATALOG_BRANCH` | `main` | Git catalog branch |
| `GIT_CATALOG_USERNAME` | empty | Optional HTTPS username for the Git catalog |
| `GIT_CATALOG_TOKEN` | empty | Optional Git access token for private catalogs |
| `GIT_CATALOG_SUBDIR` | empty | Optional subdirectory that contains catalog files |
| `GIT_CATALOG_SYNC_HOURS` | `2` | How often the Git catalog is pulled in the background |

Never commit `.env`; it is intentionally ignored.

The Mod Catalog settings page (gear icon on **Mod Catalog**) is the preferred place to add a CurseForge API key and a Git catalog repository. Values saved there override these environment variables. See [docs/git-mod-catalog.md](docs/git-mod-catalog.md) for the repository layout. The Docker image includes `git` and `git-lfs`; a native host needs those packages if you enable a Git catalog.

## Everyday operation

```bash
docker compose logs -f mc-manager   # follow manager logs
docker compose restart mc-manager   # restart the manager
docker compose down                 # stop it without deleting data
docker compose up -d --build        # rebuild after an application update
```

Installing or removing add-ons and changing server properties can require a Bedrock server restart. The UI marks the affected server and offers either an immediate restart or a warned restart that sends player messages at five, two, and one minute.

## Development and verification

```bash
npm ci
npm --prefix frontend ci
npm run build
npm test
```

For hot reload, use `docker compose -f docker-compose.dev.yml up --build` or run the backend and frontend development commands in separate terminals.

## Data and backups

Runtime state is intentionally excluded from Git. It includes:

- `data/servers/` — server binaries, worlds, properties, and SQLite data
- `data/mods/` — manager-level add-on packages
- `data/mods/thumbs/` — library thumbnail images
- `data/git-catalog/` — cloned Git catalog repository
- `data/uploads/` — temporary uploads
- `data/logs/` — application logs

Stop active servers before taking a consistent backup. Restore the entire data directory or Docker volume together.

## Known limitations

- The manager has no built-in authentication.
- The CurseForge catalog is more reliable with an API key; a Git catalog can be used instead or in addition.
- Automatic Bedrock binary provisioning may fall back to a test stub; verify the official binary before production use.
- Player bans are enforced by the manager when it observes a player connection; Bedrock Dedicated Server does not provide a standalone native ban-list file equivalent to Java Edition.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Report security issues using the private process in [SECURITY.md](SECURITY.md), not a public issue.

No open-source license has been selected yet. Unless a license is added, the repository's contents remain under the copyright holder's default rights.
