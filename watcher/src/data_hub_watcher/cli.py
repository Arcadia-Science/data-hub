from __future__ import annotations
import fnmatch
import logging
import os
import platform
import re
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

import click

from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.config_io import config_checksum, load_config, save_config
from data_hub_watcher.constants import (
    API_URLS,
    DEFAULT_CONFIG_DIR,
    DEFAULT_STABILITY_PERIOD_SECONDS,
    RUN_DETECTION_PRESETS,
    STATE_DB_FILENAME,
    SUPPORTED_ENVIRONMENTS,
    WATCHER_VERSION,
    env_file_path,
    load_env,
    resolve_config_path,
    save_api_key,
)
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import (
    InstrumentConfig,
    RunDetectionConfig,
    WatcherConfig,
)
from data_hub_watcher.runtime import (
    build_runtime,
    classify_shutdown,
    start_runtime,
    stop_runtime,
    sync_config_to_api,
)
from data_hub_watcher.self_update import (
    DEFAULT_INDEX_URL,
    InstallMethod,
    UvExecutableNotFoundError,
    _resolve_uv_executable,
    detect_install_method,
    evaluate_update,
    run_upgrade,
)
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


API_KEY_PREFIX = "dhub_"

# Invisible characters that some Windows clipboards (Outlook, Teams, Word, etc.)
# silently inject when an operator copies an API key. Stripping them here
# avoids 401s caused by a hash mismatch on the server.
_INVISIBLE_CHARS = (
    "\u00a0",  # non-breaking space
    "\u200b",  # zero-width space
    "\u200c",  # zero-width non-joiner
    "\u200d",  # zero-width joiner
    "\ufeff",  # BOM / zero-width no-break space
)


def _clean_api_key(value: str) -> str:
    """Normalize and validate an API key entered by the operator.

    Pasting into a hidden ``click.prompt`` on Windows frequently introduces
    stray whitespace (CR, LF, NBSP) or zero-width characters from rich-text
    clipboards. We strip those defensively and then verify the value still
    looks like a Data Hub PAT before any network call so the operator sees a
    clear error instead of a confusing 401.
    """
    cleaned = value
    for ch in _INVISIBLE_CHARS:
        cleaned = cleaned.replace(ch, "")
    cleaned = cleaned.strip()

    if not cleaned:
        raise click.ClickException("API key is empty.")
    if any(c.isspace() for c in cleaned):
        raise click.ClickException(
            "API key contains whitespace. Re-copy the key — your clipboard "
            "may have included a line break or non-breaking space."
        )
    if not cleaned.startswith(API_KEY_PREFIX):
        raise click.ClickException(
            f"API key must start with '{API_KEY_PREFIX}'. Re-copy the key from "
            "the Data Hub UI; the value may have been truncated on paste."
        )
    return cleaned


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
    # Overlay the env-specific file (e.g. ``.env.staging``) so the API key
    # picked up by ``DataHubClient`` always matches the configured environment.
    load_env(cfg.environment)
    client = _make_client(cfg.environment, api_base_url=cfg.api_base_url)
    return cfg, client, path


def _setup_file_logging() -> None:
    """Add a RotatingFileHandler to the root logger (``~/.data-hub/watcher.log``).

    Delegates to the shared helper in :mod:`data_hub_watcher.logging_setup`
    so the CLI ``watch`` path and the Windows-service entry point can't
    drift on log location, rotation policy, or format.
    """
    from data_hub_watcher.logging_setup import setup_file_logging

    setup_file_logging()


# ---------------------------------------------------------------------------
# init command
# ---------------------------------------------------------------------------


@cli.command()
@click.option(
    "--show-key",
    is_flag=True,
    help=(
        "Echo the API key as it is typed/pasted. Useful on Windows terminals "
        "where hidden input is unreliable for paste."
    ),
)
@click.pass_context
def init(ctx: click.Context, show_key: bool) -> None:
    """Interactive setup wizard + API registration."""
    path = _resolve_path(ctx)
    if path.exists():
        if not click.confirm(f"Config already exists at {path}. Overwrite?"):
            raise SystemExit(0)

    # 1. Environment
    environment = click.prompt(
        "Environment",
        type=click.Choice(list(SUPPORTED_ENVIRONMENTS), case_sensitive=False),
    )

    api_base_url: str | None = None
    if environment == "preview":
        raw_url: str = click.prompt(
            "Preview deployment base URL (e.g. https://data-hub-git-my-branch.vercel.app/api/v1)"
        )
        api_base_url = raw_url.rstrip("/")

    # 2. API key — overlay any existing per-environment env file so the user
    # doesn't have to re-enter a key they've already saved for this target.
    load_env(environment)
    existing_key = os.environ.get("DATA_HUB_API_KEY", "")
    env_specific_path = env_file_path(environment)
    hide_input = not show_key
    if existing_key and env_specific_path.exists():
        click.echo(f"Found saved API key for {environment} at {env_specific_path}.")
        if click.confirm("Use the saved key?", default=True):
            api_key = existing_key
        else:
            api_key = click.prompt("DATA_HUB_API_KEY", hide_input=hide_input)
    elif existing_key:
        api_key = existing_key
    else:
        api_key = click.prompt("DATA_HUB_API_KEY", hide_input=hide_input)

    api_key = _clean_api_key(api_key)

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

    env_path = save_api_key(api_key, environment)
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
        # 409 means another active watcher is already registered for this
        # instrument. Surface an actionable message pointing the operator at
        # the deregister flow rather than the raw API error text.
        if exc.status_code == 409:
            existing_id = ""
            if exc.detail and exc.detail.details:
                existing_id = str(exc.detail.details.get("existing_watcher_id") or "")
            id_suffix = f" (id: {existing_id})" if existing_id else ""
            raise click.ClickException(
                f"Instrument '{selected.id}' already has an active watcher{id_suffix}.\n"
                "If this is a replacement install, deregister the existing watcher first:\n"
                "  - In the web UI: Watchers → open the existing watcher → Deregister\n"
                f"  - Or via API: DELETE /api/v1/watchers/{existing_id or '<watcher_id>'}\n"
                "Then re-run `data-hub-watcher init`."
            ) from exc
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

    # Step 2 (dry-run only): sync config checksum without a reporter
    # so dry-run still validates the API path. The watch path defers
    # its sync until *after* build_runtime so we have a reporter to
    # surface failures via kind=config_sync_failed.
    if dry_run:
        local_checksum = config_checksum(path)
        remote = client.get_config_checksum(cfg.watcher_id)
        if remote is None or remote.config_checksum != local_checksum:
            click.echo("Syncing config to Data Hub…")
            _push_config_to_api(client, cfg.watcher_id, path, trigger="startup")

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

    # Step 4: Build the shared runtime (state DB, uploader, detector,
    # monitor, heartbeat — all wired identically to the Windows-service
    # path via data_hub_watcher.runtime).
    db_path = DEFAULT_CONFIG_DIR / STATE_DB_FILENAME
    rt = build_runtime(client=client, cfg=cfg, db_path=db_path)

    # Step 5: sync config (now that we have a reporter, failures are
    # surfaced to the dashboard as kind=config_sync_failed instead of
    # only being printed to the local console).
    click.echo("Syncing config to Data Hub…")
    sync_config_to_api(client, cfg.watcher_id, path, rt.reporter, trigger="startup")

    click.echo(f"Scanning {inst.watch_directory} for existing files…")
    start_runtime(rt, started_message=f"Watcher started on {platform.node()}")

    click.echo(f"Watcher is running (instrument={inst.id}, dir={inst.watch_directory})…")
    click.echo("Press Ctrl+C to stop.")

    def _shutdown(signum: int, frame: Any) -> None:
        click.echo("\nShutting down…")
        stop_runtime(rt, stopped_message="Watcher stopped by user")
        raise SystemExit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    # Block on the runtime's shutdown event so the in-process auto-updater
    # can request a restart from the heartbeat thread without needing a
    # signal. Ctrl+C still works because the SIGINT handler raises
    # SystemExit(0) directly out of `Event.wait` (Python interrupts the
    # blocking call to deliver the signal).
    while not rt.shutdown_event.wait(timeout=1.0):
        pass

    # Distinguish an upgrade-driven shutdown from a generic one by
    # delegating to `classify_shutdown` — the same helper used by the
    # Windows service path in `service._run_service_loop`, so the two
    # entrypoints can't drift on the WATCHER_STOPPED message text.
    decision = classify_shutdown(rt, role="Watcher")
    if decision.is_upgrade_restart:
        # Foreground `data-hub-watcher watch` doesn't have an SCM to
        # auto-restart it, so the message has to cover both audiences:
        # Windows-service operators (whose SCM picks the new wheel up
        # via the failure-actions policy on the non-zero exit below)
        # and console / macOS / Linux operators (who need to re-run
        # the command manually). The previous "restarting…" wording
        # was only accurate under the SCM.
        click.echo(
            "\nUpgrade installed. Re-run data-hub-watcher watch to load the new "
            "version (or install the service for automatic restart)."
        )
    stop_runtime(rt, stopped_message=decision.stopped_message)
    # Exit non-zero on upgrade restart so any supervisor (or the
    # operator's wrapper script) restarts us. The `data-hub-watcher
    # service` Windows path uses the SCM's failure-actions config to
    # do this automatically.
    raise SystemExit(1 if decision.is_upgrade_restart else 0)


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
# self-update command
# ---------------------------------------------------------------------------


@cli.command("self-update")
@click.option(
    "--check",
    is_flag=True,
    help="Print the server-reported target version without performing the upgrade.",
)
@click.option(
    "--force",
    is_flag=True,
    help="Run the upgrade subprocess even if the local version already matches the target.",
)
@click.pass_context
def self_update(ctx: click.Context, check: bool, force: bool) -> None:
    """Check the server for a newer watcher release and upgrade in place.

    Designed for unattended use — schedule via Windows Task Scheduler
    (e.g. weekly) so lab PCs converge on the latest published version
    without operator intervention.
    """
    cfg, client, _path = _load_and_client(ctx)
    if not cfg.watcher_id:
        raise click.ClickException("No watcher_id in config. Run 'data-hub-watcher init' first.")

    click.echo(f"Current version: {WATCHER_VERSION}")

    try:
        info = client.get_update_info(cfg.watcher_id)
    except ApiError as exc:
        raise click.ClickException(f"Failed to fetch update info: {exc.message}") from exc

    target_label = info.latest_version or "(none configured)"
    mandatory_label = " [mandatory]" if info.mandatory else ""
    click.echo(f"Server target:   {target_label} (channel={info.channel}){mandatory_label}")

    decision = evaluate_update(info, force=force)

    if check:
        verb = "Would upgrade" if decision.should_update else "No upgrade needed"
        click.echo(f"{verb}: {decision.reason}.")
        return

    if not decision.should_update:
        click.echo(f"Already up to date: {decision.reason}.")
        return

    method = detect_install_method()
    click.echo(f"Install method:  {method.value}")
    if method in (InstallMethod.EDITABLE, InstallMethod.UNKNOWN):
        raise click.ClickException(
            "Refusing to self-update an editable / unknown install. "
            "Upgrade manually with 'git pull && uv sync' from your checkout."
        )

    # Windows uv-tool installs cannot reinstall in-process: the
    # operator's own ``data-hub-watcher.exe`` shim has loaded the
    # venv's ``Scripts\\python.exe`` into the parent process, so
    # ``uv tool install --reinstall`` would fail with
    # ``Access is denied. (os error 5)`` when it tries to remove
    # ``Scripts\\``. Route through the SYSTEM-owned scheduled task
    # instead, which stops the service before invoking ``uv``.
    if sys.platform == "win32" and method is InstallMethod.UV_TOOL:
        _dispatch_self_update_via_worker(
            target_version=decision.target_version,
            current_version=decision.current_version,
        )
        return

    click.echo(f"Upgrading {decision.current_version} -> {decision.target_version}…")
    try:
        result = run_upgrade(method, target_version=decision.target_version)
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc

    if result.stdout:
        click.echo(result.stdout.rstrip())
    if result.stderr:
        click.echo(result.stderr.rstrip(), err=True)

    if result.returncode != 0:
        raise click.ClickException(
            f"Upgrade subprocess exited with code {result.returncode}. "
            "The previous installation should still be functional; review "
            "the output above and try again."
        )

    click.echo(
        click.style(
            f"\u2713 Upgrade to {decision.target_version} complete. "
            "Restart the watcher (or the Windows service) to load the new code.",
            fg="green",
        )
    )


def _dispatch_self_update_via_worker(
    *,
    target_version: str | None,
    current_version: str,
) -> None:
    """Trigger the SYSTEM-owned upgrade worker on Windows uv-tool installs.

    Writes the request sentinel + on-disk marker (so the post-restart
    event evaluation has something to merge) and asks Task Scheduler
    to run the worker. The CLI then exits — the worker stops the
    service, runs ``uv``, drops a result sentinel, and starts the
    service again. The operator watches via ``data-hub-watcher
    service status`` or by tailing
    ``~/.data-hub/upgrade-worker.log``.

    Pre-flight failures (no ``uv`` on disk, no scheduled task
    registered) raise :class:`click.ClickException` with an
    actionable next step rather than silently returning success.
    """
    from data_hub_watcher.scheduled_task import (
        ScheduledTaskError,
        task_exists,
        trigger_upgrade_task,
    )
    from data_hub_watcher.updater import write_upgrade_marker
    from data_hub_watcher.upgrade_worker import (
        build_pkg_spec,
        clear_upgrade_request,
        clear_upgrade_result,
        detect_installed_extras,
        upgrade_worker_log_path,
        write_upgrade_request,
    )

    if target_version is None:  # pragma: no cover - guarded upstream
        raise click.ClickException("No target version available for upgrade dispatch.")

    try:
        uv_path, candidates = _resolve_uv_executable()
    except UvExecutableNotFoundError as exc:  # pragma: no cover - defensive
        raise click.ClickException(str(exc)) from exc
    if uv_path is None:
        raise click.ClickException(
            "Could not locate `uv` executable for the upgrade worker. "
            "Install uv for the service account or pin a known path. "
            f"Probed: {', '.join(candidates) if candidates else '(none)'}."
        )

    if not task_exists():
        # Most likely cause: this PC was upgraded into worker-aware
        # code from auto-update without re-running ``service install``.
        raise click.ClickException(
            "Upgrade scheduled task 'DataHubWatcherUpgrade' is not registered. "
            "Run 'data-hub-watcher service reinstall' as Administrator (or "
            "'data-hub-watcher service install' if no service is currently "
            "registered) and then retry 'data-hub-watcher self-update'."
        )

    extras = detect_installed_extras()
    pkg_spec = build_pkg_spec(InstallMethod.UV_TOOL, target_version=target_version, extras=extras)

    # Defensively clear any stale result sentinel from a prior
    # upgrade so the post-restart evaluation can't misattribute an
    # old result to this dispatch.
    clear_upgrade_result(DEFAULT_CONFIG_DIR)

    write_upgrade_marker(
        DEFAULT_CONFIG_DIR,
        target_version=target_version,
        previous_version=current_version,
    )
    req = write_upgrade_request(
        DEFAULT_CONFIG_DIR,
        target_version=target_version,
        pkg_spec=pkg_spec,
        uv_executable=uv_path,
        index_url=DEFAULT_INDEX_URL,
        previous_version=current_version,
        install_method=InstallMethod.UV_TOOL.value,
    )

    click.echo(
        f"Dispatching upgrade {current_version} -> {target_version} via worker "
        f"(request_id={req.request_id})..."
    )
    try:
        trigger_upgrade_task()
    except ScheduledTaskError as exc:
        # Roll back the sentinels so a follow-up retry doesn't see a
        # stale request lying around.
        from data_hub_watcher.updater import clear_upgrade_marker

        clear_upgrade_marker(DEFAULT_CONFIG_DIR)
        clear_upgrade_request(DEFAULT_CONFIG_DIR)
        raise click.ClickException(
            f"Could not trigger the upgrade scheduled task: {exc}. "
            "Run 'data-hub-watcher service reinstall' as Administrator and retry."
        ) from exc

    click.echo(
        click.style(
            f"\u2713 Upgrade dispatched. The service will stop, install "
            f"{target_version}, and restart automatically.",
            fg="green",
        )
    )
    click.echo(
        f"  Watch: data-hub-watcher service status\n"
        f"  Tail:  {upgrade_worker_log_path(DEFAULT_CONFIG_DIR)}"
    )


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
    help="Path to the .env file. Defaults to ~/.data-hub/.env.<environment>.",
)
@click.pass_context
def service_install(ctx: click.Context, env_path_override: str | None) -> None:
    """Install the watcher as a Windows service."""
    _windows_only()
    path = _resolve_path(ctx)
    cfg = load_config(path)

    from data_hub_watcher.service import install_service

    if env_path_override is not None:
        env_path = Path(env_path_override).resolve()
    else:
        env_path = env_file_path(cfg.environment).resolve()

    if not env_path.exists():
        click.echo(
            click.style(
                f"⚠ Warning: {env_path} does not exist. "
                "Run 'data-hub-watcher init' first or pass --env-path.",
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


@service.command("reinstall")
@click.option(
    "--env-path",
    "env_path_override",
    type=click.Path(dir_okay=False),
    default=None,
    help="Path to the .env file. Defaults to ~/.data-hub/.env.<environment>.",
)
@click.pass_context
def service_reinstall(ctx: click.Context, env_path_override: str | None) -> None:
    """Stop, uninstall, install, and start the watcher Windows service.

    Useful after upgrading the watcher wheel from an Administrator shell so
    the SCM picks up the new ``data_hub_watcher.service`` entrypoint without
    needing four separate ``service`` invocations.
    """
    _windows_only()
    path = _resolve_path(ctx)
    cfg = load_config(path)

    from data_hub_watcher.service import (
        install_service,
        start_service,
        stop_service,
        uninstall_service,
        wait_for_service_removed,
    )

    if env_path_override is not None:
        env_path = Path(env_path_override).resolve()
    else:
        env_path = env_file_path(cfg.environment).resolve()

    if not env_path.exists():
        click.echo(
            click.style(
                f"⚠ Warning: {env_path} does not exist. "
                "Run 'data-hub-watcher init' first or pass --env-path.",
                fg="yellow",
            ),
            err=True,
        )

    # Stop and uninstall are best-effort: a fresh install (or a half-uninstalled
    # service) shouldn't block the reinstall from progressing to install+start.
    # ``uninstall_service`` already swallows StopService errors internally, but
    # we still call ``stop_service`` first so the operator gets a clear log
    # line about which step succeeded.
    try:
        stop_service()
        click.echo(click.style("✓ Service stopped.", fg="green"))
    except Exception as exc:
        click.echo(f"  (stop skipped: {exc})")

    try:
        uninstall_service()
        click.echo(click.style("✓ Service uninstalled.", fg="green"))
    except Exception as exc:
        click.echo(f"  (uninstall skipped: {exc})")

    # ``RemoveService`` only marks the service for deletion; the SCM
    # finalises the delete asynchronously once every open handle is
    # closed. Polling here turns the otherwise inscrutable
    # ``(1072, 'CreateService', 'The specified service has been marked
    # for deletion.')`` error into either (a) a transparent retry that
    # succeeds within a few seconds in the common case, or (b) a clear,
    # actionable message when something is genuinely holding a handle.
    if not wait_for_service_removed(timeout_seconds=30.0):
        raise click.ClickException(
            "Service is still marked for deletion after 30 s. Close any open "
            "Services consoles (services.msc), Event Viewer windows, or "
            "Task Manager 'Services' tabs, then re-run "
            "'data-hub-watcher service install && data-hub-watcher service start'. "
            "If that doesn't help, reboot to force-clear the SCM handle."
        )

    try:
        install_service(config_path=path.resolve(), env_path=env_path)
        click.echo(click.style("✓ Service installed.", fg="green"))
    except Exception as exc:
        raise click.ClickException(f"Failed to install service: {exc}") from exc

    try:
        start_service()
        click.echo(click.style("✓ Service started.", fg="green"))
    except Exception as exc:
        raise click.ClickException(f"Failed to start service: {exc}") from exc
