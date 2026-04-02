from typing import Any, TypedDict

from pydantic import BaseModel


class FileTag(BaseModel):
    """Tag object returned by Ganymede's API."""

    id: str
    type: str
    value: str


class File(BaseModel):
    """File object returned by Ganymede's API."""

    uri: str
    name: str
    createdAt: int
    size: int
    creator: str
    tags: list[FileTag]


class PostQueryResponseObject(TypedDict):
    """Row object returned by Ganymede's table query API."""

    row: dict[str, Any]
    error: str | None
