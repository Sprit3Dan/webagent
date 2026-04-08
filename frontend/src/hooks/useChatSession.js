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
import { createAndRegisterSkill } from "../lib/skills";
import {
  buildConversationMemoryPromptBlock,
  listAllSkillMemoryRecords,
  listConversationFactMemories,
  listStoreRecords,
  readPersistedLlmProviderSettings,
  readSkillDocument,
  searchConversationMemoryKnn,
  writeConversationFactMemories,
  writePersistedLlmProviderSettings,
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
import { WEBGPU_EMBEDDINGS_DEFAULTS, embedText } from "../lib/webgpuEmbeddings";

const SLIDING_WINDOW_ROUNDS = 10;
const MEMORY_KNN_TOP_K = 12;
const MEMORY_MIN_SCORE_FLOOR = 0.72;
const MEMORY_SCORE_MARGIN_FROM_TOP = 0.08;
const MEMORY_MAX_PROMPT_HITS = 8;
const MEMORY_EMBED_MODEL = WEBGPU_EMBEDDINGS_DEFAULTS.model;
const MEMORY_EMBED_DEVICE = WEBGPU_EMBEDDINGS_DEFAULTS.device;
const FACT_EXTRACTION_MAX_FACTS = 3;
const FACT_EXTRACTION_MIN_USER_CHARS = 12;
const FACT_DEDUP_KNN_THRESHOLD = 0.95;

function pickSlidingWindowMessages(messages, rounds = SLIDING_WINDOW_ROUNDS) {
  const all = normalizeMessages(Array.isArray(messages) ? messages : []);
  if (!all.length) return [];

  const targetMessages = Math.max(1, Number(rounds) || SLIDING_WINDOW_ROUNDS);
  const hasSystemPrefix = String(all[0]?.role || "") === "system";
  const prefix = hasSystemPrefix ? [all[0]] : [];
  const body = hasSystemPrefix ? all.slice(1) : all;

  if (body.length <= targetMessages) {
    return normalizeMessages([...prefix, ...body]);
  }

  const slicedBody = body.slice(-targetMessages);
  return normalizeMessages([...prefix, ...slicedBody]);
}

function summarizeMemoryHits(hits) {
  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) {
    return {
      count: 0,
      topScore: 0,
      avgScore: 0,
      topBaseScore: 0,
      avgBaseScore: 0,
      topRecencyBonus: 0,
      avgRecencyBonus: 0,
      topSessionBonus: 0,
      avgSessionBonus: 0,
      sessions: [],
      turnIndexes: [],
    };
  }

  const scores = list.map((item) => Number(item?.score || 0));
  const baseScores = list.map((item) => Number(item?.baseScore || item?.score || 0));
  const recencyBonuses = list.map((item) => Number(item?.recencyBonus || 0));
  const sessionBonuses = list.map((item) => Number(item?.sessionBonus || 0));

  const avgScore = scores.reduce((acc, n) => acc + n, 0) / scores.length;
  const avgBaseScore = baseScores.reduce((acc, n) => acc + n, 0) / baseScores.length;
  const avgRecencyBonus =
    recencyBonuses.reduce((acc, n) => acc + n, 0) / recencyBonuses.length;
  const avgSessionBonus =
    sessionBonuses.reduce((acc, n) => acc + n, 0) / sessionBonuses.length;

  const sessions = Array.from(
    new Set(list.map((item) => String(item?.sessionId || "")).filter(Boolean)),
  ).slice(0, 6);
  const turnIndexes = list
    .map((item) => Number(item?.turnIndex || 0))
    .filter((n) => Number.isFinite(n))
    .slice(0, 10);

  return {
    count: list.length,
    topScore: Math.max(...scores),
    avgScore,
    topBaseScore: Math.max(...baseScores),
    avgBaseScore,
    topRecencyBonus: Math.max(...recencyBonuses),
    avgRecencyBonus,
    topSessionBonus: Math.max(...sessionBonuses),
    avgSessionBonus,
    sessions,
    turnIndexes,
  };
}

function logMemoryRetrieval({
  queryText = "",
  hits = [],
  minScore = MEMORY_MIN_SCORE_FLOOR,
  topK = MEMORY_KNN_TOP_K,
  durationMs = 0,
} = {}) {
  const summary = summarizeMemoryHits(hits);
  console.info("[memory:knn] retrieval", {
    queryPreview: String(queryText || "").slice(0, 120),
    minScore,
    topK,
    durationMs: Number(durationMs) || 0,
    hitCount: summary.count,
    topScore: summary.topScore,
    avgScore: summary.avgScore,
    topBaseScore: summary.topBaseScore,
    avgBaseScore: summary.avgBaseScore,
    topRecencyBonus: summary.topRecencyBonus,
    avgRecencyBonus: summary.avgRecencyBonus,
    topSessionBonus: summary.topSessionBonus,
    avgSessionBonus: summary.avgSessionBonus,
    sessions: summary.sessions,
    turnIndexes: summary.turnIndexes,
  });
}

function cosineSimilarityVectors(a = [], b = []) {
  const v1 = Array.isArray(a) ? a : [];
  const v2 = Array.isArray(b) ? b : [];
  if (!v1.length || !v2.length || v1.length !== v2.length) return 0;

  let dot = 0;
  let n1 = 0;
  let n2 = 0;

  for (let i = 0; i < v1.length; i += 1) {
    const x = Number(v1[i]) || 0;
    const y = Number(v2[i]) || 0;
    dot += x * y;
    n1 += x * x;
    n2 += y * y;
  }

  if (!n1 || !n2) return 0;
  return dot / (Math.sqrt(n1) * Math.sqrt(n2));
}

async function extractMajorUserFactsWithLlm({
  userText = "",
  selectedLlmProvider = null,
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
  sessionId = "default",
} = {}) {
  const text = String(userText || "").trim();
  if (text.length < FACT_EXTRACTION_MIN_USER_CHARS) return [];

  const systemPrompt = [
    "Extract only major, durable user facts from the message.",
    "Return strict JSON object: {\"facts\":[\"...\"]}.",
    `Include at most ${FACT_EXTRACTION_MAX_FACTS} facts.`,
    "Do not include transient requests like 'more' or short acknowledgements.",
    "If no major facts, return {\"facts\":[]}.",
  ].join(" ");

  const payload = {
    tenantId,
    userId,
    agentId,
    sessionId,
    model: String(selectedLlmProvider?.model || CONTEXT.model || "").trim() || CONTEXT.model,
    stream: false,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    metadata: {
      llmProvider: {
        id: String(selectedLlmProvider?.id || ""),
        name: String(selectedLlmProvider?.name || ""),
        provider: String(selectedLlmProvider?.provider || ""),
        baseUrl: String(selectedLlmProvider?.baseUrl || ""),
      },
    },
  };

  const startedAt =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  try {
    console.info("[memory:facts] extractor:start", {
      userChars: text.length,
      maxFacts: FACT_EXTRACTION_MAX_FACTS,
      model: payload.model,
      hasBaseUrl: Boolean(payload?.metadata?.llmProvider?.baseUrl),
    });

    const sseEvents = await postJsonAndConsumeSse(
      "/api/agent/respond/sse",
      { ...payload, stream: true },
      {
        headers: {
          "content-type": "application/json",
          "x-tenant-id": tenantId,
          "x-user-id": userId,
          "x-agent-id": agentId,
        },
      },
    );

    let raw = "";

    for (const evt of sseEvents) {
      const payloadJson =
        evt?.json && typeof evt.json === "object"
          ? evt.json
          : parseJsonSafe(evt?.data || "", null);

      if (!payloadJson) continue;

      if (evt.event === "delta" && payloadJson.type === "content") {
        raw += String(payloadJson.text || "");
        continue;
      }

      if (evt.event === "message") {
        const full = String(payloadJson.content || "").trim();
        if (full) raw = full;
        continue;
      }

      if (evt.event === "done") {
        const doneFull = String(payloadJson?.message?.content || "").trim();
        if (doneFull) raw = doneFull;
      }
    }

    raw = String(raw || "").trim();
    if (!raw) {
      console.info("[memory:facts] extractor:empty", {
        durationMs: Math.round(
          (typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now()) - startedAt,
        ),
      });
      return [];
    }

    const normalized = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = parseJsonSafe(normalized, null) || parseJsonSafe(raw, null);
    const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];

    const deduped = [];
    const seen = new Set();
    for (const item of facts) {
      const fact = String(item || "").replace(/\s+/g, " ").trim();
      if (!fact) continue;
      const key = fact.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(fact);
      if (deduped.length >= FACT_EXTRACTION_MAX_FACTS) break;
    }

    const endedAt =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();

    console.info("[memory:facts] extractor:done", {
      durationMs: Math.round(endedAt - startedAt),
      parsedFacts: deduped.length,
      rawPreview: raw.slice(0, 220),
    });

    return deduped;
  } catch (err) {
    const endedAt =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();

    console.warn(
      "[memory:facts] extractor:failed",
      err instanceof Error ? err.message : "unknown error",
      { durationMs: Math.round(endedAt - startedAt) },
    );
    return [];
  }
}

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
    llmProviders,
    setLlmProviders,
    activeLlmProviderId,
    setActiveLlmProviderId,
    activeLlmProvider,
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
  const spaceToggleIntentRef = useRef(false);

  const pagination = useMemo(
    () => derivePagination(messages, pageIndex, pageSize),
    [messages, pageIndex, pageSize],
  );

  const { pages, lastPageIndex, safePageIndex, currentPage, isOnLastPage } = pagination;
  const telemetryText = useMemo(() => buildTelemetryText(telemetry), [telemetry]);
  const composerDisabled = !storageReady || !isHydrated || !toolsReady;
  const selectedLlmProvider = useMemo(() => {
    const providers = Array.isArray(llmProviders) ? llmProviders : [];
    if (!providers.length) return null;
    return (
      providers.find(
        (provider) => String(provider?.id || "") === String(activeLlmProviderId || ""),
      ) ||
      activeLlmProvider ||
      providers[0]
    );
  }, [activeLlmProvider, activeLlmProviderId, llmProviders]);

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

  const updateActiveLlmProvider = useCallback(
    (patch = {}) => {
      const targetId = String(
        activeLlmProviderId ||
          (Array.isArray(llmProviders) && llmProviders.length ? llmProviders[0]?.id : ""),
      );

      setLlmProviders((prev) => {
        const list = Array.isArray(prev) ? prev : [];
        return list.map((provider) =>
          String(provider?.id || "") === targetId ? { ...provider, ...patch } : provider,
        );
      });
    },
    [activeLlmProviderId, llmProviders, setLlmProviders],
  );

  const addLlmProvider = useCallback(() => {
    const providerId = `provider-${Date.now()}`;
    const nextProvider = {
      id: providerId,
      name: `provider-${(Array.isArray(llmProviders) ? llmProviders.length : 0) + 1}`,
      provider: "openai-compatible",
      baseUrl: "",
      model: String(CONTEXT.model || "nemotron-30b"),
      contextWindowTokens: Number(CONTEXT.contextWindowTokens || 64_000),
      tokenBudget: 0,
      tokenSecret: "",
    };

    setLlmProviders((prev) => [...(Array.isArray(prev) ? prev : []), nextProvider]);
    setActiveLlmProviderId(providerId);
  }, [llmProviders, setActiveLlmProviderId, setLlmProviders]);

  const removeLlmProvider = useCallback(
    (providerId) => {
      const list = Array.isArray(llmProviders) ? llmProviders : [];
      if (list.length <= 1) return;

      const targetId = String(providerId || activeLlmProviderId || "");
      const filtered = list.filter((provider) => String(provider?.id || "") !== targetId);
      if (!filtered.length) return;

      setLlmProviders(filtered);
      if (String(activeLlmProviderId || "") === targetId) {
        setActiveLlmProviderId(String(filtered[0]?.id || ""));
      }
    },
    [activeLlmProviderId, llmProviders, setActiveLlmProviderId, setLlmProviders],
  );

  const saveLlmSettings = useCallback(async () => {
    try {
      await writePersistedLlmProviderSettings({
        providers: llmProviders,
        activeProviderId: activeLlmProviderId,
      });
      setStatus("settings: saved");
    } catch (err) {
      setStatus(
        `settings: save failed · ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }, [activeLlmProviderId, llmProviders, setStatus]);

  const focusComposer = useCallback(() => {
    const el = document.querySelector('textarea[aria-label="New message"]');
    el?.focus();
  }, []);

  const toggleFocusedMessageDetails = useCallback(() => {
    if (!spaceToggleIntentRef.current) return false;
    if (focusedMessageIndex < 0) return false;
    const root = listRef.current;
    if (!root) return false;

    const cards = root.querySelectorAll("article");
    const card = cards?.[focusedMessageIndex];
    if (!card) return false;

    const details = card.querySelectorAll("details");
    if (!details.length) return false;

    const shouldOpenAll = Array.from(details).some((node) => !node.open);
    details.forEach((node) => {
      node.open = shouldOpenAll;
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
    const onKeyDown = (event) => {
      if (route !== ROUTES.CHAT) return;
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== " ") return;

      const target = event.target;
      const tag = target?.tagName?.toLowerCase?.() || "";
      const editable = target?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
      if (editable) return;

      event.preventDefault();
      spaceToggleIntentRef.current = true;
      try {
        void toggleFocusedMessageDetails();
      } finally {
        spaceToggleIntentRef.current = false;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [route, toggleFocusedMessageDetails]);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        await loadFrontendToolDefinitionsFromOpfs({ persistFallback: true });
        await createAndRegisterSkill({ name: "sw_unified_knowledge_runtime" });

        const persisted = await readPersistedLlmProviderSettings();
        const persistedProviders = Array.isArray(persisted?.providers) ? persisted.providers : [];
        if (active && persistedProviders.length) {
          setLlmProviders(persistedProviders);
          setActiveLlmProviderId(
            String(persisted?.activeProviderId || persistedProviders[0]?.id || ""),
          );
        }
      } finally {
        if (active) setToolsReady(true);
      }
    })();

    return () => {
      active = false;
    };
  }, [setActiveLlmProviderId, setLlmProviders]);

  const send = useCallback(async (inputText = null) => {
    if (!storageReady || !isHydrated) {
      setStatus("storage: OPFS not ready");
      return;
    }

    if (!toolsReady) {
      setStatus("tools: loading");
      return;
    }

    const resolvedInput = typeof inputText === "string" ? inputText : prompt;
    const text = resolvedInput.trim();
    if (!text) return;

    const userMsg = makeUserMessage(text);
    const nextMessages = normalizeMessages([...messages, userMsg]);

    setMessages(nextMessages);
    if (typeof inputText !== "string") {
      setPrompt("");
    }

    setIsLoading(true);
    setStatus("agent: loading");

    const turnIndex = Math.max(
      0,
      nextMessages.filter((m) => String(m?.role || "") === "user").length - 1,
    );
    let memoryQueued = false;
    try {
      memoryQueued = true;

      void (async () => {
        const startedAt =
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();

        try {
          console.info("[memory:facts] background:start", {
            turnIndex,
            userChars: String(text || "").length,
            model: String(selectedLlmProvider?.model || CONTEXT.model || ""),
          });

          const factTexts = await extractMajorUserFactsWithLlm({
            userText: text,
            selectedLlmProvider,
            tenantId: CONTEXT.tenantId,
            userId: CONTEXT.userId,
            agentId: CONTEXT.agentId,
            sessionId: CONTEXT.sessionId,
          });

          if (!factTexts.length) {
            const endedAt =
              typeof performance !== "undefined" && typeof performance.now === "function"
                ? performance.now()
                : Date.now();

            console.info("[memory:facts] background:none", {
              turnIndex,
              durationMs: Math.round(endedAt - startedAt),
            });
            return;
          }

          console.info("[memory:facts] background:embedding", {
            turnIndex,
            factCount: factTexts.length,
            model: MEMORY_EMBED_MODEL,
            device: MEMORY_EMBED_DEVICE,
            facts: factTexts,
          });

          const facts = await Promise.all(
            factTexts.map(async (factText, factIndex) => {
              const embedStartedAt =
                typeof performance !== "undefined" && typeof performance.now === "function"
                  ? performance.now()
                  : Date.now();

              const vec = await embedText(factText, {
                model: MEMORY_EMBED_MODEL,
                device: MEMORY_EMBED_DEVICE,
              });

              const embedEndedAt =
                typeof performance !== "undefined" && typeof performance.now === "function"
                  ? performance.now()
                  : Date.now();

              console.info("[memory:facts] background:embedded", {
                turnIndex,
                factIndex,
                factPreview: factText.slice(0, 180),
                dimensions: Array.isArray(vec?.embedding) ? vec.embedding.length : 0,
                durationMs: Math.round(embedEndedAt - embedStartedAt),
              });

              return {
                text: factText,
                embedding: vec.embedding,
              };
            }),
          );

          const existingFacts = await listConversationFactMemories({
            tenantId: CONTEXT.tenantId,
            userId: CONTEXT.userId,
            agentId: CONTEXT.agentId,
            sessionId: CONTEXT.sessionId,
            limit: 2000,
            offset: 0,
            sortDesc: true,
          });

          const dedupedFacts = [];
          for (const fact of facts) {
            const candidateVec = Array.isArray(fact?.embedding) ? fact.embedding : [];
            if (!candidateVec.length) continue;

            const duplicateInExisting = existingFacts.some((row) => {
              const existingVec = Array.isArray(row?.embedding) ? row.embedding : [];
              if (!existingVec.length || existingVec.length !== candidateVec.length) return false;
              return cosineSimilarityVectors(candidateVec, existingVec) >= FACT_DEDUP_KNN_THRESHOLD;
            });

            if (duplicateInExisting) continue;

            const duplicateInBatch = dedupedFacts.some((row) => {
              const priorVec = Array.isArray(row?.embedding) ? row.embedding : [];
              if (!priorVec.length || priorVec.length !== candidateVec.length) return false;
              return cosineSimilarityVectors(candidateVec, priorVec) >= FACT_DEDUP_KNN_THRESHOLD;
            });

            if (duplicateInBatch) continue;
            dedupedFacts.push(fact);
          }

          if (!dedupedFacts.length) {
            console.info("[memory:facts] background:deduped-all", {
              turnIndex,
              threshold: FACT_DEDUP_KNN_THRESHOLD,
              extracted: facts.length,
              existing: existingFacts.length,
            });
            return;
          }

          await writeConversationFactMemories({
            tenantId: CONTEXT.tenantId,
            userId: CONTEXT.userId,
            agentId: CONTEXT.agentId,
            sessionId: CONTEXT.sessionId,
            turnIndex,
            embeddingModel: MEMORY_EMBED_MODEL,
            facts: dedupedFacts,
          });

          const endedAt =
            typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : Date.now();

          console.info("[memory:facts] background:stored", {
            turnIndex,
            count: dedupedFacts.length,
            extractedCount: facts.length,
            threshold: FACT_DEDUP_KNN_THRESHOLD,
            durationMs: Math.round(endedAt - startedAt),
          });
        } catch (err) {
          const endedAt =
            typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : Date.now();

          console.warn(
            "[memory:facts] background extraction failed",
            err instanceof Error ? err.message : "unknown error",
            { turnIndex, durationMs: Math.round(endedAt - startedAt) },
          );
        }
      })();
    } catch (err) {
      console.warn(
        "[memory:facts] queue failed",
        err instanceof Error ? err.message : "unknown error",
      );
    }

    try {
      let workingMessages = nextMessages;
      let generatedAggregate = [];
      let usage = null;
      let compaction = null;
      const effectiveModel =
        String(selectedLlmProvider?.model || CONTEXT.model || "").trim() || CONTEXT.model;
      const effectiveContextWindowTokens = Math.max(
        1,
        Number(
          selectedLlmProvider?.contextWindowTokens || CONTEXT?.contextWindowTokens || 64_000,
        ) || 64_000,
      );
      let modelName = effectiveModel;
      let executedTools = 0;
      let systemContextMessage = null;
      let promptMemoriesForAssistant = [];
      let promptMemoryMetaForAssistant = null;

      for (let round = 0; round < 4; round += 1) {
        let requestMessages = workingMessages;

        if (round === 0) {
          const historyWithoutCurrent = workingMessages.slice(0, -1);
          const slidingWindowHistory = pickSlidingWindowMessages(
            historyWithoutCurrent,
            SLIDING_WINDOW_ROUNDS,
          );
          const currentMessage = String(
            workingMessages[workingMessages.length - 1]?.content || "",
          );

          let heartbeatMemoryText = "";
          try {
            const heartbeatDoc = await readSkillDocument("system::heartbeat::pending-markdown");
            heartbeatMemoryText =
              typeof heartbeatDoc?.text === "string" ? heartbeatDoc.text : "";
          } catch {
            heartbeatMemoryText = "";
          }

          let memoryHits = [];
          let memoryRetrievalMs = 0;
          try {
            const t0 =
              typeof performance !== "undefined" && typeof performance.now === "function"
                ? performance.now()
                : Date.now();

            const queryEmbedding = await embedText(currentMessage, {
              model: MEMORY_EMBED_MODEL,
              device: MEMORY_EMBED_DEVICE,
            });

            const totalPriorUserTurns = historyWithoutCurrent
              .filter((m) => String(m?.role || "") === "user")
              .length;
            const slidingWindowUserTurns = slidingWindowHistory
              .filter((m) => String(m?.role || "") === "user")
              .length;
            const firstExcludedTurnIndex = Math.max(
              0,
              totalPriorUserTurns - slidingWindowUserTurns,
            );
            const excludeTurnIndexes = Array.from(
              { length: slidingWindowUserTurns },
              (_, idx) => firstExcludedTurnIndex + idx,
            );

            const knn = await searchConversationMemoryKnn({
              tenantId: CONTEXT.tenantId,
              userId: CONTEXT.userId,
              agentId: CONTEXT.agentId,
              sessionId: CONTEXT.sessionId,
              excludeSessionId: CONTEXT.sessionId,
              excludeTurnIndexes,
              queryEmbedding: queryEmbedding.embedding,
              topK: MEMORY_KNN_TOP_K,
              minScore: MEMORY_MIN_SCORE_FLOOR,
              recencyWeight: 0.12,
              recencyHalfLifeHours: 48,
              sameSessionBoost: 0.08,
            });

            memoryRetrievalMs =
              (typeof performance !== "undefined" && typeof performance.now === "function"
                ? performance.now()
                : Date.now()) - t0;

            const rawHits = Array.isArray(knn?.hits) ? knn.hits : [];
            const topScore = rawHits.length
              ? Math.max(...rawHits.map((item) => Number(item?.score || 0)))
              : 0;
            const adaptiveMinScore = Math.max(
              MEMORY_MIN_SCORE_FLOOR,
              topScore - MEMORY_SCORE_MARGIN_FROM_TOP,
            );

            memoryHits = rawHits
              .filter((item) => Number(item?.score || 0) >= adaptiveMinScore)
              .slice(0, MEMORY_MAX_PROMPT_HITS);

            promptMemoriesForAssistant = memoryHits;
            promptMemoryMetaForAssistant = {
              minScore: adaptiveMinScore,
              topK: MEMORY_KNN_TOP_K,
              retrievalMs: memoryRetrievalMs,
              hitCount: memoryHits.length,
            };

            logMemoryRetrieval({
              queryText: currentMessage,
              hits: memoryHits,
              minScore: adaptiveMinScore,
              topK: MEMORY_KNN_TOP_K,
              durationMs: memoryRetrievalMs,
            });
          } catch (err) {
            console.warn(
              "[memory:knn] retrieval failed",
              err instanceof Error ? err.message : "unknown error",
            );
          }

          const memoryPromptBlock = buildConversationMemoryPromptBlock(memoryHits);
          const memorySections = [];
          if (heartbeatMemoryText) {
            memorySections.push(`## Heartbeat Pending Markdown\n\n${heartbeatMemoryText}`);
          }
          if (memoryPromptBlock) {
            memorySections.push(memoryPromptBlock);
          }

          const opfsMemoryPolicyText = [
            "## Persistence Policy",
            "- Store frequently-needed user facts, agent identity, and operating process in OPFS context files via opfs_* tools.",
            "- Use `USER.md` for user profile and preferences, `SOUL.md` for stable agent behavior, `AGENTS.md` for process/runbook, `TOOLS.md` for tool instructions.",
            "- IndexedDB memory tools are long-term retrieval memory only and may not be injected into every prompt.",
            "- If new information should be reliably present in future prompts, persist it to OPFS first; optionally mirror to IndexedDB for long-term recall.",
            "- Grounding rule: if asked about prior conversation and no retrieved memory evidence is provided, do not claim certainty or recall; state that memory evidence is unavailable in the current context.",
            "- When memory evidence exists, prefer citing those retrieved memories over assumptions.",

          ].join("\n");

          const built = await buildContextForLlm({
            history: slidingWindowHistory,
            currentMessage,
            tenantId: CONTEXT.tenantId,
            userId: CONTEXT.userId,
            agentId: CONTEXT.agentId,
            sessionId: CONTEXT.sessionId,
            route,
            page: route === ROUTES.STORAGE ? "storage" : "chat",
            memoryText: memorySections.join("\n\n"),
            skillsText: opfsMemoryPolicyText,
          });

          requestMessages = built.messages;
          systemContextMessage = built.messages[0] || null;
        } else if (systemContextMessage) {
          const slidingWindowFollowUp = pickSlidingWindowMessages(
            workingMessages,
            SLIDING_WINDOW_ROUNDS,
          );
          requestMessages = normalizeMessages([
            systemContextMessage,
            ...slidingWindowFollowUp,
          ]);
        }

        const requestMessagesWindowed = pickSlidingWindowMessages(
          requestMessages,
          SLIDING_WINDOW_ROUNDS,
        );

        const requestRoleCounts = requestMessagesWindowed.reduce((acc, msg) => {
          const role = String(msg?.role || "unknown");
          acc[role] = (acc[role] || 0) + 1;
          return acc;
        }, {});

        console.info("[context:sliding-window]", {
          round,
          totalMessages: requestMessagesWindowed.length,
          roleCounts: requestRoleCounts,
          slidingWindowRounds: SLIDING_WINDOW_ROUNDS,
        });

        const payload = {
          ...CONTEXT,
          model: effectiveModel,
          stream: false,
          messages: requestMessagesWindowed,
          tools: listFrontendToolDefinitions(),
          metadata: {
            llmProvider: {
              id: String(selectedLlmProvider?.id || ""),
              name: String(selectedLlmProvider?.name || ""),
              provider: String(selectedLlmProvider?.provider || ""),
              baseUrl: String(selectedLlmProvider?.baseUrl || ""),
              tokenBudget: Math.max(0, Number(selectedLlmProvider?.tokenBudget) || 0),
              hasTokenSecret: Boolean(selectedLlmProvider?.tokenSecret),
            },
          },
        };

        const streamAssistantId = `stream-assistant-${Date.now()}-${round}`;
        const streamToolPreviewPrefix = `stream-tool-preview-${Date.now()}-${round}`;
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

        const upsertLiveToolCallPreviews = (toolCalls) => {
          const calls = Array.isArray(toolCalls) ? toolCalls : [];

          setMessages((prev) => {
            const base = prev.filter(
              (m) => !String(m?.timestamp || "").startsWith(streamToolPreviewPrefix),
            );

            if (!calls.length) return base;

            const previews = calls.map((call, idx) => {
              const fn = call?.function || {};
              const name = typeof fn?.name === "string" ? fn.name : "tool";
              const rawArgs = typeof fn?.arguments === "string" ? fn.arguments.trim() : "";
              const renderedArgs = rawArgs ? rawArgs.slice(0, 220) : "";
              const suffix = renderedArgs ? ` ${renderedArgs}` : "";

              return sanitizeMessage({
                role: "tool",
                content: `calling ${name}${suffix}`,
                timestamp: `${streamToolPreviewPrefix}-${idx}`,
              });
            });

            return [...base, ...previews];
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
                upsertLiveToolCallPreviews(liveToolCalls);
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
          .map((m) => {
            const sanitized = sanitizeMessage(m);
            const role = String(sanitized?.role || "").toLowerCase();

            if (role !== "assistant") return sanitized;
            if (!Array.isArray(promptMemoriesForAssistant) || !promptMemoriesForAssistant.length) {
              return sanitized;
            }

            return sanitizeMessage({
              ...sanitized,
              prompt_memories: promptMemoriesForAssistant,
              prompt_memory_meta: promptMemoryMetaForAssistant || undefined,
            });
          });

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

      setMessages((prev) => {
        const base = prev.filter((m) => {
          const ts = String(m?.timestamp || "");
          return !ts.startsWith("stream-assistant-") && !ts.startsWith("stream-tool-preview-");
        });

        const shared = globalThis?.WebagentRuntimeShared;
        if (shared && typeof shared.appendMessageToSession === "function") {
          let snapshot = {
            messages: base,
            telemetry: { usage: null, compaction: null },
          };

          for (const msg of generatedAggregate) {
            const updated = shared.appendMessageToSession(snapshot, msg, {
              contextWindowTokens: effectiveContextWindowTokens,
              dedupe: true,
            });
            snapshot = updated?.snapshot || snapshot;
          }

          return normalizeMessages(snapshot.messages);
        }

        return [...base, ...generatedAggregate];
      });
      setTelemetry({ usage, compaction });



      const tokenPart = typeof usage?.totalTokens === "number" ? ` · ${usage.totalTokens} tok` : "";
      const compactPart = compaction?.triggered ? ` · compacted ${compaction?.droppedMessages ?? 0}` : "";
      const toolPart = executedTools > 0 ? ` · tools ${executedTools}` : "";
      const memoryPart = memoryQueued ? " · memory queued" : "";
      setStatus(`agent: ready · ${modelName}${tokenPart}${compactPart}${toolPart}${memoryPart}`);
    } catch (err) {
      setMessages((prev) => [
        ...prev.filter((m) => {
          const ts = String(m?.timestamp || "");
          return !ts.startsWith("stream-assistant-") && !ts.startsWith("stream-tool-preview-");
        }),
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
    messages,
    route,
    selectedLlmProvider,
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

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;

    const onSwMessage = (event) => {
      const data = event?.data;
      if (!data || typeof data !== "object") return;
      if (data.type !== "heartbeat.assistant_note") return;

      const note = data?.message || {};
      const content = typeof note.content === "string" ? note.content.trim() : "";
      if (!content) return;

      const msg = sanitizeMessage({
        role: "assistant",
        content,
        timestamp: note.timestamp || new Date().toISOString(),
      });

      setMessages((prev) => normalizeMessages([...prev, msg]));
      setStatus("heartbeat: reviewed pending items");
    };

    navigator.serviceWorker.addEventListener("message", onSwMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onSwMessage);
    };
  }, [setStatus]);

  return {
    route,
    navigate,
    prompt,
    setPrompt,
    status,
    setStatus,
    llmProviders,
    activeLlmProviderId,
    activeLlmProvider,
    setActiveLlmProviderId,
    updateActiveLlmProvider,
    addLlmProvider,
    removeLlmProvider,
    saveLlmSettings,

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