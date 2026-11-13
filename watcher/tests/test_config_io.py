"""Tests for ``load_config`` on files that can't be read as a config.

Every failure has to come out as a ``click.ClickException``, because the CLI prints one
cleanly and the Windows service logs one and exits. Any other exception escapes as a crash.
"""

from __future__ import annotations
from pathlib import Path

import click
import pytest

from data_hub_watcher.config_io import load_config


def _refusal(path: Path) -> str:
    """The message of the ``ClickException`` that ``load_config`` raises for *path*."""
    with pytest.raises(click.ClickException) as excinfo:
        load_config(path)
    return excinfo.value.format_message()


class TestFileThatIsNotUtf8:
    def test_a_utf16_file_is_refused_with_a_hint_to_save_it_as_utf8(self, tmp_path: Path) -> None:
        # What `>` and `Out-File` write in Windows PowerShell 5.1: a byte order mark, then UTF-16.
        path = tmp_path / "config.yaml"
        path.write_bytes("version: 1\nenvironment: staging\n".encode("utf-16"))

        message = _refusal(path)

        assert str(path) in message
        assert "UTF-8" in message

    def test_a_windows_code_page_file_is_refused_with_a_hint_to_save_it_as_utf8(
        self, tmp_path: Path
    ) -> None:
        # The u with a diaeresis and the micro sign are one byte each in cp1252, and neither
        # byte is valid UTF-8 on its own.
        path = tmp_path / "config.yaml"
        path.write_bytes("instrument:\n  id: lab-\u00fc-\u00b5\n".encode("cp1252"))

        message = _refusal(path)

        assert str(path) in message
        assert "UTF-8" in message


class TestKeyThatIsNotAString:
    @pytest.mark.parametrize("line", ["1: a", "on: yes", "yes: 1", "~: x"])
    def test_a_top_level_key_that_is_not_a_string_is_a_validation_error(
        self, tmp_path: Path, line: str
    ) -> None:
        # YAML reads these keys as an integer, `True` and `None`, and a call with such a key as
        # a keyword argument raises TypeError.
        path = tmp_path / "config.yaml"
        path.write_text(f"{line}\n", encoding="utf-8")

        message = _refusal(path)

        assert message.startswith("Config validation failed")
        # The listing of what is wrong still works: the real fields are missing.
        assert "version: Field required" in message
