import {
  AGENT_AGENTS_FILE_NAME,
  AGENT_SOUL_FILE_NAME,
  AGENT_TOOLS_FILE_NAME,
  AGENT_USER_FILE_NAME,
} from "./constants";

const runtimeShared = globalThis?.WebagentRuntimeShared;
if (!runtimeShared) {
  throw new Error("Shared runtime module is required");
}

const BOOTSTRAP_FILES = [
  AGENT_AGENTS_FILE_NAME,
  AGENT_SOUL_FILE_NAME,
  AGENT_USER_FILE_NAME,
  AGENT_TOOLS_FILE_NAME,
];

export async function reseedContextBootstrapFilesFromBackend() {
  try {
    const res = await fetch("/api/context/bootstrap", {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      mode: "same-origin",
      cache: "no-store",
    });

    if (!res.ok) {
      return { ok: false, written: [], error: `bootstrap fetch failed (${res.status})` };
    }

    const payload = await res.json().catch(() => ({}));
    const files = Array.isArray(payload?.files) ? payload.files : [];
    const written = [];

    for (const entry of files) {
      const name = String(entry?.name || "").trim();
      if (!name || !BOOTSTRAP_FILES.includes(name)) continue;

      const content = String(entry?.content || "");
      // eslint-disable-next-line no-await-in-loop
      await runtimeShared.writeOpfsTextFile(name, content);
      written.push(name);
    }

    return { ok: written.length > 0, written };
  } catch (err) {
    return {
      ok: false,
      written: [],
      error: err instanceof Error ? err.message : "bootstrap reseed failed",
    };
  }
}

export async function ensureContextBootstrapFilesInOpfs() {
  try {
    return await runtimeShared.ensureContextBootstrapFilesInOpfs(BOOTSTRAP_FILES);
  } catch {
    const reseed = await reseedContextBootstrapFilesFromBackend();
    if (!reseed.ok) return false;

    try {
      return await runtimeShared.ensureContextBootstrapFilesInOpfs(BOOTSTRAP_FILES);
    } catch {
      return false;
    }
  }
}

export async function loadContextBootstrapFromOpfs() {
  try {
    return await runtimeShared.loadContextBootstrapFromOpfs(BOOTSTRAP_FILES);
  } catch {
    return { files: [], text: "" };
  }
}

export function buildIdentitySection() {
  return "";
}

export function buildRuntimeMetadataBlock({
  tenantId,
  userId,
  sessionId,
  route = "/",
  page = "chat",
  metadata = {},
} = {}) {
  return runtimeShared.buildRuntimeMetadataBlock({
    tenantId,
    userId,
    sessionId,
    route,
    page,
    metadata,
  });
}

export function buildSystemPrompt({
  identitySection = "",
  bootstrapText = "",
  memoryText = "",
  skillsText = "",
  extraSections = [],
} = {}) {
  return runtimeShared.buildSystemPrompt({
    identitySection,
    bootstrapText,
    memoryText,
    skillsText,
    extraSections,
  });
}

export function mergeRuntimeWithUserContent(runtimeBlock, userText) {
  return runtimeShared.mergeRuntimeWithUserContent(runtimeBlock, userText);
}



export async function buildContextForLlm({
  history = [],
  currentMessage = "",
  tenantId = "tenant-dev",
  userId = "user-001",
  sessionId = "chat-001",
  route = "/",
  page = "chat",
  metadata = {},
  memoryText = "",
  skillsText = "",
} = {}) {
  await ensureContextBootstrapFilesInOpfs();

  const bootstrap = await loadContextBootstrapFromOpfs();
  const bootstrapText =
    bootstrap && typeof bootstrap.text === "string" ? bootstrap.text : "";
  const bootstrapFiles = Array.isArray(bootstrap?.files) ? bootstrap.files : [];
  const runtimeExplorationHint = [
    "## Runtime Exploration",
    "- Before using non-default tools, explore the local environment first.",
    "- Default tools are `list_registered_skills` and `read_local_skill`.",
    "- Use discovered local skill definitions as the source of truth for additional tools.",
  ].join("\n");
  const mergedSkillsText = [skillsText, runtimeExplorationHint]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n\n");

  const systemPrompt = buildSystemPrompt({
    bootstrapText,
    memoryText,
    skillsText: mergedSkillsText,
  });

  const runtimeBlock = buildRuntimeMetadataBlock({
    tenantId,
    userId,
    sessionId,
    route,
    page,
    metadata,
  });

  const normalizedHistory = runtimeShared
    .normalizeMessages(history)
    .filter((m) => ["system", "user", "assistant", "tool"].includes(m.role));

  const messages = [
    { role: "system", content: systemPrompt, timestamp: runtimeShared.nowIso() },
    ...normalizedHistory.filter((m) => m.role !== "system"),
    {
      role: "user",
      content: mergeRuntimeWithUserContent(runtimeBlock, currentMessage),
      timestamp: runtimeShared.nowIso(),
    },
  ];

  return {
    systemPrompt,
    runtimeBlock,
    bootstrapFiles: bootstrapFiles.map((f) => f.fileName),
    messages,
  };
}