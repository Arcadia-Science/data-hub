# Watcher agent notes

The published package version is `[project].version` in `watcher/pyproject.toml`. Heartbeats and `data-hub-watcher --version` read that value from the installed package metadata. Lab PCs only pick up a new version after someone tags `watcher-vX.Y.Z` on `production` and advertises it in Settings → Watchers — see [Roll out watcher releases](https://datahub.arcadiascience.com/docs/watcher-releases).

## Bump the version when you change shipped code

If this branch changes anything under `watcher/src/` (runtime, CLI, upload, update), bump `watcher/pyproject.toml` **once on the branch** before you finish.

1. Compare `[project].version` to the merge-base (`staging` unless the user named another base).
2. If it still matches the base, bump it:
   - **patch** (`1.0.0` → `1.0.1`) — bug fixes and behavior changes that do not add a feature or break a contract
   - **minor** (`1.0.1` → `1.1.0`) — new commands, flags, or backward-compatible features
   - **major** (`1.1.0` → `2.0.0`) — breaking CLI, config, or API-protocol changes
3. Run `uv lock` from the repo root so `uv.lock` records the new workspace version.
4. Do not bump again for later commits on the same branch. If the base already moved past your number, bump from the current base version instead.

Do **not** bump for tests-only, docs-only, or `AGENTS.md` edits. Do **not** tag `watcher-v*` from a feature branch. Do **not** change the seeded `watcher_release_config` latest version — that is the advertised fleet pin for local seed data, not this package version.

The CLI catalog step in the root `AGENTS.md` still applies when you change Click help or options.
