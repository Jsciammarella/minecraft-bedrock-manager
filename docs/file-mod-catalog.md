# File mod catalog

The manager can browse folders of Bedrock packs as a catalog source, alongside CurseForge and Git. CurseForge, Git, and the file catalog can be enabled together or one at a time.

The folder layout is the same as the Git catalog. See [git-mod-catalog.md](git-mod-catalog.md).

## Sources

Open **Mod Catalog → Settings** and enable **File catalog**, then any of:

| Source | What to enter |
| --- | --- |
| Local folder | A Windows or Linux path on the manager host. Leave blank to use the writable default below. |
| SMB share | A UNC path such as `\\fileserver\bedrock\catalog`, or a folder where the share is already mounted. Optional username and password. |
| NFS share | A local mount path such as `/mnt/nfs/bedrock-catalog`. `host:/export` is attempted only when the host can mount NFS. |

Each of those can be on at the same time. Search results are tagged Local, SMB, or NFS.

## Default local folder

The manager uses a folder you can write to, not Program Files or the Docker data volume:

| Install | Default local folder |
| --- | --- |
| Windows | `C:\Users\Public\Documents\Minecraft Bedrock Manager\catalog` |
| Docker | `/catalog`, bind-mounted from `~/Minecraft Bedrock Manager/catalog` on the host |
| Native Linux | `data/catalog` (the service user can write here) |

It creates this layout there:

```text
catalog/
  addons/
  maps/
  texture-packs/
  skins/
  scripts/
```

Drop packs into those folders, or add `catalog.json` / per-folder `mod.json` the same way as Git. `file` can be a string or an array of archives. A folder that contains both a world and a texture pack is listed once and downloads both files as one library mod.

**Catalog Settings** has a **Download folder template** button. It is a zip of this layout, with `README.md`, `catalog.json`, an `example-mod` folder, and an example in each category. Extract it, replace the empty pack files, and point the local (or share) path at that folder.

## Docker and network shares

The manager process can only read folders it can already see.

- **Local:** use the writable default, or bind-mount another host folder onto `/catalog` (`FILE_CATALOG_HOST_DIR`).
- **SMB / NFS:** bind-mount the share into the container, then paste that container path (for example `/mnt/smb-catalog`). Mounting from inside the container needs extra privileges and is easy to lose on recreate.

On Windows native, UNC paths usually work directly. Credentials, if needed, are used with `net use`.

## Environment variables

These are used only when the matching setting has not been saved in the UI.

| Variable | Purpose |
| --- | --- |
| `FILE_CATALOG_ENABLED` | Master toggle (default on) |
| `FILE_CATALOG_LOCAL_ENABLED` | Local folder (default on) |
| `FILE_CATALOG_LOCAL_PATH` | Override the default writable catalog path |
| `FILE_CATALOG_SMB_ENABLED` | Enable SMB |
| `FILE_CATALOG_SMB_PATH` | UNC or mount path |
| `FILE_CATALOG_SMB_USERNAME` | Optional |
| `FILE_CATALOG_SMB_PASSWORD` | Optional |
| `FILE_CATALOG_NFS_ENABLED` | Enable NFS |
| `FILE_CATALOG_NFS_PATH` | Mount path or `host:/export` |

Do not store share passwords in git. Prefer Catalog Settings.
