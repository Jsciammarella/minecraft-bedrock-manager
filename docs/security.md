# Security model

Minecraft Bedrock Manager authenticates and authorizes through a trusted
**security provider**. The provider is not a plugin: it cannot be installed,
removed, enabled, or disabled from the Plugins screen, and plugins cannot
replace it.

```text
Core application
    |
    +-- Security runtime
          |
          +-- NoAuthProvider        (open-source .3)
          +-- LocalRbacProvider     (Pro .6 and Enterprise .9)
          +-- Future identity providers (OIDC, LDAP, SSO) — not implemented
```

Feature routes, WebSocket handlers, plugin actions, and background jobs all
call the same runtime (`authenticate`, `authorize`, `requirePermission`,
`getCapabilities`, `createSystemPrincipal`). They must not branch on product
edition.

The runtime loads **only the selected trusted provider**. A no-auth package
does not import local RBAC, `authService`, or user-management routes. A
missing or invalid provider on `.6` / `.9` refuses to start and never falls
back to no-auth.

## Profiles

| Edition | Version patch | Profile | Login | User management |
| --- | --- | --- | --- | --- |
| Open-source | `.3` | `no-auth` | No | Hidden / unavailable |
| Pro | `.6` | `local-rbac` | Yes | Yes |
| Enterprise | `.9` | `local-rbac` | Yes | Yes |

The profile is selected from trusted product identity (package version and
`server/security/productConfig.js`), not from a database setting. Production
`.6` and `.9` installations ignore `MBM_SECURITY_PROFILE`. A missing or
invalid provider on those editions refuses to start the web service and never
falls back to no-auth.

Development and tests may set `MBM_SECURITY_PROFILE=no-auth` or `local-rbac`
when `NODE_ENV` is not `production`.

## No-auth profile

Every request receives a built-in local system principal (`id: local-system`).
Authorization still runs: unknown permissions, unknown plugin actions, and
unknown feature names are denied. Plugin sandbox, filesystem, process,
network, and path restrictions remain fully enforced.

No-auth does not seed users, groups, permission assignments, sessions, or
passwords. Shared schema migrations may retain RBAC tables, but a clean
no-auth database has zero user and session rows.

Login, password, session, and user-management APIs return `404`.

**Do not expose a no-auth installation directly to an untrusted network.**
Place it on a trusted LAN or behind an authenticating reverse proxy. The UI
shows this warning, and `/api/system` includes `networkWarning: true`.

## Local RBAC profile

Preserves current Pro/Enterprise behavior: login, sessions, users, groups,
permission assignment, and fail-closed unknown permissions. Existing
accounts, roles, and assignments are kept across upgrades. New Java
permissions (`servers.create_java`, `servers.start_java`, `servers.stop_java`,
`servers.change_java_settings`) are granted to the built-in Administrators and
Standard groups when they have not already been assigned. Other custom roles
are not updated automatically.

Startup does **not** create a known default password. If no active
administrator exists, `/api/auth/bootstrap` requires the operator to supply
the initial username and password. Existing `.6` / `.9` administrators are
unchanged.

Sessions are not invalidated by this refactor; cookie signing is unchanged.

## Catalog settings

Native catalog plugin settings map to registered catalog permissions:

| Plugin | Actions | Permission |
| --- | --- | --- |
| CurseForge | view, save, test connection, API key secrets | `catalog.set_curseforge_key` |
| Git catalog | view, save, test, sync | `catalog.enable_git` |
| Git catalog | download template | `catalog.download_mods` |
| File catalog | view, save, path tests | `catalog.enable_file` |
| File catalog | download template | `catalog.download_mods` |

Unknown settings actions remain denied.

## WebSocket rooms

Joining a server room requires `servers.view_details` and `servers.console`
because console output is broadcast to that room. Users who can view a server
but not its console receive a join error and do not get `server-output`.
Start, stop, and console commands use the same permissions as the HTTP
routes. Server-status events are emitted only to sockets that can view that
server.

## Frontend

The UI reads `/api/auth/security` (public) and `/api/auth/me` (authenticated
or local-system). Buttons may hide from the capability list, but the API still
enforces authorization. A failed security-configuration response does not
switch the UI into no-auth mode.

## Plugins

Plugins may declare required permissions, ask whether the current principal
has a permission, and request that core perform an action. They may not
register a security provider, grant permissions, construct a system principal,
or treat hidden buttons as authorization. Trusted background work uses
`createSystemPrincipal(reason)` with an audit reason.
