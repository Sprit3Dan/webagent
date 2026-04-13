import { createAndRegisterSkill, listDynamicSkills } from "./skills";
import { getOrCreateFrontendInstanceId } from "./frontendIdentity";
import { readA2ADelegationRecord, upsertA2ADelegationRecord } from "./skillMemory";

const BUILTIN_SKILL_NAMES = Object.freeze({
  memory: "memory_runtime",
  heartbeat: "heartbeat_runtime",
  webSearch: "web_search_runtime",
  opfs: "opfs_runtime",
  delegation: "delegation_direct_runtime",
});
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

function inferBuiltInSkillName(toolName) {
  const name = String(toolName || "").trim();
  if (!name) return "";

  if (name.startsWith("memory_")) return BUILTIN_SKILL_NAMES.memory;
  if (name.startsWith("heartbeat_")) return BUILTIN_SKILL_NAMES.heartbeat;
  if (name === "web_search_duckduckgo") return BUILTIN_SKILL_NAMES.webSearch;
  if (name.startsWith("opfs_")) return BUILTIN_SKILL_NAMES.opfs;
  if (
    name === "delegate_task" ||
    name === "get_delegation_status" ||
    name === "list_a2a_discovery_candidates"
  ) {
    return BUILTIN_SKILL_NAMES.delegation;
  }

  return "";
}

function isToolNameAllowed(name) {
  const normalized = String(name || "").trim();
  if (!normalized) return false;
  if (toolOwnerSkillByName.has(normalized)) return true;
  return Boolean(_DIRECT_BACKEND_HANDLERS?.[normalized]);
}

const DEFAULT_ATTACHED_FRONTEND_TOOL_NAMES = new Set([
  "list_registered_skills",
  "read_registered_skill",
]);

let toolOwnerSkillByName = new Map();

const DEFAULT_FRONTEND_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "list_registered_skills",
      description: "List all currently registered dynamic skills available in the frontend runtime.",
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
      name: "read_registered_skill",
      description: "Read one registered skill by name, including metadata.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
];

function buildDefaultAttachedToolDefinitions() {
  return deepClone(
    DEFAULT_FRONTEND_TOOL_DEFINITIONS.filter((item) =>
      DEFAULT_ATTACHED_FRONTEND_TOOL_NAMES.has(String(item?.function?.name || "").trim()),
    ),
  );
}

let frontendToolDefinitionsCache = buildDefaultAttachedToolDefinitions();

function normalizeToolDefinitions(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();

  for (const item of arr) {
    const type = item?.type;
    const name = item?.function?.name;

    if (type !== "function") continue;
    if (typeof name !== "string" || !name.trim()) continue;
    if (!isToolNameAllowed(name)) continue;
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

  const fallback = buildDefaultAttachedToolDefinitions();
  const derived = [...fallback];
  const seen = new Set(
    fallback
      .map((item) => String(item?.function?.name || "").trim())
      .filter(Boolean),
  );
  const ownerMap = new Map();

  try {
    const registry = await listDynamicSkills();
    const skills = Array.isArray(registry) ? registry : [];

    for (const skill of skills) {
      if (!skill || skill.enabled === false) continue;
      const registeredSkillName = String(skill?.name || "").trim();
      const tools = Array.isArray(skill?.tools) ? skill.tools : [];

      for (const tool of tools) {
        if (!tool || tool.enabled === false) continue;

        const name = String(tool?.name || "").trim();
        if (!name || seen.has(name)) continue;

        const description = String(tool?.description || "").trim();
        const parameters =
          tool?.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
            ? tool.parameters
            : { type: "object", properties: {}, additionalProperties: true };

        ownerMap.set(name, inferBuiltInSkillName(name) || registeredSkillName);
        seen.add(name);
        derived.push({
          type: "function",
          function: {
            name,
            description,
            parameters,
          },
        });
      }
    }
  } catch {
    // keep fallback-only definitions when skills registry is temporarily unavailable
  }

  toolOwnerSkillByName = ownerMap;
  frontendToolDefinitionsCache = normalizeToolDefinitions(derived);

  if (!Array.isArray(frontendToolDefinitionsCache) || !frontendToolDefinitionsCache.length) {
    frontendToolDefinitionsCache = normalizeToolDefinitions(fallback);
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
  const normalized = String(name || "").trim();
  if (!normalized) return false;
  return isToolNameAllowed(normalized);
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

  async list_registered_skills() {
    const registry = await listDynamicSkills();
    return {
      count: Array.isArray(registry) ? registry.length : 0,
      skills: Array.isArray(registry)
        ? registry.map((skill) => ({
            name: String(skill?.name || ""),
            description: String(skill?.description || ""),
            version: Number(skill?.version || 0),
            enabled: skill?.enabled !== false,
            modulesCount: Array.isArray(skill?.modules) ? skill.modules.length : 0,
            toolsCount: Array.isArray(skill?.tools) ? skill.tools.length : 0,
          }))
        : [],
    };
  },

  async read_registered_skill({ name } = {}) {
    const skillName = String(name || "").trim();
    if (!skillName) throw new Error("name is required");

    const registry = await listDynamicSkills();
    const skill = Array.isArray(registry)
      ? registry.find((item) => String(item?.name || "") === skillName)
      : null;

    if (!skill) throw new Error(`Skill not found: ${skillName}`);

    const payload = {
      name: String(skill?.name || ""),
      description: String(skill?.description || ""),
      version: Number(skill?.version || 0),
      language: String(skill?.language || ""),
      entrypoint: String(skill?.entrypoint || ""),
      enabled: skill?.enabled !== false,
      modules: Array.isArray(skill?.modules)
        ? skill.modules.map((m) => ({
            name: String(m?.name || ""),
            enabled: m?.enabled !== false,
          }))
        : [],

      tools: Array.isArray(skill?.tools)
        ? skill.tools.map((t) => ({
            id: String(t?.id || ""),
            name: String(t?.name || ""),
            enabled: t?.enabled !== false,
            moduleRefs: Array.isArray(t?.moduleRefs) ? t.moduleRefs : [],
          }))
        : [],
    };

    return payload;
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

async function runSkillAction(toolName, args, context, skillName) {
  const id = runtimeShared.randomId("skill");
  const resolvedSkillName = String(skillName || "").trim();
  if (!resolvedSkillName) {
    throw new Error(`No owning skill found for tool: ${String(toolName || "").trim()}`);
  }
  const payload = await runtimeShared.sendToServiceWorker(
    {
      type: "skill.run",
      id,
      skill: resolvedSkillName,
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
  const attachedToolNames = new Set(
    (Array.isArray(frontendToolDefinitionsCache) ? frontendToolDefinitionsCache : [])
      .map((item) => String(item?.function?.name || "").trim())
      .filter(Boolean),
  );
  if (!attachedToolNames.has(name)) {
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
    const ownerSkillName =
      toolOwnerSkillByName.get(name) || inferBuiltInSkillName(name);
    if (!directHandler && !ownerSkillName) {
      throw new Error(`No owning skill found for tool: ${name}`);
    }
    const result = directHandler
      ? await directHandler(args)
      : await runSkillAction(name, args, context, ownerSkillName);

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

// Warm cache from OPFS on import, then ensure built-in runtime skills exist in IndexedDB.
void loadFrontendToolDefinitionsFromOpfs({ persistFallback: true })
  .then(() =>
    Promise.all([
      createAndRegisterSkill({ name: BUILTIN_SKILL_NAMES.memory }),
      createAndRegisterSkill({ name: BUILTIN_SKILL_NAMES.heartbeat }),
      createAndRegisterSkill({ name: BUILTIN_SKILL_NAMES.webSearch }),
      createAndRegisterSkill({ name: BUILTIN_SKILL_NAMES.opfs }),
      createAndRegisterSkill({ name: BUILTIN_SKILL_NAMES.delegation }),
    ]),
  )
  .catch(() => {
    // best effort bootstrap; runtime can still function with existing registry state
  });
