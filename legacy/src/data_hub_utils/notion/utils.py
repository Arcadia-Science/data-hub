from typing import Any

from data_hub_utils.config import config
from data_hub_utils.notion.api import (
    create_text_block,
    get_block_children,
    get_databases,
    query_database,
)
from data_hub_utils.notion.models import ReportPage


def get_notion_page_url(page_id: str) -> str:
    """Returns a URL to the Notion page with the given ID.

    Args:
        page_id (str): The ID of the Notion page.

    Returns:
        str: The URL to the Notion page.
    """
    return f"https://www.notion.so/arcadiascience/{page_id.replace('-', '')}"


def get_instrument_database(instrument_name: str) -> dict[str, Any]:
    """Returns the Notion database for the specified instrument.

    Searches for a database with a title that contains the instrument name
    in the "Data Hub" Notion page (when lowercase).

    We don't search for an exact match so that we don't have to store the database names
    as environment variables. For example, in the staging Notion page, each database has
    the "(Staging)" suffix, whereas there is no such suffix in the production Notion page.

    Args:
        instrument_name (str): The name of the instrument e.g. "SpectraMax iD3 Plate Reader".

    Returns:
        dict[str, Any]: The Notion database for the specified instrument.

    Raises:
        requests.exceptions.HTTPError: If the request fails.
        Exception: If the instrument database is not found.
    """
    databases = get_databases(config.NOTION_PAGE_ID)  # type: ignore

    for database in databases:
        if instrument_name.lower() in database["child_database"]["title"].lower():
            return database  # type: ignore

    raise Exception(f"Instrument database not found for {instrument_name}")


def get_instrument_run_page(instrument_name: str, run_id: str) -> dict[str, Any] | None:
    """Returns the Notion page for the specified instrument run.

    Args:
        instrument_name (str): The name of the instrument.
        run_id (str): The ID of the instrument run.

    Returns:
        dict[str, Any] | None: If found, the Notion page for the specified instrument run.

    Raises:
        requests.exceptions.HTTPError: If the request fails.
    """
    database = get_instrument_database(instrument_name)
    pages = query_database(database["id"])

    for page in pages["results"]:
        if page["properties"]["Instrument Run ID"]["title"][0]["plain_text"] == run_id:
            return page

    return None


def get_instrument_run_page_id(instrument_name: str, run_id: str) -> str | None:
    """Returns the Notion page ID for the specified instrument run, if it exists.

    Args:
        instrument_name (str): The name of the instrument.
        run_id (str): The ID of the instrument run.

    Returns:
        str | None: The Notion page ID for the instrument run, if it exists.
    """
    instrument_run_page = get_instrument_run_page(instrument_name, run_id)
    return instrument_run_page["id"] if instrument_run_page is not None else None


def create_report_page_properties_object(
    properties: ReportPage,
) -> dict[str, Any]:
    """Creates the properties object for an instrument run report page in Notion.

    API reference: https://developers.notion.com/reference/property-object.

    Args:
        properties (ReportPage): The properties for the report page.

    Returns:
        dict[str, Any]: The properties object for the report page.
    """
    return {
        "Instrument Run ID": {"title": [create_text_block(properties.instrument_run_id)]},
        "Date Generated": {"date": {"start": properties.date_generated}},
        "Report Version": {"select": {"name": properties.report_version}},
    }


def get_files_appended_to_notion_page(notion_page_id: str) -> list[str]:
    """Returns the names of files appended to the specified Notion page.

    This method only returns files with the "file" block type. It will not
    return PDF or image files.

    Args:
        notion_page_id (str): The ID of the Notion page.

    Returns:
        list[str]: The names of the files appended to the Notion page.
    """
    return [
        block["file"]["name"]
        for block in get_block_children(notion_page_id)
        if block["type"] == "file"
    ]


def get_pdf_files_appended_to_notion_page(notion_page_id: str) -> list[str]:
    """Returns the names of PDF files appended to the specified Notion page.

    Args:
        notion_page_id (str): The ID of the Notion page.

    Returns:
        list[str]: The names of the PDF files appended to the Notion page.
    """
    return [
        block["pdf"]["caption"][0]["plain_text"]
        for block in get_block_children(notion_page_id)
        if block["type"] == "pdf" and block["pdf"]["caption"]
    ]
