"""CLI for locally running instrument file processing without S3 or API access."""

from __future__ import annotations
import json
import shutil
from pathlib import Path

import click


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

    colony_masks: list | None = None
    if detect_colonies:
        from data_hub_lambda.epson_v700_scanner.colony_detection import (
            detect_colonies as run_colony_detection,
        )
        from data_hub_lambda.epson_v700_scanner.colony_detection import (
            export_colony_csv,
        )

        processor.detect_plates()
        plate_crops = processor.crop_plates()
        if not plate_crops:
            click.echo("No plates detected — skipping colony detection.")
        else:
            dpi = processor.dpi
            colony_masks = []
            dataframes = []
            for i, crop in enumerate(plate_crops):
                result = run_colony_detection(crop, dpi=dpi)
                colony_masks.append(result.mask)
                click.echo(f"\nPlate {i + 1}:")
                click.echo(json.dumps(result.summary(), indent=2))
                dataframes.append(result.to_dataframe(plate_index=i + 1))

            dest_dir = output_dir or file.parent
            dest_dir.mkdir(parents=True, exist_ok=True)
            csv_path = dest_dir / f"{file.stem}_colonies.csv"
            export_colony_csv(dataframes, csv_path)
            click.echo(f"\nColony CSV: {csv_path}")

    jpg_path = processor.export_jpg(colony_masks=colony_masks)

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
