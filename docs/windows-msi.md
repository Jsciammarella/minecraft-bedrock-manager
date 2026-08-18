# Windows native MSI

Linux Docker and native Ubuntu installs are unchanged. This package is a separate Windows x64 installer: one folder under Program Files, a Windows service, an uninstaller, and the same manager UI.

It is **not** a compiled Bedrock binary. The MSI ships Node, optional JRE / Python / Git, Phantom, and the manager. Official Minecraft Bedrock Dedicated Server is downloaded when you create a server, same as Linux.

## What you get

| Piece | Location after install |
| --- | --- |
| Manager + UI | `C:\Program Files\Minecraft Bedrock Manager\` |
| Worlds, SQLite, mods | `C:\Program Files\Minecraft Bedrock Manager\data\` |
| Bundled Node 20 | `runtime\node\node.exe` |
| Windows service | **Minecraft Bedrock Manager** (WinSW, LocalSystem) |
| Uninstall | Apps & features |

Firewall rules match the Linux UDP ranges plus TCP `3000` and DNS `53`. Data folders are marked permanent so worlds survive uninstall.

DNS on port 53 is still optional. Windows Internet Connection Sharing or another DNS service may already own that port; if bind fails, leave DNS off and use IP:port or Bedrock Connect without this host as the console DNS.

Do **not** set `CURSEFORGE_FETCH_URL`. Windows uses the bundled Python scripts directly. The Linux CurseForge sidecar stays a Docker-only path.

## Build the MSI (Windows packager)

Need:

- Windows 10/11 x64
- Node.js 20
- [WiX Toolset 5+](https://wixtoolset.org/): `dotnet tool install -g wix` (WiX v7 needs `-acceptEula wix7`, which the build script passes)
- Visual Studio Build Tools with the C++ desktop workload (native `node-pty` and `better-sqlite3`)

From the repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\build-msi.ps1
```

The MSI is written to `dist\windows\MinecraftBedrockManager-<version>.msi`. Downloads are cached under `packaging\windows\cache\`.

Useful switches:

- `-SkipOptionalRuntimes` — Node + WinSW only (Bedrock Connect and URL imports need a JRE/Python already on PATH)
- `-SkipGit` — omit MinGit / Git LFS (Git catalog disabled unless Git is already installed)
- `-Version 0.2.3` — MSI product version (x.y.z)

GitLab CI stays Linux-only and does not build this MSI.

## Install and use

1. Run the MSI as an administrator.
2. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).
3. Create a Bedrock server as usual. The manager fetches the official **Windows** zip (`bedrock_server.exe`).
4. Xbox / LAN listing still uses bundled `vendor\phantom\phantom-windows.exe`.

Service commands:

```powershell
sc.exe stop MinecraftBedrockManager
sc.exe start MinecraftBedrockManager
```

Logs: `data\logs\` and `data\logs\service\`.

## What this does not change

These Linux paths are not used by the MSI and should not be edited for Windows packaging:

- `scripts/install-docker.sh`
- `scripts/install-native.sh`
- `scripts/upgrade.sh`
- `Dockerfile`, `Dockerfile.curseforge-fetch`, `docker-compose.yml`
