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

export async function ensureContextBootstrapFilesInOpfs() {
  try {
    return await runtimeShared.ensureContextBootstrapFilesInOpfs(BOOTSTRAP_FILES);
  } catch {
    return false;
  }
}

export async function loadContextBootstrapFromOpfs() {
  try {
    return await runtimeShared.loadContextBootstrapFromOpfs(BOOTSTRAP_FILES);
  } catch {
    return { files: [], text: "" };
  }
}

export function buildIdentitySection({
  tenantId = "tenant-dev",
  userId = "user-001",
  sessionId = "chat-001",
} = {}) {
  return runtimeShared.buildIdentitySection({
    tenantId,
    userId,
    sessionId,
    environment: "browser",
  });
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
  const identity = buildIdentitySection({ tenantId, userId, sessionId });
  const systemPrompt = buildSystemPrompt({
    identitySection: identity,
    bootstrapText,
    memoryText,
    skillsText,
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