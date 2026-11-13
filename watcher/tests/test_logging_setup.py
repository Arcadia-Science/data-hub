"""Unit tests for the shared file + Event-Log logging helpers.

These exercise the cross-platform parts of ``data_hub_watcher.logging_setup``:
the rotating file handler attached by ``setup_file_logging`` and the
``servicemanager``-routing handler attached by
``attach_servicemanager_handler``. The Windows-specific wiring inside
``service._run_service_loop`` is covered separately by
``test_service.py``.
"""

from __future__ import annotations
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from data_hub_watcher import logging_setup


@pytest.fixture(autouse=True)
def _isolated_root_logger() -> Any:
    """Snapshot and restore the root logger so tests don't leak handlers.

    Adding handlers to the root logger is the explicit job of the
    helpers under test, so isolation here is mandatory — otherwise a
    test that exercises ``setup_file_logging`` would leave a real
    ``RotatingFileHandler`` attached that subsequent tests would
    silently inherit and emit through.
    """
    root = logging.getLogger()
    original_handlers = list(root.handlers)
    original_level = root.level
    try:
        yield
    finally:
        # Close any handlers added during the test before discarding
        # them, otherwise on Windows the underlying log file stays
        # locked and the tmp_path teardown fails with a PermissionError.
        for handler in root.handlers:
            if handler not in original_handlers:
                try:
                    handler.close()
                except Exception:
                    pass
        root.handlers = original_handlers
        root.setLevel(original_level)


@pytest.fixture
def patch_log_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Redirect ``WATCHER_LOG_DIR`` so file logging lands in tmp_path.

    Patches both the source-module constant and the re-exported binding
    inside ``logging_setup`` so the helper picks the tmp directory up
    regardless of how its imports resolve.
    """
    from data_hub_watcher import constants

    monkeypatch.setattr(constants, "WATCHER_LOG_DIR", tmp_path)
    monkeypatch.setattr(logging_setup, "WATCHER_LOG_DIR", tmp_path)
    return tmp_path


class TestSetupFileLogging:
    def test_creates_log_file_and_attaches_rotating_handler(self, patch_log_dir: Path) -> None:
        log_path = logging_setup.setup_file_logging()

        assert log_path == patch_log_dir / logging_setup.LOG_FILENAME

        root = logging.getLogger()
        rotating = [h for h in root.handlers if isinstance(h, RotatingFileHandler)]
        assert len(rotating) == 1

        handler = rotating[0]
        assert Path(handler.baseFilename) == log_path
        # 10 MB / 5 backups matches the historical CLI behavior and
        # what's documented in the troubleshooting guide.
        assert handler.maxBytes == 10 * 1024 * 1024
        assert handler.backupCount == 5

    def test_writes_records_to_disk(
        self,
        patch_log_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Pytest's logging plugin defaults the root logger to WARNING,
        # so we exercise the operator-visible flow by setting the env
        # override explicitly here — this is the same knob a lab PC
        # operator would flip in ``~/.data-hub/.env.<environment>``
        # to confirm watcher.log is receiving INFO traffic.
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "INFO")

        log_path = logging_setup.setup_file_logging()
        logger = logging.getLogger("data_hub_watcher.test")
        logger.info("hello from the test")

        for handler in logging.getLogger().handlers:
            handler.flush()

        assert log_path.exists()
        contents = log_path.read_text(encoding="utf-8")
        assert "hello from the test" in contents
        # Format includes level + logger name so a tail of the file
        # is actually useful during a lab-PC triage.
        assert "[INFO]" in contents
        assert "data_hub_watcher.test" in contents

    def test_is_idempotent(self, patch_log_dir: Path) -> None:
        logging_setup.setup_file_logging()
        logging_setup.setup_file_logging()
        logging_setup.setup_file_logging()

        rotating = [h for h in logging.getLogger().handlers if isinstance(h, RotatingFileHandler)]
        assert len(rotating) == 1

    def test_log_level_env_var_overrides_default(
        self,
        patch_log_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "DEBUG")
        logging_setup.setup_file_logging()
        assert logging.getLogger().level == logging.DEBUG

    def test_unknown_log_level_falls_back_to_info(
        self,
        patch_log_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # A typo in a lab-PC env file must NOT silence logging — the
        # whole point of the env-var override is that an operator can
        # turn debug on without redeploying, and the failure mode of
        # the wrong knob disabling output altogether would defeat
        # the feature.
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "definitely-not-a-level")
        logging_setup.setup_file_logging()
        assert logging.getLogger().level == logging.INFO


class TestApplyLogLevelFromEnv:
    """The service calls this again after it has loaded its env file."""

    def test_sets_the_root_level_from_the_env_var(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "DEBUG")
        logging.getLogger().setLevel(logging.INFO)

        logging_setup.apply_log_level_from_env()

        assert logging.getLogger().level == logging.DEBUG

    def test_leaves_the_level_alone_when_the_var_is_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("DATA_HUB_WATCHER_LOG_LEVEL", raising=False)
        logging.getLogger().setLevel(logging.WARNING)

        logging_setup.apply_log_level_from_env()

        assert logging.getLogger().level == logging.WARNING


class TestUrllib3StaysAtInfo:
    """At DEBUG, urllib3 logs each request's URL, which for an upload is a pre-signed S3 URL."""

    SIGNED_REQUEST = (
        'https://uploads.example.test:443 "PUT /bucket/RUN001/a.csv?X-Amz-Signature=abc123 '
        'HTTP/1.1" 200 0'
    )

    def test_a_debug_root_level_from_the_env_var_leaves_urllib3_at_info(
        self, patch_log_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "DEBUG")

        log_path = logging_setup.setup_file_logging()
        logging.getLogger("data_hub_watcher.test").debug("a line of the watcher's own")
        logging.getLogger("urllib3.connectionpool").debug(self.SIGNED_REQUEST)

        for handler in logging.getLogger().handlers:
            handler.flush()
        contents = log_path.read_text(encoding="utf-8")
        assert "a line of the watcher's own" in contents
        assert "X-Amz-Signature" not in contents

    def test_the_level_the_service_applies_after_loading_its_env_file_does_too(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The service starts at INFO, and the env file it loads later asks for DEBUG.
        logging.getLogger().setLevel(logging.INFO)
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "DEBUG")

        logging_setup.apply_log_level_from_env()

        urllib3_logger = logging.getLogger("urllib3.connectionpool")
        assert logging.getLogger().level == logging.DEBUG
        assert not urllib3_logger.isEnabledFor(logging.DEBUG)
        assert urllib3_logger.isEnabledFor(logging.INFO)

    def test_a_root_level_above_info_applies_to_urllib3_too(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # urllib3 is at INFO while the root level is DEBUG, and follows it up to ERROR.
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "DEBUG")
        logging_setup.apply_log_level_from_env()
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "ERROR")

        logging_setup.apply_log_level_from_env()

        urllib3_logger = logging.getLogger("urllib3.connectionpool")
        assert not urllib3_logger.isEnabledFor(logging.WARNING)
        assert urllib3_logger.isEnabledFor(logging.ERROR)

    def test_verbose_leaves_urllib3_at_info(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from click.testing import CliRunner

        from data_hub_watcher import cli as cli_module

        monkeypatch.setattr(cli_module, "load_env", lambda *a, **k: None)
        # `--verbose` makes `basicConfig` set the root logger to DEBUG, but `basicConfig`
        # does nothing under pytest, where the root logger already has handlers.
        logging.getLogger().setLevel(logging.DEBUG)

        result = CliRunner().invoke(cli_module.cli, ["--verbose", "config", "path"])

        assert result.exit_code == 0, result.output
        urllib3_logger = logging.getLogger("urllib3.connectionpool")
        assert not urllib3_logger.isEnabledFor(logging.DEBUG)
        assert urllib3_logger.isEnabledFor(logging.INFO)


class TestServiceManagerHandler:
    def test_error_routes_to_log_error_msg(self) -> None:
        sm = MagicMock(name="servicemanager")
        logging_setup.attach_servicemanager_handler(sm)

        logging.getLogger("data_hub_watcher.test").error("boom")

        sm.LogErrorMsg.assert_called_once()
        msg = sm.LogErrorMsg.call_args.args[0]
        # The Event Log records ``LevelDisplayName`` and
        # ``TimeCreated`` per entry, so the formatter intentionally
        # drops the bracketed level + asctime — the message body
        # is just ``<logger>: <message>``. We still include the
        # logger name so an operator scanning event viewer can tell
        # ``uploader`` failures from ``api_client`` failures.
        assert "boom" in msg
        assert "data_hub_watcher.test" in msg
        sm.LogWarningMsg.assert_not_called()
        sm.LogInfoMsg.assert_not_called()

    def test_warning_routes_to_log_warning_msg(self) -> None:
        sm = MagicMock(name="servicemanager")
        logging_setup.attach_servicemanager_handler(sm)

        logging.getLogger("data_hub_watcher.test").warning("careful")

        sm.LogWarningMsg.assert_called_once()
        assert "careful" in sm.LogWarningMsg.call_args.args[0]
        sm.LogErrorMsg.assert_not_called()
        sm.LogInfoMsg.assert_not_called()

    def test_info_and_debug_route_to_log_info_msg(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Set the env var so the operator-facing override path runs
        # rather than relying on whatever level pytest's logging
        # plugin currently defaults the root to.
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "DEBUG")
        sm = MagicMock(name="servicemanager")
        logging_setup.attach_servicemanager_handler(sm, info_from="data_hub_watcher.test")

        logger = logging.getLogger("data_hub_watcher.test")
        logger.info("hello")
        logger.debug("noisy")

        assert sm.LogInfoMsg.call_count == 2
        bodies = [c.args[0] for c in sm.LogInfoMsg.call_args_list]
        assert any("hello" in b for b in bodies)
        assert any("noisy" in b for b in bodies)
        sm.LogErrorMsg.assert_not_called()
        sm.LogWarningMsg.assert_not_called()

    def test_info_from_other_loggers_stays_out_of_the_event_log(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A run of thousands of files logs several INFO lines per file;
        # ``watcher.log`` keeps them, the Application log must not.
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "DEBUG")
        sm = MagicMock(name="servicemanager")
        logging_setup.attach_servicemanager_handler(sm, info_from="data_hub_watcher.service")

        other = logging.getLogger("data_hub_watcher.monitor")
        other.info("File stable: a.csv")
        other.debug("Checking a.csv")
        other.warning("Upload is slow")
        other.error("Upload failed")
        logging.getLogger("data_hub_watcher.service").info("Data Hub Watcher is running")

        sm.LogInfoMsg.assert_called_once()
        assert "is running" in sm.LogInfoMsg.call_args.args[0]
        sm.LogWarningMsg.assert_called_once()
        assert "Upload is slow" in sm.LogWarningMsg.call_args.args[0]
        sm.LogErrorMsg.assert_called_once()
        assert "Upload failed" in sm.LogErrorMsg.call_args.args[0]

    def test_without_info_from_only_warnings_and_errors_reach_the_event_log(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "DEBUG")
        sm = MagicMock(name="servicemanager")
        logging_setup.attach_servicemanager_handler(sm)

        logger = logging.getLogger("data_hub_watcher.service")
        logger.info("Data Hub Watcher is running")
        logger.warning("careful")

        sm.LogInfoMsg.assert_not_called()
        sm.LogWarningMsg.assert_called_once()

    def test_idempotent_for_same_sm(self) -> None:
        sm = MagicMock(name="servicemanager")
        first = logging_setup.attach_servicemanager_handler(sm)
        second = logging_setup.attach_servicemanager_handler(sm)

        assert first is second
        root = logging.getLogger()
        handlers = [h for h in root.handlers if isinstance(h, logging_setup._ServiceManagerHandler)]
        assert len(handlers) == 1

    def test_attaching_again_keeps_the_first_info_from(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATA_HUB_WATCHER_LOG_LEVEL", "DEBUG")
        sm = MagicMock(name="servicemanager")
        logging_setup.attach_servicemanager_handler(sm, info_from="data_hub_watcher.first")
        logging_setup.attach_servicemanager_handler(sm, info_from="data_hub_watcher.second")

        logging.getLogger("data_hub_watcher.second").info("not from the first")
        logging.getLogger("data_hub_watcher.first").info("from the first")

        sm.LogInfoMsg.assert_called_once()
        assert "from the first" in sm.LogInfoMsg.call_args.args[0]

    def test_separate_handler_per_sm_object(self) -> None:
        sm1 = MagicMock(name="sm1")
        sm2 = MagicMock(name="sm2")
        logging_setup.attach_servicemanager_handler(sm1)
        logging_setup.attach_servicemanager_handler(sm2)

        logging.getLogger("data_hub_watcher.test").error("dispatch")

        sm1.LogErrorMsg.assert_called_once()
        sm2.LogErrorMsg.assert_called_once()

    def test_truncates_oversize_messages(self) -> None:
        sm = MagicMock(name="servicemanager")
        logging_setup.attach_servicemanager_handler(sm)

        # The truncation cap is 30 KB to leave headroom under the
        # 32 KB Windows Event Log per-string limit. Build a message
        # comfortably past the cap so the truncation logic kicks in.
        big = "x" * (40 * 1024)
        logging.getLogger("data_hub_watcher.test").error(big)

        sm.LogErrorMsg.assert_called_once()
        forwarded = sm.LogErrorMsg.call_args.args[0]
        assert len(forwarded) <= 30 * 1024 + 200  # cap + truncation marker
        assert "truncated" in forwarded

    def test_swallows_underlying_sm_errors(self) -> None:
        # If the servicemanager call itself raises (e.g. Event Log is
        # full or unreachable) we must NOT propagate — the worst case
        # is a missing Event Log entry, not a crashed service. The
        # original record should also still reach any sibling handler
        # like the rotating file log.
        sm = MagicMock(name="servicemanager")
        sm.LogErrorMsg.side_effect = RuntimeError("event log unavailable")
        logging_setup.attach_servicemanager_handler(sm)

        logging.getLogger("data_hub_watcher.test").error("still useful")

        sm.LogErrorMsg.assert_called_once()
        # No exception escaped.

    def test_does_not_recurse_if_format_raises(self) -> None:
        # If formatting the record itself blows up, we must fall back
        # to the standard logging.Handler error path instead of
        # looping by emitting another record through ourselves.
        sm = MagicMock(name="servicemanager")
        handler = logging_setup.attach_servicemanager_handler(sm)
        handler.setFormatter(logging.Formatter("%(asctime)s %(missing_attribute)s %(message)s"))

        # Should not raise, should not call any sm.Log* method since
        # formatting fails before routing.
        logging.getLogger("data_hub_watcher.test").error("payload")

        sm.LogErrorMsg.assert_not_called()
