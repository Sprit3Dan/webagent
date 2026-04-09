"""
In-memory delegation store with state machine and message-level deduplication.

State machine:
  created → dispatched → received → running → done | failed | timeout

Emitters:
  - origin:  created, dispatched
  - target:  received, running, done, failed
  - watchdog: timeout (origin)
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional


VALID_TRANSITIONS: dict[str, set[str]] = {
    "created":    {"dispatched", "failed"},
    "dispatched": {"received", "failed", "timeout"},
    "received":   {"running", "failed", "timeout"},
    "running":    {"done", "failed", "timeout"},
    "done":       set(),
    "failed":     set(),
    "timeout":    set(),
}

TERMINAL_STATUSES = frozenset({"done", "failed", "timeout"})


class DelegationRecord:
    __slots__ = (
        "delegation_id",
        "status",
        "created_at",
        "updated_at",
        "target_agent",
        "from_agent",
        "task",
        "_messages",
        "_message_ids",
        "result",
        "error",
    )

    def __init__(
        self,
        *,
        delegation_id: str,
        target_agent: str,
        from_agent: str,
        task: dict[str, Any],
    ) -> None:
        self.delegation_id = delegation_id
        self.status = "created"
        now = datetime.now(timezone.utc)
        self.created_at = now
        self.updated_at = now
        self.target_agent = target_agent
        self.from_agent = from_agent
        self.task = task
        # Append-only status event ledger; each entry deduped by message_id
        self._messages: list[dict[str, Any]] = []
        self._message_ids: set[str] = set()
        self.result: Optional[dict[str, Any]] = None
        self.error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "delegationId": self.delegation_id,
            "status": self.status,
            "createdAt": self.created_at.isoformat(),
            "updatedAt": self.updated_at.isoformat(),
            "targetAgent": self.target_agent,
            "fromAgent": self.from_agent,
            "task": self.task,
            "messages": list(self._messages),
            "result": self.result,
            "error": self.error,
        }


class DelegationStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._records: dict[str, DelegationRecord] = {}

    def create(
        self,
        *,
        delegation_id: str,
        target_agent: str,
        from_agent: str,
        task: dict[str, Any],
    ) -> DelegationRecord:
        """Create a new delegation record. Idempotent: returns existing record if already present."""
        with self._lock:
            if delegation_id in self._records:
                return self._records[delegation_id]
            record = DelegationRecord(
                delegation_id=delegation_id,
                target_agent=target_agent,
                from_agent=from_agent,
                task=task,
            )
            # Append 'created' to ledger
            record._messages.append({
                "status": "created",
                "timestamp": record.created_at.isoformat(),
            })
            self._records[delegation_id] = record
            return record

    def transition(
        self,
        delegation_id: str,
        new_status: str,
        *,
        message_id: str | None = None,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> DelegationRecord | None:
        """
        Advance delegation to new_status.

        - Silently drops invalid transitions (wrong source state).
        - Deduplicates by message_id: a repeated message_id is a no-op.
        - Returns updated record, or None if delegation_id unknown.
        """
        with self._lock:
            record = self._records.get(delegation_id)
            if record is None:
                return None

            # Deduplicate by message_id
            if message_id and message_id in record._message_ids:
                return record

            # Validate transition
            if new_status not in VALID_TRANSITIONS.get(record.status, set()):
                return record

            record.status = new_status
            record.updated_at = datetime.now(timezone.utc)
            if result is not None:
                record.result = result
            if error is not None:
                record.error = error

            event: dict[str, Any] = {
                "status": new_status,
                "timestamp": record.updated_at.isoformat(),
            }
            if message_id:
                event["messageId"] = message_id
                record._message_ids.add(message_id)
            if error:
                event["error"] = error
            record._messages.append(event)

            # Metrics (imported lazily to avoid circular imports at module load)
            try:
                from .metrics import record_delegation_transition, record_delegation_duration
                record_delegation_transition(new_status, record.target_agent)
                if new_status in TERMINAL_STATUSES:
                    duration = time.time() - record.created_at.timestamp()
                    record_delegation_duration(duration, record.target_agent)
            except Exception:
                pass

            return record

    def get(self, delegation_id: str) -> DelegationRecord | None:
        with self._lock:
            return self._records.get(delegation_id)

    def list_records(
        self,
        *,
        from_agent: str | None = None,
        target_agent: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[DelegationRecord]:
        with self._lock:
            records = list(self._records.values())

        if from_agent:
            records = [r for r in records if r.from_agent == from_agent]
        if target_agent:
            records = [r for r in records if r.target_agent == target_agent]
        if status:
            records = [r for r in records if r.status == status]

        records.sort(key=lambda r: r.created_at, reverse=True)
        return records[:limit]

    def count(self) -> int:
        with self._lock:
            return len(self._records)


# Module-level singleton
_store: DelegationStore | None = None
_store_lock = threading.Lock()


def get_delegation_store() -> DelegationStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = DelegationStore()
    return _store
