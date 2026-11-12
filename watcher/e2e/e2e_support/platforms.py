"""Which kinds of driver a test is for, and when a run skips it.

A test in a shared file runs under every kind of driver (``cli``, ``service``) unless it says
otherwise with ``@pytest.mark.platforms("cli")``. The suite's ``conftest.py`` skips a test
whose marker leaves out the kind of driver in use, before any fixture is set up. The catalog
check reads the same marker (``e2e_support.catalog.check``), so a skip declared this way is
never hidden from it: it knows which transitions each kind of driver covers.

A test in ``test_windows_service.py`` is for the service whatever it is marked.
"""

from __future__ import annotations
from collections.abc import Sequence

from e2e_support.catalog import DRIVER_KINDS, SERVICE_TEST_FILE

__all__ = ["platforms_skip_reason"]


def platforms_skip_reason(
    marker_args: Sequence[object] | None, file_name: str, active_kind: str
) -> str | None:
    """Why a test must be skipped under ``active_kind``, or ``None`` if it runs.

    ``marker_args`` are the arguments of the closest ``platforms`` marker (``None`` if the test
    has none), and ``file_name`` is the test file's name.
    """
    kinds = set(DRIVER_KINDS) if marker_args is None else set(marker_args)
    unknown = sorted(str(kind) for kind in kinds - set(DRIVER_KINDS))
    if unknown or not kinds:
        raise ValueError(f"platforms takes one or more of {list(DRIVER_KINDS)}, not {unknown}")
    if file_name == SERVICE_TEST_FILE:
        kinds &= {"service"}
    if active_kind in kinds:
        return None
    wanted = "/".join(kind for kind in DRIVER_KINDS if kind in kinds) or "no"
    return f"this test is for the {wanted} driver, and this run uses the {active_kind} driver"
