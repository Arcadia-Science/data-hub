import re

from data_hub_utils.aws import s3_utils
from data_hub_utils.config import config
from data_hub_utils.constants import INSTRUMENT_ID_TO_NAME_MAP
from data_hub_utils.enums import Instrument
from data_hub_utils.ganymede import api as ganymede_api
from data_hub_utils.ganymede import utils as ganymede_utils
from data_hub_utils.lib.spectramax_plate_reader import (
    create_plate_map,
    query_raw_well_data,
)
from data_hub_utils.logger import get_named_logger
from data_hub_utils.notion.api import (
    create_file_block,
    create_heading_block,
    create_page_in_database,
    create_table_block,
)
from data_hub_utils.notion.models import ReportPage
from data_hub_utils.notion.utils import (
    create_report_page_properties_object,
    get_instrument_database,
    get_notion_page_url,
)
from data_hub_utils.utils import get_current_utc_time

logger = get_named_logger(__name__)

NOTION_REPORT_VERSION = "0.1.0"


def generate_report(run_id: str) -> str:
    """Runs the report generation workflow for a SpectraMax iD5 plate reader run.

    This workflow creates a Notion page in the "SpectraMax iD5 Plate Reader" database
    with the following:

    - "Measurement Mode", "Measurement Type", and "Wavelength" tags
    - An embed of the raw Excel file
    - An embed of an Excel file containing raw well data queried from Ganymede
    - A Notion table block with appropriate data based on the measurement type

    To accomplish this, this method performs the following operations:

    1. Downloads the instrument run data from S3 using the given run ID.
    2. Queries Ganymede's API for the metadata tags.
    3. Queries Ganymede's Tables for the raw well data.
    4. Creates a Notion page in the instrument's database with the appropriate
       properties and content.

    Args:
        run_id (str):
            The run ID, which is just the name of the Excel file, e.g.
            "yeast_norm_01_16_26".

    Returns:
        str: The URL of the created Notion page.
    """
    raw_data_dir_path = (
        config.LOCAL_RAW_DATA_DIRPATH / Instrument.SPECTRAMAX_ID5_PLATE_READER.value / run_id
    )
    excel_file_name = f"{run_id}.xls"
    s3_object_uri = f"s3://{config.AWS_S3_RAW_DATA_BUCKET}/{Instrument.SPECTRAMAX_ID5_PLATE_READER.value}/{excel_file_name}"
    excel_file_path = raw_data_dir_path / excel_file_name

    # Download the Excel file from S3.
    logger.info("Downloading instrument run data from S3 to '%s'...", raw_data_dir_path)
    s3_utils.download_file(s3_object_uri, excel_file_path)
    logger.info("✅ Excel file downloaded.\n")

    # Query the metadata tags from Ganymede.
    logger.info("Querying files from Ganymede's API...")
    plate_reader_files = ganymede_api.get_files(tag="instrument:Plate Reader")
    run_files = ganymede_utils.filter_files_by_name(plate_reader_files, re.escape(excel_file_name))

    logger.info("Found %d files for '%s' in Ganymede.", len(run_files), run_id)
    for file in run_files:
        logger.info("- %s", file.name)

    excel_file = run_files[0]
    if not excel_file or not excel_file.name.endswith(".xls"):
        raise FileNotFoundError("The plate reader Excel file was not found in Ganymede.")

    tags = {}
    for tag in excel_file.tags:
        if tag.type == "measurement_mode":
            tags["measurement_mode"] = tag.value
        elif tag.type == "measurement_type":
            tags["measurement_type"] = tag.value
        elif tag.type == "wavelength":
            tags["wavelength"] = tag.value

    logger.info("Tags: %s", tags)
    logger.info("✅ Files queried from Ganymede.\n")

    # Query the raw well data from Ganymede.
    logger.info("Querying raw well data from Ganymede...")
    df_raw_well_data = query_raw_well_data(excel_file_name)

    raw_well_data_file_path = raw_data_dir_path / "raw_well_data.xlsx"
    df_raw_well_data.to_excel(raw_well_data_file_path)
    logger.info("\n%s", df_raw_well_data)
    logger.info("✅ Raw well data queried from Ganymede.\n")

    # Create the report in Notion.
    instrument_name = INSTRUMENT_ID_TO_NAME_MAP[Instrument.SPECTRAMAX_ID5_PLATE_READER.value]
    instrument_database = get_instrument_database(instrument_name)
    logger.info("Creating report in '%s' database...", instrument_name)

    page_properties = {
        **create_report_page_properties_object(
            properties=ReportPage(
                instrument_run_id=run_id,
                date_generated=get_current_utc_time(),
                report_version=NOTION_REPORT_VERSION,
            )
        ),
        "Measurement Mode": {
            "select": {"name": tags["measurement_mode"]},
        },
        "Measurement Type": {
            "select": {"name": tags["measurement_type"]},
        },
        "Wavelength": {
            "select": {"name": tags["wavelength"]},
        },
    }

    page_content = [
        create_heading_block(2, "Raw data"),
        create_file_block(excel_file_path, block_type="file"),
        create_heading_block(2, "Parsed data from Ganymede Tables"),
        create_file_block(raw_well_data_file_path, block_type="file"),
    ]

    # For endpoint runs, create a plate map with the absorbance values.
    if tags["measurement_type"] == "Endpoint":
        df_plate_map = create_plate_map(df_raw_well_data)
        df_plate_map.insert(0, " ", df_plate_map.index)

        page_content.append(create_heading_block(2, "Plate reader measurements"))
        page_content.append(create_table_block(df_plate_map))
        logger.info("%s", df_plate_map)

    # For kinetic and spectrum runs, create a table with the first 25 rows of raw well data.
    elif tags["measurement_type"] == "Kinetic":
        df_kinetic_data = df_raw_well_data[["time", "well_position", "value"]]
        df_kinetic_data = df_kinetic_data.rename(
            columns={
                "time": "Time",
                "well_position": "Well Position",
                "value": "Value",
            }
        )
        page_content.append(create_heading_block(2, "First 25 rows of kinetic data"))
        page_content.append(create_table_block(df_kinetic_data.head(25)))
        logger.info("%s", df_kinetic_data)

    elif tags["measurement_type"] == "Spectrum":
        df_spectrum_data = df_raw_well_data[["wavelength", "well_position", "value"]]
        df_spectrum_data = df_spectrum_data.rename(
            columns={
                "wavelength": "Wavelength",
                "well_position": "Well Position",
                "value": "Value",
            }
        )
        page_content.append(create_heading_block(2, "First 25 rows of spectrum data"))
        page_content.append(create_table_block(df_spectrum_data.head(25)))
        logger.info("%s", df_spectrum_data)

    page_id = create_page_in_database(
        database_id=instrument_database["id"],
        properties=page_properties,
        content=page_content,
    )

    notion_page_url = get_notion_page_url(page_id)
    logger.info("✅ Report created in Notion. Link: %s\n", notion_page_url)
    return notion_page_url
