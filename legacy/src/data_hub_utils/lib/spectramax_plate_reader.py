import pandas as pd
from data_hub_utils.ganymede import api as ganymede_api
from data_hub_utils.logger import get_named_logger

GANYMEDE_RAW_WELL_DATA_TABLE_NAME = "Spectramax_Raw_Well_Data"

logger = get_named_logger(__name__)


def query_raw_well_data(excel_file_name: str) -> pd.DataFrame:
    """Queries the raw well data for the given Excel file from the latest Ganymede flow run.

    Args:
        excel_file_name (str):
            The name of the Excel file e.g. "20250716_01.xls".

    Returns:
        pd.DataFrame: A DataFrame with the following columns:
            - plate_name (str)
            - well_position (str)
            - temperature_c (float)
            - value (float)
            - row_label (str)
            - column_label (str)
            - wavelength (float)
            - __flow_run_id (str)
            - filename (str)
            - time (int)
    """
    raw_well_data = ganymede_api.post_query(
        f"SELECT * FROM `{GANYMEDE_RAW_WELL_DATA_TABLE_NAME}` WHERE filename = '{excel_file_name}'"
    )
    df_raw_well_data = pd.DataFrame([item["row"] for item in raw_well_data])
    logger.info("Found %d raw well data rows in Ganymede.", len(df_raw_well_data))

    # If there's more than one flow run ID, determine which is the most recent and filter
    # the DataFrame to only include the rows for that flow run.
    flow_run_ids = df_raw_well_data["__flow_run_id"].unique()
    if len(flow_run_ids) > 1:
        logger.info(
            "Found %d flow run IDs in Ganymede. Filtering to latest flow run...", len(flow_run_ids)
        )
        for flow_run_id in flow_run_ids:
            logger.info("- %s", flow_run_id)

        # The flow run ID is a Unix timestamp, so we can just sort them and take the last one.
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
        # On error, use the original value.
        errors="ignore",
    )
    return df_raw_well_data


def transform_raw_well_data(df_raw_well_data: pd.DataFrame) -> pd.DataFrame:
    """Transforms raw well data to the format required for the Michaelis-Menten kinetics analysis.

    Args:
        df_raw_well_data (pd.DataFrame): The raw well data.

    Returns:
        pd.DataFrame: A DataFrame with the following columns:
            - well_row (str)
            - well_column (int)
            - well_id (str)
            - absorbance (float)
            - time (int)
    """
    # Rename and select columns.
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

    # Format `well_id` to have leading zeros (e.g., "A1" -> "A01").
    df_kinetic_data["well_id"] = df_kinetic_data["well_row"] + df_kinetic_data[
        "well_column"
    ].astype(str).str.zfill(2)

    return df_kinetic_data


def create_plate_map(df_raw_well_data: pd.DataFrame) -> pd.DataFrame:
    """Creates a 96- or 384-well plate map from raw well data queried from Ganymede.

    For 96 well plates, the rows are alphabetically labeled from A to H,
    and the columns are numerically labeled from 1 to 12. For 384 well plates,
    the rows are alphabetically labeled from A to P, and the columns are numerically
    labeled from 1 to 24.

    Args:
        df_raw_well_data (pd.DataFrame): The raw well data queried from Ganymede.

    Returns:
        pd.DataFrame: A DataFrame representing a 96- or 384-well plate.
    """
    # Determine the row and column labels based on the maximum column label.
    if df_raw_well_data["column_label"].max() <= 12:
        row_labels = list("ABCDEFGH")
        column_labels = list(range(1, 13))
    else:
        row_labels = list("ABCDEFGHIJKLMNOP")
        column_labels = list(range(1, 25))

    # Create a new DataFrame with the appropriate row and column labels.
    df_plate_map = pd.DataFrame(index=row_labels, columns=column_labels)

    # Iterate over the raw well data and set the absorbance values in the plate map.
    for _, row in df_raw_well_data.iterrows():
        df_plate_map.loc[row["row_label"], row["column_label"]] = row["value"]

    return df_plate_map
