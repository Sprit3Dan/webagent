import { createAndRegisterSkill } from "./skills";
import { getOrCreateFrontendInstanceId } from "./frontendIdentity";
import { readA2ADelegationRecord, upsertA2ADelegationRecord } from "./skillMemory";

const SKILL_NAME = "sw_unified_knowledge_runtime";
const SW_PATH = "/sw.js";
const SW_TIMEOUT_MS = 20_000;

const runtimeShared = globalThis?.WebagentRuntimeShared;
if (!runtimeShared) {
  throw new Error("Shared runtime module is required");
}

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
  const parsed = runtimeShared.parseJsonObjectSafe(rawArgs, {});
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  throw new Error("Tool arguments must be a JSON object or JSON string");
}

const SUPPORTED_FRONTEND_TOOLS = new Set([
  "memory_ingest_url",
  "memory_ingest_text",
  "memory_query",
  "memory_list_documents",
  "memory_get_document",
  "memory_delete_document",
  "memory_clear",
  "web_search_duckduckgo",
  "heartbeat_add_pending_item",
  "heartbeat_list_pending_items",
  "heartbeat_complete_pending_item",
  "opfs_read_file",
  "opfs_write_file",
  "opfs_edit_file",
  "delegate_task",
  "get_delegation_status",
  "list_a2a_discovery_candidates",
]);

const DEFAULT_FRONTEND_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "memory_ingest_url",
      description: "Store URL content in IndexedDB long-term retrieval memory (not guaranteed to be injected into every prompt)",
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
      description: "Store raw text in IndexedDB long-term retrieval memory (not guaranteed to be injected into every prompt)",
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
      description: "Query IndexedDB long-term retrieval memory and return relevant chunks on demand",
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
      description: "List all IndexedDB long-term memory documents for the current scope",
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
      description: "Get one IndexedDB long-term memory document and all of its chunks",
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
      description: "Delete one document from IndexedDB long-term retrieval memory",
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
      description: "Clear IndexedDB long-term retrieval memory for the current tenant/user/session scope",
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
      name: "web_search_duckduckgo",
      description: "Search the public web via DuckDuckGo instant answer API and return normalized results",
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
      name: "heartbeat_add_pending_item",
      description: "Add one pending heartbeat task item with a clear task title and detailed work description",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["text", "description"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "heartbeat_list_pending_items",
      description: "List all pending heartbeat task items from markdown-backed list",
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
      name: "heartbeat_complete_pending_item",
      description: "Mark one pending heartbeat task item as completed in markdown-backed list",
      parameters: {
        type: "object",
        properties: {
          itemId: { type: "string" },
        },
        required: ["itemId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "opfs_read_file",
      description: "Read one allowed OPFS fast-path context file used directly in prompt construction",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", enum: ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"] },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "opfs_write_file",
      description: "Write full content to one allowed OPFS context file (preferred for durable user/agent/process facts needed in future prompts)",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", enum: ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"] },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "opfs_edit_file",
      description: "Edit one allowed OPFS context file via append, prepend, or find/replace (OPFS-first for frequently needed guidance)",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", enum: ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"] },
          append: { type: "string" },
          prepend: { type: "string" },
          find: { type: "string" },
          replace: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_task",
      description: "Delegate a task to a peer agent via A2A. Returns a delegationId to track progress with get_delegation_status.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Description of the task to delegate" },
          targetAgent: { type: "string", description: "Explicit peer agent ID; omit for discovery-based routing" },
          intent: { type: "string", description: "Semantic hint for agent discovery (e.g. 'summarize', 'translate')" },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_delegation_status",
      description: "Check the status of a previously delegated task by delegationId. Returns status, result, error, and event ledger.",
      parameters: {
        type: "object",
        properties: {
          delegationId: { type: "string" },
        },
        required: ["delegationId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_a2a_discovery_candidates",
      description: "List candidate A2A agents from backend discovery so the frontend LLM can pick a targetAgent.",
      parameters: {
        type: "object",
        properties: {
          targetAgent: { type: "string" },
          intent: { type: "string" },
          capabilities: { type: "array", items: { type: "string" } },
        },
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



// Direct backend handlers bypass the service worker and call the REST API.
const _DIRECT_BACKEND_HANDLERS = {
  async delegate_task({ task, targetAgent, intent }) {
    const instanceId = getOrCreateFrontendInstanceId();
    const body = {
      task,
      agentId: instanceId,
    };
    const explicitTarget = String(targetAgent || "").trim();
    if (explicitTarget) {
      body.targetAgent = explicitTarget;
    }
    if (intent) body.intent = intent;
    const res = await fetch("/api/agent/delegate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err?.detail || `delegate_task failed: ${res.status}`);
    }

    const data = await res.json();
    const delegationId = String(data?.delegationId || "").trim();
    if (delegationId) {
      const now = String(data?.createdAt || new Date().toISOString());
      const normalizedTask =
        task && typeof task === "object" ? task : { text: String(task || "") };

      try {
        await upsertA2ADelegationRecord(
          {
            delegationId,
            status: String(data?.status || "dispatched").toLowerCase(),
            targetAgent: String(data?.targetAgent || explicitTarget || ""),
            fromAgent: instanceId,
            task: normalizedTask,
            messages: [
              { status: "created", timestamp: now },
              { status: "dispatched", timestamp: now, messageId: String(data?.messageId || "") },
            ],
            result: null,
            error: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            tenantId: "tenant-dev",
            userId: "user-001",
            agentId: instanceId,
          },
        );
      } catch {
        // best effort persistence
      }
    }

    return data;
  },

  async get_delegation_status({ delegationId }) {
    const id = String(delegationId || "").trim();
    if (!id) throw new Error("delegationId is required");

    const record = await readA2ADelegationRecord(id, {
      tenantId: "tenant-dev",
      userId: "user-001",
      agentId: getOrCreateFrontendInstanceId(),
    });

    if (!record) throw new Error(`Delegation ${id} not found in IndexedDB`);
    return record;
  },

  async list_a2a_discovery_candidates({ targetAgent, intent, capabilities } = {}) {
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
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err?.detail || `list_a2a_discovery_candidates failed: ${res.status}`);
    }
    return res.json();
  },
};

const TERMINAL_DELEGATION_STATUSES = new Set(["done", "failed", "timeout"]);

export async function pollDelegationUntilTerminal({
  delegationId,
  intervalMs = 1500,
  timeoutMs = 120000,
} = {}) {
  const id = String(delegationId || "").trim();
  if (!id) {
    throw new Error("delegationId is required");
  }

  const pollEvery = Math.max(250, Number(intervalMs) || 1500);
  const timeoutAt = Date.now() + Math.max(1000, Number(timeoutMs) || 120000);

  while (true) {
    const current = await _DIRECT_BACKEND_HANDLERS.get_delegation_status({
      delegationId: id,
    });

    const status = String(current?.status || "").toLowerCase();
    if (TERMINAL_DELEGATION_STATUSES.has(status)) {
      return current;
    }

    if (Date.now() >= timeoutAt) {
      throw new Error(
        `pollDelegationUntilTerminal timed out for delegation ${id} (last status: ${status || "unknown"})`,
      );
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, pollEvery));
  }
}

async function runSkillAction(toolName, args, context) {
  const id = runtimeShared.randomId("skill");
  const payload = await runtimeShared.sendToServiceWorker(
    {
      type: "skill.run",
      id,
      skill: SKILL_NAME,
      action: toolName,
      args: args || {},
      context: context || {},
    },
    { timeoutMs: SW_TIMEOUT_MS, swPath: SW_PATH },
  );

  if (!payload?.ok) {
    throw new Error(payload?.error || "Skill execution failed");
  }

  return payload?.result ?? null;
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
    const directHandler = _DIRECT_BACKEND_HANDLERS[name];
    const result = directHandler
      ? await directHandler(args)
      : await runSkillAction(name, args, context);

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