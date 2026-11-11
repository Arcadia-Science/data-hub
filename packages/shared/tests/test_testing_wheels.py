"""Tests for the watcher wheel builder."""

from __future__ import annotations
import re
import shutil
import sys
import zipfile
from pathlib import Path

import pytest
import tomllib

from data_hub_shared import testing_wheels
from data_hub_shared.testing_wheels import (
    build_watcher_wheel,
    bumped_version,
    watcher_project_version,
)

REPO_ROOT = Path(__file__).resolve().parents[3]

# What the server's own version parser (web/lib/api/watcher-versions.ts) reads: three
# numbers, then an optional suffix.
SERVER_VERSION_REGEX = re.compile(r"^(\d+)\.(\d+)\.(\d+)([.-].+|[a-zA-Z].*)?$")


def wheel_version(wheel: Path) -> str:
    """Read the ``Version:`` header from a wheel's METADATA file."""
    with zipfile.ZipFile(wheel) as archive:
        (name,) = [n for n in archive.namelist() if n.endswith(".dist-info/METADATA")]
        metadata = archive.read(name).decode()
    (version,) = re.findall(r"(?m)^Version: (.+)$", metadata)
    return version


# ---------------------------------------------------------------------------
# Versions
# ---------------------------------------------------------------------------


def test_watcher_project_version_matches_pyproject() -> None:
    with (REPO_ROOT / "watcher" / "pyproject.toml").open("rb") as file:
        expected = tomllib.load(file)["project"]["version"]

    assert watcher_project_version() == expected


def test_the_server_version_regex_in_these_tests_is_still_the_servers() -> None:
    server_source = (REPO_ROOT / "web" / "lib" / "api" / "watcher-versions.ts").read_text()

    assert f"/{SERVER_VERSION_REGEX.pattern}/" in server_source


def test_the_current_watcher_version_can_be_bumped() -> None:
    # If the watcher ever gets a non-plain version, such as a release candidate, the
    # helpers here need to learn about it. This fails first.
    bumped = bumped_version(watcher_project_version())

    assert SERVER_VERSION_REGEX.match(bumped)


@pytest.mark.parametrize(
    ("version", "offset", "expected"),
    [
        ("1.4.0", None, "1.4.1000"),
        ("1.4.7", None, "1.4.1007"),
        ("0.0.0", None, "0.0.1000"),
        ("12.34.56", None, "12.34.1056"),
        ("1.4.0", 1, "1.4.1"),
        ("1.4.0", 5000, "1.4.5000"),
        ("1.4.1999", 1000, "1.4.2999"),
    ],
)
def test_bumped_version_adds_the_offset_to_the_patch_number(
    version: str, offset: int | None, expected: str
) -> None:
    result = bumped_version(version) if offset is None else bumped_version(version, offset)

    assert result == expected
    assert SERVER_VERSION_REGEX.match(result)
    assert re.fullmatch(r"\d+\.\d+\.\d+", result), "the result must stay a plain three-part version"


def test_bumped_version_is_newer_in_the_order_the_server_uses() -> None:
    def key(version: str) -> tuple[int, ...]:
        return tuple(int(part) for part in version.split("."))

    current = watcher_project_version()

    assert key(bumped_version(current)) > key(current)
    # Compared as text, "1.4.1000" would sort below "1.4.9". The server compares numbers.
    assert key(bumped_version("1.4.9")) > key("1.4.9")


@pytest.mark.parametrize(
    "bad", ["1.4", "1.4.0.1", "1.4.0rc1", "1.4.0.post1", "v1.4.0", "", "a.b.c"]
)
def test_bumped_version_rejects_versions_that_are_not_plain_three_part(bad: str) -> None:
    with pytest.raises(ValueError, match="MAJOR.MINOR.PATCH"):
        bumped_version(bad)


@pytest.mark.parametrize("offset", [0, -5])
def test_bumped_version_rejects_an_offset_that_would_not_raise_the_version(offset: int) -> None:
    with pytest.raises(ValueError, match="patch_offset"):
        bumped_version("1.4.0", offset)


# ---------------------------------------------------------------------------
# Rewriting the version in pyproject.toml
# ---------------------------------------------------------------------------


def test_only_the_project_version_line_is_rewritten() -> None:
    original = (
        '[build-system]\nrequires = ["setuptools"]\n\n'
        '[project]\nname = "demo"\nversion = "1.0.0"\n'
        'dependencies = ["thing"]\n\n'
        '[tool.other]\nversion = "9.9.9"\n'
    )

    rewritten = testing_wheels._with_project_version(original, "1.0.1000")

    assert rewritten == original.replace('version = "1.0.0"', 'version = "1.0.1000"')
    assert tomllib.loads(rewritten)["tool"]["other"]["version"] == "9.9.9"


def test_rewriting_fails_loudly_when_there_is_no_project_version() -> None:
    with pytest.raises(RuntimeError, match="no \\[project\\] table"):
        testing_wheels._with_project_version('[tool.x]\nversion = "1"\n', "2.0.0")
    with pytest.raises(RuntimeError, match="no version line"):
        testing_wheels._with_project_version(
            '[project]\nname = "demo"\n\n[tool.x]\nversion = "1"\n', "2.0.0"
        )


# ---------------------------------------------------------------------------
# Building wheels
# ---------------------------------------------------------------------------

needs_uv = pytest.mark.skipif(shutil.which("uv") is None, reason="`uv` is not on the PATH")


@needs_uv
def test_builds_the_current_and_a_bumped_wheel_into_one_folder(tmp_path: Path) -> None:
    pyproject = REPO_ROOT / "watcher" / "pyproject.toml"
    pyproject_before = pyproject.read_bytes()
    current = watcher_project_version()
    bumped = bumped_version(current)
    out_dir = tmp_path / "wheels"

    current_wheel = build_watcher_wheel(out_dir)
    bumped_wheel = build_watcher_wheel(out_dir, version=bumped)

    assert current_wheel.parent == out_dir.resolve()
    assert bumped_wheel.parent == out_dir.resolve()
    assert current_wheel.name == f"data_hub_watcher-{current}-py3-none-any.whl"
    assert bumped_wheel.name == f"data_hub_watcher-{bumped}-py3-none-any.whl"
    assert wheel_version(current_wheel) == current
    assert wheel_version(bumped_wheel) == bumped
    # Both wheels hold the same code. Only the version differs.
    with zipfile.ZipFile(current_wheel) as a, zipfile.ZipFile(bumped_wheel) as b:
        sources_a = sorted(n for n in a.namelist() if n.startswith("data_hub_watcher/"))
        sources_b = sorted(n for n in b.namelist() if n.startswith("data_hub_watcher/"))
        assert "data_hub_watcher/constants.py" in sources_a
        assert sources_a == sources_b
        assert a.read("data_hub_watcher/constants.py") == b.read("data_hub_watcher/constants.py")
    # The checkout itself is not touched by building a bumped copy.
    assert pyproject.read_bytes() == pyproject_before


@needs_uv
def test_a_relative_out_dir_means_relative_to_the_caller(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    wheel = build_watcher_wheel(Path("wheels"), version=bumped_version(watcher_project_version()))

    assert wheel.is_file()
    assert wheel.parent == (tmp_path / "wheels").resolve()


def test_building_without_uv_says_so(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(testing_wheels.shutil, "which", lambda _name: None)

    with pytest.raises(RuntimeError, match="needs `uv`"):
        build_watcher_wheel(tmp_path)


def test_a_failed_build_reports_the_command_output(tmp_path: Path) -> None:
    command = [sys.executable, "-c", "import sys; print('boom'); sys.exit(3)"]

    with pytest.raises(RuntimeError, match=r"exit code 3[\s\S]*boom"):
        testing_wheels._run_uv_build(command, cwd=tmp_path)
