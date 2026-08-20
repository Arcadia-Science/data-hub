"""Type → processor registry for Lambda file dispatch.

One `instrument_type` maps to one vendor-specific processor. Types that
sound generic (`qpcr`, `plate_reader`, `gel_doc`, `tape_station`, `fplc`)
still bind to a single vendor's output format — adding a second vendor
requires splitting the type, not reusing it.
"""

from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass

from data_hub_lambda import (
    agilent_4150_tapestation,
    akta_fplc,
    azure_600_gel_doc,
    azure_cielo_qpcr,
    dishcam,
    epson_v700_scanner,
    hina_microscope,
    spectramax_plate_reader,
)
from data_hub_lambda.dishcam.filenames import matches_filename as _is_dishcam_input

ProcessFileFn = Callable[[str, str, str], None]


@dataclass(frozen=True)
class ProcessorEntry:
    """A processor and the filename gate that selects it for S3 events."""

    process_file: ProcessFileFn
    matches_filename: Callable[[str], bool]


def _ends_with_any(*suffixes: str) -> Callable[[str], bool]:
    lowers = tuple(s.lower() for s in suffixes)

    def _match(filename: str) -> bool:
        name = filename.lower()
        return any(name.endswith(s) for s in lowers)

    return _match


PROCESSORS: dict[str, ProcessorEntry] = {
    "qpcr": ProcessorEntry(
        process_file=azure_cielo_qpcr.process_file,
        matches_filename=_ends_with_any("_cq values.csv"),
    ),
    "plate_reader": ProcessorEntry(
        process_file=spectramax_plate_reader.process_file,
        matches_filename=_ends_with_any(".xls"),
    ),
    "gel_doc": ProcessorEntry(
        process_file=azure_600_gel_doc.process_file,
        matches_filename=_ends_with_any(".tif", ".tiff"),
    ),
    "tape_station": ProcessorEntry(
        process_file=agilent_4150_tapestation.process_file,
        matches_filename=_ends_with_any(".pdf"),
    ),
    "hina_microscope": ProcessorEntry(
        process_file=hina_microscope.process_file,
        matches_filename=_ends_with_any(".nd2"),
    ),
    "epson_v700_scanner": ProcessorEntry(
        process_file=epson_v700_scanner.process_file,
        matches_filename=_ends_with_any(".tif", ".tiff"),
    ),
    "fplc": ProcessorEntry(
        process_file=akta_fplc.process_file,
        matches_filename=_ends_with_any(".pdf"),
    ),
    "dishcam": ProcessorEntry(
        process_file=dishcam.process_file,
        matches_filename=_is_dishcam_input,
    ),
}


def matches_any_processor_gate(filename: str) -> bool:
    """True if *filename* passes at least one processor's filename gate."""
    return any(entry.matches_filename(filename) for entry in PROCESSORS.values())


def get_processor(instrument_type: str) -> ProcessorEntry | None:
    """Return the registry entry for *instrument_type*, or None if unmapped."""
    return PROCESSORS.get(instrument_type)
