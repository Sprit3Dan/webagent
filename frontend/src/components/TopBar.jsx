import React from "react";
import { ROUTES } from "../lib/constants";

function navButtonStyle(active) {
  return {
    border: "1px solid #2f4257",
    borderRadius: 8,
    background: active ? "#17324e" : "#102132",
    color: "#c7d5e2",
    padding: "7px 12px",
    fontSize: 13,
    minWidth: 92,
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
  llmProviders = [],
  activeLlmProviderId = "",
  onActiveLlmProviderChange,
}) {
  const isChatRoute = route === ROUTES.CHAT;
  const isStorageRoute = route === ROUTES.STORAGE;
  const isSettingsRoute = route === ROUTES.SETTINGS;
  const isA2aRoute = route === ROUTES.A2A;

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
            title="Hotkey: g c"
          >
            chat · g c
          </button>
          <button
            onClick={() => onNavigate(ROUTES.STORAGE)}
            style={navButtonStyle(isStorageRoute)}
            title="Hotkey: g s"
          >
            storage · g s
          </button>
          <button
            onClick={() => onNavigate(ROUTES.SETTINGS)}
            style={navButtonStyle(isSettingsRoute)}
            title="Hotkey: g ,"
          >
            settings · g ,
          </button>
          <button
            onClick={() => onNavigate(ROUTES.A2A)}
            style={navButtonStyle(isA2aRoute)}
            title="Hotkey: g a"
          >
            a2a · g a
          </button>

          <label style={{ color: "#93a6b7", fontSize: 12 }}>
            provider
            <select
              value={activeLlmProviderId}
              onChange={(e) => onActiveLlmProviderChange?.(e.target.value)}
              style={{
                marginLeft: 6,
                background: "#102132",
                color: "#c7d5e2",
                border: "1px solid #2f4257",
                borderRadius: 6,
                padding: "2px 6px",
                fontSize: 12,
              }}
            >
              {(Array.isArray(llmProviders) ? llmProviders : []).map((provider) => (
                <option key={String(provider?.id || "")} value={String(provider?.id || "")}>
                  {String(provider?.name || provider?.id || "provider")}
                </option>
              ))}
            </select>
          </label>

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
        ) : isSettingsRoute ? (
          <span style={{ color: "#93a6b7", fontSize: 12 }}>settings: provider configuration</span>
        ) : isA2aRoute ? (
          <span style={{ color: "#93a6b7", fontSize: 12 }}>a2a: agent delegation monitor</span>
        ) : (
          <span style={{ color: "#93a6b7", fontSize: 12 }}>{inspectorStatus}</span>
        )}
      </div>

      <div style={{ marginTop: 6, color: "#93a6b7", fontSize: 12 }}>
        {isChatRoute
          ? telemetryText
          : isSettingsRoute
            ? "LLM settings · manage providers, model, context size, and budget"
            : isA2aRoute
              ? "Delegate tasks to peer agents, monitor status, inspect results"
              : "OPFS inspector · browse files and clear active session snapshot"}
      </div>
    </header>
  );
}