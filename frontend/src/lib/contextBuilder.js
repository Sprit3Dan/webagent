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
  return runtimeShared.ensureContextBootstrapFilesInOpfs(BOOTSTRAP_FILES);
}

export async function loadContextBootstrapFromOpfs() {
  return runtimeShared.loadContextBootstrapFromOpfs(BOOTSTRAP_FILES);
}

export function buildIdentitySection({
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
  sessionId = "chat-001",
} = {}) {
  return runtimeShared.buildIdentitySection({
    tenantId,
    userId,
    agentId,
    sessionId,
    environment: "browser",
  });
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
  return runtimeShared.buildRuntimeMetadataBlock({
    tenantId,
    userId,
    agentId,
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
    bootstrapFiles: bootstrap.files.map((f) => f.fileName),
    messages,
  };
}