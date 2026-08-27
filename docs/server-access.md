# Server-specific manager access

Server Access Control is an optional bundled **Enterprise (.9)** plugin. It is
not present in the shared `.0` baseline, open-source `.3`, or Pro `.6`
packages. It applies to **management-console users**, not Minecraft players.
Player roles, allow lists, and ban lists stay on **Player Roles**.

The generic resource-authorization interfaces live in core and remain in every
edition. Core does not hardcode the `server-access-control` plugin id. When the
plugin folder is absent, the manager starts normally, the Users button is
hidden, `/api/server-access` reports unavailable, and authorization uses the
global security provider.

## Global vs server-specific

Global groups and direct user assignments continue to apply. When the plugin
is enabled, each server can also have:

- Its own groups
- Explicit assigned users
- Allow / deny / unset for permissions that declare `resourceScopes: ["server"]`

Combination rules:

1. Administrators and system principals keep the existing bypass.
2. Any applicable **deny** wins, including a global deny.
3. Otherwise any applicable **allow** grants the action.
4. Otherwise the action is denied.
5. A server allow cannot override a global deny.
6. A server deny overrides a global allow **only on that server**.
7. Assignments never affect other servers or global-only operations.

## Access modes

- **Inherited** (default): global permissions apply; server assignments add
  allows or denies.
- **Restricted**: only administrators, explicitly assigned users, and members
  of an active server group can discover the server. Membership does not grant
  every server permission.

New and existing servers default to inherited so installing the plugin does
not hide servers.

## Plugin lifecycle

Enable: migrate plugin tables, register the resource-authorization provider,
restore stored configuration.

Disable: administrators must confirm an impact summary. Configuration is
preserved. The UI Users button and `/api/server-access` management endpoints
disappear. Authorization returns to global RBAC.

If the provider is expected to be active and fails to load, non-administrators
are denied access to servers (fail closed). Administrators can repair or
disable the plugin.

Releases that omit the plugin folder keep a working core. The generic
`resourceAuthorizationRegistry` has no hardcoded plugin id. Server-access
permission definitions and plugin tables are created only by the plugin, not
by core.

Inactive explicit server-user assignments contribute no direct allows or
denies and do not satisfy restricted-mode membership. Active server-group
membership can still satisfy membership independently. Reactivating an
assignment restores its stored direct permissions; removing the assignment
deletes those rows. Multi-step mutations run in a database transaction and
emit audit or live socket refresh only after a successful commit.

## Declaring server applicability

Permission owners set:

```json
"resourceScopes": ["server"],
"assignableAtServerScope": true,
"serverKinds": ["java"]
```

## Future bundled providers

Core exposes `resourceAuthorizationRegistry.register(plugin, provider)` to
bundled plugins that declare `provider:resource-authorization`. The registry
has no hardcoded plugin id. A provider supplies `authorize`,
`getEffectivePermissions`, `listAssignablePermissions`, and
`getDisableImpact`. Optional `collectSources` and `inspectMembership` let the
core combiner apply deny-wins rules and restricted-mode membership.

Third-party user plugins cannot register this capability.

