"""Out-of-process Windows upgrade worker scaffolding.

On Windows, ``uv tool install --reinstall`` recreates the venv's
``Scripts\\`` directory, including the ``python.exe`` that the running
service was launched with. Windows takes an exclusive lock on any
mapped executable, so the in-process upgrade subprocess fails with
``Access is denied. (os error 5)`` when it tries to remove that
directory. This is a structural problem, not a permissions one — we
need to drive the upgrade from a process tree that does *not* contain
the service's interpreter.

The fix lives in three pieces:

1. This module defines the on-disk **sentinels** the watcher uses to
   communicate with the worker (``.upgrade-request.json`` for the
   inbound request, ``.upgrade-result.json`` for the outbound result),
   the **package spec** computed from the current install (preserving
   any extras that were originally installed — historically the
   in-process path silently dropped ``[windows-service]`` and broke
   pywin32), and the **PowerShell worker template** itself.
2. :mod:`data_hub_watcher.scheduled_task` drops the rendered worker
   onto disk and registers it as an on-demand SYSTEM-owned Windows
   Scheduled Task.
3. :mod:`data_hub_watcher.updater` and ``cli.self_update`` write the
   request sentinel and trigger the task instead of running ``uv``
   themselves on Windows uv-tool installs.

The worker is intentionally pure PowerShell. We do not invoke any
Python script for it because any Python interpreter spawned from the
watcher's venv would re-lock ``Scripts\\python.exe`` and reproduce the
original problem, and bringing in a second standalone Python solely
for the upgrade would balloon the install footprint on every lab PC.

This module is import-safe on every platform (no win32 imports) so the
templating and sentinel helpers can be unit-tested on the Linux CI
runner.
"""

from __future__ import annotations
import json
import logging
import os
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path
from typing import Any

from data_hub_watcher.self_update import PACKAGE_NAME, InstallMethod

logger = logging.getLogger(__name__)


UPGRADE_REQUEST_FILENAME = ".upgrade-request.json"
UPGRADE_RESULT_FILENAME = ".upgrade-result.json"
UPGRADE_WORKER_SCRIPT_FILENAME = "upgrade-worker.ps1"
UPGRADE_WORKER_LOG_FILENAME = "upgrade-worker.log"

# The sole optional extra the watcher publishes today. Hard-coded
# rather than discovered dynamically because (a) extras detection from
# installed metadata is unreliable across pip / uv versions, and
# (b) on Windows a missing ``pywin32`` always breaks the service —
# so we'd rather over-include it on a pip install than silently drop
# it on a uv-tool reinstall.
WINDOWS_SERVICE_EXTRA = "windows-service"


# ---------------------------------------------------------------------------
# Sentinels
# ---------------------------------------------------------------------------


def upgrade_request_path(config_dir: Path) -> Path:
    return config_dir / UPGRADE_REQUEST_FILENAME


def upgrade_result_path(config_dir: Path) -> Path:
    return config_dir / UPGRADE_RESULT_FILENAME


def upgrade_worker_script_path(config_dir: Path) -> Path:
    return config_dir / UPGRADE_WORKER_SCRIPT_FILENAME


def upgrade_worker_log_path(config_dir: Path) -> Path:
    return config_dir / UPGRADE_WORKER_LOG_FILENAME


@dataclass
class UpgradeRequest:
    """Inbound request the watcher writes for the worker to consume.

    Carries the package spec the worker should pass to ``uv``, the
    target version (informational, used for the result event), and a
    request_id (uuid4) so the worker can stamp its result with the
    same value — letting the post-restart event evaluation correlate
    a result back to the request that produced it.
    """

    target_version: str
    pkg_spec: str
    uv_executable: str
    index_url: str
    request_id: str
    requested_at: str
    previous_version: str
    install_method: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "target_version": self.target_version,
            "pkg_spec": self.pkg_spec,
            "uv_executable": self.uv_executable,
            "index_url": self.index_url,
            "request_id": self.request_id,
            "requested_at": self.requested_at,
            "previous_version": self.previous_version,
            "install_method": self.install_method,
        }


@dataclass
class UpgradeResult:
    """Outbound result the worker writes once ``uv`` finishes.

    The post-restart event-evaluation in :mod:`data_hub_watcher.runtime`
    merges these fields into the ``UPDATE_SUCCEEDED`` /
    ``UPDATE_FAILED`` event so the dashboard sees the same level of
    detail it used to get from the in-process subprocess
    (``stdout_tail``, ``stderr_tail``, ``returncode``). If the worker
    crashes between ``Stop-Service`` and writing this file the result
    sentinel is absent and the event falls back to a generic
    "worker did not write result" reason.
    """

    request_id: str
    target_version: str
    succeeded: bool
    returncode: int | None
    stdout_tail: str
    stderr_tail: str
    finished_at: str
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "target_version": self.target_version,
            "succeeded": self.succeeded,
            "returncode": self.returncode,
            "stdout_tail": self.stdout_tail,
            "stderr_tail": self.stderr_tail,
            "finished_at": self.finished_at,
            "error": self.error,
        }


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write *payload* as JSON to *path* atomically.

    Use a tempfile + ``os.replace`` so a reader never observes a
    partially-written sentinel (the worker polls for the request file
    immediately after the task is triggered, so a torn write would
    masquerade as a corrupt request).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def write_upgrade_request(
    config_dir: Path,
    *,
    target_version: str,
    pkg_spec: str,
    uv_executable: str,
    index_url: str,
    previous_version: str,
    install_method: str,
    request_id: str | None = None,
) -> UpgradeRequest:
    """Persist a request sentinel and return the resulting :class:`UpgradeRequest`.

    *request_id* defaults to a fresh uuid4. Callers (the updater and
    the CLI) generally don't pass it; tests do, so they can pin the
    sentinel contents deterministically.
    """
    req = UpgradeRequest(
        target_version=target_version,
        pkg_spec=pkg_spec,
        uv_executable=uv_executable,
        index_url=index_url,
        request_id=request_id or str(uuid.uuid4()),
        requested_at=datetime.now(timezone.utc).isoformat(),
        previous_version=previous_version,
        install_method=install_method,
    )
    _atomic_write_json(upgrade_request_path(config_dir), req.to_dict())
    return req


def read_upgrade_request(config_dir: Path) -> UpgradeRequest | None:
    """Read and return the request sentinel, or ``None`` if absent.

    Does not delete the file — the worker is responsible for cleanup
    once it has written its result. Used by tests + (eventually) any
    diagnostic CLI that wants to inspect a stuck dispatch.
    """
    path = upgrade_request_path(config_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return UpgradeRequest(
            target_version=str(data["target_version"]),
            pkg_spec=str(data["pkg_spec"]),
            uv_executable=str(data["uv_executable"]),
            index_url=str(data["index_url"]),
            request_id=str(data["request_id"]),
            requested_at=str(data["requested_at"]),
            previous_version=str(data["previous_version"]),
            install_method=str(data["install_method"]),
        )
    except (KeyError, TypeError):
        return None


def clear_upgrade_request(config_dir: Path) -> None:
    upgrade_request_path(config_dir).unlink(missing_ok=True)


def read_upgrade_result(config_dir: Path) -> UpgradeResult | None:
    """Read and return the worker's result sentinel, or ``None`` if absent.

    Lifecycle parallels the upgrade marker in :mod:`updater`: the
    runtime reads the result on the post-restart inspection and then
    deletes it via :func:`clear_upgrade_result` so a stale result from
    a prior upgrade can't leak into the next one.
    """
    path = upgrade_result_path(config_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return UpgradeResult(
            request_id=str(data["request_id"]),
            target_version=str(data["target_version"]),
            succeeded=bool(data["succeeded"]),
            returncode=(int(data["returncode"]) if data.get("returncode") is not None else None),
            stdout_tail=str(data.get("stdout_tail", "")),
            stderr_tail=str(data.get("stderr_tail", "")),
            finished_at=str(data["finished_at"]),
            error=(str(data["error"]) if data.get("error") is not None else None),
        )
    except (KeyError, TypeError, ValueError):
        return None


def clear_upgrade_result(config_dir: Path) -> None:
    upgrade_result_path(config_dir).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Package spec
# ---------------------------------------------------------------------------


def detect_installed_extras() -> list[str]:
    """Return the list of extras the running watcher install has.

    Best-effort: we only care about the ``windows-service`` extra
    today. On any platform other than Windows (including all CI
    runners) we return an empty list so this function is a no-op.

    Detection strategy: probe the dist's ``Provides-Extra`` metadata
    *and* check whether ``pywin32`` is importable in the current
    interpreter. The two together are stable across pip / uv install
    histories — extras tracking is notoriously inconsistent in dist
    metadata across package managers, so we treat "the extra was
    advertised AND its dependency satisfied" as the signal that the
    operator wanted it.
    """
    if sys.platform != "win32":
        return []

    extras: list[str] = []
    try:
        dist = distribution(PACKAGE_NAME)
    except PackageNotFoundError:
        return extras

    advertised: list[str] = []
    metadata = dist.metadata
    for key, value in metadata.items():
        if key == "Provides-Extra" and isinstance(value, str):
            advertised.append(value.strip())

    if WINDOWS_SERVICE_EXTRA in advertised:
        try:
            import pywin32  # type: ignore[import-not-found]  # noqa: F401

            extras.append(WINDOWS_SERVICE_EXTRA)
        except Exception:
            try:
                import win32service  # type: ignore[import-not-found]  # noqa: F401

                extras.append(WINDOWS_SERVICE_EXTRA)
            except Exception:
                pass

    return extras


def build_pkg_spec(
    method: InstallMethod,
    *,
    target_version: str | None = None,
    extras: list[str] | None = None,
) -> str:
    """Produce the ``data-hub-watcher[extras]==X.Y.Z`` spec for ``uv``/``pip``.

    Used by both the in-process upgrade path and the worker so the two
    paths can never disagree on what gets reinstalled. The Windows
    service install historically broke after a self-update because the
    in-process path passed bare ``data-hub-watcher==X.Y.Z`` — silently
    dropping the ``[windows-service]`` extra and uninstalling
    ``pywin32``. Rebuilding the spec via this helper closes that gap.
    """
    if method in (InstallMethod.EDITABLE, InstallMethod.UNKNOWN):
        raise ValueError(f"Cannot build a package spec for install method {method.value!r}")

    if extras:
        # Sort for deterministic output so the rendered worker script
        # is byte-identical across runs (matters for the golden-string
        # test and for change detection in the dropped script).
        extras_part = f"[{','.join(sorted(extras))}]"
    else:
        extras_part = ""
    spec = f"{PACKAGE_NAME}{extras_part}"
    if target_version:
        spec = f"{spec}=={target_version}"
    return spec


# ---------------------------------------------------------------------------
# PowerShell worker template
# ---------------------------------------------------------------------------


# The worker does the bare minimum needed to break the file-lock loop:
#   1. Stop the service (releases Scripts\python.exe).
#   2. Run `uv tool install --reinstall` capturing stdout/stderr.
#   3. Write a result sentinel so the post-restart event has the
#      subprocess output to attach to UPDATE_SUCCEEDED / UPDATE_FAILED.
#   4. Start the service again so the new wheel takes effect.
#
# Everything is wrapped in try/finally so a crash inside `uv` still
# produces a result sentinel and still attempts to restart the service —
# leaving the host with a stopped service after a botched upgrade would
# be the worst possible failure mode.
#
# Logging is duplicated to a rolling text log under ~/.data-hub so an
# operator on the lab PC can debug a stuck task without relying on the
# Task Scheduler History pane (which is off by default on most fleet
# images).
WORKER_SCRIPT_TEMPLATE = """\
# data-hub-watcher upgrade worker (auto-generated; do not edit by hand)
# Generated: {generated_at}
$ErrorActionPreference = "Stop"

$ServiceName  = "{service_name}"
$RequestPath  = "{request_path}"
$ResultPath   = "{result_path}"
$LogPath      = "{log_path}"

function Write-Log($msg) {{
    $ts = (Get-Date).ToUniversalTime().ToString("o")
    $line = "$ts $msg"
    Add-Content -LiteralPath $LogPath -Value $line -ErrorAction SilentlyContinue
}}

function Write-ResultJson($payload) {{
    $tmp = "$ResultPath.tmp"
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $ResultPath -Force
}}

function Tail-Text($text, $maxLen) {{
    if (-not $text) {{ return "" }}
    if ($text.Length -le $maxLen) {{ return $text }}
    return $text.Substring($text.Length - $maxLen)
}}

Write-Log "upgrade-worker starting"

if (-not (Test-Path -LiteralPath $RequestPath)) {{
    Write-Log "no request sentinel at $RequestPath; nothing to do"
    exit 0
}}

try {{
    $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
}} catch {{
    Write-Log "failed to parse request sentinel: $_"
    exit 1
}}

$RequestId = [string]$request.request_id
$Target    = [string]$request.target_version
$PkgSpec   = [string]$request.pkg_spec
$UvExe     = [string]$request.uv_executable
$IndexUrl  = [string]$request.index_url

Write-Log "request_id=$RequestId target=$Target pkg_spec=$PkgSpec uv=$UvExe"

$stdoutTail  = ""
$stderrTail  = ""
$returncode  = $null
$succeeded   = $false
$errorText   = $null

try {{
    Write-Log "stopping service $ServiceName"
    try {{
        Stop-Service -Name $ServiceName -Force -ErrorAction Stop
        Write-Log "service stopped"
    }} catch {{
        Write-Log "stop-service failed (continuing): $_"
    }}

    # Give Windows a moment to fully release Scripts\\python.exe even
    # after the service control manager reports the service as stopped.
    Start-Sleep -Seconds 2

    # `--index-url` is always passed because the worker is only ever
    # triggered for a pinned target version (the dispatch-side guards
    # in ``_apply_via_worker`` and ``_dispatch_self_update_via_worker``
    # both refuse to write a request without one). Mirrors
    # ``build_upgrade_command``'s argv shape exactly so the worker and
    # the in-process path produce equivalent uv invocations.
    $uvArgs = @("tool", "install", "--reinstall", "--index-url", $IndexUrl, $PkgSpec)

    Write-Log "running: $UvExe $($uvArgs -join ' ')"

    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    try {{
        $proc = Start-Process -FilePath $UvExe -ArgumentList $uvArgs `
            -RedirectStandardOutput $stdoutFile `
            -RedirectStandardError $stderrFile `
            -NoNewWindow -Wait -PassThru
        $returncode = $proc.ExitCode
        $stdout = Get-Content -LiteralPath $stdoutFile -Raw -ErrorAction SilentlyContinue
        $stderr = Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue
        $stdoutTail = Tail-Text $stdout 1000
        $stderrTail = Tail-Text $stderr 1000
        $succeeded = ($returncode -eq 0)
        Write-Log "uv exited $returncode"
        # Always echo uv's output to the worker log so an operator
        # tailing it on the lab PC sees the install transcript even
        # if the result sentinel is later consumed / cleared. We
        # split on lines so each entry has its own UTC timestamp,
        # which makes interleaving with surrounding log lines
        # readable.
        if ($stdout) {{
            foreach ($line in ($stdout -split "`r?`n")) {{
                if ($line) {{ Write-Log "uv stdout: $line" }}
            }}
        }}
        if ($stderr) {{
            foreach ($line in ($stderr -split "`r?`n")) {{
                if ($line) {{ Write-Log "uv stderr: $line" }}
            }}
        }}
    }} finally {{
        Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }}
}} catch {{
    $errorText = "$_"
    Write-Log "worker raised: $errorText"
}} finally {{
    $payload = @{{
        request_id     = $RequestId
        target_version = $Target
        succeeded      = $succeeded
        returncode     = $returncode
        stdout_tail    = $stdoutTail
        stderr_tail    = $stderrTail
        finished_at    = (Get-Date).ToUniversalTime().ToString("o")
        error          = $errorText
    }}
    try {{
        Write-ResultJson $payload
        Write-Log "wrote result sentinel"
    }} catch {{
        Write-Log "failed to write result sentinel: $_"
    }}

    Remove-Item -LiteralPath $RequestPath -Force -ErrorAction SilentlyContinue

    Write-Log "starting service $ServiceName"
    try {{
        Start-Service -Name $ServiceName -ErrorAction Stop
        Write-Log "service started"
    }} catch {{
        Write-Log "start-service failed: $_"
    }}
}}

Write-Log "upgrade-worker exiting"
"""


def render_worker_script(
    *,
    service_name: str,
    request_path: Path,
    result_path: Path,
    log_path: Path,
    generated_at: str | None = None,
) -> str:
    """Render :data:`WORKER_SCRIPT_TEMPLATE` with concrete paths.

    Pure string templating so the rendering is unit-testable on POSIX.
    The actual ``uv`` path is not baked in — the worker reads it from
    the request sentinel so a post-install relocation of ``uv.exe``
    doesn't require regenerating the script.

    The ``.upgrade-in-progress`` marker is intentionally not handed to
    the worker: its full lifecycle (write before dispatch, evaluate
    and clear on the next process start) lives on the Python side in
    :mod:`data_hub_watcher.updater` and :mod:`data_hub_watcher.runtime`.
    """
    return WORKER_SCRIPT_TEMPLATE.format(
        generated_at=(generated_at or datetime.now(timezone.utc).isoformat()),
        service_name=service_name,
        request_path=str(request_path),
        result_path=str(result_path),
        log_path=str(log_path),
    )


def write_worker_script(
    config_dir: Path,
    *,
    service_name: str,
    generated_at: str | None = None,
) -> Path:
    """Render the worker script and drop it under *config_dir*.

    Returns the resulting path so callers (the service installer) can
    hand it to ``schtasks`` as the action target.
    """
    script_path = upgrade_worker_script_path(config_dir)
    script = render_worker_script(
        service_name=service_name,
        request_path=upgrade_request_path(config_dir),
        result_path=upgrade_result_path(config_dir),
        log_path=upgrade_worker_log_path(config_dir),
        generated_at=generated_at,
    )
    script_path.parent.mkdir(parents=True, exist_ok=True)
    script_path.write_text(script, encoding="utf-8")
    return script_path
