import { useCallback, useEffect, useRef, useState } from "react";
import { SNAPSHOT_FILE_NAME } from "../lib/constants";
import {
  clearSnapshotFromOpfs,
  readSnapshotFromOpfs,
  writeSnapshotToOpfs,
} from "../lib/opfs";

const DEFAULT_PERSIST_DEBOUNCE_MS = 150;

function identityMessages(value) {
  return Array.isArray(value) ? value : [];
}

export default function useSessionStorageSync({
  messages = [],
  telemetry = null,
  setMessages,
  setTelemetry,
  setStatus,
  sanitizeMessage = (m) => m,
  normalizeMessages = identityMessages,
  emptySnapshot,
  emptyTelemetry,
  snapshotFileName = SNAPSHOT_FILE_NAME,
  persistDebounceMs = DEFAULT_PERSIST_DEBOUNCE_MS,
} = {}) {
  const [storageReady, setStorageReady] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const persistTimerRef = useRef(null);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const snapshot = await readSnapshotFromOpfs(snapshotFileName, {
          sanitizeMessage: (m) => sanitizeMessage(m),
          emptySnapshot,
        });

        if (!active) return;
        setMessages?.(normalizeMessages(snapshot.messages));
        setTelemetry?.(snapshot.telemetry || emptyTelemetry?.());
        setStorageReady(true);
        setIsHydrated(true);
        setStatus?.("storage: opfs ready");
      } catch {
        if (!active) return;
        setStorageReady(false);
        setIsHydrated(false);
        setStatus?.("storage: opfs unavailable");
      }
    })();

    return () => {
      active = false;
    };
  }, [
    emptySnapshot,
    emptyTelemetry,
    normalizeMessages,
    sanitizeMessage,
    setMessages,
    setStatus,
    setTelemetry,
    snapshotFileName,
  ]);

  useEffect(() => {
    if (!storageReady || !isHydrated) return undefined;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);

    persistTimerRef.current = setTimeout(async () => {
      try {
        await writeSnapshotToOpfs(snapshotFileName, {
          updatedAt: new Date().toISOString(),
          telemetry,
          messages: normalizeMessages(messages).map((m) => sanitizeMessage(m)),
        });

        setStatus?.((prev) =>
          typeof prev === "string" && prev.startsWith("error")
            ? prev
            : "storage: synced",
        );
      } catch {
        setStatus?.("error: failed to sync OPFS");
      }
    }, Math.max(0, Number(persistDebounceMs) || DEFAULT_PERSIST_DEBOUNCE_MS));

    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [
    isHydrated,
    messages,
    normalizeMessages,
    persistDebounceMs,
    sanitizeMessage,
    setStatus,
    snapshotFileName,
    storageReady,
    telemetry,
  ]);

  const clearCurrentSession = useCallback(async () => {
    setStatus?.("clearing session...");
    try {
      await clearSnapshotFromOpfs(snapshotFileName);
      setMessages?.([]);
      setTelemetry?.(emptyTelemetry?.());
      setStatus?.("session cleared");
    } catch (err) {
      setStatus?.(
        `error · ${
          err instanceof Error ? err.message : "failed to clear session"
        }`,
      );
    }
  }, [emptyTelemetry, setMessages, setStatus, setTelemetry, snapshotFileName]);

  return {
    storageReady,
    isHydrated,
    clearCurrentSession,
  };
}