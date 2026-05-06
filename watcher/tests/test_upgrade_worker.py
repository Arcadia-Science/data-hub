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
import subprocess
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
            tool_dir=Path(r"C:\Users\op\AppData\Roaming\uv\tools"),
            tool_bin_dir=Path(r"C:\Users\op\.local\bin"),
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
        path = write_worker_script(
            tmp_path,
            service_name="DataHubWatcher",
            tool_dir=Path(r"C:\Users\op\AppData\Roaming\uv\tools"),
            tool_bin_dir=Path(r"C:\Users\op\.local\bin"),
        )
        assert path == upgrade_worker_script_path(tmp_path)
        assert path.exists()
        assert path.name == UPGRADE_WORKER_SCRIPT_FILENAME
        contents = path.read_text(encoding="utf-8")
        assert "Stop-Service" in contents
        assert "DataHubWatcher" in contents

    def test_no_marker_path_baked_into_template(self, tmp_path: Path) -> None:
        # The ``.upgrade-in-progress`` marker is owned end-to-end on
        # the Python side (written before dispatch in ``updater``,
        # consumed in ``runtime.start_runtime``). The worker has no
        # business touching it — leaking ``$MarkerPath`` into the
        # rendered script invites a future change to start mutating
        # it from PowerShell, which would race with the post-restart
        # evaluation. Pin the contract here.
        script = self._render(tmp_path)
        assert "$MarkerPath" not in script
        assert ".upgrade-in-progress" not in script

    def test_uv_invocation_always_passes_index_url(self, tmp_path: Path) -> None:
        # The dispatch-side code (``_apply_via_worker`` /
        # ``_dispatch_self_update_via_worker``) only ever writes a
        # request sentinel for a pinned target version, so the worker
        # is guaranteed to have an index URL to forward. Mirroring
        # ``build_upgrade_command``'s argv shape unconditionally keeps
        # the two install paths byte-equivalent and means a future
        # change to one needs to update the other — rather than
        # silently drifting because a conditional in the worker
        # was a no-op for the only call site that ever hit it.
        script = self._render(tmp_path)
        assert "--index-url" in script
        # No conditional gating the index-url addition; the args list
        # is constructed in a single literal.
        assert "if ($Target)" not in script

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

    def test_uv_tool_dir_overrides_are_baked_in(self, tmp_path: Path) -> None:
        # Regression guard for the silent "uv installed into SYSTEM
        # profile" failure mode: the worker runs as LocalSystem via
        # the scheduled task, and uv resolves UV_TOOL_DIR /
        # UV_TOOL_BIN_DIR from $env:USERPROFILE which under SYSTEM
        # is C:\Windows\System32\config\systemprofile\.local\... —
        # NOT where the running watcher service was originally
        # installed from. The rendered worker MUST set both env
        # vars to the operator-context paths captured at install
        # time so uv reinstalls in place at the operator's tool
        # dir; otherwise the upgrade succeeds (uv exits 0) but
        # produces a SECOND copy of the package that the running
        # service never loads, and the marker comparison fails
        # with "expected X, running Y" on the next restart.
        script = render_worker_script(
            service_name="DataHubWatcher",
            request_path=tmp_path / ".upgrade-request.json",
            result_path=tmp_path / ".upgrade-result.json",
            log_path=tmp_path / "upgrade-worker.log",
            tool_dir=Path(r"C:\Users\op\AppData\Roaming\uv\tools"),
            tool_bin_dir=Path(r"C:\Users\op\.local\bin"),
            generated_at="2026-05-04T22:30:00+00:00",
        )

        # The literal paths are baked in as PowerShell variables…
        assert r'$ToolDir      = "C:\Users\op\AppData\Roaming\uv\tools"' in script
        assert r'$ToolBinDir   = "C:\Users\op\.local\bin"' in script
        # …and assigned to the env vars uv actually consults BEFORE
        # the uv invocation. Order matters: setting them after
        # `Start-Process -FilePath $UvExe` would have no effect on
        # the subprocess.
        env_idx = script.find("$env:UV_TOOL_DIR")
        uv_invoke_idx = script.find("Start-Process -FilePath $UvExe")
        assert env_idx != -1, "worker must set $env:UV_TOOL_DIR"
        assert uv_invoke_idx != -1, "worker must invoke uv via Start-Process"
        assert env_idx < uv_invoke_idx, (
            "$env:UV_TOOL_DIR must be set BEFORE uv is invoked, "
            "otherwise the override has no effect on the subprocess"
        )
        # Both env vars present.
        assert "$env:UV_TOOL_DIR     = $ToolDir" in script
        assert "$env:UV_TOOL_BIN_DIR = $ToolBinDir" in script

    def test_result_sentinel_is_written_without_utf8_bom(self, tmp_path: Path) -> None:
        # Regression guard for the secondary symptom of the silent
        # auto-update failure: PowerShell 5.1's `Set-Content -Encoding
        # UTF8` writes a UTF-8 BOM, and Python's `json.loads(
        # path.read_text(encoding="utf-8"))` raises JSONDecodeError on
        # the leading U+FEFF. `read_upgrade_result` then swallows the
        # error and returns None, causing the post-restart inspection
        # to flag `worker_result_missing=True` even though the file
        # was written successfully — the operator sees no actual
        # error context in the failure event.
        #
        # The fix uses [System.IO.File]::WriteAllText with an explicit
        # UTF8Encoding($false) so the BOM is omitted on every supported
        # PowerShell version. Pin the encoder choice here.
        script = render_worker_script(
            service_name="DataHubWatcher",
            request_path=tmp_path / ".upgrade-request.json",
            result_path=tmp_path / ".upgrade-result.json",
            log_path=tmp_path / "upgrade-worker.log",
            tool_dir=tmp_path / "tools",
            tool_bin_dir=tmp_path / "bin",
            generated_at="2026-05-04T22:30:00+00:00",
        )
        # The .NET UTF8Encoding constructor takes a bool encoderShouldEmitUTF8Identifier
        # — `$false` means "no BOM". We pin both the type and the
        # `$false` argument so a future refactor can't accidentally
        # flip it back to BOM-emitting.
        assert "[System.IO.File]::WriteAllText" in script
        assert "[System.Text.UTF8Encoding]::new($false)" in script
        # The original BOM-emitting `Set-Content` invocation must
        # not appear as an actual command anywhere in the rendered
        # template. Search line-by-line, ignoring lines that start
        # with `#` (PowerShell comments) so the regression-context
        # commentary describing the *old* behaviour doesn't trip
        # the assertion.
        for line in script.splitlines():
            stripped = line.lstrip()
            if stripped.startswith("#"):
                continue
            assert "Set-Content -LiteralPath $tmp -Encoding UTF8" not in stripped


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


# ---------------------------------------------------------------------------
# resolve_uv_tool_dirs
# ---------------------------------------------------------------------------


class TestResolveUvToolDirs:
    """Capture the operator's uv tool directories at install time.

    Required because the worker later runs as LocalSystem and uv would
    otherwise resolve UV_TOOL_DIR / UV_TOOL_BIN_DIR against the SYSTEM
    profile rather than the operator's profile — silently installing
    upgrades into the wrong location.
    """

    def test_returns_paths_from_uv_tool_dir_invocations(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from data_hub_watcher import upgrade_worker as worker_mod

        invocations: list[list[str]] = []

        def fake_run(argv: list[str], **_kw: object) -> subprocess.CompletedProcess[str]:
            invocations.append(argv)
            if "--bin" in argv:
                stdout = r"C:\Users\op\.local\bin"
            else:
                stdout = r"C:\Users\op\AppData\Roaming\uv\tools"
            return subprocess.CompletedProcess(argv, returncode=0, stdout=stdout, stderr="")

        monkeypatch.setattr(worker_mod.subprocess, "run", fake_run)

        tool_dir, tool_bin_dir = worker_mod.resolve_uv_tool_dirs(r"C:\Users\op\.local\bin\uv.exe")

        assert tool_dir == Path(r"C:\Users\op\AppData\Roaming\uv\tools")
        assert tool_bin_dir == Path(r"C:\Users\op\.local\bin")
        # Both invocations must use the supplied uv path (not e.g. a
        # PATH-resolved fallback) so the helper reflects the same uv
        # the worker will eventually drive.
        assert invocations[0] == [r"C:\Users\op\.local\bin\uv.exe", "tool", "dir"]
        assert invocations[1] == [r"C:\Users\op\.local\bin\uv.exe", "tool", "dir", "--bin"]

    def test_nonzero_exit_raises_with_stderr_attached(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from data_hub_watcher import upgrade_worker as worker_mod

        def fake_run(argv: list[str], **_kw: object) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(
                argv, returncode=2, stdout="", stderr="uv: command does not exist"
            )

        monkeypatch.setattr(worker_mod.subprocess, "run", fake_run)

        with pytest.raises(worker_mod.UvToolDirResolutionError) as excinfo:
            worker_mod.resolve_uv_tool_dirs("uv")

        # Operator-facing message must include the failing argv and
        # uv's stderr — diagnostically those are the two pieces an
        # operator needs to recover from a stuck install.
        msg = str(excinfo.value)
        assert "uv tool dir" in msg
        assert "command does not exist" in msg

    def test_empty_stdout_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # An exit-0 with empty stdout would otherwise silently bake
        # `Path("")` into the worker template, which uv interprets
        # as "use the default" — i.e. the very SYSTEM-profile path
        # we're trying to override. Treat it as a hard failure.
        from data_hub_watcher import upgrade_worker as worker_mod

        def fake_run(argv: list[str], **_kw: object) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(argv, returncode=0, stdout="\n", stderr="")

        monkeypatch.setattr(worker_mod.subprocess, "run", fake_run)

        with pytest.raises(worker_mod.UvToolDirResolutionError):
            worker_mod.resolve_uv_tool_dirs("uv")

    def test_oserror_raises_uv_tool_dir_resolution_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # uv.exe missing from disk surfaces as FileNotFoundError from
        # subprocess.run; the helper must convert that to its typed
        # error so callers don't have to know about subprocess
        # internals.
        from data_hub_watcher import upgrade_worker as worker_mod

        def boom(argv: list[str], **_kw: object) -> subprocess.CompletedProcess[str]:
            raise FileNotFoundError("uv.exe not found")

        monkeypatch.setattr(worker_mod.subprocess, "run", boom)

        with pytest.raises(worker_mod.UvToolDirResolutionError):
            worker_mod.resolve_uv_tool_dirs("uv")
