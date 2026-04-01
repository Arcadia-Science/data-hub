from __future__ import annotations
from typing import Any

from data_hub_lambda.config import lambda_config
from data_hub_lambda.notion.api import (
    create_text_block,
    get_block_children,
    get_databases,
    query_database,
)
from data_hub_lambda.notion.models import ReportPage


def get_notion_page_url(page_id: str) -> str:
    """Returns a URL to the Notion page with the given ID."""
    return f"https://www.notion.so/arcadiascience/{page_id.replace('-', '')}"


def get_instrument_database(instrument_name: str) -> dict[str, Any]:
    """Returns the Notion database for the specified instrument."""
    databases = get_databases(lambda_config.NOTION_PAGE_ID)  # type: ignore[arg-type]

    for database in databases:
        if instrument_name.lower() in database["child_database"]["title"].lower():
            return database  # type: ignore[no-any-return]

    raise Exception(f"Instrument database not found for {instrument_name}")


def get_instrument_run_page(instrument_name: str, run_id: str) -> dict[str, Any] | None:
    """Returns the Notion page for the specified instrument run, if it exists."""
    database = get_instrument_database(instrument_name)
    pages = query_database(database["id"])

    for page in pages["results"]:
        if page["properties"]["Instrument Run ID"]["title"][0]["plain_text"] == run_id:
            return page

    return None


def get_instrument_run_page_id(instrument_name: str, run_id: str) -> str | None:
    """Returns the Notion page ID for the specified instrument run, if it exists."""
    instrument_run_page = get_instrument_run_page(instrument_name, run_id)
    return instrument_run_page["id"] if instrument_run_page is not None else None


def create_report_page_properties_object(
    properties: ReportPage,
) -> dict[str, Any]:
    """Creates the Notion properties object for an instrument run report page."""
    return {
        "Instrument Run ID": {"title": [create_text_block(properties.instrument_run_id)]},
        "Date Generated": {"date": {"start": properties.date_generated}},
        "Report Version": {"select": {"name": properties.report_version}},
    }


def get_files_appended_to_notion_page(notion_page_id: str) -> list[str]:
    """Returns the names of ``file`` blocks appended to the specified Notion page."""
    return [
        block["file"]["name"]
        for block in get_block_children(notion_page_id)
        if block["type"] == "file"
    ]


def get_pdf_files_appended_to_notion_page(notion_page_id: str) -> list[str]:
    """Returns the names of PDF files appended to the specified Notion page."""
    return [
        block["pdf"]["caption"][0]["plain_text"]
        for block in get_block_children(notion_page_id)
        if block["type"] == "pdf" and block["pdf"]["caption"]
    ]
