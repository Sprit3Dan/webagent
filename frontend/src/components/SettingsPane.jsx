import React, { useEffect, useState } from "react";

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
    boxSizing: "border-box",
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

function buttonStyle({ danger = false, subtle = false, primary = false } = {}) {
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

  if (primary) {
    return {
      border: "1px solid #2580be",
      borderRadius: 6,
      background: "#1a6ea8",
      color: "#d6e2ee",
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

function A2AStatusCard({
  a2aEnabled = false,
  onA2aEnabledChange,
  healthInfo = null,
  loadingHealth = false,
  onRefreshHealth,
}) {
  const row = (label, value) => (
    <div key={label} style={rowStyle()}>
      <span style={{ color: "#6f8499", fontSize: 12 }}>{label}</span>
      <span style={{ color: "#d0dce8", fontSize: 12, fontFamily: "monospace" }}>{value}</span>
    </div>
  );

  return (
    <div style={cardStyle()}>
      <h3 style={{ margin: 0, color: "#cfe0ef", fontSize: 15 }}>A2A Status</h3>
      <div style={{ color: "#93a6b7", fontSize: 12 }}>
        UI controls delegation behavior. Backend values are treated as defaults only.
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ color: "#c7d5e2", fontSize: 12 }}>
          UI A2A:{" "}
          <strong style={{ color: a2aEnabled ? "#7bd88f" : "#e07070" }}>
            {a2aEnabled ? "enabled" : "disabled"}
          </strong>
        </div>
        <button
          onClick={() => onA2aEnabledChange?.(!a2aEnabled)}
          style={buttonStyle({ subtle: true })}
        >
          {a2aEnabled ? "disable in ui" : "enable in ui"}
        </button>
      </div>



      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => onRefreshHealth?.()} style={buttonStyle({ subtle: true })}>
          refresh status
        </button>
      </div>

      {loadingHealth ? (
        <div style={{ color: "#6f8499", fontSize: 12 }}>Probing backend health…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {row("backend healthy", healthInfo?.ok ? "yes" : "no")}
          {row("agent id", healthInfo?.agentId || "—")}
          {row("transport", healthInfo?.transport?.backend || "—")}
          {row("nats url", healthInfo?.transport?.natsUrl || "—")}
          {row("discovery url", healthInfo?.discovery?.baseUrl || "—")}
          {row("delegations", String(healthInfo?.store?.delegations ?? "—"))}
          {row("transport connected", healthInfo?.transport?.connected ? "yes" : "no")}
          {row("discovery connected", healthInfo?.discovery?.connected ? "yes" : "no")}
        </div>
      )}
    </div>
  );
}

function A2ADetailsCard({
  a2aBackendDefaults = {},
  onA2aConfigChange,
}) {
  const [savingConfig, setSavingConfig] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveNote, setSaveNote] = useState("");
  const [draft, setDraft] = useState({
    a2aAgentId: "",
    a2aTransportBackend: "nats",
    a2aNatsUrl: "",
    a2aDiscoveryBaseUrl: "",
    a2aStreamName: "a2a",
    a2aSubjectPrefix: "a2a",
    a2aConsumerName: "webagent",
    a2aMaxDeliver: 5,
    a2aAckWaitSeconds: 30,
    a2aExecutionTimeoutSeconds: 120,
    a2aRequireAuth: false,
    a2aSharedSecret: "",
  });

  useEffect(() => {
    setDraft({
      a2aAgentId: String(a2aBackendDefaults?.a2aAgentId || ""),
      a2aTransportBackend: String(a2aBackendDefaults?.a2aTransportBackend || "nats"),
      a2aNatsUrl: String(a2aBackendDefaults?.a2aNatsUrl || ""),
      a2aDiscoveryBaseUrl: String(a2aBackendDefaults?.a2aDiscoveryBaseUrl || ""),
      a2aStreamName: String(a2aBackendDefaults?.a2aStreamName || "a2a"),
      a2aSubjectPrefix: String(a2aBackendDefaults?.a2aSubjectPrefix || "a2a"),
      a2aConsumerName: String(a2aBackendDefaults?.a2aConsumerName || "webagent"),
      a2aMaxDeliver: Math.max(1, Number(a2aBackendDefaults?.a2aMaxDeliver) || 5),
      a2aAckWaitSeconds: Math.max(1, Number(a2aBackendDefaults?.a2aAckWaitSeconds) || 30),
      a2aExecutionTimeoutSeconds: Math.max(
        1,
        Number(a2aBackendDefaults?.a2aExecutionTimeoutSeconds) || 120,
      ),
      a2aRequireAuth: Boolean(a2aBackendDefaults?.a2aRequireAuth),
      a2aSharedSecret: String(a2aBackendDefaults?.a2aSharedSecret || ""),
    });
  }, [a2aBackendDefaults]);

  const updateDraft = (patch) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setSaveError("");
    setSaveNote("");
  };

  const toPositiveInt = (value, fallback) =>
    Math.max(1, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback);

  const saveRuntimeConfig = async () => {
    if (!onA2aConfigChange) return;
    setSavingConfig(true);
    setSaveError("");
    setSaveNote("");
    try {
      await onA2aConfigChange({
        ...draft,
        a2aAgentId: String(draft.a2aAgentId || "").trim(),
        a2aTransportBackend: String(draft.a2aTransportBackend || "nats").trim() || "nats",
        a2aNatsUrl: String(draft.a2aNatsUrl || "").trim(),
        a2aDiscoveryBaseUrl: String(draft.a2aDiscoveryBaseUrl || "").trim(),
        a2aStreamName: String(draft.a2aStreamName || "a2a").trim() || "a2a",
        a2aSubjectPrefix: String(draft.a2aSubjectPrefix || "a2a").trim() || "a2a",
        a2aConsumerName: String(draft.a2aConsumerName || "webagent").trim() || "webagent",
        a2aMaxDeliver: toPositiveInt(draft.a2aMaxDeliver, 5),
        a2aAckWaitSeconds: toPositiveInt(draft.a2aAckWaitSeconds, 30),
        a2aExecutionTimeoutSeconds: toPositiveInt(draft.a2aExecutionTimeoutSeconds, 120),
        a2aRequireAuth: Boolean(draft.a2aRequireAuth),
        a2aSharedSecret: String(draft.a2aSharedSecret || "").trim(),
      });
      setSaveNote("A2A details saved in IndexedDB");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "failed to save A2A details");
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div style={cardStyle()}>
      <h3 style={{ margin: 0, color: "#cfe0ef", fontSize: 15 }}>A2A Details</h3>
      <div style={{ color: "#93a6b7", fontSize: 12 }}>
        Configure A2A runtime defaults in UI (persisted to IndexedDB).
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>Agent ID</label>
        <input
          value={String(draft.a2aAgentId || "")}
          onChange={(e) => updateDraft({ a2aAgentId: e.target.value })}
          style={inputStyle()}
        />
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>Transport</label>
        <input
          value={String(draft.a2aTransportBackend || "")}
          onChange={(e) => updateDraft({ a2aTransportBackend: e.target.value })}
          style={inputStyle()}
        />
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>NATS URL</label>
        <input
          value={String(draft.a2aNatsUrl || "")}
          onChange={(e) => updateDraft({ a2aNatsUrl: e.target.value })}
          style={inputStyle()}
        />
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>Discovery URL</label>
        <input
          value={String(draft.a2aDiscoveryBaseUrl || "")}
          onChange={(e) => updateDraft({ a2aDiscoveryBaseUrl: e.target.value })}
          style={inputStyle()}
        />
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>Stream name</label>
        <input
          value={String(draft.a2aStreamName || "")}
          onChange={(e) => updateDraft({ a2aStreamName: e.target.value })}
          style={inputStyle()}
        />
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>Subject prefix</label>
        <input
          value={String(draft.a2aSubjectPrefix || "")}
          onChange={(e) => updateDraft({ a2aSubjectPrefix: e.target.value })}
          style={inputStyle()}
        />
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>Consumer name</label>
        <input
          value={String(draft.a2aConsumerName || "")}
          onChange={(e) => updateDraft({ a2aConsumerName: e.target.value })}
          style={inputStyle()}
        />
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>Max deliver</label>
        <input
          type="number"
          min={1}
          step={1}
          value={Math.max(1, Number(draft.a2aMaxDeliver) || 1)}
          onChange={(e) => updateDraft({ a2aMaxDeliver: Math.max(1, Number(e.target.value) || 1) })}
          style={inputStyle()}
        />
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>Ack wait seconds</label>
        <input
          type="number"
          min={1}
          step={1}
          value={Math.max(1, Number(draft.a2aAckWaitSeconds) || 1)}
          onChange={(e) =>
            updateDraft({ a2aAckWaitSeconds: Math.max(1, Number(e.target.value) || 1) })
          }
          style={inputStyle()}
        />
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>Execution timeout</label>
        <input
          type="number"
          min={1}
          step={1}
          value={Math.max(1, Number(draft.a2aExecutionTimeoutSeconds) || 1)}
          onChange={(e) =>
            updateDraft({
              a2aExecutionTimeoutSeconds: Math.max(1, Number(e.target.value) || 1),
            })
          }
          style={inputStyle()}
        />
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>Require auth</label>
        <input
          type="checkbox"
          checked={Boolean(draft.a2aRequireAuth)}
          onChange={(e) => updateDraft({ a2aRequireAuth: Boolean(e.target.checked) })}
        />
      </div>

      <div style={rowStyle()}>
        <label style={labelStyle()}>Shared secret</label>
        <input
          type="password"
          value={String(draft.a2aSharedSecret || "")}
          onChange={(e) => updateDraft({ a2aSharedSecret: e.target.value })}
          autoComplete="off"
          spellCheck={false}
          style={inputStyle()}
        />
      </div>

      {saveError ? <div style={{ color: "#e07070", fontSize: 12 }}>{saveError}</div> : null}
      {saveNote ? <div style={{ color: "#7bd88f", fontSize: 12 }}>{saveNote}</div> : null}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={() => saveRuntimeConfig()}
          disabled={savingConfig || !onA2aConfigChange}
          style={{ ...buttonStyle({ subtle: true }), opacity: savingConfig ? 0.6 : 1 }}
        >
          {savingConfig ? "saving…" : "save a2a details"}
        </button>
      </div>
    </div>
  );
}

export default function SettingsPane({
  llmProviders = [],
  activeLlmProviderId = "",
  onActiveLlmProviderChange,
  onUpdateActiveProvider,
  onAddProvider,
  onRemoveProvider,
  onSave,
  a2aEnabled = false,
  a2aBackendDefaults = {},
  onA2aEnabledChange,
  onA2aConfigChange,
}) {
  const providers = Array.isArray(llmProviders) ? llmProviders : [];
  const activeProvider =
    providers.find((p) => String(p?.id || "") === String(activeLlmProviderId || "")) ||
    providers[0] ||
    null;

  const [a2aHealth, setA2aHealth] = useState(null);
  const [loadingA2aHealth, setLoadingA2aHealth] = useState(true);

  const refreshA2aHealth = async () => {
    setLoadingA2aHealth(true);
    try {
      const res = await fetch("/api/a2a/health");
      const data = res.ok ? await res.json() : { ok: false };
      setA2aHealth(data);
    } catch {
      setA2aHealth({ ok: false });
    } finally {
      setLoadingA2aHealth(false);
    }
  };

  useEffect(() => {
    void refreshA2aHealth();
  }, []);

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
      <aside style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={cardStyle()}>
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
        </div>

        <A2AStatusCard
          a2aEnabled={a2aEnabled}
          onA2aEnabledChange={onA2aEnabledChange}
          healthInfo={a2aHealth}
          loadingHealth={loadingA2aHealth}
          onRefreshHealth={refreshA2aHealth}
        />
      </aside>

      <main style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <section style={cardStyle()}>
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
        </section>

        <A2ADetailsCard
          a2aBackendDefaults={a2aBackendDefaults}
          onA2aConfigChange={onA2aConfigChange}
        />
      </main>
    </section>
  );
}