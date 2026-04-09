import React, { useEffect, useRef, useState } from "react";
import { normalizeRoute } from "../lib/utils";

const POLL_INTERVAL_MS = 2000;

const STATUS_COLORS = {
  created:    "#6f8499",
  dispatched: "#5ea0d8",
  received:   "#7bb8e8",
  running:    "#f0c040",
  done:       "#4caf76",
  failed:     "#e05050",
  timeout:    "#c0804a",
};

function statusColor(status) {
  return STATUS_COLORS[status] || "#8fb0c9";
}

function pill(status) {
  return (
    <span
      style={{
        display: "inline-block",
        background: statusColor(status) + "22",
        color: statusColor(status),
        border: `1px solid ${statusColor(status)}55`,
        borderRadius: 4,
        padding: "1px 7px",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
      }}
    >
      {status}
    </span>
  );
}

function cardStyle() {
  return {
    border: "1px solid #24303d",
    borderRadius: 8,
    background: "#0f1720",
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    minHeight: 0,
  };
}

function inputStyle() {
  return {
    width: "100%",
    background: "#0b121a",
    color: "#d6e2ee",
    border: "1px solid #2a394a",
    borderRadius: 6,
    padding: "8px 10px",
    outline: "none",
    fontSize: 13,
    boxSizing: "border-box",
  };
}

function labelStyle() {
  return {
    display: "block",
    marginBottom: 4,
    color: "#8fb0c9",
    fontSize: 11,
    letterSpacing: "0.03em",
    textTransform: "uppercase",
  };
}

function buttonStyle(variant = "default") {
  const base = {
    borderRadius: 6,
    padding: "6px 14px",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  };
  if (variant === "primary") {
    return { ...base, background: "#1a6ea8", border: "1px solid #2580be", color: "#d6e2ee" };
  }
  return { ...base, background: "#102132", border: "1px solid #2f4257", color: "#c7d5e2" };
}

function DelegationRow({ delegation, onSelect, selected }) {
  const isSelected = selected?.delegationId === delegation.delegationId;
  return (
    <div
      onClick={() => onSelect(isSelected ? null : delegation)}
      style={{
        padding: "8px 10px",
        borderBottom: "1px solid #1a2733",
        cursor: "pointer",
        background: isSelected ? "#0d2035" : "transparent",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        userSelect: "none",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3 }}>
          {pill(delegation.status)}
          <span style={{ color: "#8fb0c9", fontSize: 11, fontFamily: "monospace" }}>
            {delegation.delegationId?.slice(0, 8)}…
          </span>
        </div>
        <div style={{ color: "#c0d0df", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {delegation.fromAgent} → {delegation.targetAgent}
        </div>
        <div style={{ color: "#6f8499", fontSize: 11, marginTop: 2 }}>
          {new Date(delegation.createdAt).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}

function DelegationDetail({ delegation }) {
  if (!delegation) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {pill(delegation.status)}
        <span style={{ color: "#8ca1b4", fontFamily: "monospace", fontSize: 12 }}>
          {delegation.delegationId}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: "4px 10px" }}>
        <span style={{ color: "#6f8499" }}>from</span>
        <span style={{ color: "#d0dce8" }}>{delegation.fromAgent}</span>
        <span style={{ color: "#6f8499" }}>to</span>
        <span style={{ color: "#d0dce8" }}>{delegation.targetAgent}</span>
        <span style={{ color: "#6f8499" }}>created</span>
        <span style={{ color: "#d0dce8" }}>{new Date(delegation.createdAt).toLocaleString()}</span>
        <span style={{ color: "#6f8499" }}>updated</span>
        <span style={{ color: "#d0dce8" }}>{new Date(delegation.updatedAt).toLocaleString()}</span>
      </div>
      {delegation.result && (
        <div>
          <div style={labelStyle()}>Result</div>
          <pre style={{
            background: "#080e14", border: "1px solid #1e2e3e", borderRadius: 6,
            padding: "8px 10px", color: "#a8d0a0", fontSize: 12,
            overflow: "auto", maxHeight: 180, margin: 0,
          }}>
            {JSON.stringify(delegation.result, null, 2)}
          </pre>
        </div>
      )}
      {delegation.error && (
        <div>
          <div style={labelStyle()}>Error</div>
          <div style={{
            background: "#2a0f0f", border: "1px solid #55333a", borderRadius: 6,
            padding: "8px 10px", color: "#ffc9cf", fontSize: 12,
          }}>
            {delegation.error}
          </div>
        </div>
      )}
      {delegation.messages?.length > 0 && (
        <div>
          <div style={labelStyle()}>Event ledger</div>
          <div style={{
            background: "#080e14", border: "1px solid #1e2e3e", borderRadius: 6,
            padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4,
            maxHeight: 160, overflow: "auto",
          }}>
            {delegation.messages.map((ev, i) => (
              <div key={i} style={{ display: "flex", gap: 10, fontSize: 11 }}>
                <span style={{ color: "#4a6070", minWidth: 70 }}>
                  {new Date(ev.timestamp).toLocaleTimeString()}
                </span>
                {pill(ev.status)}
                {ev.error && <span style={{ color: "#e08080" }}>{ev.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function A2APane({ delegations = [], onRefresh, onDelegate, a2aEnabled }) {
  const [selected, setSelected] = useState(null);
  const [taskText, setTaskText] = useState("");
  const [targetAgent, setTargetAgent] = useState("");
  const [intent, setIntent] = useState("");
  const [delegating, setDelegating] = useState(false);
  const [delegateError, setDelegateError] = useState("");
  const pollRef = useRef(null);

  // Auto-refresh
  useEffect(() => {
    if (!a2aEnabled) return;
    pollRef.current = setInterval(onRefresh, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [a2aEnabled, onRefresh]);

  // Keep selected in sync with refreshed list
  useEffect(() => {
    if (!selected) return;
    const updated = delegations.find(d => d.delegationId === selected.delegationId);
    if (updated) setSelected(updated);
  }, [delegations]);

  async function handleDelegate(e) {
    e.preventDefault();
    if (!taskText.trim()) return;
    setDelegating(true);
    setDelegateError("");
    try {
      const result = await onDelegate({ task: taskText, targetAgent, intent });
      if (result?.error) setDelegateError(result.error);
      else {
        setTaskText("");
        onRefresh();
      }
    } catch (err) {
      setDelegateError(String(err));
    } finally {
      setDelegating(false);
    }
  }

  if (!a2aEnabled) {
    return (
      <div style={{ padding: 24, color: "#6f8499", fontSize: 14 }}>
        A2A is disabled. Set <code>A2A_ENABLED=true</code> on the backend to enable agent delegation.
      </div>
    );
  }

  return (
    <div style={{
      minHeight: 0,
      overflow: "auto",
      padding: 12,
      display: "grid",
      gridTemplateColumns: "minmax(260px, 340px) minmax(0, 1fr)",
      gap: 12,
      alignItems: "start",
    }}>

      {/* Left: list + delegate form */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={cardStyle()}>
          <h3 style={{ margin: 0, color: "#cfe0ef", fontSize: 14 }}>Delegate Task</h3>
          <form onSubmit={handleDelegate} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <label style={labelStyle()}>Task</label>
              <textarea
                value={taskText}
                onChange={e => setTaskText(e.target.value)}
                rows={3}
                placeholder="Describe the task to delegate…"
                style={{ ...inputStyle(), resize: "vertical" }}
              />
            </div>
            <div>
              <label style={labelStyle()}>Target Agent (optional)</label>
              <input
                value={targetAgent}
                onChange={e => setTargetAgent(e.target.value)}
                placeholder="agent-id or leave blank for discovery"
                style={inputStyle()}
              />
            </div>
            <div>
              <label style={labelStyle()}>Intent (optional)</label>
              <input
                value={intent}
                onChange={e => setIntent(e.target.value)}
                placeholder="e.g. summarize, translate, analyze"
                style={inputStyle()}
              />
            </div>
            {delegateError && (
              <div style={{ color: "#e07070", fontSize: 12 }}>{delegateError}</div>
            )}
            <button
              type="submit"
              disabled={delegating || !taskText.trim()}
              style={{ ...buttonStyle("primary"), opacity: delegating ? 0.6 : 1 }}
            >
              {delegating ? "Delegating…" : "Delegate"}
            </button>
          </form>
        </div>

        <div style={cardStyle()}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0, color: "#cfe0ef", fontSize: 14 }}>
              Delegations ({delegations.length})
            </h3>
            <button onClick={onRefresh} style={buttonStyle()}>Refresh</button>
          </div>
          <div style={{
            maxHeight: "40vh",
            overflow: "auto",
            borderTop: "1px solid #1e2e3e",
            borderBottom: "1px solid #1e2e3e",
          }}>
            {delegations.length === 0 ? (
              <div style={{ color: "#4a6070", fontSize: 12, padding: "10px 0" }}>
                No delegations yet
              </div>
            ) : (
              delegations.map(d => (
                <DelegationRow
                  key={d.delegationId}
                  delegation={d}
                  onSelect={setSelected}
                  selected={selected}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Right: detail */}
      <div style={cardStyle()}>
        {selected ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, color: "#cfe0ef", fontSize: 14 }}>Delegation Detail</h3>
              <button onClick={() => setSelected(null)} style={buttonStyle()}>Close</button>
            </div>
            <DelegationDetail delegation={selected} />
          </>
        ) : (
          <div style={{ color: "#4a6070", fontSize: 13, padding: "8px 0" }}>
            Select a delegation to inspect it.
          </div>
        )}
      </div>
    </div>
  );
}
