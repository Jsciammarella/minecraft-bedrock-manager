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
│   └── CurseForge Java (`catalog-curseforge-java` bundled plugin)
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
catalog. CurseForge Java appears only while its plugin is enabled.
