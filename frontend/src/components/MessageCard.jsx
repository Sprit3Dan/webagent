import React from "react";
import ReactMarkdown from "react-markdown";

const runtimeShared = globalThis?.WebagentRuntimeShared;
if (!runtimeShared) {
  throw new Error("Shared runtime module is required");
}

function sanitizeMessage(m) {
  return runtimeShared.sanitizeMessage(m, "assistant");
}

function isA2ALifecycleAssistantMessage(message) {
  const messageType = String(message?.message_type || "").trim().toLowerCase();
  return messageType === "a2a.lifecycle";
}

function roleStyle(role) {
  if (role === "user") {
    return {
      accent: "#ffd166",
      background: "rgba(255, 209, 102, 0.06)",
    };
  }

  if (role === "assistant") {
    return {
      accent: "#73d0ff",
      background: "rgba(115, 208, 255, 0.06)",
    };
  }

  if (role === "tool") {
    return {
      accent: "#8df7ac",
      background: "rgba(141, 247, 172, 0.05)",
    };
  }

  return {
    accent: "#9fb3c8",
    background: "rgba(159, 179, 200, 0.04)",
  };
}

function splitToolMessageContent(content) {
  const raw = String(content || "");
  const marker = "\n\nresult:\n";
  const idx = raw.indexOf(marker);

  if (idx < 0) {
    return {
      call: raw.trim(),
      result: "",
    };
  }

  return {
    call: raw.slice(0, idx).trim(),
    result: raw.slice(idx + marker.length).trim(),
  };
}

function formatToolResult(resultText) {
  const raw = String(resultText || "").trim();
  if (!raw) return "";

  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default function MessageCard({ msg }) {
  const m = sanitizeMessage(msg);
  const role = m.role.toLowerCase();
  const isA2A = isA2ALifecycleAssistantMessage(m);
  const baseStyle = roleStyle(role);
  const accent = isA2A ? "#b388ff" : baseStyle.accent;
  const background = isA2A ? "rgba(179, 136, 255, 0.12)" : baseStyle.background;
  const roleLabel = isA2A ? "A2A" : role.toUpperCase();
  const promptMemories = Array.isArray(m?.prompt_memories) ? m.prompt_memories : [];
  const retrievedFacts = Array.isArray(m?.retrieved_facts) ? m.retrieved_facts : [];
  const retrievedFactMeta =
    m?.retrieved_fact_meta && typeof m.retrieved_fact_meta === "object"
      ? m.retrieved_fact_meta
      : null;
  const isToolMessage = role === "tool";
  const toolMessage = isToolMessage ? splitToolMessageContent(m.content) : null;
  const toolResult = isToolMessage ? formatToolResult(toolMessage?.result || "") : "";

  return (
    <article
      style={{
        borderStyle: "solid",
        borderColor: accent,
        borderWidth: "0 0 0 3px",
        borderRadius: 0,
        background,
        padding: "8px 10px",
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: accent,
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span>{roleLabel}</span>
        <span style={{ color: "#93a6b7" }}>{m.timestamp}</span>
      </div>

      {isToolMessage ? (
        <details style={{ marginTop: 2 }}>
          <summary style={{ cursor: "pointer", color: "#93a6b7", fontSize: 12 }}>
            {toolMessage?.call || "tool result"}
          </summary>
          {toolResult ? (
            <pre
              style={{
                margin: "8px 0 0",
                color: "#c7d5e2",
                whiteSpace: "pre-wrap",
                borderLeft: "1px solid #2a394a",
                paddingLeft: 8,
              }}
            >
              {toolResult}
            </pre>
          ) : (
            <div style={{ marginTop: 8, color: "#8fa3b6", fontSize: 12 }}>
              No result payload
            </div>
          )}
        </details>
      ) : (
        <div style={{ lineHeight: 1.45, color: "#d6e2ee" }}>
          <ReactMarkdown>{m.content}</ReactMarkdown>
        </div>
      )}

      {role === "user" && retrievedFacts.length ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", color: "#93a6b7", fontSize: 12 }}>
            retrieved facts ({retrievedFacts.length})
          </summary>
          {retrievedFactMeta ? (
            <div style={{ marginTop: 6, fontSize: 11, color: "#8fb2cf" }}>
              minScore={Number(retrievedFactMeta.minScore || 0).toFixed(3)} · topK=
              {Number(retrievedFactMeta.topK || 0)} · retrievalMs=
              {Math.round(Number(retrievedFactMeta.retrievalMs || 0))} · hits=
              {Number(retrievedFactMeta.hitCount || retrievedFacts.length)}
            </div>
          ) : null}
          <div
            style={{
              margin: "8px 0 0",
              color: "#c7d5e2",
              borderLeft: "1px solid #2a394a",
              paddingLeft: 8,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {retrievedFacts.map((item, idx) => {
              const score = Number(item?.score || 0).toFixed(3);
              const factType = String(item?.factType || item?.fact_type || "unknown");
              const factText = String(item?.factText || item?.text || "").replace(/\s+/g, " ").trim();
              if (!factText) return null;

              return (
                <div key={`${item?.id || "retrieved-fact"}-${idx}`} style={{ fontSize: 12 }}>
                  <span style={{ color: "#8fb2cf" }}>score={score} · type={factType}</span>
                  <span style={{ color: "#d6e2ee" }}> · {factText.slice(0, 320)}</span>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}

      {promptMemories.length ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", color: "#93a6b7", fontSize: 12 }}>
            applied memory facts ({promptMemories.length})
          </summary>
          <div
            style={{
              margin: "8px 0 0",
              color: "#c7d5e2",
              borderLeft: "1px solid #2a394a",
              paddingLeft: 8,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {promptMemories.map((item, idx) => {
              const score = Number(item?.score || 0).toFixed(3);
              const factText = String(item?.factText || item?.text || "").replace(/\s+/g, " ").trim();
              if (!factText) return null;

              return (
                <div key={`${item?.id || "memory"}-${idx}`} style={{ fontSize: 12 }}>
                  <span style={{ color: "#8fb2cf" }}>score={score}</span>
                  <span style={{ color: "#d6e2ee" }}> · {factText.slice(0, 320)}</span>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}

      {m.reasoning ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", color: "#93a6b7", fontSize: 12 }}>
            reasoning
          </summary>
          <div
            style={{
              margin: "8px 0 0",
              color: "#c7d5e2",
              borderLeft: "1px solid #2a394a",
              paddingLeft: 8,
            }}
          >
            <ReactMarkdown>{m.reasoning}</ReactMarkdown>
          </div>
        </details>
      ) : null}

      {m.tool_calls?.length ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", color: "#93a6b7", fontSize: 12 }}>
            tool calls ({m.tool_calls.length})
          </summary>
          <pre
            style={{
              margin: "8px 0 0",
              color: "#c7d5e2",
              whiteSpace: "pre-wrap",
              borderLeft: "1px solid #2a394a",
              paddingLeft: 8,
            }}
          >
            {JSON.stringify(m.tool_calls, null, 2)}
          </pre>
        </details>
      ) : null}
    </article>
  );
}
