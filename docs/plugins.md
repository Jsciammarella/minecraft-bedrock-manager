# Plugins

Plugins add **their own left-hand menu items and pages**. They cannot change how
core screens look or behave: Dashboard, server details, New Server, Mod Library,
Mod Catalog, Players, BedrockConnect, or Ports.

The sidebar scrolls only when core items plus plugin items no longer fit. If
they fit, there is no extra scrollbar.

## Install

1. Copy a plugin folder into `data/plugins/` on the manager host.
   Docker uses the `mc-data` volume at `/app/data/plugins`.
2. Restart the manager.
3. Open **Plugins** in the sidebar, or use the new menu item the plugin added.

A complete example is [`examples/plugins/hello-world`](../examples/plugins/hello-world).
Copy that folder to `data/plugins/hello-world` to try it.

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

Set `"enabled": false` to keep the files on disk without showing a menu item.

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

`backend.js` may export `register({ id, router, dataDir, logger })`. The router
is mounted only at `/api/plugins/<id>/`. It cannot replace `/api/servers` or any
other core route.

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

First-party edition features can ship later as folders under
`server/bundled-plugins/` using the same manifest.
