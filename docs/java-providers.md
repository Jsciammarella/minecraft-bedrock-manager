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
and requires an explicit confirmation. Floodgate requires the same raw 16-byte
`key.pem` on Geyser and the Java Floodgate plugin. The manager writes that key
as binary AES-128 bytes (not Base64). For a local Fabric, NeoForge, or Paper
server, Start (or Install Floodgate) downloads the matching Floodgate jar into
`mods/` or `plugins/` if it is missing, copies the key into
`config/floodgate/key.pem` or `plugins/floodgate/key.pem`, and restarts that
Java server so Floodgate can load the key. Remote servers still need a manual
Floodgate install and key copy. Private-key contents are never returned in API
responses.

Providers return structured JSON (download lists, installer argument arrays,
launch argument arrays). Shell command strings are rejected.

## Direct Geyser vs ViaProxy

Current Geyser Standalone understands a limited Java protocol range. If the
target Java server is newer or otherwise outside that range, Bedrock players
cannot join through a direct Geyser process.

ViaProxy compatibility is optional and is never downloaded unless an
administrator confirms it:

```text
Bedrock client
    │ Bedrock UDP (public)
    ▼
ViaProxy process
    └── Geyser-ViaProxy plugin
            │ translated Java protocol
            ▼
Target Java server
```

Direct mode keeps the existing Geyser Standalone layout. ViaProxy mode runs
ViaProxy with the official Geyser-ViaProxy plugin inside the same per-gateway
data directory (`data/gateways/<id>/`). The process is started as
`java -jar ViaProxy.jar config viaproxy.yml`
(ViaProxy 3.4.12 has no `start` command). Do not pass `-javaagent:ViaProxy.jar`:
the published jar has `Launcher-Agent-Class`, not `Premain-Class`, so that flag
kills the JVM during startup with no application log. ViaProxy injects itself
when launched with `java -jar`. Geyser
currently emulates a Java 1.26.2 client, so ViaProxy 3.4.12 is required to
translate that to older Java servers. Geyser-ViaProxy connects through ViaProxy
to the target Java server; it does not loop back to ViaProxy's own bind port.
The internal ViaProxy Java listener binds to loopback only and is never
advertised. Bedrock Connect lists the Geyser Bedrock UDP host and port.

ViaProxy is **not** installed automatically. Direct Geyser start still requires
an explicit ViaProxy install if the Java protocol is outside Geyser's native
range. If ViaProxy is already enabled on that gateway, Start launches ViaProxy
(not standalone Geyser). A leftover ViaProxy JVM from a previous relaunch can
hold UDP 19132 / TCP 25566 (`Address already in use`); Start now kills Java
processes whose working directory is that gateway folder before binding.

ViaProxy is GPL-3.0; Geyser is MIT. Runtime download does not relicense this
manager. If authentication is Java online-mode, ViaProxy CLI mode requires
Floodgate on the Java server (Start can install it for a local target), matching
`key.pem` files, and the FloodgateJoin ViaProxy helper (compiled at Start).
The manager never silently changes a Java server to offline mode.

Geyser gateways that target a **managed local Java server** attach to that
server's dashboard tile. Core renders plugin-supplied tags, a separate Geyser
status, and a split Start/Stop Geyser control. Clicking the tile still opens
the Java server page. Remote Java targets keep a projected **Remote Java — Geyser**
tile (`gateway:<id>`) with Java actions disabled.

Plugins cannot inject HTML, CSS, JavaScript, URLs, or commands into Dashboard.
They register trusted backend actions and return a sanitized contribution
contract (tags, indicators, actions, summary). Core validates enums, lengths,
and ownership before render or dispatch. Only one primary Geyser attachment is
shown per Java server; extra gateways stay on the Geyser plugin page.

Geyser gateways appear on the main dashboard as **Geyser Server** tiles with
ids `gateway:<id>`. Those tiles open a read-only page; start/stop/delete and
other server actions stay disabled. Management stays on the Geyser plugin page.

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

## Troubleshooting

- **Protocol incompatible:** Direct Geyser only speaks a native Java version
  (currently 1.26.2). Enable ViaProxy from the Geyser plugin, or update the Java
  server.
- **ViaProxy exits immediately:** Java 21+ prints an `Unsafe` warning from
  ViaProxy; that is not a crash. ViaProxy 3.4.12 must be launched with
  `config viaproxy.yml`, using `bind-address` / `target-address` as `host:port`.
- **Client version is not supported by ViaProxy:** That message is about Geyser's
  Java protocol (1.26.2), not Bedrock. Use ViaProxy 3.4.12 or newer. Do not point
  Geyser's `remote` at ViaProxy's loopback bind port.
- **Authentication misconfigured:** ViaProxy CLI mode cannot join an online-mode
  Java target without Floodgate on that Java server and matching `key.pem` files.
  For NeoForge/Fabric the jar goes in `mods/` and the key in `config/floodgate/key.pem`.
  ViaProxy still kicks with "requires a valid authentication mode" unless the
  FloodgateJoin helper is in the gateway `plugins/` folder (Start compiles it).
  The manager will not change Java `online-mode` itself.
- **Install NeoForge / you are not running NeoForge:** Floodgate auth succeeded.
  Geyser Standalone and ViaProxy still join as a vanilla Java client. NeoForge
  then rejects that client. Xbox cannot install NeoForge. Geyser only supports
  modded servers that a vanilla Java client could join. Create and most content
  mods are client-required, so Bedrock cannot join that pack through ViaProxy.
  Geyser-NeoForge on the Java server is the Geyser-supported NeoForge path, and
  it must match that server's Minecraft version (current Geyser-NeoForge does
  not support 1.21.1). For current Xbox crossplay, use Paper or vanilla Java,
  or a NeoForge version that current Geyser-NeoForge supports with server-side
  mods only.
- **Port conflict:** The Bedrock UDP port must be unique. The internal ViaProxy
  TCP port is loopback-only and is not listed to players. `Address already in
  use` on Geyser/ViaProxy usually means a leftover JVM still holds that port;
  stop the gateway (or restart the manager) so those processes are killed.
- **Unsafe / launcher warnings:** Java 21+ may print `Unsafe` or “Injected using
  Launcher Agent” lines. Those are not the crash. Duplicate overlapping Geyser
  banners in the log mean two JVMs started; Start kills leftover Java in the
  gateway folder before binding. Do not add `-javaagent` — that crashes ViaProxy
  3.4.12 before it can write a log.
- **Plugin disabled:** Gateway files remain. The dashboard tile stays read-only
  and Bedrock Connect stops advertising that UDP endpoint until the plugin is
  enabled again.

## APIs

- `GET /api/java/providers`
- `GET /api/java/providers/:id/versions`
- `GET /api/java/providers/:id/loader-versions`
- `POST /api/java/providers/:id/validate`
- `GET|POST|DELETE /api/servers/:id/java/mods`
- `GET /api/gateways/providers`
- `GET|POST /api/gateways` and start/stop/restart/logs (core administrative API)
- `GET /api/dashboard` and `GET /api/dashboard/gateways/:id` (read-only Geyser tiles)
- `GET|POST /api/plugins/gateway-geyser/gateways` (plugin iframe API)
- `POST /api/plugins/gateway-geyser/gateways/:id/viaproxy/install` (explicit ViaProxy install)
- `POST /api/plugins/gateway-geyser/gateways/:id/floodgate/install` (install Floodgate onto a local Java server)

Plugin iframe pages do not receive `/api/gateways` through `MBM.get`. The Geyser
UI must use the plugin’s own backend.
