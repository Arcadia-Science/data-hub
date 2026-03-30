from typing import Any, TypedDict

from pydantic import BaseModel


class FileTag(BaseModel):
    """The tag object returned by Ganymede's API.

    Reference: https://docs.ganymede.bio/api/get-files.
    """

    id: str
    type: str
    value: str


class File(BaseModel):
    """The file object returned by Ganymede's API.

    Reference: https://docs.ganymede.bio/api/get-files.
    """

    uri: str
    name: str
    createdAt: int
    size: int
    creator: str
    tags: list[FileTag]


class PostQueryResponseObject(TypedDict):
    """The object returned by Ganymede's API when querying a table.

    Reference: https://docs.ganymede.bio/api/post-query.
    """

    row: dict[str, Any]
    error: str | None
