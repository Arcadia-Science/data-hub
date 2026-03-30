import requests
from data_hub_utils.config import config
from data_hub_utils.ganymede.models import File, PostQueryResponseObject
from data_hub_utils.logger import get_named_logger

GANYMEDE_API_BASE_URL = "https://arcadia.ganymede.bio/v1/environment/arcadia-prod"

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "api-key": config.GANYMEDE_API_KEY,
}

if not config.GANYMEDE_API_KEY:
    raise ValueError("GANYMEDE_API_KEY is not set.")

logger = get_named_logger(__name__)


def get_files(
    created_before: int | None = None,
    created_after: int | None = None,
    page_number: int | None = None,
    page_size: int = 10000,
    tag: str | None = None,
) -> list[File]:
    """Returns a list of files from Ganymede's API matching the given filters.

    API reference: https://docs.ganymede.bio/api/get-files.

    Args:
        created_before (int, optional):
            Only return files created before this epoch time in milliseconds.
        created_after (int, optional):
            Only return files created after this epoch time in milliseconds.
        page_number (int, optional):
            The page number for paginated results.
        page_size (int, optional):
            Number of results per page between 1 and 10000. Defaults to 10000.
        tag (str, optional):
            A tag in the format of "tagName:tagValue" to filter files.

    Returns:
        list[ganymede.models.File]: A list of File objects returned from Ganymede's API.

    Raises:
        requests.exceptions.HTTPError: If the response from Ganymede's API is not 200.
    """
    query_params = {}

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
            headers=HEADERS,
            params=query_params,
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore
        logger.exception("Failed to query files from Ganymede.")
        raise e

    logger.info("✅ Files queried from Ganymede.")
    return [File(**file) for file in response.json()]


def post_query(sql_query: str) -> list[PostQueryResponseObject]:
    """Submits a SQL query against data in Ganymede Tables.

    API reference: https://docs.ganymede.bio/api/post-query.

    Args:
        sql_query (str): A SQL query compatible with BigQuery to execute against Ganymede Tables.

    Returns:
        list[PostQueryResponseObject]: The results of the provided SQL query.

    Raises:
        requests.exceptions.HTTPError: If the response from Ganymede's API is not 200.
    """
    payload = {"sqlQuery": sql_query}

    try:
        response = requests.request(
            method="POST",
            url=f"{GANYMEDE_API_BASE_URL}/tables/query",
            headers=HEADERS,
            json=payload,
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore
        logger.exception("Failed to execute SQL query on Ganymede.")
        raise e

    logger.info("✅ SQL query executed on Ganymede.")
    return response.json()
