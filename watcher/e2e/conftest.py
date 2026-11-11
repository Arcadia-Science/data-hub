"""Fixtures for the watcher end-to-end suite.

What a scenario gets
--------------------

Session (built once, shared):

* ``integration_env``: the real Next.js test server on Postgres (``start_test_server``).
* ``admin_session``, ``admin``: a seeded admin and the ``Admin`` actions. Every test starts
  with the release's latest version set to the current watcher version, so nothing is offered
  an update unless it asks for one.
* ``current_wheel``, ``bumped_wheel``, ``current_version``, ``bumped_version``: the watcher
  wheel built from this checkout (or ``$DATA_HUB_E2E_WHEEL``, which the release workflow sets
  to the wheel it is about to publish), and a "next" wheel with a higher version, built when
  a test asks for it.
* ``driver_class``: the kind of driver the run uses (``$DATA_HUB_E2E_DRIVER``: ``cli``, the
  default, or ``service``, which PR 3 adds).
* ``tool_install``: ``uv tool install --python 3.12`` of the current wheel, in a folder whose
  path contains ``/uv/tools/data-hub-watcher``, so the watcher recognises it as a uv-tool
  install. Tests share it, so no test may update it: one that updates the watcher asks the
  ``watcher`` fixture for ``own_install=True``.
* ``package_index``: a local package index serving the wheels in ``wheel_dir``: the current
  one, and the bumped one once a test has asked for ``bumped_wheel``. For self-update.

Per test:

* ``instrument_id``: a fresh instrument (a unique ID), the only one in the database.
* ``proxy``: a fresh ``FaultProxy`` in front of the server. The watcher talks to it.
* ``server``: a ``ServerView``.
* ``watch_dir``: an empty watch folder.
* ``watcher``: a factory for configured ``WatcherDriver`` objects. See ``WatcherFactory``.
* ``private_install``: what ``watcher(own_install=True)`` uses for a ``uv tool`` install of
  the test's own. A scenario doesn't ask for it: that would tie it to one kind of driver.
* ``unreadable_folder``: a folder this user can't list, for the one scenario about it.

A test that is only for one kind of driver is marked ``@pytest.mark.platforms("cli")`` (or
``"service"``). The ``pytest_runtest_setup`` hook below skips it under the other kind, and the
catalog check reads the marker, so the skip is never hidden from it.

The watcher tables are emptied before each test. When a test fails, its logs, state database
and server logs are copied to ``$DATA_HUB_E2E_ARTIFACTS/<test id>/``.
"""

from __future__ import annotations
import os
import re
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from _pytest.nodes import Item
from _pytest.reports import TestReport

from data_hub_shared.testing import (
    AdminSession,
    IntegrationEnv,
    seed_admin_session,
    seed_auth,
    seed_instruments,
    start_test_server,
    truncate_tables,
)
from data_hub_shared.testing_index import LocalPackageIndex
from data_hub_shared.testing_proxy import FaultProxy
from data_hub_shared.testing_wheels import (
    build_watcher_wheel,
    watcher_project_version,
)
from data_hub_shared.testing_wheels import (
    bumped_version as bump_version,
)
from e2e_support.admin import ADMIN_REVISION_SCOPES, WATCHER_SCOPES, Admin
from e2e_support.artifacts import artifacts_root, collect_failure_artifacts, safe_name
from e2e_support.drivers import (
    ToolInstall,
    WatcherDriver,
    active_driver_kind,
    driver_class_for,
    install_watcher_tool,
)
from e2e_support.factory import E2EContext, WatcherFactory
from e2e_support.platforms import platforms_skip_reason
from e2e_support.server import ServerView

WHEEL_VARIABLE = "DATA_HUB_E2E_WHEEL"

# Everything the watcher writes and the tests read. TRUNCATE ... CASCADE also clears the
# tables that point at these. Instruments are emptied too, so `init` always lists exactly the
# instrument a test seeds. Users, sessions and tokens stay.
_RESET_TABLES = [
    "files",
    "instrument_runs",
    "watcher_events",
    "watcher_heartbeats",
    "watcher_config_revisions",
    "watchers",
    "instruments",
]


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------


def pytest_report_header(config: pytest.Config) -> list[str]:
    return [
        f"e2e driver: {active_driver_kind()}",
        f"e2e failure artifacts: {artifacts_root()}",
    ]


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item: Item) -> None:
    """Skip a test whose ``platforms`` marker leaves out the kind of driver this run uses.

    It runs before the fixtures, so a skipped test starts nothing. The closest marker wins
    (function, then class, then module), which is what the catalog check assumes too. This is
    the only skip the suite uses: the check refuses ``pytest.skip`` in the tests.
    """
    marker = item.get_closest_marker("platforms")
    reason = platforms_skip_reason(
        None if marker is None else marker.args, item.path.name, active_driver_kind()
    )
    if reason is not None:
        pytest.skip(reason)


class _Running:
    """The test that is running, for ``pytest_keyboard_interrupt``, which is not given one."""

    item: Item | None = None


@pytest.hookimpl(wrapper=True)
def pytest_runtest_protocol(item: Item, nextitem: Item | None) -> Iterator[None]:
    _Running.item = item
    result = yield
    # Only a test that finished leaves the slot. An interrupt that ends the run passes through
    # here as an exception, and `pytest_keyboard_interrupt` then still knows what was running.
    _Running.item = None
    return result  # type: ignore[return-value]


def pytest_keyboard_interrupt(excinfo: pytest.ExceptionInfo[BaseException]) -> None:
    """Keep the files of the test that was running when the run was interrupted.

    CI cancels a run (a person, or a timeout above the step) by interrupting pytest. Nothing
    has failed, so the usual collection at the end of a failed test doesn't happen, and the
    interrupted test is the one whose files explain a hang. This runs before the fixtures are
    torn down, so the watchers are still running and their logs are as they were.
    """
    item = _Running.item
    if item is None:
        return
    funcargs = getattr(item, "funcargs", {})
    context = funcargs.get("e2e_context")
    env = funcargs.get("integration_env")
    if not isinstance(context, E2EContext) or not isinstance(env, IntegrationEnv):
        return
    destination = artifacts_root() / safe_name(item.nodeid)
    context.snapshot_server_views()
    collect_failure_artifacts(
        destination,
        env=env,
        server_log_offset=context.server_log_offset,
        drivers=context.drivers,
        proxy=context.proxy,
        server=context.server,
        server_views=context.server_views,
    )
    print(f"\ne2e artifacts of the interrupted test {item.nodeid}: {destination}")


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item: Item, call: pytest.CallInfo[None]) -> Iterator[None]:
    """Remember each phase's outcome on the test, so a fixture can see whether it failed."""
    report: TestReport = yield  # type: ignore[assignment]
    setattr(item, f"report_{report.when}", report)
    if report.failed and report.when in ("setup", "call"):
        context = getattr(item, "funcargs", {}).get("e2e_context")
        if isinstance(context, E2EContext):
            context.snapshot_server_views()
    return report  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Session fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def integration_env() -> Iterator[IntegrationEnv]:
    """Start the real Next.js server on Postgres (see ``start_test_server``).

    ``DATA_HUB_TEST_PGDATABASE`` picks the database, so this suite can run next to another
    that truncates tables.
    """
    with start_test_server() as env:
        yield env


@pytest.fixture(scope="session")
def admin_session(integration_env: IntegrationEnv) -> AdminSession:
    return seed_admin_session(integration_env.db_dsn, auth_secret=integration_env.auth_secret)


@pytest.fixture(scope="session")
def admin(integration_env: IntegrationEnv, admin_session: AdminSession) -> Admin:
    """The admin side of the system: queue uploads, delete runs, change config, revoke tokens."""
    # Config revisions need a token that lists `watchers:admin` itself.
    revision_token = seed_auth(integration_env.db_dsn, scopes=ADMIN_REVISION_SCOPES)
    return Admin(integration_env, session=admin_session, revision_token=revision_token)


def _prebuilt_wheel() -> Path | None:
    """The wheel ``$DATA_HUB_E2E_WHEEL`` names: a file, or a folder holding exactly one."""
    configured = os.environ.get(WHEEL_VARIABLE)
    if not configured:
        return None
    path = Path(configured)
    if path.is_dir():
        wheels = sorted(path.glob("data_hub_watcher-*.whl"))
        if len(wheels) != 1:
            raise RuntimeError(f"{WHEEL_VARIABLE}={path} holds {len(wheels)} wheels, expected one")
        return wheels[0]
    if not path.is_file() or path.suffix != ".whl":
        raise RuntimeError(f"{WHEEL_VARIABLE}={path} is not a wheel file or a folder holding one")
    return path


@pytest.fixture(scope="session")
def wheel_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Where the suite's wheels are kept, and what the package index serves."""
    return tmp_path_factory.mktemp("wheels")


@pytest.fixture(scope="session")
def current_wheel(wheel_dir: Path) -> Path:
    """The watcher wheel under test: ``$DATA_HUB_E2E_WHEEL``, or one built from this checkout."""
    prebuilt = _prebuilt_wheel()
    if prebuilt is not None:
        target = wheel_dir / prebuilt.name
        target.write_bytes(prebuilt.read_bytes())
        return target
    return build_watcher_wheel(wheel_dir)


@pytest.fixture(scope="session")
def current_version(current_wheel: Path) -> str:
    """The version of ``current_wheel``, read from its file name."""
    match = re.match(r"data_hub_watcher-([^-]+)-", current_wheel.name)
    if match is None:
        raise RuntimeError(f"Can't read a version from {current_wheel.name}")
    version = match.group(1)
    if _prebuilt_wheel() is None:
        assert version == watcher_project_version()
    return version


@pytest.fixture(scope="session")
def bumped_version(current_version: str) -> str:
    """A version above every real release of this minor version (the patch number plus 1000)."""
    return bump_version(current_version)


@pytest.fixture(scope="session")
def bumped_wheel(wheel_dir: Path, bumped_version: str) -> Path:
    """The same code as ``current_wheel`` under ``bumped_version``, built when first needed."""
    return build_watcher_wheel(wheel_dir, version=bumped_version)


@pytest.fixture(scope="session")
def driver_class() -> type[WatcherDriver]:
    """The driver class of this run, from ``$DATA_HUB_E2E_DRIVER`` (``cli`` unless set).

    ``service`` raises ``NotImplementedError`` until the Windows service driver (PR 3) exists.
    """
    return driver_class_for(active_driver_kind())


@pytest.fixture(scope="session")
def tool_install(tmp_path_factory: pytest.TempPathFactory, current_wheel: Path) -> ToolInstall:
    """The shared ``uv tool install`` of the current wheel on Python 3.12.

    The watcher installs updates into the folder it runs from, so a test that updates must
    not use this one: it asks the ``watcher`` fixture for ``own_install=True``.
    """
    return install_watcher_tool(tmp_path_factory.mktemp("shared-install"), current_wheel)


@pytest.fixture(scope="session")
def _package_index(wheel_dir: Path, current_wheel: Path) -> Iterator[LocalPackageIndex]:
    with LocalPackageIndex(wheel_dir) as index:
        yield index


@pytest.fixture
def package_index(_package_index: LocalPackageIndex) -> Iterator[LocalPackageIndex]:
    """A local package index serving the wheels of ``wheel_dir``: the current one, and the
    bumped one once a test has asked for ``bumped_wheel`` (the session builds it then, so it is
    in the index from that point on, for the tests after it too). Pass ``package_index.url``
    to the watcher with ``watcher(index_url=...)``. Each test starts with an empty request log
    and no failure switches, and the switches are cleared again after it."""
    _package_index.clear_requested_paths()
    _package_index.clear_unavailable()
    yield _package_index
    _package_index.clear_unavailable()


# ---------------------------------------------------------------------------
# Per-test context and failure artifacts
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def e2e_context(
    request: pytest.FixtureRequest,
    integration_env: IntegrationEnv,
    admin: Admin,
    current_version: str,
) -> Iterator[E2EContext]:
    """Reset the server before each test and keep the artifacts of a failed one.

    This fixture is set up first and torn down last, so by the time it collects artifacts
    the watchers are stopped and their files are complete.
    """
    truncate_tables(integration_env.db_dsn, _RESET_TABLES)
    # So no test is offered an update it didn't ask for.
    admin.set_release(current_version).raise_for_status()
    context = E2EContext(server_log_offset=integration_env.server_log.stat().st_size)
    yield context

    node = request.node
    failed = any(
        getattr(node, name, None) is not None and getattr(node, name).failed
        for name in ("report_setup", "report_call")
    )
    if not failed:
        return
    destination = artifacts_root() / safe_name(node.nodeid)
    collect_failure_artifacts(
        destination,
        env=integration_env,
        server_log_offset=context.server_log_offset,
        drivers=context.drivers,
        proxy=context.proxy,
        server=context.server,
        server_views=context.server_views,
    )
    print(f"\ne2e failure artifacts for {node.nodeid}: {destination}")


# ---------------------------------------------------------------------------
# Per-test fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def instrument_id(integration_env: IntegrationEnv, e2e_context: E2EContext) -> str:
    """A fresh instrument, with a unique ID, that exists and is active."""
    name = f"e2e-{uuid.uuid4().hex[:8]}"
    seed_instruments(integration_env.db_dsn, {name: f"E2E Instrument {name[-8:]}"})
    return name


@pytest.fixture
def proxy(integration_env: IntegrationEnv, e2e_context: E2EContext) -> Iterator[FaultProxy]:
    """A fresh fault proxy in front of the server, with no faults and an empty request log.

    The watcher's ``api_base_url`` is this proxy, so every request it makes, uploads
    included, can be delayed, refused or answered with an error. Use ``proxy.fault(...)``
    for a fault that lasts a ``with`` block, ``proxy.go_down()`` and ``come_up()`` for an
    outage, and ``proxy.requests`` to see what the watcher sent.
    """
    with FaultProxy(integration_env.base_url) as fault_proxy:
        e2e_context.proxy = fault_proxy
        yield fault_proxy


@pytest.fixture
def watcher_token(admin: Admin) -> str:
    """A personal access token with the watcher preset's scopes, like one on an instrument PC."""
    return admin.new_token(WATCHER_SCOPES)


@pytest.fixture
def server(
    integration_env: IntegrationEnv, watcher_token: str, e2e_context: E2EContext
) -> ServerView:
    """What the server says about the watcher under test: rows, events, files, the S3 stand-in."""
    view = ServerView(integration_env, watcher_token=watcher_token)
    e2e_context.server = view
    return view


@pytest.fixture
def watch_dir(tmp_path: Path) -> Path:
    """An empty watch folder, resolved (macOS temp folders are symlinks the watcher resolves)."""
    folder = (tmp_path / "watch").resolve()
    folder.mkdir()
    return folder


@pytest.fixture
def private_install(
    tmp_path_factory: pytest.TempPathFactory, current_wheel: Path
) -> Callable[[Path | None], ToolInstall]:
    """A factory for a ``uv tool install`` of this test's own: ``private_install()`` installs
    the current wheel, ``private_install(bumped_wheel)`` another one.

    It is what ``watcher(own_install=True, wheel=...)`` uses, and nothing else should ask for
    it: a scenario that did would be written for the CLI driver alone, because under the
    service there is one install for the machine.
    """

    def make(wheel: Path | None = None, *, python: str = "3.12") -> ToolInstall:
        return install_watcher_tool(
            tmp_path_factory.mktemp("private-install"), wheel or current_wheel, python=python
        )

    return make


@pytest.fixture
def unreadable_folder(tmp_path: Path) -> Iterator[Path]:
    """A folder that this user can't list (mode 000), for the one scenario about it.

    Root, and a user with a capability such as ``CAP_DAC_OVERRIDE``, can list it anyway, and
    then the scenario can't run. That is a skip on a developer's machine and a failure on CI
    (where ``$CI`` is set). The catalog check reads the test files and never sees a skip like
    this, so the scenario stays counted as covered whatever a local run does. A quiet skip
    on CI would make that count false without anybody noticing, so there it fails and says
    why. This is a fixture, not a ``pytest.skip`` in the test, because the check refuses those.
    """
    folder = tmp_path / "locked"
    folder.mkdir()
    folder.chmod(0o000)
    try:
        if _can_list(folder):
            message = (
                "This user can list a folder with no permissions (root, or a capability such "
                "as CAP_DAC_OVERRIDE), so the scenario about an unreadable watch folder "
                "can't run. Run the suite as an ordinary user."
            )
            if os.environ.get("CI"):
                pytest.fail(message, pytrace=False)
            pytest.skip(message)
        yield folder
    finally:
        folder.chmod(0o700)


def _can_list(folder: Path) -> bool:
    try:
        next(folder.iterdir(), None)
    except PermissionError:
        return False
    return True


@pytest.fixture
def watcher(
    integration_env: IntegrationEnv,
    proxy: FaultProxy,
    e2e_context: E2EContext,
    instrument_id: str,
    watch_dir: Path,
    watcher_token: str,
    driver_class: type[WatcherDriver],
    tool_install: ToolInstall,
    private_install: Callable[[Path | None], ToolInstall],
    server: ServerView,
    tmp_path: Path,
) -> Iterator[WatcherFactory]:
    """A factory for configured watchers (see ``WatcherFactory``). Each watcher it makes
    is stopped, and killed if it won't stop, when the test ends."""
    factory = WatcherFactory(
        env=integration_env,
        proxy=proxy,
        context=e2e_context,
        instrument_id=instrument_id,
        watch_dir=watch_dir,
        watcher_token=watcher_token,
        driver_class=driver_class,
        tool_install=tool_install,
        new_install=private_install,
        tmp_path=tmp_path,
    )
    yield factory
    for driver in e2e_context.drivers:
        driver.close()
