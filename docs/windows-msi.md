# Windows native MSI

Linux Docker and native Ubuntu installs are unchanged. This package is a separate Windows x64 installer: one folder under Program Files, a Windows service, an uninstaller, and the **same manager web UI** as Linux. Only Windows runtime and packaging scripts differ (Node service wrapper, BDS `.exe`, zip extract, bundled JDK/Python/Git).

It is **not** a compiled Bedrock binary. The MSI ships Node, an optional JDK / Python / Git, Phantom, and the manager. Official Minecraft Bedrock Dedicated Server is downloaded when you create a server, same as Linux.

## What you get

| Piece | Location after install |
| --- | --- |
| Manager + UI | `C:\Program Files\Minecraft Bedrock Manager\` |
| Worlds, SQLite, mods, `.env` | `C:\Program Files\Minecraft Bedrock Manager\` (data under `data\`, config `.env` beside `.env.example`) |
| Bundled Node 20 | `runtime\node\node.exe` |
| Bundled Temurin JDK 21 | `runtime\jdk\` (`java.exe` and `javac.exe`) |
| Windows service | **Minecraft Bedrock Manager** (`MinecraftBedrockManager`, LocalSystem, starts at install) |
| Start menu | **MC Manager → Minecraft Bedrock Manager** (`http://127.0.0.1:3000`) |
| Uninstall | Apps & features |

Firewall rules match the Linux UDP game-port ranges, add TCP for Java server ranges (`19132-19199`, `25565-25665`, `30000-30100`), and allow TCP `3000` plus DNS `53`. Data folders are marked permanent so worlds survive uninstall. `.env` is created once from `.env.example` and is never overwritten on upgrade.

DNS on port 53 is still optional. Windows Internet Connection Sharing or another DNS service may already own that port; if bind fails, leave DNS off and use IP:port or Bedrock Connect without this host as the console DNS.

Do **not** set `CURSEFORGE_FETCH_URL`. Windows uses the bundled Python scripts directly. The Linux CurseForge sidecar stays a Docker-only path.

## Build the installer (Windows packager)

Need:

- Windows 10/11 x64
- Node.js 20
- [WiX Toolset 5+](https://wixtoolset.org/): `dotnet tool install -g wix` (WiX v7 needs `-acceptEula wix7`, which the build script passes)
- Visual Studio Build Tools with the C++ desktop workload (native `node-pty` and `better-sqlite3`)
- Network access to download Node, Temurin JDK 21, Python embeddable, MinGit, and Git LFS (cached under `packaging\windows\cache\`)

From the repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\build-msi.ps1
```

The product version is read from the repository `package.json` when `-Version` is omitted. `package-lock.json` must match. Invalid values such as `-Version banana` or `-Version 0.6` stop the build with an error; there is no fallback to an unrelated version.

Built installers are stored in `dist/windows/` as `MinecraftBedrockManager-<version>_NNNN.exe` (for example `MinecraftBedrockManager-0.6.0_0001.exe` on `release/0.6.0`). The `.exe` is tracked with Git LFS and is attached to GitHub Releases for open-source `.3` versions; `.msi`, `.wixpdb`, and the staging folder stay local. Windows Installer uses `x.y.z`; the Burn bundle uses `x.y.z.N` so a newer `_NNNN` build can replace an older install of the same product version. The setup UI shows the Burn version.

The packager rebuilds the web UI unless `-SkipFrontend` is passed. Downloads are cached under `packaging\windows\cache\`.

Useful switches:

- `-SkipOptionalRuntimes` — omit the bundled JDK and Python. The service still looks under `runtime\jdk`. Bedrock Connect, URL imports, and **ViaProxy with Floodgate** then need a JDK already on the machine (`JAVA_HOME` or `MC_MANAGER_JAVAC`). A JRE is not enough for Floodgate join-helper compilation. Minecraft Java servers can still run on a JRE.
- `-SkipGit` — omit MinGit / Git LFS (Git catalog disabled unless Git is already installed)
- `-SkipFrontend` — skip the Vite production build. Fails if `public\index.html` is missing.
- `-Version x.y.z` — override the `package.json` product version. Must be three numeric MSI components.
- `-Version x.y.z_NNNN` or `-Build N` — pin the Burn build number. With neither, the next number is chosen from `packaging/windows/installer-build-number.txt` and existing files in `dist\windows\`.

## Validate before release

Windows packaging is **not** part of Linux GitLab CI. Before publishing a Windows installer, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\test-installer.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\test-installer.ps1 -Build
```

The first command checks version resolution, firewall scripts, `.env` copy behavior, and required source files. `-Build` also stages the app, confirms `java.exe`/`javac.exe`, native modules, WiX MSI/Burn output, and `/api/health`. Do not commit `dist\windows\stage`, cache extracts, or test-only production dependencies.

GitLab CI stays Linux-only and does not build this MSI. Add a Windows runner job only when a compatible Windows GitLab runner exists.

## Publish a release installer

GitLab is the source repository. CI mirrors only `release/x.x.3` to GitHub. Installers under `dist/windows/*.exe` use Git LFS, so CI copies only LFS objects reachable from the open-source ref and attaches the final installer to its GitHub Release.

Before publishing the first release:

1. Create a GitHub fine-grained personal access token scoped only to `Jsciammarella/minecraft-bedrock-manager` with **Contents: Read and write**.
2. In GitLab, add the token as a masked, protected CI/CD variable named `GITHUB_RELEASE_TOKEN`.
3. Protect the GitLab tag pattern `v*` so protected variables are available only to release-tag pipelines.

To publish, keep exactly one final installer matching the open-source release version in `dist/windows/`, commit it, and create a tag ending in `.3`, such as `v0.6.3`. After verification succeeds, the `publish-github-release` job:

- downloads the real installer from GitLab LFS;
- uploads the reachable LFS objects to the GitHub mirror;
- creates the matching GitHub Release if necessary; and
- attaches the `.exe` as a downloadable release asset.

To backfill an existing open-source tag, run a pipeline from the GitLab UI on a branch containing this automation and add a variable such as `RELEASE_TAG=v0.6.3`. The same version and single-installer checks apply.

The documented Linux clone commands and the upgrade script set `GIT_LFS_SKIP_SMUDGE=1`, so Docker and native Linux systems do not download Windows installers. Developer clones keep normal LFS behavior and receive the installer when Git LFS is installed.

## Install and use

Copy one file onto the PC: `MinecraftBedrockManager-<version>_NNNN.exe`. Double-click it and approve the User Account Control prompt (the `.exe` is marked to run as administrator).

1. After setup, the **Minecraft Bedrock Manager** service should be running. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) from **Start → MC Manager → Minecraft Bedrock Manager**.
2. Confirm `/api/health` reports the same product version as `package.json`.
3. Create a Bedrock server as usual. The manager fetches the official **Windows** zip (`bedrock_server.exe`).
4. Java servers use TCP on the allocated game port. The installer opens those TCP ranges in Windows Firewall.
5. Geyser ViaProxy with Floodgate compiles `FloodgateJoin.jar` using the bundled JDK. No separate Java install is required on a standard package.
6. Xbox / LAN listing still uses bundled `vendor\phantom\phantom-windows.exe`.

Configuration lives in `.env` next to `.env.example` in the install folder. The Windows service working directory is that folder, so Node loads `%BASE%\.env` without overriding variables already set by WinSW. Upgrades never replace an existing `.env`. Uninstall keeps data folders according to the permanent-component policy.

Do not start `MinecraftBedrockManager.exe` from a console; that file is the Windows service wrapper. Use Services or:

```powershell
sc.exe query MinecraftBedrockManager
sc.exe stop MinecraftBedrockManager
sc.exe start MinecraftBedrockManager
```

Logs: `data\logs\` and `data\logs\service\`.

Confirm firewall rules after install:

```powershell
Get-NetFirewallRule -DisplayName "Minecraft Bedrock Manager*"
```

Uninstall removes those manager-created rules and the Windows service. It does not modify unrelated firewall rules.

## What this does not change

These Linux paths are not used by the MSI and should not be edited for Windows packaging:

- `scripts/install-docker.sh`
- `scripts/install-native.sh`
- `scripts/upgrade.sh`
- `Dockerfile`, `Dockerfile.curseforge-fetch`, `docker-compose.yml`
