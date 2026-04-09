"""
Prometheus metrics for A2A delegation observability.

All metrics are no-ops if prometheus_client is not installed, so the
rest of the codebase can import from here unconditionally.
"""
from __future__ import annotations

from typing import Any

try:
    from prometheus_client import Counter, Histogram, REGISTRY  # noqa: F401

    _ENABLED = True

    a2a_delegations_total = Counter(
        "a2a_delegations_total",
        "Total A2A delegation status transitions",
        ["status", "target_agent"],
    )

    a2a_delegation_duration_seconds = Histogram(
        "a2a_delegation_duration_seconds",
        "Duration from delegation creation to terminal state",
        ["target_agent"],
        buckets=[0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    )

    a2a_envelope_validation_failures_total = Counter(
        "a2a_envelope_validation_failures_total",
        "A2A envelope validation failures",
        ["reason"],
    )

    a2a_transport_reconnects_total = Counter(
        "a2a_transport_reconnects_total",
        "NATS transport reconnect events",
        [],
    )

except ImportError:
    _ENABLED = False

    class _Noop:
        """Silent no-op for all metric calls."""
        def labels(self, **_kw: Any) -> "_Noop":
            return self
        def inc(self, _amount: float = 1) -> None:
            pass
        def observe(self, _value: float) -> None:
            pass
        def time(self):
            import contextlib
            return contextlib.nullcontext()

    _noop = _Noop()
    a2a_delegations_total = _noop           # type: ignore[assignment]
    a2a_delegation_duration_seconds = _noop  # type: ignore[assignment]
    a2a_envelope_validation_failures_total = _noop  # type: ignore[assignment]
    a2a_transport_reconnects_total = _noop  # type: ignore[assignment]


def record_delegation_transition(status: str, target_agent: str) -> None:
    """Increment delegation counter on every status transition."""
    a2a_delegations_total.labels(status=status, target_agent=target_agent).inc()


def record_delegation_duration(duration_seconds: float, target_agent: str) -> None:
    """Record end-to-end duration when a delegation reaches a terminal state."""
    a2a_delegation_duration_seconds.labels(target_agent=target_agent).observe(duration_seconds)


def record_envelope_validation_failure(reason: str) -> None:
    """Increment envelope validation failure counter."""
    # Normalize reason to a short label (first segment before colon/comma/space)
    short = str(reason).split(":")[0].split(",")[0].strip()[:64]
    a2a_envelope_validation_failures_total.labels(reason=short).inc()


def record_transport_reconnect() -> None:
    """Increment NATS reconnect counter."""
    a2a_transport_reconnects_total.inc()
