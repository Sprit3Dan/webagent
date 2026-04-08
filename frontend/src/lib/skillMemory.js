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

const DEFAULT_SCOPE = "tenant-dev::user-001::default";

export const CONVERSATION_MEMORY_SCOPE_PREFIX = "conversation-memory";
export const CONVERSATION_MEMORY_DOC_KIND = "conversation_turn";
export const CONVERSATION_MEMORY_FACT_KIND = "conversation_fact";

const reqToPromise = runtimeShared.dbReqToPromise;
const txDone = runtimeShared.dbTxDone;

function hasStore(db, storeName) {
  return db.objectStoreNames.contains(storeName);
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
      const text = String(item?.text || "").trim();
      const embedding = normalizeVector(item?.embedding);
      if (!text || !embedding.length) return null;
      return {
        id: buildConversationFactMemoryId({ sessionId, turnIndex, factIndex: idx }),
        text,
        embedding,
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

  for (let i = 0; i < normalizedFacts.length; i += 1) {
    const fact = normalizedFacts[i];
    // Use per-record transaction to avoid transaction-lifecycle races under async load.
    // eslint-disable-next-line no-await-in-loop
    const existing = await readSkillDocument(fact.id);

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
      text: fact.text,
      embedding: fact.embedding,
      embeddingModel: String(embeddingModel || ""),
      dimensions: fact.embedding.length,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });

    // eslint-disable-next-line no-await-in-loop
    await txDone(tx);
    stored += 1;
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

  const candidates = docs.filter((doc) => {
    const kind = String(doc?.kind || "");
    return kind === CONVERSATION_MEMORY_DOC_KIND || kind === CONVERSATION_MEMORY_FACT_KIND;
  });

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

    let baseScore = 0;

    if (kind === CONVERSATION_MEMORY_FACT_KIND) {
      baseScore = cosineSimilarity(query, doc?.embedding || []);
      const score = Math.min(1, baseScore + recencyBonus + sessionBonus);

      return {
        id: String(doc?.id || ""),
        score,
        baseScore,
        recencyBonus,
        sessionBonus,
        kind,
        turnIndex: Number(doc?.turnIndex || 0),
        sessionId: docSessionId,
        text: String(doc?.text || ""),
        userText: "",
        assistantText: "",
        factText: String(doc?.text || ""),
        updatedAt,
        source: doc,
      };
    }

    const userScore = cosineSimilarity(query, doc?.userEmbedding || []);
    const assistantScore = cosineSimilarity(query, doc?.assistantEmbedding || []);
    baseScore = Math.max(userScore, assistantScore);
    const score = Math.min(1, baseScore + recencyBonus + sessionBonus);

    return {
      id: String(doc?.id || ""),
      score,
      baseScore,
      recencyBonus,
      sessionBonus,
      kind,
      turnIndex: Number(doc?.turnIndex || 0),
      sessionId: docSessionId,
      text: String(doc?.text || ""),
      userText: String(doc?.userText || ""),
      assistantText: String(doc?.assistantText || ""),
      factText: "",
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

  const lines = ["## Relevant Prior Memories", "", "We had related conversations before:"];

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const score = Number(item?.score || 0).toFixed(3);
    const sessionId = String(item?.sessionId || "");
    const turnIndex = Math.max(0, Number(item?.turnIndex || 0));
    const userText = String(item?.userText || "").replace(/\s+/g, " ").trim();
    const assistantText = String(item?.assistantText || "").replace(/\s+/g, " ").trim();
    const factText = String(item?.factText || "").replace(/\s+/g, " ").trim();
    const kind = String(item?.kind || "");

    lines.push(`- [score=${score}] session=${sessionId} turn=${turnIndex} kind=${kind}`);

    if (factText) {
      lines.push(`  - fact: ${factText.slice(0, 280)}`);
      continue;
    }

    lines.push(
      `  - user: ${userText.slice(0, 280)}`,
      `  - assistant: ${assistantText.slice(0, 280)}`,
    );
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