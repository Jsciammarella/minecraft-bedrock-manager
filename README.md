# Minecraft Bedrock Server Manager

A self-hosted web console for creating and operating multiple Minecraft Bedrock Dedicated Server instances from one dashboard.

## What it provides

- Server creation with an available-port selector
- Start, stop, immediate restart, and five-minute warned restart controls
- A server-specific live console with per-server command history
- Per-server allowlists, player permissions, and ban lists
- Bedrock add-on upload, installation, removal, and restart-required notices
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
- One published UDP port per Bedrock server (default `19132`)

For a native installation, use Node.js 20 or newer plus Python 3, `make`, and a C++ compiler for native dependencies.

## Install with Docker (recommended)

1. Clone the repository and enter it:

   ```bash
   git clone <repository-url>
   cd minecraft-bedrock-manager
   ```

2. Create your local configuration:

   ```bash
   cp .env.example .env
   ```

   Change `TZ` and `PORT` if needed. `CURSEFORGE_API_KEY` is optional and is only used by the deferred CurseForge catalog integration.

3. Review the UDP mapping in `docker-compose.yml`. The included mapping publishes port `19132`. If a server will use another port, add a matching entry before creating the container, for example:

   ```yaml
   ports:
     - "3000:3000/tcp"
     - "19132:19132/udp"
     - "19133:19133/udp"
   ```

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

Application data is stored in the `mc-data` Docker volume and survives container replacement. Back up this volume before upgrades.

### Bedrock Dedicated Server binary

Minecraft Bedrock Dedicated Server is licensed and distributed separately by Mojang/Microsoft, so it is not included in this repository or image. Server creation attempts to provision it; if the official download cannot be resolved, the manager creates a development stub so the UI can still be tested.

For a real server, download the current Linux Bedrock Dedicated Server from the [official Minecraft server download page](https://www.minecraft.net/en-us/download/server/bedrock), stop the instance, and place the extracted files in that instance's data directory. The executable must be named `bedrock_server`, be executable, and be owned by the account running the manager. In Docker, the instance directories are inside the `mc-data` volume at `/app/data/servers/<server-name>`.

## Native Ubuntu installation

1. Install Node.js 20 and build prerequisites:

   ```bash
   sudo apt update
   sudo apt install -y ca-certificates curl python3 make g++ wget tar
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

2. Clone the repository, install locked dependencies, and build the UI:

   ```bash
   git clone <repository-url> /opt/mc-manager
   cd /opt/mc-manager
   cp .env.example .env
   npm ci
   npm --prefix frontend ci
   npm run build
   ```

3. Start it interactively for an initial check:

   ```bash
   ./scripts/start.sh
   ```

For a persistent service, create a dedicated `mcmanager` user, give it ownership of `/opt/mc-manager`, review `scripts/mc-manager.service`, then install that unit under `/etc/systemd/system/`. Open TCP port `3000` and each selected Bedrock UDP port in the host firewall.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | Runtime mode |
| `PORT` | `3000` | Web interface and API port |
| `LOG_LEVEL` | `info` | Application logging level |
| `TZ` | `UTC` | Container timezone |
| `AUTO_UPDATE_CHECK_INTERVAL` | `86400` | Update-check interval in seconds |
| `CURSEFORGE_API_KEY` | empty | Optional CurseForge API credential |
| `BEDROCK_PORT` | `19132` | UDP port published by the default Compose file |

Never commit `.env`; it is intentionally ignored.

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
- `data/uploads/` — temporary uploads
- `data/logs/` — application logs

Stop active servers before taking a consistent backup. Restore the entire data directory or Docker volume together.

## Known limitations

- The manager has no built-in authentication.
- The CurseForge catalog requires an API key for reliable use and is not a current project focus.
- Automatic Bedrock binary provisioning may fall back to a test stub; verify the official binary before production use.
- Player bans are enforced by the manager when it observes a player connection; Bedrock Dedicated Server does not provide a standalone native ban-list file equivalent to Java Edition.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Report security issues using the private process in [SECURITY.md](SECURITY.md), not a public issue.

No open-source license has been selected yet. Unless a license is added, the repository's contents remain under the copyright holder's default rights.
