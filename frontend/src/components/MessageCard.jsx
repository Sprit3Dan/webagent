import React from "react";

function sanitizeMessage(m) {
  return {
    role: m?.role || "assistant",
    content: typeof m?.content === "string" ? m.content : "",
    tool_calls: Array.isArray(m?.tool_calls) ? m.tool_calls : undefined,
    reasoning: typeof m?.reasoning === "string" ? m.reasoning : undefined,
    timestamp: m?.timestamp || new Date().toISOString(),
  };
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

export default function MessageCard({ msg }) {
  const m = sanitizeMessage(msg);
  const role = m.role.toLowerCase();
  const { accent, background } = roleStyle(role);

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
        <span>{role.toUpperCase()}</span>
        <span style={{ color: "#93a6b7" }}>{m.timestamp}</span>
      </div>

      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45, color: "#d6e2ee" }}>
        {m.content}
      </div>

      {m.reasoning ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", color: "#93a6b7", fontSize: 12 }}>
            reasoning
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
            {m.reasoning}
          </pre>
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