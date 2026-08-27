# Release branch model

GitLab is the source of truth for every product tier. Each minor family starts from
one shared baseline, and the three product branches are siblings created directly
from that baseline.

| Branch pattern | Purpose | Security profile | Server Access Control | Public GitHub mirror |
| --- | --- | --- | --- | --- |
| `release/x.x.0` | Shared baseline for changes that affect every edition | `no-auth` | Absent | No |
| `release/x.x.3` | Open-source edition | `no-auth` | Absent | Yes |
| `release/x.x.6` | Pro edition (Local RBAC) | `local-rbac` | Absent | No |
| `release/x.x.9` | Enterprise edition (Local RBAC + Server Access Control) | `local-rbac` | Present, enabled by default | No |

For the 0.5 family the branches are `release/0.5.0`, `release/0.5.3`,
`release/0.5.6`, and `release/0.5.9`. Unknown patch suffixes such as `.1` or
`.7` are rejected at startup.

Local RBAC is a trusted security provider, not a plugin. Shared no-auth code may
retain dormant RBAC schema but does not load or seed RBAC. Server Access Control
is merged only into `.9`; do not merge that plugin folder backward into `.0`,
`.3`, or `.6`.

## Change flow

1. Start common feature and fix branches from `release/x.x.0`.
2. Merge completed common work back into the baseline.
3. Merge the baseline forward into each edition branch.
4. Start edition-specific plugin or feature branches from the edition that needs
   them, then merge only into that edition.
5. Tag a tested edition commit when it is ready to publish.

The edition branches are siblings, not a chain: do not create `.6` from `.3` or
`.9` from `.6`. Shared changes always flow through the `.0` baseline.

Only `release/x.x.3` is synchronized to GitHub. Its CI job transfers only Git
and LFS objects reachable from that open-source branch. Tags ending in `.3`
can publish GitHub Releases; base, Pro, and Enterprise tags remain in GitLab.

## Validation

Run `npm run test:release-family` (or `node scripts/verify-release-family.js`)
before building release artifacts. The script rejects inconsistent combinations
such as `.3` with Local RBAC, `.6` with no-auth, `.6` containing Server Access
Control, `.9` missing that plugin, or a package version that does not match
`release/x.x.x`.

Security tests and this release-family check are mandatory release gates. See
[security.md](security.md) and [edition-verification.md](edition-verification.md).
