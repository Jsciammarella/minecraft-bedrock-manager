# Windows native MSI

Linux Docker and native Ubuntu installs are unchanged. This package is a separate Windows x64 installer: one folder under Program Files, a Windows service, an uninstaller, and the **same manager web UI** as Linux. Only Windows runtime and packaging scripts differ (Node service wrapper, BDS `.exe`, zip extract, bundled JRE/Python/Git).

It is **not** a compiled Bedrock binary. The MSI ships Node, optional JRE / Python / Git, Phantom, and the manager. Official Minecraft Bedrock Dedicated Server is downloaded when you create a server, same as Linux.

## What you get

| Piece | Location after install |
| --- | --- |
| Manager + UI | `C:\Program Files\Minecraft Bedrock Manager\` |
| Worlds, SQLite, mods | `C:\Program Files\Minecraft Bedrock Manager\data\` |
| Bundled Node 20 | `runtime\node\node.exe` |
| Windows service | **Minecraft Bedrock Manager** (`MinecraftBedrockManager`, LocalSystem, starts at install) |
| Start menu | **MC Manager → Minecraft Bedrock Manager** (`http://127.0.0.1:3000`) |
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

Built installers are stored in `dist/windows/` as `MinecraftBedrockManager-0.3.0_NNNN.exe` (for example `_0001`). The `.exe` is tracked with Git LFS and is attached to GitHub Releases for open-source `.3` versions; `.msi`, `.wixpdb`, and the staging folder stay local. The filename stays on the product version and adds a four-digit build. Windows Installer uses `x.y.z`; the Burn bundle uses `x.y.z.N` so a newer build can replace an older `_NNNN` install.

The setup UI uses the manager favicon, logo, and a solid dark window (a full-window background image hides the buttons in Burn). Progress lines use an opaque font so “Processing:” can redraw instead of smearing. The success page shows `http://localhost:3000` and the computer’s LAN name. The packager always rebuilds the web UI so dashboard search and remote servers are included. Downloads are cached under `packaging\windows\cache\`.

Useful switches:

- `-SkipOptionalRuntimes` — Node + WinSW only (Bedrock Connect and URL imports need a JRE/Python already on PATH)
- `-SkipGit` — omit MinGit / Git LFS (Git catalog disabled unless Git is already installed)
- `-Version 0.3.0` — product version (`x.y.z`). The default follows the current release branch.
- `-Version 0.3.0_0002` or `-Build 2` — pin a build number. With neither, the next number is chosen from `packaging/windows/installer-build-number.txt` and existing files in `dist\windows\`.


GitLab CI stays Linux-only and does not build this MSI.

## Publish a release installer

GitLab is the source repository. CI mirrors only `release/x.x.3` to GitHub. Installers under `dist/windows/*.exe` use Git LFS, so CI copies only LFS objects reachable from the open-source ref and attaches the final installer to its GitHub Release.

Before publishing the first release:

1. Create a GitHub fine-grained personal access token scoped only to `Jsciammarella/minecraft-bedrock-manager` with **Contents: Read and write**.
2. In GitLab, add the token as a masked, protected CI/CD variable named `GITHUB_RELEASE_TOKEN`.
3. Protect the GitLab tag pattern `v*` so protected variables are available only to release-tag pipelines.

To publish, keep exactly one final installer matching the open-source release version in `dist/windows/`, commit it, and create a tag ending in `.3`, such as `v0.3.3`. After verification succeeds, the `publish-github-release` job:

- downloads the real installer from GitLab LFS;
- uploads the reachable LFS objects to the GitHub mirror;
- creates the matching GitHub Release if necessary; and
- attaches the `.exe` as a downloadable release asset.

To backfill an existing open-source tag, run a pipeline from the GitLab UI on a branch containing this automation and add a variable such as `RELEASE_TAG=v0.3.3`. The same version and single-installer checks apply.

The documented Linux clone commands and the upgrade script set `GIT_LFS_SKIP_SMUDGE=1`, so Docker and native Linux systems do not download Windows installers. Developer clones keep normal LFS behavior and receive the installer when Git LFS is installed.

## Install and use

Copy one file onto the PC: `MinecraftBedrockManager-<version>.exe`. Double-click it and approve the User Account Control prompt (the `.exe` is marked to run as administrator).

1. After setup, the **Minecraft Bedrock Manager** service should be running. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) from **Start → MC Manager → Minecraft Bedrock Manager**.
2. Create a Bedrock server as usual. The manager fetches the official **Windows** zip (`bedrock_server.exe`).
3. Xbox / LAN listing still uses bundled `vendor\phantom\phantom-windows.exe`.

Do not start `MinecraftBedrockManager.exe` from a console; that file is the Windows service wrapper. Use Services or:

```powershell
sc.exe query MinecraftBedrockManager
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
