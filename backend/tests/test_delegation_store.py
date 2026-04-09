"""
Unit tests for DelegationStore: state machine, idempotency, list/filter.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from app.services.delegation_store import DelegationStore, TERMINAL_STATUSES


@pytest.fixture
def store():
    return DelegationStore()


def _create(store, did="d-1"):
    return store.create(
        delegation_id=did,
        target_agent="agent-b",
        from_agent="agent-a",
        task={"text": "test"},
    )


# ── create ────────────────────────────────────────────────────────────────────

def test_create_initial_status(store):
    rec = _create(store)
    assert rec.status == "created"
    assert rec.delegation_id == "d-1"
    assert rec.target_agent == "agent-b"
    assert rec.from_agent == "agent-a"


def test_create_idempotent(store):
    rec1 = _create(store, "d-idem")
    rec2 = _create(store, "d-idem")
    assert rec1 is rec2


def test_create_adds_created_event(store):
    rec = _create(store)
    assert any(e["status"] == "created" for e in rec._messages)


# ── transition — happy path ───────────────────────────────────────────────────

def test_full_happy_path(store):
    _create(store, "d-happy")
    store.transition("d-happy", "dispatched")
    store.transition("d-happy", "received", message_id="msg-1")
    store.transition("d-happy", "running")
    store.transition("d-happy", "done", result={"content": "ok"})
    rec = store.get("d-happy")
    assert rec.status == "done"
    assert rec.result == {"content": "ok"}


def test_failed_path(store):
    _create(store, "d-fail")
    store.transition("d-fail", "dispatched")
    store.transition("d-fail", "failed", error="timeout")
    rec = store.get("d-fail")
    assert rec.status == "failed"
    assert rec.error == "timeout"


# ── transition — invalid / terminal ──────────────────────────────────────────

def test_invalid_transition_silently_ignored(store):
    _create(store, "d-inv")
    store.transition("d-inv", "done")   # created -> done is not valid
    assert store.get("d-inv").status == "created"


def test_terminal_transition_ignored(store):
    _create(store, "d-term")
    store.transition("d-term", "dispatched")
    store.transition("d-term", "received")
    store.transition("d-term", "running")
    store.transition("d-term", "done")      # valid terminal
    store.transition("d-term", "failed")    # terminal → further transitions ignored
    assert store.get("d-term").status == "done"


def test_all_terminal_statuses_block_further_transitions(store):
    for terminal in TERMINAL_STATUSES:
        did = f"d-terminal-{terminal}"
        _create(store, did)
        # fast-track to dispatched first
        store.transition(did, "dispatched")
        # simulate terminal
        store._records[did].status = terminal
        store.transition(did, "running")
        assert store.get(did).status == terminal


# ── transition — message_id deduplication ────────────────────────────────────

def test_message_id_deduplicate(store):
    _create(store, "d-dedup")
    store.transition("d-dedup", "dispatched")
    store.transition("d-dedup", "received", message_id="msg-abc")
    # Same message_id — should be no-op, status stays received
    store.transition("d-dedup", "running", message_id="msg-abc")
    assert store.get("d-dedup").status == "received"


def test_different_message_ids_allowed(store):
    _create(store, "d-msgs")
    store.transition("d-msgs", "dispatched", message_id="msg-1")
    store.transition("d-msgs", "received", message_id="msg-2")
    assert store.get("d-msgs").status == "received"


# ── get / count ───────────────────────────────────────────────────────────────

def test_get_unknown_returns_none(store):
    assert store.get("nonexistent") is None


def test_count(store):
    assert store.count() == 0
    _create(store, "d-c1")
    _create(store, "d-c2")
    assert store.count() == 2


# ── list_records ──────────────────────────────────────────────────────────────

def test_list_records_unfiltered(store):
    _create(store, "d-l1")
    _create(store, "d-l2")
    records = store.list_records()
    assert len(records) == 2


def test_list_records_filter_by_status(store):
    _create(store, "d-ls1")
    _create(store, "d-ls2")
    store.transition("d-ls1", "dispatched")
    records = store.list_records(status="created")
    assert len(records) == 1
    assert records[0].delegation_id == "d-ls2"


def test_list_records_filter_by_from_agent(store):
    store.create(delegation_id="d-fa1", target_agent="b", from_agent="alice", task={})
    store.create(delegation_id="d-fa2", target_agent="b", from_agent="bob", task={})
    records = store.list_records(from_agent="alice")
    assert len(records) == 1
    assert records[0].from_agent == "alice"


def test_list_records_limit(store):
    for i in range(10):
        _create(store, f"d-lim-{i}")
    records = store.list_records(limit=3)
    assert len(records) == 3


# ── to_dict ───────────────────────────────────────────────────────────────────

def test_to_dict_shape(store):
    _create(store, "d-dict")
    store.transition("d-dict", "dispatched")
    d = store.get("d-dict").to_dict()
    assert d["delegationId"] == "d-dict"
    assert d["status"] == "dispatched"
    assert isinstance(d["messages"], list)
    assert isinstance(d["createdAt"], str)
