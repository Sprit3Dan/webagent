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
import { postJsonAndConsumeSse } from "../lib/sse";
import {
  executeFrontendToolCalls,
  listFrontendToolDefinitions,
  loadFrontendToolDefinitionsFromOpfs,
  toFrontendToolMessage,
} from "../lib/frontendTools";
import {
  listAllSkillMemoryRecords,
  listStoreRecords,
} from "../lib/skillMemory";
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
import { buildContextForLlm } from "../lib/contextBuilder";

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
  const [toolsReady, setToolsReady] = useState(false);

  const listRef = useRef(null);
  const persistTimerRef = useRef(null);
  const swipeRef = useRef({ x: 0, y: 0 });

  const pagination = useMemo(
    () => derivePagination(messages, pageIndex, pageSize),
    [messages, pageIndex, pageSize],
  );

  const { pages, lastPageIndex, safePageIndex, currentPage, isOnLastPage } = pagination;
  const telemetryText = useMemo(() => buildTelemetryText(telemetry), [telemetry]);
  const composerDisabled = !storageReady || !isHydrated || !toolsReady || isLoading;

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

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        await loadFrontendToolDefinitionsFromOpfs({ persistFallback: true });
      } finally {
        if (active) setToolsReady(true);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const send = useCallback(async () => {
    if (!storageReady || !isHydrated) {
      setStatus("storage: OPFS not ready");
      return;
    }

    if (!toolsReady) {
      setStatus("tools: loading");
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
      let workingMessages = nextMessages;
      let generatedAggregate = [];
      let usage = null;
      let compaction = null;
      let modelName = CONTEXT.model;
      let executedTools = 0;
      let systemContextMessage = null;

      for (let round = 0; round < 4; round += 1) {
        let requestMessages = workingMessages;

        if (round === 0) {
          const historyWithoutCurrent = workingMessages.slice(0, -1);
          const currentMessage = String(
            workingMessages[workingMessages.length - 1]?.content || "",
          );

          const built = await buildContextForLlm({
            history: historyWithoutCurrent,
            currentMessage,
            tenantId: CONTEXT.tenantId,
            userId: CONTEXT.userId,
            agentId: CONTEXT.agentId,
            sessionId: CONTEXT.sessionId,
            route,
            page: route === ROUTES.STORAGE ? "storage" : "chat",
          });

          requestMessages = built.messages;
          systemContextMessage = built.messages[0] || null;
        } else if (systemContextMessage) {
          requestMessages = normalizeMessages([
            systemContextMessage,
            ...workingMessages,
          ]);
        }

        const payload = {
          ...CONTEXT,
          stream: false,
          messages: requestMessages,
          tools: listFrontendToolDefinitions(),
        };

        const streamAssistantId = `stream-assistant-${Date.now()}-${round}`;
        let liveContent = "";
        let liveReasoning = "";
        let liveToolCalls = null;

        const upsertLiveAssistant = () => {
          setMessages((prev) => {
            const liveMessage = sanitizeMessage({
              role: "assistant",
              content: liveContent,
              reasoning: liveReasoning || undefined,
              tool_calls: Array.isArray(liveToolCalls) && liveToolCalls.length
                ? liveToolCalls
                : undefined,
              timestamp: streamAssistantId,
            });

            const idx = prev.findIndex((m) => m?.timestamp === streamAssistantId);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = liveMessage;
              return next;
            }
            return [...prev, liveMessage];
          });
        };

        const sseEvents = await postJsonAndConsumeSse(
          "/api/agent/respond/sse",
          payload,
          {
            headers: {
              "content-type": "application/json",
              "x-tenant-id": CONTEXT.tenantId,
              "x-user-id": CONTEXT.userId,
              "x-agent-id": CONTEXT.agentId,
            },
            onEvent: (evt) => {
              const payloadJson =
                evt?.json && typeof evt.json === "object"
                  ? evt.json
                  : parseJsonSafe(evt?.data || "", null);

              if (!payloadJson) return;
              if (evt.event !== "delta") return;

              if (payloadJson.type === "content" && typeof payloadJson.text === "string") {
                liveContent += payloadJson.text;
                upsertLiveAssistant();
                return;
              }

              if (payloadJson.type === "reasoning" && typeof payloadJson.text === "string") {
                liveReasoning += payloadJson.text;
                upsertLiveAssistant();
                return;
              }

              if (payloadJson.type === "tool_calls" && Array.isArray(payloadJson.toolCalls)) {
                liveToolCalls = payloadJson.toolCalls;
                upsertLiveAssistant();
              }
            },
          },
        );

        const sseData = {
          model: null,
          message: null,
          usage: null,
          compaction: null,
          generatedMessages: [],
          toolEvents: [],
        };

        for (const evt of sseEvents) {
          const payloadJson =
            evt?.json && typeof evt.json === "object"
              ? evt.json
              : parseJsonSafe(evt?.data || "", null);

          if (!payloadJson) continue;

          if (evt.event === "meta") {
            sseData.model = payloadJson.model || sseData.model;
            continue;
          }

          if (evt.event === "message") {
            sseData.generatedMessages.push(payloadJson);
            continue;
          }

          if (evt.event === "tool_event") {
            sseData.toolEvents.push(payloadJson);
            continue;
          }

          if (evt.event === "done") {
            sseData.message = payloadJson.message || sseData.message;
            sseData.usage = payloadJson.usage || sseData.usage;
            sseData.compaction = payloadJson.compaction || sseData.compaction;
          }
        }

        modelName = sseData.model || modelName;
        usage = sseData.usage || usage;
        compaction = sseData.compaction || compaction;

        const generated =
          Array.isArray(sseData.generatedMessages) && sseData.generatedMessages.length
            ? sseData.generatedMessages
            : [sseData.message];

        const normalizedGenerated = generated
          .filter(Boolean)
          .map((m) => sanitizeMessage(m));

        if (!normalizedGenerated.length) break;

        generatedAggregate = [...generatedAggregate, ...normalizedGenerated];
        workingMessages = normalizeMessages([
          ...workingMessages,
          ...normalizedGenerated,
        ]);

        const assistantWithTools = [...normalizedGenerated]
          .reverse()
          .find(
            (m) =>
              m?.role === "assistant" &&
              Array.isArray(m?.tool_calls) &&
              m.tool_calls.length > 0,
          );

        if (!assistantWithTools?.tool_calls?.length) {
          break;
        }

        const toolResults = await executeFrontendToolCalls(
          assistantWithTools.tool_calls,
          {
            tenantId: CONTEXT.tenantId,
            userId: CONTEXT.userId,
            agentId: CONTEXT.agentId,
            sessionId: CONTEXT.sessionId,
          },
        );

        executedTools += toolResults.length;

        const toolMessages = toolResults
          .map((result) => toFrontendToolMessage(result))
          .map((m) => sanitizeMessage(m));

        if (!toolMessages.length) break;

        generatedAggregate = [...generatedAggregate, ...toolMessages];
        workingMessages = normalizeMessages([
          ...workingMessages,
          ...toolMessages,
        ]);
      }

      setMessages((prev) => [
        ...prev.filter(
          (m) => !String(m?.timestamp || "").startsWith("stream-assistant-"),
        ),
        ...generatedAggregate,
      ]);
      setTelemetry({ usage, compaction });

      const tokenPart = typeof usage?.totalTokens === "number" ? ` · ${usage.totalTokens} tok` : "";
      const compactPart = compaction?.triggered ? ` · compacted ${compaction?.droppedMessages ?? 0}` : "";
      const toolPart = executedTools > 0 ? ` · tools ${executedTools}` : "";
      setStatus(`agent: ready · ${modelName}${tokenPart}${compactPart}${toolPart}`);
    } catch (err) {
      setMessages((prev) => [
        ...prev.filter(
          (m) => !String(m?.timestamp || "").startsWith("stream-assistant-"),
        ),
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
    toolsReady,
    prompt,
    isLoading,
    messages,
    route,
    setPrompt,
    setIsLoading,
    setStatus,
  ]);

  const refreshInspector = useCallback(async () => {
    setInspectorLoading(true);
    setInspectorStatus("scanning OPFS + IndexedDB...");
    try {
      const [root, allIndexedDb] = await Promise.all([
        getOpfsRoot(),
        listAllSkillMemoryRecords({ limitPerStore: 1000 }),
      ]);

      const opfsItems = await walkOpfs(root);

      const indexedDbItems = Object.entries(allIndexedDb || {}).flatMap(
        ([storeName, records]) => {
          const safeRecords = Array.isArray(records) ? records : [];
          return safeRecords.map((record, idx) => {
            const recordId = String(record?.id ?? idx);
            return {
              kind: "file",
              path: `indexeddb/${storeName}/${encodeURIComponent(recordId)}`,
              name: `${storeName}:${recordId}`,
            };
          });
        },
      );

      const items = [...opfsItems, ...indexedDbItems];
      setInspectorItems(items);
      setInspectorStatus(
        `ready · ${opfsItems.length} OPFS + ${indexedDbItems.length} IndexedDB records`,
      );
    } catch (err) {
      setInspectorItems([]);
      setInspectorStatus(`error · ${err instanceof Error ? err.message : "failed to scan storage"}`);
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
        const indexedDbPrefix = "indexeddb/";
        if (String(path).startsWith(indexedDbPrefix)) {
          const rest = String(path).slice(indexedDbPrefix.length);
          const [storeName, ...idParts] = rest.split("/");
          const recordId = decodeURIComponent(idParts.join("/"));

          if (!storeName || !recordId) {
            throw new Error("Invalid IndexedDB path");
          }

          const records = await listStoreRecords(storeName, { limit: 10_000, offset: 0 });
          const payload = records.find((r) => String(r?.id) === String(recordId));

          if (!payload) {
            throw new Error(`IndexedDB record not found: ${storeName}/${recordId}`);
          }

          const text = JSON.stringify(payload, null, 2);
          setSelectedFileContent(text);
          setSelectedFileMeta({
            size: new TextEncoder().encode(text).byteLength,
            type: "application/json",
            modified: payload?.updatedAt || payload?.createdAt || new Date().toISOString(),
          });
          return;
        }

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