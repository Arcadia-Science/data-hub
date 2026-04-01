from __future__ import annotations
import logging

import pandas as pd

from data_hub_lambda.ganymede import api as ganymede_api

GANYMEDE_RAW_WELL_DATA_TABLE_NAME = "Spectramax_Raw_Well_Data"

logger = logging.getLogger(__name__)


def query_raw_well_data(excel_file_name: str) -> pd.DataFrame:
    """Queries the raw well data for the given Excel file from Ganymede."""
    raw_well_data = ganymede_api.post_query(
        f"SELECT * FROM `{GANYMEDE_RAW_WELL_DATA_TABLE_NAME}` WHERE filename = '{excel_file_name}'"
    )
    df_raw_well_data = pd.DataFrame([item["row"] for item in raw_well_data])
    logger.info("Found %d raw well data rows in Ganymede.", len(df_raw_well_data))

    # Ganymede may contain data from multiple flow runs if the same file was
    # re-processed. Keep only the most recent run to avoid duplicated rows.
    flow_run_ids = df_raw_well_data["__flow_run_id"].unique()
    if len(flow_run_ids) > 1:
        logger.info(
            "Found %d flow run IDs in Ganymede. Filtering to latest flow run...",
            len(flow_run_ids),
        )
        latest_flow_run_id = sorted(flow_run_ids)[-1]
        latest_flow_run_data = df_raw_well_data["__flow_run_id"] == latest_flow_run_id
        df_raw_well_data = df_raw_well_data[latest_flow_run_data]
        logger.info("Filtered to %d rows for the latest flow run.", len(df_raw_well_data))

    df_raw_well_data = df_raw_well_data.astype(
        {
            "plate_name": str,
            "well_position": str,
            "row_label": str,
            "wavelength": float,
            "__flow_run_id": str,
            "filename": str,
        },
        errors="ignore",
    )
    return df_raw_well_data


def transform_raw_well_data(df_raw_well_data: pd.DataFrame) -> pd.DataFrame:
    """Transforms raw well data to the format required for Michaelis-Menten kinetics."""
    df_kinetic_data = df_raw_well_data.rename(
        columns={
            "row_label": "well_row",
            "column_label": "well_column",
            "well_position": "well_id",
            "value": "absorbance",
            "time": "time",
        }
    )
    columns = ["well_row", "well_column", "well_id", "absorbance", "time"]
    df_kinetic_data = df_kinetic_data[columns]

    # Reconstruct well_id as "A01", "B12", etc. — the original well_position
    # from Ganymede uses inconsistent formatting across plate types.
    df_kinetic_data["well_id"] = df_kinetic_data["well_row"] + df_kinetic_data[
        "well_column"
    ].astype(str).str.zfill(2)

    return df_kinetic_data


def create_plate_map(df_raw_well_data: pd.DataFrame) -> pd.DataFrame:
    """Creates a 96- or 384-well plate map from raw well data.

    Infers the plate format from the column count: <=12 columns → 96-well
    (8 rows A-H), >12 columns → 384-well (16 rows A-P).
    """
    if df_raw_well_data["column_label"].max() <= 12:
        row_labels = list("ABCDEFGH")
        column_labels = list(range(1, 13))
    else:
        row_labels = list("ABCDEFGHIJKLMNOP")
        column_labels = list(range(1, 25))

    df_plate_map = pd.DataFrame(index=row_labels, columns=column_labels)

    for _, row in df_raw_well_data.iterrows():
        df_plate_map.loc[row["row_label"], row["column_label"]] = row["value"]

    return df_plate_map
