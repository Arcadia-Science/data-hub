"""Checks that the end-to-end tests and the transition catalog agree.

The tests are read with ``ast``: nothing in ``watcher/e2e/test_*.py`` is imported or run, and
no server or database is needed, so this is fast enough for the normal unit-test run
(``watcher/tests/test_e2e_catalog.py``). Run it by hand while writing scenarios::

    cd watcher/e2e && uv run python -m e2e_support.catalog.check

The rules (``check_catalog``):

* every test module sets ``pytestmark = pytest.mark.e2e``;
* every ID in a ``covers`` marker is in the catalog;
* every ``covered`` transition has a test that is not an xfail;
* every ``xfail_bug`` transition has a test marked ``xfail(strict=True)``;
* an ``excluded`` transition has no test;
* a transition that exists only on Windows is covered by ``test_windows_service.py``, and one
  that exists only on Linux is not covered there. Other test files count for both platforms.
  Windows-only transitions are not asked for until ``WINDOWS_SUITE_READY`` is true.

What counts as a marker: ``@pytest.mark.covers("id", ...)`` and
``@pytest.mark.xfail(..., strict=True)`` on a test function, on a test class (which covers
all its methods), or in a module-level ``pytestmark``. Put them there, not inside
``pytest.param(..., marks=...)``, which this check does not read.
"""

from __future__ import annotations
import ast
import sys
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TypeGuard

from e2e_support.catalog import (
    ALL_TRANSITIONS,
    BOTH,
    MACHINES,
    WINDOWS,
    WINDOWS_SUITE_READY,
    WINDOWS_TEST_FILE,
    Transition,
)

__all__ = ["CatalogReport", "TestInfo", "check_catalog", "collect_tests", "main"]

E2E_DIR = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class TestInfo:
    """One test function, as the markers around it say."""

    __test__ = False  # Not a test class, whatever pytest makes of the name.

    file: str
    name: str
    covers: tuple[str, ...]
    strict_xfail: bool
    xfail: bool

    @property
    def platforms(self) -> frozenset[str]:
        """Where this test runs: the Windows service only, or both drivers."""
        return WINDOWS if self.file == WINDOWS_TEST_FILE else BOTH

    @property
    def label(self) -> str:
        return f"{self.file}::{self.name}"


@dataclass(frozen=True)
class CatalogReport:
    """The problems ``check_catalog`` found, grouped so a message can say what is missing."""

    missing: dict[str, list[Transition]]  # machine -> transitions that need a test
    wrong_kind: list[str]  # xfail/covered mismatches
    unknown: list[str]
    excluded_with_tests: list[str]
    platform_mismatch: list[str]
    module_problems: list[str]

    @property
    def problems(self) -> int:
        return (
            sum(len(v) for v in self.missing.values())
            + len(self.wrong_kind)
            + len(self.unknown)
            + len(self.excluded_with_tests)
            + len(self.platform_mismatch)
            + len(self.module_problems)
        )

    def format(self) -> str:
        """A message that lists exactly what is wrong, ready for an assertion."""
        if self.problems == 0:
            return "The end-to-end catalog and tests agree."
        lines = [f"The end-to-end catalog and tests disagree ({self.problems} problem(s))."]
        for title, items in (
            ("Test modules without `pytestmark = pytest.mark.e2e`", self.module_problems),
            ("Tests that name an ID that is not in the catalog", self.unknown),
            (
                "Tests for excluded transitions (drop the test or the exclusion)",
                self.excluded_with_tests,
            ),
            ("Tests on a platform the transition doesn't exist on", self.platform_mismatch),
            ("Tests of the wrong kind for the transition's status", self.wrong_kind),
        ):
            if items:
                lines.append(f"\n{title} ({len(items)}):")
                lines += [f"  {item}" for item in items]
        if self.missing:
            total = sum(len(v) for v in self.missing.values())
            lines.append(f"\nTransitions with no test ({total}):")
            order = {name: index for index, name in enumerate(MACHINES)}
            for machine in sorted(
                self.missing, key=lambda name: (order.get(name, len(order)), name)
            ):
                entries = self.missing[machine]
                lines.append(f"  [{machine}] {len(entries)} missing")
                for t in entries:
                    kind = "xfail(strict=True) test" if t.status == "xfail_bug" else "test"
                    lines.append(f"    {t.id}  needs a {kind}: {t.description}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Reading the tests
# ---------------------------------------------------------------------------


def _marker_name(node: ast.expr) -> tuple[str, ast.Call | None] | None:
    """``("covers", call)`` for ``pytest.mark.covers(...)``; ``None`` if it isn't a marker."""
    call = node if isinstance(node, ast.Call) else None
    target = node.func if isinstance(node, ast.Call) else node
    if isinstance(target, ast.Attribute):
        owner = target.value
        if isinstance(owner, ast.Attribute) and owner.attr == "mark":
            return target.attr, call
        if isinstance(owner, ast.Name) and owner.id == "mark":
            return target.attr, call
    return None


@dataclass
class _Markers:
    covers: list[str]
    strict_xfail: bool = False
    xfail: bool = False
    e2e: bool = False

    def merged(self, other: _Markers) -> _Markers:
        return _Markers(
            covers=[*self.covers, *other.covers],
            strict_xfail=self.strict_xfail or other.strict_xfail,
            xfail=self.xfail or other.xfail,
            e2e=self.e2e or other.e2e,
        )


def _read_markers(nodes: Iterable[ast.expr], where: str, errors: list[str]) -> _Markers:
    found = _Markers(covers=[])
    for node in nodes:
        marker = _marker_name(node)
        if marker is None:
            continue
        name, call = marker
        if name == "e2e":
            found.e2e = True
        elif name == "covers":
            if call is None:
                errors.append(f"{where}: `covers` must be called with the IDs it covers")
                continue
            for arg in call.args:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    found.covers.append(arg.value)
                else:
                    errors.append(f"{where}: `covers` takes string literals only")
        elif name == "xfail":
            found.xfail = True
            if call is not None:
                for keyword in call.keywords:
                    if (
                        keyword.arg == "strict"
                        and isinstance(keyword.value, ast.Constant)
                        and keyword.value.value is True
                    ):
                        found.strict_xfail = True
    return found


def _is_test_function(node: ast.stmt) -> TypeGuard[ast.FunctionDef | ast.AsyncFunctionDef]:
    return isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith(
        "test"
    )


def _pytestmark_nodes(module: ast.Module) -> list[ast.expr]:
    nodes: list[ast.expr] = []
    for statement in module.body:
        if isinstance(statement, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "pytestmark" for t in statement.targets
        ):
            value = statement.value
            nodes += list(value.elts) if isinstance(value, (ast.List, ast.Tuple)) else [value]
    return nodes


def collect_tests(
    e2e_dir: Path = E2E_DIR, *, errors: list[str] | None = None
) -> tuple[list[TestInfo], list[str]]:
    """Read ``test_*.py`` in ``e2e_dir`` and return the tests, and the modules that lack the
    ``e2e`` marker (as problem lines). Unreadable markers are added to ``errors`` too."""
    tests: list[TestInfo] = []
    module_problems: list[str] = []
    marker_errors: list[str] = errors if errors is not None else []
    for path in sorted(e2e_dir.glob("test_*.py")):
        module = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        module_markers = _read_markers(_pytestmark_nodes(module), path.name, marker_errors)
        if not module_markers.e2e:
            module_problems.append(f"{path.name} (set `pytestmark = pytest.mark.e2e`)")

        def add(
            function: ast.FunctionDef | ast.AsyncFunctionDef,
            inherited: _Markers,
            owner: str = "",
            file: str = path.name,
        ) -> None:
            where = f"{file}::{owner}{function.name}"
            own = _read_markers(function.decorator_list, where, marker_errors)
            markers = inherited.merged(own)
            tests.append(
                TestInfo(
                    file=file,
                    name=f"{owner}{function.name}",
                    covers=tuple(markers.covers),
                    strict_xfail=markers.strict_xfail,
                    xfail=markers.xfail,
                )
            )

        for node in module.body:
            if _is_test_function(node):
                add(node, module_markers)
            elif isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
                class_markers = module_markers.merged(
                    _read_markers(node.decorator_list, f"{path.name}::{node.name}", marker_errors)
                )
                for child in node.body:
                    if _is_test_function(child):
                        add(child, class_markers, owner=f"{node.name}::")
    return tests, module_problems


# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------


def check_catalog(
    tests: Sequence[TestInfo],
    transitions: Sequence[Transition] = ALL_TRANSITIONS,
    *,
    windows_suite_ready: bool = WINDOWS_SUITE_READY,
    module_problems: Sequence[str] = (),
    marker_errors: Sequence[str] = (),
) -> CatalogReport:
    """Compare ``tests`` with ``transitions`` and report every disagreement."""
    by_id = {t.id: t for t in transitions}
    covering: dict[str, list[TestInfo]] = defaultdict(list)
    unknown: list[str] = list(marker_errors)
    excluded_with_tests: list[str] = []
    platform_mismatch: list[str] = []

    for test in tests:
        for transition_id in test.covers:
            transition = by_id.get(transition_id)
            if transition is None:
                unknown.append(f"{test.label} names {transition_id!r}")
                continue
            covering[transition_id].append(test)
            if transition.status == "excluded":
                excluded_with_tests.append(
                    f"{test.label} covers {transition_id!r}: {transition.reason}"
                )
            if transition.platforms == WINDOWS and test.file != WINDOWS_TEST_FILE:
                platform_mismatch.append(
                    f"{test.label} covers {transition_id!r}, which exists only on Windows "
                    f"(put it in {WINDOWS_TEST_FILE})"
                )
            if "windows" not in transition.platforms and test.file == WINDOWS_TEST_FILE:
                platform_mismatch.append(
                    f"{test.label} covers {transition_id!r}, which doesn't exist on Windows"
                )

    missing: dict[str, list[Transition]] = defaultdict(list)
    wrong_kind: list[str] = []
    for transition in transitions:
        if transition.status == "excluded":
            continue
        if transition.platforms == WINDOWS and not windows_suite_ready:
            continue
        tests_here = covering.get(transition.id, [])
        for platform in sorted(transition.platforms):
            runs_on = [t for t in tests_here if platform in t.platforms]
            if transition.status == "covered":
                ok = any(not t.xfail for t in runs_on)
            else:
                ok = any(t.strict_xfail for t in runs_on)
            if ok:
                continue
            if not runs_on:
                if transition not in missing[transition.machine]:
                    missing[transition.machine].append(transition)
            elif transition.status == "covered":
                wrong_kind.append(
                    f"{transition.id} is `covered` but only xfail tests cover it "
                    f"({', '.join(t.label for t in runs_on)}); a covered transition needs a "
                    "test that passes"
                )
            else:
                wrong_kind.append(
                    f"{transition.id} is `xfail_bug` ({transition.bug}) but no test that covers "
                    f"it is marked xfail(strict=True) ({', '.join(t.label for t in runs_on)})"
                )
    return CatalogReport(
        missing=dict(missing),
        wrong_kind=sorted(set(wrong_kind)),
        unknown=unknown,
        excluded_with_tests=excluded_with_tests,
        platform_mismatch=platform_mismatch,
        module_problems=list(module_problems),
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Print the report for ``watcher/e2e``, or with ``--summary`` the missing count per machine."""
    args = list(sys.argv[1:] if argv is None else argv)
    errors: list[str] = []
    tests, module_problems = collect_tests(errors=errors)
    report = check_catalog(tests, module_problems=module_problems, marker_errors=errors)
    if "--summary" in args:
        for machine in MACHINES:
            needed = [
                t
                for t in ALL_TRANSITIONS
                if t.machine == machine
                and t.status != "excluded"
                and (WINDOWS_SUITE_READY or t.platforms != WINDOWS)
            ]
            missing = len(report.missing.get(machine, []))
            print(f"{machine:24s} {missing:3d} missing of {len(needed)}")
        print(f"{'(all)':24s} {sum(len(v) for v in report.missing.values()):3d} missing")
    else:
        print(report.format())
    return 1 if report.problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
