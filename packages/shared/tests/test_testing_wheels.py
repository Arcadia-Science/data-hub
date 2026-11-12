"""Tests for the watcher wheel builder."""

from __future__ import annotations
import re
import shutil
import sys
import zipfile
from dataclasses import dataclass
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

WATCHER_DIR = REPO_ROOT / "watcher"


def snapshot_tree(root: Path) -> dict[str, tuple[int, int] | None]:
    """Every file and folder under ``root`` except bytecode caches.

    A file maps to its modification time and size, and a folder to ``None``. Comparing two
    snapshots shows anything that was added, removed or rewritten in between.
    """
    entries: dict[str, tuple[int, int] | None] = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if "__pycache__" in relative.parts:
            continue
        if path.is_dir():
            entries[relative.as_posix()] = None
        else:
            info = path.stat()
            entries[relative.as_posix()] = (info.st_mtime_ns, info.st_size)
    return entries


def describe_changes(
    before: dict[str, tuple[int, int] | None], after: dict[str, tuple[int, int] | None]
) -> str:
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    rewritten = sorted(name for name in before.keys() & after.keys() if before[name] != after[name])
    return f"added={added[:10]} removed={removed[:10]} rewritten={rewritten[:10]}"


@dataclass(frozen=True)
class BuiltWheels:
    """The result of building the current and a bumped wheel once for this module."""

    out_dir: Path
    current: Path
    bumped: Path
    watcher_before: dict[str, tuple[int, int] | None]
    watcher_after: dict[str, tuple[int, int] | None]


@pytest.fixture(scope="module")
def built_wheels(tmp_path_factory: pytest.TempPathFactory) -> BuiltWheels:
    """Build the current and a bumped wheel once, however many tests look at them.

    Each ``uv build`` takes a few seconds, and more when the ``uv`` cache is cold, so the
    tests below share these two builds.
    """
    if shutil.which("uv") is None:
        pytest.skip("`uv` is not on the PATH")
    out_dir = tmp_path_factory.mktemp("wheels")
    before = snapshot_tree(WATCHER_DIR)

    current = build_watcher_wheel(out_dir)
    bumped = build_watcher_wheel(out_dir, version=bumped_version(watcher_project_version()))

    return BuiltWheels(out_dir, current, bumped, before, snapshot_tree(WATCHER_DIR))


def test_builds_the_current_and_a_bumped_wheel_into_one_folder(built_wheels: BuiltWheels) -> None:
    current = watcher_project_version()
    bumped = bumped_version(current)

    assert built_wheels.current.parent == built_wheels.out_dir.resolve()
    assert built_wheels.bumped.parent == built_wheels.out_dir.resolve()
    assert built_wheels.current.name == f"data_hub_watcher-{current}-py3-none-any.whl"
    assert built_wheels.bumped.name == f"data_hub_watcher-{bumped}-py3-none-any.whl"
    assert wheel_version(built_wheels.current) == current
    assert wheel_version(built_wheels.bumped) == bumped
    # Both wheels hold the same code. Only the version differs.
    with zipfile.ZipFile(built_wheels.current) as a, zipfile.ZipFile(built_wheels.bumped) as b:
        sources_a = sorted(n for n in a.namelist() if n.startswith("data_hub_watcher/"))
        sources_b = sorted(n for n in b.namelist() if n.startswith("data_hub_watcher/"))
        assert "data_hub_watcher/constants.py" in sources_a
        assert sources_a == sources_b
        assert a.read("data_hub_watcher/constants.py") == b.read("data_hub_watcher/constants.py")


def test_building_leaves_the_checkout_as_it_was(built_wheels: BuiltWheels) -> None:
    # Building in place would leave `build/` and `*.egg-info` behind. Whatever was already
    # there (an older local build, for example) must be exactly as it was too.
    assert built_wheels.watcher_after == built_wheels.watcher_before, describe_changes(
        built_wheels.watcher_before, built_wheels.watcher_after
    )


def test_the_wheel_holds_the_modules_in_src_and_no_others(built_wheels: BuiltWheels) -> None:
    # setuptools never cleans `build/lib`, so a build made in place can ship a module that
    # was since deleted from `src`.
    source_dir = WATCHER_DIR / "src" / "data_hub_watcher"
    expected = {
        path.relative_to(source_dir.parent).as_posix()
        for path in source_dir.rglob("*.py")
        if "__pycache__" not in path.parts
    }
    for wheel in (built_wheels.current, built_wheels.bumped):
        with zipfile.ZipFile(wheel) as archive:
            shipped = {n for n in archive.namelist() if n.endswith(".py")}

        assert shipped == expected


def test_the_copy_leaves_out_build_leftovers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_watcher = tmp_path / "watcher"
    (fake_watcher / "src" / "pkg").mkdir(parents=True)
    (fake_watcher / "src" / "pkg" / "kept.py").write_text("")
    (fake_watcher / "src" / "pkg" / "__pycache__").mkdir()
    (fake_watcher / "src" / "pkg" / "__pycache__" / "kept.cpython-312.pyc").write_bytes(b"")
    (fake_watcher / "src" / "pkg.egg-info").mkdir()
    (fake_watcher / "src" / "pkg.egg-info" / "PKG-INFO").write_text("")
    (fake_watcher / "build" / "lib" / "pkg").mkdir(parents=True)
    (fake_watcher / "build" / "lib" / "pkg" / "deleted_from_src.py").write_text("")
    (fake_watcher / "tests").mkdir()
    (fake_watcher / "tests" / "test_something.py").write_text("")
    (fake_watcher / "README.md").write_text("readme")
    (fake_watcher / "pyproject.toml").write_text('[project]\nname = "pkg"\nversion = "1.0.0"\n')
    monkeypatch.setattr(testing_wheels, "_WATCHER_DIR", fake_watcher)

    copy = testing_wheels._copy_watcher_with_version(tmp_path / "copy", "1.0.1000")

    copied = sorted(p.relative_to(copy).as_posix() for p in copy.rglob("*"))
    assert copied == ["README.md", "pyproject.toml", "src", "src/pkg", "src/pkg/kept.py"]
    assert tomllib.loads((copy / "pyproject.toml").read_text())["project"]["version"] == "1.0.1000"
    # The source folder it was copied from is untouched.
    assert 'version = "1.0.0"' in (fake_watcher / "pyproject.toml").read_text()


def test_a_relative_out_dir_means_relative_to_the_caller(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No real build is needed to check where the wheel is looked for, so a stand-in for
    # `uv build` writes an empty wheel into the folder it is told to use.
    commands: list[list[str]] = []

    def fake_build(command: list[str], *, cwd: Path) -> None:
        commands.append(command)
        out_dir = Path(command[command.index("--out-dir") + 1])
        (out_dir / "data_hub_watcher-1.2.3-py3-none-any.whl").write_bytes(b"")

    monkeypatch.setattr(testing_wheels.shutil, "which", lambda _name: "uv")
    monkeypatch.setattr(testing_wheels, "_run_uv_build", fake_build)
    monkeypatch.chdir(tmp_path)

    wheel = build_watcher_wheel(Path("wheels"), version="1.2.3")

    assert wheel == (tmp_path / "wheels").resolve() / "data_hub_watcher-1.2.3-py3-none-any.whl"
    assert str((tmp_path / "wheels").resolve()) in commands[0]


def test_every_build_runs_on_a_copy_outside_the_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Without a version the wheel carries the version in pyproject.toml, and the build
    # still must not run inside `watcher/`.
    seen: list[tuple[list[str], Path]] = []

    def fake_build(command: list[str], *, cwd: Path) -> None:
        seen.append((command, cwd))
        out_dir = Path(command[command.index("--out-dir") + 1])
        version = tomllib.loads((cwd / "pyproject.toml").read_text())["project"]["version"]
        (out_dir / f"data_hub_watcher-{version}-py3-none-any.whl").write_bytes(b"")

    monkeypatch.setattr(testing_wheels.shutil, "which", lambda _name: "uv")
    monkeypatch.setattr(testing_wheels, "_run_uv_build", fake_build)

    current = build_watcher_wheel(tmp_path / "wheels")
    bumped = build_watcher_wheel(tmp_path / "wheels", version="9.9.9")

    assert current.name.startswith(f"data_hub_watcher-{watcher_project_version()}-")
    assert bumped.name.startswith("data_hub_watcher-9.9.9-")
    for command, cwd in seen:
        assert "--no-sources" in command
        assert "--wheel" in command
        assert WATCHER_DIR not in (cwd, *cwd.parents)
        assert command[-1] == str(cwd)


def test_building_without_uv_says_so(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(testing_wheels.shutil, "which", lambda _name: None)

    with pytest.raises(RuntimeError, match="needs `uv`"):
        build_watcher_wheel(tmp_path)


def test_a_failed_build_reports_the_command_output(tmp_path: Path) -> None:
    command = [sys.executable, "-c", "import sys; print('boom'); sys.exit(3)"]

    with pytest.raises(RuntimeError, match=r"exit code 3[\s\S]*boom"):
        testing_wheels._run_uv_build(command, cwd=tmp_path)
