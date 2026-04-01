from __future__ import annotations
import shutil

import pandas as pd
from michaelis_menten_analysis import process_kinetic_data

from data_hub_lambda.lib.spectramax_plate_reader import (
    query_raw_well_data,
    transform_raw_well_data,
)
from data_hub_lambda.notion.api import (
    append_block_children,
    create_file_block,
    create_heading_block,
    create_table_block,
)
from data_hub_lambda.utils import convert_csv_to_excel
from data_hub_shared import s3_utils
from data_hub_shared.config import config
from data_hub_shared.enums import Instrument
from data_hub_shared.logger import get_named_logger
from data_hub_shared.utils import download_file_from_url, get_current_utc_time


def run_kinetics_analysis(run_id: str, plate_map_file_url: str, notion_page_id: str) -> None:
    """Run Michaelis-Menten kinetics analysis and append results to the Notion page."""
    raw_data_dir_path = (
        config.LOCAL_RAW_DATA_DIRPATH / Instrument.SPECTRAMAX_ID3_PLATE_READER.value / run_id
    )

    processed_data_dir_path = (
        config.LOCAL_PROCESSED_DATA_DIRPATH / Instrument.SPECTRAMAX_ID3_PLATE_READER.value / run_id
    )
    if processed_data_dir_path.exists():
        shutil.rmtree(processed_data_dir_path)
    processed_data_dir_path.mkdir(parents=True, exist_ok=True)

    logger = get_named_logger(
        name=__name__,
        log_file_path=processed_data_dir_path / "mm_kinetics_analysis_pipeline.log",
    )
    logger.info("Performing Michaelis-Menten kinetics analysis for run '%s'...", run_id)

    logger.info("Downloading plate map file from URL '%s'...", plate_map_file_url)
    plate_map_file_path = raw_data_dir_path / "plate_map.csv"
    try:
        download_file_from_url(plate_map_file_url, plate_map_file_path)
        logger.info("Plate map file downloaded to '%s'.", plate_map_file_path)
    except Exception as e:
        logger.exception("Error downloading plate map file.")
        raise e

    logger.info("Querying raw well data from Ganymede...")
    df_raw_well_data = query_raw_well_data(f"{run_id}.xls")
    df_kinetic_data = transform_raw_well_data(df_raw_well_data)

    process_kinetic_data(df_kinetic_data, plate_map_file_path, processed_data_dir_path)

    initial_rate_fit_plots = list(processed_data_dir_path.glob("initial_rate_fits_*.png"))
    kinetic_curve_plots = list(processed_data_dir_path.glob("kinetic_curves_*.png"))
    mm_curve_plots = list(processed_data_dir_path.glob("mm_curves_*.png"))

    excel_files = []
    for csv_path in processed_data_dir_path.glob("*.csv"):
        excel_files.append(convert_csv_to_excel(csv_path))

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
    logger.info("Analysis results appended to Notion page.")

    logger.info("Uploading processed data to S3...")
    s3_processed_data_uri = (
        f"s3://{config.AWS_S3_PROCESSED_DATA_BUCKET}/"
        f"{Instrument.SPECTRAMAX_ID3_PLATE_READER.value}/"
        f"{run_id}/{get_current_utc_time()}"
    )
    s3_utils.upload_folder(processed_data_dir_path, s3_processed_data_uri)
    logger.info("Processed data uploaded to S3.")
