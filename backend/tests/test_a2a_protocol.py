"""
Unit tests for A2A protocol module.

Covers: envelope build/sign/verify, validate_envelope negative cases.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import time
import pytest
from app.services.a2a_protocol import (
    PROTOCOL_VERSION,
    MSG_DELEGATE,
    build_envelope,
    build_status_event,
    sign_envelope,
    verify_envelope_signature,
    validate_envelope,
    _nonce_store,
    _nonce_lock,
)


def _fresh_envelope(**overrides):
    """Build a valid envelope and apply any overrides after construction."""
    env = build_envelope(
        message_type=MSG_DELEGATE,
        from_agent="agent-a",
        to_agent="agent-b",
        delegation_id="d-001",
        payload={"task": {"text": "hello"}},
    )
    env.update(overrides)
    return env


def _clear_nonces():
    with _nonce_lock:
        _nonce_store.clear()


# ── build_envelope ────────────────────────────────────────────────────────────

def test_build_envelope_fields():
    env = _fresh_envelope()
    assert env["protocol"] == PROTOCOL_VERSION
    assert env["message_type"] == MSG_DELEGATE
    assert env["from_agent"] == "agent-a"
    assert env["to_agent"] == "agent-b"
    assert env["delegation_id"] == "d-001"
    assert isinstance(env["timestamp"], int)
    assert "nonce" in env
    assert "message_id" in env
    assert "auth" not in env


def test_build_envelope_with_secret():
    env = build_envelope(
        message_type=MSG_DELEGATE,
        from_agent="a", to_agent="b",
        delegation_id="d-002", payload={},
        secret="s3cr3t",
    )
    assert "auth" in env
    assert env["auth"]["method"] == "hmac-sha256"
    assert isinstance(env["auth"]["signature"], str)


def test_build_envelope_correlation_id():
    env = build_envelope(
        message_type=MSG_DELEGATE,
        from_agent="a", to_agent="b",
        delegation_id="d-003", payload={},
        correlation_id="corr-xyz",
    )
    assert env["correlation_id"] == "corr-xyz"


# ── sign / verify ─────────────────────────────────────────────────────────────

def test_sign_verify_roundtrip():
    env = _fresh_envelope()
    env["auth"] = {"method": "hmac-sha256", "signature": sign_envelope(env, "secret")}
    assert verify_envelope_signature(env, "secret")
    assert not verify_envelope_signature(env, "wrong")


def test_verify_fails_on_tampered_body():
    env = build_envelope(
        message_type=MSG_DELEGATE,
        from_agent="a", to_agent="b",
        delegation_id="d-010", payload={"task": "original"},
        secret="s3cr3t",
    )
    env["payload"] = {"task": "tampered"}
    assert not verify_envelope_signature(env, "s3cr3t")


def test_verify_fails_missing_auth():
    env = _fresh_envelope()
    assert not verify_envelope_signature(env, "any")


# ── validate_envelope — happy path ────────────────────────────────────────────

def test_validate_passes_for_valid_envelope():
    _clear_nonces()
    env = _fresh_envelope()
    validate_envelope(env, self_agent_id="agent-b")  # should not raise


def test_validate_wildcard_recipient():
    _clear_nonces()
    env = build_envelope(
        message_type=MSG_DELEGATE,
        from_agent="a", to_agent="*",
        delegation_id="d-w1", payload={},
    )
    validate_envelope(env, self_agent_id="anyone")


# ── validate_envelope — missing fields ───────────────────────────────────────

@pytest.mark.parametrize("field", [
    "protocol", "message_type", "delegation_id", "from_agent", "to_agent", "nonce"
])
def test_validate_missing_required_field(field):
    _clear_nonces()
    env = _fresh_envelope()
    env.pop(field, None)
    with pytest.raises(ValueError, match=field):
        validate_envelope(env, self_agent_id="agent-b")


def test_validate_missing_timestamp():
    _clear_nonces()
    env = _fresh_envelope()
    env.pop("timestamp")
    with pytest.raises(ValueError, match="timestamp"):
        validate_envelope(env, self_agent_id="agent-b")


# ── validate_envelope — wrong recipient ──────────────────────────────────────

def test_validate_wrong_recipient():
    _clear_nonces()
    env = _fresh_envelope()
    with pytest.raises(ValueError, match="recipient"):
        validate_envelope(env, self_agent_id="agent-c")


# ── validate_envelope — clock skew ───────────────────────────────────────────

def test_validate_expired_timestamp():
    _clear_nonces()
    env = _fresh_envelope()
    env["timestamp"] = int(time.time()) - 999   # way in the past
    with pytest.raises(ValueError, match="clock-skew"):
        validate_envelope(env, self_agent_id="agent-b", clock_skew_seconds=30)


def test_validate_future_timestamp():
    _clear_nonces()
    env = _fresh_envelope()
    env["timestamp"] = int(time.time()) + 999   # way in the future
    with pytest.raises(ValueError, match="clock-skew"):
        validate_envelope(env, self_agent_id="agent-b", clock_skew_seconds=30)


def test_validate_invalid_timestamp_type():
    _clear_nonces()
    env = _fresh_envelope()
    env["timestamp"] = "not-a-number"
    with pytest.raises(ValueError, match="timestamp"):
        validate_envelope(env, self_agent_id="agent-b")


# ── validate_envelope — replay / nonce ───────────────────────────────────────

def test_validate_replay_detected():
    _clear_nonces()
    env = _fresh_envelope()
    validate_envelope(env, self_agent_id="agent-b")  # first: OK
    with pytest.raises(ValueError, match="[Rr]eplayed|nonce"):
        validate_envelope(env, self_agent_id="agent-b")  # second: replay


# ── validate_envelope — HMAC ─────────────────────────────────────────────────

def test_validate_requires_hmac_when_auth_required():
    _clear_nonces()
    env = _fresh_envelope()   # no auth field
    with pytest.raises(ValueError, match="[Ss]ignature|[Aa]uth|[Hh]MAC"):
        validate_envelope(
            env,
            self_agent_id="agent-b",
            require_auth=True,
            shared_secret="s3cr3t",
        )


def test_validate_wrong_hmac():
    _clear_nonces()
    env = build_envelope(
        message_type=MSG_DELEGATE,
        from_agent="a", to_agent="b",
        delegation_id="d-hmac-1", payload={},
        secret="correct-secret",
    )
    with pytest.raises(ValueError, match="[Ss]ignature|[Hh]MAC"):
        validate_envelope(
            env,
            self_agent_id="b",
            require_auth=True,
            shared_secret="wrong-secret",
        )


def test_validate_correct_hmac():
    _clear_nonces()
    env = build_envelope(
        message_type=MSG_DELEGATE,
        from_agent="a", to_agent="b",
        delegation_id="d-hmac-2", payload={},
        secret="correct-secret",
    )
    validate_envelope(
        env,
        self_agent_id="b",
        require_auth=True,
        shared_secret="correct-secret",
    )  # should not raise


# ── build_status_event ────────────────────────────────────────────────────────

def test_build_status_event_fields():
    ev = build_status_event(
        delegation_id="d-001",
        status="done",
        from_agent="agent-b",
        result={"content": "result text"},
    )
    assert ev["delegation_id"] == "d-001"
    assert ev["status"] == "done"
    assert ev["from_agent"] == "agent-b"
    assert ev["payload"]["result"] == {"content": "result text"}
    assert "event_id" in ev
    # No protocol/nonce/auth fields
    assert "protocol" not in ev
    assert "auth" not in ev


def test_build_status_event_with_error():
    ev = build_status_event(
        delegation_id="d-002",
        status="failed",
        from_agent="agent-b",
        error="connection refused",
    )
    assert ev["payload"]["error"] == "connection refused"
