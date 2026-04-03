import React from "react";
import { ROUTES } from "../lib/constants";

function navButtonStyle(active) {
  return {
    border: "1px solid #2f4257",
    borderRadius: 6,
    background: active ? "#17324e" : "#102132",
    color: "#c7d5e2",
    padding: "4px 8px",
    cursor: "pointer",
  };
}

export default function TopBar({
  route,
  onNavigate,
  isLoading,
  status,
  inspectorStatus,
  telemetryText,
}) {
  const isChatRoute = route === ROUTES.CHAT;

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        borderBottom: "1px solid #24303d",
        padding: "10px 14px",
        background: "#0b131c",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ color: "#71ffa7", letterSpacing: "0.04em" }}>
          $ webagent.console
        </strong>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => onNavigate(ROUTES.CHAT)}
            style={navButtonStyle(isChatRoute)}
          >
            chat
          </button>
          <button
            onClick={() => onNavigate(ROUTES.STORAGE)}
            style={navButtonStyle(!isChatRoute)}
          >
            storage
          </button>
        </div>

        {isChatRoute ? (
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ color: isLoading ? "#ffd166" : "#93a6b7", fontSize: 12 }}>
              [{isLoading ? "BUSY" : "READY"}] {status}
              {isLoading ? (
                <span style={{ animation: "pulseDots 0.9s infinite", marginLeft: 6 }}>
                  •••
                </span>
              ) : null}
            </span>
          </div>
        ) : (
          <span style={{ color: "#93a6b7", fontSize: 12 }}>{inspectorStatus}</span>
        )}
      </div>

      <div style={{ marginTop: 6, color: "#93a6b7", fontSize: 12 }}>
        {isChatRoute
          ? telemetryText
          : "OPFS inspector · browse files and clear active session snapshot"}
      </div>
    </header>
  );
}