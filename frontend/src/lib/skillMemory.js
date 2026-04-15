/**
 * IndexedDB helpers for frontend skill memory inspection.
 *
 * Mirrors service worker storage schema from `public/sw.js`:
 * - DB: "webagent-skills-db"
 * - Stores: "docs", "chunks", "skills", "skill_modules", "tools"
 * - Indexes:
 *   - docs:          "scope", "sourceUrl"
 *   - chunks:        "scope", "docId"
 *   - skills:        "name", "enabled"
 *   - skill_modules: "skillId", "name", "enabled"
 *   - tools:         "name", "enabled"
 */

import { getOrCreateFrontendInstanceId } from "./frontendIdentity";

const runtimeShared = globalThis?.WebagentRuntimeShared;
if (!runtimeShared) {
  throw new Error("Shared runtime facade is required");
}

export const SKILL_DB_NAME = runtimeShared.RuntimeDbRegistry.DB_NAME;
export const SKILL_DB_VERSION = runtimeShared.RuntimeDbRegistry.DB_VERSION;
export const SKILL_DOCS_STORE = runtimeShared.RuntimeDbRegistry.DOCS_STORE;
export const SKILL_CHUNKS_STORE = runtimeShared.RuntimeDbRegistry.CHUNKS_STORE;
export const SKILL_SKILLS_STORE = runtimeShared.RuntimeDbRegistry.SKILLS_STORE;
export const SKILL_MODULES_STORE = "skill_modules";
export const SKILL_TOOLS_STORE = runtimeShared.RuntimeDbRegistry.TOOLS_STORE;

export const LLM_SETTINGS_STORE = SKILL_DOCS_STORE;
export const LLM_PROVIDER_SETTINGS_DOC_ID = "system::settings::llm-providers";
export const LLM_PROVIDER_SETTINGS_SCOPE = "system::settings";
export const LLM_PROVIDER_SETTINGS_TITLE = "LLM Provider Settings";
export const UI_SETTINGS_DOC_ID = "system::settings::ui";
export const UI_SETTINGS_SCOPE = "system::settings";
export const UI_SETTINGS_TITLE = "UI Settings";

const DEFAULT_SCOPE = "tenant-dev::user-001::default";

export const CONVERSATION_MEMORY_SCOPE_PREFIX = "conversation-memory";
export const CONVERSATION_MEMORY_DOC_KIND = "conversation_turn";
export const CONVERSATION_MEMORY_FACT_KIND = "conversation_fact";
export const FACT_UPSERT_SIMILARITY_THRESHOLD = 0.94;
export const FACT_CONTRADICTION_SIMILARITY_THRESHOLD = 0.78;
export const FACT_CONFIDENCE_BUMP_ON_CONFIRM = 0.08;
export const FACT_CONFIDENCE_DECAY_ON_CONTRADICTION = 0.2;
export const FACT_SCORE_CONFIDENCE_WEIGHT = 0.14;
export const FACT_SCORE_CONFIRMATION_WEIGHT = 0.06;
export const FACT_SCORE_RECENCY_WEIGHT = 0.08;
export const A2A_DELEGATION_SCOPE_PREFIX = "a2a-delegations";
export const A2A_DELEGATION_DOC_KIND = "a2a_delegation";

const reqToPromise = runtimeShared.dbReqToPromise;
const txDone = runtimeShared.dbTxDone;

function hasStore(db, storeName) {
  return db.objectStoreNames.contains(storeName);
}

const DELEGATION_TOOL_PARAMETER_SCHEMAS = Object.freeze({
  delegate_task: {
    type: "object",
    properties: {
      task: {
        anyOf: [
          { type: "string" },
          { type: "object", additionalProperties: true },
        ],
      },
      targetAgent: { type: "string" },
      intent: { type: "string" },
    },
    required: ["task"],
    additionalProperties: false,
  },
  get_delegation_status: {
    type: "object",
    properties: {
      delegationId: { type: "string" },
    },
    required: ["delegationId"],
    additionalProperties: false,
  },
  list_a2a_discovery_candidates: {
    type: "object",
    properties: {
      targetAgent: { type: "string" },
      intent: { type: "string" },
      capabilities: {
        type: "array",
        items: { type: "string" },
      },
    },
    additionalProperties: false,
  },
});

function isGenericObjectSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return true;
  const type = String(schema.type || "").trim().toLowerCase();
  const props = schema.properties;
  const propCount =
    props && typeof props === "object" && !Array.isArray(props)
      ? Object.keys(props).length
      : 0;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return type === "object" && propCount === 0 && required.length === 0;
}

export async function upgradeDelegationToolSchemasInIndexedDb() {
  const db = await runtimeShared.openDb();
  if (!hasStore(db, SKILL_TOOLS_STORE)) {
    throw new Error(`Missing IndexedDB store: ${SKILL_TOOLS_STORE}`);
  }

  const tx = db.transaction(SKILL_TOOLS_STORE, "readwrite");
  const store = tx.objectStore(SKILL_TOOLS_STORE);
  const allTools = await reqToPromise(store.getAll());

  let updated = 0;
  for (const rec of Array.isArray(allTools) ? allTools : []) {
    const toolName = String(rec?.name || "").trim();
    const expectedSchema = DELEGATION_TOOL_PARAMETER_SCHEMAS[toolName];
    if (!expectedSchema) continue;

    const currentSchema = rec?.parameters;
    if (!isGenericObjectSchema(currentSchema)) continue;

    store.put({
      ...rec,
      parameters: expectedSchema,
      updatedAt: new Date().toISOString(),
    });
    updated += 1;
  }

  await txDone(tx);
  return {
    ok: true,
    updated,
    scanned: Array.isArray(allTools) ? allTools.length : 0,
  };
}

export function buildSkillScope({
  tenantId = "tenant-dev",
  userId = "user-001",
  sessionId = "default",
} = {}) {
  return `${String(tenantId)}::${String(userId)}::${String(sessionId)}`;
}

export function buildConversationMemoryScope({
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
} = {}) {
  return [
    CONVERSATION_MEMORY_SCOPE_PREFIX,
    String(tenantId),
    String(userId),
    String(agentId),
  ].join("::");
}

export function isConversationMemoryScope(scope) {
  return String(scope || "").startsWith(`${CONVERSATION_MEMORY_SCOPE_PREFIX}::`);
}

export function buildA2ADelegationScope({
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "",
} = {}) {
  const resolvedAgentId = String(agentId || getOrCreateFrontendInstanceId()).trim();
  return [
    A2A_DELEGATION_SCOPE_PREFIX,
    String(tenantId),
    String(userId),
    resolvedAgentId || "agent-main",
  ].join("::");
}

export function isA2ADelegationScope(scope) {
  return String(scope || "").startsWith(`${A2A_DELEGATION_SCOPE_PREFIX}::`);
}

export function buildA2ADelegationDocId(delegationId) {
  const id = String(delegationId || "").trim();
  if (!id) throw new Error("delegationId is required");
  return `a2a::delegation::${id}`;
}

export function buildConversationTurnMemoryId({
  sessionId = "default",
  turnIndex = 0,
} = {}) {
  const safeTurnIndex = Math.max(0, Number(turnIndex) || 0);
  return `memory::conversation::${String(sessionId)}::turn::${safeTurnIndex}`;
}

export function buildConversationFactMemoryId({
  sessionId = "default",
  turnIndex = 0,
  factIndex = 0,
} = {}) {
  const safeTurnIndex = Math.max(0, Number(turnIndex) || 0);
  const safeFactIndex = Math.max(0, Number(factIndex) || 0);
  return `memory::conversation::${String(sessionId)}::fact::${safeTurnIndex}::${safeFactIndex}`;
}

export async function openSkillMemoryDb() {
  return runtimeShared.openDb();
}

function normalizePagination({ limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return { limit: safeLimit, offset: safeOffset };
}

function pageArray(items, { limit = 100, offset = 0 } = {}) {
  const { limit: l, offset: o } = normalizePagination({ limit, offset });
  return items.slice(o, o + l);
}

async function getAllByIndex(db, storeName, indexName, value) {
  return runtimeShared.dbGetAllByIndex(db, storeName, indexName, value);
}

async function getAllByStore(db, storeName) {
  return runtimeShared.dbGetAllByStore(db, storeName);
}

export async function listIndexedDbStores() {
  const db = await openSkillMemoryDb();
  return Array.from(db.objectStoreNames).sort((a, b) => String(a).localeCompare(String(b)));
}

export async function clearAllSkillMemoryIndexedDbRecords() {
  const db = await openSkillMemoryDb();
  const stores = Array.from(db.objectStoreNames);

  if (!stores.length) {
    return {
      ok: true,
      stores: [],
      deletedByStore: {},
      totalDeleted: 0,
    };
  }

  const tx = db.transaction(stores, "readwrite");
  const deletedByStore = {};

  for (const storeName of stores) {
    const store = tx.objectStore(storeName);
    // eslint-disable-next-line no-await-in-loop
    const count = Number((await reqToPromise(store.count())) || 0);
    deletedByStore[storeName] = count;
    store.clear();
  }

  await txDone(tx);

  const totalDeleted = Object.values(deletedByStore).reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );

  return {
    ok: true,
    stores,
    deletedByStore,
    totalDeleted,
  };
}

export async function listStoreRecords(storeName, { limit = 500, offset = 0 } = {}) {
  const db = await openSkillMemoryDb();
  if (!hasStore(db, storeName)) return [];

  const records = await getAllByStore(db, storeName);
  return pageArray(records, { limit, offset });
}

export async function listAllSkillMemoryRecords({ limitPerStore = 500 } = {}) {
  const db = await openSkillMemoryDb();
  const stores = await listIndexedDbStores();

  const out = {};
  for (const storeName of stores) {
    // eslint-disable-next-line no-await-in-loop
    const records = await getAllByStore(db, storeName);
    out[storeName] = pageArray(records, { limit: limitPerStore, offset: 0 });
  }

  return out;
}

export async function listSkillDocuments({
  scope = DEFAULT_SCOPE,
  limit = 100,
  offset = 0,
  sortDesc = true,
} = {}) {
  const db = await openSkillMemoryDb();
  if (!hasStore(db, SKILL_DOCS_STORE)) return [];

  const docs = await getAllByIndex(db, SKILL_DOCS_STORE, "scope", String(scope));
  docs.sort((a, b) => {
    const av = String(a?.updatedAt || a?.createdAt || "");
    const bv = String(b?.updatedAt || b?.createdAt || "");
    return sortDesc ? bv.localeCompare(av) : av.localeCompare(bv);
  });

  return pageArray(docs, { limit, offset });
}

export async function listSkillChunks({
  scope = DEFAULT_SCOPE,
  docId = null,
  limit = 200,
  offset = 0,
} = {}) {
  const db = await openSkillMemoryDb();
  if (!hasStore(db, SKILL_CHUNKS_STORE)) return [];

  let chunks = [];

  if (docId) {
    chunks = await getAllByIndex(db, SKILL_CHUNKS_STORE, "docId", String(docId));
    chunks = chunks.filter((c) => c?.scope === String(scope));
  } else {
    chunks = await getAllByIndex(db, SKILL_CHUNKS_STORE, "scope", String(scope));
  }

  chunks.sort((a, b) => {
    if (a?.docId !== b?.docId) return String(a?.docId || "").localeCompare(String(b?.docId || ""));
    return (a?.index || 0) - (b?.index || 0);
  });

  return pageArray(chunks, { limit, offset });
}

export async function listSkillTools({ limit = 1000, offset = 0 } = {}) {
  return listStoreRecords(SKILL_TOOLS_STORE, { limit, offset });
}

export async function readSkillDocument(docId) {
  if (!docId) throw new Error("docId is required");
  const db = await openSkillMemoryDb();
  if (!hasStore(db, SKILL_DOCS_STORE)) return null;

  const tx = db.transaction(SKILL_DOCS_STORE, "readonly");
  const req = tx.objectStore(SKILL_DOCS_STORE).get(String(docId));
  const doc = await reqToPromise(req);
  await txDone(tx);
  return doc || null;
}

function normalizeA2ADelegationRecord(input = {}) {
  const delegationId = String(input?.delegationId || "").trim();
  if (!delegationId) throw new Error("delegationId is required");

  const status = String(input?.status || "").trim().toLowerCase() || "created";
  const createdAt = String(input?.createdAt || new Date().toISOString());
  const updatedAt = String(input?.updatedAt || createdAt);

  return {
    delegationId,
    status,
    targetAgent: String(input?.targetAgent || ""),
    fromAgent: String(input?.fromAgent || ""),
    task: input?.task && typeof input.task === "object" ? input.task : {},
    messages: Array.isArray(input?.messages) ? input.messages : [],
    result:
      input?.result && typeof input.result === "object"
        ? input.result
        : (input?.result ?? null),
    error: typeof input?.error === "string" ? input.error : (input?.error ?? null),
    createdAt,
    updatedAt,
  };
}

export async function upsertA2ADelegationRecord(
  input,
  {
    tenantId = "tenant-dev",
    userId = "user-001",
    agentId = "",
  } = {},
) {
  const db = await openSkillMemoryDb();
  if (!hasStore(db, SKILL_DOCS_STORE)) {
    throw new Error(`Missing IndexedDB store: ${SKILL_DOCS_STORE}`);
  }

  const normalized = normalizeA2ADelegationRecord(input || {});
  const scope = buildA2ADelegationScope({ tenantId, userId, agentId });
  const id = buildA2ADelegationDocId(normalized.delegationId);
  const now = new Date().toISOString();
  const existing = await readSkillDocument(id);

  const tx = db.transaction(SKILL_DOCS_STORE, "readwrite");
  tx.objectStore(SKILL_DOCS_STORE).put({
    id,
    scope,
    kind: A2A_DELEGATION_DOC_KIND,
    title: `A2A Delegation ${normalized.delegationId.slice(0, 8)}`,
    text: JSON.stringify(normalized, null, 2),
    ...normalized,
    createdAt: existing?.createdAt || normalized.createdAt || now,
    updatedAt: normalized.updatedAt || now,
  });
  await txDone(tx);

  return {
    id,
    scope,
    ...normalized,
    createdAt: existing?.createdAt || normalized.createdAt || now,
    updatedAt: normalized.updatedAt || now,
  };
}

export async function readA2ADelegationRecord(
  delegationId,
  {
    tenantId = "tenant-dev",
    userId = "user-001",
    agentId = "",
  } = {},
) {
  const id = buildA2ADelegationDocId(delegationId);
  const doc = await readSkillDocument(id);
  if (!doc || String(doc?.kind || "") !== A2A_DELEGATION_DOC_KIND) return null;
  const scope = buildA2ADelegationScope({ tenantId, userId, agentId });
  if (String(doc?.scope || "") !== scope) return null;
  return doc;
}

export async function listA2ADelegationRecords(
  {
    tenantId = "tenant-dev",
    userId = "user-001",
    agentId = "",
    status = "",
    limit = 100,
    offset = 0,
    sortDesc = true,
  } = {},
) {
  const scope = buildA2ADelegationScope({ tenantId, userId, agentId });
  const docs = await listSkillDocuments({
    scope,
    limit: 10_000,
    offset: 0,
    sortDesc,
  });

  const statusFilter = String(status || "").trim().toLowerCase();
  const records = docs.filter((doc) => {
    if (String(doc?.kind || "") !== A2A_DELEGATION_DOC_KIND) return false;
    if (!statusFilter) return true;
    return String(doc?.status || "").trim().toLowerCase() === statusFilter;
  });

  records.sort((a, b) => {
    const av = String(a?.updatedAt || a?.createdAt || "");
    const bv = String(b?.updatedAt || b?.createdAt || "");
    return sortDesc ? bv.localeCompare(av) : av.localeCompare(bv);
  });

  return pageArray(records, { limit, offset });
}

export async function clearA2ADelegationRecords(
  {
    tenantId = "tenant-dev",
    userId = "user-001",
    agentId = "",
  } = {},
) {
  const db = await openSkillMemoryDb();
  if (!hasStore(db, SKILL_DOCS_STORE)) return 0;

  const records = await listA2ADelegationRecords({
    tenantId,
    userId,
    agentId,
    limit: 10_000,
    offset: 0,
    sortDesc: false,
  });

  if (!records.length) return 0;

  const tx = db.transaction(SKILL_DOCS_STORE, "readwrite");
  const store = tx.objectStore(SKILL_DOCS_STORE);
  for (const row of records) {
    if (row?.id) store.delete(String(row.id));
  }
  await txDone(tx);

  return records.length;
}

function normalizeProviderRecord(input, index = 0) {
  const id = String(input?.id || `provider-${index + 1}`);
  return {
    id,
    name: String(input?.name || id),
    provider: String(input?.provider || "openai-compatible"),
    baseUrl: String(input?.baseUrl || ""),
    model: String(input?.model || ""),
    contextWindowTokens: Math.max(1, Number(input?.contextWindowTokens) || 64000),
    tokenBudget: Math.max(0, Number(input?.tokenBudget) || 0),
    tokenSecret: String(input?.tokenSecret || ""),
  };
}

function normalizeProviderSettingsPayload(input) {
  const rawProviders = Array.isArray(input?.providers) ? input.providers : [];
  const providers = rawProviders.map((item, idx) => normalizeProviderRecord(item, idx));
  const activeProviderId = String(input?.activeProviderId || providers[0]?.id || "");
  return { providers, activeProviderId };
}

function normalizeA2aConsumerName(value) {
  const candidate = String(value || "").trim();
  if (candidate && candidate.toLowerCase() !== "webagent") return candidate;
  return getOrCreateFrontendInstanceId();
}

function normalizeUiSettingsPayload(input, defaults = {}) {
  const hasExplicitA2aEnabled = input && Object.prototype.hasOwnProperty.call(input, "a2aEnabled");
  const hasExplicitA2aRequireAuth = input && Object.prototype.hasOwnProperty.call(input, "a2aRequireAuth");
  const toText = (value, fallback = "") => String(value ?? fallback ?? "").trim();
  const toPositiveInt = (value, fallback) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    return Math.max(1, Number(fallback) || 1);
  };

  const fallbackA2aEnabled = Boolean(defaults?.a2aEnabled);
  const fallbackA2aRequireAuth = Boolean(defaults?.a2aRequireAuth);

  return {
    a2aEnabled: hasExplicitA2aEnabled
      ? Boolean(input?.a2aEnabled)
      : fallbackA2aEnabled,
    a2aAgentId: toText(input?.a2aAgentId, defaults?.a2aAgentId),
    a2aTransportBackend: toText(input?.a2aTransportBackend, defaults?.a2aTransportBackend || "nats"),
    a2aNatsUrl: toText(input?.a2aNatsUrl, defaults?.a2aNatsUrl),
    a2aDiscoveryBaseUrl: toText(input?.a2aDiscoveryBaseUrl, defaults?.a2aDiscoveryBaseUrl),
    a2aStreamName: toText(input?.a2aStreamName, defaults?.a2aStreamName || "a2a"),
    a2aSubjectPrefix: toText(input?.a2aSubjectPrefix, defaults?.a2aSubjectPrefix || "a2a"),
    a2aConsumerName: normalizeA2aConsumerName(
      toText(input?.a2aConsumerName, defaults?.a2aConsumerName || ""),
    ),
    a2aMaxDeliver: toPositiveInt(input?.a2aMaxDeliver, defaults?.a2aMaxDeliver || 5),
    a2aAckWaitSeconds: toPositiveInt(input?.a2aAckWaitSeconds, defaults?.a2aAckWaitSeconds || 30),
    a2aExecutionTimeoutSeconds: toPositiveInt(
      input?.a2aExecutionTimeoutSeconds,
      defaults?.a2aExecutionTimeoutSeconds || 120,
    ),
    a2aRequireAuth: hasExplicitA2aRequireAuth
      ? Boolean(input?.a2aRequireAuth)
      : fallbackA2aRequireAuth,
    a2aSharedSecret: toText(input?.a2aSharedSecret, defaults?.a2aSharedSecret),
  };
}

export async function readPersistedLlmProviderSettings() {
  const doc = await readSkillDocument(LLM_PROVIDER_SETTINGS_DOC_ID);
  if (!doc?.text) {
    return {
      providers: [],
      activeProviderId: "",
      updatedAt: null,
    };
  }

  try {
    const parsed = JSON.parse(String(doc.text || "{}"));
    const normalized = normalizeProviderSettingsPayload(parsed);
    return {
      ...normalized,
      updatedAt: doc.updatedAt || doc.createdAt || null,
    };
  } catch {
    return {
      providers: [],
      activeProviderId: "",
      updatedAt: doc.updatedAt || doc.createdAt || null,
    };
  }
}

export async function writePersistedLlmProviderSettings(input) {
  const db = await openSkillMemoryDb();
  if (!hasStore(db, LLM_SETTINGS_STORE)) {
    throw new Error(`Missing IndexedDB store: ${LLM_SETTINGS_STORE}`);
  }

  const normalized = normalizeProviderSettingsPayload(input || {});
  const now = new Date().toISOString();
  const existing = await readSkillDocument(LLM_PROVIDER_SETTINGS_DOC_ID);

  const tx = db.transaction(LLM_SETTINGS_STORE, "readwrite");
  tx.objectStore(LLM_SETTINGS_STORE).put({
    id: LLM_PROVIDER_SETTINGS_DOC_ID,
    scope: LLM_PROVIDER_SETTINGS_SCOPE,
    title: LLM_PROVIDER_SETTINGS_TITLE,
    text: JSON.stringify(normalized, null, 2),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
  await txDone(tx);

  return {
    ...normalized,
    updatedAt: now,
  };
}

export async function readPersistedUiSettings(defaults = {}) {
  const doc = await readSkillDocument(UI_SETTINGS_DOC_ID);
  if (!doc?.text) {
    return {
      ...normalizeUiSettingsPayload({}, defaults),
      updatedAt: null,
    };
  }

  try {
    const parsed = JSON.parse(String(doc.text || "{}"));
    const normalized = normalizeUiSettingsPayload(parsed, defaults);
    return {
      ...normalized,
      updatedAt: doc.updatedAt || doc.createdAt || null,
    };
  } catch {
    return {
      ...normalizeUiSettingsPayload({}, defaults),
      updatedAt: doc.updatedAt || doc.createdAt || null,
    };
  }
}

export async function writePersistedUiSettings(input, defaults = {}) {
  const db = await openSkillMemoryDb();
  if (!hasStore(db, LLM_SETTINGS_STORE)) {
    throw new Error(`Missing IndexedDB store: ${LLM_SETTINGS_STORE}`);
  }

  const normalized = normalizeUiSettingsPayload(input || {}, defaults);
  const now = new Date().toISOString();
  const existing = await readSkillDocument(UI_SETTINGS_DOC_ID);

  const tx = db.transaction(LLM_SETTINGS_STORE, "readwrite");
  tx.objectStore(LLM_SETTINGS_STORE).put({
    id: UI_SETTINGS_DOC_ID,
    scope: UI_SETTINGS_SCOPE,
    title: UI_SETTINGS_TITLE,
    text: JSON.stringify(normalized, null, 2),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
  await txDone(tx);

  return {
    ...normalized,
    updatedAt: now,
  };
}

export async function readSkillDocumentWithChunks(docId) {
  if (!docId) throw new Error("docId is required");

  const [document, chunks] = await Promise.all([
    readSkillDocument(docId),
    listSkillChunks({ docId, limit: 10_000, offset: 0 }),
  ]);

  return {
    document,
    chunks,
  };
}

export async function listSkillMemoryScopes() {
  const db = await openSkillMemoryDb();
  if (!hasStore(db, SKILL_DOCS_STORE)) return [];

  const tx = db.transaction(SKILL_DOCS_STORE, "readonly");
  const req = tx.objectStore(SKILL_DOCS_STORE).getAll();
  const docs = await reqToPromise(req);
  await txDone(tx);

  const set = new Set((docs || []).map((d) => d?.scope).filter(Boolean));
  return Array.from(set).sort((a, b) => String(a).localeCompare(String(b)));
}

export async function readSkillMemorySummary({ scope = DEFAULT_SCOPE } = {}) {
  const [documents, chunks, skills, tools] = await Promise.all([
    listSkillDocuments({ scope, limit: 10_000, offset: 0 }),
    listSkillChunks({ scope, limit: 10_000, offset: 0 }),
    listStoreRecords(SKILL_SKILLS_STORE, { limit: 10_000, offset: 0 }),
    listStoreRecords(SKILL_TOOLS_STORE, { limit: 10_000, offset: 0 }),
  ]);

  return {
    scope: String(scope),
    documentCount: documents.length,
    chunkCount: chunks.length,
    skillCount: skills.length,
    toolCount: tools.length,
    documents,
    skills,
    tools,
  };
}

function normalizeVector(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const v of input) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out.push(n);
  }
  return out;
}

function normalizeFactText(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function normalizeFactConfidence(input, fallback = 0.6) {
  const raw = Number(input);
  const value = Number.isFinite(raw) ? raw : Number(fallback);
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.6));
}

function normalizeConfirmedCount(input) {
  const value = Number(input);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function computeFactHybridScore({
  similarity = 0,
  confidence = 0.6,
  confirmedCount = 0,
  recencyBonus = 0,
  confidenceWeight = FACT_SCORE_CONFIDENCE_WEIGHT,
  confirmationWeight = FACT_SCORE_CONFIRMATION_WEIGHT,
  recencyWeight = FACT_SCORE_RECENCY_WEIGHT,
} = {}) {
  const sim = clamp01(similarity);
  const conf = clamp01(confidence);
  const confirms = normalizeConfirmedCount(confirmedCount);
  const confirmationBoost = Math.log2(1 + confirms) * confirmationWeight;
  const freshnessBoost = clamp01(recencyBonus) * recencyWeight;
  const score = sim + conf * confidenceWeight + confirmationBoost + freshnessBoost;
  return clamp01(score);
}

function areFactsContradictory(leftText, rightText) {
  const left = normalizeFactText(leftText).toLowerCase();
  const right = normalizeFactText(rightText).toLowerCase();
  if (!left || !right) return false;
  if (left === right) return false;

  const negWords = [" no ", " not ", " never ", " without ", " cannot ", " can't "];
  const leftNeg = negWords.some((w) => ` ${left} `.includes(w));
  const rightNeg = negWords.some((w) => ` ${right} `.includes(w));
  const overlap =
    left.includes(right) ||
    right.includes(left) ||
    left.split(" ").some((token) => token.length > 4 && right.includes(token));

  return overlap && leftNeg !== rightNeg;
}

function cosineSimilarity(a, b) {
  const v1 = normalizeVector(a);
  const v2 = normalizeVector(b);
  if (!v1.length || !v2.length || v1.length !== v2.length) return 0;

  let dot = 0;
  let n1 = 0;
  let n2 = 0;
  for (let i = 0; i < v1.length; i += 1) {
    const x = v1[i];
    const y = v2[i];
    dot += x * y;
    n1 += x * x;
    n2 += y * y;
  }

  if (!n1 || !n2) return 0;
  return dot / (Math.sqrt(n1) * Math.sqrt(n2));
}

function buildTurnMemoryText({ userText = "", assistantText = "" } = {}) {
  const u = String(userText || "").trim();
  const a = String(assistantText || "").trim();

  return [
    "## Prior Conversation Turn",
    "",
    u ? `User: ${u}` : "User:",
    "",
    a ? `Assistant: ${a}` : "Assistant:",
  ].join("\n");
}

export async function writeConversationTurnMemory({
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
  sessionId = "default",
  turnIndex = 0,
  userText = "",
  assistantText = "",
  userEmbedding = [],
  assistantEmbedding = [],
  embeddingModel = "",
} = {}) {
  const db = await openSkillMemoryDb();
  if (!hasStore(db, SKILL_DOCS_STORE)) {
    throw new Error(`Missing IndexedDB store: ${SKILL_DOCS_STORE}`);
  }

  const scope = buildConversationMemoryScope({ tenantId, userId, agentId });
  const id = buildConversationTurnMemoryId({ sessionId, turnIndex });
  const now = new Date().toISOString();
  const existing = await readSkillDocument(id);

  const normalizedUserEmbedding = normalizeVector(userEmbedding);
  const normalizedAssistantEmbedding = normalizeVector(assistantEmbedding);
  const dimensions =
    normalizedUserEmbedding.length ||
    normalizedAssistantEmbedding.length ||
    0;



  const tx = db.transaction(SKILL_DOCS_STORE, "readwrite");
  tx.objectStore(SKILL_DOCS_STORE).put({
    id,
    scope,
    kind: CONVERSATION_MEMORY_DOC_KIND,
    title: `Conversation Turn ${Number(turnIndex) || 0}`,
    sessionId: String(sessionId),
    turnIndex: Math.max(0, Number(turnIndex) || 0),
    text: buildTurnMemoryText({ userText, assistantText }),
    userText: String(userText || ""),
    assistantText: String(assistantText || ""),
    userEmbedding: normalizedUserEmbedding,
    assistantEmbedding: normalizedAssistantEmbedding,
    embeddingModel: String(embeddingModel || ""),
    dimensions,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
  await txDone(tx);

  return {
    id,
    scope,
    sessionId: String(sessionId),
    turnIndex: Math.max(0, Number(turnIndex) || 0),
    dimensions,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

export async function writeConversationFactMemories({
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
  sessionId = "default",
  turnIndex = 0,
  embeddingModel = "",
  facts = [],
} = {}) {
  const db = await openSkillMemoryDb();
  if (!hasStore(db, SKILL_DOCS_STORE)) {
    throw new Error(`Missing IndexedDB store: ${SKILL_DOCS_STORE}`);
  }

  const normalizedFacts = (Array.isArray(facts) ? facts : [])
    .map((item, idx) => {
      const text = normalizeFactText(item?.text);
      const embedding = normalizeVector(item?.embedding);
      const confidence = normalizeFactConfidence(item?.confidence, 0.6);
      const confirmedCount = normalizeConfirmedCount(item?.confirmedCount || 1);
      if (!text || !embedding.length) return null;
      return {
        id: buildConversationFactMemoryId({ sessionId, turnIndex, factIndex: idx }),
        text,
        embedding,
        confidence,
        confirmedCount,
      };
    })
    .filter(Boolean);

  if (!normalizedFacts.length) {
    return {
      scope: buildConversationMemoryScope({ tenantId, userId, agentId }),
      sessionId: String(sessionId),
      turnIndex: Math.max(0, Number(turnIndex) || 0),
      stored: 0,
      skipped: true,
    };
  }

  const scope = buildConversationMemoryScope({ tenantId, userId, agentId });
  const safeTurnIndex = Math.max(0, Number(turnIndex) || 0);
  const now = new Date().toISOString();
  let stored = 0;

  const existingFacts = await listConversationFactMemories({
    tenantId,
    userId,
    agentId,
    limit: 10_000,
    offset: 0,
    sortDesc: true,
  });
  const knownFacts = [...existingFacts];

  for (let i = 0; i < normalizedFacts.length; i += 1) {
    const fact = normalizedFacts[i];
    const factConfidence = normalizeFactConfidence(fact.confidence, 0.6);
    const factConfirmedCount = normalizeConfirmedCount(fact.confirmedCount || 1);

    let bestSimilar = null;
    let bestSimilarity = 0;

    for (let j = 0; j < knownFacts.length; j += 1) {
      const candidate = knownFacts[j];
      const candidateVec = normalizeVector(candidate?.embedding);
      if (!candidateVec.length || candidateVec.length !== fact.embedding.length) continue;
      const similarity = cosineSimilarity(fact.embedding, candidateVec);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestSimilar = candidate;
      }
    }

    if (bestSimilar && bestSimilarity >= FACT_UPSERT_SIMILARITY_THRESHOLD) {
      const tx = db.transaction(SKILL_DOCS_STORE, "readwrite");
      const store = tx.objectStore(SKILL_DOCS_STORE);

      const nextConfirmedCount =
        normalizeConfirmedCount(bestSimilar?.confirmedCount) + factConfirmedCount;
      const nextConfidence = clamp01(
        Math.max(
          normalizeFactConfidence(bestSimilar?.confidence, 0.6),
          factConfidence,
        ) + FACT_CONFIDENCE_BUMP_ON_CONFIRM,
      );

      store.put({
        ...bestSimilar,
        id: String(bestSimilar.id),
        scope,
        kind: CONVERSATION_MEMORY_FACT_KIND,
        title: String(bestSimilar?.title || `Conversation Fact ${safeTurnIndex}:${i}`),
        sessionId: String(bestSimilar?.sessionId || sessionId),
        turnIndex: Math.max(0, Number(bestSimilar?.turnIndex ?? safeTurnIndex)),
        factIndex: Math.max(0, Number(bestSimilar?.factIndex ?? i)),
        text: normalizeFactText(fact.text),
        embedding: fact.embedding,
        embeddingModel: String(embeddingModel || bestSimilar?.embeddingModel || ""),
        dimensions: fact.embedding.length,
        confidence: nextConfidence,
        confirmedCount: nextConfirmedCount,
        createdAt: String(bestSimilar?.createdAt || now),
        updatedAt: now,
      });

      await txDone(tx);
      stored += 1;

      const idx = knownFacts.findIndex((row) => String(row?.id || "") === String(bestSimilar.id));
      if (idx >= 0) {
        knownFacts[idx] = {
          ...knownFacts[idx],
          text: normalizeFactText(fact.text),
          embedding: fact.embedding,
          confidence: nextConfidence,
          confirmedCount: nextConfirmedCount,
          updatedAt: now,
        };
      }

      continue;
    }

    let contradiction = null;
    let contradictionSimilarity = 0;

    for (let j = 0; j < knownFacts.length; j += 1) {
      const candidate = knownFacts[j];
      const candidateVec = normalizeVector(candidate?.embedding);
      if (!candidateVec.length || candidateVec.length !== fact.embedding.length) continue;
      const similarity = cosineSimilarity(fact.embedding, candidateVec);
      if (similarity < FACT_CONTRADICTION_SIMILARITY_THRESHOLD) continue;
      if (!areFactsContradictory(fact.text, candidate?.text)) continue;
      if (similarity > contradictionSimilarity) {
        contradictionSimilarity = similarity;
        contradiction = candidate;
      }
    }

    if (contradiction) {
      const tx = db.transaction(SKILL_DOCS_STORE, "readwrite");
      const store = tx.objectStore(SKILL_DOCS_STORE);

      const decayedConfidence = clamp01(
        normalizeFactConfidence(contradiction?.confidence, 0.6) -
          FACT_CONFIDENCE_DECAY_ON_CONTRADICTION,
      );

      store.put({
        ...contradiction,
        id: String(contradiction.id),
        confidence: decayedConfidence,
        updatedAt: now,
      });

      await txDone(tx);

      const idx = knownFacts.findIndex((row) => String(row?.id || "") === String(contradiction.id));
      if (idx >= 0) {
        knownFacts[idx] = {
          ...knownFacts[idx],
          confidence: decayedConfidence,
          updatedAt: now,
        };
      }
    }

    const tx = db.transaction(SKILL_DOCS_STORE, "readwrite");
    const store = tx.objectStore(SKILL_DOCS_STORE);

    store.put({
      id: fact.id,
      scope,
      kind: CONVERSATION_MEMORY_FACT_KIND,
      title: `Conversation Fact ${safeTurnIndex}:${i}`,
      sessionId: String(sessionId),
      turnIndex: safeTurnIndex,
      factIndex: i,
      text: normalizeFactText(fact.text),
      embedding: fact.embedding,
      embeddingModel: String(embeddingModel || ""),
      dimensions: fact.embedding.length,
      confidence: factConfidence,
      confirmedCount: factConfirmedCount,
      createdAt: now,
      updatedAt: now,
    });

    await txDone(tx);
    stored += 1;

    knownFacts.push({
      id: fact.id,
      scope,
      kind: CONVERSATION_MEMORY_FACT_KIND,
      title: `Conversation Fact ${safeTurnIndex}:${i}`,
      sessionId: String(sessionId),
      turnIndex: safeTurnIndex,
      factIndex: i,
      text: normalizeFactText(fact.text),
      embedding: fact.embedding,
      embeddingModel: String(embeddingModel || ""),
      dimensions: fact.embedding.length,
      confidence: factConfidence,
      confirmedCount: factConfirmedCount,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    scope,
    sessionId: String(sessionId),
    turnIndex: safeTurnIndex,
    stored,
    skipped: false,
    updatedAt: now,
  };
}

export async function listConversationFactMemories({
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
  sessionId = null,
  limit = 500,
  offset = 0,
  sortDesc = true,
} = {}) {
  const scope = buildConversationMemoryScope({ tenantId, userId, agentId });
  const docs = await listSkillDocuments({
    scope,
    limit: 10_000,
    offset: 0,
    sortDesc,
  });

  const targetSessionId = String(sessionId || "").trim();

  const facts = docs.filter((doc) => {
    if (String(doc?.kind || "") !== CONVERSATION_MEMORY_FACT_KIND) return false;
    if (!targetSessionId) return true;
    return String(doc?.sessionId || "") === targetSessionId;
  });

  facts.sort((a, b) => {
    const ai = Number(a?.turnIndex || 0);
    const bi = Number(b?.turnIndex || 0);
    if (ai !== bi) return sortDesc ? bi - ai : ai - bi;
    const afi = Number(a?.factIndex || 0);
    const bfi = Number(b?.factIndex || 0);
    return sortDesc ? bfi - afi : afi - bfi;
  });

  return pageArray(facts, { limit, offset });
}

export async function forgetConversationFactsByText({
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
  query = "",
} = {}) {
  const scope = buildConversationMemoryScope({ tenantId, userId, agentId });
  const needle = normalizeFactText(query).toLowerCase();

  if (!needle) {
    return {
      scope,
      query: "",
      deleted: 0,
      matchedIds: [],
      skipped: true,
    };
  }

  const candidates = await listConversationFactMemories({
    tenantId,
    userId,
    agentId,
    limit: 10_000,
    offset: 0,
    sortDesc: true,
  });

  const matched = candidates.filter((doc) =>
    normalizeFactText(doc?.text).toLowerCase().includes(needle),
  );

  if (!matched.length) {
    return {
      scope,
      query: needle,
      deleted: 0,
      matchedIds: [],
      skipped: false,
    };
  }

  const db = await openSkillMemoryDb();
  if (!hasStore(db, SKILL_DOCS_STORE)) {
    throw new Error(`Missing IndexedDB store: ${SKILL_DOCS_STORE}`);
  }

  const tx = db.transaction(SKILL_DOCS_STORE, "readwrite");
  const store = tx.objectStore(SKILL_DOCS_STORE);

  for (let i = 0; i < matched.length; i += 1) {
    const row = matched[i];
    if (!row?.id) continue;
    store.delete(String(row.id));
  }

  await txDone(tx);

  return {
    scope,
    query: needle,
    deleted: matched.length,
    matchedIds: matched.map((row) => String(row?.id || "")).filter(Boolean),
    skipped: false,
  };
}

export async function clearConversationFactMemories({
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
  sessionId = null,
} = {}) {
  const scope = buildConversationMemoryScope({ tenantId, userId, agentId });

  const matched = await listConversationFactMemories({
    tenantId,
    userId,
    agentId,
    sessionId,
    limit: 10_000,
    offset: 0,
    sortDesc: true,
  });

  if (!matched.length) {
    return {
      scope,
      sessionId: String(sessionId || "").trim() || null,
      deleted: 0,
      matchedIds: [],
      skipped: false,
    };
  }

  const db = await openSkillMemoryDb();
  if (!hasStore(db, SKILL_DOCS_STORE)) {
    throw new Error(`Missing IndexedDB store: ${SKILL_DOCS_STORE}`);
  }

  const tx = db.transaction(SKILL_DOCS_STORE, "readwrite");
  const store = tx.objectStore(SKILL_DOCS_STORE);

  for (let i = 0; i < matched.length; i += 1) {
    const row = matched[i];
    if (!row?.id) continue;
    store.delete(String(row.id));
  }

  await txDone(tx);

  return {
    scope,
    sessionId: String(sessionId || "").trim() || null,
    deleted: matched.length,
    matchedIds: matched.map((row) => String(row?.id || "")).filter(Boolean),
    skipped: false,
  };
}

export async function listConversationTurnMemories({
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
  limit = 200,
  offset = 0,
  sortDesc = true,
} = {}) {
  const scope = buildConversationMemoryScope({ tenantId, userId, agentId });
  const docs = await listSkillDocuments({
    scope,
    limit: 10_000,
    offset: 0,
    sortDesc,
  });

  const turns = docs.filter(
    (doc) => String(doc?.kind || "") === CONVERSATION_MEMORY_DOC_KIND,
  );

  turns.sort((a, b) => {
    const ai = Number(a?.turnIndex || 0);
    const bi = Number(b?.turnIndex || 0);
    return sortDesc ? bi - ai : ai - bi;
  });

  return pageArray(turns, { limit, offset });
}

export async function searchConversationMemoryKnn({
  tenantId = "tenant-dev",
  userId = "user-001",
  agentId = "agent-main",
  sessionId = null,
  excludeSessionId = null,
  excludeTurnIndexes = [],
  queryEmbedding = [],
  topK = 12,
  minScore = 0.7,
  recencyWeight = 0.08,
  recencyHalfLifeHours = 72,
  sameSessionBoost = 0.05,
} = {}) {
  const scope = buildConversationMemoryScope({ tenantId, userId, agentId });
  const query = normalizeVector(queryEmbedding);

  if (!query.length) {
    return {
      scope,
      topK: Math.max(1, Number(topK) || 1),
      minScore: Number(minScore) || 0,
      totalCandidates: 0,
      hits: [],
    };
  }

  const docs = await listSkillDocuments({
    scope,
    limit: 10_000,
    offset: 0,
    sortDesc: true,
  });

  const candidates = docs.filter(
    (doc) => String(doc?.kind || "") === CONVERSATION_MEMORY_FACT_KIND,
  );

  const nowMs = Date.now();
  const safeRecencyWeight = Math.max(0, Math.min(1, Number(recencyWeight) || 0));
  const safeHalfLifeHours = Math.max(1, Number(recencyHalfLifeHours) || 72);
  const safeSessionBoost = Math.max(0, Math.min(1, Number(sameSessionBoost) || 0));
  const preferredSessionId = String(sessionId || "").trim();
  const excludedSessionId = String(excludeSessionId || "").trim();
  const excludedTurnSet = new Set(
    (Array.isArray(excludeTurnIndexes) ? excludeTurnIndexes : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.max(0, Math.trunc(value))),
  );

  const filteredCandidates = candidates.filter((doc) => {
    const docSessionId = String(doc?.sessionId || "");
    const docTurnIndex = Math.max(0, Number(doc?.turnIndex || 0));

    if (excludedSessionId && docSessionId === excludedSessionId) return false;
    if (excludedTurnSet.has(docTurnIndex)) return false;
    return true;
  });

  const scored = filteredCandidates.map((doc) => {
    const kind = String(doc?.kind || "");
    const docSessionId = String(doc?.sessionId || "");
    const updatedAt = String(doc?.updatedAt || doc?.createdAt || "");
    const updatedAtMs = Date.parse(updatedAt);
    const ageHours = Number.isFinite(updatedAtMs)
      ? Math.max(0, (nowMs - updatedAtMs) / 3_600_000)
      : safeHalfLifeHours * 4;
    const recencyStrength = Math.exp((-Math.log(2) * ageHours) / safeHalfLifeHours);
    const recencyBonus = safeRecencyWeight * recencyStrength;
    const sessionBonus =
      preferredSessionId && docSessionId === preferredSessionId ? safeSessionBoost : 0;

    const baseScore = cosineSimilarity(query, doc?.embedding || []);
    const confidence = normalizeFactConfidence(doc?.confidence, 0.6);
    const confirmedCount = normalizeConfirmedCount(doc?.confirmedCount);
    const hybridScore = computeFactHybridScore({
      similarity: baseScore,
      confidence,
      confirmedCount,
      recencyBonus,
    });
    const score = clamp01(hybridScore + sessionBonus);

    return {
      id: String(doc?.id || ""),
      score,
      baseScore,
      recencyBonus,
      sessionBonus,
      confidence,
      confirmedCount,
      kind,
      turnIndex: Number(doc?.turnIndex || 0),
      sessionId: docSessionId,
      text: normalizeFactText(doc?.text),
      userText: "",
      assistantText: "",
      factText: normalizeFactText(doc?.text),
      updatedAt,
      source: doc,
    };
  });

  const threshold = Number(minScore) || 0;
  const safeTopK = Math.max(1, Number(topK) || 1);

  const hits = scored
    .filter((item) => item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, safeTopK);

  return {
    scope,
    topK: safeTopK,
    minScore: threshold,
    totalCandidates: filteredCandidates.length,
    totalCandidatesBeforeExclusions: candidates.length,
    excludeSessionId: excludedSessionId || null,
    excludeTurnIndexes: Array.from(excludedTurnSet),
    recencyWeight: safeRecencyWeight,
    recencyHalfLifeHours: safeHalfLifeHours,
    sameSessionBoost: safeSessionBoost,
    hits,
  };
}

export function buildConversationMemoryPromptBlock(hits) {
  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) return "";

  const lines = [
    "## Relevant Prior Facts",
    "",
    "Use these as candidate prior facts. Prefer higher-confidence and newer facts. If uncertain or conflicting, ask the user to confirm.",
    "",
  ];

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const score = Number(item?.score || 0).toFixed(3);
    const confidence = normalizeFactConfidence(item?.confidence, 0.6).toFixed(2);
    const updatedAt = String(item?.updatedAt || "").trim() || "unknown";
    const factText = normalizeFactText(item?.factText || item?.text || "");

    if (!factText) continue;

    lines.push(`- fact: ${factText.slice(0, 320)}`);
    lines.push(`  confidence: ${confidence} · freshness: ${updatedAt} · score: ${score}`);
  }

  return lines.join("\n").trim();
}

export async function closeSkillMemoryDb() {
  try {
    const db = await runtimeShared.openDb();
    db.close();
  } catch {
    // no-op
  } finally {
    if (runtimeShared.RuntimeDbRegistry) {
      runtimeShared.RuntimeDbRegistry._dbPromise = null;
    }
  }
}