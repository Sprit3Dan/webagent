import { createAndRegisterSkill } from "./skills";

const SKILL_NAME = "sw_unified_knowledge_runtime";
const SW_PATH = "/sw.js";
const SW_TIMEOUT_MS = 20_000;



function safeJson(value, fallback = "{}") {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseArgs(rawArgs) {
  if (rawArgs == null) return {};
  if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) return rawArgs;
  if (typeof rawArgs !== "string") {
    throw new Error("Tool arguments must be a JSON object or JSON string");
  }

  const text = rawArgs.trim();
  if (!text) return {};

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON in tool arguments");
  }

  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments JSON must decode to an object");
  }
  return parsed;
}

const SUPPORTED_FRONTEND_TOOLS = new Set([
  "memory_ingest_url",
  "memory_ingest_text",
  "memory_query",
  "memory_list_documents",
  "memory_get_document",
  "memory_delete_document",
  "memory_clear",
]);

const DEFAULT_FRONTEND_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "memory_ingest_url",
      description: "Ingest a URL into local retrieval memory in the service worker",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          forceRefresh: { type: "boolean" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_ingest_text",
      description: "Ingest raw text into local retrieval memory in the service worker",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_query",
      description: "Query local retrieval memory and return relevant chunks",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          topK: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_list_documents",
      description: "List all indexed documents in local retrieval memory",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_get_document",
      description: "Get one indexed document and all of its chunks",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string" },
        },
        required: ["docId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_delete_document",
      description: "Delete one indexed document from local retrieval memory",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string" },
        },
        required: ["docId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_clear",
      description: "Clear local retrieval memory for current tenant/user/session scope",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

let frontendToolDefinitionsCache = deepClone(DEFAULT_FRONTEND_TOOL_DEFINITIONS);

function normalizeToolDefinitions(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();

  for (const item of arr) {
    const type = item?.type;
    const name = item?.function?.name;

    if (type !== "function") continue;
    if (typeof name !== "string" || !name.trim()) continue;
    if (!SUPPORTED_FRONTEND_TOOLS.has(name)) continue;
    if (seen.has(name)) continue;

    seen.add(name);
    out.push({
      type: "function",
      function: {
        name,
        description:
          typeof item?.function?.description === "string"
            ? item.function.description
            : undefined,
        parameters:
          item?.function?.parameters && typeof item.function.parameters === "object"
            ? item.function.parameters
            : { type: "object", properties: {}, additionalProperties: true },
      },
    });
  }

  return out;
}

async function writeDefinitionsToOpfs(definitions) {
  const normalized = normalizeToolDefinitions(definitions);
  if (normalized.length) {
    frontendToolDefinitionsCache = deepClone(normalized);
  }
  return deepClone(frontendToolDefinitionsCache);
}

export async function loadFrontendToolDefinitionsFromOpfs({
  persistFallback = true,
} = {}) {
  if (!persistFallback) {
    return deepClone(frontendToolDefinitionsCache);
  }

  if (!Array.isArray(frontendToolDefinitionsCache) || !frontendToolDefinitionsCache.length) {
    frontendToolDefinitionsCache = deepClone(DEFAULT_FRONTEND_TOOL_DEFINITIONS);
  }

  return deepClone(frontendToolDefinitionsCache);
}

export async function saveFrontendToolDefinitionsToOpfs(definitions) {
  const normalized = normalizeToolDefinitions(definitions);
  if (!normalized.length) {
    throw new Error("Tool definitions must include at least one supported tool");
  }

  frontendToolDefinitionsCache = deepClone(normalized);
  return deepClone(frontendToolDefinitionsCache);
}

export function listFrontendToolDefinitions() {
  return deepClone(frontendToolDefinitionsCache);
}

export function hasFrontendTool(name) {
  return typeof name === "string" && SUPPORTED_FRONTEND_TOOLS.has(name);
}

async function ensureServiceWorkerReady() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Worker is not supported in this browser");
  }

  let registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    registration = await navigator.serviceWorker.register(SW_PATH);
  }

  await navigator.serviceWorker.ready;

  let worker = navigator.serviceWorker.controller
    || registration.active
    || registration.waiting
    || registration.installing;

  if (!worker) {
    throw new Error("Service worker is not active yet. Reload once and retry.");
  }

  return worker;
}

async function runSkillAction(toolName, args, context) {
  const worker = await ensureServiceWorkerReady();
  const id = `skill_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      reject(new Error("Service worker skill request timed out"));
    }, SW_TIMEOUT_MS);

    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      const payload = event?.data || {};
      if (!payload?.ok) {
        reject(new Error(payload?.error || "Skill execution failed"));
        return;
      }
      resolve(payload?.result ?? null);
    };

    worker.postMessage(
      {
        type: "skill.run",
        id,
        skill: SKILL_NAME,
        action: toolName,
        args: args || {},
        context: context || {},
      },
      [channel.port2],
    );
  });
}

export async function executeFrontendToolCall(toolCall, context = {}) {
  const started = performance.now();
  const callId = String(toolCall?.id || `frontend-tool-${Date.now()}`);
  const fn = toolCall?.function || {};
  const name = String(fn?.name || "");
  if (!SUPPORTED_FRONTEND_TOOLS.has(name)) {
    const error = `Unknown frontend tool: ${name || "<missing>"}`;
    return {
      toolCallId: callId,
      name: name || "unknown",
      ok: false,
      error,
      content: safeJson({ ok: false, error }),
      durationMs: Math.round(performance.now() - started),
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const args = parseArgs(fn?.arguments);
    const result = await runSkillAction(name, args, context);

    return {
      toolCallId: callId,
      name,
      ok: true,
      result,
      content: typeof result === "string" ? result : safeJson(result),
      durationMs: Math.round(performance.now() - started),
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Tool execution failed";
    return {
      toolCallId: callId,
      name,
      ok: false,
      error,
      content: safeJson({ ok: false, error }),
      durationMs: Math.round(performance.now() - started),
      timestamp: new Date().toISOString(),
    };
  }
}

export async function executeFrontendToolCalls(toolCalls, context = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const out = [];

  for (const call of calls) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await executeFrontendToolCall(call, context));
  }

  return out;
}

export function toFrontendToolMessage(result) {
  return {
    role: "tool",
    tool_call_id: result?.toolCallId || "",
    name: result?.name || "unknown",
    content: result?.content || "",
    timestamp: result?.timestamp || new Date().toISOString(),
  };
}

// Warm cache from OPFS on import, then ensure default runtime skill exists in IndexedDB.
void loadFrontendToolDefinitionsFromOpfs({ persistFallback: true })
  .then(() => createAndRegisterSkill({ name: SKILL_NAME }))
  .catch(() => {
    // best effort bootstrap; runtime can still function with existing registry state
  });