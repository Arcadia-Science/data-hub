"""The end-to-end suite's transition catalog and its tests must agree.

``watcher/e2e`` holds the end-to-end tests, which need a server and are not part of this run.
This test reads them with ``ast`` (nothing is imported or run) and compares the
``@pytest.mark.covers(...)`` markers with the catalog in ``watcher/e2e/e2e_support/catalog``.
It is fast and runs in the normal unit-test run, so a pull request that adds a transition
without a test, deletes a test, or names an ID that doesn't exist fails here.

``test_every_transition_has_the_right_kind_of_test`` fails and lists what is missing until
every scenario is written. Run the same check by hand, with the missing count per machine::

    cd watcher/e2e && uv run python -m e2e_support.catalog.check --summary
"""

from __future__ import annotations
import textwrap
from pathlib import Path

import pytest

from e2e_support import catalog
from e2e_support.catalog import BOTH, LINUX, WINDOWS, Transition, covered, excluded, xfail_bug
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


def test_known_bugs_have_a_slug_and_exclusions_a_reason() -> None:
    for t in catalog.ALL_TRANSITIONS:
        if t.status == "xfail_bug":
            assert t.bug is not None and t.bug.startswith("bug-"), t.id
        if t.status == "excluded":
            assert t.reason, t.id


def test_a_windows_only_transition_is_in_a_catalog_module_for_it() -> None:
    # The Windows suite (PR 3) covers these from test_windows_service.py. Until then the check
    # skips them behind WINDOWS_SUITE_READY, so make sure that switch is the only thing standing
    # between a Windows-only transition and a missing-test failure.
    windows_only = [t for t in catalog.ALL_TRANSITIONS if t.platforms == WINDOWS]
    assert windows_only
    assert catalog.WINDOWS_SUITE_READY is False or (E2E_DIR / catalog.WINDOWS_TEST_FILE).exists()


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
    covered("m", "svc.up->down", "The service goes down.", platforms=WINDOWS),
    covered("m", "sig.int->exit", "A signal ends it.", platforms=LINUX),
)


def read(tmp_path: Path, files: dict[str, str]) -> tuple[list[TestInfo], list[str], list[str]]:
    for name, source in files.items():
        (tmp_path / name).write_text(textwrap.dedent(source))
    errors: list[str] = []
    tests, module_problems = collect_tests(tmp_path, errors=errors)
    return tests, module_problems, errors


def run_check(
    tmp_path: Path, files: dict[str, str], *, windows_suite_ready: bool = False
) -> CatalogReport:
    tests, module_problems, errors = read(tmp_path, files)
    return check_catalog(
        tests,
        SMALL_CATALOG,
        windows_suite_ready=windows_suite_ready,
        module_problems=module_problems,
        marker_errors=errors,
    )


def missing_ids(report: CatalogReport) -> set[str]:
    return {t.id for ts in report.missing.values() for t in ts}


COMPLETE = """
    import pytest

    pytestmark = pytest.mark.e2e


    @pytest.mark.covers("thing.a->b", "thing.b->c", "sig.int->exit")
    def test_ok():
        pass


    @pytest.mark.covers("thing.c->d")
    @pytest.mark.xfail(strict=True, reason="bug-99-example")
    def test_bug():
        pass
"""


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


                @pytest.mark.covers("thing.a->b", "thing.b->c", "sig.int->exit")
                class TestGroup:
                    def test_one(self):
                        pass

                    @pytest.mark.covers("thing.c->d")
                    @pytest.mark.xfail(strict=True)
                    def test_two(self):
                        pass

                    def helper(self):
                        pass
            """
        },
    )
    tests, _, _ = read(tmp_path, {})

    assert report.problems == 0, report.format()
    assert [t.name for t in tests] == ["TestGroup::test_one", "TestGroup::test_two"]
    assert tests[1].covers == ("thing.a->b", "thing.b->c", "sig.int->exit", "thing.c->d")


def test_module_level_markers_apply_to_every_test(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": """
                import pytest

                pytestmark = [pytest.mark.e2e, pytest.mark.covers("thing.a->b")]


                @pytest.mark.covers("thing.b->c", "sig.int->exit")
                def test_one():
                    pass

                @pytest.mark.covers("thing.c->d")
                @pytest.mark.xfail(strict=True)
                def test_two():
                    pass
            """
        },
    )

    assert report.problems == 0, report.format()


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

    assert report.unknown == ["test_one.py::test_variable: `covers` takes string literals only"]


def test_windows_only_transitions_are_skipped_until_the_windows_suite_is_ready(
    tmp_path: Path,
) -> None:
    files = {"test_one.py": COMPLETE}

    assert run_check(tmp_path, files, windows_suite_ready=False).problems == 0
    ready = run_check(tmp_path, files, windows_suite_ready=True)
    assert missing_ids(ready) == {"svc.up->down"}


def test_windows_tests_count_for_windows_only_and_other_tests_for_both(tmp_path: Path) -> None:
    windows_file = """
        import pytest

        pytestmark = pytest.mark.e2e


        @pytest.mark.covers("svc.up->down")
        def test_service():
            pass
    """

    report = run_check(
        tmp_path,
        {"test_one.py": COMPLETE, catalog.WINDOWS_TEST_FILE: windows_file},
        windows_suite_ready=True,
    )

    assert report.problems == 0, report.format()


def test_a_shared_test_cannot_cover_a_windows_only_transition(tmp_path: Path) -> None:
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
    assert "exists only on Windows" in report.platform_mismatch[0]


def test_a_windows_test_cannot_cover_a_linux_only_transition(tmp_path: Path) -> None:
    report = run_check(
        tmp_path,
        {
            "test_one.py": COMPLETE,
            catalog.WINDOWS_TEST_FILE: """
                import pytest

                pytestmark = pytest.mark.e2e


                @pytest.mark.covers("sig.int->exit")
                def test_signal_on_windows():
                    pass
            """,
        },
    )

    assert len(report.platform_mismatch) == 1
    assert "doesn't exist on Windows" in report.platform_mismatch[0]


def test_a_transition_for_both_platforms_needs_a_test_that_runs_on_both(tmp_path: Path) -> None:
    both = (covered("m", "thing.a->b", "A thing goes from a to b.", platforms=BOTH),)
    tests, module_problems, errors = read(
        tmp_path,
        {
            catalog.WINDOWS_TEST_FILE: """
                import pytest

                pytestmark = pytest.mark.e2e


                @pytest.mark.covers("thing.a->b")
                def test_only_on_windows():
                    pass
            """
        },
    )

    report = check_catalog(tests, both, module_problems=module_problems, marker_errors=errors)

    assert missing_ids(report) == {"thing.a->b"}


def test_the_real_catalog_has_a_transition_for_every_kind_of_status() -> None:
    kinds: set[str] = {t.status for t in catalog.ALL_TRANSITIONS}
    assert kinds == {"covered", "xfail_bug", "excluded"}
    assert isinstance(catalog.ALL_TRANSITIONS[0], Transition)
