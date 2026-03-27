import shutil

import pandas as pd
from data_hub_utils.aws import s3_utils
from data_hub_utils.config import config
from data_hub_utils.enums import Instrument
from data_hub_utils.lib.spectramax_plate_reader import (
    query_raw_well_data,
    transform_raw_well_data,
)
from data_hub_utils.logger import get_named_logger
from data_hub_utils.notion.api import (
    append_block_children,
    create_file_block,
    create_heading_block,
    create_table_block,
)
from data_hub_utils.utils import (
    convert_csv_to_excel,
    download_file_from_url,
    get_current_utc_time,
)
from michaelis_menten_analysis import process_kinetic_data


def run_kinetics_analysis(run_id: str, plate_map_file_url: str, notion_page_id: str) -> None:
    """Run Michaelis-Menten kinetics analysis and append results to the given Notion page.

    Performs the following operations:

    1. Queries the Ganymede API for the raw well data for the given run ID.
    2. Downloads the plate map file from the given URL.
    3. Processes the data using the `michaelis-menten-analysis` package.
    4. Appends the analysis results to the given Notion page.
    5. Uploads the analysis results to S3.

    Args:
        run_id (str): The run ID e.g. '20250716_01'.
        plate_map_file_url (str): The URL to download the plate map file.
        notion_page_id (str): The ID of the Notion page.
    """
    raw_data_dir_path = (
        config.LOCAL_RAW_DATA_DIRPATH / Instrument.SPECTRAMAX_ID3_PLATE_READER.value / run_id
    )

    # Clear the processed data directory, if it exists.
    processed_data_dir_path = (
        config.LOCAL_PROCESSED_DATA_DIRPATH / Instrument.SPECTRAMAX_ID3_PLATE_READER.value / run_id
    )
    if processed_data_dir_path.exists():
        shutil.rmtree(processed_data_dir_path)
    processed_data_dir_path.mkdir(parents=True, exist_ok=True)

    # Configure logging.
    logger = get_named_logger(
        name=__name__,
        log_file_path=processed_data_dir_path / "mm_kinetics_analysis_pipeline.log",
    )
    logger.info("Performing Michaelis-Menten kinetics analysis for run '%s'...", run_id)

    # Download the plate map file from the Notion URL.
    logger.info("Downloading plate map file from URL '%s'...", plate_map_file_url)
    plate_map_file_path = raw_data_dir_path / "plate_map.csv"

    try:
        download_file_from_url(plate_map_file_url, plate_map_file_path)
        logger.info("✅ Plate map file downloaded to '%s'.", plate_map_file_path)
    except Exception as e:
        logger.exception("❌ Error downloading plate map file.")
        raise e

    # Query the raw well data from Ganymede and transform it to the required format.
    logger.info("Querying raw well data from Ganymede...")
    df_raw_well_data = query_raw_well_data(f"{run_id}.xls")
    df_kinetic_data = transform_raw_well_data(df_raw_well_data)

    # Execute the analysis.
    process_kinetic_data(df_kinetic_data, plate_map_file_path, processed_data_dir_path)

    # Get the paths to the analysis plots.
    initial_rate_fit_plots = list(processed_data_dir_path.glob("initial_rate_fits_*.png"))
    kinetic_curve_plots = list(processed_data_dir_path.glob("kinetic_curves_*.png"))
    mm_curve_plots = list(processed_data_dir_path.glob("mm_curves_*.png"))

    # The Notion API does not support uploading CSV files, so we convert them to Excel files.
    excel_files = []
    for csv_path in processed_data_dir_path.glob("*.csv"):
        excel_path = convert_csv_to_excel(csv_path)
        excel_files.append(excel_path)

    # Append the analysis results to the Notion page.
    logger.info("Appending analysis results to Notion page...")
    page_content = [
        create_heading_block(2, "Michaelis-Menten kinetics analysis"),
        create_heading_block(3, "Processed data"),
        *[create_file_block(path, block_type="file") for path in excel_files],
        create_heading_block(3, "Michaelis-Menten parameters"),
        create_table_block(
            pd.read_csv(processed_data_dir_path / "michaelis_menten_parameters.csv")
        ),
        create_heading_block(3, "Reaction curves"),
        *[create_file_block(path, block_type="image") for path in kinetic_curve_plots],
        create_heading_block(3, "Reaction curves with initial rate fits"),
        *[create_file_block(path, block_type="image") for path in initial_rate_fit_plots],
        create_heading_block(3, "Michaelis-Menten and Lineweaver-Burk plots"),
        *[create_file_block(path, block_type="image") for path in mm_curve_plots],
    ]
    append_block_children(notion_page_id, page_content)
    logger.info("✅ Analysis results appended to Notion page.")

    # Upload the processed data to S3.
    logger.info("Uploading processed data to S3...")
    s3_processed_data_uri = (
        f"s3://{config.AWS_S3_PROCESSED_DATA_BUCKET}/"
        f"{Instrument.SPECTRAMAX_ID3_PLATE_READER.value}/"
        f"{run_id}/{get_current_utc_time()}"
    )
    s3_utils.upload_folder(processed_data_dir_path, s3_processed_data_uri)
    logger.info("✅ Processed data uploaded to S3.")
