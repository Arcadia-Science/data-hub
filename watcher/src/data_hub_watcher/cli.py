from __future__ import annotations
import fnmatch
import logging
import os
import platform
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import click

from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.config_io import config_checksum, load_config, save_config
from data_hub_watcher.constants import (
    API_URLS,
    DEFAULT_CONFIG_DIR,
    DEFAULT_STABILITY_PERIOD_SECONDS,
    HEARTBEAT_INTERVAL_SECONDS,
    PRUNE_DAYS,
    RUN_DETECTION_PRESETS,
    STATE_DB_FILENAME,
    load_env,
    resolve_config_path,
    save_api_key,
)
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import HeartbeatLoop, WatcherCounters
from data_hub_watcher.models import (
    InstrumentConfig,
    RunDetectionConfig,
    WatcherConfig,
)
from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.run_detector import RunDetector
from data_hub_watcher.state import StateDB
from data_hub_watcher.uploader import Uploader

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Root group
# ---------------------------------------------------------------------------


@click.group()
@click.option(
    "--config",
    "config_path",
    default=None,
    type=click.Path(),
    envvar="DATA_HUB_CONFIG_PATH",
    help="Override config file path.",
)
@click.option("--verbose", is_flag=True, help="Enable debug logging.")
@click.version_option()
@click.pass_context
def cli(ctx: click.Context, config_path: str | None, verbose: bool) -> None:
    """Data Hub Watcher — file upload service for lab instrument PCs."""
    load_env()
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    ctx.ensure_object(dict)
    ctx.obj["config_path"] = config_path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_path(ctx: click.Context) -> Path:
    return resolve_config_path(ctx.obj.get("config_path"))


def _make_client(
    environment: str, api_key: str | None = None, api_base_url: str | None = None
) -> DataHubClient:
    if environment == "preview":
        if not api_base_url:
            raise click.ClickException("api_base_url is required for the 'preview' environment.")
        base_url = api_base_url
    else:
        base_url = API_URLS[environment]
    return DataHubClient(base_url, api_key=api_key)


def _load_and_client(ctx: click.Context) -> tuple[WatcherConfig, DataHubClient, Path]:
    """Load config and build a matching API client. Returns (config, client, path)."""
    path = _resolve_path(ctx)
    cfg = load_config(path)
    client = _make_client(cfg.environment, api_base_url=cfg.api_base_url)
    return cfg, client, path


def _setup_file_logging() -> None:
    """Add a RotatingFileHandler to the root logger (`~/.data-hub/watcher.log`)."""
    from logging.handlers import RotatingFileHandler

    log_path = DEFAULT_CONFIG_DIR / "watcher.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        str(log_path), maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    logging.getLogger().addHandler(handler)


# ---------------------------------------------------------------------------
# init command
# ---------------------------------------------------------------------------


@cli.command()
@click.pass_context
def init(ctx: click.Context) -> None:
    """Interactive setup wizard + API registration."""
    path = _resolve_path(ctx)
    if path.exists():
        if not click.confirm(f"Config already exists at {path}. Overwrite?"):
            raise SystemExit(0)

    # 1. Environment
    environment = click.prompt(
        "Environment",
        type=click.Choice(["staging", "production", "preview"], case_sensitive=False),
    )

    api_base_url: str | None = None
    if environment == "preview":
        raw_url: str = click.prompt(
            "Preview deployment base URL (e.g. https://data-hub-git-my-branch.vercel.app/api/v1)"
        )
        api_base_url = raw_url.rstrip("/")

    # 2. API key
    api_key = os.environ.get("DATA_HUB_API_KEY", "")
    if not api_key:
        api_key = click.prompt("DATA_HUB_API_KEY", hide_input=True)

    client = _make_client(environment, api_key=api_key, api_base_url=api_base_url)

    # 3. Instruments (also validates the API key before we persist it)
    click.echo("\nFetching instruments…")
    try:
        instruments = client.list_instruments()
    except ApiError as exc:
        raise click.ClickException(
            f"Failed to fetch instruments: {exc.message}\n"
            "The API key was not saved. Please re-run init with a valid key."
        ) from exc

    env_path = save_api_key(api_key)
    click.echo(f"API key saved to {env_path}")

    if instruments:
        click.echo("\nExisting instruments:")
        for i, inst in enumerate(instruments, 1):
            color = "yellow" if inst.status == "pending" else "green"
            status_badge = click.style(f"[{inst.status}]", fg=color)
            click.echo(f"  {i}. {inst.id} {status_badge} — {inst.display_name}")
        click.echo(f"  {len(instruments) + 1}. Register a new instrument")

        choice = click.prompt(
            "Select",
            type=click.IntRange(1, len(instruments) + 1),
        )
        if choice <= len(instruments):
            selected = instruments[choice - 1]
        else:
            selected = _register_new_instrument(client)
    else:
        click.echo("No instruments found. Let's register one.")
        selected = _register_new_instrument(client)

    # 4. Watch directory
    watch_dir_str = click.prompt("Watch directory (absolute path)")
    watch_dir = Path(watch_dir_str).expanduser().resolve()
    if not watch_dir.is_dir():
        raise click.ClickException(f"Not a directory: {watch_dir}")

    # 5. File patterns
    default_patterns = ",".join(selected.file_patterns) if selected.file_patterns else "*.*"
    patterns_raw = click.prompt("File patterns (comma-separated)", default=default_patterns)
    file_patterns = [p.strip() for p in patterns_raw.split(",") if p.strip()]
    if not file_patterns:
        raise click.ClickException("At least one file pattern is required.")

    run_pattern, run_recursive = _prompt_run_detection(watch_dir)

    # How long a file's size + mtime must remain unchanged before we consider
    # it fully written. Instruments that produce large files may need a longer
    # period to avoid uploading partial writes.
    stability = click.prompt(
        "Stability period (seconds)",
        type=click.IntRange(1, 300),
        default=DEFAULT_STABILITY_PERIOD_SECONDS,
    )

    # "auto": files are uploaded to S3 immediately after run detection.
    # "manual": the server decides which files to upload via a queue, polled
    # on each heartbeat tick. Useful when uploads need human approval.
    upload_mode = click.prompt(
        "Upload mode",
        type=click.Choice(["auto", "manual"], case_sensitive=False),
        default="auto",
    )

    # 9. Register watcher
    click.echo("\nRegistering watcher…")
    try:
        reg = client.register_watcher(
            instrument_id=selected.id,
            hostname=platform.node(),
            os_info=f"{platform.system()} {platform.release()}",
        )
    except ApiError as exc:
        raise click.ClickException(f"Failed to register watcher: {exc.message}") from exc

    watcher_id = reg.watcher_id
    click.echo(f"Watcher registered: {watcher_id}")

    # 10. Build and save config
    config = WatcherConfig(
        version=1,
        environment=environment,
        api_base_url=api_base_url,
        watcher_id=watcher_id,
        instrument=InstrumentConfig(
            id=selected.id,
            watch_directory=watch_dir,
            file_patterns=file_patterns,
            upload_mode=upload_mode,
            stability_period_seconds=stability,
            run_detection=RunDetectionConfig(
                pattern=run_pattern,
                recursive=run_recursive,
            ),
        ),
    )

    save_config(config, path)
    click.echo(f"Config saved to {path}")

    # 11. Push config to API
    _push_config_to_api(client, watcher_id, path, trigger="init")

    click.echo(click.style("\n✓ Setup complete!", fg="green", bold=True))
    click.echo("  Start watching with: data-hub-watcher watch")


def _register_new_instrument(client: DataHubClient) -> Any:
    """Prompt for a new instrument and register it."""
    inst_id = click.prompt("Instrument ID (kebab-case)")
    if not re.match(r"^[a-z0-9]+(-[a-z0-9]+)*$", inst_id):
        raise click.ClickException("ID must be kebab-case (lowercase letters, numbers, hyphens).")
    display_name = click.prompt("Display name", default=inst_id.replace("-", " ").title())
    try:
        return client.create_instrument(inst_id, display_name)
    except ApiError as exc:
        raise click.ClickException(f"Failed to create instrument: {exc.message}") from exc


def _prompt_run_detection(
    watch_dir: Path,
    *,
    current_pattern: str | None = None,
    current_recursive: bool | None = None,
) -> tuple[str, bool]:
    """Prompt the operator for a run-detection pattern and recursive flag.

    Returns ``(pattern, recursive)``.
    """
    click.echo("\nRun detection — how should the run ID be determined?")
    for i, (_key, desc, _pat, _rec) in enumerate(RUN_DETECTION_PRESETS, 1):
        click.echo(f"  {i}. {desc}")
    custom_idx = len(RUN_DETECTION_PRESETS) + 1
    click.echo(f"  {custom_idx}. Custom regex")

    choice = click.prompt("Select", type=click.IntRange(1, custom_idx), default=1)

    if choice == custom_idx:
        prompt_default = current_pattern or RUN_DETECTION_PRESETS[0][2]
        while True:
            pattern = click.prompt(
                "Run detection pattern (regex with 1 capture group)",
                default=prompt_default,
            )
            try:
                compiled = re.compile(pattern)
            except re.error as exc:
                click.echo(click.style(f"  Invalid regex: {exc}", fg="red"))
                continue
            if compiled.groups != 1:
                click.echo(
                    click.style(
                        f"  Pattern must have exactly 1 capture group, got {compiled.groups}",
                        fg="red",
                    )
                )
                continue
            break
        default_rec = current_recursive if current_recursive is not None else True
    else:
        _key, _desc, pattern, default_rec = RUN_DETECTION_PRESETS[choice - 1]
        click.echo(f"  Pattern: {pattern}")

    recursive = click.confirm(
        "Watch subdirectories recursively?",
        default=default_rec,
    )

    _preview_run_pattern(pattern, watch_dir, recursive)
    return pattern, recursive


def _preview_run_pattern(pattern: str, directory: Path, recursive: bool) -> None:
    """Show sample matches for the run detection pattern."""
    try:
        compiled = re.compile(pattern)
    except re.error:
        click.echo(click.style("  Warning: invalid regex, skipping preview.", fg="yellow"))
        return

    samples: list[str] = []
    try:
        iterator = sorted(directory.rglob("*")) if recursive else sorted(directory.iterdir())
        for entry in iterator[:50]:
            if not entry.is_file():
                continue
            try:
                rel = entry.relative_to(directory).as_posix()
            except ValueError:
                continue
            m = compiled.search(rel)
            if m and m.group(1):
                samples.append(f"    {rel} → run: {m.group(1)}")
            if len(samples) >= 10:
                break
    except PermissionError:
        pass

    if samples:
        click.echo("  Pattern preview:")
        for s in samples:
            click.echo(s)
    else:
        click.echo("  (no matching files found for preview)")


def _push_config_to_api(
    client: DataHubClient,
    watcher_id: str,
    path: Path,
    *,
    trigger: str = "init",
    reporter: EventReporter | None = None,
) -> None:
    """Push config YAML and checksum to the API."""
    try:
        yaml_content = path.read_text(encoding="utf-8")
        checksum = config_checksum(path)
        client.push_config(watcher_id, yaml_content, checksum)
        click.echo("Config synced to Data Hub.")
        if reporter is not None:
            reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.CONFIG_SYNCED,
                    message=f"Config synced (trigger={trigger})",
                    details={"trigger": trigger},
                )
            )
    except ApiError as exc:
        click.echo(
            click.style(f"Warning: could not sync config to API: {exc.message}", fg="yellow")
        )


def _dry_run_scan(cfg: WatcherConfig) -> None:
    """Scan the watch directory and log what `watch` would do, without side effects."""
    inst = cfg.instrument
    is_auto = inst.upload_mode == "auto"
    is_recursive = inst.run_detection.recursive
    watch_dir = inst.watch_directory
    pattern_re = re.compile(inst.run_detection.pattern)

    iterator = watch_dir.rglob("*") if is_recursive else watch_dir.iterdir()
    matched: list[Path] = []
    for entry in sorted(iterator):
        if not entry.is_file():
            continue
        if not any(fnmatch.fnmatch(entry.name, pat) for pat in inst.file_patterns):
            continue
        matched.append(entry)

    if not matched:
        click.echo(f"\nNo matching files found in {watch_dir}")
        return

    runs: dict[str, list[Path]] = {}
    unmatched: list[Path] = []
    for path in matched:
        run_id = _extract_run_id_for_dry_run(path, pattern_re, watch_dir)
        if run_id is None:
            unmatched.append(path)
        else:
            runs.setdefault(run_id, []).append(path)

    click.echo(f"\nDetected {len(matched)} file(s) in {watch_dir}:")

    for run_id in sorted(runs):
        files = runs[run_id]
        click.echo(f"\n  Run {click.style(run_id, bold=True)} ({len(files)} file(s)):")
        for path in files:
            s3_key = f"{inst.id}/{run_id}/{path.name}"
            click.echo(f"    {path.name}")
            click.echo(f"      → {s3_key}")

    if unmatched:
        click.echo(f"\n  {len(unmatched)} file(s) did not match any run pattern:")
        for path in unmatched:
            click.echo(f"    {path.name}")

    mode_label = (
        "auto (files would be uploaded immediately)"
        if is_auto
        else "manual (runs would be reported without uploading)"
    )
    click.echo(f"\nUpload mode: {mode_label}")
    click.echo(f"Total: {len(runs)} run(s), {sum(len(f) for f in runs.values())} grouped file(s)")


def _extract_run_id_for_dry_run(
    path: Path, pattern_re: re.Pattern[str], watch_dir: Path
) -> str | None:
    """Extract a run ID from *path* using the same logic as `RunDetector`."""
    try:
        rel = path.relative_to(watch_dir).as_posix()
    except ValueError:
        return None
    m = pattern_re.search(rel)
    if m and m.group(1):
        return m.group(1)
    return None


# ---------------------------------------------------------------------------
# config group
# ---------------------------------------------------------------------------


@cli.group()
def config() -> None:
    """View and manage the watcher config file."""


@config.command("show")
@click.pass_context
def config_show(ctx: click.Context) -> None:
    """Pretty-print the current config."""
    path = _resolve_path(ctx)
    cfg = load_config(path)

    inst = cfg.instrument
    click.echo(f"Config: {path}")
    click.echo(f"  Version:     {cfg.version}")
    click.echo(f"  Environment: {cfg.environment}")
    if cfg.api_base_url:
        click.echo(f"  API base URL: {cfg.api_base_url}")
    click.echo(f"  Watcher ID:  {cfg.watcher_id or '(not registered)'}")
    click.echo("  Instrument:")
    click.echo(f"    ID:              {inst.id}")
    click.echo(f"    Watch directory: {inst.watch_directory}")
    click.echo(f"    File patterns:   {', '.join(inst.file_patterns)}")
    click.echo(f"    Enabled:         {inst.enabled}")
    click.echo(f"    Upload mode:     {inst.upload_mode}")
    click.echo(f"    Stability (s):   {inst.stability_period_seconds}")
    click.echo(f"    Run pattern:     {inst.run_detection.pattern}")
    click.echo(f"    Recursive:       {inst.run_detection.recursive}")


@config.command("validate")
@click.pass_context
def config_validate(ctx: click.Context) -> None:
    """Validate the config file (offline, no network calls)."""
    path = _resolve_path(ctx)
    load_config(path)  # raises on validation error
    click.echo(click.style(f"✓ Config is valid: {path}", fg="green"))


@config.command("edit")
@click.pass_context
def config_edit(ctx: click.Context) -> None:
    """Re-prompt each config field with current values as defaults."""
    path = _resolve_path(ctx)
    cfg = load_config(path)
    inst = cfg.instrument

    watch_dir_str = click.prompt("Watch directory", default=str(inst.watch_directory))
    watch_dir = Path(watch_dir_str).expanduser().resolve()
    if not watch_dir.is_dir():
        raise click.ClickException(f"Not a directory: {watch_dir}")

    patterns_raw = click.prompt(
        "File patterns (comma-separated)",
        default=",".join(inst.file_patterns),
    )
    file_patterns = [p.strip() for p in patterns_raw.split(",") if p.strip()]

    run_pattern, run_recursive = _prompt_run_detection(
        watch_dir,
        current_pattern=inst.run_detection.pattern,
        current_recursive=inst.run_detection.recursive,
    )

    stability = click.prompt(
        "Stability period (seconds)",
        type=click.IntRange(1, 300),
        default=inst.stability_period_seconds,
    )

    upload_mode = click.prompt(
        "Upload mode",
        type=click.Choice(["auto", "manual"], case_sensitive=False),
        default=inst.upload_mode,
    )

    enabled = click.confirm("Enabled?", default=inst.enabled)

    new_config = WatcherConfig(
        version=cfg.version,
        environment=cfg.environment,
        api_base_url=cfg.api_base_url,
        watcher_id=cfg.watcher_id,
        instrument=InstrumentConfig(
            id=inst.id,
            watch_directory=watch_dir,
            file_patterns=file_patterns,
            enabled=enabled,
            upload_mode=upload_mode,
            stability_period_seconds=stability,
            run_detection=RunDetectionConfig(pattern=run_pattern, recursive=run_recursive),
        ),
    )

    save_config(new_config, path)
    click.echo(f"Config saved to {path}")

    if cfg.watcher_id:
        client = _make_client(cfg.environment, api_base_url=cfg.api_base_url)
        _push_config_to_api(client, cfg.watcher_id, path, trigger="edit")


@config.command("open")
@click.option(
    "--editor", "editor_override", default=None, help="Editor command (e.g. --editor code)."
)
@click.pass_context
def config_open(ctx: click.Context, editor_override: str | None) -> None:
    """Open the config file in your editor, then re-validate."""
    path = _resolve_path(ctx)
    if not path.exists():
        raise click.ClickException(f"Config file not found: {path}")

    editor = editor_override or os.environ.get("EDITOR", os.environ.get("VISUAL"))
    if editor:
        subprocess.call([editor, str(path)])
    else:
        result = click.edit(filename=str(path))
        if result is None:
            click.echo("Editor returned no changes.")
            return

    cfg = load_config(path)
    click.echo(click.style("✓ Config is valid after editing.", fg="green"))

    if cfg.watcher_id:
        client = _make_client(cfg.environment, api_base_url=cfg.api_base_url)
        _push_config_to_api(client, cfg.watcher_id, path, trigger="open")


@config.command("path")
@click.pass_context
def config_path_cmd(ctx: click.Context) -> None:
    """Print the resolved config file path."""
    click.echo(str(_resolve_path(ctx)))


# ---------------------------------------------------------------------------
# watch command
# ---------------------------------------------------------------------------


@cli.command()
@click.option("--dry-run", is_flag=True, help="Validate and log but don't start monitoring.")
@click.pass_context
def watch(ctx: click.Context, dry_run: bool) -> None:
    """Start watching for new files."""
    cfg, client, path = _load_and_client(ctx)
    inst = cfg.instrument

    if not cfg.watcher_id:
        raise click.ClickException("No watcher_id in config. Run 'data-hub-watcher init' first.")

    # Step 1: Check instrument status
    click.echo(f"Checking instrument {inst.id}…")
    try:
        detail = client.get_instrument(inst.id)
    except ApiError as exc:
        raise click.ClickException(f"Cannot reach API: {exc.message}") from exc

    if detail.status == "pending":
        raise click.ClickException(
            f"Instrument {inst.id!r} is still pending activation. "
            "Please wait for it to be activated before starting the watcher."
        )

    # Step 2: Sync config checksum
    local_checksum = config_checksum(path)
    remote = client.get_config_checksum(cfg.watcher_id)
    if remote is None or remote.config_checksum != local_checksum:
        click.echo("Syncing config to Data Hub…")
        _push_config_to_api(client, cfg.watcher_id, path, trigger="startup")

    if dry_run:
        _dry_run_scan(cfg)
        click.echo(
            click.style(
                "\n✓ Dry run complete. Config is valid, API reachable, instrument active.",
                fg="green",
            )
        )
        return

    # Step 3: File logging
    _setup_file_logging()

    # Step 4: State DB + pruning
    db_path = DEFAULT_CONFIG_DIR / STATE_DB_FILENAME
    state_db = StateDB(db_path)
    state_db.prune_uploaded_files(PRUNE_DAYS)

    # Step 5: Core services
    counters = WatcherCounters()
    reporter = EventReporter(client, cfg.watcher_id)

    is_auto = inst.upload_mode == "auto"

    uploader = Uploader(
        client=client,
        state_db=state_db,
        event_reporter=reporter,
        counters=counters,
        instrument_id=inst.id,
        watcher_id=cfg.watcher_id,
        watch_directory=inst.watch_directory,
    )

    detector = RunDetector(
        pattern=inst.run_detection.pattern,
        instrument_id=inst.id,
        watcher_id=cfg.watcher_id,
        client=client,
        state_db=state_db,
        event_reporter=reporter,
        counters=counters,
        upload_callback=uploader.upload_files if is_auto else None,
        watch_directory=inst.watch_directory,
    )

    monitor = FileMonitor(
        watch_directory=inst.watch_directory,
        file_patterns=inst.file_patterns,
        stability_period=inst.stability_period_seconds,
        on_stable_file=detector.on_stable_file,
        state_db=state_db,
        recursive=inst.run_detection.recursive,
    )

    # In manual mode the server controls which files to upload. We piggyback
    # on the heartbeat tick to poll the server's upload queue, so uploads
    # happen at the same cadence as heartbeats without a separate timer.
    def _poll_upload_queue() -> None:
        try:
            uploader.poll_upload_queue()
        except Exception:
            logger.exception("Upload queue poll failed")

    heartbeat = HeartbeatLoop(
        client=client,
        watcher_id=cfg.watcher_id,
        interval_seconds=HEARTBEAT_INTERVAL_SECONDS,
        event_reporter=reporter,
        instrument_id=inst.id,
        watch_directory=str(inst.watch_directory),
        upload_mode=inst.upload_mode,
        counters=counters,
        on_tick=_poll_upload_queue if not is_auto else None,
    )

    reporter.queue_event(
        WatcherEvent(
            event_type=EventType.WATCHER_STARTED,
            message=f"Watcher started on {platform.node()}",
        )
    )

    # If the watcher crashed mid-session, some runs may have been detected but
    # never successfully POSTed to the API. Retry those before starting the
    # normal event loop so they aren't silently lost.
    detector.retry_unreported_runs()

    # Step 8: Start everything
    heartbeat.start()
    click.echo(f"Scanning {inst.watch_directory} for existing files…")
    monitor.start()

    click.echo(f"Watcher is running (instrument={inst.id}, dir={inst.watch_directory})…")
    click.echo("Press Ctrl+C to stop.")

    def _shutdown(signum: int, frame: Any) -> None:
        click.echo("\nShutting down…")
        monitor.stop()
        reporter.queue_event(
            WatcherEvent(
                event_type=EventType.WATCHER_STOPPED,
                message="Watcher stopped by user",
            )
        )
        heartbeat.stop()
        reporter.flush()
        state_db.close()
        raise SystemExit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    while True:
        time.sleep(1)


# ---------------------------------------------------------------------------
# upload command
# ---------------------------------------------------------------------------


@cli.command()
@click.option("--file", "file_path", type=click.Path(exists=True), help="Specific file to upload.")
@click.option("--run-id", default=None, help="Associate upload with a specific run.")
@click.option("--dry-run", is_flag=True, help="Log what would be uploaded without uploading.")
@click.pass_context
def upload(ctx: click.Context, file_path: str | None, run_id: str | None, dry_run: bool) -> None:
    """Upload files to Data Hub (manual trigger).

    One-shot mode: pass both --file and --run-id to upload a single file.
    Queue mode:    omit both to process the server-side upload queue.
    """
    if file_path and not run_id:
        raise click.ClickException("--run-id is required when --file is specified.")
    if run_id and not file_path:
        raise click.ClickException("--file is required when --run-id is specified.")

    cfg, client, path = _load_and_client(ctx)
    inst = cfg.instrument

    if not cfg.watcher_id:
        raise click.ClickException("No watcher_id in config. Run 'data-hub-watcher init' first.")

    # Check instrument status
    try:
        detail = client.get_instrument(inst.id)
    except ApiError as exc:
        raise click.ClickException(f"Cannot reach API: {exc.message}") from exc

    if detail.status == "pending":
        raise click.ClickException(f"Instrument {inst.id!r} is pending. Cannot upload yet.")

    db_path = DEFAULT_CONFIG_DIR / STATE_DB_FILENAME
    state_db = StateDB(db_path)
    counters = WatcherCounters()
    reporter = EventReporter(client, cfg.watcher_id)
    uploader = Uploader(
        client=client,
        state_db=state_db,
        event_reporter=reporter,
        counters=counters,
        instrument_id=inst.id,
        watcher_id=cfg.watcher_id,
        watch_directory=inst.watch_directory,
    )

    if file_path:
        assert run_id is not None  # guaranteed by the guard above
        fp = Path(file_path).resolve()
        s3_key_preview = f"{inst.id}/{run_id}/{fp.name}"

        if dry_run:
            click.echo(f"[dry-run] Would upload {fp}")
            click.echo(f"  → {s3_key_preview}")
            state_db.close()
            return

        click.echo(f"Uploading {fp.name}…")
        ok = uploader._upload_single(fp, run_id)
        state_db.close()
        if not ok:
            raise click.ClickException(f"Upload failed for {fp.name}")
        click.echo(click.style("✓ Upload complete.", fg="green"))
    else:
        click.echo("Fetching upload queue…")
        try:
            queue = client.get_upload_queue(cfg.watcher_id)
        except ApiError as exc:
            state_db.close()
            raise click.ClickException(f"Failed to fetch upload queue: {exc.message}") from exc

        if not queue.files:
            click.echo("Upload queue is empty.")
            state_db.close()
            return

        click.echo(f"{len(queue.files)} file(s) in queue:")
        for f in queue.files:
            click.echo(f"  • {f.filename} (run: {f.run_id}, {f.size_bytes or '?'} bytes)")

        if dry_run:
            click.echo("[dry-run] No files uploaded.")
            state_db.close()
            return

        uploader.poll_upload_queue()
        reporter.flush()
        click.echo(click.style(f"✓ Processed {len(queue.files)} file(s).", fg="green"))
        state_db.close()


# ---------------------------------------------------------------------------
# service group (Windows placeholder)
# ---------------------------------------------------------------------------


@cli.group()
def service() -> None:
    """Windows service management."""


def _windows_only() -> None:
    if sys.platform != "win32":
        click.echo("Error: Windows Service management is only available on Windows.", err=True)
        raise SystemExit(1)


@service.command("install")
@click.option(
    "--env-path",
    "env_path_override",
    type=click.Path(dir_okay=False),
    default=None,
    help="Path to the .env file. Defaults to ~/.data-hub/.env.",
)
@click.pass_context
def service_install(ctx: click.Context, env_path_override: str | None) -> None:
    """Install the watcher as a Windows service."""
    _windows_only()
    path = _resolve_path(ctx)
    load_config(path)

    from data_hub_watcher.service import install_service

    if env_path_override is not None:
        env_path = Path(env_path_override).resolve()
    else:
        from data_hub_watcher.constants import DEFAULT_CONFIG_DIR, ENV_FILENAME

        env_path = (DEFAULT_CONFIG_DIR / ENV_FILENAME).resolve()

    if not env_path.exists():
        click.echo(
            click.style(
                f"⚠ Warning: {env_path} does not exist. "
                "Run 'data-hub-watcher login' first or pass --env-path.",
                fg="yellow",
            ),
            err=True,
        )

    try:
        install_service(config_path=path.resolve(), env_path=env_path)
        click.echo(click.style("✓ Service installed.", fg="green"))
    except Exception as exc:
        raise click.ClickException(f"Failed to install service: {exc}") from exc


@service.command("uninstall")
def service_uninstall() -> None:
    """Uninstall the watcher Windows service."""
    _windows_only()

    from data_hub_watcher.service import uninstall_service

    try:
        uninstall_service()
        click.echo(click.style("✓ Service removed.", fg="green"))
    except Exception as exc:
        raise click.ClickException(f"Failed to remove service: {exc}") from exc


@service.command("start")
def service_start_cmd() -> None:
    """Start the watcher Windows service."""
    _windows_only()

    from data_hub_watcher.service import start_service

    try:
        start_service()
        click.echo(click.style("✓ Service started.", fg="green"))
    except Exception as exc:
        raise click.ClickException(f"Failed to start service: {exc}") from exc


@service.command("stop")
def service_stop_cmd() -> None:
    """Stop the watcher Windows service."""
    _windows_only()

    from data_hub_watcher.service import stop_service

    try:
        stop_service()
        click.echo(click.style("✓ Service stopped.", fg="green"))
    except Exception as exc:
        raise click.ClickException(f"Failed to stop service: {exc}") from exc


@service.command("status")
def service_status_cmd() -> None:
    """Show the watcher Windows service status."""
    _windows_only()

    from data_hub_watcher.service import query_service_status

    try:
        info = query_service_status()
        click.echo(f"Service: {info['service_name']}")
        click.echo(f"  State: {info['state']}")
        if info.get("pid"):
            click.echo(f"  PID:   {info['pid']}")
    except Exception as exc:
        raise click.ClickException(f"Failed to query service status: {exc}") from exc
