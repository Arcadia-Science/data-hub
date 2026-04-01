from __future__ import annotations
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
    DEFAULT_PREFIX_PATTERN,
    DEFAULT_STABILITY_PERIOD_SECONDS,
    HEARTBEAT_INTERVAL_SECONDS,
    S3_BUCKET_TEMPLATE,
    resolve_config_path,
)
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import HeartbeatLoop, WatcherCounters
from data_hub_watcher.models import (
    InstrumentConfig,
    RunDetectionConfig,
    WatcherConfig,
)

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


def _make_client(environment: str, api_key: str | None = None) -> DataHubClient:
    base_url = API_URLS[environment]
    return DataHubClient(base_url, api_key=api_key)


def _load_and_client(ctx: click.Context) -> tuple[WatcherConfig, DataHubClient, Path]:
    """Load config and build a matching API client. Returns (config, client, path)."""
    path = _resolve_path(ctx)
    cfg = load_config(path)
    client = _make_client(cfg.environment)
    return cfg, client, path


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
        type=click.Choice(["staging", "production"], case_sensitive=False),
    )

    # 2. API key
    api_key = os.environ.get("DATA_HUB_API_KEY", "")
    if not api_key:
        api_key = click.prompt("DATA_HUB_API_KEY", hide_input=True)

    client = _make_client(environment, api_key=api_key)

    # 3. Instruments
    click.echo("\nFetching instruments…")
    try:
        instruments = client.list_instruments()
    except ApiError as exc:
        raise click.ClickException(f"Failed to fetch instruments: {exc.message}") from exc

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

    # 6. Run detection
    method = click.prompt(
        "Run detection method",
        type=click.Choice(["prefix", "directory"], case_sensitive=False),
        default="prefix",
    )

    prefix_pattern: str | None = None
    if method == "prefix":
        prefix_pattern = click.prompt("Prefix pattern (regex)", default=DEFAULT_PREFIX_PATTERN)
        _preview_prefix_pattern(prefix_pattern or DEFAULT_PREFIX_PATTERN, watch_dir)

    # 7. Stability period
    stability = click.prompt(
        "Stability period (seconds)",
        type=click.IntRange(1, 300),
        default=DEFAULT_STABILITY_PERIOD_SECONDS,
    )

    # 8. Upload mode
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
        watcher_id=watcher_id,
        instrument=InstrumentConfig(
            id=selected.id,
            watch_directory=watch_dir,
            file_patterns=file_patterns,
            upload_mode=upload_mode,
            stability_period_seconds=stability,
            run_detection=RunDetectionConfig(
                method=method,
                prefix_pattern=prefix_pattern,
            ),
        ),
    )

    save_config(config, path)
    click.echo(f"Config saved to {path}")

    # 11. Push config to API
    _push_config_to_api(client, watcher_id, path)

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


def _preview_prefix_pattern(pattern: str, directory: Path) -> None:
    """Show sample matches for the prefix pattern."""
    try:
        compiled = re.compile(pattern)
    except re.error:
        click.echo(click.style("  Warning: invalid regex, skipping preview.", fg="yellow"))
        return

    samples: list[str] = []
    try:
        for entry in sorted(directory.iterdir())[:20]:
            if entry.is_file():
                m = compiled.match(entry.name)
                if m and m.group(1):
                    samples.append(f"    {entry.name} → run: {m.group(1)}")
    except PermissionError:
        pass

    if samples:
        click.echo("  Prefix pattern preview:")
        for s in samples[:10]:
            click.echo(s)
    else:
        click.echo("  (no matching files found for preview)")


def _push_config_to_api(client: DataHubClient, watcher_id: str, path: Path) -> None:
    """Push config YAML and checksum to the API."""
    try:
        yaml_content = path.read_text(encoding="utf-8")
        checksum = config_checksum(path)
        client.push_config(watcher_id, yaml_content, checksum)
        click.echo("Config synced to Data Hub.")
    except ApiError as exc:
        click.echo(
            click.style(f"Warning: could not sync config to API: {exc.message}", fg="yellow")
        )


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
    click.echo(f"  Watcher ID:  {cfg.watcher_id or '(not registered)'}")
    click.echo("  Instrument:")
    click.echo(f"    ID:              {inst.id}")
    click.echo(f"    Watch directory: {inst.watch_directory}")
    click.echo(f"    File patterns:   {', '.join(inst.file_patterns)}")
    click.echo(f"    Enabled:         {inst.enabled}")
    click.echo(f"    Upload mode:     {inst.upload_mode}")
    click.echo(f"    Stability (s):   {inst.stability_period_seconds}")
    click.echo(f"    Run detection:   {inst.run_detection.method}")
    if inst.run_detection.prefix_pattern:
        click.echo(f"    Prefix pattern:  {inst.run_detection.prefix_pattern}")


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

    method = click.prompt(
        "Run detection method",
        type=click.Choice(["prefix", "directory"], case_sensitive=False),
        default=inst.run_detection.method,
    )

    prefix_pattern: str | None = inst.run_detection.prefix_pattern
    if method == "prefix":
        prefix_pattern = click.prompt(
            "Prefix pattern",
            default=prefix_pattern or DEFAULT_PREFIX_PATTERN,
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
        watcher_id=cfg.watcher_id,
        instrument=InstrumentConfig(
            id=inst.id,
            watch_directory=watch_dir,
            file_patterns=file_patterns,
            enabled=enabled,
            upload_mode=upload_mode,
            stability_period_seconds=stability,
            run_detection=RunDetectionConfig(method=method, prefix_pattern=prefix_pattern),
        ),
    )

    save_config(new_config, path)
    click.echo(f"Config saved to {path}")

    if cfg.watcher_id:
        client = _make_client(cfg.environment)
        _push_config_to_api(client, cfg.watcher_id, path)


@config.command("open")
@click.pass_context
def config_open(ctx: click.Context) -> None:
    """Open the config file in your editor, then re-validate."""
    path = _resolve_path(ctx)
    if not path.exists():
        raise click.ClickException(f"Config file not found: {path}")

    editor = os.environ.get("EDITOR", os.environ.get("VISUAL"))
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
        client = _make_client(cfg.environment)
        _push_config_to_api(client, cfg.watcher_id, path)


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
        _push_config_to_api(client, cfg.watcher_id, path)

    if dry_run:
        click.echo(
            click.style(
                "✓ Dry run complete. Config is valid, API reachable, instrument active.",
                fg="green",
            )
        )
        return

    # Step 3: Start heartbeat + event reporter
    counters = WatcherCounters()
    reporter = EventReporter(client, cfg.watcher_id)
    heartbeat = HeartbeatLoop(
        client=client,
        watcher_id=cfg.watcher_id,
        interval_seconds=HEARTBEAT_INTERVAL_SECONDS,
        event_reporter=reporter,
        counters=counters,
    )

    reporter.queue_event(
        WatcherEvent(
            event_type=EventType.WATCHER_STARTED,
            message=f"Watcher started on {platform.node()}",
        )
    )

    heartbeat.start()
    click.echo(f"Watcher is running (instrument={inst.id}, dir={inst.watch_directory})…")
    click.echo("Press Ctrl+C to stop.")

    # Placeholder: file monitoring loop (FILE_MONITORING.md scope)
    def _shutdown(signum: int, frame: Any) -> None:
        click.echo("\nShutting down…")
        reporter.queue_event(
            WatcherEvent(
                event_type=EventType.WATCHER_STOPPED,
                message="Watcher stopped by user",
            )
        )
        heartbeat.stop()
        reporter.flush()
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
    """Upload files to Data Hub (manual trigger)."""
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

    environment = cfg.environment
    s3_bucket = S3_BUCKET_TEMPLATE.format(environment=environment)

    if file_path:
        fp = Path(file_path).resolve()
        if fp.is_relative_to(inst.watch_directory):
            rel = fp.relative_to(inst.watch_directory)
        else:
            rel = Path(fp.name)
        s3_key = f"{inst.id}/{run_id or 'unassigned'}/{rel}"

        if dry_run:
            click.echo(f"[dry-run] Would upload {fp}")
            click.echo(f"  → s3://{s3_bucket}/{s3_key}")
            return

        # Actual upload deferred to UPLOAD.md scope
        click.echo("Upload logic not yet implemented (UPLOAD.md scope).")
        click.echo(f"  File:   {fp}")
        click.echo(f"  Bucket: {s3_bucket}")
        click.echo(f"  Key:    {s3_key}")
    else:
        # Queue-based upload
        click.echo("Fetching upload queue…")
        try:
            queue = client.get_upload_queue(cfg.watcher_id)
        except ApiError as exc:
            raise click.ClickException(f"Failed to fetch upload queue: {exc.message}") from exc

        if not queue.files:
            click.echo("Upload queue is empty.")
            return

        click.echo(f"{len(queue.files)} file(s) in queue:")
        for f in queue.files:
            click.echo(f"  • {f.filename} (run: {f.run_id}, {f.size_bytes or '?'} bytes)")

        if dry_run:
            click.echo("[dry-run] No files uploaded.")
            return

        click.echo("Upload logic not yet implemented (UPLOAD.md scope).")


# ---------------------------------------------------------------------------
# service group (Windows placeholder)
# ---------------------------------------------------------------------------


@cli.group()
def service() -> None:
    """Windows service management."""


def _windows_only() -> None:
    if sys.platform != "win32":
        click.echo("Windows Service management is only available on Windows.")
        raise SystemExit(0)


@service.command("install")
def service_install() -> None:
    """Install the watcher as a Windows service."""
    _windows_only()
    click.echo("Service install not yet implemented (WINDOWS_SERVICE.md scope).")


@service.command("uninstall")
def service_uninstall() -> None:
    """Uninstall the watcher Windows service."""
    _windows_only()
    click.echo("Service uninstall not yet implemented (WINDOWS_SERVICE.md scope).")


@service.command("start")
def service_start() -> None:
    """Start the watcher Windows service."""
    _windows_only()
    click.echo("Service start not yet implemented (WINDOWS_SERVICE.md scope).")


@service.command("stop")
def service_stop() -> None:
    """Stop the watcher Windows service."""
    _windows_only()
    click.echo("Service stop not yet implemented (WINDOWS_SERVICE.md scope).")


@service.command("status")
def service_status() -> None:
    """Show the watcher Windows service status."""
    _windows_only()
    click.echo("Service status not yet implemented (WINDOWS_SERVICE.md scope).")
