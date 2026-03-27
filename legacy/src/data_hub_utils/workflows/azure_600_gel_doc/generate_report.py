import re

from data_hub_utils.aws import s3_utils
from data_hub_utils.config import config
from data_hub_utils.constants import INSTRUMENT_ID_TO_NAME_MAP
from data_hub_utils.enums import Instrument
from data_hub_utils.ganymede import api as ganymede_api
from data_hub_utils.ganymede import utils as ganymede_utils
from data_hub_utils.logger import get_named_logger
from data_hub_utils.notion.api import (
    create_file_block,
    create_heading_block,
    create_page_in_database,
)
from data_hub_utils.notion.models import ReportPage
from data_hub_utils.notion.utils import (
    create_report_page_properties_object,
    get_instrument_database,
    get_notion_page_url,
)
from data_hub_utils.utils import get_current_utc_time
from data_hub_utils.workflows.azure_600_gel_doc.image_processing import TIFFProcessor

logger = get_named_logger(__name__)

NOTION_REPORT_VERSION = "0.1.3"


def generate_report(run_id: str) -> str:
    """Runs the report generation workflow for a Azure 600 Gel Doc run.

    This workflow creates a Notion page in the "Azure 600 Gel Doc" database
    with the following:

    - "Capture Type", "Imaging Mode", "Wavelength", and "Wavelength Color" tags
    - An embed of the raw TIFF file
    - An embed of the processed PNG file

    To accomplish this, this method performs the following operations:

    1. Downloads the instrument run data from S3 using the given run ID.
    2. Processes the TIFF file to generate a PNG with rescaled image intensities.
    3. Queries Ganymede's API for the metadata tags.
    4. Creates a Notion page in the instrument's database with the appropriate
       properties and content.

    Args:
        run_id (str):
            The run ID, which is just the name of the TIFF file,
            e.g. "25.09.26_14.49.59_YES+MOPS_MES_pH6.1".

    Returns:
        str: The URL of the created Notion page.
    """
    raw_data_dir_path = config.LOCAL_RAW_DATA_DIRPATH / Instrument.AZURE_600_GEL_DOC.value / run_id
    tiff_file_name = f"{run_id}.tif"
    s3_object_uri = f"s3://{config.AWS_S3_RAW_DATA_BUCKET}/{Instrument.AZURE_600_GEL_DOC.value}/{tiff_file_name}"
    tiff_file_path = raw_data_dir_path / tiff_file_name

    # Download the TIFF file from S3.
    logger.info("Downloading instrument run data from S3 to '%s'...", raw_data_dir_path)
    s3_utils.download_file(s3_object_uri, tiff_file_path)
    logger.info("✅ TIFF file downloaded.\n")

    # Process the TIFF file.
    logger.info("Processing TIFF file...")
    try:
        tiff_processor = TIFFProcessor(tiff_file_path)
        tiff_processor.load()
        png_file_path = tiff_processor.export_figure()
    except Exception as e:
        logger.exception("Failed to process TIFF file.")
        raise e
    logger.info("✅ TIFF file processed.\n")

    # Query the metadata tags from Ganymede.
    logger.info("Querying files from Ganymede's API...")
    gel_doc_files = ganymede_api.get_files(tag="instrument:Gel Doc")
    run_files = ganymede_utils.filter_files_by_name(gel_doc_files, re.escape(tiff_file_name))

    logger.info("Found %d files named '%s' in Ganymede.", len(run_files), tiff_file_name)
    for file in run_files:
        logger.info("- %s", file.name)
    if not run_files:
        raise FileNotFoundError("The Gel Doc TIFF file was not found in Ganymede.")

    tiff_file = run_files[0]

    tags = {
        "imaging_mode": None,
        "capture_type": None,
        "wavelength": [],
        "wavelength_color": [],
    }
    for tag in tiff_file.tags:
        if tag.type == "imaging_mode":
            tags["imaging_mode"] = tag.value
        elif tag.type == "capture_type":
            tags["capture_type"] = tag.value
        elif tag.type == "wavelength":
            tags["wavelength"].append(tag.value)
        elif tag.type == "wavelength_color":
            tags["wavelength_color"].append(tag.value)

    logger.info("Tags: %s", tags)
    logger.info("✅ Files queried from Ganymede.\n")

    # Create the report in Notion.
    instrument_name = INSTRUMENT_ID_TO_NAME_MAP[Instrument.AZURE_600_GEL_DOC.value]
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
        "Wavelengths": {
            "multi_select": [{"name": tag} for tag in tags["wavelength"]],
        },
        "Wavelength Colors": {
            "multi_select": [{"name": tag} for tag in tags["wavelength_color"]],
        },
    }

    if tags.get("imaging_mode"):
        page_properties["Imaging Mode"] = {"select": {"name": tags["imaging_mode"]}}
    if tags.get("capture_type"):
        page_properties["Capture Type"] = {"select": {"name": tags["capture_type"]}}

    page_id = create_page_in_database(
        database_id=instrument_database["id"],
        properties=page_properties,
        content=[
            create_heading_block(2, "Processed image"),
            create_file_block(png_file_path, block_type="image"),
            create_heading_block(2, "Raw image"),
            create_file_block(tiff_file_path, block_type="image"),
        ],
    )

    notion_page_url = get_notion_page_url(page_id)
    logger.info("✅ Report created in Notion. Link: %s\n", notion_page_url)
    return notion_page_url
