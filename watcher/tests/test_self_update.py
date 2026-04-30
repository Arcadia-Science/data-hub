"""Unit tests for `data_hub_watcher.self_update`.

The self-update path runs in unattended contexts (Windows Task Scheduler,
the in-process updater on the running service) where a wrong decision
can downgrade a fleet of watchers. These tests pin the install-method
detection, the version-comparison decision matrix, and the
upgrade-command synthesis so regressions surface as clear test failures.
"""

from __future__ import annotations
import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from data_hub_watcher.models import WatcherUpdateInfoResponse
from data_hub_watcher.self_update import (
    DEFAULT_INDEX_URL,
    PACKAGE_NAME,
    InstallMethod,
    UpdateDecision,
    build_upgrade_command,
    detect_install_method,
    evaluate_update,
    run_upgrade,
)

# ---------------------------------------------------------------------------
# Install-method detection
# ---------------------------------------------------------------------------


class _FakeDist:
    def __init__(self, direct_url: dict[str, Any] | None) -> None:
        self._direct_url = direct_url

    def read_text(self, name: str) -> str | None:
        if name != "direct_url.json":
            return None
        if self._direct_url is None:
            return None
        return json.dumps(self._direct_url)


def _patch_distribution(direct_url: dict[str, Any] | None) -> Any:
    """Replace `importlib.metadata.distribution` for the duration of a test."""
    return patch(
        "data_hub_watcher.self_update.distribution",
        return_value=_FakeDist(direct_url),
    )


class TestDetectInstallMethod:
    def test_returns_unknown_when_distribution_missing(self) -> None:
        from importlib.metadata import PackageNotFoundError

        with patch(
            "data_hub_watcher.self_update.distribution",
            side_effect=PackageNotFoundError(PACKAGE_NAME),
        ):
            assert detect_install_method() is InstallMethod.UNKNOWN

    def test_returns_editable_for_dir_info_editable_true(self) -> None:
        with _patch_distribution({"dir_info": {"editable": True}, "url": "file:///x"}):
            assert detect_install_method() is InstallMethod.EDITABLE

    def test_returns_uv_tool_when_prefix_under_uv_tools(self) -> None:
        with _patch_distribution(None):
            prefix = "/home/user/.local/share/uv/tools/data-hub-watcher"
            assert detect_install_method(prefix=prefix) is InstallMethod.UV_TOOL

    def test_returns_uv_tool_on_windows_path(self) -> None:
        with _patch_distribution(None):
            prefix = r"C:\Users\lab\AppData\Roaming\uv\tools\data-hub-watcher"
            # On a non-Windows test runner Path.resolve() will keep the raw
            # string, so we assert the substring match still works after
            # `as_posix()` normalization.
            assert detect_install_method(prefix=prefix) is InstallMethod.UV_TOOL

    def test_returns_pip_for_plain_venv(self) -> None:
        with _patch_distribution(None):
            assert (
                detect_install_method(prefix="/home/user/projects/foo/.venv") is InstallMethod.PIP
            )

    def test_editable_takes_precedence_over_uv_tools_path(self) -> None:
        # If a dev somehow has an editable install whose .venv lives under a
        # `uv/tools/` directory, we must still refuse to upgrade — editable
        # wins over the path heuristic.
        with _patch_distribution({"dir_info": {"editable": True}, "url": "file:///x"}):
            prefix = "/home/user/.local/share/uv/tools/data-hub-watcher"
            assert detect_install_method(prefix=prefix) is InstallMethod.EDITABLE

    def test_malformed_direct_url_falls_back_to_path_heuristic(self) -> None:
        with patch(
            "data_hub_watcher.self_update.distribution",
            return_value=_FakeDist(direct_url=None),
        ):
            # Simulate present-but-malformed JSON via a custom fake dist.
            class _BadDist:
                def read_text(self, name: str) -> str:
                    return "not-json"

            with patch(
                "data_hub_watcher.self_update.distribution",
                return_value=_BadDist(),
            ):
                assert detect_install_method(prefix="/opt/venv") is InstallMethod.PIP


# ---------------------------------------------------------------------------
# Version comparison
# ---------------------------------------------------------------------------


def _info(
    *,
    latest: str | None = "0.3.0",
    minimum: str | None = None,
    channel: str = "stable",
    mandatory: bool = False,
) -> WatcherUpdateInfoResponse:
    return WatcherUpdateInfoResponse(
        latest_version=latest,
        min_supported_version=minimum,
        channel=channel,
        mandatory=mandatory,
    )


class TestEvaluateUpdate:
    def test_no_target_means_no_update(self) -> None:
        decision = evaluate_update(_info(latest=None), current_version="0.1.0")
        assert decision == UpdateDecision(
            should_update=False,
            reason="server has no release info configured",
            current_version="0.1.0",
            target_version=None,
        )

    def test_current_older_than_target_triggers_update(self) -> None:
        decision = evaluate_update(_info(latest="0.3.0"), current_version="0.1.0")
        assert decision.should_update is True
        assert decision.target_version == "0.3.0"

    def test_current_equals_target_skips_update(self) -> None:
        decision = evaluate_update(_info(latest="0.3.0"), current_version="0.3.0")
        assert decision.should_update is False
        assert "already at or ahead" in decision.reason

    def test_current_newer_than_target_skips_update(self) -> None:
        # Operators sometimes test a pre-release locally — never auto-downgrade.
        decision = evaluate_update(_info(latest="0.3.0"), current_version="0.4.0")
        assert decision.should_update is False

    def test_mandatory_forces_update_even_for_dev_pre_release(self) -> None:
        # A mandatory rollout exists to evict known-buggy versions; the
        # comparison must still be != rather than > so a pre-release
        # operator is also forced back onto the canonical release.
        decision = evaluate_update(
            _info(latest="0.3.0", mandatory=True),
            current_version="0.4.0.dev1",
        )
        assert decision.should_update is True
        assert "mandatory" in decision.reason

    def test_force_flag_overrides_skip_decision(self) -> None:
        decision = evaluate_update(
            _info(latest="0.3.0"),
            current_version="0.3.0",
            force=True,
        )
        assert decision.should_update is True
        assert "forced" in decision.reason

    def test_force_with_no_target_still_skips(self) -> None:
        decision = evaluate_update(
            _info(latest=None),
            current_version="0.1.0",
            force=True,
        )
        assert decision.should_update is False

    def test_unparseable_current_version_skips_update(self) -> None:
        decision = evaluate_update(
            _info(latest="0.3.0"),
            current_version="garbage",
        )
        assert decision.should_update is False
        assert "could not compare" in decision.reason


# ---------------------------------------------------------------------------
# Upgrade command synthesis
# ---------------------------------------------------------------------------


class TestBuildUpgradeCommand:
    def test_uv_tool_uses_install_reinstall(self) -> None:
        cmd = build_upgrade_command(
            InstallMethod.UV_TOOL,
            target_version="0.3.0",
            uv_executable="/usr/local/bin/uv",
        )
        assert cmd == [
            "/usr/local/bin/uv",
            "tool",
            "install",
            "--reinstall",
            "--index-url",
            DEFAULT_INDEX_URL,
            "data-hub-watcher==0.3.0",
        ]

    def test_uv_tool_without_target_version_drops_index(self) -> None:
        cmd = build_upgrade_command(InstallMethod.UV_TOOL, uv_executable="uv")
        assert cmd == ["uv", "tool", "install", "--reinstall", "data-hub-watcher"]

    def test_pip_uses_current_python_executable(self) -> None:
        cmd = build_upgrade_command(
            InstallMethod.PIP,
            target_version="0.3.0",
            python_executable="/opt/venv/bin/python",
        )
        assert cmd == [
            "/opt/venv/bin/python",
            "-m",
            "pip",
            "install",
            "--upgrade",
            "--index-url",
            DEFAULT_INDEX_URL,
            "data-hub-watcher==0.3.0",
        ]

    def test_custom_index_url_is_propagated(self) -> None:
        # Exercises the `index_url` passthrough that an internal PyPI
        # mirror or air-gapped lab proxy would set.
        cmd = build_upgrade_command(
            InstallMethod.PIP,
            target_version="0.3.0",
            index_url="https://pypi.example.com/simple/",
            python_executable="python",
        )
        assert "https://pypi.example.com/simple/" in cmd

    @pytest.mark.parametrize("method", [InstallMethod.EDITABLE, InstallMethod.UNKNOWN])
    def test_unsupported_methods_raise(self, method: InstallMethod) -> None:
        with pytest.raises(ValueError, match="Cannot build an upgrade command"):
            build_upgrade_command(method, target_version="0.3.0")


# ---------------------------------------------------------------------------
# Upgrade execution wiring
# ---------------------------------------------------------------------------


class TestRunUpgrade:
    def test_invokes_runner_with_built_command(self) -> None:
        captured: dict[str, Any] = {}

        def fake_runner(cmd: list[str], **kwargs: Any) -> Any:
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs

            class _Result:
                returncode = 0
                stdout = ""
                stderr = ""

            return _Result()

        result = run_upgrade(
            InstallMethod.PIP,
            target_version="0.3.0",
            runner=fake_runner,
        )
        assert result.returncode == 0
        assert captured["cmd"][0] == sys.executable
        assert captured["cmd"][-1] == "data-hub-watcher==0.3.0"
        assert captured["kwargs"]["check"] is False
        assert captured["kwargs"]["capture_output"] is True
        assert captured["kwargs"]["text"] is True

    @pytest.mark.parametrize("method", [InstallMethod.EDITABLE, InstallMethod.UNKNOWN])
    def test_refuses_editable_and_unknown(self, method: InstallMethod) -> None:
        def runner(*args: Any, **kwargs: Any) -> Any:  # pragma: no cover
            raise AssertionError("runner should not be invoked")

        with pytest.raises(RuntimeError, match="Refusing to self-update"):
            run_upgrade(method, runner=runner)


# ---------------------------------------------------------------------------
# Smoke test: detect_install_method on the actual installed dist
# ---------------------------------------------------------------------------


def test_real_install_method_detection_returns_a_known_value() -> None:
    """In CI / dev, the watcher is installed editable via `uv sync`.

    This guard ensures the real-world detection path returns *something*
    sensible (i.e. not a crash), without asserting which specific method
    — it varies between local dev and CI runners.
    """
    method = detect_install_method()
    assert isinstance(method, InstallMethod)
    # Sanity: the dist should be importable in the test env.
    assert method is not InstallMethod.UNKNOWN
    # Local checkouts should always come up as editable. Skip the assertion
    # if the test env isn't running from the workspace (e.g. when run
    # against a pre-built wheel) by checking sys.prefix.
    workspace_root = Path(__file__).resolve().parents[2]
    if str(workspace_root) in str(Path(sys.prefix).resolve()):
        assert method is InstallMethod.EDITABLE
