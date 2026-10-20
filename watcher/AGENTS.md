# Watcher

The published version is `[project].version` in `watcher/pyproject.toml`. Heartbeats and `data-hub-watcher --version` read it from the installed package. Lab PCs pick up a new version only after someone tags `watcher-vX.Y.Z` on `production` and advertises it in Settings → Watchers, as described at https://datahub.arcadiascience.com/docs/watcher-releases. Commands, config, and the Windows service are covered in `docs/developer/watcher.md`.

## Bump the version when you change shipped code

If this branch changes anything under `watcher/src/`, bump the version once on the branch before you finish:

1. Compare `[project].version` with the merge-base (`staging`, unless the user named another base).
2. If it still matches the base, bump it:
   - patch (`1.0.0` → `1.0.1`): bug fixes and behavior changes that don't add a feature or break a contract.
   - minor (`1.0.1` → `1.1.0`): new commands, flags, or backward-compatible features.
   - major (`1.1.0` → `2.0.0`): breaking CLI, config, or API protocol changes.
3. Run `uv lock` from the repo root so `uv.lock` records the new version.
4. Regenerate the snapshots as "Generated snapshots" in the root `AGENTS.md` describes, and commit both changed files. The CLI catalog records the version, and the MCP docs bundle embeds the CLI reference page.
5. Don't bump again for later commits on the branch. If the base has moved past your number, bump from the base's version instead.

Changes to tests, docs, or `AGENTS.md` alone don't need a bump. Never tag `watcher-v*` from a feature branch. Leave the seeded `watcher_release_config` version alone. It pins the fleet version for local seed data and isn't this package's version.

## Rules

- Runtime code never imports `data_hub_shared`. It is a test-only dependency and isn't published to PyPI.
- Give every new config field a default, so the YAML files already on lab PCs keep loading.
- The `preview` environment never auto-updates lab PCs. Keep that check in `watcher/src/data_hub_watcher/updater.py`.
