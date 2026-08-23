# Java loaders and Geyser gateways

Minecraft Bedrock Manager does not ship Minecraft, Fabric, NeoForge, Geyser, or
third-party mods. Official binaries are downloaded when an administrator creates
or updates a server or gateway.

## Provider model

The core owns downloads, filesystem paths, process launch, ports, secrets, and
audit logging. Bundled plugins describe installation plans, launch
specifications, and (for Geyser) the management UI.

```text
Core manager
├── Generic gateway-provider registry
├── Generic gateway records and lifecycle
├── Port allocation
├── Controlled downloads and Java processes
└── Optional-integration links on Java servers

Bundled gateway-geyser plugin
├── Sidebar entry and management page
├── Geyser provider implementation
├── Local and remote Java targets
└── Authentication choices and Geyser configuration
```

Geyser is an optional bundled gateway plugin, not a Java loader. It accepts
Bedrock UDP and translates to Java TCP. Do not reuse the Bedrock UDP-to-UDP
remote forwarder for Geyser. Java server creation does not install Geyser,
reserve a Bedrock UDP port, start another Java process, or change
authentication. Enabling the plugin makes the provider and Geyser page
available. A gateway must be created and started explicitly; new gateways stay
stopped until started. Geyser Standalone can target a local managed Java server
or a remote Java hostname and TCP port.

The plugin calls only `/api/plugins/gateway-geyser/...`. Core validates Java
executables, working directories, JAR paths, argument lists, download hosts,
UDP ports, and authentication confirmations. Offline authentication is insecure
and requires an explicit confirmation. Floodgate requires additional
configuration on the Java server and never returns private-key contents.

Providers return structured JSON (download lists, installer argument arrays,
launch argument arrays). Shell command strings are rejected.

## Existing servers

Java servers created before this change are migrated to `loader_provider_id =
vanilla` with `minecraft_version` copied from `version`. Existing Geyser gateway
rows, ports, files, and keys remain after this plugin isolation. `/gateways`
redirects to the Geyser plugin page when it is enabled, or to Plugins when it
is not.

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
- `GET /api/gateways/providers`
- `GET|POST /api/gateways` and start/stop/restart/logs (core administrative API)
- `GET|POST /api/plugins/gateway-geyser/gateways` (plugin iframe API)

Plugin iframe pages do not receive `/api/gateways` through `MBM.get`. The Geyser
UI must use the plugin’s own backend.
