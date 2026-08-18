# Git mod catalog

The manager can browse a Git repository as an optional catalog source, alongside CurseForge. Committed Bedrock packs become searchable in **Mod Catalog** and can be downloaded into the mod library.

Use any Git host that speaks HTTPS or SSH. GitLab is the primary target; GitHub, Gitea, Forgejo, Bitbucket, and other Git remotes work the same way.

## Connect the repository

1. Create the Git project (public or private).
2. Commit packs using the layout below.
3. In the manager, open **Mod Catalog** and click the settings gear.
4. Enable **Git catalog** and paste the clone URL, branch, and an access token. **Sync Now** stays disabled until the catalog is enabled and a token has been saved.
5. Use **Test Connection**, then **Save Settings**. Save returns immediately. If Git is enabled and a token is saved, a background sync starts (the **Sync Now** button and catalog refresh icon spin until it finishes). Wait for that spinner before downloading packs.

Settings are stored in the manager database. Environment variables are used only when a value has not been saved in the UI.

| Variable | Purpose |
| --- | --- |
| `GIT_CATALOG_ENABLED` | `true` to enable the Git source when no UI value exists |
| `GIT_CATALOG_URL` | HTTPS or SSH clone URL |
| `GIT_CATALOG_BRANCH` | Branch to track (default `main`) |
| `GIT_CATALOG_USERNAME` | Optional HTTPS username |
| `GIT_CATALOG_TOKEN` | Personal access token or deploy token |
| `GIT_CATALOG_SUBDIR` | Optional folder inside the repo that contains the catalog |

The host running the manager needs a `git` binary. The production Docker image includes Git.

## GitLab setup

1. Create a project, for example `bedrock-mod-catalog`.
2. Use `main` as the default branch, or set the branch name in Catalog Settings.
3. For a **private** project, create a token that can **download repository code**:
   - Personal access token with `read_repository` checked
   - Project access token with the Guest (or higher) role and `read_repository`
   - Deploy token with `read_repository`
   - Do **not** use a token that only has `read_user`. GitLab will accept that token for login, then reject the clone with "You are not allowed to download code."
4. Paste the HTTPS clone URL, such as `https://gitlab.example.com/group/bedrock-mod-catalog.git`.
5. Username may be left blank. The manager authenticates as `oauth2` with the token, which GitLab accepts. You can also set username to your GitLab username.
6. Paste the token in Catalog Settings. Do not commit it or send it in chat.

SSH URLs such as `git@gitlab.example.com:group/bedrock-mod-catalog.git` are converted to HTTPS when a token is provided. Passwordless SSH keys inside the manager container are not required.

## Other Git providers

| Provider | URL example | Token notes |
| --- | --- | --- |
| GitHub | `https://github.com/org/bedrock-mod-catalog.git` | Fine-grained PAT with Contents: Read, or a classic PAT |
| Gitea / Forgejo | `https://gitea.example.com/org/bedrock-mod-catalog.git` | Token with repository read |
| Bitbucket | `https://bitbucket.org/workspace/bedrock-mod-catalog.git` | App password or repository access token |

Public repositories can omit the token.

## Repository layout

The manager reads one branch. Keep catalog files on that branch; every commit becomes the next catalog snapshot after the manager syncs.

Recommended layout:

```text
README.md
catalog.json
addons/
  example-addon/
    mod.json
    example-addon.mcaddon
    thumbnail.png
texture-packs/
  clean-textures/
    mod.json
    clean-textures.mcpack
    pack_icon.png
maps/
  starter-world/
    mod.json
    starter-world.mcworld
templates/
  starter-template.mctemplate
structures/
  house.mcstructure
```

Supported pack files: `.mcaddon`, `.mcpack`, `.mcworld`, `.mctemplate`, `.mcstructure`, `.zip`.

Optional images in the same folder: `thumbnail.png`, `thumbnail.jpg`, `logo.png`, `icon.png`, or `pack_icon.png`.

Folder names `addons`, `texture-packs`, `maps`, `skins`, `worlds`, and `scripts` are used to infer type when metadata does not set it.

If the packs live in a subfolder, set **Catalog subdirectory** (for example `mods`) instead of moving the Git root.

## catalog.json

Place an index at the catalog root (repository root, or the configured subdirectory). Paths in this file are relative to the file's directory, then the catalog root.

```json
{
  "version": 1,
  "mods": [
    {
      "name": "Example Addon",
      "slug": "example-addon",
      "type": "addon",
      "version": "1.2.0",
      "description": "Adds extra survival tools for Bedrock servers.",
      "author": "Your Team",
      "categories": ["survival", "utility"],
      "file": "addons/example-addon/example-addon.mcaddon",
      "thumbnail": "addons/example-addon/thumbnail.png",
      "websiteUrl": "https://gitlab.example.com/group/bedrock-mod-catalog"
    }
  ]
}
```

`catalog.json` is optional. If it is missing, the manager still discovers pack files and per-folder `mod.json` files.

## Per-mod mod.json

Each pack folder may include `mod.json` (or `addon.json`):

```json
{
  "name": "Example Addon",
  "slug": "example-addon",
  "type": "addon",
  "version": "1.2.0",
  "description": "Adds extra survival tools for Bedrock servers.",
  "author": "Your Team",
  "categories": ["survival", "utility"],
  "file": "example-addon.mcaddon"
}
```

If `file` is omitted, the first pack file in that folder is used.

## Fields and catalog filters

The Mod Catalog search box, category dropdown, sort dropdown, and source dropdown apply to Git entries the same way they apply to CurseForge.

| Field | Required | Notes |
| --- | --- | --- |
| `name` | Recommended | Display title. Defaults to a cleaned-up file or folder name. |
| `slug` | Recommended | Stable id used when downloading. Use lowercase kebab-case. |
| `type` | Recommended | `addon`, `texture_pack`, `world`, or `skin`. |
| `file` | Recommended | Path to the downloadable pack. |
| `description` | Optional | Shown on the catalog card and matched by search. |
| `author` | Optional | Shown on the card and matched by search. |
| `categories` | Optional | Matched by the category filter. |
| `version` | Optional | Stored in the mod library on download. |
| `thumbnail` | Optional | Card image. |
| `websiteUrl` | Optional | External link on the catalog card. |
| `downloads` | Optional | Used when sorting by popularity or most downloaded. |
| `updated` | Optional | ISO date used when sorting by recently updated. File mtime is used otherwise. |

Use these category values so Git packs appear in the existing filter list:

- `addons`
- `texture-packs`
- `maps`
- `skins`
- `utility`
- `vanilla`
- `survival`
- `technology`
- `magic`
- `multiplayer`

Other category strings are added to the dropdown after the repository is synced.

Search matches name, slug, description, author, and categories. Sort options:

- **Relevancy** — name match against the search query, then alphabetical
- **Popularity** / **Most Downloaded** — `downloads` if provided
- **Recently Updated** — `updated` or the pack file's modification time

## Discovery without metadata

If you only commit pack files, the manager still lists them:

- `addons/my-tools.mcaddon` becomes an addon named "My Tools"
- `maps/lobby.mcworld` becomes a world named "Lobby"

Adding `catalog.json` or `mod.json` is better once you care about descriptions, authors, and category filters.

## Sync and download behavior

- The manager keeps a shallow clone under `data/git-catalog/`.
- The clone is refreshed automatically every **2 hours** while the manager is running, and in the background when you save Git catalog settings (enabled plus a saved token) or click **Sync Now** / the catalog refresh icon. Save Settings does not wait for the clone to finish. **Sync Now** stays disabled until the Git catalog is enabled and an access token has been saved. Large catalogs can take a long time; wait for the spinner to stop before downloading packs.
- A folder that contains `mod.json` (or `addon.json`) is listed **once**, using that metadata. Pack files in the same folder are not listed separately.
- `thumbnail.png` (or `thumbnail.jpg`, `logo.png`, `icon.png`, `pack_icon.png`) in the same folder is used as the catalog card image.
- **Download** copies the pack file into the manager mod library with source `Git`. It does not install the pack onto a Bedrock server until you install it from the library.
- Re-downloading the same Git slug replaces the library file.

Do not store secrets in the catalog repository. Pack archives are treated as untrusted add-on content; review them before installing onto production servers.

## Size and Git LFS

Keep individual packs within your Git host's file-size limit. Repositories that do not use Git LFS clone and index as normal Git; the manager skips `git lfs pull` unless pointer files are present.

If the catalog uses Git LFS, install `git-lfs` on the manager host (the Docker image includes it) so thumbnails and packs are real files rather than pointer files.

A successful Git clone is not enough for LFS. The manager fetches LFS objects with the same catalog token after clone. If a pack downloads at about 0.1 KB, the file is still an LFS pointer (`version https://git-lfs.github.com/spec/v1`) and the real object was not pulled.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Test Connection fails with authentication error | Token is valid and not expired; URL is the HTTPS clone URL |
| GitLab denied code download / HTTP 403 | Token scopes include `read_repository`. `read_user` alone cannot clone a private project |
| Branch was not found | Branch name matches the remote (`main` vs `master`) |
| Sync succeeds but the catalog is empty | Packs are on the selected branch; subdirectory is correct; files use a supported extension |
| Git is not installed | Install Git on the host, or rebuild the Docker image that now includes Git |
| Duplicate Git catalog cards for one pack | A `mod.json` in the folder now wins; refresh the catalog after updating the manager |
| Thumbnail missing | Put `thumbnail.png` next to `mod.json`. If the repo uses Git LFS, refresh the catalog after a manager update so LFS objects are pulled with the token |
| Sync times out or some packs fail until you download-fail and refresh | Save Settings no longer waits on sync. After saving an enabled catalog with a token, wait for the sync spinner to finish. **Sync Now** stays disabled until those settings are saved. |
| Download file size is ~0.1 KB | The pack is still a Git LFS pointer. Wait for the catalog sync spinner to finish. Confirm `git-lfs` is on the PATH of the manager process and the token can download repository files |
