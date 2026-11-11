"""The pieces behind the ``watcher`` fixture, in a module so tests can import them for typing.

Test modules can't import ``conftest`` (pytest runs with ``--import-mode=importlib``), so a
test that annotates its ``watcher`` argument imports ``WatcherFactory`` from here.
"""

from __future__ import annotations
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from data_hub_shared.testing import IntegrationEnv, seed_instruments
from data_hub_shared.testing_proxy import FaultProxy
from data_hub_watcher import testing_overrides
from data_hub_watcher.api_client import DataHubClient
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig
from e2e_support.drivers import (
    DEFAULT_ENVIRONMENT,
    DEFAULT_TIMER_OVERRIDES,
    CliDriver,
    ToolInstall,
    WatcherDriver,
)
from e2e_support.server import ServerView
from e2e_support.service_driver import WindowsServiceDriver

__all__ = ["E2EContext", "WatcherFactory"]


@dataclass
class E2EContext:
    """What the autouse fixture tracks so a failed test can be explained afterwards."""

    drivers: list[WatcherDriver] = field(default_factory=list)
    proxy: FaultProxy | None = None
    server: ServerView | None = None
    server_log_offset: int = 0
    # The server's view of each watcher when the test failed, in the order of `drivers`.
    server_views: list[str] = field(default_factory=list)

    def snapshot_server_views(self) -> None:
        """Record what the server says about each watcher now. Called when a test fails,
        before its fixtures stop the watchers and change the picture."""
        if self.server is None:
            return
        self.server_views = []
        for driver in self.drivers:
            try:
                self.server_views.append(self.server.dump(driver.watcher_id, driver.instrument_id))
            except Exception as exc:
                self.server_views.append(f"(could not read the server state: {exc})")


class WatcherFactory:
    """Builds configured watchers. This is the ``watcher`` fixture.

    ``watcher()`` returns a :class:`WatcherDriver` (of the kind the run uses, see
    ``$DATA_HUB_E2E_DRIVER``) for a PC that is set up like a real one after ``init``:
    ``config.yaml`` written with the watcher's own ``save_config``, an env file with its API
    key and the fast test overrides, and a watcher registered with the server (so
    ``driver.watcher_id`` is set). It is not started. Call ``driver.start()``.

    Everything is a keyword argument, so a test changes only what it cares about:

    * ``upload_mode``, ``file_patterns`` (default ``*.csv``), ``run_pattern`` and
      ``recursive`` (default: the top-level subfolder of the watch folder is the run),
      ``stability_period_seconds`` (1), ``max_stability_wait_seconds`` (60) and
      ``upload_parallelism`` (4).
    * ``initial_scan``: ``"full"`` (the default, so files already in the folder are uploaded),
      ``"new-only"``, or ``None`` for the environment's default.
    * ``overrides``: environment variables for the env file, merged over
      ``DEFAULT_TIMER_OVERRIDES`` (heartbeat 2 s, queue poll 2 s, update check every 5th
      heartbeat, 2 quiet heartbeats). A value of ``None`` removes a default.
    * ``index_url``: sets ``DATA_HUB_WATCHER_INDEX_URL``, for self-update.
    * ``own_install``: install the watcher for this PC alone. A watcher that updates itself
      reinstalls into the folder it runs from, so a scenario that updates (or that changes what
      is installed) asks for its own. ``wheel`` is the wheel to install instead of the
      current one (for example ``bumped_wheel``), and needs ``own_install=True``. Read the
      version with ``driver.installed_version()``.
    * ``instrument_id``, ``watch_dir``, ``environment``, ``api_base_url`` (default: the proxy),
      ``token`` (default: the test's watcher token).
    * ``register=False`` writes a config with no watcher id and registers nothing.
    * ``configure=False`` writes no config and no env file and registers nothing, for
      scenarios that run ``init`` themselves.
    * ``create_watch_dir=False`` leaves the watch folder out, so the watcher has to wait.
    """

    def __init__(
        self,
        *,
        env: IntegrationEnv,
        proxy: FaultProxy,
        context: E2EContext,
        instrument_id: str,
        watch_dir: Path,
        watcher_token: str,
        driver_class: type[WatcherDriver],
        tool_install: ToolInstall,
        new_install: Callable[[Path | None], ToolInstall],
        tmp_path: Path,
    ) -> None:
        self._env = env
        self._proxy = proxy
        self._context = context
        self._instrument_id = instrument_id
        self._watch_dir = watch_dir
        self._token = watcher_token
        self._driver_class = driver_class
        self._tool_install = tool_install
        self._new_install = new_install
        self._tmp_path = tmp_path

    def __call__(
        self,
        *,
        upload_mode: Literal["auto", "manual"] = "auto",
        file_patterns: Sequence[str] = ("*.csv",),
        run_pattern: str = r"^([^/]+)/",
        recursive: bool = True,
        stability_period_seconds: int = 1,
        max_stability_wait_seconds: int = 60,
        upload_parallelism: int = 4,
        initial_scan: Literal["full", "new-only"] | None = "full",
        overrides: Mapping[str, str | None] | None = None,
        index_url: str | None = None,
        own_install: bool = False,
        wheel: Path | None = None,
        instrument_id: str | None = None,
        watch_dir: Path | None = None,
        environment: str = DEFAULT_ENVIRONMENT,
        api_base_url: str | None = None,
        token: str | None = None,
        register: bool = True,
        configure: bool = True,
        create_watch_dir: bool = True,
    ) -> WatcherDriver:
        if wheel is not None and not own_install:
            raise ValueError("wheel= installs a wheel for this PC alone: pass own_install=True")
        instrument = instrument_id or self._instrument_id
        seed_instruments(self._env.db_dsn, {instrument: f"E2E Instrument {instrument[-8:]}"})
        folder = (watch_dir or self._watch_dir).resolve()
        if create_watch_dir:
            folder.mkdir(parents=True, exist_ok=True)
        api_key = token or self._token
        base_url = api_base_url or f"{self._proxy.base_url}/api/v1"

        number = len(self._context.drivers) + 1
        driver = self._new_driver(
            number=number,
            install=self._new_install(wheel) if own_install else self._tool_install,
            own_install=own_install,
            instrument=instrument,
            folder=folder,
            environment=environment,
            base_url=base_url,
            api_key=api_key,
        )
        self._context.drivers.append(driver)
        if not configure:
            return driver

        watcher_ids: dict[str, str] = {}
        if register:
            client = DataHubClient(f"{self._env.base_url}/api/v1", api_key=api_key)
            # The server is on this machine, and a proxy in the developer's environment
            # would send the request somewhere else.
            client._session.trust_env = False  # type: ignore[attr-defined]  # noqa: SLF001
            registered = client.register_watcher(
                instrument, hostname=f"e2e-pc-{number}", os_info="E2E test machine"
            )
            driver.watcher_id = registered.watcher_id
            watcher_ids[environment] = registered.watcher_id

        driver.write_config(
            WatcherConfig(
                version=1,
                environment=environment,  # type: ignore[arg-type]
                api_base_urls={environment: base_url},
                watcher_ids=watcher_ids,
                initial_scan=initial_scan,
                instrument=InstrumentConfig(
                    id=instrument,
                    watch_directory=folder,
                    file_patterns=list(file_patterns),
                    upload_mode=upload_mode,
                    stability_period_seconds=stability_period_seconds,
                    max_stability_wait_seconds=max_stability_wait_seconds,
                    upload_parallelism=upload_parallelism,
                    run_detection=RunDetectionConfig(pattern=run_pattern, recursive=recursive),
                ),
            )
        )
        variables: dict[str, str | None] = dict(DEFAULT_TIMER_OVERRIDES)
        if index_url is not None:
            variables[testing_overrides.INDEX_URL_ENV_VAR] = index_url
        variables.update(overrides or {})
        driver.write_env(api_key, variables)
        return driver

    def _new_driver(
        self,
        *,
        number: int,
        install: ToolInstall,
        own_install: bool,
        instrument: str,
        folder: Path,
        environment: str,
        base_url: str,
        api_key: str,
    ) -> WatcherDriver:
        """Build the driver of this run's kind: a ``CliDriver`` gets a ``HOME`` of its own, and a
        ``WindowsServiceDriver`` a profile folder that stands in for the operator's home
        (``USERPROFILE``), which holds ``~/.data-hub``. Each is a folder of this test."""
        folder_name = f"home-{number}"
        if issubclass(self._driver_class, CliDriver):
            return self._driver_class(
                home=self._tmp_path / folder_name,
                tool_install=install,
                instrument_id=instrument,
                watch_dir=folder,
                environment=environment,
                api_base_url=base_url,
                api_key=api_key,
                owns_install=own_install,
            )
        if issubclass(self._driver_class, WindowsServiceDriver):
            return self._driver_class(
                profile=self._tmp_path / folder_name,
                tool_install=install,
                instrument_id=instrument,
                watch_dir=folder,
                environment=environment,
                api_base_url=base_url,
                api_key=api_key,
                owns_install=own_install,
            )
        raise NotImplementedError(f"No way to build a {self._driver_class.__name__} yet")
