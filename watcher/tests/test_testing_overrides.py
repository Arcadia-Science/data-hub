"""Unit tests for `data_hub_watcher.testing_overrides`.

These variables let the end-to-end suite shrink the watcher's timers and point
self-update at a local index. They ship in the real package, so the tests pin
three things: with nothing set the production defaults come back unchanged, a
bad value never raises, and values are read when asked for rather than when the
module is imported (the Windows service loads its env file after import).

How each call site uses them is tested next to that call site, in
`test_runtime.py`, `test_config_revisions.py`, `test_updater.py`,
`test_self_update.py` and `test_cli_self_update.py`.
"""

from __future__ import annotations
import logging
from collections.abc import Callable
from pathlib import Path

import pytest

from data_hub_watcher import testing_overrides as overrides
from data_hub_watcher.constants import (
    DEFAULT_CHECK_INTERVAL_TICKS,
    DEFAULT_IDLE_TICKS_REQUIRED,
    DEFAULT_INDEX_URL,
    HEARTBEAT_INTERVAL_SECONDS,
    UPLOAD_POLL_INTERVAL_SECONDS,
)

HEARTBEAT = "DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS"
UPLOAD_POLL = "DATA_HUB_WATCHER_UPLOAD_POLL_INTERVAL_SECONDS"
CHECK_TICKS = "DATA_HUB_WATCHER_UPDATE_CHECK_INTERVAL_TICKS"
IDLE_TICKS = "DATA_HUB_WATCHER_UPDATE_IDLE_TICKS"
INDEX_URL = "DATA_HUB_WATCHER_INDEX_URL"
LOGGER = "data_hub_watcher.testing_overrides"

# (variable, accessor, default) for each integer override.
INTEGER_OVERRIDES: list[tuple[str, Callable[[], int], int]] = [
    (HEARTBEAT, overrides.heartbeat_interval_seconds, HEARTBEAT_INTERVAL_SECONDS),
    (UPLOAD_POLL, overrides.upload_poll_interval_seconds, UPLOAD_POLL_INTERVAL_SECONDS),
    (CHECK_TICKS, overrides.update_check_interval_ticks, DEFAULT_CHECK_INTERVAL_TICKS),
    (IDLE_TICKS, overrides.update_idle_ticks, DEFAULT_IDLE_TICKS_REQUIRED),
]
# Seconds are capped at a day, ticks are not.
SECONDS_OVERRIDES = INTEGER_OVERRIDES[:2]
TICKS_OVERRIDES = INTEGER_OVERRIDES[2:]

# One id per entry keeps `-k` selection readable.
INTEGER_IDS = ["heartbeat", "upload_poll", "check_ticks", "idle_ticks"]

# Values that are not a whole number of at least 1.
NOT_A_POSITIVE_INTEGER = ["0", "00", "-1", "+5", "1.5", "1e3", "1_000", "abc", "5 s", "٣", "²"]


@pytest.fixture
def warnings_logged(caplog: pytest.LogCaptureFixture) -> Callable[[], list[str]]:
    """Messages of the WARNINGs this module has logged so far."""
    caplog.set_level(logging.WARNING, logger=LOGGER)

    def messages() -> list[str]:
        return [r.getMessage() for r in caplog.records if r.name == LOGGER]

    return messages


class TestEnvVarNames:
    def test_names_are_the_ones_the_end_to_end_suite_sets(self) -> None:
        # The e2e suite and docs/developer/watcher.md spell these out, so a
        # rename here has to be deliberate.
        assert overrides.ALL_ENV_VARS == (
            "DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS",
            "DATA_HUB_WATCHER_UPLOAD_POLL_INTERVAL_SECONDS",
            "DATA_HUB_WATCHER_UPDATE_CHECK_INTERVAL_TICKS",
            "DATA_HUB_WATCHER_UPDATE_IDLE_TICKS",
            "DATA_HUB_WATCHER_INDEX_URL",
        )


class TestDefaultsWhenUnset:
    @pytest.mark.parametrize(("name", "accessor", "default"), INTEGER_OVERRIDES, ids=INTEGER_IDS)
    def test_integer_accessors_return_the_production_default(
        self, name: str, accessor: Callable[[], int], default: int
    ) -> None:
        assert accessor() == default

    def test_index_url_is_pypi(self) -> None:
        assert overrides.index_url() == DEFAULT_INDEX_URL == "https://pypi.org/simple/"

    def test_production_defaults_are_the_documented_ones(self) -> None:
        # The values the lab fleet runs on. Changing one is a behavior change
        # for every PC, not a test tweak.
        assert HEARTBEAT_INTERVAL_SECONDS == 60
        assert UPLOAD_POLL_INTERVAL_SECONDS == 60
        assert DEFAULT_CHECK_INTERVAL_TICKS == 60
        assert DEFAULT_IDLE_TICKS_REQUIRED == 5

    def test_nothing_is_active_and_nothing_is_logged(
        self, warnings_logged: Callable[[], list[str]]
    ) -> None:
        for _name, accessor, _default in INTEGER_OVERRIDES:
            accessor()
        overrides.index_url()

        assert overrides.active_overrides() == {}
        assert warnings_logged() == []

    @pytest.mark.parametrize("blank", ["", "   ", "\t"])
    def test_blank_values_count_as_unset_and_are_not_reported(
        self,
        monkeypatch: pytest.MonkeyPatch,
        warnings_logged: Callable[[], list[str]],
        blank: str,
    ) -> None:
        # `NAME=` in an env file is how a value is cleared.
        for name in overrides.ALL_ENV_VARS:
            monkeypatch.setenv(name, blank)

        for _name, accessor, default in INTEGER_OVERRIDES:
            assert accessor() == default
        assert overrides.index_url() == DEFAULT_INDEX_URL
        assert overrides.active_overrides() == {}
        assert warnings_logged() == []


class TestValidValues:
    @pytest.mark.parametrize(("name", "accessor", "default"), INTEGER_OVERRIDES, ids=INTEGER_IDS)
    def test_integer_override_is_used(
        self,
        monkeypatch: pytest.MonkeyPatch,
        name: str,
        accessor: Callable[[], int],
        default: int,
    ) -> None:
        monkeypatch.setenv(name, "3")

        assert accessor() == 3
        assert default != 3

    @pytest.mark.parametrize(("name", "accessor", "default"), INTEGER_OVERRIDES, ids=INTEGER_IDS)
    def test_smallest_allowed_value_is_one(
        self,
        monkeypatch: pytest.MonkeyPatch,
        name: str,
        accessor: Callable[[], int],
        default: int,
    ) -> None:
        monkeypatch.setenv(name, "1")

        assert accessor() == 1

    def test_surrounding_whitespace_is_ignored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(HEARTBEAT, " 7\n")
        monkeypatch.setenv(INDEX_URL, "  http://127.0.0.1:8123/simple/ ")

        assert overrides.heartbeat_interval_seconds() == 7
        assert overrides.index_url() == "http://127.0.0.1:8123/simple/"

    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1:8123/simple/",
            "https://index.example.test/simple/",
            "http://localhost:9/simple",
            "HTTP://127.0.0.1:8123/simple/",
        ],
    )
    def test_http_and_https_index_urls_are_used_as_given(
        self, monkeypatch: pytest.MonkeyPatch, url: str
    ) -> None:
        monkeypatch.setenv(INDEX_URL, url)

        assert overrides.index_url() == url

    def test_one_override_leaves_the_others_at_their_defaults(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(CHECK_TICKS, "2")

        assert overrides.update_check_interval_ticks() == 2
        assert overrides.update_idle_ticks() == DEFAULT_IDLE_TICKS_REQUIRED
        assert overrides.heartbeat_interval_seconds() == HEARTBEAT_INTERVAL_SECONDS
        assert overrides.index_url() == DEFAULT_INDEX_URL

    def test_seconds_have_a_day_as_the_ceiling(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(HEARTBEAT, "86400")

        assert overrides.heartbeat_interval_seconds() == 86400

    def test_active_overrides_lists_exactly_the_valid_ones(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(HEARTBEAT, "2")
        monkeypatch.setenv(IDLE_TICKS, "bogus")
        monkeypatch.setenv(INDEX_URL, "http://127.0.0.1:1/simple/")

        assert overrides.active_overrides() == {
            HEARTBEAT: "2",
            INDEX_URL: "http://127.0.0.1:1/simple/",
        }


class TestInvalidValues:
    @pytest.mark.parametrize(("name", "accessor", "default"), INTEGER_OVERRIDES, ids=INTEGER_IDS)
    @pytest.mark.parametrize("bad", NOT_A_POSITIVE_INTEGER)
    def test_bad_integer_warns_naming_the_variable_and_uses_the_default(
        self,
        monkeypatch: pytest.MonkeyPatch,
        warnings_logged: Callable[[], list[str]],
        name: str,
        accessor: Callable[[], int],
        default: int,
        bad: str,
    ) -> None:
        monkeypatch.setenv(name, bad)

        assert accessor() == default

        (message,) = warnings_logged()
        assert name in message
        assert repr(bad) in message
        assert "using the default" in message

    @pytest.mark.parametrize(("name", "accessor", "default"), SECONDS_OVERRIDES)
    def test_seconds_above_a_day_are_refused(
        self,
        monkeypatch: pytest.MonkeyPatch,
        warnings_logged: Callable[[], list[str]],
        name: str,
        accessor: Callable[[], int],
        default: int,
    ) -> None:
        # A cap far below what `Event.wait` accepts, so a typo can't get near
        # the value that would raise OverflowError in the waiting thread.
        monkeypatch.setenv(name, "86401")

        assert accessor() == default
        (message,) = warnings_logged()
        assert name in message

    @pytest.mark.parametrize(("name", "accessor", "default"), TICKS_OVERRIDES)
    def test_ticks_have_no_day_ceiling(
        self,
        monkeypatch: pytest.MonkeyPatch,
        name: str,
        accessor: Callable[[], int],
        default: int,
    ) -> None:
        monkeypatch.setenv(name, "86401")

        assert accessor() == 86401

    def test_absurdly_long_number_does_not_raise(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        # `int()` raises on more than 4300 digits; the accessors must not.
        monkeypatch.setenv(CHECK_TICKS, "9" * 5000)

        assert overrides.update_check_interval_ticks() == DEFAULT_CHECK_INTERVAL_TICKS
        assert len(warnings_logged()) == 1

    @pytest.mark.parametrize(
        "bad",
        [
            "ftp://127.0.0.1/simple/",
            "file:///tmp/index/",
            "127.0.0.1:8123/simple/",
            "pypi.org/simple/",
            "/simple/",
            "http://",
            "https:///simple/",
            "http://[::1",
            "not a url",
        ],
    )
    def test_bad_index_url_warns_and_uses_pypi(
        self,
        monkeypatch: pytest.MonkeyPatch,
        warnings_logged: Callable[[], list[str]],
        bad: str,
    ) -> None:
        monkeypatch.setenv(INDEX_URL, bad)

        assert overrides.index_url() == DEFAULT_INDEX_URL

        (message,) = warnings_logged()
        assert INDEX_URL in message
        assert "http" in message

    def test_a_bad_value_is_not_an_active_override(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        monkeypatch.setenv(HEARTBEAT, "0")
        monkeypatch.setenv(INDEX_URL, "ftp://x/")

        assert overrides.active_overrides() == {}
        # Only the bad-value warnings; no "overrides are active" announcement.
        assert not any("Test-only overrides are active" in m for m in warnings_logged())

    def test_the_same_bad_value_is_reported_once(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        # The accessors run on every runtime build and every waiting-state
        # retry, so repeating the warning each time would flood the log.
        monkeypatch.setenv(HEARTBEAT, "fast")

        for _ in range(5):
            assert overrides.heartbeat_interval_seconds() == HEARTBEAT_INTERVAL_SECONDS

        assert len(warnings_logged()) == 1

    def test_a_different_bad_value_is_reported_again(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        monkeypatch.setenv(HEARTBEAT, "fast")
        overrides.heartbeat_interval_seconds()
        monkeypatch.setenv(HEARTBEAT, "slow")
        overrides.heartbeat_interval_seconds()

        assert len(warnings_logged()) == 2

    def test_a_bad_value_does_not_block_a_good_one(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        monkeypatch.setenv(HEARTBEAT, "fast")
        monkeypatch.setenv(UPLOAD_POLL, "4")

        assert overrides.heartbeat_interval_seconds() == HEARTBEAT_INTERVAL_SECONDS
        assert overrides.upload_poll_interval_seconds() == 4


class TestActiveOverridesWarning:
    def test_one_warning_lists_every_active_override(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        monkeypatch.setenv(HEARTBEAT, "2")
        monkeypatch.setenv(CHECK_TICKS, "3")
        monkeypatch.setenv(INDEX_URL, "http://127.0.0.1:8123/simple/")

        # Reading just one of them announces all three.
        overrides.heartbeat_interval_seconds()

        (message,) = warnings_logged()
        assert "Test-only overrides are active" in message
        assert f"{HEARTBEAT}=2" in message
        assert f"{CHECK_TICKS}=3" in message
        assert f"{INDEX_URL}=http://127.0.0.1:8123/simple/" in message
        assert UPLOAD_POLL not in message
        assert IDLE_TICKS not in message

    def test_it_is_logged_at_warning_level_by_the_modules_logger(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.DEBUG)
        monkeypatch.setenv(IDLE_TICKS, "1")

        overrides.update_idle_ticks()

        records = [r for r in caplog.records if "Test-only overrides" in r.getMessage()]
        assert [(r.name, r.levelno) for r in records] == [(LOGGER, logging.WARNING)]

    def test_calling_again_does_not_repeat_it(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        monkeypatch.setenv(HEARTBEAT, "2")
        monkeypatch.setenv(INDEX_URL, "http://127.0.0.1:8123/simple/")

        for _ in range(4):
            overrides.heartbeat_interval_seconds()
            overrides.upload_poll_interval_seconds()
            overrides.index_url()

        assert len(warnings_logged()) == 1

    def test_an_override_set_after_the_first_is_not_announced_again(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        # One warning per process, as promised: it says which were active when
        # the first one took effect.
        monkeypatch.setenv(HEARTBEAT, "2")
        overrides.heartbeat_interval_seconds()
        monkeypatch.setenv(UPLOAD_POLL, "3")
        assert overrides.upload_poll_interval_seconds() == 3

        assert len(warnings_logged()) == 1

    @pytest.mark.parametrize(("name", "accessor", "default"), INTEGER_OVERRIDES, ids=INTEGER_IDS)
    def test_every_override_triggers_it(
        self,
        monkeypatch: pytest.MonkeyPatch,
        warnings_logged: Callable[[], list[str]],
        name: str,
        accessor: Callable[[], int],
        default: int,
    ) -> None:
        monkeypatch.setenv(name, "2")

        accessor()

        (message,) = warnings_logged()
        assert f"{name}=2" in message

    def test_the_index_url_alone_triggers_it(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        # self-update only reads the index, so it has to announce by itself.
        monkeypatch.setenv(INDEX_URL, "http://127.0.0.1:8123/simple/")

        overrides.index_url()

        (message,) = warnings_logged()
        assert INDEX_URL in message

    def test_active_overrides_itself_is_quiet(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        monkeypatch.setenv(HEARTBEAT, "2")

        assert overrides.active_overrides() == {HEARTBEAT: "2"}

        assert warnings_logged() == []

    def test_reset_warning_state_announces_again(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        monkeypatch.setenv(HEARTBEAT, "2")
        overrides.heartbeat_interval_seconds()
        overrides.reset_warning_state()
        overrides.heartbeat_interval_seconds()

        assert len(warnings_logged()) == 2

    def test_reset_warning_state_reports_a_bad_value_again(
        self, monkeypatch: pytest.MonkeyPatch, warnings_logged: Callable[[], list[str]]
    ) -> None:
        monkeypatch.setenv(HEARTBEAT, "fast")
        overrides.heartbeat_interval_seconds()
        overrides.reset_warning_state()
        overrides.heartbeat_interval_seconds()

        assert len(warnings_logged()) == 2


class TestReadAtCallTime:
    """The values are not captured at import time.

    This module and the code that calls it were imported when pytest collected
    the tests, before any `monkeypatch.setenv` below ran. The Windows service
    is in the same position: it imports everything, then loads its env file.
    """

    @pytest.mark.parametrize(("name", "accessor", "default"), INTEGER_OVERRIDES, ids=INTEGER_IDS)
    def test_integer_set_after_import_is_seen(
        self,
        monkeypatch: pytest.MonkeyPatch,
        name: str,
        accessor: Callable[[], int],
        default: int,
    ) -> None:
        assert accessor() == default

        monkeypatch.setenv(name, "9")

        assert accessor() == 9

    def test_index_url_set_after_import_is_seen(self, monkeypatch: pytest.MonkeyPatch) -> None:
        assert overrides.index_url() == DEFAULT_INDEX_URL

        monkeypatch.setenv(INDEX_URL, "http://127.0.0.1:8123/simple/")

        assert overrides.index_url() == "http://127.0.0.1:8123/simple/"

    def test_changing_or_clearing_the_variable_changes_the_answer(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(HEARTBEAT, "2")
        assert overrides.heartbeat_interval_seconds() == 2

        monkeypatch.setenv(HEARTBEAT, "5")
        assert overrides.heartbeat_interval_seconds() == 5

        monkeypatch.delenv(HEARTBEAT)
        assert overrides.heartbeat_interval_seconds() == HEARTBEAT_INTERVAL_SECONDS

    def test_a_value_loaded_from_an_env_file_after_import_is_seen(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        # What the Windows service does: `load_dotenv(env_path, override=True)`
        # long after this module was imported.
        from dotenv import load_dotenv

        env_file = tmp_path / ".env.staging"
        env_file.write_text(f"{HEARTBEAT}=4\n{INDEX_URL}=http://127.0.0.1:8123/simple/\n")
        assert overrides.heartbeat_interval_seconds() == HEARTBEAT_INTERVAL_SECONDS

        # `load_dotenv` writes straight into `os.environ`. Setting the two
        # variables first makes `monkeypatch` remove them again afterwards.
        monkeypatch.setenv(HEARTBEAT, "placeholder")
        monkeypatch.setenv(INDEX_URL, "placeholder")
        load_dotenv(env_file, override=True)

        assert overrides.heartbeat_interval_seconds() == 4
        assert overrides.index_url() == "http://127.0.0.1:8123/simple/"
