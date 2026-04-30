# Upgrading the watcher

This guide covers everything that happens between a new `data-hub-watcher` release landing on PyPI and the upgraded code running on a lab instrument PC. It's written for two audiences: **lab operators** keeping a single PC up to date (start at [How upgrades reach a lab PC](#how-upgrades-reach-a-lab-pc)), and **release admins** cutting a new version and rolling it out to the fleet (jump to [Cutting a new release](#cutting-a-new-release)).

If you're installing the watcher for the first time, see [Installing a watcher](installing-a-watcher.md) first; this guide assumes the watcher is already registered against an instrument.

## How upgrades reach a lab PC

Three paths feed an upgraded wheel into the running watcher. Lab PCs running as a Windows service get the auto-update path for free; everything else upgrades on demand via the CLI.

### Background auto-update (Windows service, recommended)

When the watcher runs as a Windows service in `staging` or `production`, the in-process updater polls the API roughly once an hour and applies new releases on its own — no operator action and no Task Scheduler entry required.

On each tick the service:

1. Calls `GET /api/v1/watchers/<watcher-id>/update-check` and compares the server's `latest_version` against its own.
2. Only attempts an upgrade if **all** of these are true: a newer version is available, no files have been uploaded for several heartbeats in a row, and no run has been reported within roughly 5× the configured `stability_period_seconds`. The activity-window guard exists so the watcher never takes itself down mid-acquisition.
    - **Exception:** releases flagged as `mandatory` on the server skip the activity-window check entirely and are applied immediately — this is reserved for security fixes or breaking wire-protocol changes where leaving the old version running is worse than a brief interruption.
3. Runs `uv tool install --reinstall data-hub-watcher==<latest>` (or the `pip install -U` equivalent for non-uv installs) on a dedicated background thread, so heartbeats keep flowing while the install executes — which can take 30–60 s on slow links. Before the subprocess starts, the service emits an `update_started` event you can see in the **Watchers** page.
4. On success, exits non-zero so the Windows SCM restarts the service into the new wheel via its configured failure-actions policy. The new process emits `update_succeeded` once it confirms the new version is actually loaded; if the new code crashes at startup or otherwise doesn't take effect, you'll see `update_failed` instead.

Auto-update is **disabled** in the `preview` environment so PR preview deployments can never push code to production lab PCs.

### Manual operator-driven upgrade (`self-update`)

Any watcher installed from PyPI — service or foreground — can upgrade itself in place via the CLI. This is the right path on macOS / Linux instrument PCs, on Windows PCs running the watcher in a console window, or any time you want an upgrade now rather than on the next hourly tick.

```sh
data-hub-watcher self-update            # check + upgrade if needed
data-hub-watcher self-update --check    # report status only, no upgrade
data-hub-watcher self-update --force    # re-run the upgrade subprocess
                                        # even if the version already matches
```

The command asks the API for the latest published version, compares it to the locally installed version, and runs the appropriate upgrade subprocess for your install method:

| Install method | Upgrade command |
| --- | --- |
| `uv tool install` | `uv tool install --reinstall data-hub-watcher==<latest>` |
| Plain venv `pip install` | `<python> -m pip install -U data-hub-watcher==<latest>` |
| Editable / `uv sync` checkout | Refused; upgrade manually with `git pull && uv sync` |

After a successful CLI upgrade you must restart the watcher (or the Windows service) for the new code to take effect — `self-update` does not restart the running process. To run upgrades unattended without the Windows service, schedule the CLI via Windows Task Scheduler (e.g. weekly).

### Editable / developer checkouts

If the watcher is installed editable from a checkout (`uv sync --all-packages`), both the auto-updater and `self-update` will refuse to act and tell you to upgrade manually with `git pull && uv sync`. The refusal is intentional, since auto-upgrading would silently shadow your source tree with an index build.

The detection lives in `data_hub_watcher.self_update.detect_install_method` and reads `direct_url.json` from the dist's metadata; the editable check takes precedence over every other heuristic, so even an editable install whose `.venv` happens to live under a `uv/tools/` directory still gets refused.

## Pinning a specific version

If you want a specific PC to stay on a particular release rather than tracking the server's `latest_version`, pin it explicitly:

```sh
uv tool install data-hub-watcher==<pinned>
```

Run `data-hub-watcher self-update --check` afterwards to confirm what the server's target is. As long as the pinned version matches `latest_version`, the auto-update tick is a no-op. The moment the server's target moves past your pin, the next tick will try to upgrade past it again — pinning is per-machine state, not server-side state. To park a fleet on a given version intentionally, the right knob is the server-side `WATCHER_LATEST_VERSION` env var (see [Cutting a new release](#cutting-a-new-release)).

## Cutting a new release

This section is for admins shipping a new `data-hub-watcher` build. The flow is intentionally tag-driven so you can't accidentally publish from a feature branch.

### 1. Bump the version

Edit `[project].version` in `watcher/pyproject.toml`. Follow [PEP 440](https://peps.python.org/pep-0440/) (`X.Y.Z`, with optional pre-release suffixes). Open the bump as a PR against `staging`, smoke-test it from a checkout, then merge to `production` once it's clean.

Bumping the version on `staging` alone is not enough — `publish-watcher.yml` only runs on `watcher-v*` tags, and tags should always point at a `production` commit so the published wheel matches what's deployed to the web app.

### 2. Tag the release commit and push the tag

```sh
git checkout production
git pull
git tag watcher-v0.3.0
git push origin watcher-v0.3.0
```

The `publish-watcher.yml` workflow runs automatically. Its `build` job calls `make py-check-watcher-version`, which refuses to proceed if the git tag and `watcher/pyproject.toml` disagree — so a typo in either fails fast before anything reaches PyPI.

### 3. Approve the `pypi` deployment

`publish-watcher.yml` is gated on the `pypi` GitHub deployment environment. Approve it under **Actions → Publish watcher** in the GitHub UI.

Once approved, the `publish` job uploads the wheel + sdist to PyPI via OIDC trusted publishing (no API token in repo secrets), and the `verify` job installs `data-hub-watcher==<tag-version>` from PyPI into a clean venv and runs `data-hub-watcher --version` plus `python -c "import data_hub_watcher"` as a smoke test. The verify step catches stale-mirror shadows and module-level import side-effects that would otherwise only surface on a lab PC.

If a transient PyPI outage breaks one of those steps after a successful build, you can re-run the workflow from the GitHub UI: **Actions → Publish watcher → Run workflow** on the `production` branch. The `skip-existing: true` flag on the publish step makes the retry safe — files already uploaded with the same hash are skipped rather than failing the run with `400: file already exists`.

Manual dispatch from any branch other than `production` is refused by the workflow's `if:` guard.

### 4. Roll the release out

Once the new version is live on PyPI, bump the server-side `WATCHER_LATEST_VERSION` env var in Vercel (per environment) so the `/update-check` endpoint advertises the new target. Lab PCs running an auto-update-capable build will pick it up on their next hourly tick.

The supported watcher release env vars are:

| Env var | Purpose |
| --- | --- |
| `WATCHER_LATEST_VERSION` | Required to advertise a release. `null`/unset means "no update info available" and the watcher skips its update attempt. |
| `WATCHER_MIN_SUPPORTED_VERSION` | Optional floor; surfaced in the response for future use. Not yet enforced server-side. |
| `WATCHER_RELEASE_CHANNEL` | Defaults to `stable`. Surfaced in the response and shown in `self-update` output. |
| `WATCHER_MANDATORY_UPDATE` | Set to `true` / `1` to flag the release as mandatory (see below). |

Do **not** bump `WATCHER_LATEST_VERSION` ahead of the PyPI publish — the watcher's upgrade subprocess will fail to resolve a version that doesn't yet exist on the index, and you'll see a wave of `update_failed` events from the fleet. Always: tag → publish → verify → bump env var.

If the rollout needs to be paged through (e.g. you want only `staging` lab PCs to see the new version while you babysit it for a day), bump only the staging environment's `WATCHER_LATEST_VERSION`. The `production` environment keeps advertising the previous version until you bump it explicitly.

## Mandatory updates

By default the activity-window guard means a watcher mid-acquisition won't auto-update — it'll wait for the next idle window. For releases that fix a security issue, a wire-protocol break, or any other case where running the known-bad version is worse than a brief outage, set `WATCHER_MANDATORY_UPDATE=true` alongside the version bump. Mandatory rollouts skip the activity-window guard and fire on the very next hourly check on every lab PC.

Use this sparingly. The activity-window guard exists for a reason — a forced upgrade in the middle of a multi-hour microscopy run will lose data. Reserve it for cases where leaving the bad version in place is strictly worse than restarting the watcher in flight.

Note also that mandatory rollouts are versioned, not absolute: the server compares the running version against `latest_version` and only forces the upgrade when they differ. A correctly-pinned PC that already matches `latest_version` won't be forced to do anything.

## Rolling back

Rollback is just another release. To revert the fleet from `0.3.0` to `0.2.5`:

1. Set `WATCHER_LATEST_VERSION=0.2.5` in Vercel for the affected environment(s).
2. Set `WATCHER_MANDATORY_UPDATE=true` if you need the rollback to bypass the activity-window guard (most rollback scenarios qualify — you're rolling back precisely because the running version is misbehaving).
3. Wait for the next hourly tick on each PC. Lab PCs running an auto-update-capable build will downgrade themselves; PCs being upgraded manually need a `data-hub-watcher self-update` (or an `uv tool install data-hub-watcher==0.2.5` if `self-update` itself is what's broken).
4. Once the fleet has converged, set `WATCHER_MANDATORY_UPDATE` back to `false`.

There is no separate "yank" step — a rolled-back release is still on PyPI and still reinstallable, just not advertised by `/update-check`.

## Troubleshooting

### `update_started` is followed by `update_failed`

The upgrade subprocess started but didn't end up running the new version on the next process startup. The `details.reason` field on the `update_failed` event tells you which sub-case fired:

- **`subprocess raised: …`** — `subprocess.run` itself raised before it could exec the upgrade command. Typically `FileNotFoundError` because `uv` isn't on PATH for the service account, or a permission error. Check `~/.data-hub/watcher.log` for the full traceback.
- **`subprocess exited <N>`** — the upgrade command itself failed. The event details include the last 1000 bytes of stdout/stderr; the most common cause is a transient PyPI / mirror failure or the version not yet existing on the index (see the "don't bump ahead of publish" note above).
- **`expected '<target>' after upgrade, running '<current>'`** — the subprocess succeeded, the service restarted, but the running interpreter still imports the old version. Almost always means a stale `__pycache__` or a separate copy of the package on `sys.path`. Run `uv tool uninstall data-hub-watcher && uv tool install data-hub-watcher==<target>` as the service account.

### `update_failed` without a preceding `update_started`

When `details.attempted_subprocess` is `false`, the auto-updater never ran the upgrade command — it refused before starting one. The `details.reason` field tells you why:

- **`install method '<editable|unknown>' not eligible for auto-update`** — the watcher detected a development-style install (editable `uv sync`, or a distribution whose metadata couldn't be located) and refused so it wouldn't silently shadow the source tree with an index build. Resolve by switching the host to a PyPI install (`uv tool install data-hub-watcher`) or, on a developer machine, ignoring the event. To avoid spamming the events stream, the watcher emits this at most once per server target — a rebump of `WATCHER_LATEST_VERSION` will trigger one fresh event per stuck PC.

### Auto-update never fires

Check, in order:

- The watcher is running as a service, not in a console window. Foreground `data-hub-watcher watch` does run the in-process updater, but on a developer-style install it'll typically be refused as editable.
- The environment isn't `preview`. Auto-update is hard-disabled there.
- The activity-window guard isn't holding things up. The instrument has to have been quiet for several heartbeats; on a busy plate reader you may simply never hit the idle window. Use the CLI path (`data-hub-watcher self-update`) for an immediate upgrade, or set `WATCHER_MANDATORY_UPDATE=true` if the release warrants it.
- The dashboard's **Last Heartbeat** is recent. If the watcher has gone stale, it's not ticking and won't auto-update.

### `data-hub-watcher self-update --check` says "(none configured)"

`WATCHER_LATEST_VERSION` is unset for that environment. Either you're running against a `preview` build that doesn't have the env var set, or someone unset it in Vercel. The CLI returns successfully and treats this as "no update available" — the same response code path used by an up-to-date watcher — so this is benign, just informational.

### "Refusing to self-update an editable / unknown install"

You're running from a checkout (`uv sync --all-packages`). This is the [editable install refusal](#editable--developer-checkouts) — upgrade manually with `git pull && uv sync` from your repo. If you genuinely need to switch a developer machine onto a PyPI build, `uv tool install data-hub-watcher` from a separate shell will get you a parallel install on PATH, and you can switch between them by un-shadowing whichever you don't want active.

### A failed upgrade left a stale marker

The on-disk upgrade marker at `~/.data-hub/.upgrade-in-progress` is consumed and deleted on read by the next process startup, so a single failure won't be reported indefinitely. If you see the file persisting across multiple restarts, the watcher is failing to start up at all (so it never reaches the `evaluate_upgrade_marker` step). Delete the marker manually, fix the underlying startup issue, and the next clean start will report cleanly.
