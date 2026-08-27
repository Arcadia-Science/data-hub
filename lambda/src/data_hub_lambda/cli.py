"""CLI for locally running instrument file processing without S3 or API access."""

from __future__ import annotations
import json
import os
import shutil
from pathlib import Path

import click

# Repo root: ``cli.py`` lives at ``<repo>/lambda/src/data_hub_lambda/cli.py``,
# so four ``parents`` levels up land on the repo root. Used as the default
# anchor for ``--mirror-root`` so devs don't have to type a path on every
# ``handler`` invocation.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_DEFAULT_MIRROR_ROOT = _REPO_ROOT / "lambda" / ".local-s3"


@click.group()
def cli() -> None:
    """Locally run instrument-specific file parsing and processing."""


# ---------------------------------------------------------------------------
# Azure 600 Gel Doc
# ---------------------------------------------------------------------------


@cli.command("gel-doc")
@click.argument("file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option(
    "--output-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help="Directory for the exported PNG (default: same directory as FILE).",
)
def gel_doc(file: Path, output_dir: Path | None) -> None:
    """Process an Azure 600 Gel Doc TIFF file.

    Runs the contrast-enhancement pipeline to produce a PNG and extracts
    imaging metadata from the TIFF XPComment tag.
    """
    from data_hub_lambda.azure_600_gel_doc.image_processing import TIFFProcessor
    from data_hub_lambda.azure_600_gel_doc.parse_metadata import parse_metadata

    processor = TIFFProcessor(file)
    processor.load()
    png_path = processor.export_figure()

    if output_dir is not None:
        output_dir.mkdir(parents=True, exist_ok=True)
        dest = output_dir / png_path.name
        shutil.move(str(png_path), str(dest))
        png_path = dest

    click.echo(f"Exported PNG: {png_path}")

    metadata = parse_metadata(file)
    click.echo(json.dumps(metadata, indent=2))


# ---------------------------------------------------------------------------
# Hina microscope (Nikon ND2)
# ---------------------------------------------------------------------------


@cli.command("hina")
@click.argument("file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option(
    "--output-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help="Directory for the exported JPG (default: same directory as FILE).",
)
def hina(file: Path, output_dir: Path | None) -> None:
    """Convert a Hina microscope ND2 file to a JPG overlay.

    Loads the ND2 via `arcadia-microscopy-tools`, produces a composite
    JPG overlay (per-channel percentile-stretched intensities blended onto
    a brightfield/zero background using each channel's native color), and
    prints the parsed run-level metadata.
    """
    from data_hub_lambda.hina_microscope.image_processing import ND2Processor
    from data_hub_lambda.hina_microscope.parse_metadata import parse_metadata

    processor = ND2Processor(file)
    processor.load()
    jpg_path = processor.export_jpg()

    if output_dir is not None:
        output_dir.mkdir(parents=True, exist_ok=True)
        dest = output_dir / jpg_path.name
        shutil.move(str(jpg_path), str(dest))
        jpg_path = dest

    click.echo(f"Exported JPG: {jpg_path}")

    metadata = parse_metadata(processor.image)
    click.echo(json.dumps(metadata, indent=2))


# ---------------------------------------------------------------------------
# Epson V700 Scanner
# ---------------------------------------------------------------------------


@cli.command("epson-scanner")
@click.argument("file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option(
    "--output-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help="Directory for the exported JPG (default: same directory as FILE).",
)
@click.option(
    "--detect-colonies",
    is_flag=True,
    default=False,
    help="Run colony detection and phenotyping on each detected plate.",
)
def epson_scanner(file: Path, output_dir: Path | None, detect_colonies: bool) -> None:
    """Process an Epson V700 Scanner TIFF file.

    Detects agar plates inside gold frames, draws bounding-box overlays,
    resizes to a web-friendly JPEG preview, and extracts TIFF metadata.
    """
    from data_hub_lambda.epson_v700_scanner.image_processing import TiffProcessor

    processor = TiffProcessor(file)
    processor.load()

    pipeline = None
    if detect_colonies:
        from data_hub_lambda.epson_v700_scanner.colony_detection import (
            export_colony_csv,
            run_colony_pipeline,
        )

        processor.detect_plates()
        plate_crops = processor.crop_plates()
        if not plate_crops:
            click.echo("No plates detected — skipping colony detection.")
        else:
            pipeline = run_colony_pipeline(plate_crops, dpi=processor.dpi)
            for i, result in enumerate(pipeline.results):
                click.echo(f"\nPlate {i + 1}:")
                click.echo(json.dumps(result.summary(), indent=2))

            dest_dir = output_dir or file.parent
            dest_dir.mkdir(parents=True, exist_ok=True)
            csv_path = dest_dir / f"{file.stem}_colonies.csv"
            export_colony_csv(pipeline.to_dataframes(), csv_path)
            click.echo(f"\nColony CSV: {csv_path}")

    jpg_path = processor.export_jpg(
        colony_results=pipeline.results if pipeline else None,
    )

    if output_dir is not None:
        output_dir.mkdir(parents=True, exist_ok=True)
        dest = output_dir / jpg_path.name
        shutil.move(str(jpg_path), str(dest))
        jpg_path = dest

    click.echo(f"Exported JPG: {jpg_path}")

    metadata = processor.parse_metadata()
    click.echo(json.dumps(metadata, indent=2))


# ---------------------------------------------------------------------------
# Azure Cielo qPCR
# ---------------------------------------------------------------------------


@cli.command("qpcr")
@click.argument("file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
def qpcr(file: Path) -> None:
    """Parse dye channels from an Azure Cielo qPCR Cq Values CSV."""
    from data_hub_lambda.azure_cielo_qpcr.parse_dye_channels import parse_dye_channels

    channels = parse_dye_channels(file)
    click.echo(json.dumps(channels, indent=2))


# ---------------------------------------------------------------------------
# SpectraMax plate reader
# ---------------------------------------------------------------------------


@cli.command("spectramax")
@click.argument("file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
def spectramax(file: Path) -> None:
    """Parse metadata and raw well data from a SpectraMax .xls export."""
    from data_hub_lambda.spectramax_plate_reader.utils import (
        parse_metadata,
        parse_raw_well_data,
    )

    metadata = parse_metadata(file)
    click.echo(json.dumps(metadata, indent=2))

    well_data = parse_raw_well_data(file)
    click.echo(f"\n{len(well_data)} well data rows:")
    click.echo(well_data.to_string())


# ---------------------------------------------------------------------------
# Agilent 4150 TapeStation
# ---------------------------------------------------------------------------


@cli.command("tapestation")
@click.argument("filename")
def tapestation(filename: str) -> None:
    """Extract the tape type from a TapeStation CSV filename.

    FILENAME is the bare filename string (e.g.
    '2026-02-18 - 18-00-04-gDNA_peakTable.csv'), not a file path.
    """
    from data_hub_lambda.agilent_4150_tapestation.utils import parse_tape_type

    tape_type = parse_tape_type(filename)
    if tape_type:
        click.echo(f"Tape type: {tape_type}")
    else:
        click.echo("No tape type found in filename.")


# ---------------------------------------------------------------------------
# DishCam
# ---------------------------------------------------------------------------


@cli.command("dishcam")
@click.argument("tiff", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option(
    "--run-json",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="Sidecar run.json (fps / frame count).",
)
@click.option(
    "--output-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help="Directory for the MP4 and JPEG poster (default: same directory as TIFF).",
)
def dishcam_cmd(tiff: Path, run_json: Path, output_dir: Path | None) -> None:
    """Convert a DishCam TIFF stack to an MP4 preview and JPEG poster."""
    from data_hub_lambda.dishcam.encode_video import encode_tiff_stack
    from data_hub_lambda.dishcam.parse_metadata import (
        encode_fps,
        parse_run_json,
        playback_fps,
    )

    metadata = parse_run_json(run_json)
    fps = playback_fps(encode_fps(metadata))
    dest_dir = output_dir or tiff.parent
    dest_dir.mkdir(parents=True, exist_ok=True)
    mp4_path = dest_dir / f"{tiff.stem}.mp4"
    poster_path = dest_dir / f"{tiff.stem}.jpg"
    encode_tiff_stack(tiff, mp4_path, poster_path, fps)
    click.echo(f"Exported MP4: {mp4_path}")
    click.echo(f"Exported JPEG: {poster_path}")
    click.echo(json.dumps(metadata, indent=2))


# ---------------------------------------------------------------------------
# Unchained Labs Aunty
# ---------------------------------------------------------------------------


@cli.command("aunty")
@click.argument("file", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option(
    "--output-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help="Directory for the curves CSV and plate JSON (default: same directory as FILE).",
)
def aunty(file: Path, output_dir: Path | None) -> None:
    """Parse an Aunty .xlsx export into a curves CSV and a plate JSON."""
    from data_hub_lambda.unchained_labs_aunty.utils import (
        parse_aunty_workbook,
        write_curves_csv,
        write_plate_json,
    )

    parsed = parse_aunty_workbook(file)
    dest_dir = output_dir or file.parent
    dest_dir.mkdir(parents=True, exist_ok=True)
    csv_path = dest_dir / f"{file.stem}_aunty_curves.csv"
    json_path = dest_dir / f"{file.stem}_aunty_plate.json"
    write_curves_csv(csv_path, parsed.curve_rows)
    write_plate_json(json_path, parsed.experiments)

    click.echo(f"Experiments: {len(parsed.experiments)}")
    click.echo(f"Curve rows: {len(parsed.curve_rows)}")
    click.echo(f"Curves CSV: {csv_path}")
    click.echo(f"Plate JSON: {json_path}")
    click.echo(json.dumps(parsed.metadata, indent=2))


# ---------------------------------------------------------------------------
# End-to-end handler invocation against a local S3 mirror
# ---------------------------------------------------------------------------


def _reset_config_singletons() -> None:
    """Re-initialize shared/lambda config and drop the cached API client.

    Mirrors ``lambda/tests/integration/conftest.py``: callers mutate
    process env vars (bucket names, API URL) and then need the long-lived
    ``config`` / ``lambda_config`` singletons to re-read them. Replacing
    the objects would break ``from … import config`` consumers, so we
    re-run ``__init__`` in place instead.
    """
    import data_hub_lambda.api_client as _api_mod
    import data_hub_lambda.config as _lcfg_mod
    import data_hub_shared.config as _scfg_mod

    _api_mod._client = None
    _scfg_mod.config.__init__()  # type: ignore[misc]
    _lcfg_mod.lambda_config.__init__()  # type: ignore[misc]


@cli.command("handler")
@click.argument("instrument_id")
@click.argument("run_id")
@click.argument("filename")
@click.option(
    "--source",
    "source",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="Local file to stage into the mirror as the 'uploaded' raw file.",
)
@click.option(
    "--mirror-root",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help=(
        "Directory that mirrors S3 (defaults to <repo>/lambda/.local-s3 "
        "or $LOCAL_S3_MIRROR if set)."
    ),
)
@click.option(
    "--raw-bucket",
    default="test-raw-data-bucket",
    show_default=True,
    help="Bucket name used for the staged raw file and the synthesized S3 event.",
)
@click.option(
    "--processed-bucket",
    default="test-processed-data-bucket",
    show_default=True,
    help="Bucket name used by `upload_file` for processed artifacts.",
)
def handler(
    instrument_id: str,
    run_id: str,
    filename: str,
    source: Path,
    mirror_root: Path | None,
    raw_bucket: str,
    processed_bucket: str,
) -> None:
    """Run `lambda_handler` end-to-end against a local S3 mirror.

    Stages SOURCE at <mirror>/<raw-bucket>/<instrument-id>/<run-id>/<filename>,
    monkey-patches `s3_utils.download_file` / `upload_file` to copy from/to
    the mirror, and invokes `lambda_handler` with a synthesized S3 event so
    the per-instrument `process_file` runs against the local web app.

    Requires `DATA_HUB_API_URL` and `DATA_HUB_API_KEY` to be set so the
    inner `DataHubClient` can hit the dev API (typically
    `http://localhost:3000/api/v1` plus a PAT printed by `npm run db:seed`).
    """
    from urllib.parse import quote_plus

    from data_hub_lambda.handler import lambda_handler
    from data_hub_lambda.local_s3_mirror import make_mock_context, patched_s3

    # Instrument existence / type is resolved by the handler via the API —
    # an unknown ID no-ops there rather than failing CLI argument validation.

    for var in ("DATA_HUB_API_URL", "DATA_HUB_API_KEY"):
        if not os.environ.get(var):
            raise click.UsageError(
                f"{var} is not set. Point it at the local dev API "
                "(e.g. http://localhost:3000/api/v1) and the seeded PAT "
                "printed by `npm run db:seed`."
            )

    if mirror_root is None:
        env_root = os.environ.get("LOCAL_S3_MIRROR")
        mirror_root = Path(env_root) if env_root else _DEFAULT_MIRROR_ROOT
    mirror_root = mirror_root.resolve()

    staged = mirror_root / raw_bucket / instrument_id / run_id / filename
    staged.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, staged)
    click.echo(f"Staged {source} -> {staged}")

    os.environ["AWS_S3_RAW_DATA_BUCKET"] = raw_bucket
    os.environ["AWS_S3_PROCESSED_DATA_BUCKET"] = processed_bucket
    _reset_config_singletons()

    # Real S3 events form-encode the object key (spaces -> '+', '+' -> '%2B'),
    # which the handler decodes with `unquote_plus`. Match that here so a
    # `filename` containing spaces or '+' round-trips the same as production.
    s3_key = f"{instrument_id}/{run_id}/{filename}"
    event = {
        "Records": [
            {
                "eventVersion": "2.1",
                "eventSource": "aws:s3",
                "awsRegion": "us-east-1",
                "eventName": "ObjectCreated:Put",
                "s3": {
                    "bucket": {"name": raw_bucket},
                    "object": {
                        "key": quote_plus(s3_key, safe="/"),
                        "size": staged.stat().st_size,
                    },
                },
            }
        ]
    }

    click.echo(f"Invoking lambda_handler for s3://{raw_bucket}/{s3_key}")
    with patched_s3(mirror_root):
        lambda_handler(event, make_mock_context())  # type: ignore[arg-type]

    click.echo("")
    click.echo("Done. Inspect the result in the dev UI:")
    click.echo(f"  http://localhost:3000/instruments/{instrument_id}/runs/{run_id}")
    click.echo(f"Mirror root: {mirror_root}")
