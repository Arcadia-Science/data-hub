"""Self-update orchestration for the watcher package.

This module is intentionally framework-agnostic so it can be driven from
two places:

* `data-hub-watcher self-update` — the operator-facing CLI command,
  scheduled e.g. via Windows Task Scheduler.
* An in-process updater invoked from the running service during idle
  windows (added on top of these helpers).

Both paths need to answer the same questions: how is this watcher
installed, what command upgrades it, and is a newer version actually
available? Keeping that logic here makes it unit-testable without
spinning up a Click context or a real Windows service.
"""

from __future__ import annotations
import json
import logging
import shutil
import subprocess
import sys
from dataclasses import dataclass
from enum import Enum
from importlib.metadata import PackageNotFoundError, distribution
from typing import Any

from packaging.version import InvalidVersion, Version

from data_hub_watcher.constants import WATCHER_VERSION
from data_hub_watcher.models import WatcherUpdateInfoResponse

logger = logging.getLogger(__name__)

PACKAGE_NAME = "data-hub-watcher"

# Default index for `pip install` invocations. PyPI is hard-coded for now;
# can be made configurable per channel later.
DEFAULT_INDEX_URL = "https://pypi.org/simple/"


class InstallMethod(str, Enum):
    """How the running watcher distribution was installed.

    The value drives which subprocess we spawn to upgrade in place.
    """

    UV_TOOL = "uv-tool"
    """Installed via `uv tool install data-hub-watcher`. Upgrade by
    re-running `uv tool upgrade data-hub-watcher`."""

    PIP = "pip"
    """Installed into a regular venv via pip (or uv pip). Upgrade by
    re-running `<sys.executable> -m pip install -U data-hub-watcher`."""

    EDITABLE = "editable"
    """Installed editable from a local checkout (e.g. workspace `uv sync`).
    Refuse to self-update — the developer should `git pull && uv sync`
    instead. Auto-updating an editable install would silently shadow the
    source tree with an index-built copy."""

    UNKNOWN = "unknown"
    """Distribution metadata couldn't be located. Treat as a hard error;
    we can't safely upgrade something we can't even find."""


@dataclass
class UpdateDecision:
    """Outcome of comparing the local version against server-reported info.

    Captures *why* we decided what we decided so callers can produce
    actionable log lines and `UPDATE_*` events.
    """

    should_update: bool
    reason: str
    current_version: str
    target_version: str | None


# ---------------------------------------------------------------------------
# Install-method detection
# ---------------------------------------------------------------------------


def detect_install_method(prefix: str | None = None) -> InstallMethod:
    """Inspect distribution metadata + `sys.prefix` to classify the install.

    *prefix* defaults to ``sys.prefix`` and is overridable for tests.

    Detection order matters: we read `direct_url.json` first because an
    editable install may also live inside a uv-managed prefix and we'd
    rather refuse to upgrade an editable checkout than silently overwrite
    it with an index build.
    """
    try:
        dist = distribution(PACKAGE_NAME)
    except PackageNotFoundError:
        return InstallMethod.UNKNOWN

    # PEP 610 — pip / uv write a `direct_url.json` file alongside the dist
    # info when a package was installed from a non-index source. The
    # `dir_info.editable` flag is the canonical signal for `pip install -e`
    # and `uv sync` workspace installs.
    direct_url_text = dist.read_text("direct_url.json")
    if direct_url_text:
        try:
            direct_url = json.loads(direct_url_text)
        except json.JSONDecodeError:
            direct_url = {}
        if isinstance(direct_url, dict):
            dir_info = direct_url.get("dir_info") or {}
            if isinstance(dir_info, dict) and dir_info.get("editable"):
                return InstallMethod.EDITABLE

    raw_prefix = prefix or sys.prefix
    # Normalize backslashes manually so the substring check works on a
    # Windows-style path even when this runs on a POSIX test host (where
    # `Path(...).as_posix()` would still keep the backslashes intact).
    prefix_posix = raw_prefix.replace("\\", "/")
    if "/uv/tools/data-hub-watcher" in prefix_posix:
        return InstallMethod.UV_TOOL

    return InstallMethod.PIP


# ---------------------------------------------------------------------------
# Version comparison
# ---------------------------------------------------------------------------


def _safe_parse(version_str: str | None) -> Version | None:
    if not version_str:
        return None
    try:
        return Version(version_str)
    except InvalidVersion:
        logger.warning("Ignoring un-parseable version string: %r", version_str)
        return None


def evaluate_update(
    info: WatcherUpdateInfoResponse,
    *,
    current_version: str = WATCHER_VERSION,
    force: bool = False,
) -> UpdateDecision:
    """Decide whether the running watcher should upgrade.

    `force=True` short-circuits the version comparison and always returns
    `should_update=True` (as long as the server reports a target). Used
    by the `--force` flag on the CLI for ops debugging.
    """
    target = info.latest_version
    if target is None:
        return UpdateDecision(
            should_update=False,
            reason="server has no release info configured",
            current_version=current_version,
            target_version=None,
        )

    current = _safe_parse(current_version)
    target_v = _safe_parse(target)

    if force:
        return UpdateDecision(
            should_update=target_v is not None,
            reason="forced by caller",
            current_version=current_version,
            target_version=target,
        )

    if current is None or target_v is None:
        # If either side is un-parseable we can't make a safe ordering
        # decision; refuse the update rather than risk a downgrade.
        return UpdateDecision(
            should_update=False,
            reason="could not compare versions",
            current_version=current_version,
            target_version=target,
        )

    if info.mandatory and current != target_v:
        return UpdateDecision(
            should_update=True,
            reason="server marked release as mandatory",
            current_version=current_version,
            target_version=target,
        )

    if current >= target_v:
        return UpdateDecision(
            should_update=False,
            reason="already at or ahead of target",
            current_version=current_version,
            target_version=target,
        )

    return UpdateDecision(
        should_update=True,
        reason="newer version available",
        current_version=current_version,
        target_version=target,
    )


# ---------------------------------------------------------------------------
# Upgrade execution
# ---------------------------------------------------------------------------


def build_upgrade_command(
    method: InstallMethod,
    *,
    target_version: str | None = None,
    index_url: str | None = None,
    python_executable: str | None = None,
    uv_executable: str | None = None,
) -> list[str]:
    """Translate an install method into the concrete subprocess argv.

    Pinning *target_version* lets the server roll a specific release out
    rather than always landing on whatever the index calls "latest" — which
    matters when we want to roll back by re-pinning to an older version.
    """
    pkg_spec = PACKAGE_NAME if not target_version else f"{PACKAGE_NAME}=={target_version}"
    index = index_url or DEFAULT_INDEX_URL

    if method is InstallMethod.UV_TOOL:
        uv_path = uv_executable or shutil.which("uv") or "uv"
        # `uv tool install --reinstall` is more deterministic than `upgrade`
        # — it works whether or not the previous version is already at the
        # target, and it lets us pin to an explicit version for rollback.
        cmd = [uv_path, "tool", "install", "--reinstall"]
        if target_version:
            cmd += ["--index-url", index]
        cmd.append(pkg_spec)
        return cmd

    if method is InstallMethod.PIP:
        py = python_executable or sys.executable
        cmd = [py, "-m", "pip", "install", "--upgrade", "--index-url", index, pkg_spec]
        return cmd

    raise ValueError(
        f"Cannot build an upgrade command for install method {method.value!r}; "
        "only uv-tool and pip installs support self-update."
    )


def run_upgrade(
    method: InstallMethod,
    *,
    target_version: str | None = None,
    index_url: str | None = None,
    runner: Any = subprocess.run,
) -> subprocess.CompletedProcess[str]:
    """Execute the upgrade subprocess and capture stdout/stderr.

    *runner* is injected so unit tests can assert on the argv without
    actually shelling out. The default runs `subprocess.run` with text mode
    + captured output so callers can log it.
    """
    if method in (InstallMethod.EDITABLE, InstallMethod.UNKNOWN):
        raise RuntimeError(
            f"Refusing to self-update install method {method.value!r}: "
            "this looks like a development checkout. "
            "Upgrade manually with `git pull && uv sync` instead."
        )

    cmd = build_upgrade_command(method, target_version=target_version, index_url=index_url)
    logger.info("Running watcher self-update: %s", " ".join(cmd))
    return runner(cmd, capture_output=True, text=True, check=False)
