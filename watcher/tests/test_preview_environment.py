"""Unit tests for per-environment API base URLs.

Covers model validation (now lenient — a config may lack a URL), YAML config
round-trips, legacy `api_base_url` migration, and client construction (which
requires a URL for every environment).
"""

from __future__ import annotations
from pathlib import Path

import click
import pytest
import yaml

from data_hub_watcher.cli import _make_client
from data_hub_watcher.config_io import load_config, save_config
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig

PREVIEW_URL = "https://data-hub-git-my-branch.vercel.app/api/v1"


def _make_instrument(tmp_path: Path) -> InstrumentConfig:
    """Return a minimal valid InstrumentConfig rooted in *tmp_path*."""
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
    return InstrumentConfig(
        id="test-instrument",
        watch_directory=watch_dir,
        file_patterns=["*.csv"],
        run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
    )


# ------------------------------------------------------------------
# Group 1: WatcherConfig model validation (lenient — URL optional)
# ------------------------------------------------------------------


class TestWatcherConfigValidation:
    def test_config_without_url_is_valid(self, tmp_path: Path) -> None:
        # No environment requires a URL at the model layer anymore; the URL is
        # enforced when a client is built (see TestMakeClient).
        cfg = WatcherConfig(
            version=1,
            environment="preview",
            instrument=_make_instrument(tmp_path),
        )
        assert cfg.api_base_url is None
        assert cfg.api_base_urls == {}

    def test_legacy_api_base_url_migrates_to_map(self, tmp_path: Path) -> None:
        # `api_base_url` is no longer a field, so exercise the legacy scalar
        # via `model_validate` (what `load_config` uses) rather than a kwarg.
        cfg = WatcherConfig.model_validate(
            {
                "version": 1,
                "environment": "preview",
                "api_base_url": PREVIEW_URL,
                "instrument": _make_instrument(tmp_path).model_dump(mode="json"),
            }
        )
        assert cfg.api_base_urls == {"preview": PREVIEW_URL}
        assert cfg.api_base_url == PREVIEW_URL

    def test_api_base_url_reflects_active_environment(self, tmp_path: Path) -> None:
        cfg = WatcherConfig(
            version=1,
            environment="staging",
            api_base_urls={
                "staging": "https://staging.example.test/api/v1",
                "production": "https://prod.example.test/api/v1",
            },
            instrument=_make_instrument(tmp_path),
        )
        assert cfg.api_base_url == "https://staging.example.test/api/v1"


# ------------------------------------------------------------------
# Group 2: YAML config round-trips
# ------------------------------------------------------------------


class TestConfigRoundTrip:
    def test_round_trip_preserves_all_urls(self, tmp_path: Path) -> None:
        path = tmp_path / "config.yaml"
        original = WatcherConfig(
            version=1,
            environment="preview",
            api_base_urls={"preview": PREVIEW_URL},
            watcher_ids={"preview": "w-123"},
            instrument=_make_instrument(tmp_path),
        )

        save_config(original, path)
        loaded = load_config(path)

        assert loaded.environment == "preview"
        assert loaded.api_base_urls == {"preview": PREVIEW_URL}
        assert loaded.api_base_url == PREVIEW_URL
        assert loaded.watcher_id == "w-123"

    def test_legacy_scalar_url_in_yaml_migrates_on_load(self, tmp_path: Path) -> None:
        path = tmp_path / "config.yaml"
        watch_dir = tmp_path / "data"
        watch_dir.mkdir(exist_ok=True)
        (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")

        raw = {
            "version": 1,
            "environment": "preview",
            "api_base_url": PREVIEW_URL,
            "instrument": {
                "id": "test-instrument",
                "watch_directory": str(watch_dir),
                "file_patterns": ["*.csv"],
                "run_detection": {"pattern": "^([^_]+)", "recursive": False},
            },
        }
        path.write_text(yaml.dump(raw), encoding="utf-8")

        loaded = load_config(path)
        assert loaded.api_base_urls == {"preview": PREVIEW_URL}
        assert loaded.api_base_url == PREVIEW_URL

    def test_config_without_url_omits_scalar_in_yaml(self, tmp_path: Path) -> None:
        path = tmp_path / "config.yaml"
        cfg = WatcherConfig(
            version=1,
            environment="staging",
            instrument=_make_instrument(tmp_path),
        )

        save_config(cfg, path)
        data = yaml.safe_load(path.read_text(encoding="utf-8"))

        assert "api_base_url" not in data
        assert data.get("api_base_urls") == {}


# ------------------------------------------------------------------
# Group 3: _make_client helper (URL required for every environment)
# ------------------------------------------------------------------


class TestMakeClient:
    def test_uses_provided_url(self) -> None:
        client = _make_client("preview", api_base_url=PREVIEW_URL)
        assert client.base_url == PREVIEW_URL

    def test_staging_uses_provided_url(self) -> None:
        url = "https://staging.example.test/api/v1"
        client = _make_client("staging", api_base_url=url)
        assert client.base_url == url

    def test_missing_url_raises(self) -> None:
        with pytest.raises(click.ClickException, match="No API base URL is configured"):
            _make_client("preview")

    def test_missing_url_raises_for_staging(self) -> None:
        with pytest.raises(click.ClickException, match="No API base URL is configured"):
            _make_client("staging")
