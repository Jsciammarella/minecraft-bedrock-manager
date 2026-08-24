# Catalog-source providers

Minecraft Bedrock Manager does not ship Minecraft, loaders, Geyser, or mods.
Catalog plugins describe search and download plans. The core owns credentials,
HTTPS downloads, archive inspection, and Mod Library storage.

## Provider model

```text
Core manager
├── Catalog provider registry
│   ├── CurseForge Bedrock (core)
│   ├── Git repository (core)
│   ├── File catalog (core)
│   ├── CurseForge Java (`catalog-curseforge-java` bundled plugin)
│   └── Modrinth Java (`catalog-modrinth-java` bundled plugin)
├── Java loader provider registry
└── Gateway provider registry
```

Only plugins loaded from `server/bundled-plugins/` may declare
`provider:catalog-source` and call `registerCatalogSource`. Uploaded plugins
that declare the capability are rejected at install time. Disabling a catalog
plugin unregisters its source. Downloaded Mod Library entries and server installs
are left in place.

## CurseForge Java

The bundled `catalog-curseforge-java` plugin adds Minecraft Java projects from
https://www.curseforge.com/minecraft using CurseForge’s official API.

It reuses the existing CurseForge API-key setting. The plugin receives a
credential-aware HTTP broker (`services.catalogHttp`). The raw key is never
passed into the plugin, returned by APIs, written to logs, or stored on download
records.

If the key is missing, the source explains that Catalog Settings still needs the
existing CurseForge API key. There is no Java web-scraping fallback.

Java mods are executable code. Trust a project before installing it on a server.
Loader and Minecraft-version compatibility is validated again by the Fabric or
NeoForge loader provider at install time. Downloads never execute JAR files;
the manager only reads zip metadata.

## Modrinth Java

The bundled `catalog-modrinth-java` plugin adds Minecraft Java mods from
https://modrinth.com/ using the public Modrinth API
(https://docs.modrinth.com/api/). No API key or user account is used. The
plugin never sends an `Authorization` header and does not publish, follow, or
modify projects.

All API calls originate from the manager backend with an identifying User-Agent:

```text
minecraft-bedrock-manager/<version> (https://github.com/Jsciammarella/minecraft-bedrock-manager)
```

Allowed hosts:

- API: `api.modrinth.com`
- Artifacts and icons: `cdn.modrinth.com`
- Project pages: `https://modrinth.com/`

The plugin is always available when enabled. Disabling it removes **Modrinth**
from the catalog source selector, cancels new searches and downloads, and
clears transient caches. Library files and installed server mods stay in place,
including Modrinth provenance on `metadata_json`.

### Plugin permissions

The plugin declares only `provider:catalog-source`, `catalog:metadata`, and
`download:catalog-sources`. It can register the Modrinth source, call the
catalog HTTP broker (restricted to `api.modrinth.com`), and submit download
plans for `cdn.modrinth.com`. It does not receive shell, Docker, filesystem,
credential-store, gateway, or unrestricted network access.

### Search and filters

Search uses `GET /v2/search` with structured JSON facets. Queries are always
constrained to `project_type:mod`. User text is passed as the `query` parameter,
never concatenated into facet syntax.

Existing catalog filters apply:

- Query, category, sort, edition, Minecraft version
- Loader (Fabric or NeoForge; Quilt maps to Fabric search, Forge to NeoForge)
- Environment (default **Server Compatible**)

Sort mapping: Relevancy → `relevance`, Popularity → `follows`, Recently Updated
→ `updated`, Most Downloaded → `downloads`.

Pagination is bounded to 40 results. Search responses are cached for a few
minutes; project and version metadata longer; categories for hours. `429`
responses honor `X-Ratelimit-Reset` / `Retry-After` with a single bounded retry.

### Environment classification

Version-level `environment` from Modrinth is mapped to the manager allowlist
before download or install. Search facets may narrow results, but installation
uses the selected version.

| Modrinth value | Manager environment | Catalog action |
| --- | --- | --- |
| `client_only`, `singleplayer_only` | `client` | Blocked. Yellow **Client Side Only** |
| `server_only`, `dedicated_server_only`, `server_only_client_optional` | `server` | Allowed |
| `client_and_server` | `both` | Allowed, with “must also be installed on connecting Minecraft clients” |
| `client_or_server`, `client_or_server_prefers_both` | `both` | Allowed; label keeps the Modrinth meaning |
| `client_only_server_optional` | `both` | Allowed, with “Client Focused — Server Optional” |
| `unknown` | `unknown` | Not treated as client-only; **Compatibility Unknown** |

After a JAR is in the library, loader manifests still override these catalog
hints as described above.

### Downloads and dependencies

Downloads use the controlled download service: HTTPS, allowlisted CDN hosts,
filename sanitization, size limit, SHA-512 when provided, SHA-1 as an extra
check, and hash mismatch cleanup. Redirects to unapproved hosts are rejected.
JARs are not executed during catalog import.

Required Modrinth dependencies are resolved (exact `version_id` when present,
otherwise a matching project version), classified the same way, and imported as
separate library mods (merged by project id, slug, or file hash). Optional and
embedded dependencies are not downloaded automatically. Cycles, excessive
depth, missing deps, and client-only required deps block the plan.

Additional files for a project already in the library are appended to that
library entry, the same as CurseForge Java.

### Troubleshooting

- **Modrinth missing from Sources:** enable **Modrinth Java Catalog** on the
  Plugins page.
- **Rate limit reached:** wait for the reset window; do not hammer search.
- **Client Side Only:** the selected version is not for a dedicated server.
- **Hash mismatch / invalid CDN URL:** the file failed verification or the URL
  was not on `cdn.modrinth.com`.
- **Missing dependency:** a required project has no matching loader/version.

Java mods are executable code. Trust a project before installing it on a server.
Loader and Minecraft-version compatibility is validated again by the Fabric or
NeoForge loader provider at install time. Downloads never execute JAR files;
the manager only reads zip metadata.

## Normalized metadata

Catalog plugins classify file compatibility. They may return normalized
`environment` values from the allowlist `client`, `server`, `both`, and
`unknown`. Missing or unrecognized values become `unknown`. Unknown files are
not treated as client-only.

The core validates that metadata, computes download policy, and enforces it.
Allowed download states are `allowed`, `blocked`, `requires-selection`, and
`unknown`. Allowed block reasons currently include `client-only`,
`incompatible-loader`, `incompatible-minecraft`, and `unavailable`. Only
`client-only` blocks catalog download today.

After a JAR is in the Mod Library, loader manifests override catalog tags:
`fabric.mod.json` / `quilt.mod.json` `environment`, and NeoForge/Forge
`clientSideOnly`, `serverSideOnly`, `displayTest=IGNORE_SERVER_VERSION`, or
`side` on `[[mods]]`. Missing Fabric/Quilt `environment` defaults to `both`.
NeoForge files without those keys stay `unknown`. Catalog `Client`/`Server`
game-version tags remain hints for download policy only. Library tiles show
`Client`, `Server`, `Both`, or `Unknown`.

Plugins must not return HTML, JSX, CSS, event handlers, button labels, or
executable browser rules. Catalog tiles, colors, and the disabled
**Client Side Only** button are owned by the core frontend.

```json
{
  "id": "12345",
  "name": "example-client.jar",
  "edition": "java",
  "environment": "client",
  "downloadable": false,
  "blockedReason": "client-only"
}
```

## Client-only Java files

Java files marked client-only cannot be downloaded into the Mod Library. The
CurseForge Java plugin reports environment metadata from CurseForge. The core
rejects those files on the download API even if the browser control is bypassed.

A project is confirmed client-only only after the complete relevant JAR list has
been inspected and every JAR is explicitly `environment: "client"`. Search
`latestFiles`, project categories, and missing environment fields are not enough.
One `server`, `both`, or `unknown` JAR prevents that blocked state.

Confirmed all-client projects show a yellow disabled **Client Side Only** button.
The upstream CurseForge link stays available. Mixed projects still open the file
picker: client files are visible and disabled, and Download selected stays off
until a permitted file is chosen.

Availability is cached by provider and project so catalog tiles are not refreshed
with a CurseForge request on every render. Disabling the CurseForge Java plugin
unregisters the source and clears that cache. Previously downloaded Mod Library
files and installed server mods are left in place, including older client-only
records.

Java mods remain executable code. Server-compatible classification does not mean
a JAR is safe to trust.

## Edition options

Catalog providers declare supported edition identifiers in metadata:

```json
{ "editions": ["java"] }
```

The core validates those identifiers against an allowlist (`bedrock`, `java`),
then renders the Mod Catalog edition dropdown. Plugins do not inject HTML, CSS,
labels, or event handlers into that field.

- `all` is a core-only option and cannot be declared by a provider.
- Display labels such as **Bedrock** and **Java** are owned by the core.
- An edition appears while at least one enabled provider supports it.
- Disabling the last provider for an edition removes that edition from the
  dropdown. Downloaded and installed mods are not deleted.

`GET /api/mods/catalog/providers` is the source of truth for enabled sources
and their editions.

## APIs

- `GET /api/mods/catalog/providers`
- `GET /api/mods/catalog/search?edition=all|bedrock|java&provider=&source=`
- `GET /api/mods/catalog/categories?edition=&provider=`
- `POST /api/mods/catalog/download/:slug`

Default search without `edition` or `provider` matches the previous Bedrock
catalog. CurseForge Java and Modrinth appear only while their plugins are
enabled.
