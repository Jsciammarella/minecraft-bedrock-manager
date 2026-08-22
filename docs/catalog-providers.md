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

Catalog results include `providerId`, `source`, `edition`, `loader`,
`minecraftVersions`, and `environment`. Unknown loader or environment values stay
`unknown` rather than being guessed.

## APIs

- `GET /api/mods/catalog/providers`
- `GET /api/mods/catalog/search?edition=all|bedrock|java&provider=&source=`
- `GET /api/mods/catalog/categories?edition=&provider=`
- `POST /api/mods/catalog/download/:slug`

Default search without `edition` or `provider` matches the previous Bedrock
catalog. CurseForge Java appears only while its plugin is enabled.
