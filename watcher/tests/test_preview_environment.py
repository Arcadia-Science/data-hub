"""Unit tests for the 'preview' environment option.

Covers model validation, YAML config round-trips, and client construction.
"""

from __future__ import annotations
from pathlib import Path

import click
import pytest
import yaml
from pydantic import ValidationError

from data_hub_watcher.cli import _make_client
from data_hub_watcher.config_io import load_config, save_config
from data_hub_watcher.constants import API_URLS
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
# Group 1: WatcherConfig model validation
# ------------------------------------------------------------------


class TestWatcherConfigValidation:
    def test_preview_requires_api_base_url(self, tmp_path: Path) -> None:
        with pytest.raises(ValidationError, match="api_base_url is required"):
            WatcherConfig(
                version=1,
                environment="preview",
                instrument=_make_instrument(tmp_path),
            )

    def test_preview_with_api_base_url_succeeds(self, tmp_path: Path) -> None:
        cfg = WatcherConfig(
            version=1,
            environment="preview",
            api_base_url=PREVIEW_URL,
            instrument=_make_instrument(tmp_path),
        )
        assert cfg.environment == "preview"
        assert cfg.api_base_url == PREVIEW_URL

    def test_staging_does_not_require_api_base_url(self, tmp_path: Path) -> None:
        cfg = WatcherConfig(
            version=1,
            environment="staging",
            instrument=_make_instrument(tmp_path),
        )
        assert cfg.api_base_url is None

    def test_production_does_not_require_api_base_url(self, tmp_path: Path) -> None:
        cfg = WatcherConfig(
            version=1,
            environment="production",
            instrument=_make_instrument(tmp_path),
        )
        assert cfg.api_base_url is None


# ------------------------------------------------------------------
# Group 2: YAML config round-trips
# ------------------------------------------------------------------


class TestConfigRoundTrip:
    def test_preview_config_round_trip(self, tmp_path: Path) -> None:
        path = tmp_path / "config.yaml"
        original = WatcherConfig(
            version=1,
            environment="preview",
            api_base_url=PREVIEW_URL,
            watcher_id="w-123",
            instrument=_make_instrument(tmp_path),
        )

        save_config(original, path)
        loaded = load_config(path)

        assert loaded.environment == "preview"
        assert loaded.api_base_url == PREVIEW_URL
        assert loaded.watcher_id == "w-123"

    def test_preview_yaml_without_url_fails_to_load(self, tmp_path: Path) -> None:
        path = tmp_path / "config.yaml"
        watch_dir = tmp_path / "data"
        watch_dir.mkdir(exist_ok=True)
        (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")

        raw = {
            "version": 1,
            "environment": "preview",
            "instrument": {
                "id": "test-instrument",
                "watch_directory": str(watch_dir),
                "file_patterns": ["*.csv"],
                "run_detection": {"pattern": "^([^_]+)", "recursive": False},
            },
        }
        path.write_text(yaml.dump(raw), encoding="utf-8")

        with pytest.raises(click.ClickException, match="api_base_url is required"):
            load_config(path)

    def test_staging_config_omits_api_base_url_in_yaml(self, tmp_path: Path) -> None:
        path = tmp_path / "config.yaml"
        cfg = WatcherConfig(
            version=1,
            environment="staging",
            instrument=_make_instrument(tmp_path),
        )

        save_config(cfg, path)
        raw_yaml = path.read_text(encoding="utf-8")
        data = yaml.safe_load(raw_yaml)

        assert data.get("api_base_url") is None


# ------------------------------------------------------------------
# Group 3: _make_client helper
# ------------------------------------------------------------------


class TestMakeClient:
    def test_preview_uses_custom_url(self) -> None:
        client = _make_client("preview", api_base_url=PREVIEW_URL)
        assert client.base_url == PREVIEW_URL

    def test_preview_without_url_raises(self) -> None:
        with pytest.raises(click.ClickException, match="api_base_url is required"):
            _make_client("preview")

    def test_staging_uses_hardcoded_url(self) -> None:
        client = _make_client("staging")
        assert client.base_url == API_URLS["staging"]

    def test_production_uses_hardcoded_url(self) -> None:
        client = _make_client("production")
        assert client.base_url == API_URLS["production"]

    def test_staging_ignores_api_base_url(self) -> None:
        client = _make_client("staging", api_base_url="https://should-be-ignored.example.com")
        assert client.base_url == API_URLS["staging"]
