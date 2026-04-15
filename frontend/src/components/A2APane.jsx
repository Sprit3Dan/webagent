import React, { useEffect, useRef, useState } from "react";
import { normalizeRoute } from "../lib/utils";

const POLL_INTERVAL_MS = 10000;

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

function AgentRow({ agent, onSelect, selected }) {
  const agentId = agent?.agent_id || agent?.agentId || "";
  const isSelected = selected && (selected.agent_id || selected.agentId) === agentId;
  const caps = agent?.capabilities && typeof agent.capabilities === "object" ? agent.capabilities : {};
  const skills = Array.isArray(caps.skills) ? caps.skills : [];
  return (
    <div
      onClick={() => onSelect(isSelected ? null : agent)}
      style={{
        padding: "8px 10px",
        borderBottom: "1px solid #1a2733",
        cursor: "pointer",
        background: isSelected ? "#0d2035" : "transparent",
        userSelect: "none",
      }}
    >
      <div style={{ color: "#d0dce8", fontWeight: 600, fontSize: 12 }}>{agentId || "unknown-agent"}</div>
      {caps.description ? (
        <div style={{ color: "#8fb0c9", fontSize: 12, marginTop: 3 }}>{caps.description}</div>
      ) : null}
      <div style={{ color: "#6f8499", fontSize: 11, marginTop: 4 }}>
        skills: {skills.length}
      </div>
    </div>
  );
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

function AgentDetail({ agent }) {
  if (!agent) return null;
  const caps = agent?.capabilities && typeof agent.capabilities === "object" ? agent.capabilities : {};
  const skills = Array.isArray(caps.skills) ? caps.skills : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
      <div style={{ color: "#d0dce8", fontWeight: 600, fontSize: 14 }}>
        {agent.agent_id || agent.agentId || "unknown-agent"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "4px 10px" }}>
        <span style={{ color: "#6f8499" }}>endpoint</span>
        <span style={{ color: "#d0dce8" }}>{String(agent.base_url || "").trim() || "n/a"}</span>
        <span style={{ color: "#6f8499" }}>transport</span>
        <span style={{ color: "#d0dce8" }}>{String(agent.transport || "").trim() || "n/a"}</span>
        <span style={{ color: "#6f8499" }}>protocol</span>
        <span style={{ color: "#d0dce8" }}>{String(agent.protocol || "").trim() || "n/a"}</span>
      </div>
      {caps.description ? (
        <div>
          <div style={labelStyle()}>Description</div>
          <div style={{ color: "#8fb0c9", fontSize: 12 }}>{caps.description}</div>
        </div>
      ) : null}
      <div>
        <div style={labelStyle()}>Capabilities JSON</div>
        <pre style={{
          background: "#080e14", border: "1px solid #1e2e3e", borderRadius: 6,
          padding: "8px 10px", color: "#b9cbe0", fontSize: 12,
          overflow: "auto", maxHeight: 280, margin: 0,
        }}>
          {JSON.stringify(caps, null, 2)}
        </pre>
      </div>
      <div>
        <div style={labelStyle()}>Skills</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {skills.length ? (
            skills.map((s, i) => (
              <span
                key={`detail-skill-${i}`}
                style={{
                  border: "1px solid #2f4257",
                  color: "#b9cbe0",
                  background: "#102132",
                  borderRadius: 4,
                  padding: "1px 6px",
                  fontSize: 11,
                }}
              >
                {String(s?.name || "").trim() || "unnamed-skill"}
              </span>
            ))
          ) : (
            <span style={{ color: "#63798e", fontSize: 11 }}>No skills listed</span>
          )}
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

export default function A2APane({
  delegations = [],
  onRefresh,
  onLoadSpecialists,
  a2aEnabled,
  a2aBackendDefaultEnabled = false,
  onA2aEnabledChange,
}) {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [selectedDelegation, setSelectedDelegation] = useState(null);
  const [specialists, setSpecialists] = useState([]);
  const [specialistsLoading, setSpecialistsLoading] = useState(false);
  const [specialistsError, setSpecialistsError] = useState("");
  const pollRef = useRef(null);

  const safeRefresh = () => {
    if (!a2aEnabled) return;
    onRefresh?.();
  };

  const loadSpecialists = async () => {
    if (!a2aEnabled) {
      setSpecialists([]);
      setSpecialistsError("");
      return;
    }
    setSpecialistsLoading(true);
    setSpecialistsError("");
    try {
      const result = await onLoadSpecialists?.();
      if (result?.error) {
        setSpecialistsError(String(result.error));
        setSpecialists([]);
      } else {
        setSpecialists(Array.isArray(result?.specialists) ? result.specialists : []);
      }
    } catch (err) {
      setSpecialistsError(String(err));
      setSpecialists([]);
    } finally {
      setSpecialistsLoading(false);
    }
  };

  // Auto-refresh delegations only; specialists load on enter + manual refresh
  useEffect(() => {
    if (!a2aEnabled) {
      setSpecialists([]);
      setSpecialistsError("");
      return;
    }
    safeRefresh();
    void loadSpecialists();
    pollRef.current = setInterval(() => {
      safeRefresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [a2aEnabled, onRefresh, onLoadSpecialists]);

  // Keep selected delegation in sync with refreshed list
  useEffect(() => {
    if (!selectedDelegation) return;
    const updated = delegations.find((d) => d.delegationId === selectedDelegation.delegationId);
    if (updated) setSelectedDelegation(updated);
  }, [delegations, selectedDelegation]);

  // Keep selected agent in sync with refreshed specialists list
  useEffect(() => {
    if (!selectedAgent) return;
    const selectedId = selectedAgent.agent_id || selectedAgent.agentId;
    const updated = specialists.find(
      (a) => (a.agent_id || a.agentId) === selectedId,
    );
    if (updated) setSelectedAgent(updated);
  }, [specialists, selectedAgent]);

  if (!a2aEnabled) {
    return (
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ color: "#6f8499", fontSize: 14 }}>
          A2A delegation is currently disabled in UI settings.
        </div>
        <div style={{ color: "#8fb0c9", fontSize: 12 }}>
          Backend default is <code>{a2aBackendDefaultEnabled ? "enabled" : "disabled"}</code>.
        </div>
        <div>
          <button
            onClick={() => onA2aEnabledChange?.(true)}
            style={buttonStyle("primary")}
          >
            Enable A2A in UI
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: 0,
      overflow: "auto",
      padding: 12,
      display: "grid",
      gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)",
      gap: 12,
      alignItems: "start",
    }}>
      {/* Left: lists */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={cardStyle()}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0, color: "#cfe0ef", fontSize: 14 }}>
              Agents Available ({specialists.length})
            </h3>
            <button
              onClick={() => {
                safeRefresh();
                void loadSpecialists();
              }}
              style={buttonStyle()}
            >
              Refresh
            </button>
          </div>
          {specialistsError && (
            <div style={{ color: "#e07070", fontSize: 12 }}>{specialistsError}</div>
          )}
          <div style={{
            maxHeight: "32vh",
            overflow: "auto",
            borderTop: "1px solid #1e2e3e",
            borderBottom: "1px solid #1e2e3e",
          }}>
            {specialistsLoading ? (
              <div style={{ color: "#6f8499", fontSize: 12, padding: "10px 0" }}>
                Loading agents…
              </div>
            ) : specialists.length === 0 ? (
              <div style={{ color: "#4a6070", fontSize: 12, padding: "10px 0" }}>
                No agents registered
              </div>
            ) : (
              specialists.map((agent, idx) => (
                <AgentRow
                  key={agent.agent_id || agent.agentId || `agent-${idx}`}
                  agent={agent}
                  selected={selectedAgent}
                  onSelect={(value) => {
                    setSelectedAgent(value);
                    if (value) setSelectedDelegation(null);
                  }}
                />
              ))
            )}
          </div>
        </div>

        <div style={cardStyle()}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0, color: "#cfe0ef", fontSize: 14 }}>
              Delegations ({delegations.length})
            </h3>
            <button onClick={safeRefresh} style={buttonStyle()}>Refresh</button>
          </div>
          <div style={{
            maxHeight: "34vh",
            overflow: "auto",
            borderTop: "1px solid #1e2e3e",
            borderBottom: "1px solid #1e2e3e",
          }}>
            {delegations.length === 0 ? (
              <div style={{ color: "#4a6070", fontSize: 12, padding: "10px 0" }}>
                No delegations yet
              </div>
            ) : (
              delegations.map((d) => (
                <DelegationRow
                  key={d.delegationId}
                  delegation={d}
                  selected={selectedDelegation}
                  onSelect={(value) => {
                    setSelectedDelegation(value);
                    if (value) setSelectedAgent(null);
                  }}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Right: conditional detail panel */}
      <div style={cardStyle()}>
        {selectedAgent ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, color: "#cfe0ef", fontSize: 14 }}>Agent Detail</h3>
              <button onClick={() => setSelectedAgent(null)} style={buttonStyle()}>Close</button>
            </div>
            <AgentDetail agent={selectedAgent} />
          </>
        ) : selectedDelegation ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, color: "#cfe0ef", fontSize: 14 }}>Delegation Detail</h3>
              <button onClick={() => setSelectedDelegation(null)} style={buttonStyle()}>Close</button>
            </div>
            <DelegationDetail delegation={selectedDelegation} />
          </>
        ) : (
          <div style={{ color: "#4a6070", fontSize: 13, padding: "8px 0" }}>
            Select an agent or a delegation to inspect details.
          </div>
        )}
      </div>
    </div>
  );
}
