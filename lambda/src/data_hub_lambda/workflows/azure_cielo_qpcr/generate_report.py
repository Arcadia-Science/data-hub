from __future__ import annotations

from data_hub_lambda.ganymede import api as ganymede_api
from data_hub_lambda.ganymede import utils as ganymede_utils
from data_hub_lambda.notion.api import (
    append_block_children,
    create_file_block,
    create_page_in_database,
)
from data_hub_lambda.notion.models import ReportPage
from data_hub_lambda.notion.utils import (
    create_report_page_properties_object,
    get_files_appended_to_notion_page,
    get_instrument_database,
    get_notion_page_url,
    get_pdf_files_appended_to_notion_page,
)
from data_hub_lambda.utils import convert_csv_to_excel
from data_hub_shared import s3_utils
from data_hub_shared.config import config
from data_hub_shared.constants import INSTRUMENT_ID_TO_NAME_MAP
from data_hub_shared.enums import Instrument
from data_hub_shared.logger import get_named_logger
from data_hub_shared.utils import get_current_utc_time

logger = get_named_logger(__name__)

INSTRUMENT_NAME = INSTRUMENT_ID_TO_NAME_MAP[Instrument.AZURE_CIELO_QPCR.value]
S3_PREFIX = f"s3://{config.AWS_S3_RAW_DATA_BUCKET}/{Instrument.AZURE_CIELO_QPCR.value}"
NOTION_REPORT_VERSION = "0.1.4"


def generate_report(run_id: str, notion_page_id: str | None = None) -> str:
    """Runs the report generation workflow for an Azure Cielo qPCR run."""
    raw_data_dir_path = config.LOCAL_RAW_DATA_DIRPATH / Instrument.AZURE_CIELO_QPCR.value / run_id

    logger.info("Querying files from Ganymede's API...")
    qpcr_files = ganymede_api.get_files(tag="instrument:qPCR")
    run_files = ganymede_utils.filter_files_by_name(qpcr_files, rf"^{run_id}.*")

    logger.info("Found %d files for '%s' in Ganymede.", len(run_files), run_id)
    dye_channel_tags = [tag.value for tag in run_files[0].tags if tag.type == "dye_channel"]
    logger.info("Files queried from Ganymede. Dye channel tags: %s.\n", dye_channel_tags)

    if notion_page_id is None:
        logger.info("Creating a new page for the instrument run in Notion...")
        instrument_database = get_instrument_database(INSTRUMENT_NAME)
        page_properties = {
            **create_report_page_properties_object(
                properties=ReportPage(
                    instrument_run_id=run_id,
                    date_generated=get_current_utc_time(),
                    report_version=NOTION_REPORT_VERSION,
                )
            ),
            "Dye Channels": {"multi_select": [{"name": tag} for tag in dye_channel_tags]},
        }
        notion_page_id = create_page_in_database(
            database_id=instrument_database["id"],
            properties=page_properties,
            content=[],
        )
        logger.info("Instrument run page created in Notion.\n")

    logger.info("Determining which files have already been appended to the page...")
    pdf_files_appended = get_pdf_files_appended_to_notion_page(notion_page_id)
    xlsx_files_appended = get_files_appended_to_notion_page(notion_page_id)
    files_appended = pdf_files_appended + xlsx_files_appended
    logger.info("%d files already appended to the page.\n", len(files_appended))

    s3_object_uris = s3_utils.list_objects(f"{S3_PREFIX}/{run_id}")
    file_blocks = []

    for s3_object_uri in s3_object_uris:
        filename = s3_object_uri.split("/")[-1]
        expected_xlsx_filename = filename.replace(".csv", ".xlsx").replace(" ", "_")
        if filename in files_appended or expected_xlsx_filename in files_appended:
            logger.info("File '%s' already appended to the page. Skipping...", filename)
            continue

        logger.info("Downloading '%s' from S3...", filename)
        file_path = raw_data_dir_path / filename
        s3_utils.download_file(s3_object_uri, file_path)

        if filename.endswith(".csv"):
            excel_file_path = convert_csv_to_excel(file_path)
            file_blocks.append(create_file_block(excel_file_path, block_type="file"))
        elif filename.endswith(".pdf"):
            file_blocks.append(create_file_block(file_path, block_type="pdf", caption=filename))

    if file_blocks:
        append_block_children(notion_page_id, file_blocks)
    else:
        logger.info("No new files to append to the page.")

    notion_page_url = get_notion_page_url(notion_page_id)
    logger.info("Report updated in Notion. Link: %s\n", notion_page_url)
    return notion_page_url
