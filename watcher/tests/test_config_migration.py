"""Per-environment `watcher_ids` schema, legacy migration, and scan-mode defaults."""

from __future__ import annotations
from pathlib import Path

import yaml

from data_hub_watcher.config_io import load_config, save_config
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig


def _instrument(tmp_path: Path) -> InstrumentConfig:
    watch_dir = tmp_path / "data"
    watch_dir.mkdir(exist_ok=True)
    (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
    return InstrumentConfig(
        id="test-instrument",
        watch_directory=watch_dir,
        file_patterns=["*.csv"],
        run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
    )


def _legacy_yaml(watch_dir: Path) -> dict:
    return {
        "version": 1,
        "environment": "production",
        "watcher_id": "w-legacy",
        "instrument": {
            "id": "test-instrument",
            "watch_directory": str(watch_dir),
            "file_patterns": ["*.csv"],
            "run_detection": {"pattern": "^([^_]+)", "recursive": False},
        },
    }


class TestLegacyMigration:
    def test_yaml_legacy_watcher_id_lifts_into_map(self, tmp_path: Path) -> None:
        watch_dir = tmp_path / "data"
        watch_dir.mkdir()
        (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
        path = tmp_path / "config.yaml"
        path.write_text(yaml.dump(_legacy_yaml(watch_dir)), encoding="utf-8")

        cfg = load_config(path)

        assert cfg.watcher_ids == {"production": "w-legacy"}
        assert cfg.watcher_id == "w-legacy"

    def test_model_validate_legacy_watcher_id_lifts_into_map(self, tmp_path: Path) -> None:
        # `watcher_id` is no longer a field, so exercise the legacy shape via
        # `model_validate` (what `load_config` uses) rather than a kwarg.
        cfg = WatcherConfig.model_validate(
            {
                "version": 1,
                "environment": "staging",
                "watcher_id": "w-old",
                "instrument": _instrument(tmp_path).model_dump(mode="json"),
            }
        )
        assert cfg.watcher_ids == {"staging": "w-old"}
        assert cfg.watcher_id == "w-old"

    def test_legacy_key_dropped_on_save(self, tmp_path: Path) -> None:
        watch_dir = tmp_path / "data"
        watch_dir.mkdir()
        (watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
        path = tmp_path / "config.yaml"
        path.write_text(yaml.dump(_legacy_yaml(watch_dir)), encoding="utf-8")

        save_config(load_config(path), path)
        data = yaml.safe_load(path.read_text(encoding="utf-8"))

        assert "watcher_id" not in data
        assert data["watcher_ids"] == {"production": "w-legacy"}


class TestWatcherIdProperty:
    def test_returns_id_for_active_environment(self, tmp_path: Path) -> None:
        cfg = WatcherConfig(
            version=1,
            environment="staging",
            watcher_ids={"staging": "w-staging", "production": "w-prod"},
            instrument=_instrument(tmp_path),
        )
        assert cfg.watcher_id == "w-staging"

    def test_returns_none_when_unregistered_for_environment(self, tmp_path: Path) -> None:
        cfg = WatcherConfig(
            version=1,
            environment="production",
            watcher_ids={"staging": "w-staging"},
            instrument=_instrument(tmp_path),
        )
        assert cfg.watcher_id is None


class TestMultiEnvRoundTrip:
    def test_round_trip_preserves_all_ids(self, tmp_path: Path) -> None:
        path = tmp_path / "config.yaml"
        original = WatcherConfig(
            version=1,
            environment="production",
            watcher_ids={"staging": "w-staging", "production": "w-prod"},
            instrument=_instrument(tmp_path),
        )

        save_config(original, path)
        loaded = load_config(path)

        assert loaded.watcher_ids == {"staging": "w-staging", "production": "w-prod"}


class TestResolveInitialScan:
    def test_production_defaults_to_full(self, tmp_path: Path) -> None:
        cfg = WatcherConfig(version=1, environment="production", instrument=_instrument(tmp_path))
        assert cfg.resolve_initial_scan() == "full"

    def test_staging_defaults_to_new_only(self, tmp_path: Path) -> None:
        cfg = WatcherConfig(version=1, environment="staging", instrument=_instrument(tmp_path))
        assert cfg.resolve_initial_scan() == "new-only"

    def test_explicit_override_wins(self, tmp_path: Path) -> None:
        cfg = WatcherConfig(
            version=1,
            environment="production",
            initial_scan="new-only",
            instrument=_instrument(tmp_path),
        )
        assert cfg.resolve_initial_scan() == "new-only"
