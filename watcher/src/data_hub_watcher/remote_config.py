"""Turn a config revision from the web app into a `WatcherConfig`.

Pure helpers used by `runtime.WatcherSupervisor`: validating a revision's
settings, merging them into the running config, comparing settings, and
working out whether a change widens what the watcher sees. Nothing here talks
to the API or touches the runtime.
"""

from __future__ import annotations
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from data_hub_watcher.models import (
    InstrumentConfig,
    RunDetectionConfig,
    RunDetectionSettings,
    WatcherConfig,
    WatcherConfigSettings,
    watch_directory_problem,
)
from data_hub_watcher.monitor import _compile_pattern_matcher


class RevisionRejected(Exception):
    """A config revision failed validation. The message is the reason sent to the server."""


def format_validation_error(exc: ValidationError) -> str:
    """One-line summary of a pydantic error, for a rejected revision's reason."""
    parts = []
    for err in exc.errors():
        loc = ".".join(str(part) for part in err["loc"])
        msg = err["msg"]
        parts.append(f"{loc}: {msg}" if loc else msg)
    return "; ".join(parts)


def settings_from_config(inst: InstrumentConfig) -> WatcherConfigSettings:
    """The editable settings of *inst*, in the wire-contract shape."""
    return WatcherConfigSettings.model_construct(
        watch_directory=str(inst.watch_directory),
        file_patterns=list(inst.file_patterns),
        run_detection=RunDetectionSettings.model_construct(
            pattern=inst.run_detection.pattern,
            recursive=inst.run_detection.recursive,
        ),
        upload_mode=inst.upload_mode,
        stability_period_seconds=inst.stability_period_seconds,
        max_stability_wait_seconds=inst.max_stability_wait_seconds,
        upload_parallelism=inst.upload_parallelism,
    )


def editable_settings_problem(inst: InstrumentConfig) -> str | None:
    """Why Data Hub can't read the editable settings of *inst*, or `None`.

    The watcher accepts some configs the server's rules don't, such as more
    than 50 file patterns, a pattern longer than 200 characters, or a
    Python-only named group in the run regex. The watcher runs them fine, but
    the server can't parse the pushed YAML, so it records no revision for the
    PC's edits and the web form can't start from them.
    """
    try:
        WatcherConfigSettings.model_validate(settings_from_config(inst).model_dump())
    except ValidationError as exc:
        return format_validation_error(exc)
    pattern = inst.run_detection.pattern
    if "(?P<" in pattern or "(?P=" in pattern:
        return (
            "run_detection.pattern: Python-style named groups, such as (?P<name>…), "
            "can't be read by Data Hub; use a plain capture group, such as (…)"
        )
    return None


def _normalized_dir(path: str | Path) -> str:
    # The web app stores the folder as typed, and the watcher stores it
    # resolved, so `D:/Exports` and `D:\\Exports` must compare equal.
    return os.path.normcase(os.path.normpath(str(path)))


def _comparable(settings: WatcherConfigSettings) -> dict[str, Any]:
    data = settings.model_dump()
    data["watch_directory"] = _normalized_dir(settings.watch_directory)
    return data


def settings_match(inst: InstrumentConfig, raw_settings: dict[str, Any]) -> bool:
    """Whether *raw_settings* (from a revision) equal the editable fields of *inst*."""
    try:
        settings = WatcherConfigSettings.model_validate(raw_settings)
    except ValidationError:
        return False
    return _comparable(settings) == _comparable(settings_from_config(inst))


def config_with_revision(cfg: WatcherConfig, raw_settings: dict[str, Any]) -> WatcherConfig:
    """Return *cfg* with a revision's settings merged in, or raise `RevisionRejected`.

    Only the editable fields change. The environment, API URLs, watcher IDs,
    `initial_scan`, the instrument ID and `enabled` always come from *cfg*.
    Checks the same rules as the server, plus that the folder exists and can
    be listed, which only the PC can check.
    """
    try:
        settings = WatcherConfigSettings.model_validate(raw_settings)
    except ValidationError as exc:
        raise RevisionRejected(format_validation_error(exc)) from exc

    inst = cfg.instrument
    try:
        new_inst = InstrumentConfig(
            id=inst.id,
            enabled=inst.enabled,
            watch_directory=Path(settings.watch_directory),
            file_patterns=list(settings.file_patterns),
            upload_mode=settings.upload_mode,
            stability_period_seconds=settings.stability_period_seconds,
            max_stability_wait_seconds=settings.max_stability_wait_seconds,
            upload_parallelism=settings.upload_parallelism,
            run_detection=RunDetectionConfig(
                pattern=settings.run_detection.pattern,
                recursive=settings.run_detection.recursive,
            ),
        )
    except ValidationError as exc:
        raise RevisionRejected(format_validation_error(exc)) from exc

    problem = watch_directory_problem(new_inst.watch_directory)
    if problem is not None:
        raise RevisionRejected(problem)

    # `model_copy` skips `WatcherConfig`'s load-time warnings, which walk the
    # whole folder looking for a matching file.
    return cfg.model_copy(update={"instrument": new_inst})


def folder_changed(old: InstrumentConfig, new: InstrumentConfig) -> bool:
    return _normalized_dir(old.watch_directory) != _normalized_dir(new.watch_directory)


def widens_scope(old: InstrumentConfig, new: InstrumentConfig) -> bool:
    """Whether *new* can match files on disk that *old* never handled.

    True for a new folder, a new file pattern, recursion turned on, or a new
    run-detection regex (a file the old regex didn't match was never reported,
    so the new one may pick it up).
    """
    return (
        folder_changed(old, new)
        or bool(set(new.file_patterns) - set(old.file_patterns))
        or (new.run_detection.recursive and not old.run_detection.recursive)
        or new.run_detection.pattern != old.run_detection.pattern
    )


def _handled_by(inst: InstrumentConfig) -> Callable[[str], bool]:
    """``relative_path -> bool``: whether *inst* would have reported the file."""
    matches_name = _compile_pattern_matcher(inst.file_patterns)
    run_regex = re.compile(inst.run_detection.pattern)
    recursive = inst.run_detection.recursive

    def handled(relative_path: str) -> bool:
        if not recursive and "/" in relative_path:
            return False
        if not matches_name(relative_path.rsplit("/", 1)[-1]):
            return False
        match = run_regex.search(relative_path)
        return bool(match and match.group(1))

    return handled


def report_only_predicate(
    old: InstrumentConfig, new: InstrumentConfig, *, cutoff: float
) -> Callable[[str, float], bool]:
    """Build the `FileMonitor` ``report_only`` predicate for a widening change.

    A file is reported without uploading when it was last modified before
    *cutoff* (the moment the change was applied) and the old config would not
    have reported it. Everything else follows `upload_mode` as usual: files
    written after the change, and files the old config also matched that are
    missing from the local state, such as a file that arrived while the
    runtime was being rebuilt.

    State rows are keyed by the path relative to the watch folder, so after a
    folder change a file is still skipped when an old row has the same
    relative path, size and modification time. That only happens when the new
    folder holds a copy of the old one's files, where skipping is what we want.
    """
    if folder_changed(old, new):
        return lambda _relative_path, mtime: mtime < cutoff

    handled_before = _handled_by(old)

    def report_only(relative_path: str, mtime: float) -> bool:
        return mtime < cutoff and not handled_before(relative_path)

    return report_only
