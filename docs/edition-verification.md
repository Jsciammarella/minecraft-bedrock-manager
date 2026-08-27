# Edition verification

Use this checklist when cutting a 0.5.x family. Automated gates must be green
before creating or merging `release/0.5.0`, `release/0.5.3`, `release/0.5.6`,
or `release/0.5.9`.

```text
npm test
npm run test:security
node scripts/server-access-test.js
node scripts/permission-catalog-test.js
npm run test:release-family
npm --prefix frontend run build
```

`npm run test:release-family` must fail on unsupported suffixes and on
inconsistent profile or plugin combinations.

## Clean install

Perform a clean Docker install for each product edition:

| Edition | Version shown | Health profile | Login | User Management | Server Users |
| --- | --- | --- | --- | --- | --- |
| Open-source | `0.5.3` | `no-auth` | No | Hidden | Hidden |
| Pro | `0.5.6` | `local-rbac` | Yes | Visible | Hidden |
| Enterprise | `0.5.9` | `local-rbac` | Yes | Visible | Visible |

For every edition confirm:

- Bedrock server creation and lifecycle
- Console access
- Player Roles
- Plugin loading
- Graceful restart and shutdown

Additional Pro (`.6`) checks:

- Bootstrap the first administrator (no known default password)
- Create users and groups
- Global allow and deny inheritance
- Server Users remains unavailable

Additional Enterprise (`.9`) checks:

- Complete every Pro check
- Create server-specific groups and users
- Inherited and restricted modes
- Server A assignments do not affect Server B
- Server deny against global allow; server allow against global unset; global deny against server allow
- Inactive assignments contribute no scoped permissions
- Live socket revocation after a permission change
- Disable and re-enable Server Access Control; stored configuration is restored

## Same-edition upgrades

Documented upgrades with preserved data:

- `0.4.3` → `0.5.3`
- `0.4.6` → `0.5.6`
- `0.4.9` → `0.5.9`

Verify:

- Servers and downloaded mods remain intact
- Plugin settings remain intact
- Users, groups, and assignments remain intact for `.6` and `.9`
- Existing administrator access remains valid
- No default administrator is introduced
- Permission-catalog migrations are idempotent
- Server Access Control migrations run only on `.9`
- Re-running the upgrade does not duplicate assignments or migrations
- Running servers are stopped gracefully and restored according to `upgrade.sh`
- Backup retention remains at most two timestamped copies

Do not upgrade `.3` directly to `.6` or `.9` unless a separate conversion is
designed and documented.
