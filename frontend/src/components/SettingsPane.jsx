import React from "react";

const PROVIDERS = [
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "openai", label: "OpenAI" },
  { value: "vllm", label: "vLLM" },
  { value: "custom", label: "Custom" },
];

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
  };
}

function labelStyle() {
  return {
    display: "block",
    marginBottom: 6,
    color: "#8fb0c9",
    fontSize: 12,
    letterSpacing: "0.02em",
  };
}

function buttonStyle({ danger = false, subtle = false } = {}) {
  if (danger) {
    return {
      border: "1px solid #55333a",
      borderRadius: 6,
      background: "#2a161a",
      color: "#ffc9cf",
      padding: "6px 10px",
      cursor: "pointer",
    };
  }

  if (subtle) {
    return {
      border: "1px solid #2f4257",
      borderRadius: 6,
      background: "#0f1d2a",
      color: "#c7d5e2",
      padding: "6px 10px",
      cursor: "pointer",
    };
  }

  return {
    border: "1px solid #2f4257",
    borderRadius: 6,
    background: "#102132",
    color: "#c7d5e2",
    padding: "6px 10px",
    cursor: "pointer",
  };
}

function rowStyle() {
  return {
    display: "grid",
    gridTemplateColumns: "minmax(120px, 170px) minmax(0, 1fr)",
    gap: 10,
    alignItems: "center",
  };
}

export default function SettingsPane({
  llmProviders = [],
  activeLlmProviderId = "",
  onActiveLlmProviderChange,
  onUpdateActiveProvider,
  onAddProvider,
  onRemoveProvider,
  onSave,
}) {
  const providers = Array.isArray(llmProviders) ? llmProviders : [];
  const activeProvider =
    providers.find((p) => String(p?.id || "") === String(activeLlmProviderId || "")) ||
    providers[0] ||
    null;

  const update = (patch) => onUpdateActiveProvider?.(patch);

  return (
    <section
      style={{
        minHeight: 0,
        overflow: "auto",
        padding: 12,
        display: "grid",
        gridTemplateColumns: "minmax(240px, 340px) minmax(420px, 860px)",
        gap: 12,
        alignItems: "start",
      }}
    >
      <aside style={cardStyle()}>
        <h3 style={{ margin: 0, color: "#cfe0ef", fontSize: 15 }}>Providers</h3>
        <div style={{ color: "#93a6b7", fontSize: 12 }}>
          Manage saved providers, then edit details in the right card.
        </div>

        <div
          style={{
            borderTop: "1px solid #233240",
            borderBottom: "1px solid #233240",
            padding: "10px 0",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            maxHeight: "52vh",
            overflow: "auto",
          }}
        >
          {providers.length === 0 ? (
            <div style={{ color: "#6f8499", fontSize: 12 }}>No providers configured</div>
          ) : (
            providers.map((provider) => {
              const id = String(provider?.id || "");
              const selected = id === String(activeProvider?.id || "");
              const name = String(provider?.name || id || "provider");
              const model = String(provider?.model || "");
              return (
                <button
                  key={id}
                  onClick={() => onActiveLlmProviderChange?.(id)}
                  style={{
                    textAlign: "left",
                    border: "1px solid #2a394a",
                    borderRadius: 6,
                    background: selected ? "#17324e" : "#111b27",
                    color: selected ? "#e3f1ff" : "#cfe0ef",
                    padding: "8px 10px",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <span style={{ fontSize: 13 }}>{name}</span>
                  <span style={{ fontSize: 11, color: selected ? "#b9d6ef" : "#8ca1b4" }}>
                    {model || "no model"}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
          <button onClick={() => onAddProvider?.()} style={buttonStyle()}>
            + add provider
          </button>
          <button
            onClick={() => onRemoveProvider?.(activeProvider?.id)}
            disabled={providers.length <= 1}
            style={{
              ...buttonStyle({ danger: true }),
              opacity: providers.length <= 1 ? 0.55 : 1,
              cursor: providers.length <= 1 ? "not-allowed" : "pointer",
            }}
          >
            remove
          </button>
        </div>
      </aside>

      <main style={cardStyle()}>
        <h3 style={{ margin: 0, color: "#cfe0ef", fontSize: 15 }}>Active provider details</h3>
        <div style={{ color: "#93a6b7", fontSize: 12 }}>
          Configure model routing, context size, and budget controls.
        </div>

        {!activeProvider ? (
          <div style={{ color: "#6f8499", fontSize: 12 }}>Select or add a provider</div>
        ) : (
          <>
            <div style={rowStyle()}>
              <label style={labelStyle()}>Name</label>
              <input
                value={String(activeProvider?.name || "")}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="nemotron-local"
                spellCheck={false}
                style={inputStyle()}
              />
            </div>

            <div style={rowStyle()}>
              <label style={labelStyle()}>Provider</label>
              <select
                value={String(activeProvider?.provider || "openai-compatible")}
                onChange={(e) => update({ provider: e.target.value })}
                style={inputStyle()}
              >
                {PROVIDERS.map((provider) => (
                  <option key={provider.value} value={provider.value}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={rowStyle()}>
              <label style={labelStyle()}>Base URL</label>
              <input
                value={String(activeProvider?.baseUrl || "")}
                onChange={(e) => update({ baseUrl: e.target.value })}
                placeholder="http://inference.example.net/model/v1/"
                spellCheck={false}
                style={inputStyle()}
              />
            </div>

            <div style={rowStyle()}>
              <label style={labelStyle()}>Model</label>
              <input
                value={String(activeProvider?.model || "")}
                onChange={(e) => update({ model: e.target.value })}
                placeholder="nemotron-30b"
                spellCheck={false}
                style={inputStyle()}
              />
            </div>

            <div style={rowStyle()}>
              <label style={labelStyle()}>Context window tokens</label>
              <input
                type="number"
                min={1}
                step={1}
                value={Math.max(1, Number(activeProvider?.contextWindowTokens) || 64000)}
                onChange={(e) =>
                  update({ contextWindowTokens: Math.max(1, Number(e.target.value) || 1) })
                }
                style={inputStyle()}
              />
            </div>

            <div style={rowStyle()}>
              <label style={labelStyle()}>Token spend budget</label>
              <input
                type="number"
                min={0}
                step={1}
                value={Math.max(0, Number(activeProvider?.tokenBudget) || 0)}
                onChange={(e) =>
                  update({ tokenBudget: Math.max(0, Number(e.target.value) || 0) })
                }
                style={inputStyle()}
              />
            </div>

            <div style={rowStyle()}>
              <label style={labelStyle()}>Token secret</label>
              <input
                type="password"
                value={String(activeProvider?.tokenSecret || "")}
                onChange={(e) => update({ tokenSecret: e.target.value })}
                placeholder="Enter API token"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle()}
              />
            </div>
          </>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 6,
            borderTop: "1px solid #233240",
            paddingTop: 10,
          }}
        >
          <button onClick={() => onSave?.()} style={buttonStyle({ subtle: true })}>
            save settings
          </button>
        </div>
      </main>
    </section>
  );
}