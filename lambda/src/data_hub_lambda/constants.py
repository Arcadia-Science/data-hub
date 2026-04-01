from __future__ import annotations

# File types accepted by the Notion API (temporary — removed after full migration).
# https://developers.notion.com/docs/working-with-files-and-media#supported-file-types
NOTION_SUPPORTED_FILE_TYPES = [
    ".aac", ".adts", ".mid", ".midi", ".mp3", ".mpga", ".m4a", ".m4b", ".mp4",
    ".pdf", ".txt", ".json", ".doc", ".dot", ".docx", ".dotx",
    ".xls", ".xlt", ".xla", ".xlsx", ".xltx",
    ".ppt", ".pot", ".pps", ".ppa", ".pptx", ".potx",
    ".gif", ".heic", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp", ".ico",
    ".amv", ".asf", ".wmv", ".avi", ".f4v", ".flv", ".gifv", ".m4v",
    ".mp4", ".mkv", ".webm", ".mov", ".qt", ".mpeg",
]  # fmt: skip

# Base URL for building web app links included in Slack notifications.
# Migrated workflows return "{DATA_HUB_WEB_URL}/instruments/{id}/runs/{run_id}".
DATA_HUB_WEB_URL = "https://data-hub.arcadiascience.com"
