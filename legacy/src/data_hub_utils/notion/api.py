import mimetypes
from pathlib import Path
from typing import Any, Literal

import pandas as pd
import requests
from data_hub_utils.config import config
from data_hub_utils.constants import NOTION_SUPPORTED_FILE_TYPES
from data_hub_utils.logger import get_named_logger
from data_hub_utils.notion.models import CreateFileUploadBodyParams
from data_hub_utils.utils import split_file_into_n_parts

NOTION_API_BASE_URL = "https://api.notion.com/v1"
NOTION_API_HEADERS = {
    "Authorization": f"Bearer {config.NOTION_API_SECRET}",
    # This version header is required.
    # Latest version retrieved from: https://developers.notion.com/reference/changes-by-version.
    "Notion-Version": "2022-06-28",
}

if not config.NOTION_API_SECRET:
    raise ValueError("NOTION_API_SECRET is not set.")

logger = get_named_logger(__name__)


def create_text_block(text: str, inline_link_url: str | None = None) -> dict[str, Any]:
    """Helper function to create a text block.

    API reference: https://developers.notion.com/reference/rich-text.

    Args:
        text (str): The text to display in the block.
        inline_link_url (str | None): The URL to link to. Defaults to None.

    Returns:
        dict[str, Any]: The text block object.
    """
    text_block = {
        "type": "text",
        "text": {"content": text},
    }
    if inline_link_url:
        text_block["text"]["link"] = {"url": inline_link_url}
    return text_block


def _create_file_upload(body_params: CreateFileUploadBodyParams | None = None) -> str:
    """Creates a File Upload object in Notion and returns the ID.

    API reference: https://developers.notion.com/reference/create-a-file-upload.

    Args:
        body_params (CreateFileUploadBodyParams | None):
            If this is a multi-part upload, the body parameters. Defaults to None.

    Returns:
        str: The ID of the File Upload object.

    Raises:
        requests.exceptions.HTTPError: If the request fails.
    """
    logger.info("Creating file upload object in Notion with data: %s", body_params)

    try:
        response = requests.post(
            f"{NOTION_API_BASE_URL}/file_uploads",
            headers={
                **NOTION_API_HEADERS,
                "accept": "application/json",
                "content-type": "application/json",
            },
            json=body_params,
        )
        response.raise_for_status()
        logger.info("File upload object created in Notion.")
        return response.json()["id"]
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore
        logger.exception("Failed to create file upload object in Notion.")
        raise e


def _send_file_upload(file_upload_id: str, file_path: Path, part_number: int | None = None) -> None:
    """Sends a file upload to Notion.

    API reference: https://developers.notion.com/reference/send-a-file-upload.

    Args:
        file_upload_id (str):
            The ID of the File Upload object.
        file_path (Path):
            The path to the file to upload.
        part_number (int | None):
            If this is a multi-part upload, the part number of the file to upload.

    Raises:
        requests.exceptions.HTTPError: If the request fails.
    """
    logger.info("Sending file upload to Notion for '%s'...", file_path)

    with open(file_path, "rb") as file:
        file_contents = file.read()
    mime_type = mimetypes.guess_type(file_path)[0]
    files: dict[str, Any] = {"file": (file_path.name, file_contents, mime_type)}

    try:
        response = requests.post(
            f"{NOTION_API_BASE_URL}/file_uploads/{file_upload_id}/send",
            headers=NOTION_API_HEADERS,
            files=files,  # type: ignore
            data={"part_number": str(part_number)} if part_number else None,
        )
        response.raise_for_status()
        logger.info("File upload sent to Notion.")
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore
        logger.exception("Failed to upload file to Notion.")
        raise e


def _complete_file_upload(file_upload_id: str) -> None:
    """Finalizes a multi-part file upload in Notion.

    API reference: https://developers.notion.com/reference/complete-a-file-upload.

    Args:
        file_upload_id (str): The ID of the File Upload object.

    Raises:
        requests.exceptions.HTTPError: If the request fails.
    """
    logger.info("Completing file upload in Notion...")

    try:
        response = requests.post(
            f"{NOTION_API_BASE_URL}/file_uploads/{file_upload_id}/complete",
            headers=NOTION_API_HEADERS,
        )
        response.raise_for_status()
        logger.info("File upload completed in Notion.")
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore
        logger.exception("Failed to complete file upload in Notion.")
        raise e


def create_rich_text_block(text: str, inline_link_url: str | None = None) -> dict[str, Any]:
    """Creates a rich text block with the specified text.

    API reference: https://developers.notion.com/reference/rich-text.

    Args:
        text (str): The text to display in the block.
        inline_link_url (str | None): The URL to link to. Defaults to None.

    Returns:
        dict[str, Any]: The rich text block object.
    """
    return {
        "rich_text": [create_text_block(text, inline_link_url)],
    }


def create_paragraph_block(text: str, inline_link_url: str | None = None) -> dict[str, Any]:
    """Creates a paragraph block with the specified text.

    API reference: https://developers.notion.com/reference/block#paragraph.

    Args:
        text (str): The text to display in the block.
        inline_link_url (str | None): The URL to link to. Defaults to None.

    Returns:
        dict[str, Any]: The paragraph block object.
    """
    return {
        "type": "paragraph",
        "paragraph": create_rich_text_block(text, inline_link_url),
    }


def create_heading_block(level: Literal[1, 2, 3], text: str) -> dict[str, Any]:
    """Creates a heading block with the specified text.

    API reference: https://developers.notion.com/reference/heading.

    Args:
        level (Literal[1, 2, 3]): The level of the heading.
        text (str): The text to display in the block.

    Returns:
        dict[str, Any]: The heading block object.
    """
    return {
        "type": f"heading_{level}",
        f"heading_{level}": {
            "rich_text": [create_text_block(text)],
        },
    }


def create_file_block(
    file_path: Path,
    block_type: Literal["file", "image", "pdf"] = "file",
    caption: str | None = None,
) -> dict[str, Any]:
    """Uploads a file to Notion and returns a file block.

    The file is attached to the block once the upload is complete.

    API reference: https://developers.notion.com/docs/uploading-small-files.

    Args:
        file_path (Path):
            The path to the file to upload.
        block_type (Literal["file", "image", "pdf"]):
            The type of block to create. Defaults to "file".
        caption (str | None):
            The caption to display for the file. Defaults to None.

    Returns:
        dict[str, Any]: The file block object.

    Raises:
        ValueError: If the file type is not accepted by the Notion API.
        requests.exceptions.HTTPError: If the request fails.
    """
    if file_path.suffix.lower() not in NOTION_SUPPORTED_FILE_TYPES:
        raise ValueError(f"File type {file_path.suffix} is not accepted by the Notion API.")

    # If the file is larger than 20 MB, we need to create a multi-part upload.
    # We will split the file into equal parts of 10 MB each.
    # Reference: https://developers.notion.com/docs/sending-larger-files.
    file_upload_data: CreateFileUploadBodyParams | None = None
    file_size = file_path.stat().st_size
    is_multi_part_upload = file_size > 20 * 1024 * 1024

    if is_multi_part_upload:
        file_upload_data = {
            "mode": "multi_part",
            "filename": file_path.name,
            "number_of_parts": file_size // (10 * 1024 * 1024) + 1,
        }

    # Create a File Upload object.
    file_upload_id = _create_file_upload(body_params=file_upload_data)

    # Upload the file contents.
    if is_multi_part_upload:
        part_files = split_file_into_n_parts(file_path, file_upload_data["number_of_parts"])  # type: ignore

        for part_number, part_file in enumerate(part_files):
            _send_file_upload(file_upload_id, part_file, part_number + 1)

        _complete_file_upload(file_upload_id)
    else:
        _send_file_upload(file_upload_id, file_path)

    # Return a block with the file upload ID.
    file_block = {
        "type": block_type,
        block_type: {
            "type": "file_upload",
            "file_upload": {"id": file_upload_id},
        },
    }

    if caption:
        file_block[block_type]["caption"] = [create_text_block(caption)]

    return file_block


def create_external_image_block(image_url: str) -> dict[str, Any]:
    """Creates an image block with the specified URL.

    API reference: https://developers.notion.com/reference/block#image.

    Args:
        image_url (str): The URL of the image to display in the block.

    Returns:
        dict[str, Any]: The image block object.
    """
    return {
        "type": "image",
        "image": {
            "type": "external",
            "external": {"url": image_url},
        },
    }


def create_table_block(df: pd.DataFrame) -> dict[str, Any]:
    """Creates a table block with the specified DataFrame data.

    API reference: https://developers.notion.com/reference/block#table.

    Args:
        df (pd.DataFrame): DataFrame to convert to a table block.

    Returns:
        dict[str, Any]: The table block object.
    """
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

    # Determine table width from the number of columns.
    table_width = len(df.columns)

    # Create table rows.
    children = []

    # First, create header row from column names.
    header_cells = []
    for column_name in df.columns:
        # Create rich text structure for each header cell.
        cell = [create_text_block(str(column_name))]
        header_cells.append(cell)

    # Create header row block.
    header_row = {"type": "table_row", "table_row": {"cells": header_cells}}
    children.append(header_row)

    # Then, create data rows.
    for _, row in df.iterrows():
        # Create cells for this row.
        cells = []
        for cell_value in row:
            # Convert cell value to string and handle NaN values.
            cell_content = str(cell_value) if pd.notna(cell_value) else ""

            # Create rich text structure for each cell.
            cell = [create_text_block(cell_content)]
            cells.append(cell)

        # Create table row block.
        table_row = {"type": "table_row", "table_row": {"cells": cells}}
        children.append(table_row)

    return {
        "type": "table",
        "table": {
            "table_width": table_width,
            "has_column_header": True,  # DataFrame column names are used as headers.
            "has_row_header": False,
            "children": children,
        },
    }


def get_databases(page_id: str) -> list[dict[str, Any]]:
    """Returns a list of all databases in the given Notion page.

    API reference: https://developers.notion.com/reference/get-block-children.

    Args:
        page_id (str): The ID of the Notion page to get databases from.

    Returns:
        list[dict[str, Any]]: A list of all databases in the given Notion page.

    Raises:
        ValueError: If NOTION_PAGE_ID is not set.
        requests.exceptions.HTTPError: If the request fails.
    """
    # Get all children blocks from the given Notion page.
    try:
        response = requests.get(
            f"{NOTION_API_BASE_URL}/blocks/{page_id}/children",
            headers=NOTION_API_HEADERS,
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore
        logger.exception("Failed to get children blocks from Notion.")
        raise e

    # Filter for database objects and return them.
    blocks = response.json()["results"]
    databases = [block for block in blocks if block.get("type") == "child_database"]

    return databases


def query_database(database_id: str) -> dict[str, Any]:
    """Returns a list of pages in the specified database.

    By default, pages are sorted by last edited time in descending order.
    A maximum of 100 pages are returned.

    TODO: Add parameters for filtering, sorting, and pagination.

    API reference: https://developers.notion.com/reference/post-database-query.

    Args:
        database_id (str): The ID of the database to query.

    Returns:
        dict[str, Any]: The response from the database query.

    Raises:
        requests.exceptions.HTTPError: If the request fails.
    """
    logger.info("Querying database %s...", database_id)

    payload = {
        "sorts": [
            {
                "property": "Last edited time",
                "direction": "descending",
            }
        ]
    }

    try:
        response = requests.post(
            f"{NOTION_API_BASE_URL}/databases/{database_id}/query",
            headers=NOTION_API_HEADERS,
            json=payload,
        )
        response.raise_for_status()
        return response.json()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore
        logger.exception("Failed to query database from Notion.")
        raise e


def create_page_in_database(
    database_id: str,
    properties: dict[str, Any],
    content: list[Any],
) -> str:
    """Creates a page in the specified database.

    API reference: https://developers.notion.com/reference/post-page.

    Args:
        database_id (str):
            The ID of the database to create the page in.
        properties (dict[str, Any]):
            The page properties, which should match the database's properties.
            TODO: We should probably use a generic type here.
            API reference: https://developers.notion.com/reference/property-object.
        content (list[dict[str, Any]]):
            The page content, represented as a list of block objects.
            API reference: https://developers.notion.com/reference/block.

    Returns:
        str: The ID of the created page.

    Raises:
        requests.exceptions.HTTPError: If the request fails.
    """
    payload = {
        "parent": {"type": "database_id", "database_id": database_id},
        "properties": properties,
        "children": content,
    }

    try:
        response = requests.post(
            f"{NOTION_API_BASE_URL}/pages",
            headers={
                **NOTION_API_HEADERS,
                "Content-Type": "application/json",
            },
            json=payload,
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore
        logger.exception("Failed to create page in Notion.")
        raise e

    return response.json()["id"]


def get_block_children(block_id: str) -> list[dict[str, Any]]:
    """Returns the children blocks of the specified block.

    API reference: https://developers.notion.com/reference/get-block-children.

    Args:
        block_id (str): The ID of the block to get children from.

    Returns:
        list[dict[str, Any]]: The children blocks of the specified block.
    """
    try:
        response = requests.get(
            f"{NOTION_API_BASE_URL}/blocks/{block_id}/children",
            headers=NOTION_API_HEADERS,
        )
        response.raise_for_status()
        return response.json()["results"]
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore
        logger.exception("Failed to get children blocks from Notion.")
        raise e


def append_block_children(
    block_id: str,
    children: list[dict[str, Any]],
    after: str | None = None,
) -> dict[str, Any]:
    """Appends new children blocks to the parent `block_id` specified.

    Creates and appends new children blocks to the parent block_id. Blocks can be
    parented by other blocks, pages, or databases. Returns a paginated list of
    newly created first level children block objects.

    API reference: https://developers.notion.com/reference/patch-block-children.

    Args:
        block_id (str):
            The ID of the parent block to append children to.
        children (list[dict[str, Any]]):
            Array of block objects to append as children. Limited to 100 block children per request.
            Supports up to two levels of nesting.
        after (str | None):
            ID of the existing child block, after which the new block should be appended.
            If not provided, the new block is appended at the end. Defaults to None.

    Returns:
        dict[str, Any]:
            Response object containing the paginated list of newly created
            first level children block objects.

    Raises:
        ValueError:
            If more than 100 children blocks are provided.
        requests.exceptions.HTTPError:
            - 404 if block doesn't exist
            - 403 if missing insert content capabilities
            - 400/429 if request limits exceeded
    """
    if len(children) > 100:
        raise ValueError("Cannot append more than 100 block children in a single request.")

    payload: dict[str, Any] = {"children": children}
    if after is not None:
        payload["after"] = after

    logger.info("Appending %d children blocks to block %s", len(children), block_id)

    try:
        response = requests.patch(
            f"{NOTION_API_BASE_URL}/blocks/{block_id}/children",
            headers={
                **NOTION_API_HEADERS,
                "Content-Type": "application/json",
            },
            json=payload,
        )
        response.raise_for_status()
        logger.info("Successfully appended %d children blocks to block %s", len(children), block_id)
        return response.json()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore
        logger.exception("Failed to append children blocks to block %s", block_id)
        raise e


def update_page_properties(page_id: str, properties: dict[str, Any]) -> dict[str, Any]:
    """Updates the properties of the specified page.

    API reference: https://developers.notion.com/reference/patch-page.

    Args:
        page_id (str): The ID of the page to update.
        properties (dict[str, Any]): The properties to update.

    Raises:
        requests.exceptions.HTTPError: If the request fails.
    """
    payload = {"properties": properties}

    try:
        response = requests.patch(
            f"{NOTION_API_BASE_URL}/pages/{page_id}",
            headers=NOTION_API_HEADERS,
            json=payload,
        )
        response.raise_for_status()
        logger.info("Successfully updated page properties for page %s.", page_id)
        return response.json()
    except requests.exceptions.HTTPError as e:
        logger.error("Response: %s", response.json())  # type: ignore
        logger.exception("Failed to update page properties for page %s.", page_id)
        raise e
