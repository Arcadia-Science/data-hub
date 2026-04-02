from __future__ import annotations
import re

from data_hub_lambda.ganymede.models import File


def filter_files_by_name(files: list[File], pattern: str) -> list[File]:
    """Filters a list of files by matching the file name to the given regex pattern."""
    filtered_files = []

    for file in files:
        file_name = file.name.split("/")[-1]
        if re.match(pattern, file_name):
            filtered_files.append(file)

    return filtered_files


def get_file_browser_url(file: File) -> str:
    """Returns a URL to the file in Ganymede's web interface."""
    return f"https://arcadia.ganymede.bio/arcadia-prod/files?fileBucket=input&filePath={file.name}"
