import { useCallback, useEffect, useRef, useState } from "react";

import {
  listA2ADelegationRecords,
  readPersistedUiSettings,
  upsertA2ADelegationRecord,
  writePersistedUiSettings,
} from "../lib/skillMemory";
import { FRONTEND_IDENTITY_STORAGE_KEY, getOrCreateFrontendInstanceId } from "../lib/frontendIdentity";

function getFrontendInstanceId() {
  try {
    const runtimeAgentId = String(
      localStorage.getItem("webagent.runtime.agentId")
      || localStorage.getItem("webagent.agentId")
      || localStorage.getItem(FRONTEND_IDENTITY_STORAGE_KEY)
      || "",
    ).trim();
    if (runtimeAgentId) return runtimeAgentId;
  } catch {
    // ignore storage access failures
  }
  return getOrCreateFrontendInstanceId();
}

function resolveA2aConsumerName(value) {
  const candidate = String(value || "").trim();
  if (!candidate || candidate.toLowerCase() === "webagent") {
    return getFrontendInstanceId();
  }
  return candidate;
}

function deriveA2aBackendDefaults(health = {}) {
  return {
    a2aEnabled: true,
    a2aAgentId: String(health?.agentId || ""),
    a2aTransportBackend: String(health?.transport?.backend || "nats"),
    a2aNatsUrl: String(health?.transport?.natsUrl || ""),
    a2aDiscoveryBaseUrl: String(health?.discovery?.baseUrl || ""),
    a2aStreamName: String(health?.transport?.streamName || "a2a"),
    a2aSubjectPrefix: String(health?.transport?.subjectPrefix || "a2a"),
    a2aConsumerName: resolveA2aConsumerName(health?.transport?.consumerName),
    a2aMaxDeliver: Math.max(1, Number(health?.transport?.maxDeliver) || 5),
    a2aAckWaitSeconds: Math.max(
      1,
      Number(health?.transport?.ackWaitSeconds) || 30,
    ),
    a2aExecutionTimeoutSeconds: Math.max(
      1,
      Number(health?.execution?.timeoutSeconds) || 120,
    ),
    a2aRequireAuth: Boolean(health?.auth?.requireAuth),
    a2aSharedSecret: "",
  };
}

function normalizeA2APushUpdate(data) {
  if (!data || typeof data !== "object") return null;

  const envelopeType = String(data.type || "").trim();
  const candidate =
    envelopeType === "a2a.delegation.update" && data.update && typeof data.update === "object"
      ? data.update
      : data;

  if (String(candidate.type || envelopeType || "").trim() !== "a2a.delegation.update") return null;

  const delegationId = String(candidate.delegationId || "").trim();
  const status = String(candidate.status || "").trim().toLowerCase();
  if (!delegationId || !status) return null;

  return {
    delegationId,
    status,
    fromAgent: String(candidate.fromAgent || ""),
    targetAgent: String(candidate.targetAgent || ""),
    result: candidate.result,
    error: candidate.error,
    updatedAt: String(candidate.updatedAt || new Date().toISOString()),
  };
}

function normalizeA2AWSUpdate(data) {
  if (!data || typeof data !== "object") return null;
  if (String(data.type || "").trim() !== "a2a.delegation.update") return null;

  const delegationId = String(data.delegationId || "").trim();
  const status = String(data.status || "").trim().toLowerCase();
  if (!delegationId || !status) return null;

  return {
    delegationId,
    status,
    fromAgent: String(data.fromAgent || ""),
    targetAgent: String(data.targetAgent || ""),
    result: data.result,
    error: data.error,
    updatedAt: String(data.updatedAt || new Date().toISOString()),
  };
}

function buildA2aWsUrl() {
  const route = "/api/a2a/ws";
  const origin =
    typeof window !== "undefined" && window?.location?.origin
      ? window.location.origin
      : "http://localhost:5173";

  const raw = String(route || "").trim();
  const baseUrl = raw.startsWith("http://") || raw.startsWith("https://")
    ? new URL(raw)
    : new URL(raw || "/api/a2a/ws", origin);

  baseUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  return baseUrl;
}

export default function useA2ADelegation({ setStatus } = {}) {
  const [delegations, setDelegations] = useState([]);
  const [a2aEnabled, setA2aEnabled] = useState(false);
  const [a2aBackendDefaults, setA2aBackendDefaults] = useState(() =>
    deriveA2aBackendDefaults({}),
  );

  const refreshSeqRef = useRef(0);
  const wsConnectedRef = useRef(false);

  const persistDelegation = useCallback(async (record) => {
    try {
      await upsertA2ADelegationRecord(record, {
        tenantId: "tenant-dev",
        userId: "user-001",
        agentId: getFrontendInstanceId(),
      });
    } catch {
      // best effort persistence
    }
  }, []);

  const applyDelegationUpdate = useCallback(
    (update) => {
      if (!update || typeof update !== "object") return;

      const hasResultUpdate = Object.prototype.hasOwnProperty.call(update, "result");
      const hasErrorUpdate = Object.prototype.hasOwnProperty.call(update, "error");

      setDelegations((prev) => {
        const list = Array.isArray(prev) ? prev : [];
        const idx = list.findIndex(
          (item) =>
            String(item?.delegationId || "").trim() ===
            String(update.delegationId || "").trim(),
        );

        const eventRow = {
          status: update.status,
          timestamp: update.updatedAt,
        };

        if (idx < 0) {
          const createdRecord = {
            delegationId: update.delegationId,
            status: update.status,
            createdAt: update.updatedAt,
            updatedAt: update.updatedAt,
            targetAgent: update.targetAgent || "",
            fromAgent: update.fromAgent || "",
            task: {},
            messages: [eventRow],
            result: update.result ?? null,
            error:
              typeof update.error === "string"
                ? update.error
                : null,
          };
          void persistDelegation(createdRecord);
          return [createdRecord, ...list];
        }

        const next = [...list];
        const existing = next[idx] || {};
        const existingMessages = Array.isArray(existing.messages)
          ? existing.messages
          : [];
        const last = existingMessages[existingMessages.length - 1];
        const shouldAppend =
          !last ||
          String(last.status || "") !== String(update.status || "") ||
          String(last.timestamp || "") !== String(update.updatedAt || "");

        next[idx] = {
          ...existing,
          status: update.status || existing.status,
          updatedAt: update.updatedAt || existing.updatedAt,
          targetAgent:
            update.targetAgent || existing.targetAgent || "",
          fromAgent: update.fromAgent || existing.fromAgent || "",
          result:
            hasResultUpdate && update.result !== null
              ? update.result
              : existing.result ?? null,
          error:
            hasErrorUpdate && typeof update.error === "string" && update.error.trim()
              ? update.error
              : existing.error ?? null,
          messages: shouldAppend
            ? [...existingMessages, eventRow]
            : existingMessages,
        };

        void persistDelegation(next[idx]);
        return next.sort((a, b) =>
          String(b?.updatedAt || "").localeCompare(
            String(a?.updatedAt || ""),
          ),
        );
      });
    },
    [persistDelegation],
  );

  const initializeA2A = useCallback(async () => {
    const backendDefaults = deriveA2aBackendDefaults({});

    const uiSettings = await readPersistedUiSettings(backendDefaults);
    const effectiveEnabled = Boolean(uiSettings?.a2aEnabled);
    setA2aBackendDefaults(backendDefaults);
    setA2aEnabled(effectiveEnabled);

    if (!effectiveEnabled) {
      setDelegations([]);
      return;
    }

    try {
      const persisted = await listA2ADelegationRecords({
        tenantId: "tenant-dev",
        userId: "user-001",
        agentId: getFrontendInstanceId(),
        limit: 200,
        offset: 0,
        sortDesc: true,
      });
      setDelegations(Array.isArray(persisted) ? persisted : []);
    } catch {
      setDelegations([]);
    }
  }, []);

  const setA2aEnabledPreference = useCallback(
    async (nextEnabled) => {
      const enabled = Boolean(nextEnabled);
      setA2aEnabled(enabled);
      if (!enabled) setDelegations([]);

      try {
        await writePersistedUiSettings(
          { a2aEnabled: enabled },
          a2aBackendDefaults,
        );
        setStatus?.(`a2a: ${enabled ? "enabled" : "disabled"} (saved)`);
      } catch (err) {
        setStatus?.(
          `a2a: failed to save setting · ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      }
    },
    [a2aBackendDefaults, setStatus],
  );

  const setA2aConfigDefaultsPreference = useCallback(
    async (patch = {}) => {
      const mergedDefaults = {
        ...a2aBackendDefaults,
        ...(patch || {}),
      };

      try {
        const persisted = await writePersistedUiSettings(
          mergedDefaults,
          mergedDefaults,
        );
        setA2aBackendDefaults((prev) => ({ ...prev, ...persisted }));
        setStatus?.("a2a: runtime defaults saved");
      } catch (err) {
        setStatus?.(
          `a2a: failed to save runtime defaults · ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
        throw err;
      }
    },
    [a2aBackendDefaults, setStatus],
  );

  const refreshDelegations = useCallback(async () => {
    const reqId = ++refreshSeqRef.current;

    try {
      const backendDefaults = deriveA2aBackendDefaults({});
      const uiSettings = await readPersistedUiSettings(backendDefaults);
      const effectiveEnabled = Boolean(uiSettings?.a2aEnabled);

      if (reqId !== refreshSeqRef.current) return;

      setA2aBackendDefaults(backendDefaults);
      setA2aEnabled(effectiveEnabled);

      if (!effectiveEnabled) {
        setDelegations([]);
        return;
      }

      const persisted = await listA2ADelegationRecords({
        tenantId: "tenant-dev",
        userId: "user-001",
        agentId: getFrontendInstanceId(),
        limit: 200,
        offset: 0,
        sortDesc: true,
      });
      if (reqId !== refreshSeqRef.current) return;
      setDelegations(Array.isArray(persisted) ? persisted : []);
    } catch {
      // keep previous state on transient errors
    }
  }, []);

  const listA2ADiscoveryCandidates = useCallback(
    async ({ targetAgent, intent, capabilities } = {}) => {
      if (!a2aEnabled) {
        return { candidates: [], count: 0, error: "A2A is disabled in UI settings." };
      }

      const params = new URLSearchParams();
      const target = String(targetAgent || "").trim();
      const hint = String(intent || "").trim();
      const caps = Array.isArray(capabilities)
        ? capabilities.map((item) => String(item || "").trim()).filter(Boolean)
        : [];

      if (target) params.set("targetAgent", target);
      if (hint) params.set("intent", hint);
      if (caps.length) params.set("capabilities", caps.join(","));

      const query = params.toString();
      const res = await fetch(`/api/a2a/discovery/candidates${query ? `?${query}` : ""}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          candidates: [],
          count: 0,
          error: data?.detail || `discovery candidates request failed (${res.status})`,
        };
      }
      return data;
    },
    [a2aEnabled],
  );

  const delegateTask = useCallback(
    async ({ task, targetAgent, intent } = {}) => {
      if (!a2aEnabled) {
        return { error: "A2A is disabled in UI settings." };
      }

      try {
        const callerAgentId = getFrontendInstanceId();
        const resolvedTargetAgent = String(targetAgent || "").trim() || callerAgentId;
        const res = await fetch("/api/agent/delegate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            task,
            agentId: callerAgentId,
            targetAgent: resolvedTargetAgent,
            intent: intent || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) return { error: data?.detail || "delegation failed" };

        const now = new Date().toISOString();
        const normalizedTask =
          task && typeof task === "object" ? task : { text: String(task || "") };

        const optimistic = {
          delegationId: String(data?.delegationId || ""),
          status: String(data?.status || "dispatched").toLowerCase(),
          createdAt: String(data?.createdAt || now),
          updatedAt: String(data?.createdAt || now),
          targetAgent: String(data?.targetAgent || resolvedTargetAgent || ""),
          fromAgent: callerAgentId,
          task: normalizedTask,
          messages: [
            { status: "created", timestamp: String(data?.createdAt || now) },
            { status: "dispatched", timestamp: String(data?.createdAt || now), messageId: String(data?.messageId || "") },
          ],
          result: null,
          error: null,
        };

        void persistDelegation(optimistic);
        setDelegations((prev) => [optimistic, ...(Array.isArray(prev) ? prev : [])]);

        return data;
      } catch (err) {
        return { error: String(err) };
      }
    },
    [a2aEnabled],
  );

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;

    const onSwMessage = (event) => {
      const update = normalizeA2APushUpdate(event?.data);
      if (!update) return;
      applyDelegationUpdate(update);
    };

    navigator.serviceWorker.addEventListener("message", onSwMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onSwMessage);
    };
  }, [applyDelegationUpdate]);

  useEffect(() => {
    if (!a2aEnabled) return undefined;
    if (typeof window === "undefined" || typeof window.WebSocket === "undefined") {
      return undefined;
    }

    let disposed = false;
    let socket = null;
    let reconnectTimer = null;
    let heartbeatTimer = null;
    let attempt = 0;

    const clearTimers = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const scheduleReconnect = () => {
      clearTimers();
      if (disposed) return;
      attempt += 1;
      const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
      reconnectTimer = setTimeout(connect, delay);
      setStatus?.(`a2a: realtime reconnecting (${Math.round(delay / 1000)}s)`);
    };

    const connect = () => {
      if (disposed) return;
      try {
        const wsUrl = buildA2aWsUrl();
        wsUrl.searchParams.set("tenantId", "tenant-dev");
        wsUrl.searchParams.set("userId", "user-001");
        wsUrl.searchParams.set("agentId", getFrontendInstanceId());

        socket = new WebSocket(wsUrl.toString());
      } catch {
        scheduleReconnect();
        return;
      }

      socket.onopen = () => {
        wsConnectedRef.current = true;
        attempt = 0;
        setStatus?.("a2a: realtime connected");
        clearTimers();
        heartbeatTimer = setInterval(() => {
          try {
            socket?.readyState === WebSocket.OPEN && socket.send("ping");
          } catch {
            // ignore heartbeat send failures
          }
        }, 25_000);
      };

      socket.onmessage = (event) => {
        try {
          const raw = JSON.parse(String(event?.data || "{}"));
          const update = normalizeA2AWSUpdate(raw);
          if (!update) return;
          applyDelegationUpdate(update);
        } catch {
          // ignore malformed websocket payloads
        }
      };

      socket.onerror = () => {
        try {
          socket?.close();
        } catch {
          // ignore close errors
        }
      };

      socket.onclose = () => {
        wsConnectedRef.current = false;
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      wsConnectedRef.current = false;
      clearTimers();
      try {
        socket?.close();
      } catch {
        // ignore close errors
      }
    };
  }, [a2aEnabled, applyDelegationUpdate, setStatus]);

  return {
    delegations,
    a2aEnabled,
    a2aBackendDefaults,
    initializeA2A,
    setA2aEnabledPreference,
    setA2aConfigDefaultsPreference,
    refreshDelegations,
    listA2ADiscoveryCandidates,
    delegateTask,
  };
}