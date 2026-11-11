"""Build watcher wheels for end-to-end tests.

The self-update tests need two builds of the watcher: the current one, to install first,
and a "next" one with a higher version, for the watcher to upgrade to. Both come from the
checkout under test, so no release is needed.

The version is the only difference between them. The watcher reports its version at
runtime by reading the installed package's metadata (``importlib.metadata``), so the
version baked into the wheel at build time is the version the watcher advertises in its
heartbeats.
"""

from __future__ import annotations
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import tomllib

__all__ = ["build_watcher_wheel", "bumped_version", "watcher_project_version"]

# testing_wheels.py lives at packages/shared/src/data_hub_shared/. Walk up 4 levels to
# the repo root, the same as testing.py does.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_WATCHER_DIR = _REPO_ROOT / "watcher"
_WATCHER_PYPROJECT = _WATCHER_DIR / "pyproject.toml"
_PACKAGE_NAME = "data-hub-watcher"

# The server compares versions with its own loose parser (compareVersions in
# web/lib/api/watcher-versions.ts), which reads "MAJOR.MINOR.PATCH" followed by an
# optional suffix. Keeping bumped versions to plain MAJOR.MINOR.PATCH means any parser
# reads them the same way.
_PLAIN_VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")

_BUILD_TIMEOUT_SECONDS = 600


def watcher_project_version() -> str:
    """Return the watcher's version as written in ``watcher/pyproject.toml``."""
    with _WATCHER_PYPROJECT.open("rb") as file:
        return tomllib.load(file)["project"]["version"]


def bumped_version(version: str, patch_offset: int = 1000) -> str:
    """Return a higher version made by adding ``patch_offset`` to the patch number.

    ``1.4.0`` becomes ``1.4.1000``. The result is still a plain three-part version, and
    far above any real release of the same minor version, so the watcher and the server
    always treat it as newer. Raises ``ValueError`` if ``version`` is not a plain
    ``MAJOR.MINOR.PATCH`` version or if ``patch_offset`` is not positive.
    """
    match = _PLAIN_VERSION.match(version)
    if match is None:
        raise ValueError(f"Expected a plain MAJOR.MINOR.PATCH version, got {version!r}.")
    if patch_offset < 1:
        raise ValueError(f"patch_offset must be at least 1, got {patch_offset}.")
    major, minor, patch = (int(part) for part in match.groups())
    return f"{major}.{minor}.{patch + patch_offset}"


def build_watcher_wheel(out_dir: Path, *, version: str | None = None) -> Path:
    """Build the watcher wheel into ``out_dir`` and return the path to the wheel file.

    The wheel carries ``version``, or the version in ``watcher/pyproject.toml`` when
    ``version`` is left out. Either way the build runs on a temporary copy of the
    watcher, so the checkout itself is not touched: no ``watcher/build`` or
    ``*.egg-info`` appears in it. It also means the build can't pick up a module that was
    deleted from ``src`` but still sits in an older ``build/lib``, because setuptools
    never cleans that folder. The current wheel and a bumped wheel come from identical
    trees, and the version is the only thing that differs.

    The copy is built outside the uv workspace, so ``uv build --no-sources`` ignores the
    workspace links in the watcher's ``pyproject.toml``.

    Needs ``uv`` on the PATH, and network access the first time, to fetch the build tools.
    """
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    uv = shutil.which("uv")
    if uv is None:
        raise RuntimeError("Building a watcher wheel needs `uv` on the PATH.")

    built_version = version or watcher_project_version()
    with tempfile.TemporaryDirectory(prefix="watcher-wheel-", ignore_cleanup_errors=True) as tmp:
        copy = _copy_watcher_with_version(Path(tmp) / "watcher", built_version)
        _run_uv_build(
            [uv, "build", "--wheel", "--no-sources", "--out-dir", str(out_dir), str(copy)],
            cwd=copy,
        )

    wheels = sorted(out_dir.glob(f"data_hub_watcher-{built_version}-*.whl"))
    if len(wheels) != 1:
        raise RuntimeError(
            f"Expected one wheel for version {built_version} in {out_dir}, found {wheels}."
        )
    return wheels[0]


def _copy_watcher_with_version(destination: Path, version: str) -> Path:
    """Copy what a wheel build needs from ``watcher/`` and set its version."""
    destination.mkdir(parents=True)
    # The build needs pyproject.toml plus the files it names (README, LICENSE), which sit
    # beside it, and the source tree. Only the files directly in ``watcher/`` are copied, so
    # ``tests/`` and an old ``build/`` folder stay behind, and the copy leaves out
    # ``*.egg-info`` and bytecode from the source tree.
    for item in _WATCHER_DIR.iterdir():
        if item.is_file():
            shutil.copy2(item, destination / item.name)
    shutil.copytree(
        _WATCHER_DIR / "src",
        destination / "src",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.egg-info"),
    )

    pyproject = destination / "pyproject.toml"
    pyproject.write_text(
        _with_project_version(pyproject.read_text(encoding="utf-8"), version), encoding="utf-8"
    )
    with pyproject.open("rb") as file:
        written = tomllib.load(file)["project"]["version"]
    if written != version:
        raise RuntimeError(f"Failed to set the version to {version!r}; the copy says {written!r}.")
    return destination


def _with_project_version(pyproject_text: str, version: str) -> str:
    """Replace the ``version`` line inside the ``[project]`` table."""
    header = re.search(r"(?m)^\[project\]\s*$", pyproject_text)
    if header is None:
        raise RuntimeError("watcher/pyproject.toml has no [project] table.")
    next_table = re.search(r"(?m)^\[", pyproject_text[header.end() :])
    end = header.end() + next_table.start() if next_table else len(pyproject_text)
    section = pyproject_text[header.end() : end]
    new_section, replaced = re.subn(
        r'(?m)^version\s*=\s*"[^"]*"', f'version = "{version}"', section, count=1
    )
    if replaced != 1:
        raise RuntimeError("watcher/pyproject.toml has no version line in [project].")
    return pyproject_text[: header.end()] + new_section + pyproject_text[end:]


def _run_uv_build(command: list[str], *, cwd: Path) -> None:
    result = subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=_BUILD_TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"`{' '.join(command)}` failed with exit code {result.returncode}.\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
