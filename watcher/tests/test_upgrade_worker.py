"""Unit tests for `data_hub_watcher.upgrade_worker`.

The worker module is the fixed contract between the service / CLI
(which write the request sentinel) and the SYSTEM-owned PowerShell
worker (which reads it). These tests pin the JSON shape, the package
spec computation, and the rendered worker template so a regression
that breaks the contract surfaces here rather than as a stuck
``schtasks`` execution on a real lab PC.
"""

from __future__ import annotations
import json
from pathlib import Path

import pytest

from data_hub_watcher.self_update import InstallMethod
from data_hub_watcher.upgrade_worker import (
    UPGRADE_REQUEST_FILENAME,
    UPGRADE_RESULT_FILENAME,
    UPGRADE_WORKER_SCRIPT_FILENAME,
    UpgradeResult,
    build_pkg_spec,
    clear_upgrade_request,
    clear_upgrade_result,
    read_upgrade_request,
    read_upgrade_result,
    render_worker_script,
    upgrade_request_path,
    upgrade_result_path,
    upgrade_worker_script_path,
    write_upgrade_request,
    write_worker_script,
)

# ---------------------------------------------------------------------------
# Sentinel round-trips
# ---------------------------------------------------------------------------


class TestUpgradeRequestRoundTrip:
    def test_write_then_read_preserves_fields(self, tmp_path: Path) -> None:
        req = write_upgrade_request(
            tmp_path,
            target_version="0.3.0",
            pkg_spec="data-hub-watcher[windows-service]==0.3.0",
            uv_executable=r"C:\Users\lab\.local\bin\uv.exe",
            index_url="https://pypi.org/simple/",
            previous_version="0.1.4",
            install_method="uv-tool",
            request_id="test-id-1234",
        )

        loaded = read_upgrade_request(tmp_path)
        assert loaded == req
        assert loaded is not None
        assert loaded.request_id == "test-id-1234"
        assert loaded.pkg_spec == "data-hub-watcher[windows-service]==0.3.0"
        assert loaded.uv_executable == r"C:\Users\lab\.local\bin\uv.exe"

    def test_request_id_defaults_to_uuid_when_absent(self, tmp_path: Path) -> None:
        req = write_upgrade_request(
            tmp_path,
            target_version="0.3.0",
            pkg_spec="data-hub-watcher==0.3.0",
            uv_executable="uv",
            index_url="https://pypi.org/simple/",
            previous_version="0.1.0",
            install_method="uv-tool",
        )
        assert req.request_id
        # uuid4 is 36 chars (32 hex + 4 dashes); the exact format is
        # less important than "not the literal default placeholder".
        assert len(req.request_id) == 36

    def test_read_returns_none_when_file_absent(self, tmp_path: Path) -> None:
        assert read_upgrade_request(tmp_path) is None

    def test_read_returns_none_for_corrupt_json(self, tmp_path: Path) -> None:
        upgrade_request_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
        upgrade_request_path(tmp_path).write_text("not-json", encoding="utf-8")
        assert read_upgrade_request(tmp_path) is None

    def test_read_returns_none_for_missing_required_fields(self, tmp_path: Path) -> None:
        upgrade_request_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
        upgrade_request_path(tmp_path).write_text(
            json.dumps({"target_version": "0.3.0"}), encoding="utf-8"
        )
        assert read_upgrade_request(tmp_path) is None

    def test_clear_is_idempotent(self, tmp_path: Path) -> None:
        clear_upgrade_request(tmp_path)
        clear_upgrade_request(tmp_path)

    def test_write_overwrites_existing_request(self, tmp_path: Path) -> None:
        # Two consecutive dispatches (e.g. CLI invocation while the
        # auto-updater also fired) must leave the file consistent
        # rather than torn — the atomic-write contract is what makes
        # the worker's read race-free.
        write_upgrade_request(
            tmp_path,
            target_version="0.2.0",
            pkg_spec="data-hub-watcher==0.2.0",
            uv_executable="uv",
            index_url="https://pypi.org/simple/",
            previous_version="0.1.0",
            install_method="uv-tool",
            request_id="first",
        )
        write_upgrade_request(
            tmp_path,
            target_version="0.3.0",
            pkg_spec="data-hub-watcher==0.3.0",
            uv_executable="uv",
            index_url="https://pypi.org/simple/",
            previous_version="0.1.0",
            install_method="uv-tool",
            request_id="second",
        )
        latest = read_upgrade_request(tmp_path)
        assert latest is not None
        assert latest.request_id == "second"
        assert latest.target_version == "0.3.0"


class TestUpgradeResultRoundTrip:
    def test_write_then_read_success(self, tmp_path: Path) -> None:
        result = UpgradeResult(
            request_id="test-id",
            target_version="0.3.0",
            succeeded=True,
            returncode=0,
            stdout_tail="installed 17 packages",
            stderr_tail="",
            finished_at="2026-05-04T22:30:00+00:00",
            error=None,
        )
        path = upgrade_result_path(tmp_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result.to_dict()), encoding="utf-8")

        loaded = read_upgrade_result(tmp_path)
        assert loaded == result

    def test_read_returns_none_when_absent(self, tmp_path: Path) -> None:
        assert read_upgrade_result(tmp_path) is None

    def test_read_returns_none_for_corrupt_json(self, tmp_path: Path) -> None:
        upgrade_result_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
        upgrade_result_path(tmp_path).write_text("not-json", encoding="utf-8")
        assert read_upgrade_result(tmp_path) is None

    def test_read_handles_null_returncode(self, tmp_path: Path) -> None:
        # The PowerShell worker writes returncode=null when `uv` itself
        # raised before producing an exit code (e.g. ENOENT on the binary).
        # Round-trip must preserve the null rather than coercing to 0,
        # because 0 would mean "success" and dramatically change the
        # event semantics.
        path = upgrade_result_path(tmp_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "request_id": "x",
                    "target_version": "0.3.0",
                    "succeeded": False,
                    "returncode": None,
                    "stdout_tail": "",
                    "stderr_tail": "",
                    "finished_at": "2026-05-04T22:30:00+00:00",
                    "error": "uv not found",
                }
            ),
            encoding="utf-8",
        )
        loaded = read_upgrade_result(tmp_path)
        assert loaded is not None
        assert loaded.succeeded is False
        assert loaded.returncode is None
        assert loaded.error == "uv not found"

    def test_clear_is_idempotent(self, tmp_path: Path) -> None:
        clear_upgrade_result(tmp_path)
        clear_upgrade_result(tmp_path)


# ---------------------------------------------------------------------------
# build_pkg_spec
# ---------------------------------------------------------------------------


class TestBuildPkgSpec:
    def test_uv_tool_with_no_extras_pinned(self) -> None:
        assert (
            build_pkg_spec(InstallMethod.UV_TOOL, target_version="0.3.0")
            == "data-hub-watcher==0.3.0"
        )

    def test_uv_tool_with_windows_service_extra(self) -> None:
        # The whole point of this helper: a fleet PC originally
        # installed with `[windows-service]` must keep getting it on
        # every reinstall, otherwise pywin32 disappears and the
        # service can't start.
        assert (
            build_pkg_spec(
                InstallMethod.UV_TOOL,
                target_version="0.3.0",
                extras=["windows-service"],
            )
            == "data-hub-watcher[windows-service]==0.3.0"
        )

    def test_pip_with_extras(self) -> None:
        assert (
            build_pkg_spec(
                InstallMethod.PIP,
                target_version="0.3.0",
                extras=["windows-service"],
            )
            == "data-hub-watcher[windows-service]==0.3.0"
        )

    def test_extras_are_sorted(self) -> None:
        # Sorted output keeps the rendered worker script byte-stable
        # so we can use a content hash for "did the script change?"
        # checks down the line, and so the golden test below isn't
        # sensitive to dict-iteration order.
        assert (
            build_pkg_spec(
                InstallMethod.UV_TOOL,
                target_version="0.3.0",
                extras=["zeta", "alpha"],
            )
            == "data-hub-watcher[alpha,zeta]==0.3.0"
        )

    def test_no_target_version_omits_pin(self) -> None:
        assert build_pkg_spec(InstallMethod.UV_TOOL) == "data-hub-watcher"
        assert (
            build_pkg_spec(InstallMethod.UV_TOOL, extras=["windows-service"])
            == "data-hub-watcher[windows-service]"
        )

    @pytest.mark.parametrize("method", [InstallMethod.EDITABLE, InstallMethod.UNKNOWN])
    def test_unsupported_methods_raise(self, method: InstallMethod) -> None:
        with pytest.raises(ValueError, match="Cannot build a package spec"):
            build_pkg_spec(method, target_version="0.3.0")


# ---------------------------------------------------------------------------
# Worker script template
# ---------------------------------------------------------------------------


class TestRenderWorkerScript:
    def _render(self, tmp_path: Path) -> str:
        return render_worker_script(
            service_name="DataHubWatcher",
            request_path=tmp_path / ".upgrade-request.json",
            result_path=tmp_path / ".upgrade-result.json",
            log_path=tmp_path / "upgrade-worker.log",
            marker_path=tmp_path / ".upgrade-in-progress",
            generated_at="2026-05-04T22:30:00+00:00",
        )

    def test_includes_critical_lifecycle_steps(self, tmp_path: Path) -> None:
        script = self._render(tmp_path)
        # Must stop the service before running uv (releases Scripts\python.exe).
        assert "Stop-Service" in script
        # Must start the service again so the new wheel is loaded.
        assert "Start-Service" in script
        # Must invoke uv with the reinstall flag so the venv is rebuilt.
        assert "tool" in script and "install" in script and "--reinstall" in script
        # Must write the result sentinel so the post-restart event has
        # the subprocess output to attach.
        assert "$ResultPath" in script
        # Must clean up the request sentinel so a stale request doesn't
        # re-dispatch on a future task run.
        assert "Remove-Item" in script and "$RequestPath" in script

    def test_baked_in_paths_are_absolute_strings(self, tmp_path: Path) -> None:
        script = self._render(tmp_path)
        assert str(tmp_path / ".upgrade-request.json") in script
        assert str(tmp_path / ".upgrade-result.json") in script
        assert str(tmp_path / "upgrade-worker.log") in script
        assert "DataHubWatcher" in script

    def test_uv_executable_is_read_from_request_not_baked(self, tmp_path: Path) -> None:
        # The uv path lives in the request sentinel rather than being
        # baked into the worker script so a post-install relocation of
        # uv.exe doesn't require regenerating the script. Lock that
        # contract here.
        script = self._render(tmp_path)
        assert r"C:\Users\lab\.local\bin\uv.exe" not in script
        assert "$UvExe" in script
        assert "request.uv_executable" in script

    def test_writes_to_log_path(self, tmp_path: Path) -> None:
        script = self._render(tmp_path)
        assert "$LogPath" in script
        assert "Add-Content" in script

    def test_uses_finally_to_restart_service_on_failure(self, tmp_path: Path) -> None:
        # If uv crashes, the worker MUST still write the result sentinel
        # AND attempt to restart the service. Without the finally block
        # the host would be left with a stopped service after a botched
        # upgrade — strictly worse than the original problem.
        script = self._render(tmp_path)
        # The finally block contains both Write-ResultJson and Start-Service.
        finally_idx = script.find("} finally {")
        assert finally_idx != -1, "worker must wrap uv invocation in try/finally"
        finally_block = script[finally_idx:]
        assert "Write-ResultJson" in finally_block
        assert "Start-Service" in finally_block

    def test_write_worker_script_drops_file_at_expected_path(self, tmp_path: Path) -> None:
        path = write_worker_script(tmp_path, service_name="DataHubWatcher")
        assert path == upgrade_worker_script_path(tmp_path)
        assert path.exists()
        assert path.name == UPGRADE_WORKER_SCRIPT_FILENAME
        contents = path.read_text(encoding="utf-8")
        assert "Stop-Service" in contents
        assert "DataHubWatcher" in contents

    def test_uv_stdout_and_stderr_are_echoed_to_worker_log(self, tmp_path: Path) -> None:
        # Regression guard against the symptom that prompted this
        # change: the previous in-process upgrade attempts produced
        # no record of uv's actual stderr anywhere on the lab PC,
        # so an operator had no way to tell a "Scripts directory is
        # locked" failure from a "PyPI was down" failure. The
        # worker MUST mirror uv's full output to the worker log so
        # tailing the log on the host always shows the install
        # transcript, even if the result sentinel is later
        # consumed/cleared.
        script = self._render(tmp_path)
        # Both stdout and stderr lines are written via Write-Log so
        # they pick up the same UTC timestamp prefix as the rest of
        # the worker's events.
        assert "uv stdout:" in script
        assert "uv stderr:" in script
        # The split must happen on either CR-LF or LF so the
        # transcript reads correctly regardless of which line ending
        # uv emits on the host.
        assert "`r?`n" in script or "\\r?\\n" in script


# ---------------------------------------------------------------------------
# Filename constants
# ---------------------------------------------------------------------------


def test_sentinel_filenames_are_dotfiles_under_config_dir(tmp_path: Path) -> None:
    # The lifecycle helpers in `runtime` and the `__main__` block on
    # the service rely on these filenames; pin them so a casual rename
    # surfaces here rather than as a silent dispatch failure.
    assert upgrade_request_path(tmp_path).name == UPGRADE_REQUEST_FILENAME
    assert upgrade_result_path(tmp_path).name == UPGRADE_RESULT_FILENAME
    assert UPGRADE_REQUEST_FILENAME.startswith(".")
    assert UPGRADE_RESULT_FILENAME.startswith(".")
