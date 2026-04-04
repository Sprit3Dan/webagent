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

export const SKILL_DB_NAME = "webagent-skills-db";
export const SKILL_DB_VERSION = 3;
export const SKILL_DOCS_STORE = "docs";
export const SKILL_CHUNKS_STORE = "chunks";
export const SKILL_SKILLS_STORE = "skills";
export const SKILL_MODULES_STORE = "skill_modules";
export const SKILL_TOOLS_STORE = "tools";

const DEFAULT_SCOPE = "tenant-dev::user-001::default";

let dbPromise = null;

function assertIndexedDbAvailable() {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
}

function hasStore(db, storeName) {
  return db.objectStoreNames.contains(storeName);
}

function hasIndex(store, indexName) {
  return store.indexNames.contains(indexName);
}

export function buildSkillScope({
  tenantId = "tenant-dev",
  userId = "user-001",
  sessionId = "default",
} = {}) {
  return `${String(tenantId)}::${String(userId)}::${String(sessionId)}`;
}

export async function openSkillMemoryDb() {
  assertIndexedDbAvailable();
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(SKILL_DB_NAME, SKILL_DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(SKILL_DOCS_STORE)) {
        const docs = db.createObjectStore(SKILL_DOCS_STORE, { keyPath: "id" });
        docs.createIndex("scope", "scope", { unique: false });
        docs.createIndex("sourceUrl", "sourceUrl", { unique: false });
      }

      if (!db.objectStoreNames.contains(SKILL_CHUNKS_STORE)) {
        const chunks = db.createObjectStore(SKILL_CHUNKS_STORE, { keyPath: "id" });
        chunks.createIndex("scope", "scope", { unique: false });
        chunks.createIndex("docId", "docId", { unique: false });
      }

      if (!db.objectStoreNames.contains(SKILL_SKILLS_STORE)) {
        const skills = db.createObjectStore(SKILL_SKILLS_STORE, { keyPath: "id" });
        skills.createIndex("name", "name", { unique: false });
        skills.createIndex("enabled", "enabled", { unique: false });
      }

      if (!db.objectStoreNames.contains(SKILL_MODULES_STORE)) {
        const modules = db.createObjectStore(SKILL_MODULES_STORE, { keyPath: "id" });
        modules.createIndex("skillId", "skillId", { unique: false });
        modules.createIndex("name", "name", { unique: false });
        modules.createIndex("enabled", "enabled", { unique: false });
      }



      if (!db.objectStoreNames.contains(SKILL_TOOLS_STORE)) {
        const tools = db.createObjectStore(SKILL_TOOLS_STORE, { keyPath: "id" });
        tools.createIndex("name", "name", { unique: false });
        tools.createIndex("enabled", "enabled", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open skill memory DB"));
  });

  return dbPromise;
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
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);

  if (!hasIndex(store, indexName)) {
    await txDone(tx);
    return [];
  }

  const index = store.index(indexName);
  const req = index.getAll(IDBKeyRange.only(value));
  const out = await reqToPromise(req);
  await txDone(tx);
  return Array.isArray(out) ? out : [];
}

async function getAllByStore(db, storeName) {
  const tx = db.transaction(storeName, "readonly");
  const req = tx.objectStore(storeName).getAll();
  const out = await reqToPromise(req);
  await txDone(tx);
  return Array.isArray(out) ? out : [];
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

export async function closeSkillMemoryDb() {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}