export function nowIso() {
  return new Date().toISOString();
}

export function sanitizeMessage(message, fallbackRole = "assistant") {
  return {
    role: message?.role || fallbackRole,
    content: typeof message?.content === "string" ? message.content : "",
    name: message?.name || undefined,
    tool_call_id: message?.tool_call_id || undefined,
    tool_calls: Array.isArray(message?.tool_calls) ? message.tool_calls : undefined,
    reasoning: typeof message?.reasoning === "string" ? message.reasoning : undefined,
    timestamp: message?.timestamp || nowIso(),
  };
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
  if (!Array.isArray(input)) return [];
  return input.map((m) => sanitizeMessage(m));
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