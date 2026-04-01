from __future__ import annotations
import logging

import requests

from data_hub_lambda.config import lambda_config
from data_hub_lambda.ganymede.models import File, PostQueryResponseObject

GANYMEDE_API_BASE_URL = "https://arcadia.ganymede.bio/v1/environment/arcadia-prod"

logger = logging.getLogger(__name__)


def _headers() -> dict[str, str | None]:
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "api-key": lambda_config.GANYMEDE_API_KEY,
    }


def get_files(
    created_before: int | None = None,
    created_after: int | None = None,
    page_number: int | None = None,
    page_size: int = 10000,
    tag: str | None = None,
) -> list[File]:
    """Returns files from Ganymede matching the given filters."""
    query_params: dict[str, int | str] = {}

    if created_before is not None:
        query_params["createdBefore"] = created_before
    if created_after is not None:
        query_params["createdAfter"] = created_after
    if page_number is not None:
        query_params["pageNumber"] = page_number
    if page_size is not None:
        query_params["pageSize"] = page_size
    if tag is not None:
        query_params["tag"] = tag

    try:
        response = requests.request(
            method="GET",
            url=f"{GANYMEDE_API_BASE_URL}/files",
            headers=_headers(),
            params=query_params,
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore[possibly-undefined]
        logger.exception("Failed to query files from Ganymede.")
        raise e

    logger.info("Files queried from Ganymede.")
    return [File(**file) for file in response.json()]


def post_query(sql_query: str) -> list[PostQueryResponseObject]:
    """Submits a SQL query against data in Ganymede Tables."""
    payload = {"sqlQuery": sql_query}

    try:
        response = requests.request(
            method="POST",
            url=f"{GANYMEDE_API_BASE_URL}/tables/query",
            headers=_headers(),
            json=payload,
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore[possibly-undefined]
        logger.exception("Failed to execute SQL query on Ganymede.")
        raise e

    logger.info("SQL query executed on Ganymede.")
    return response.json()
