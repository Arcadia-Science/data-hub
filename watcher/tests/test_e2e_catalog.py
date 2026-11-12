"""The end-to-end suite's transition catalog and its tests must agree.

``watcher/e2e`` holds the end-to-end tests, which need a server and are not part of this run.
This test reads them with ``ast`` (nothing is imported or run) and compares the
``@pytest.mark.covers(...)`` markers with the catalog in ``watcher/e2e/e2e_support/catalog``.
It is fast and runs in the normal unit-test run, so a pull request that adds a transition
without a test, deletes a test, or names an ID that doesn't exist fails here.

``test_every_transition_has_the_right_kind_of_test`` fails, and lists what is wrong, when a
transition has no test, a test names something that isn't in the catalog, a known-bug test
doesn't follow the pattern, or a test hides coverage from the check (a skip, say). Run the same
check by hand, with the missing count per machine::

    cd watcher/e2e && uv run python -m e2e_support.catalog.check --summary
"""

from __future__ import annotations
import re
import textwrap
from pathlib import Path

import pytest

from e2e_support import catalog
from e2e_support.catalog import BOTH, CLI, SERVICE, Transition, covered, excluded, xfail_bug
from e2e_support.catalog.check import (
    E2E_DIR,
    CatalogReport,
    TestInfo,
    check_catalog,
    collect_tests,
)

# ---------------------------------------------------------------------------
# The real catalog and the real tests
# ---------------------------------------------------------------------------


def test_every_transition_has_the_right_kind_of_test() -> None:
    errors: list[str] = []
    tests, module_problems = collect_tests(E2E_DIR, errors=errors)

    report = check_catalog(tests, module_problems=module_problems, marker_errors=errors)

    if report.problems:
        pytest.fail(report.format(), pytrace=False)


def test_the_catalog_is_well_formed() -> None:
    ids = [t.id for t in catalog.ALL_TRANSITIONS]
    assert len(ids) == len(set(ids)), "a transition id is used twice"
    assert set(catalog.BY_ID) == set(ids)
    for machine in catalog.MACHINES:
        assert catalog.transitions_for(machine), f"{machine} has no transitions"
    # Each machine's module name is the machine, and the test file is named after it.
    assert len(set(catalog.MACHINES)) == len(catalog.MACHINES)
    assert {t.machine for t in catalog.ALL_TRANSITIONS} == set(catalog.MACHINES)
    with pytest.raises(KeyError):
        catalog.get("no.such->transition")
    with pytest.raises(KeyError):
        catalog.transitions_for("no_such_machine")


# A known bug is named by its Linear issue, or by a short slug until the issue is filed.
KNOWN_BUG_NAME = re.compile(r"ENG-[0-9]+|bug-[a-z0-9-]+")


def test_known_bugs_have_a_name_and_exclusions_a_reason() -> None:
    for t in catalog.ALL_TRANSITIONS:
        if t.status == "xfail_bug":
            assert t.bug is not None and KNOWN_BUG_NAME.fullmatch(t.bug), t.id
        if t.status == "excluded":
            assert t.reason, t.id


def test_a_service_only_transition_is_in_the_service_machine() -> None:
    # The service suite covers these from test_windows_service.py, and the check asks for each
    # of them (SERVICE_SUITE_READY), so make sure that none of them hides in the catalog of a
    # machine whose tests run under both drivers.
    service_only = [t for t in catalog.ALL_TRANSITIONS if t.platforms == SERVICE]
    assert service_only
    assert {t.machine for t in service_only} == {"windows_service"}
    assert {t.machine for t in catalog.ALL_TRANSITIONS if t.machine == "windows_service"} == {
        "windows_service"
    }
    assert catalog.SERVICE_SUITE_READY is False or (E2E_DIR / catalog.SERVICE_TEST_FILE).exists()


def test_the_platforms_are_kinds_of_driver() -> None:
    assert BOTH == {"cli", "service"} == set(catalog.DRIVER_KINDS)
    assert {p for t in catalog.ALL_TRANSITIONS for p in t.platforms} <= BOTH


def test_the_e2e_directory_is_where_the_checker_looks() -> None:
    assert E2E_DIR == Path(__file__).resolve().parents[1] / "e2e"
    assert (E2E_DIR / "conftest.py").exists()


# ---------------------------------------------------------------------------
# The checker itself, on a small catalog and small test files
# ---------------------------------------------------------------------------

SMALL_CATALOG = (
    covered("m", "thing.a->b", "A thing goes from a to b."),
    covered("m", "thing.b->c", "A thing goes from b to c."),
    xfail_bug("m", "thing.c->d", "A thing goes from c to d.", "bug-99-example"),
    excluded("m", "thing.d->e", "A thing goes from d to e.", "left to unit tests"),
    covered("m", "svc.up->down", "The service goes down.", platforms=SERVICE),
    covered("m", "sig.int->exit", "A signal ends it.", platforms=CLI),
)


def read(tmp_path: Path, files: dict[str, str]) -> tuple[list[TestInfo], list[str], list[str]]:
    if files:
        for old in tmp_path.glob("test_*.py"):
            old.unlink()
    for name, source in files.items():
        (tmp_path / name).write_text(textwrap.dedent(source))
    errors: list[str] = []
    tests, module_problems = collect_tests(tmp_path, errors=errors)
    return tests, module_problems, errors


def run_check(
    tmp_path: Path, files: dict[str, str], *, service_suite_ready: bool = False
) -> CatalogReport:
    tests, module_problems, errors = read(tmp_path, files)
    return check_catalog(
        tests,
        SMALL_CATALOG,
        service_suite_ready=service_suite_ready,
        module_problems=module_problems,
        marker_errors=errors,
    )


def missing_ids(report: CatalogReport) -> set[str]:
    return {t.id for ts in report.missing.values() for t in ts}


# The way a known-bug test is written: strict, raises the exception `known_bug()` makes, a
# reason that starts with the bug's name, and only the intended-behavior assertion in the block.
BUG_MARKS = """
    @pytest.mark.covers("thing.c->d")
    @pytest.mark.xfail(
        strict=True, raises=KnownBugStillPresent, reason="bug-99-example: it is stuck"
    )
"""

COMPLETE = (
    """
    import pytest

    from e2e_support.waiting import KnownBugStillPresent, known_bug

    pytestmark = pytest.mark.e2e


    @pytest.mark.platforms("cli")
    @pytest.mark.covers("thing.a->b", "thing.b->c", "sig.int->exit")
    def test_ok_under_the_cli():
        pass


    @pytest.mark.covers("thing.a->b", "thing.b->c")
    def test_ok_under_both():
        pass
"""
    + BUG_MARKS
    + """    def test_bug():
        with known_bug():
            pass
"""
)


def test_a_matching_suite_passes(tmp_path: Path) -> None:
    report = run_check(tmp_path, {"test_one.py": COMPLETE})

    assert report.problems == 0, report.format()
    assert report.format() == "The end-to-end catalog and tests agree."


def test_a_transition_without_a_test_is_listed_by_machine(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": """
                import pytest

                pytestmark = pytest.mark.e2e


                @pytest.mark.covers("thing.a->b")
                def test_ok():
                    pass
            """
        },
    )

    assert missing_ids(report) == {"thing.b->c", "thing.c->d", "sig.int->exit"}
    text = report.format()
    assert "Transitions with no test (3):" in text
    assert "[m] 3 missing" in text
    assert "thing.c->d  needs a xfail(strict=True) test" in text
    assert "thing.b->c  needs a test" in text


def test_a_test_that_names_an_unknown_id_fails(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": COMPLETE
            + """

    @pytest.mark.covers("thing.a->typo")
    def test_typo():
        pass
"""
        },
    )

    assert report.unknown == ["test_one.py::test_typo names 'thing.a->typo'"]
    assert report.problems == 1


def test_a_known_bug_needs_a_strict_xfail_test(tmp_path: Path) -> None:
    passing = """
        import pytest

        pytestmark = pytest.mark.e2e


        @pytest.mark.covers("thing.a->b", "thing.b->c", "thing.c->d", "sig.int->exit")
        def test_all():
            pass
    """
    lenient = passing.replace(
        "def test_all", '@pytest.mark.xfail(reason="not strict")\n        def test_all'
    )

    plain = run_check(tmp_path, {"test_one.py": passing})
    assert plain.wrong_kind == [
        "thing.c->d is `xfail_bug` (bug-99-example) but no test that covers it is marked "
        "xfail(strict=True) (test_one.py::test_all)"
    ]

    (tmp_path / "test_one.py").write_text(textwrap.dedent(lenient))
    tests, module_problems = collect_tests(tmp_path)
    not_strict = check_catalog(tests, SMALL_CATALOG, module_problems=module_problems)
    assert any(line.startswith("thing.c->d is `xfail_bug`") for line in not_strict.wrong_kind)


def test_a_covered_transition_cannot_rest_on_an_xfail_test(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": """
                import pytest

                pytestmark = pytest.mark.e2e


                @pytest.mark.covers("thing.a->b", "thing.b->c", "sig.int->exit")
                @pytest.mark.xfail(strict=True)
                def test_all():
                    pass


                @pytest.mark.covers("thing.c->d")
                @pytest.mark.xfail(strict=True)
                def test_bug():
                    pass
            """
        },
    )

    assert len(report.wrong_kind) == 3
    assert all("is `covered` but only xfail tests cover it" in line for line in report.wrong_kind)


def test_a_test_for_an_excluded_transition_fails(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": COMPLETE
            + """

    @pytest.mark.covers("thing.d->e")
    def test_excluded():
        pass
"""
        },
    )

    assert report.excluded_with_tests == [
        "test_one.py::test_excluded covers 'thing.d->e': left to unit tests"
    ]


def test_class_level_markers_apply_to_every_method(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": """
                import pytest

                pytestmark = pytest.mark.e2e


                @pytest.mark.platforms("cli")
                @pytest.mark.covers("thing.a->b", "thing.b->c", "sig.int->exit")
                class TestGroup:
                    def test_one(self):
                        pass

                    @pytest.mark.covers("thing.a->b")
                    def test_two(self):
                        pass

                    def helper(self):
                        pass


                @pytest.mark.covers("thing.a->b", "thing.b->c")
                def test_both():
                    pass


                @pytest.mark.covers("thing.c->d")
                @pytest.mark.xfail(
                    strict=True, raises=KnownBugStillPresent, reason="bug-99-example: stuck"
                )
                def test_bug():
                    with known_bug():
                        pass
            """
        },
    )
    tests, _, _ = read(tmp_path, {})

    assert report.problems == 0, report.format()
    assert [t.name for t in tests] == [
        "TestGroup::test_one",
        "TestGroup::test_two",
        "test_both",
        "test_bug",
    ]
    assert tests[1].covers == ("thing.a->b", "thing.b->c", "sig.int->exit", "thing.a->b")
    assert tests[1].platforms == CLI


def test_module_level_markers_apply_to_every_test(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": """
                import pytest

                pytestmark = [pytest.mark.e2e, pytest.mark.covers("thing.a->b")]


                @pytest.mark.covers("thing.b->c", "sig.int->exit")
                @pytest.mark.platforms("cli")
                def test_one():
                    pass

                @pytest.mark.covers("thing.b->c")
                def test_two():
                    pass
            """
        },
    )
    tests, _, _ = read(tmp_path, {})

    assert [t.covers for t in tests] == [
        ("thing.a->b", "thing.b->c", "sig.int->exit"),
        ("thing.a->b", "thing.b->c"),
    ]
    assert report.unknown == report.platform_mismatch == report.module_problems == []
    assert report.marker_errors == report.known_bug_problems == []


def test_a_module_without_the_e2e_marker_fails(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": COMPLETE.replace("pytestmark = pytest.mark.e2e", "pytestmark = []"),
        },
    )

    assert report.module_problems == ["test_one.py (set `pytestmark = pytest.mark.e2e`)"]


def test_covers_takes_string_literals(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": COMPLETE
            + """

    IDS = "thing.a->b"

    @pytest.mark.covers(IDS)
    def test_variable():
        pass
"""
        },
    )

    assert report.marker_errors == [
        "test_one.py::test_variable: `covers` takes string literals only"
    ]


# ---------------------------------------------------------------------------
# Kinds of driver: the platforms marker
# ---------------------------------------------------------------------------


def test_service_only_transitions_are_skipped_until_the_service_suite_is_ready(
    tmp_path: Path,
) -> None:
    files = {"test_one.py": COMPLETE}

    assert run_check(tmp_path, files, service_suite_ready=False).problems == 0
    ready = run_check(tmp_path, files, service_suite_ready=True)
    assert missing_ids(ready) == {"svc.up->down"}


def test_service_tests_count_for_the_service_only_and_other_tests_for_both(tmp_path: Path) -> None:
    service_file = """
        import pytest

        pytestmark = pytest.mark.e2e


        @pytest.mark.covers("svc.up->down")
        def test_service():
            pass
    """

    report = run_check(
        tmp_path,
        {"test_one.py": COMPLETE, catalog.SERVICE_TEST_FILE: service_file},
        service_suite_ready=True,
    )
    tests, _, _ = read(tmp_path, {})

    assert report.problems == 0, report.format()
    assert {t.name: t.platforms for t in tests}["test_service"] == SERVICE
    assert {t.name: t.platforms for t in tests}["test_ok_under_both"] == BOTH


def test_a_shared_test_cannot_cover_a_service_only_transition(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": COMPLETE
            + """

    @pytest.mark.covers("svc.up->down")
    def test_wrong_file():
        pass
"""
        },
    )

    assert len(report.platform_mismatch) == 1
    assert "exists only under the service" in report.platform_mismatch[0]


def test_a_service_test_cannot_cover_a_cli_only_transition(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": COMPLETE,
            catalog.SERVICE_TEST_FILE: """
                import pytest

                pytestmark = pytest.mark.e2e


                @pytest.mark.covers("sig.int->exit")
                def test_signal_on_the_service():
                    pass
            """,
        },
    )

    assert len(report.platform_mismatch) == 1
    assert "runs under service but covers 'sig.int->exit'" in report.platform_mismatch[0]


def test_a_shared_test_that_covers_a_cli_only_transition_must_say_so(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": COMPLETE.replace(
                '    @pytest.mark.platforms("cli")\n    @pytest.mark.covers("thing.a->b", '
                '"thing.b->c", "sig.int->exit")',
                '    @pytest.mark.covers("thing.a->b", "thing.b->c", "sig.int->exit")',
            )
        },
    )

    assert len(report.platform_mismatch) == 1
    assert report.platform_mismatch[0].startswith("test_one.py::test_ok_under_the_cli runs under")
    assert 'mark the test `@pytest.mark.platforms("cli")`' in report.platform_mismatch[0]


def test_a_transition_for_both_kinds_needs_a_test_that_runs_under_both(tmp_path: Path) -> None:
    both = (covered("m", "thing.a->b", "A thing goes from a to b.", platforms=BOTH),)
    cli_only = """
        import pytest

        pytestmark = pytest.mark.e2e


        @pytest.mark.platforms("cli")
        @pytest.mark.covers("thing.a->b")
        def test_only_under_the_cli():
            pass
    """

    def check(files: dict[str, str]) -> CatalogReport:
        tests, module_problems, errors = read(tmp_path, files)
        return check_catalog(tests, both, module_problems=module_problems, marker_errors=errors)

    assert missing_ids(check({"test_one.py": cli_only})) == {"thing.a->b"}
    assert missing_ids(check({catalog.SERVICE_TEST_FILE: cli_only})) == {"thing.a->b"}
    # A second test for the other kind is what it takes.
    both_kinds = cli_only + cli_only.replace("only_under_the_cli", "for_both").replace(
        '@pytest.mark.platforms("cli")', '@pytest.mark.platforms("cli", "service")'
    )
    assert check({"test_one.py": both_kinds}).problems == 0


def test_the_closest_platforms_marker_wins(tmp_path: Path) -> None:
    tests, _, errors = read(
        tmp_path,
        {
            "test_one.py": """
                import pytest

                pytestmark = [pytest.mark.e2e, pytest.mark.platforms("cli")]


                def test_module_level():
                    pass


                @pytest.mark.platforms("service")
                def test_function_level():
                    pass


                @pytest.mark.platforms("cli", "service")
                class TestGroup:
                    def test_class_level(self):
                        pass

                    @pytest.mark.platforms("service")
                    def test_function_over_class(self):
                        pass
            """
        },
    )

    assert errors == []
    assert {t.name: t.platforms for t in tests} == {
        "test_module_level": CLI,
        "test_function_level": SERVICE,
        "TestGroup::test_class_level": BOTH,
        "TestGroup::test_function_over_class": SERVICE,
    }


def test_a_platforms_marker_needs_known_kinds(tmp_path: Path) -> None:
    *_, errors = read(
        tmp_path,
        {
            "test_one.py": """
                import pytest

                pytestmark = pytest.mark.e2e


                @pytest.mark.platforms("linux")
                def test_old_name():
                    pass


                @pytest.mark.platforms()
                def test_nothing():
                    pass
            """
        },
    )

    assert len(errors) == 2
    assert "not ['linux']" in errors[0]
    assert "one or more of ['cli', 'service']" in errors[1]


def test_a_test_marked_for_a_kind_its_file_never_runs_under_is_reported(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": COMPLETE,
            catalog.SERVICE_TEST_FILE: """
                import pytest

                pytestmark = pytest.mark.e2e


                @pytest.mark.platforms("cli")
                @pytest.mark.covers("thing.a->b")
                def test_nowhere():
                    pass
            """,
        },
    )

    assert len(report.platform_mismatch) == 1
    assert "runs nowhere" in report.platform_mismatch[0]


# ---------------------------------------------------------------------------
# Known-bug tests follow the pattern
# ---------------------------------------------------------------------------

PREFIX = """
    import pytest

    pytestmark = pytest.mark.e2e


    @pytest.mark.covers("thing.a->b", "thing.b->c", "sig.int->exit")
    @pytest.mark.platforms("cli")
    def test_ok():
        pass


    @pytest.mark.covers("thing.a->b", "thing.b->c")
    def test_ok_for_both():
        pass

"""


def bug_problems(tmp_path: Path, bug_test: str) -> list[str]:
    report = run_check(tmp_path, {"test_one.py": PREFIX + textwrap.indent(bug_test, "    ")})
    return report.known_bug_problems


GOOD_BUG_TEST = """
@pytest.mark.covers("thing.c->d")
@pytest.mark.xfail(strict=True, raises=KnownBugStillPresent, reason="bug-99-example: stuck")
def test_bug():
    with known_bug():
        assert False
"""


def test_a_known_bug_test_written_the_right_way_passes(tmp_path: Path) -> None:
    assert bug_problems(tmp_path, GOOD_BUG_TEST) == []


def test_a_known_bug_xfail_must_be_strict(tmp_path: Path) -> None:
    problems = bug_problems(tmp_path, GOOD_BUG_TEST.replace("strict=True", "strict=False"))
    problems += bug_problems(tmp_path, GOOD_BUG_TEST.replace("strict=True, ", ""))

    assert len(problems) == 2
    assert all("must be strict=True" in p for p in problems)


def test_a_known_bug_xfail_must_raise_the_known_bug_exception(tmp_path: Path) -> None:
    without = bug_problems(tmp_path, GOOD_BUG_TEST.replace("raises=KnownBugStillPresent, ", ""))
    other = bug_problems(
        tmp_path, GOOD_BUG_TEST.replace("raises=KnownBugStillPresent", "raises=AssertionError")
    )

    assert len(without) == len(other) == 1
    assert "needs `raises=KnownBugStillPresent`" in without[0]
    assert "needs `raises=KnownBugStillPresent`" in other[0]
    # The class can come from its module too.
    qualified = bug_problems(
        tmp_path,
        GOOD_BUG_TEST.replace("raises=KnownBugStillPresent", "raises=waiting.KnownBugStillPresent"),
    )
    assert qualified == []


def test_a_known_bug_test_needs_the_known_bug_block(tmp_path: Path) -> None:
    problems = bug_problems(
        tmp_path,
        GOOD_BUG_TEST.replace("    with known_bug():\n        assert False", "    assert False"),
    )

    assert len(problems) == 1
    assert "no `with known_bug():` block" in problems[0]


def test_a_known_bug_test_names_only_known_bug_transitions(tmp_path: Path) -> None:
    problems = bug_problems(
        tmp_path, GOOD_BUG_TEST.replace('"thing.c->d"', '"thing.c->d", "thing.a->b"')
    )

    assert len(problems) == 1
    assert "names only xfail_bug transitions, not thing.a->b" in problems[0]


def test_the_xfail_reason_starts_with_the_bug_of_a_transition_the_test_names(
    tmp_path: Path,
) -> None:
    wrong_bug = bug_problems(
        tmp_path, GOOD_BUG_TEST.replace('"bug-99-example: stuck"', '"bug-98-other: stuck"')
    )
    no_colon = bug_problems(
        tmp_path, GOOD_BUG_TEST.replace('"bug-99-example: stuck"', '"bug-99-example-ish: stuck"')
    )
    no_bug = bug_problems(tmp_path, GOOD_BUG_TEST.replace("bug-99-example: ", ""))

    assert len(wrong_bug) == len(no_colon) == len(no_bug) == 1
    assert "must start with 'bug-99-example: ...'" in wrong_bug[0]
    assert "bug-98-other" in wrong_bug[0]


def test_a_test_that_is_not_an_xfail_cannot_name_a_known_bug_transition(tmp_path: Path) -> None:
    problems = bug_problems(
        tmp_path,
        """
@pytest.mark.covers("thing.c->d")
def test_bug():
    with known_bug():
        assert False
""",
    )

    assert len(problems) == 1
    assert "names the known-bug transition(s) thing.c->d but isn't marked xfail" in problems[0]


def test_the_closest_xfail_is_the_one_that_counts(tmp_path: Path) -> None:
    # pytest applies the closest xfail mark: a lenient one on the function replaces the strict
    # one on its class, so the test is not strict however the class is marked.
    report = run_check(
        tmp_path,
        {
            "test_one.py": PREFIX
            + """
    @pytest.mark.xfail(strict=True, raises=KnownBugStillPresent, reason="bug-99-example: x")
    class TestBug:
        @pytest.mark.covers("thing.c->d")
        @pytest.mark.xfail(reason="bug-99-example: x")
        def test_function_overrides(self):
            with known_bug():
                assert False

        @pytest.mark.covers("thing.c->d")
        def test_class_applies(self):
            with known_bug():
                assert False
"""
        },
    )

    assert report.known_bug_problems
    assert all("TestBug::test_function_overrides" in p for p in report.known_bug_problems)
    assert not any("test_class_applies" in p for p in report.known_bug_problems)
    # ... and of the decorators stacked on one function, the one next to the `def` counts.
    stacked = run_check(
        tmp_path,
        {
            "test_one.py": PREFIX
            + """
    @pytest.mark.covers("thing.c->d")
    @pytest.mark.xfail(strict=True, raises=KnownBugStillPresent, reason="bug-99-example: x")
    @pytest.mark.xfail(reason="bug-99-example: x")
    def test_inner_wins():
        with known_bug():
            assert False
"""
        },
    )
    assert any("must be strict=True" in p for p in stacked.known_bug_problems)


# ---------------------------------------------------------------------------
# Nothing may hide a test from the check
# ---------------------------------------------------------------------------


def hiding_errors(tmp_path: Path, source: str) -> list[str]:
    *_, errors = read(
        tmp_path,
        {"test_one.py": "import pytest\n\npytestmark = pytest.mark.e2e\n\n\n" + source},
    )
    return errors


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("def test_a():\n    pytest.skip('no')\n", "`pytest.skip(...)` skips"),
        ("def test_a():\n    pytest.xfail('no')\n", "`pytest.xfail(...)` skips"),
        ("def test_a():\n    pytest.importorskip('x')\n", "`pytest.importorskip(...)` skips"),
        (
            "def helper():\n    if True:\n        pytest.skip('in a helper')\n",
            "`pytest.skip(...)` skips",
        ),
        ("from pytest import skip\n", "`from pytest import skip` hides skips"),
        ("@pytest.mark.skip(reason='no')\ndef test_a():\n    pass\n", "`skip` hides the test"),
        (
            "@pytest.mark.skipif(True, reason='no')\ndef test_a():\n    pass\n",
            "`skipif` hides the test",
        ),
        (
            "@pytest.mark.parametrize('x', [pytest.param(1, marks=pytest.mark.skip)])\n"
            "def test_a(x):\n    pass\n",
            "`pytest.param(..., marks=...)` puts marks where",
        ),
        (
            "@pytest.mark.xfail(True, reason='x')\ndef test_a():\n    pass\n",
            "`xfail` with a condition hides the test",
        ),
        (
            "@pytest.mark.xfail(condition=False, reason='x')\ndef test_a():\n    pass\n",
            "`xfail(condition=...)` is conditional",
        ),
        (
            "@pytest.mark.xfail(run=False, reason='x')\ndef test_a():\n    pass\n",
            "`xfail(run=...)` would not run the test",
        ),
        (
            "slow = pytest.mark.xfail(strict=True)\n\n\n@slow\ndef test_a():\n    pass\n",
            "keeps a mark in a variable",
        ),
        (
            "@some_decorator\ndef test_a():\n    pass\n",
            "`some_decorator` is not a plain `pytest.mark.<name>(...)`",
        ),
        (
            "@pytest.mark.skip\nclass TestA:\n    def test_a(self):\n        pass\n",
            "`skip` hides the test",
        ),
        (
            "class TestA:\n    pytestmark = pytest.mark.skip\n\n    def test_a(self):\n"
            "        pass\n",
            "a `pytestmark` inside a class isn't read",
        ),
        (
            "pytestmark = [pytest.mark.skip]\n\n\ndef test_a():\n    pass\n",
            "`skip` hides the test",
        ),
        (
            "pytestmark = [pytest.mark.e2e, MARKS]\n\n\ndef test_a():\n    pass\n",
            "`MARKS` is not a plain `pytest.mark",
        ),
    ],
)
def test_a_way_of_hiding_a_test_from_the_check_is_refused(
    tmp_path: Path, source: str, expected: str
) -> None:
    errors = hiding_errors(tmp_path, source)

    assert any(expected in error for error in errors), errors


def test_the_usual_marks_and_helpers_are_fine(tmp_path: Path) -> None:
    errors = hiding_errors(
        tmp_path,
        "@pytest.mark.parametrize('x', [1, pytest.param(2, id='two')])\n"
        "@pytest.mark.usefixtures('something')\n"
        "def test_a(x):\n"
        "    assert x == pytest.approx(1.0)\n"
        "    pytest.fail('a failure is fine')\n",
    )

    assert errors == []


def test_a_mark_error_is_reported_once_however_many_tests_it_covers(tmp_path: Path) -> None:
    errors = hiding_errors(
        tmp_path,
        "pytestmark = [pytest.mark.covers(1)]\n\n\ndef test_a():\n    pass\n\n\n"
        "def test_b():\n    pass\n",
    )

    assert len([e for e in errors if "takes string literals only" in e]) == 1


def test_hidden_coverage_makes_the_check_fail(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": COMPLETE
            + """

    def test_sneaky():
        pytest.skip("on this machine")
"""
        },
    )

    assert report.problems == 1
    assert "Markers and calls the check can't allow" in report.format()
    assert "test_one.py:" in report.marker_errors[0]


def test_the_real_tests_hide_nothing() -> None:
    errors: list[str] = []
    collect_tests(E2E_DIR, errors=errors)

    assert errors == []


def test_the_real_known_bug_tests_follow_the_pattern() -> None:
    tests, _ = collect_tests(E2E_DIR)

    bug_tests = [t for t in tests if t.xfail]
    assert bug_tests
    for test in bug_tests:
        assert test.strict_xfail, test.label
        assert test.xfail_raises_known_bug, test.label
        assert test.wraps_known_bug, test.label
        assert test.xfail_reason is not None, test.label
        assert KNOWN_BUG_NAME.fullmatch(test.xfail_reason.split(":")[0]), test.label
    # And no other test names a known bug.
    for test in tests:
        if not test.xfail:
            named = [catalog.BY_ID[i] for i in test.covers if i in catalog.BY_ID]
            assert all(t.status != "xfail_bug" for t in named), test.label


def test_the_real_catalog_has_a_transition_for_every_kind_of_status() -> None:
    kinds: set[str] = {t.status for t in catalog.ALL_TRANSITIONS}
    assert kinds == {"covered", "xfail_bug", "excluded"}
    assert isinstance(catalog.ALL_TRANSITIONS[0], Transition)
