# Upgrading the watcher

This guide covers what happens between a new `data-hub-watcher` release landing on PyPI and the upgraded code running on a lab instrument PC. It's written for two audiences: **lab operators** keeping a single PC up to date (start at [How upgrades reach a lab PC](#how-upgrades-reach-a-lab-pc)), and **release admins** cutting a new version (jump to [Cutting a new release](#cutting-a-new-release)).

If you're installing the watcher for the first time, see [Installing a watcher](installing-a-watcher.md) first; this guide assumes the watcher is already registered.

## How upgrades reach a lab PC

Three paths feed an upgraded wheel into the running watcher. Lab PCs running as a Windows service get the auto-update path for free; everything else upgrades on demand via the CLI.

### Background auto-update (Windows service, recommended)

When the watcher runs as a Windows service in `staging` or `production`, the in-process updater polls the API roughly once an hour and applies new releases on its own — no operator action and no manual Task Scheduler setup required.

On each tick the service:

1. Calls `GET /api/v1/watchers/<watcher-id>/update-check` and compares the server's `latest_version` against its own.
2. Only attempts an upgrade if **all** of these are true: a newer version is available, no files have been uploaded for several heartbeats in a row, and no run has been reported within roughly 5× the configured `stability_period_seconds`. The activity-window guard exists so the watcher never takes itself down mid-acquisition. Releases flagged as **mandatory** on the server skip this guard — see [Mandatory updates](#mandatory-updates).
3. Drives the upgrade subprocess: Windows uv-tool installs route through the `DataHubWatcherUpgrade` Scheduled Task (registered by `service install`); other installs run `uv tool install --reinstall` (or `pip install -U`) inline and exit non-zero so the SCM restarts into the new wheel.
4. Emits an `update_started` event before the subprocess runs, then `update_succeeded` or `update_failed` from the next process startup. Windows uv-tool events also carry `worker_returncode`, `worker_stdout_tail`, and `worker_stderr_tail` for dashboard-side debugging.

Auto-update is **disabled** in the `preview` environment so PR preview deployments can never push code to production lab PCs.

### Manual operator-driven upgrade (`self-update`)

Use this when you want an upgrade immediately, or on a non-Windows / non-service install.

```sh
data-hub-watcher self-update            # check + upgrade if needed
data-hub-watcher self-update --check    # report status only, no upgrade
data-hub-watcher self-update --force    # re-run the upgrade subprocess
                                        # even if the version already matches
```

The command asks the API for the latest published version, compares it to the locally installed version, and runs the appropriate flow for your install method:

| Install method                | Upgrade flow                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows + `uv tool install`   | Routes through the `DataHubWatcherUpgrade` Scheduled Task — same out-of-process worker the auto-updater uses. CLI exits as soon as the task accepts the request; service restart is automatic. Tail `~/.data-hub/upgrade-worker.log` to watch progress. |
| POSIX + `uv tool install`     | `uv tool install --reinstall data-hub-watcher==<latest>` inline. **Restart the watcher** to pick up the new code.                                                                                         |
| Plain venv `pip install`      | `<python> -m pip install -U data-hub-watcher==<latest>` inline. **Restart the watcher.**                                                                                                                  |
| Editable / `uv sync` checkout | Refused; upgrade manually with `git pull && uv sync`.                                                                                                                                                     |

The Windows uv-tool path **requires** that `data-hub-watcher service install` (or `service reinstall`) has been run from an Administrator shell at least once on the machine — that's what registers the `DataHubWatcherUpgrade` Scheduled Task. If the task is missing, `self-update` fails fast with an actionable error. Fleet PCs auto-updating into a worker-aware build for the first time must be reinstalled once with `service reinstall` to pick up the new task.

To run upgrades unattended on a non-service install, schedule the CLI via Windows Task Scheduler (e.g. weekly).

### Editable / developer checkouts

If the watcher is installed editable from a checkout (`uv sync --all-packages`), both the auto-updater and `self-update` refuse to act and tell you to upgrade manually with `git pull && uv sync`. The refusal is intentional — auto-upgrading would silently shadow your source tree with an index build.

## Pinning a specific version

To keep a specific PC on a particular release rather than tracking the server's `latest_version`, pin it explicitly:

```sh
uv tool install data-hub-watcher==<pinned>
```

Run `data-hub-watcher self-update --check` afterwards to confirm what the server's target is. As long as the pinned version matches, the auto-update tick is a no-op; the moment the server's target moves past your pin, the next tick will try to upgrade past it again. **To pin a whole fleet instead, use *Latest version* in [Settings → Watchers](#cutting-a-new-release).**

## Cutting a new release

Admins-only. The flow is tag-driven; releases publish from a `production` commit, never from a feature branch.

1. **Bump the version.** Edit `[project].version` in `watcher/pyproject.toml` ([PEP 440](https://peps.python.org/pep-0440/)). Merge through `staging` to `production`.
2. **Tag and push** from `production`:
   ```sh
   git checkout production && git pull
   git tag watcher-v0.3.0 && git push origin watcher-v0.3.0
   ```
3. **Approve the `pypi` deployment** under **Actions → Publish watcher** in GitHub.
4. **Advertise the release.** Open **Settings → Watchers** in Data Hub and set **Latest version** to the new tag. Each Vercel env has its own DB, so staging and production are independent — bump them separately to roll the fleet gradually.

> **Always tag → publish → verify → save.** Saving a **Latest version** before the wheel is on PyPI causes a wave of `update_failed` events from the fleet.

### Release-config fields

| Field                         | Purpose                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| **Latest version**            | Required. Blank = "no update info available".                                      |
| **Minimum supported version** | Reserved; not enforced server-side yet.                                            |
| **Release channel**           | Defaults to `stable`. Surfaced in `self-update` output.                            |
| **Mandatory update**          | Skips the activity-window guard — see [Mandatory updates](#mandatory-updates).     |

### Notes on the publish workflow

- `make py-check-watcher-version` refuses to proceed if the git tag and `watcher/pyproject.toml` disagree.
- PyPI uploads use OIDC trusted publishing — no API token in repo secrets.
- The `verify` job installs from PyPI in a clean venv and runs `data-hub-watcher --version` + `import data_hub_watcher` as a smoke test.
- Re-running the workflow after a transient PyPI outage is safe (`skip-existing: true` skips already-published files).
- Manual `workflow_dispatch` is refused from any branch other than `production`.

## Mandatory updates

Toggling **Mandatory update** on the **Settings → Watchers** page skips the activity-window guard (see [Background auto-update](#background-auto-update-windows-service-recommended)) and fires the upgrade on the next hourly check. The server still compares the running version to `latest_version`, so a correctly-pinned PC isn't forced to anything.

Use sparingly — a forced upgrade mid-microscopy-run loses data. Reserve it for security fixes, wire-protocol breaks, or any case where leaving the bad version running is strictly worse than restarting in flight.

## Rolling back

Rollback is just another release. To revert the fleet from `0.3.0` to `0.2.5`:

1. Open **Settings → Watchers** in Data Hub and set **Latest version** to `0.2.5` for the affected environment(s).
2. Toggle **Mandatory update** on if you need the rollback to bypass the activity-window guard (most rollback scenarios qualify — you're rolling back precisely because the running version is misbehaving).
3. Wait for the next hourly tick. Lab PCs running an auto-update-capable build will downgrade themselves; PCs being upgraded manually need a `data-hub-watcher self-update` (or `uv tool install data-hub-watcher==0.2.5` if `self-update` itself is what's broken).
4. Once the fleet has converged, toggle **Mandatory update** back off.

There's no separate "yank" step — a rolled-back release is still on PyPI and still reinstallable, just not advertised by `/update-check`.

## Troubleshooting

### Common

#### `update_started` is followed by `update_failed`

The upgrade subprocess started but didn't end up running the new version. The `details.reason` field tells you which sub-case fired:

- `subprocess raised: …` — `subprocess.run` raised before exec. Usually `FileNotFoundError` because `uv` isn't on PATH for the service account. Check the watcher log for the full traceback.
- `subprocess exited <N>` — the upgrade command itself failed. Event details include the last 1000 bytes of stdout/stderr; most often a transient PyPI failure or the version not yet existing on the index.
- `expected '<target>' after upgrade, running '<current>'` — install succeeded, restart succeeded, but the running interpreter still imports the old version. Usually a stale `__pycache__` or a separate copy on `sys.path`. Run `uv tool uninstall data-hub-watcher && uv tool install data-hub-watcher==<target>` as the service account.

#### `update_failed` without a preceding `update_started`

`details.attempted_subprocess: false` means the auto-updater refused before running the upgrade. The most common `details.reason`:

- `install method '<editable|unknown>' not eligible for auto-update` — the watcher detected a development install and refused to shadow your source tree. Switch the host to a PyPI install (`uv tool install data-hub-watcher`); on a developer machine, ignore the event. Throttled to one emission per server target.

#### Auto-update never fires

Check, in order:

- The watcher is running as a service, not in a console window.
- The environment isn't `preview` (auto-update is hard-disabled there).
- The activity-window guard isn't holding things up. Use `data-hub-watcher self-update` for an immediate upgrade, or toggle **Mandatory update** if the release warrants it.
- The dashboard's **Last Heartbeat** is recent. A stale watcher isn't ticking and won't auto-update.

#### `self-update --check` says "(none configured)"

**Settings → Watchers** has a blank **Latest version** for that environment. Benign — the CLI returns successfully and treats it as "no update available".

#### "Refusing to self-update an editable / unknown install"

You're running from a checkout (`uv sync --all-packages`). Upgrade manually with `git pull && uv sync`. To switch a developer machine onto a PyPI build, `uv tool install data-hub-watcher` from a separate shell gets you a parallel install on PATH.

#### A failed upgrade left a stale marker

`~/.data-hub/.upgrade-in-progress` is consumed and deleted on the next clean startup. If it persists across multiple restarts, the watcher is failing to start at all — fix the underlying startup issue and delete the marker.

#### Where to find the raw installer transcript

| Install path                    | Log file                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-process (POSIX, Windows pip) | `~/.data-hub/watcher.log` (`C:\ProgramData\DataHubWatcher\watcher.log` on Windows) — subprocess output prefixed `Upgrade subprocess stdout/stderr tail:`. |
| Windows uv-tool worker          | `~/.data-hub/upgrade-worker.log` — every line of uv's output with a UTC timestamp.                                                                    |

Both files are append-only and survive service restarts.

### Windows uv-tool specifics

#### `update_failed` with `reason: "scheduled task could not be triggered…"`

The watcher tried to dispatch through the `DataHubWatcherUpgrade` Scheduled Task but `schtasks /Run` refused. Two causes:

- **Task not registered** (most common on first auto-update into a worker-aware build). Open an Administrator PowerShell and run `data-hub-watcher service reinstall` — it registers the task and restarts the service.
- **Service account can't talk to Task Scheduler** (`details.schtasks_stderr` shows "Access is denied"). Reinstall the service under `LocalSystem` (the default) via `service reinstall`.

The watcher self-heals on the next service start by re-registering a missing task, so a single SCM-driven restart often resolves this without operator action.

#### `update_failed` with `details.worker_result_missing: true`

The worker dispatched but never wrote `~/.data-hub/.upgrade-result.json` — usually a PowerShell crash between `Stop-Service` and the `uv` invocation, or Task Scheduler killing the worker. Open `~/.data-hub/upgrade-worker.log` for the captured output. The service still comes back up regardless.

#### Worker reported success but the dashboard shows `update_failed`

The post-restart evaluator trusts the worker's `succeeded` flag over the marker's version comparison. If `uv` exited non-zero but the install moved the version forward, you still get `update_failed` with the real installer error in `worker_stderr_tail`. The marker's classification is preserved in `details.marker_succeeded` / `details.marker_reason` for debugging.

#### `self-update` reports "Upgrade dispatched" but nothing happens

The CLI returns as soon as the Scheduled Task accepts the request — the install runs out-of-process under SYSTEM and takes 30–60s. Track progress with:

```powershell
Get-Service data-hub-watcher           # cycles Stopped -> Start Pending -> Running
Get-Content ~/.data-hub/upgrade-worker.log -Tail 20 -Wait
```

The dashboard event lands once the new service process boots and reads the marker + result sentinel.
