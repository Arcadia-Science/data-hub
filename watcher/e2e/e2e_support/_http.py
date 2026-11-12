"""A small HTTP helper shared by :mod:`e2e_support.server` and :mod:`e2e_support.admin`."""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any

import requests

__all__ = ["REQUEST_TIMEOUT_SECONDS", "ApiResult", "call", "new_session"]

# Every request goes to a local server, and a slow answer is a bug the test should see.
REQUEST_TIMEOUT_SECONDS = 30


def new_session() -> requests.Session:
    """A ``requests`` session that ignores proxy settings in the environment.

    The requests are for the local test server, and a developer's ``HTTP_PROXY`` would
    send them somewhere else.
    """
    session = requests.Session()
    session.trust_env = False
    return session


@dataclass(frozen=True)
class ApiResult:
    """The answer to one REST call, kept whole so a test can assert on a refusal.

    ``body`` is the parsed JSON, or the response text when the body isn't JSON, or ``None``
    for an empty body. Nothing raises for a 4xx or 5xx: call :meth:`raise_for_status` on the
    happy path.
    """

    method: str
    url: str
    status_code: int
    body: Any

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    @property
    def error_code(self) -> str | None:
        """The ``error.code`` of an error body (``"WATCHER_OFFLINE"``, ``"CONFLICT"``), if any."""
        if isinstance(self.body, dict):
            error = self.body.get("error")
            if isinstance(error, dict) and isinstance(error.get("code"), str):
                return str(error["code"])
        return None

    def raise_for_status(self) -> ApiResult:
        """Return ``self`` for a 2xx answer and raise ``AssertionError`` with the body otherwise."""
        if not self.ok:
            raise AssertionError(
                f"{self.method} {self.url} answered {self.status_code}: {self.body}"
            )
        return self

    def __str__(self) -> str:
        return f"{self.method} {self.url} -> {self.status_code} {self.body}"


def call(
    session: requests.Session,
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    json: Any = None,
    timeout: float = REQUEST_TIMEOUT_SECONDS,
) -> ApiResult:
    """Send one request and wrap the answer in an :class:`ApiResult`."""
    response = session.request(method, url, headers=headers, json=json, timeout=timeout)
    body: Any
    if not response.content:
        body = None
    else:
        try:
            body = response.json()
        except ValueError:
            body = response.text
    return ApiResult(method=method, url=url, status_code=response.status_code, body=body)
