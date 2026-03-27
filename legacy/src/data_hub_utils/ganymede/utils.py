import re

from data_hub_utils.ganymede.models import File


def filter_files_by_name(files: list[File], pattern: str) -> list[File]:
    """Filters a list of files by matching the file name to the given pattern.

    The Ganymede API currently does not provide a way to filter files by filename,
    so we have to filter the files ourselves after fetching them.

    Args:
        files (list[File]): The list of files to filter.
        pattern (str): The regex pattern to filter by.

    Returns:
        list[File]: The filtered list of files.
    """
    filtered_files = []

    for file in files:
        file_name = file.name.split("/")[-1]
        if re.match(pattern, file_name):
            filtered_files.append(file)

    return filtered_files


def get_file_browser_url(file: File) -> str:
    """Returns a URL to the file in Ganymede's web interface.

    Args:
        file (File): The file to get the URL for.

    Returns:
        str: The URL to the file in Ganymede's web interface.
    """
    return f"https://arcadia.ganymede.bio/arcadia-prod/files?fileBucket=input&filePath={file.name}"
