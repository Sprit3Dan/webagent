import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppContext } from "../context/AppContext";
import { CONTEXT, ROUTES, SNAPSHOT_FILE_NAME } from "../lib/constants";
import {
  clearSnapshotFromOpfs,
  getOpfsRoot,
  readOpfsFileByPath,
  readSnapshotFromOpfs,
  walkOpfs,
  writeSnapshotToOpfs,
} from "../lib/opfs";
import { normalizeRoute, parseJsonSafe } from "../lib/utils";
import {
  buildTelemetryText,
  clamp,
  derivePagination,
  emptySnapshot,
  emptyTelemetry,
  makeUserMessage,
  normalizeMessages,
  sanitizeMessage,
} from "../lib/chatState";

export default function useChatSession() {
  const {
    route,
    setRoute,
    prompt,
    setPrompt,
    status,
    setStatus,
    isLoading,
    setIsLoading,
    pageIndex,
    setPageIndex,
    pageSize,
    focusedMessageIndex,
    setFocusedMessageIndex,
    inspectorStatus,
    setInspectorStatus,
    inspectorLoading,
    setInspectorLoading,
    selectedFilePath,
    setSelectedFilePath,
    selectedFileContent,
    setSelectedFileContent,
    selectedFileMeta,
    setSelectedFileMeta,
    resetInspectorSelection,
  } = useAppContext();

  const [messages, setMessages] = useState([]);
  const [telemetry, setTelemetry] = useState(emptyTelemetry());
  const [inspectorItems, setInspectorItems] = useState([]);
  const [storageReady, setStorageReady] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);

  const listRef = useRef(null);
  const persistTimerRef = useRef(null);
  const swipeRef = useRef({ x: 0, y: 0 });

  const pagination = useMemo(
    () => derivePagination(messages, pageIndex, pageSize),
    [messages, pageIndex, pageSize],
  );

  const { pages, lastPageIndex, safePageIndex, currentPage, isOnLastPage } = pagination;
  const telemetryText = useMemo(() => buildTelemetryText(telemetry), [telemetry]);
  const composerDisabled = !storageReady || !isHydrated || isLoading;

  const navigate = useCallback(
    (nextRoute) => {
      if (nextRoute === route) return;
      history.pushState({}, "", nextRoute);
      setRoute(nextRoute);
    },
    [route, setRoute],
  );

  const goPrevPage = useCallback(() => {
    setPageIndex(clamp(safePageIndex - 1, 0, lastPageIndex));
  }, [safePageIndex, lastPageIndex, setPageIndex]);

  const goNextPage = useCallback(() => {
    setPageIndex(clamp(safePageIndex + 1, 0, lastPageIndex));
  }, [safePageIndex, lastPageIndex, setPageIndex]);



  const focusComposer = useCallback(() => {
    const el = document.querySelector('textarea[aria-label="New message"]');
    el?.focus();
  }, []);

  const toggleFocusedMessageDetails = useCallback(() => {
    if (focusedMessageIndex < 0) return false;
    const root = listRef.current;
    if (!root) return false;

    const cards = root.querySelectorAll("article");
    const card = cards?.[focusedMessageIndex];
    if (!card) return false;

    const details = card.querySelectorAll("details");
    if (!details.length) return false;

    details.forEach((node) => {
      node.open = !node.open;
    });
    return true;
  }, [focusedMessageIndex]);

  const copyFocusedMessage = useCallback(async () => {
    if (focusedMessageIndex < 0) return false;
    const msg = currentPage?.[focusedMessageIndex];
    const text = typeof msg?.content === "string" ? msg.content : "";
    if (!text || !navigator?.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  }, [currentPage, focusedMessageIndex]);

  const onTouchStart = useCallback((e) => {
    const t = e.touches[0];
    swipeRef.current = { x: t.clientX, y: t.clientY };
  }, []);

  const onTouchEnd = useCallback(
    (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - swipeRef.current.x;
      const dy = t.clientY - swipeRef.current.y;
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx > 0) goPrevPage();
      else goNextPage();
    },
    [goNextPage, goPrevPage],
  );

  const send = useCallback(async () => {
    if (!storageReady || !isHydrated) {
      setStatus("storage: OPFS not ready");
      return;
    }

    const text = prompt.trim();
    if (!text || isLoading) return;

    const userMsg = makeUserMessage(text);
    const nextMessages = normalizeMessages([...messages, userMsg]);

    setMessages(nextMessages);
    setPrompt("");
    setIsLoading(true);
    setStatus("agent: loading");

    try {
      const payload = { ...CONTEXT, stream: false, messages: nextMessages };
      const res = await fetch("/api/agent/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-id": CONTEXT.tenantId,
          "x-user-id": CONTEXT.userId,
          "x-agent-id": CONTEXT.agentId,
        },
        body: JSON.stringify(payload),
      });

      const rawText = await res.text();
      const data = parseJsonSafe(rawText, null);

      if (!res.ok) {
        const msg = data?.error || data?.detail || rawText || "request failed";
        throw new Error(msg);
      }

      const generated =
        Array.isArray(data?.generatedMessages) && data.generatedMessages.length
          ? data.generatedMessages
          : [data?.message];

      setMessages((prev) => [...prev, ...generated.filter(Boolean).map((m) => sanitizeMessage(m))]);

      const usage = data?.usage || null;
      const compaction = data?.compaction || null;
      setTelemetry({ usage, compaction });

      const tokenPart = typeof usage?.totalTokens === "number" ? ` · ${usage.totalTokens} tok` : "";
      const compactPart = compaction?.triggered ? ` · compacted ${compaction?.droppedMessages ?? 0}` : "";
      setStatus(`agent: ready · ${data?.model || CONTEXT.model}${tokenPart}${compactPart}`);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        sanitizeMessage({
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "unknown error"}`,
        }),
      ]);
      setStatus("error");
    } finally {
      setIsLoading(false);
    }
  }, [
    storageReady,
    isHydrated,
    prompt,
    isLoading,
    messages,
    setPrompt,
    setIsLoading,
    setStatus,
  ]);

  const refreshInspector = useCallback(async () => {
    setInspectorLoading(true);
    setInspectorStatus("scanning OPFS...");
    try {
      const root = await getOpfsRoot();
      const items = await walkOpfs(root);
      setInspectorItems(items);
      setInspectorStatus(`ready · ${items.length} entries`);
    } catch (err) {
      setInspectorItems([]);
      setInspectorStatus(`error · ${err instanceof Error ? err.message : "failed to scan OPFS"}`);
    } finally {
      setInspectorLoading(false);
    }
  }, [setInspectorLoading, setInspectorStatus]);

  const viewFile = useCallback(
    async (path) => {
      setSelectedFilePath(path);
      setSelectedFileContent("");
      setSelectedFileMeta(null);
      try {
        const { file, text } = await readOpfsFileByPath(path);
        const json = parseJsonSafe(text, null);
        setSelectedFileContent(json ? JSON.stringify(json, null, 2) : text);
        setSelectedFileMeta({
          size: file.size,
          type: file.type || "text/plain",
          modified: new Date(file.lastModified).toISOString(),
        });
      } catch (err) {
        setSelectedFileContent(`Failed to open file: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    },
    [setSelectedFileContent, setSelectedFileMeta, setSelectedFilePath],
  );

  const clearCurrentSession = useCallback(async () => {
    setInspectorStatus("clearing session...");
    try {
      await clearSnapshotFromOpfs(SNAPSHOT_FILE_NAME);
      setMessages([]);
      setTelemetry(emptyTelemetry());
      resetInspectorSelection();
      setInspectorStatus("session cleared");
      await refreshInspector();
    } catch (err) {
      setInspectorStatus(`error · ${err instanceof Error ? err.message : "failed to clear session"}`);
    }
  }, [refreshInspector, resetInspectorSelection, setInspectorStatus]);

  useEffect(() => {
    const onPopState = () => setRoute(normalizeRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [setRoute]);



  useEffect(() => {
    setPageIndex((prev) => clamp(prev, 0, lastPageIndex));
  }, [lastPageIndex, setPageIndex]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const snapshot = await readSnapshotFromOpfs(SNAPSHOT_FILE_NAME, {
          sanitizeMessage: (m) => sanitizeMessage(m),
          emptySnapshot,
        });
        if (!active) return;
        setMessages(normalizeMessages(snapshot.messages));
        setTelemetry(snapshot.telemetry || emptyTelemetry());
        setStorageReady(true);
        setIsHydrated(true);
        setStatus("storage: opfs ready");
      } catch {
        if (!active) return;
        setStorageReady(false);
        setIsHydrated(false);
        setStatus("storage: opfs unavailable");
      }
    })();

    return () => {
      active = false;
    };
  }, [setStatus]);

  useEffect(() => {
    if (!storageReady || !isHydrated) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);

    persistTimerRef.current = setTimeout(async () => {
      try {
        await writeSnapshotToOpfs(SNAPSHOT_FILE_NAME, {
          updatedAt: new Date().toISOString(),
          telemetry,
          messages: messages.map((m) => sanitizeMessage(m)),
        });
        setStatus((prev) => (prev.startsWith("error") ? prev : "storage: synced"));
      } catch {
        setStatus("error: failed to sync OPFS");
      }
    }, 150);

    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [isHydrated, messages, storageReady, telemetry, setStatus]);


  useEffect(() => {
    setFocusedMessageIndex((prev) => {
      const max = currentPage.length - 1;
      if (max < 0) return -1;
      if (prev < 0) return 0;
      return Math.min(prev, max);
    });
  }, [currentPage.length, safePageIndex, setFocusedMessageIndex]);

  useEffect(() => {
    if (route === ROUTES.STORAGE) refreshInspector();
  }, [refreshInspector, route]);

  return {
    route,
    navigate,
    prompt,
    setPrompt,
    status,
    setStatus,

    isLoading,
    messages,
    telemetry,
    telemetryText,
    storageReady,
    isHydrated,

    pageIndex: safePageIndex,
    pages,
    currentPage,
    isOnLastPage,
    focusedMessageIndex,
    setFocusedMessageIndex,
    goPrevPage,
    goNextPage,

    listRef,
    onTouchStart,
    onTouchEnd,
    focusComposer,
    toggleFocusedMessageDetails,
    copyFocusedMessage,

    send,
    composerDisabled,

    inspectorItems,
    inspectorStatus,
    inspectorLoading,
    selectedFilePath,
    selectedFileContent,
    selectedFileMeta,
    refreshInspector,
    viewFile,
    clearCurrentSession,
  };
}