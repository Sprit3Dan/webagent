const runtimeShared = globalThis?.WebagentRuntimeShared;
if (!runtimeShared) {
  throw new Error("Shared runtime module is required");
}

export function nowIso() {
  return runtimeShared.nowIso();
}

export function sanitizeMessage(message, fallbackRole = "assistant") {
  return runtimeShared.sanitizeMessage(message, fallbackRole);
}

export function makeUserMessage(content) {
  return sanitizeMessage({
    role: "user",
    content: typeof content === "string" ? content : "",
    timestamp: nowIso(),
  });
}

export function emptyTelemetry() {
  return { usage: null, compaction: null };
}

export function emptySnapshot() {
  return { messages: [], telemetry: emptyTelemetry() };
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function chunkMessages(messages, pageSize) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const safeSize = Math.max(1, Number(pageSize) || 1);

  if (!safeMessages.length) return [[]];

  const pages = [];
  for (let i = 0; i < safeMessages.length; i += safeSize) {
    pages.push(safeMessages.slice(i, i + safeSize));
  }
  return pages;
}

export function derivePagination(messages, pageIndex, pageSize) {
  const pages = chunkMessages(messages, pageSize);
  const lastPageIndex = Math.max(0, pages.length - 1);
  const safePageIndex = clamp(Number(pageIndex) || 0, 0, lastPageIndex);
  const currentPage = pages[safePageIndex] || [];
  const isOnLastPage = safePageIndex >= lastPageIndex;

  return {
    pages,
    lastPageIndex,
    safePageIndex,
    currentPage,
    isOnLastPage,
  };
}

export function normalizeMessages(input) {
  return runtimeShared.normalizeMessages(input);
}

export function buildTelemetryText(telemetry) {
  if (telemetry?.compaction?.triggered) {
    return `Compaction: ${telemetry.compaction.estimatedTokensBefore} → ${telemetry.compaction.estimatedTokensAfter} tokens`;
  }

  if (telemetry?.usage?.totalTokens) {
    return `Usage: ${telemetry.usage.inputTokens}/${telemetry.usage.outputTokens} in/out (${telemetry.usage.totalTokens} total)`;
  }

  return "Auto-persist: OPFS";
}