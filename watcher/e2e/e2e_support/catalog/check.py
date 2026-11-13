"""Checks that the end-to-end tests and the transition catalog agree.

The tests are read with ``ast``: nothing in ``watcher/e2e/test_*.py`` is imported or run, and
no server or database is needed, so this is fast enough for the normal unit-test run
(``watcher/tests/test_e2e_catalog.py``). Run it by hand while writing scenarios::

    cd watcher/e2e && uv run python -m e2e_support.catalog.check

The rules (``check_catalog``):

* every test module sets ``pytestmark = pytest.mark.e2e``;
* every ID in a ``covers`` marker is in the catalog;
* every ``covered`` transition has a test that is not an xfail;
* every ``xfail_bug`` transition has a strict xfail test;
* an ``excluded`` transition has no test;
* a test never runs under a kind of driver (``cli`` or ``service``) where a transition it
  covers doesn't exist. A test runs under both kinds unless ``@pytest.mark.platforms("cli")``
  (or ``"service"``) narrows it, and a test in ``test_windows_service.py`` runs only under the
  service. A transition that exists only under the service is covered from
  ``test_windows_service.py``, and is not asked for until ``SERVICE_SUITE_READY`` is true;
* a known-bug test follows the pattern: ``xfail(strict=True, raises=KnownBugStillPresent,
  reason="<bug>: ...")``, a ``with known_bug():`` block around the intended-behavior
  assertion, and only ``xfail_bug`` transitions in ``covers``. The reason starts with the bug
  of one of those transitions (its Linear issue, such as ``ENG-1234``, or a short slug until
  the issue is filed). A test that isn't an xfail never names an ``xfail_bug`` transition.

What counts as a marker: ``@pytest.mark.covers("id", ...)``, ``@pytest.mark.platforms("cli")``
and ``@pytest.mark.xfail(...)`` on a test function, on a test class (which applies to all its
methods), or in a module-level ``pytestmark``. A marker that appears at several levels follows
pytest's own rule for the ones that can only apply once: the closest wins (function, then
class, then module), and ``covers`` adds up.

Coverage must not be hidden from the check, so a test file may not contain any of these, in
any function: ``pytest.skip(...)``, ``pytest.xfail(...)``, ``pytest.importorskip(...)``, the
marks ``skip`` and ``skipif``, ``pytest.param(..., marks=...)``, an ``xfail`` with a condition,
and a mark the check can't read (a decorator that isn't ``pytest.mark.<name>``, or a mark kept
in a variable). The way to run a test under one kind of driver only is the ``platforms``
marker, which the check understands and the suite's ``conftest.py`` enforces. A skip that
depends on the machine (running as root, say) goes in a fixture in ``conftest.py``.
"""

from __future__ import annotations
import ast
import sys
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypeGuard

from e2e_support.catalog import (
    ALL_TRANSITIONS,
    BOTH,
    DRIVER_KINDS,
    MACHINES,
    SERVICE,
    SERVICE_SUITE_READY,
    SERVICE_TEST_FILE,
    Transition,
)

__all__ = ["CatalogReport", "TestInfo", "check_catalog", "collect_tests", "main"]

E2E_DIR = Path(__file__).resolve().parents[2]

# The names the check looks for in the test files (they live in e2e_support.waiting).
KNOWN_BUG_EXCEPTION = "KnownBugStillPresent"
KNOWN_BUG_CONTEXT = "known_bug"

# Calls that skip or xfail from inside a test (or a helper), which the check can't see.
_HIDING_CALLS = frozenset({"skip", "xfail", "importorskip"})


@dataclass(frozen=True)
class TestInfo:
    """One test function, as the markers around it say.

    ``xfail`` and ``strict_xfail`` describe the *closest* ``xfail`` marker, the one pytest
    applies. ``marked_platforms`` is the closest ``platforms`` marker (``None`` if there is
    none), and :attr:`platforms` adds what the file name says.
    """

    __test__ = False  # Not a test class, whatever pytest makes of the name.

    file: str
    name: str
    covers: tuple[str, ...]
    strict_xfail: bool
    xfail: bool
    marked_platforms: frozenset[str] | None = None
    xfail_raises_known_bug: bool = False
    xfail_reason: str | None = None
    wraps_known_bug: bool = False

    @property
    def platforms(self) -> frozenset[str]:
        """The kinds of driver this test runs under: the service only for a test in
        ``test_windows_service.py``, both otherwise, narrowed by a ``platforms`` marker."""
        base = SERVICE if self.file == SERVICE_TEST_FILE else BOTH
        return base if self.marked_platforms is None else base & self.marked_platforms

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
    marker_errors: list[str] = field(default_factory=list)
    known_bug_problems: list[str] = field(default_factory=list)

    @property
    def problems(self) -> int:
        return (
            sum(len(v) for v in self.missing.values())
            + len(self.wrong_kind)
            + len(self.unknown)
            + len(self.excluded_with_tests)
            + len(self.platform_mismatch)
            + len(self.module_problems)
            + len(self.marker_errors)
            + len(self.known_bug_problems)
        )

    def format(self) -> str:
        """A message that lists exactly what is wrong, ready for an assertion."""
        if self.problems == 0:
            return "The end-to-end catalog and tests agree."
        lines = [f"The end-to-end catalog and tests disagree ({self.problems} problem(s))."]
        for title, items in (
            ("Test modules without `pytestmark = pytest.mark.e2e`", self.module_problems),
            (
                "Markers and calls the check can't allow (they hide coverage from it)",
                self.marker_errors,
            ),
            ("Tests that name an ID that is not in the catalog", self.unknown),
            (
                "Tests for excluded transitions (drop the test or the exclusion)",
                self.excluded_with_tests,
            ),
            ("Tests on a driver kind the transition doesn't exist for", self.platform_mismatch),
            ("Known-bug tests that don't follow the pattern", self.known_bug_problems),
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
# Reading the markers
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


@dataclass(frozen=True)
class _Xfail:
    strict: bool
    raises_known_bug: bool
    reason: str | None


@dataclass(frozen=True)
class _Mark:
    """One marker, read once: what it says, if it is a kind the check knows."""

    name: str
    covers: tuple[str, ...] = ()
    platforms: frozenset[str] | None = None
    xfail: _Xfail | None = None


@dataclass(frozen=True)
class _Level:
    """The marks of one function, class or module.

    ``source`` is in the order they are written. pytest applies the decorators nearest the
    ``def`` first, so for a function or class the closest mark is the last one written, and
    for a module's ``pytestmark`` list it is the first.
    """

    source: tuple[_Mark, ...]
    decorators: bool

    def closest_first(self) -> list[_Mark]:
        return list(reversed(self.source)) if self.decorators else list(self.source)


def _string_args(call: ast.Call | None, name: str, where: str, errors: list[str]) -> list[str]:
    values: list[str] = []
    if call is None:
        errors.append(f"{where}: `{name}` must be called with string literals")
        return values
    for arg in call.args:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            values.append(arg.value)
        else:
            errors.append(f"{where}: `{name}` takes string literals only")
    if call.keywords:
        errors.append(f"{where}: `{name}` takes no keyword arguments")
    return values


def _parse_platforms(call: ast.Call | None, where: str, errors: list[str]) -> frozenset[str] | None:
    kinds = _string_args(call, "platforms", where, errors)
    unknown = sorted(set(kinds) - set(DRIVER_KINDS))
    if not kinds or unknown:
        errors.append(
            f"{where}: `platforms` takes one or more of {list(DRIVER_KINDS)}"
            + (f", not {unknown}" if unknown else "")
        )
        return None
    return frozenset(kinds)


def _parse_xfail(call: ast.Call | None, where: str, errors: list[str]) -> _Xfail:
    strict = False
    raises_known_bug = False
    reason: str | None = None
    if call is None:
        return _Xfail(strict, raises_known_bug, reason)
    if call.args:
        errors.append(
            f"{where}: `xfail` with a condition hides the test when the condition is false; "
            "an xfail is unconditional"
        )
    for keyword in call.keywords:
        value = keyword.value
        if keyword.arg is None:
            errors.append(f"{where}: `xfail(**...)` can't be read by the check")
        elif keyword.arg == "condition":
            errors.append(f"{where}: `xfail(condition=...)` is conditional, which isn't allowed")
        elif keyword.arg == "run":
            if not (isinstance(value, ast.Constant) and value.value is True):
                errors.append(f"{where}: `xfail(run=...)` would not run the test")
        elif keyword.arg == "strict":
            strict = isinstance(value, ast.Constant) and value.value is True
        elif keyword.arg == "raises":
            raises_known_bug = (
                isinstance(value, ast.Name) and value.id == KNOWN_BUG_EXCEPTION
            ) or (isinstance(value, ast.Attribute) and value.attr == KNOWN_BUG_EXCEPTION)
        elif keyword.arg == "reason":
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                reason = value.value
            else:
                errors.append(f"{where}: the `xfail` reason must be a plain string")
    return _Xfail(strict, raises_known_bug, reason)


def _read_level(
    nodes: Iterable[ast.expr], where: str, errors: list[str], *, decorators: bool
) -> _Level:
    """Read the marks of one function, class or module, reporting what can't be allowed.

    Every level is read once, so a problem in a module's ``pytestmark`` is reported once and
    not once per test."""
    marks: list[_Mark] = []
    for node in nodes:
        marker = _marker_name(node)
        if marker is None:
            errors.append(
                f"{where}: `{ast.unparse(node)}` is not a plain `pytest.mark.<name>(...)`, so "
                "the check can't read what it marks (write the mark out where it is used)"
            )
            continue
        name, call = marker
        if name in ("skip", "skipif"):
            errors.append(
                f"{where}: `{name}` hides the test from the catalog. Narrow a test to one kind "
                '`@pytest.mark.platforms("cli")` (or "service"), and put a skip that depends '
                "on the machine in a fixture in conftest.py"
            )
        elif name == "covers":
            marks.append(_Mark(name, covers=tuple(_string_args(call, name, where, errors))))
        elif name == "platforms":
            marks.append(_Mark(name, platforms=_parse_platforms(call, where, errors)))
        elif name == "xfail":
            marks.append(_Mark(name, xfail=_parse_xfail(call, where, errors)))
        else:
            marks.append(_Mark(name))
    return _Level(tuple(marks), decorators)


@dataclass(frozen=True)
class _Effective:
    """What pytest would see for one test, from the marks at the three levels."""

    covers: tuple[str, ...]
    e2e: bool
    platforms: frozenset[str] | None
    xfail: _Xfail | None


def _effective(levels: Sequence[_Level]) -> _Effective:
    """Combine ``levels`` given from the farthest (module) to the closest (function).

    ``covers`` adds up. The marks that apply once, ``platforms`` and ``xfail``, come from the
    closest level that has one, and from its closest mark."""
    covers = tuple(c for level in levels for mark in level.source for c in mark.covers)
    e2e = any(mark.name == "e2e" for level in levels for mark in level.source)
    nearest = [mark for level in reversed(levels) for mark in level.closest_first()]
    platforms = next((m.platforms for m in nearest if m.name == "platforms"), None)
    xfail = next((m.xfail for m in nearest if m.name == "xfail"), None)
    return _Effective(covers, e2e, platforms, xfail)


# ---------------------------------------------------------------------------
# Reading the files
# ---------------------------------------------------------------------------


def _is_test_function(node: ast.stmt) -> TypeGuard[ast.FunctionDef | ast.AsyncFunctionDef]:
    return isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith(
        "test"
    )


def _pytestmark_nodes(module: ast.Module, where: str, errors: list[str]) -> list[ast.expr]:
    nodes: list[ast.expr] = []
    for statement in module.body:
        if isinstance(statement, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "pytestmark" for t in statement.targets
        ):
            value = statement.value
            nodes += list(value.elts) if isinstance(value, (ast.List, ast.Tuple)) else [value]
        elif (
            isinstance(statement, (ast.AugAssign, ast.AnnAssign))
            and isinstance(statement.target, ast.Name)
            and statement.target.id == "pytestmark"
        ):
            errors.append(f"{where}: set `pytestmark` once, as a list, with a plain assignment")
    return nodes


def _calls_known_bug(function: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """Whether the function has a ``with known_bug():`` block."""
    for node in ast.walk(function):
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                expr = item.context_expr
                if isinstance(expr, ast.Call):
                    target = expr.func
                    if isinstance(target, ast.Name) and target.id == KNOWN_BUG_CONTEXT:
                        return True
                    if isinstance(target, ast.Attribute) and target.attr == KNOWN_BUG_CONTEXT:
                        return True
    return False


def _hiding_constructs(module: ast.Module, file: str) -> list[str]:
    """Everything in the file that skips, or marks, a test where the check can't see it."""
    problems: list[str] = []
    for node in ast.walk(module):
        where = f"{file}:{getattr(node, 'lineno', 0)}"
        if isinstance(node, ast.Call):
            func = node.func
            if (
                isinstance(func, ast.Attribute)
                and isinstance(func.value, ast.Name)
                and func.value.id == "pytest"
            ):
                if func.attr in _HIDING_CALLS:
                    problems.append(
                        f"{where}: `pytest.{func.attr}(...)` skips (or xfails) a test at run "
                        "time, where the check can't see it. Use the `platforms` marker, or a "
                        "fixture in conftest.py"
                    )
                elif func.attr == "param" and any(k.arg == "marks" for k in node.keywords):
                    problems.append(
                        f"{where}: `pytest.param(..., marks=...)` puts marks where the check "
                        "doesn't read them; split the test, or put the mark on the test"
                    )
        elif isinstance(node, ast.ImportFrom) and node.module == "pytest":
            for alias in node.names:
                if alias.name in _HIDING_CALLS:
                    problems.append(
                        f"{where}: `from pytest import {alias.name}` hides skips from the "
                        "check; call `pytest.<name>` (which is refused too) or use a marker"
                    )
        elif isinstance(node, ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if "pytestmark" not in targets and _marker_name(node.value) is not None:
                problems.append(
                    f"{where}: `{ast.unparse(node)}` keeps a mark in a variable, which the "
                    "check can't follow. Write the mark out on the test"
                )
        elif isinstance(node, ast.ClassDef):
            for child in node.body:
                if isinstance(child, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == "pytestmark" for t in child.targets
                ):
                    problems.append(
                        f"{file}:{child.lineno}: a `pytestmark` inside a class isn't read; "
                        "decorate the class with the marks instead"
                    )
    return problems


def collect_tests(
    e2e_dir: Path = E2E_DIR, *, errors: list[str] | None = None
) -> tuple[list[TestInfo], list[str]]:
    """Read ``test_*.py`` in ``e2e_dir`` and return the tests, and the modules that lack the
    ``e2e`` marker (as problem lines). Markers and calls the check can't allow are added to
    ``errors``."""
    tests: list[TestInfo] = []
    module_problems: list[str] = []
    marker_errors: list[str] = errors if errors is not None else []
    for path in sorted(e2e_dir.glob("test_*.py")):
        module = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        marker_errors.extend(_hiding_constructs(module, path.name))
        module_level = _read_level(
            _pytestmark_nodes(module, path.name, marker_errors),
            path.name,
            marker_errors,
            decorators=False,
        )
        if not _effective([module_level]).e2e:
            module_problems.append(f"{path.name} (set `pytestmark = pytest.mark.e2e`)")

        def add(
            function: ast.FunctionDef | ast.AsyncFunctionDef,
            outer: Sequence[_Level],
            owner: str = "",
            file: str = path.name,
        ) -> None:
            where = f"{file}::{owner}{function.name}"
            own = _read_level(function.decorator_list, where, marker_errors, decorators=True)
            effective = _effective([*outer, own])
            xfail = effective.xfail
            tests.append(
                TestInfo(
                    file=file,
                    name=f"{owner}{function.name}",
                    covers=effective.covers,
                    strict_xfail=xfail is not None and xfail.strict,
                    xfail=xfail is not None,
                    marked_platforms=effective.platforms,
                    xfail_raises_known_bug=xfail is not None and xfail.raises_known_bug,
                    xfail_reason=None if xfail is None else xfail.reason,
                    wraps_known_bug=_calls_known_bug(function),
                )
            )

        for node in module.body:
            if _is_test_function(node):
                add(node, [module_level])
            elif isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
                class_level = _read_level(
                    node.decorator_list,
                    f"{path.name}::{node.name}",
                    marker_errors,
                    decorators=True,
                )
                for child in node.body:
                    if _is_test_function(child):
                        add(child, [module_level, class_level], owner=f"{node.name}::")
    return tests, module_problems


# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------


def _known_bug_problems(tests: Sequence[TestInfo], by_id: dict[str, Transition]) -> list[str]:
    problems: list[str] = []
    for test in tests:
        named = [by_id[i] for i in test.covers if i in by_id]
        bugs = [t for t in named if t.status == "xfail_bug"]
        if not test.xfail:
            if bugs:
                problems.append(
                    f"{test.label} names the known-bug transition(s) "
                    f"{', '.join(t.id for t in bugs)} but isn't marked xfail. A test of a "
                    "known bug is `xfail(strict=True, raises=KnownBugStillPresent, ...)`"
                )
            continue
        if not test.strict_xfail:
            problems.append(
                f"{test.label}: the xfail must be strict=True, so that the day the bug is "
                "fixed the test fails loudly"
            )
        if not test.xfail_raises_known_bug:
            problems.append(
                f"{test.label}: the xfail needs `raises={KNOWN_BUG_EXCEPTION}`, so that a "
                "failure outside `known_bug()` fails the test and is not an expected failure"
            )
        if not test.wraps_known_bug:
            problems.append(
                f"{test.label}: no `with {KNOWN_BUG_CONTEXT}():` block. Wrap the one "
                "assertion (or wait) that shows the intended behavior in it and nothing else"
            )
        not_bugs = [t.id for t in named if t.status != "xfail_bug"]
        if not_bugs:
            problems.append(
                f"{test.label}: an xfail test names only xfail_bug transitions, not "
                f"{', '.join(not_bugs)}"
            )
        bug_names = [t.bug for t in bugs if t.bug]
        reason = test.xfail_reason or ""
        if not any(reason.startswith(f"{name}:") for name in bug_names):
            wanted = " or ".join(f"'{name}: ...'" for name in bug_names) or "its bug"
            problems.append(
                f"{test.label}: the xfail reason must start with {wanted}, not {reason[:60]!r}"
            )
    return problems


def check_catalog(
    tests: Sequence[TestInfo],
    transitions: Sequence[Transition] = ALL_TRANSITIONS,
    *,
    service_suite_ready: bool = SERVICE_SUITE_READY,
    module_problems: Sequence[str] = (),
    marker_errors: Sequence[str] = (),
) -> CatalogReport:
    """Compare ``tests`` with ``transitions`` and report every disagreement."""
    by_id = {t.id: t for t in transitions}
    covering: dict[str, list[TestInfo]] = defaultdict(list)
    unknown: list[str] = []
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
            if transition.platforms == SERVICE and test.file != SERVICE_TEST_FILE:
                platform_mismatch.append(
                    f"{test.label} covers {transition_id!r}, which exists only under the "
                    f"service (put it in {SERVICE_TEST_FILE})"
                )
            elif not test.platforms:
                platform_mismatch.append(
                    f"{test.label} is marked for a kind of driver its file never runs under, "
                    "so it runs nowhere"
                )
            else:
                extra = test.platforms - transition.platforms
                if extra:
                    only = _kinds(transition.platforms)
                    platform_mismatch.append(
                        f"{test.label} runs under {_kinds(extra)} but covers "
                        f"{transition_id!r}, which exists only under {only} "
                        f'(mark the test `@pytest.mark.platforms("{only}")`)'
                    )

    missing: dict[str, list[Transition]] = defaultdict(list)
    wrong_kind: list[str] = []
    for transition in transitions:
        if transition.status == "excluded":
            continue
        if transition.platforms == SERVICE and not service_suite_ready:
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
        marker_errors=list(marker_errors),
        known_bug_problems=_known_bug_problems(tests, by_id),
    )


def _kinds(kinds: frozenset[str]) -> str:
    return "/".join(kind for kind in DRIVER_KINDS if kind in kinds)


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
                and (SERVICE_SUITE_READY or t.platforms != SERVICE)
            ]
            missing = len(report.missing.get(machine, []))
            print(f"{machine:24s} {missing:3d} missing of {len(needed)}")
        print(f"{'(all)':24s} {sum(len(v) for v in report.missing.values()):3d} missing")
    else:
        print(report.format())
    return 1 if report.problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
