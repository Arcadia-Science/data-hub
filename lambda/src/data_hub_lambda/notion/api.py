from __future__ import annotations
import logging
import mimetypes
from pathlib import Path
from typing import Any, Literal

import pandas as pd
import requests

from data_hub_lambda.config import lambda_config
from data_hub_lambda.constants import NOTION_SUPPORTED_FILE_TYPES
from data_hub_lambda.notion.models import CreateFileUploadBodyParams
from data_hub_lambda.utils import split_file_into_n_parts

NOTION_API_BASE_URL = "https://api.notion.com/v1"

logger = logging.getLogger(__name__)


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {lambda_config.NOTION_API_SECRET}",
        "Notion-Version": "2022-06-28",
    }


def create_text_block(text: str, inline_link_url: str | None = None) -> dict[str, Any]:
    """Creates a Notion rich-text text block."""
    text_block: dict[str, Any] = {
        "type": "text",
        "text": {"content": text},
    }
    if inline_link_url:
        text_block["text"]["link"] = {"url": inline_link_url}
    return text_block


def _create_file_upload(body_params: CreateFileUploadBodyParams | None = None) -> str:
    try:
        response = requests.post(
            f"{NOTION_API_BASE_URL}/file_uploads",
            headers={
                **_headers(),
                "accept": "application/json",
                "content-type": "application/json",
            },
            json=body_params,
        )
        response.raise_for_status()
        return response.json()["id"]
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore[possibly-undefined]
        logger.exception("Failed to create file upload object in Notion.")
        raise e


def _send_file_upload(file_upload_id: str, file_path: Path, part_number: int | None = None) -> None:
    with open(file_path, "rb") as file:
        file_contents = file.read()
    mime_type = mimetypes.guess_type(file_path)[0]
    files: dict[str, Any] = {"file": (file_path.name, file_contents, mime_type)}

    try:
        response = requests.post(
            f"{NOTION_API_BASE_URL}/file_uploads/{file_upload_id}/send",
            headers=_headers(),
            files=files,  # type: ignore[arg-type]
            data={"part_number": str(part_number)} if part_number else None,
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore[possibly-undefined]
        logger.exception("Failed to upload file to Notion.")
        raise e


def _complete_file_upload(file_upload_id: str) -> None:
    try:
        response = requests.post(
            f"{NOTION_API_BASE_URL}/file_uploads/{file_upload_id}/complete",
            headers=_headers(),
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore[possibly-undefined]
        logger.exception("Failed to complete file upload in Notion.")
        raise e


def create_rich_text_block(text: str, inline_link_url: str | None = None) -> dict[str, Any]:
    return {"rich_text": [create_text_block(text, inline_link_url)]}


def create_paragraph_block(text: str, inline_link_url: str | None = None) -> dict[str, Any]:
    return {"type": "paragraph", "paragraph": create_rich_text_block(text, inline_link_url)}


def create_heading_block(level: Literal[1, 2, 3], text: str) -> dict[str, Any]:
    return {
        "type": f"heading_{level}",
        f"heading_{level}": {"rich_text": [create_text_block(text)]},
    }


def create_file_block(
    file_path: Path,
    block_type: Literal["file", "image", "pdf"] = "file",
    caption: str | None = None,
) -> dict[str, Any]:
    """Uploads a file to Notion and returns a file block referencing it."""
    if file_path.suffix.lower() not in NOTION_SUPPORTED_FILE_TYPES:
        raise ValueError(f"File type {file_path.suffix} is not accepted by the Notion API.")

    file_upload_data: CreateFileUploadBodyParams | None = None
    file_size = file_path.stat().st_size
    is_multi_part_upload = file_size > 20 * 1024 * 1024

    if is_multi_part_upload:
        file_upload_data = {
            "mode": "multi_part",
            "filename": file_path.name,
            "number_of_parts": file_size // (10 * 1024 * 1024) + 1,
        }

    file_upload_id = _create_file_upload(body_params=file_upload_data)

    if is_multi_part_upload:
        part_files = split_file_into_n_parts(file_path, file_upload_data["number_of_parts"])  # type: ignore[index]
        for part_number, part_file in enumerate(part_files):
            _send_file_upload(file_upload_id, part_file, part_number + 1)
        _complete_file_upload(file_upload_id)
    else:
        _send_file_upload(file_upload_id, file_path)

    file_block: dict[str, Any] = {
        "type": block_type,
        block_type: {"type": "file_upload", "file_upload": {"id": file_upload_id}},
    }
    if caption:
        file_block[block_type]["caption"] = [create_text_block(caption)]

    return file_block


def create_external_image_block(image_url: str) -> dict[str, Any]:
    return {
        "type": "image",
        "image": {"type": "external", "external": {"url": image_url}},
    }


def create_table_block(df: pd.DataFrame) -> dict[str, Any]:
    """Creates a Notion table block from a DataFrame."""
    if df.empty:
        return {
            "type": "table",
            "table": {
                "table_width": 0,
                "has_column_header": False,
                "has_row_header": False,
                "children": [],
            },
        }

    table_width = len(df.columns)
    children = []

    header_cells = [[create_text_block(str(col))] for col in df.columns]
    children.append({"type": "table_row", "table_row": {"cells": header_cells}})

    for _, row in df.iterrows():
        cells = []
        for cell_value in row:
            cell_content = str(cell_value) if pd.notna(cell_value) else ""
            cells.append([create_text_block(cell_content)])
        children.append({"type": "table_row", "table_row": {"cells": cells}})

    return {
        "type": "table",
        "table": {
            "table_width": table_width,
            "has_column_header": True,
            "has_row_header": False,
            "children": children,
        },
    }


def get_databases(page_id: str) -> list[dict[str, Any]]:
    try:
        response = requests.get(
            f"{NOTION_API_BASE_URL}/blocks/{page_id}/children",
            headers=_headers(),
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore[possibly-undefined]
        logger.exception("Failed to get children blocks from Notion.")
        raise e

    blocks = response.json()["results"]
    return [block for block in blocks if block.get("type") == "child_database"]


def query_database(database_id: str) -> dict[str, Any]:
    payload = {"sorts": [{"property": "Last edited time", "direction": "descending"}]}

    try:
        response = requests.post(
            f"{NOTION_API_BASE_URL}/databases/{database_id}/query",
            headers=_headers(),
            json=payload,
        )
        response.raise_for_status()
        return response.json()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore[possibly-undefined]
        logger.exception("Failed to query database from Notion.")
        raise e


def create_page_in_database(
    database_id: str,
    properties: dict[str, Any],
    content: list[Any],
) -> str:
    payload = {
        "parent": {"type": "database_id", "database_id": database_id},
        "properties": properties,
        "children": content,
    }

    try:
        response = requests.post(
            f"{NOTION_API_BASE_URL}/pages",
            headers={**_headers(), "Content-Type": "application/json"},
            json=payload,
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore[possibly-undefined]
        logger.exception("Failed to create page in Notion.")
        raise e

    return response.json()["id"]


def get_block_children(block_id: str) -> list[dict[str, Any]]:
    try:
        response = requests.get(
            f"{NOTION_API_BASE_URL}/blocks/{block_id}/children",
            headers=_headers(),
        )
        response.raise_for_status()
        return response.json()["results"]
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore[possibly-undefined]
        logger.exception("Failed to get children blocks from Notion.")
        raise e


def append_block_children(
    block_id: str,
    children: list[dict[str, Any]],
    after: str | None = None,
) -> dict[str, Any]:
    if len(children) > 100:
        raise ValueError("Cannot append more than 100 block children in a single request.")

    payload: dict[str, Any] = {"children": children}
    if after is not None:
        payload["after"] = after

    try:
        response = requests.patch(
            f"{NOTION_API_BASE_URL}/blocks/{block_id}/children",
            headers={**_headers(), "Content-Type": "application/json"},
            json=payload,
        )
        response.raise_for_status()
        return response.json()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore[possibly-undefined]
        logger.exception("Failed to append children blocks to block %s", block_id)
        raise e


def update_page_properties(page_id: str, properties: dict[str, Any]) -> dict[str, Any]:
    payload = {"properties": properties}

    try:
        response = requests.patch(
            f"{NOTION_API_BASE_URL}/pages/{page_id}",
            headers=_headers(),
            json=payload,
        )
        response.raise_for_status()
        return response.json()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore[possibly-undefined]
        logger.exception("Failed to update page properties for page %s.", page_id)
        raise e
