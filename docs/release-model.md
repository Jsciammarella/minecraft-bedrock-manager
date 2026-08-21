# Release branch model

GitLab is the source of truth for every product tier. Each minor family starts from
one shared baseline, and the three product branches are siblings created directly
from that baseline.

| Branch pattern | Purpose | Public GitHub mirror |
| --- | --- | --- |
| `release/x.x.0` | Shared baseline for changes that affect every edition | No |
| `release/x.x.3` | Open-source edition | Yes |
| `release/x.x.6` | Pro edition | No |
| `release/x.x.9` | Enterprise edition | No |

For the first family, the branches are `release/0.3.0`,
`release/0.3.3`, `release/0.3.6`, and `release/0.3.9`.

## Change flow

1. Start common feature and fix branches from `release/x.x.0`.
2. Merge completed common work back into the baseline.
3. Merge the baseline forward into each edition branch.
4. Start edition-specific plugin or feature branches from the edition that needs
   them, then merge only into that edition.
5. Tag a tested edition commit when it is ready to publish.

The edition branches are siblings, not a chain: Pro does not inherit
open-source-only commits, and Enterprise does not automatically inherit Pro
commits. Shared changes always flow through the `.0` baseline.

Only `release/x.x.3` is synchronized to GitHub. Its CI job transfers only Git
and LFS objects reachable from that open-source branch. Tags ending in `.3`
can publish GitHub Releases; base, Pro, and Enterprise tags remain in GitLab.
