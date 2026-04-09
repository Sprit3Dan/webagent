"""
A2A protocol module — aligned with nanobot-a2a/v1.

Protocol constants, envelope construction, HMAC auth, replay prevention, validation.
Cross-system compatibility with nanobot: same protocol string, message types,
timestamp format (Unix int), and auth structure.
"""
from __future__ import annotations

import hashlib
import hmac as _hmac
import json
import time
from threading import Lock
from typing import Any
from uuid import uuid4

PROTOCOL_VERSION = "nanobot-a2a/v1"
AUTH_METHOD = "hmac-sha256"

# Envelope message types
MSG_DELEGATE = "delegation_request"   # inbound delegation (nanobot canonical name)
MSG_STATUS = "status"                 # status event (flat format, not an envelope)
MSG_RESULT = "result"

VALID_STATUSES = frozenset({"created", "dispatched", "received", "running", "done", "failed", "timeout"})
TERMINAL_STATUSES = frozenset({"done", "failed", "timeout"})

# Module-level nonce store: {nonce: recorded_unix_timestamp}
_nonce_lock = Lock()
_nonce_store: dict[str, float] = {}


def _canonical_json(obj: Any) -> bytes:
    """Serialize to canonical (sorted-keys, no-spaces) JSON bytes."""
    return json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str
    ).encode("utf-8")


def sign_envelope(envelope: dict[str, Any], secret: str) -> str:
    """HMAC-SHA256 hex signature. Excludes 'auth' field from the signing body."""
    payload = {k: v for k, v in envelope.items() if k != "auth"}
    return _hmac.new(
        secret.encode("utf-8"), _canonical_json(payload), hashlib.sha256
    ).hexdigest()


def verify_envelope_signature(envelope: dict[str, Any], secret: str) -> bool:
    auth = envelope.get("auth")
    if not isinstance(auth, dict):
        return False
    received = str(auth.get("signature") or "")
    if not received:
        return False
    expected = sign_envelope(envelope, secret)
    return _hmac.compare_digest(expected, received)


def build_envelope(
    *,
    message_type: str,
    from_agent: str,
    to_agent: str,
    delegation_id: str,
    payload: dict[str, Any],
    secret: str | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """
    Construct an A2A delegation envelope.

    timestamp is a Unix integer (nanobot-compatible).
    auth field uses {"method": "hmac-sha256", "signature": "..."} structure.
    correlation_id is optional; propagated end-to-end for observability.
    """
    envelope: dict[str, Any] = {
        "protocol": PROTOCOL_VERSION,
        "message_type": message_type,
        "delegation_id": delegation_id,
        "message_id": str(uuid4()),
        "from_agent": from_agent,
        "to_agent": to_agent,
        "timestamp": int(time.time()),
        "nonce": str(uuid4()),
        "payload": payload,
    }
    if correlation_id:
        envelope["correlation_id"] = correlation_id
    if secret:
        envelope["auth"] = {
            "method": AUTH_METHOD,
            "signature": sign_envelope(envelope, secret),
        }
    return envelope


def build_status_event(
    *,
    delegation_id: str,
    status: str,
    from_agent: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """
    Build a flat status event (nanobot-compatible).

    Unlike delegation envelopes, status events carry no protocol/nonce/auth fields.
    They are identified solely by delegation_id and status.
    """
    event: dict[str, Any] = {
        "event_id": str(uuid4()),
        "delegation_id": delegation_id,
        "status": status,
        "from_agent": from_agent,
        "payload": {},
    }
    if result is not None:
        event["payload"]["result"] = result
    if error is not None:
        event["payload"]["error"] = error
    if correlation_id:
        event["correlation_id"] = correlation_id
    return event


def _purge_expired_nonces(now: float, ttl: int) -> None:
    cutoff = now - ttl
    expired = [k for k, recorded_at in _nonce_store.items() if recorded_at < cutoff]
    for k in expired:
        del _nonce_store[k]


def validate_envelope(
    envelope: dict[str, Any],
    *,
    self_agent_id: str,
    require_auth: bool = False,
    shared_secret: str | None = None,
    clock_skew_seconds: int = 30,
    nonce_ttl_seconds: int = 300,
) -> None:
    """
    Validate an inbound A2A envelope. Raises ValueError with reason on failure.

    Checks (in order):
      1. Required fields present
      2. Protocol version matches
      3. Recipient matches self_agent_id or wildcard "*"
      4. Timestamp within clock-skew window (Unix int)
      5. Nonce not previously seen (replay prevention)
      6. HMAC signature valid (if require_auth)
    """
    # 1. Required fields
    for field in ("protocol", "message_type", "delegation_id", "from_agent", "to_agent", "nonce"):
        if not envelope.get(field):
            raise ValueError(f"Missing required field: {field!r}")

    if "timestamp" not in envelope:
        raise ValueError("Missing required field: 'timestamp'")

    # 2. Protocol
    if envelope["protocol"] != PROTOCOL_VERSION:
        raise ValueError(f"Unknown protocol: {envelope['protocol']!r}")

    # 3. Recipient — accept explicit match or wildcard
    to_agent = envelope["to_agent"]
    if to_agent != self_agent_id and to_agent != "*":
        raise ValueError(f"Wrong recipient: expected {self_agent_id!r}, got {to_agent!r}")

    # 4. Clock skew — timestamp must be Unix integer seconds
    ts = envelope["timestamp"]
    if not isinstance(ts, (int, float)):
        raise ValueError(f"Invalid timestamp type: {type(ts).__name__!r}")
    age = abs(time.time() - float(ts))
    if age > clock_skew_seconds:
        raise ValueError(
            f"Timestamp outside clock-skew window: age={age:.1f}s max={clock_skew_seconds}s"
        )

    # 5. Replay prevention
    nonce = str(envelope["nonce"])
    now = time.time()
    with _nonce_lock:
        _purge_expired_nonces(now, nonce_ttl_seconds)
        if nonce in _nonce_store:
            raise ValueError(f"Replayed nonce: {nonce!r}")
        _nonce_store[nonce] = now

    # 6. HMAC
    if require_auth:
        if not shared_secret:
            raise ValueError("Auth required but no shared secret configured")
        if not verify_envelope_signature(envelope, shared_secret):
            raise ValueError("HMAC signature verification failed")
