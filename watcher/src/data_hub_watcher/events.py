from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from data_hub_watcher.api_client import ApiError, DataHubClient

logger = logging.getLogger(__name__)


class EventType(str, Enum):
    WATCHER_STARTED = "watcher_started"
    WATCHER_STOPPED = "watcher_stopped"
    FILE_UPLOADED = "file_uploaded"
    UPLOAD_FAILED = "upload_failed"
    RUN_REPORTED = "run_reported"
    CONFIG_SYNCED = "config_synced"
    ERROR = "error"


@dataclass
class WatcherEvent:
    event_type: EventType
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_type": self.event_type.value,
            "timestamp": self.timestamp,
            "message": self.message,
            "details": self.details,
        }


class EventReporter:
    """Accumulates events in memory and flushes them to the API in batches."""

    def __init__(self, client: DataHubClient, watcher_id: str) -> None:
        self._client = client
        self._watcher_id = watcher_id
        self._queue: list[WatcherEvent] = []

    def queue_event(self, event: WatcherEvent) -> None:
        self._queue.append(event)

    def flush(self) -> None:
        if not self._queue:
            return

        events_to_send = list(self._queue)
        self._queue.clear()

        try:
            self._client.send_events(
                self._watcher_id,
                [e.to_dict() for e in events_to_send],
            )
        except (ApiError, Exception) as exc:
            logger.warning("Failed to flush %d event(s): %s", len(events_to_send), exc)