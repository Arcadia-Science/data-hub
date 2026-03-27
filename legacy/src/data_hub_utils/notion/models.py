from dataclasses import dataclass
from typing import Literal, TypedDict


class CreateFileUploadBodyParams(TypedDict):
    """Body parameters for creating a file upload object in Notion.

    Reference: https://developers.notion.com/reference/create-a-file-upload.
    """

    mode: Literal["single_part", "multi_part", "external_url"]
    filename: str
    number_of_parts: int


@dataclass
class ReportPage:
    """Properties for the report page of an instrument database in Notion."""

    instrument_run_id: str
    date_generated: str
    report_version: str


@dataclass
class SpectraMaxID3ReportPage(ReportPage):
    """Properties for the report page of the SpectraMax iD3 database in Notion."""

    pipeline_name: str
    pipeline_version: str
    run_mode: str
    run_type: str
