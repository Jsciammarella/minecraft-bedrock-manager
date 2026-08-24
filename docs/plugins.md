# Plugins

Plugins add **their own left-hand menu items and pages**. They cannot change how
core screens look or behave: Dashboard, server details, New Server, Mod Library,
Mod Catalog, Players, BedrockConnect, or Ports. Geyser is a bundled plugin page,
not a hard-coded core screen.

Trust is derived from **where the plugin is installed**, not from a field in
`plugin.json`. Uploaded plugins can never become Java loader, gateway, or
catalog-source providers by declaring privileged capabilities.

The sidebar scrolls only when core items plus plugin items no longer fit. If
they fit, there is no extra scrollbar.

## Trust levels

| Source | Trust | What it can do |
| --- | --- | --- |
| `server/bundled-plugins/` | `system-provider` | Register Java loaders, gateways, and catalog sources; use core download, filesystem, Java, and port services |
| `data/plugins/` (upload) | `ui` (default) | Sandboxed pages only. Optional `backend.js` stays **disabled** until an administrator enables it |
| Extra/example dirs | `external` | Same UI model as uploads; example backends load so developers can test |

Privileged capabilities (`provider:java-loader`, `provider:gateway`,
`provider:catalog-source`, `download:official-sources`, `runtime:java`,
`filesystem:server-java`, `ports:udp`, …) are rejected for anything outside
`server/bundled-plugins/`. Unknown capabilities fail plugin load.

Uploaded `backend.js` still runs in the manager Node process if enabled. Treat
that as trusted code. Isolated workers are a follow-up.

First-party Java loaders, Geyser, the CurseForge Java catalog, and the Modrinth
Java catalog live under `server/bundled-plugins/` and are documented in [`java-providers.md`](./java-providers.md)
and [`catalog-providers.md`](./catalog-providers.md). Geyser is opt-in: enabling
the `gateway-geyser` plugin registers the provider and sidebar entry. Creating a
Java server does not download Geyser, open a Bedrock UDP port, or start a
gateway. A gateway must be created and started from the plugin page. The core
owns ports, downloads, processes, secrets, and audit logging; the plugin owns
Geyser-specific UI and configuration. Disabling the plugin safely stops running
Geyser processes, keeps gateway records, and leaves a read-only dashboard tile
labeled Plugin disabled. Bedrock Connect advertisements are removed until the
plugin is enabled again. Offline authentication is insecure. Floodgate needs
extra Java-server setup. No Geyser, ViaProxy, or ViaVersion binaries are shipped
with the manager.

## Install

Open **Plugins** next to the version label at the top of the left-hand menu.
Use **Upload** to send a plugin folder or a zip file.

A zip must contain **one plugin folder** (for example `hello-world/plugin.json`).
If the zip has files in the archive root, the manager deletes the temporary
extract and reports that the archive is an invalid plugin.

You can still copy a folder into `data/plugins/` on the host. Docker uses the
`mc-data` volume at `/app/data/plugins`. Each installed plugin has a toggle on
the Plugins page; turning it off hides its sidebar item without deleting files.

A complete example is [`examples/plugins/hello-world`](../examples/plugins/hello-world).

Installing a plugin means you trust its files. A plugin backend runs as the
same Node process as the manager. Only install plugins you would run yourself.

## Layout

```
my-plugin/
  plugin.json
  backend.js          (optional)
  ui/
    index.html
    about.html        (optional extra page)
```

The folder name **must** match `id` in `plugin.json`.

### `plugin.json`

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": "You",
  "menu": {
    "label": "My Plugin",
    "icon": "puzzle",
    "order": 100
  },
  "pages": [
    { "id": "home", "title": "My Plugin", "file": "index.html" },
    { "id": "about", "title": "About", "file": "about.html" }
  ],
  "backend": "backend.js"
}
```

Set `"enabled": false` in `plugin.json` to default a plugin off. The Plugins page
toggle overrides that without deleting the folder.

`order` only sorts plugin items relative to each other. Plugin items always
appear **below** the core menu. Use more than one object in `menus` if the
plugin needs more than one sidebar entry; each entry still opens a page under
`/plugins/<id>/...`.

Reserved ids such as `servers`, `mods`, `catalog`, `players`, `ports`, and
`bedrock-connect` are rejected.

## Pages and isolation

Plugin pages are HTML/CSS/JS under `ui/`. The manager opens them in a sandboxed
iframe so plugin CSS and JavaScript cannot restyle or patch Dashboard, catalog,
library, or the other core pages.

The manager injects `/api/plugins/sdk.js`, which exposes `window.MBM`:

| Call | Purpose |
| --- | --- |
| `MBM.get('/api/v1/overview')` | Read the public manager API |
| `MBM.post('/api/servers/1/start')` | Call the same-origin control API |
| `MBM.get('/api/plugins/my-plugin/hello')` | Call this plugin’s own backend |
| `MBM.navigate('/plugins/my-plugin/about')` | Open another page of this plugin |

`MBM.navigate` only accepts paths under `/plugins/<this-plugin-id>`. API calls
go through the host page and are limited to `/api/health`, `/api/v1`, servers,
mods, players, ports, Bedrock Connect, the plugin list, and **this** plugin’s
backend. A plugin cannot call another plugin’s API or load another plugin’s UI.

## Backend (optional)

`backend.js` may export `register({ id, router, dataDir, logger, services,
registerJavaLoader, registerGateway, registerCatalogSource })`. The router
is mounted only at `/api/plugins/<id>/`. It cannot replace `/api/servers` or any
other core route. `registerCatalogSource`, `registerJavaLoader`, and
`registerGateway` are only provided to bundled plugins. Bundled gateway plugins
also receive `services.gateways`, a provider-scoped wrapper around core gateway
lifecycle. They can manage only their own records and cannot read Floodgate
private keys or bind ports directly.

```js
module.exports = {
  register({ router, id, dataDir, logger }) {
    router.get('/hello', (req, res) => {
      res.json({ plugin: id, dataDir });
    });
  }
};
```

Private files belong in `data/plugin-data/<id>/` (`dataDir`). Do not write into
core application folders.

Catalog-source providers reuse core credential brokers. They never receive raw
API keys. Enabling or disabling a bundled catalog plugin registers or unregisters
its source without deleting Mod Library files. Catalog providers declare
`bedrock` or `java` edition identifiers; the core validates them and renders the
Mod Catalog edition dropdown. Plugins cannot inject that dropdown’s labels or
markup. `all` is a core-only option.

Catalog plugins classify file compatibility. The core enforces download policy,
including blocking Java files marked client-only. Plugins cannot inject catalog
buttons, colors, or labels. A yellow disabled **Client Side Only** button means
every inspected Java JAR for that project is client-only. Unknown files are not
treated as client-only. Uploaded and catalog Java mods are executable code;
loader compatibility is checked again when installing to a Fabric or NeoForge
server.

First-party edition features ship as folders under `server/bundled-plugins/`
using the same manifest.
