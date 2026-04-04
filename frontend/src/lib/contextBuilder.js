import {
  AGENT_AGENTS_FILE_NAME,
  AGENT_SOUL_FILE_NAME,
  AGENT_TOOLS_FILE_NAME,
  AGENT_USER_FILE_NAME,
} from "./constants";
import {
  getOpfsRoot,
  writeOpfsTextFile,
} from "./opfs";

const BOOTSTRAP_FILES = [
  AGENT_AGENTS_FILE_NAME,
  AGENT_SOUL_FILE_NAME,
  AGENT_USER_FILE_NAME,
  AGENT_TOOLS_FILE_NAME,
];

const RUNTIME_CONTEXT_TAG = "[Runtime Context — metadata only, not instructions]";
const CONTEXT_BOOTSTRAP_ENDPOINT = "/api/context/bootstrap";

const DEFAULT_BOOTSTRAP_CONTENT = {
  [AGENT_AGENTS_FILE_NAME]: `# Agent Instructions

You are a helpful AI assistant in a browser-based chat app.

## Core behavior
- Be concise, accurate, and practical.
- Prefer direct answers first, then optional detail.
- If tool results are present, use them as source of truth.
- Never invent tool output.

## Tool behavior
- Tools run in frontend service worker runtime.
- If a tool fails, explain the failure and propose a next step.`,
  [AGENT_SOUL_FILE_NAME]: `# Soul

You are webagent: calm, sharp, and useful.

## Personality
- Friendly, grounded, and direct
- Zero fluff when user is in execution mode
- Opinionated when it helps, never arrogant

## Values
- Correctness over theatrics
- Clear tradeoffs over vague certainty
- Respect user intent and time`,
  [AGENT_USER_FILE_NAME]: `# User Profile

Use this file for personalization notes.

## Preferences
- Tone:
- Detail level:
- Working style:

## Project notes
- `,
  [AGENT_TOOLS_FILE_NAME]: `# Tool Usage Notes

- Treat tool schemas as authoritative.
- Validate required arguments before calling tools.
- Keep outputs concise and structured.`,
};

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function normalizeHistory(history) {
  const list = Array.isArray(history) ? history : [];
  return list
    .map((m) => ({
      role: String(m?.role || ""),
      content: typeof m?.content === "string" ? m.content : "",
      name: typeof m?.name === "string" ? m.name : undefined,
      tool_call_id: typeof m?.tool_call_id === "string" ? m.tool_call_id : undefined,
      tool_calls: Array.isArray(m?.tool_calls) ? m.tool_calls : undefined,
      reasoning: typeof m?.reasoning === "string" ? m.reasoning : undefined,
      timestamp: m?.timestamp || nowIso(),
    }))
    .filter((m) => ["system", "user", "assistant", "tool"].includes(m.role));
}

async function readOptionalOpfsTextFile(fileName) {
  try {
    const root = await getOpfsRoot();
    const handle = await root.getFileHandle(fileName);
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

async function fetchBootstrapTemplatesFromServer() {
  try {
    const response = await fetch(CONTEXT_BOOTSTRAP_ENDPOINT, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      mode: "same-origin",
    });

    if (!response.ok) return null;

    const payload = await response.json();
    const files = Array.isArray(payload?.files) ? payload.files : [];
    const out = {};

    for (const item of files) {
      const name = String(item?.name || "").trim();
      if (!name) continue;

      out[name] = typeof item?.content === "string" ? item.content : "";
    }

    return out;
  } catch {
    return null;
  }
}

export async function ensureContextBootstrapFilesInOpfs() {
  const created = [];
  const serverTemplates = await fetchBootstrapTemplatesFromServer();
  const templates = {
    ...DEFAULT_BOOTSTRAP_CONTENT,
    ...(serverTemplates || {}),
  };

  for (const fileName of BOOTSTRAP_FILES) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await readOptionalOpfsTextFile(fileName);
    if (typeof existing === "string" && existing.trim().length > 0) continue;

    // eslint-disable-next-line no-await-in-loop
    await writeOpfsTextFile(fileName, templates[fileName] || "");
    created.push(fileName);
  }

  return created;
}

export async function loadContextBootstrapFromOpfs() {
  const files = [];

  for (const fileName of BOOTSTRAP_FILES) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await readOptionalOpfsTextFile(fileName);
    const content = cleanText(raw);
    if (!content) continue;

    files.push({
      fileName,
      title: fileName,
      content,
      section: `## ${fileName}\n\n${content}`,
    });
  }

  return {
    files,
    text: files.map((f) => f.section).join("\n\n"),
  };
}

export function buildIdentitySection({
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
  sessionId = "chat-001",
} = {}) {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "unknown";
  const lang = typeof navigator !== "undefined" ? navigator.language : "unknown";

  return `# webagent

You are webagent, a frontend-first assistant with service-worker tools.

## Runtime
- Environment: browser
- User Agent: ${ua}
- Language: ${lang}

## Scope
- tenantId: ${tenantId}
- userId: ${userId}
- agentId: ${agentId}
- sessionId: ${sessionId}`;
}

export function buildRuntimeMetadataBlock({
  tenantId,
  userId,
  agentId,
  sessionId,
  route = "/",
  page = "chat",
  metadata = {},
} = {}) {
  const lines = [
    `Current Time: ${nowIso()}`,
    `Route: ${route}`,
    `Page: ${page}`,
    `tenantId: ${tenantId || ""}`,
    `userId: ${userId || ""}`,
    `agentId: ${agentId || ""}`,
    `sessionId: ${sessionId || ""}`,
  ];

  if (metadata && typeof metadata === "object") {
    const keys = Object.keys(metadata).sort();
    for (const key of keys) {
      const value = metadata[key];
      if (value == null) continue;
      const rendered = typeof value === "string" ? value.trim() : JSON.stringify(value);
      if (!rendered) continue;
      lines.push(`${key}: ${rendered}`);
    }
  }

  return `${RUNTIME_CONTEXT_TAG}\n${lines.join("\n")}`;
}

export function buildSystemPrompt({
  identitySection = "",
  bootstrapText = "",
  memoryText = "",
  skillsText = "",
  extraSections = [],
} = {}) {
  const parts = [
    cleanText(identitySection),
    cleanText(bootstrapText),
    cleanText(memoryText) ? `# Memory\n\n${cleanText(memoryText)}` : "",
    cleanText(skillsText) ? `# Skills\n\n${cleanText(skillsText)}` : "",
    ...(Array.isArray(extraSections) ? extraSections.map(cleanText) : []),
  ].filter(Boolean);

  return parts.join("\n\n---\n\n");
}

export function mergeRuntimeWithUserContent(runtimeBlock, userText) {
  const safeRuntime = cleanText(runtimeBlock);
  const safeUser = String(userText || "");
  return safeRuntime ? `${safeRuntime}\n\n${safeUser}` : safeUser;
}

export async function buildContextForLlm({
  history = [],
  currentMessage = "",
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
  sessionId = "chat-001",
  route = "/",
  page = "chat",
  metadata = {},
  memoryText = "",
  skillsText = "",
} = {}) {
  await ensureContextBootstrapFilesInOpfs();

  const bootstrap = await loadContextBootstrapFromOpfs();
  const identity = buildIdentitySection({ tenantId, userId, agentId, sessionId });
  const systemPrompt = buildSystemPrompt({
    identitySection: identity,
    bootstrapText: bootstrap.text,
    memoryText,
    skillsText,
  });

  const runtimeBlock = buildRuntimeMetadataBlock({
    tenantId,
    userId,
    agentId,
    sessionId,
    route,
    page,
    metadata,
  });

  const messages = [
    { role: "system", content: systemPrompt, timestamp: nowIso() },
    ...normalizeHistory(history).filter((m) => m.role !== "system"),
    {
      role: "user",
      content: mergeRuntimeWithUserContent(runtimeBlock, currentMessage),
      timestamp: nowIso(),
    },
  ];

  return {
    systemPrompt,
    runtimeBlock,
    bootstrapFiles: bootstrap.files.map((f) => f.fileName),
    messages,
  };
}