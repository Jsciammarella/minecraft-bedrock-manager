# Java loaders and Geyser gateways

Minecraft Bedrock Manager does not ship Minecraft, Fabric, NeoForge, Geyser, or
third-party mods. Official binaries are downloaded when an administrator creates
or updates a server or gateway.

## Provider model

The core owns downloads, filesystem paths, process launch, ports, and secrets.
Bundled plugins only **describe** installation plans and launch specifications.

```text
Core manager
├── Java loader provider registry
│   ├── Vanilla (`java-loader-vanilla`)
│   ├── Fabric (`java-loader-fabric`)
│   └── NeoForge (`java-loader-neoforge`)
├── Gateway provider registry
│   └── Geyser Standalone (`gateway-geyser`)
└── Catalog provider registry
    └── CurseForge Java (`catalog-curseforge-java`)
```

Geyser is a gateway, not a Java loader. It accepts Bedrock UDP and translates
to Java TCP. Do not reuse the Bedrock UDP-to-UDP remote forwarder for Geyser.

Providers return structured JSON (download lists, installer argument arrays,
launch argument arrays). Shell command strings are rejected.

## Existing servers

Java servers created before this change are migrated to `loader_provider_id =
vanilla` with `minecraft_version` copied from `version`.

## Notices

UI copy uses wording such as **Compatible with Fabric**, **Compatible with
NeoForge**, and **Powered by Geyser**. That does not imply endorsement by
Mojang, Microsoft, FabricMC, NeoForged, or GeyserMC.

Users remain responsible for licenses of uploaded or catalog-downloaded mods.
Java mods are executable code; install only mods you trust until each server
runs in its own isolated process or container.

## APIs

- `GET /api/java/providers`
- `GET /api/java/providers/:id/versions`
- `GET /api/java/providers/:id/loader-versions`
- `POST /api/java/providers/:id/validate`
- `GET|POST|DELETE /api/servers/:id/java/mods`
- `GET /api/gateway-providers`
- `GET|POST /api/gateways` and start/stop/restart/logs

Plugin iframe pages do not receive these routes through `MBM.get` by default.
