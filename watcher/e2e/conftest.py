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
* ``tool_install``: ``uv tool install --python 3.12`` of the current wheel, in a folder whose
  path contains ``/uv/tools/data-hub-watcher``, so the watcher recognises it as a uv-tool
  install. Tests share it, so no test may update it: one that updates the watcher asks for
  ``private_install``.
* ``package_index``: a local package index with both wheels, for self-update.

Per test:

* ``instrument_id``: a fresh instrument (a unique ID), the only one in the database.
* ``proxy``: a fresh ``FaultProxy`` in front of the server. The watcher talks to it.
* ``server``: a ``ServerView``.
* ``watch_dir``: an empty watch folder.
* ``watcher``: a factory for configured ``WatcherDriver`` objects. See ``WatcherFactory``.
* ``private_install``: a factory for a ``uv tool`` install of its own.

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
from e2e_support.drivers import ToolInstall, install_watcher_tool
from e2e_support.factory import E2EContext, WatcherFactory
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
    return [f"e2e failure artifacts: {artifacts_root()}"]


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
def tool_install(tmp_path_factory: pytest.TempPathFactory, current_wheel: Path) -> ToolInstall:
    """The shared ``uv tool install`` of the current wheel on Python 3.12.

    The watcher installs updates into the folder it runs from, so a test that updates must
    not use this one: ask for ``private_install``.
    """
    return install_watcher_tool(tmp_path_factory.mktemp("shared-install"), current_wheel)


@pytest.fixture(scope="session")
def _package_index(wheel_dir: Path, current_wheel: Path) -> Iterator[LocalPackageIndex]:
    with LocalPackageIndex(wheel_dir) as index:
        yield index


@pytest.fixture
def package_index(_package_index: LocalPackageIndex) -> Iterator[LocalPackageIndex]:
    """A local package index serving the wheels of ``wheel_dir`` (the current one, and the
    bumped one once ``bumped_wheel`` is requested). Pass ``package_index.url`` to the watcher
    with ``watcher(index_url=...)``. Failure switches are cleared after each test."""
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
) -> Callable[..., ToolInstall]:
    """A factory for a ``uv tool install`` of this test's own, for a scenario that updates the
    watcher. ``private_install()`` installs the current wheel,
    ``private_install(bumped_wheel)`` another one. Pass the result as ``tool_install=`` to
    ``watcher(...)``."""

    def make(wheel: Path | None = None, *, python: str = "3.12") -> ToolInstall:
        return install_watcher_tool(
            tmp_path_factory.mktemp("private-install"), wheel or current_wheel, python=python
        )

    return make


@pytest.fixture
def watcher(
    integration_env: IntegrationEnv,
    proxy: FaultProxy,
    e2e_context: E2EContext,
    instrument_id: str,
    watch_dir: Path,
    watcher_token: str,
    tool_install: ToolInstall,
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
        tool_install=tool_install,
        tmp_path=tmp_path,
    )
    yield factory
    for driver in e2e_context.drivers:
        driver.close()
