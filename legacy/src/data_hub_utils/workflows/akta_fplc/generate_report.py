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
    create_paragraph_block,
)
from data_hub_utils.notion.models import ReportPage
from data_hub_utils.notion.utils import (
    create_report_page_properties_object,
    get_instrument_database,
    get_notion_page_url,
)
from data_hub_utils.utils import get_current_utc_time

logger = get_named_logger(__name__)

NOTION_REPORT_VERSION = "0.1.3"


def generate_report(run_id: str) -> str:
    """Runs the report generation workflow for an Akta FPLC run.

    This workflow creates a Notion page in the "Akta FPLC" database with a
    column type tag, an embed of the PDF file, and a link to the CSV file.

    To accomplish this, this method performs the following operations:

    1. Downloads the instrument run data from S3 using the given run ID,
       which is expected to be the name of all files of the same run
       e.g. "2025-09-23_test.pdf" and "2025-09-23_test.csv".
    2. Queries Ganymede's API for the "Column Type" tag for the PDF file.
    3. Creates a Notion page in the "Akta FPLC" database with the appropriate
       properties and content.

    Args:
        run_id (str): The run ID e.g. "2025-09-23_test".

    Returns:
        str: The URL of the created Notion page.
    """
    raw_data_dir_path = config.LOCAL_RAW_DATA_DIRPATH / Instrument.AKTA_FPLC.value / run_id
    logger.info("Downloading instrument run data from S3 to '%s'...", raw_data_dir_path)

    # Download the PDF file from S3.
    s3_object_uri = (
        f"s3://{config.AWS_S3_RAW_DATA_BUCKET}/{Instrument.AKTA_FPLC.value}/{run_id}.pdf"
    )
    pdf_file_path = raw_data_dir_path / f"{run_id}.pdf"
    s3_utils.download_file(s3_object_uri, pdf_file_path)
    logger.info("✅ PDF file downloaded.\n")

    # Generate a URL to the CSV file in Ganymede's web interface.
    # These are based on links that can be copied to the clipboard from Ganymede's File Browser UI.
    logger.info("Querying files from Ganymede's API...")

    fplc_files = ganymede_api.get_files(tag="instrument:FPLC")
    run_files = ganymede_utils.filter_files_by_name(fplc_files, rf"^{run_id}.*")

    logger.info("Found %d files for '%s' in Ganymede.", len(run_files), run_id)
    for file in run_files:
        logger.info("- %s", file.name)

    csv_file_url = ganymede_utils.get_file_browser_url(
        [file for file in run_files if file.name.endswith(".csv")][0]
    )

    # Query the "Column Type" tag. These tags are the same for every file in the run,
    # so we just need to use one file. We arbitrarily choose the PDF file.
    pdf_file = [file for file in run_files if file.name.endswith(".pdf")][0]
    column_type_tag = [tag.value for tag in pdf_file.tags if tag.type == "column_type"][0]

    logger.info("PDF file: %s", pdf_file)
    logger.info("Column type tag: %s", column_type_tag)
    logger.info("✅ Files queried from Ganymede.\n")

    # Create the report in Notion.
    instrument_name = INSTRUMENT_ID_TO_NAME_MAP[Instrument.AKTA_FPLC.value]
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
        "Column Type": {
            "select": {"name": column_type_tag},
        },
    }

    page_id = create_page_in_database(
        database_id=instrument_database["id"],
        properties=page_properties,
        content=[
            create_heading_block(2, "PDF report"),
            create_file_block(pdf_file_path, block_type="pdf"),
            create_heading_block(2, "CSV file"),
            create_paragraph_block(f"{run_id}.csv", csv_file_url),
        ],
    )

    notion_page_url = get_notion_page_url(page_id)
    logger.info("✅ Report created in Notion. Link: %s\n", notion_page_url)
    return notion_page_url
