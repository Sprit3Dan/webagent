

const SW_PATH = "/sw.js";
const DEFAULT_TIMEOUT_MS = 20_000;
const SKILL_LANGUAGE = "javascript";
const SKILL_ENTRYPOINT = "executeSkillAction";
const ACTION_EXECUTOR_JS = "js_code";

const DEFAULT_MEMORY_MODULE_CODE = [
  'exports.resolveScope = (context = {}, args = {}) => {',
  '  const tenantId = String(args.tenantId || context.tenantId || "tenant-dev");',
  '  const userId = String(args.userId || context.userId || "user-001");',
  '  const sessionId = String(args.sessionId || context.sessionId || "default");',
  '  return tenantId + "::" + userId + "::" + sessionId;',
  '};',
  '',
  'exports.ingestUrl = async (args = {}, context = {}, kernel) => {',
  '  const url = String(args.url || "").trim();',
  '  if (!url) throw new Error("url is required");',
  '  const scope = exports.resolveScope(context, args);',
  '  const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];',
  '  const force = !!args.forceRefresh;',
  '  const res = await fetch(url, { cache: "no-store", mode: "cors" });',
  '  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);',
  '  const contentType = res.headers.get("content-type") || "";',
  '  const raw = await res.text();',
  '  const text = contentType.includes("text/html") ? kernel.stripHtmlToText(raw) : raw;',
  '  return exports.upsertDocumentFromText({',
  '    scope, sourceUrl: url, title: String(args.title || url), text, tags, force,',
  '  }, kernel);',
  '};',
  '',
  'exports.ingestText = async (args = {}, context = {}, kernel) => {',
  '  const text = kernel.normalizeText(args.text);',
  '  if (!text) throw new Error("text is required");',
  '  const scope = exports.resolveScope(context, args);',
  '  const title = String(args.title || "Untitled note");',
  '  const sourceUrl = String(args.url || "");',
  '  const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];',
  '  return exports.upsertDocumentFromText({',
  '    scope, sourceUrl, title, text, tags, force: true,',
  '  }, kernel);',
  '};',
  '',
  'exports.upsertDocumentFromText = async ({ scope, sourceUrl, title, text, tags = [], force = true }, kernel) => {',
  '  const db = await kernel.openDb();',
  '  const existing = sourceUrl ? await kernel.findDocBySource(db, scope, sourceUrl) : null;',
  '  const docId = existing?.id || kernel.randomId("doc");',
  '  const createdAt = existing?.createdAt || kernel.nowIso();',
  '  const updatedAt = kernel.nowIso();',
  '  const chunks = kernel.chunkText(text);',
  '  if (!chunks.length) throw new Error("No usable content after chunking");',
  '  const tx = db.transaction([kernel.stores.docs, kernel.stores.chunks], "readwrite");',
  '  const docsStore = tx.objectStore(kernel.stores.docs);',
  '  const chunksStore = tx.objectStore(kernel.stores.chunks);',
  '  if (existing && force) await kernel.deleteChunksByDoc(chunksStore, docId);',
  '  docsStore.put({',
  '    id: docId, scope, sourceUrl: sourceUrl || null,',
  '    title: title || sourceUrl || "Untitled", tags,',
  '    textLength: String(text || "").length, chunkCount: chunks.length,',
  '    createdAt, updatedAt,',
  '  });',
  '  for (let i = 0; i < chunks.length; i += 1) {',
  '    const chunkText = chunks[i];',
  '    const tokens = kernel.tokenize(chunkText);',
  '    const tokenFreq = kernel.freqMap(tokens);',
  '    chunksStore.put({',
  '      id: `${docId}::${i}`, scope, docId, index: i, text: chunkText,',
  '      tokenFreq, tokenCount: tokens.length, createdAt, updatedAt,',
  '    });',
  '  }',
  '  await kernel.txDone(tx);',
  '  return {',
  '    docId,',
  '    title: title || sourceUrl || "Untitled",',
  '    sourceUrl: sourceUrl || null,',
  '    chunkCount: chunks.length,',
  '    textLength: String(text || "").length,',
  '    scope,',
  '    updatedAt,',
  '  };',
  '};',
  '',
  'exports.queryMemory = async (args = {}, context = {}, kernel) => {',
  '  const query = kernel.normalizeText(args.query);',
  '  if (!query) throw new Error("query is required");',
  '  const scope = exports.resolveScope(context, args);',
  '  const topK = Math.max(1, Math.min(20, Number(args.topK || 5)));',
  '  const db = await kernel.openDb();',
  '  const [chunks, docs] = await Promise.all([',
  '    kernel.getAllByIndex(db, kernel.stores.chunks, "scope", scope),',
  '    kernel.getAllByIndex(db, kernel.stores.docs, "scope", scope),',
  '  ]);',
  '  if (!chunks.length) return { query, scope, topK, totalChunks: 0, hits: [] };',
  '  const qTokens = kernel.tokenize(query);',
  '  if (!qTokens.length) return { query, scope, topK, totalChunks: chunks.length, hits: [] };',
  '  const docMap = new Map(docs.map((d) => [d.id, d]));',
  '  const hits = [];',
  '  for (const c of chunks) {',
  '    if (hits.length >= topK) break;',
  '    const text = String(c.text || "").toLowerCase();',
  '    let score = 0;',
  '    for (const token of qTokens) if (text.includes(token)) score += 1;',
  '    if (score <= 0) continue;',
  '    const d = docMap.get(c.docId) || null;',
  '    hits.push({',
  '      score, docId: c.docId, chunkId: c.id, chunkIndex: c.index, text: c.text,',
  '      title: d?.title || null, sourceUrl: d?.sourceUrl || null, tags: d?.tags || [],',
  '    });',
  '  }',
  '  hits.sort((a, b) => b.score - a.score);',
  '  return { query, scope, topK, totalChunks: chunks.length, hits: hits.slice(0, topK) };',
  '};',
  '',
  'exports.listDocuments = async (args = {}, context = {}, kernel) => {',
  '  const scope = exports.resolveScope(context, args);',
  '  const db = await kernel.openDb();',
  '  const docs = await kernel.getAllByIndex(db, kernel.stores.docs, "scope", scope);',
  '  docs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));',
  '  return {',
  '    scope,',
  '    count: docs.length,',
  '    documents: docs.map((d) => ({',
  '      id: d.id, title: d.title, sourceUrl: d.sourceUrl, chunkCount: d.chunkCount,',
  '      tags: d.tags || [], updatedAt: d.updatedAt, createdAt: d.createdAt,',
  '    })),',
  '  };',
  '};',
  '',
  'exports.getDocument = async (args = {}, context = {}, kernel) => {',
  '  const docId = String(args.docId || "").trim();',
  '  if (!docId) throw new Error("docId is required");',
  '  const scope = exports.resolveScope(context, args);',
  '  const db = await kernel.openDb();',
  '  const doc = await kernel.getByKey(db, kernel.stores.docs, docId);',
  '  if (!doc || doc.scope !== scope) throw new Error("Document not found");',
  '  const chunks = await kernel.getAllByIndex(db, kernel.stores.chunks, "docId", docId);',
  '  chunks.sort((a, b) => (a.index || 0) - (b.index || 0));',
  '  return {',
  '    document: doc,',
  '    chunks: chunks.map((c) => ({ id: c.id, index: c.index, text: c.text, tokenCount: c.tokenCount })),',
  '  };',
  '};',
  '',
  'exports.deleteDocument = async (args = {}, context = {}, kernel) => {',
  '  const docId = String(args.docId || "").trim();',
  '  if (!docId) throw new Error("docId is required");',
  '  const scope = exports.resolveScope(context, args);',
  '  const db = await kernel.openDb();',
  '  const doc = await kernel.getByKey(db, kernel.stores.docs, docId);',
  '  if (!doc || doc.scope !== scope) throw new Error("Document not found");',
  '  const tx = db.transaction([kernel.stores.docs, kernel.stores.chunks], "readwrite");',
  '  tx.objectStore(kernel.stores.docs).delete(docId);',
  '  await kernel.deleteChunksByDoc(tx.objectStore(kernel.stores.chunks), docId);',
  '  await kernel.txDone(tx);',
  '  return { ok: true, docId, scope };',
  '};',
  '',
  'exports.clearMemory = async (args = {}, context = {}, kernel) => {',
  '  const scope = exports.resolveScope(context, args);',
  '  const db = await kernel.openDb();',
  '  const [docs, chunks] = await Promise.all([',
  '    kernel.getAllByIndex(db, kernel.stores.docs, "scope", scope),',
  '    kernel.getAllByIndex(db, kernel.stores.chunks, "scope", scope),',
  '  ]);',
  '  const tx = db.transaction([kernel.stores.docs, kernel.stores.chunks], "readwrite");',
  '  const docsStore = tx.objectStore(kernel.stores.docs);',
  '  const chunksStore = tx.objectStore(kernel.stores.chunks);',
  '  for (const d of docs) docsStore.delete(d.id);',
  '  for (const c of chunks) chunksStore.delete(c.id);',
  '  await kernel.txDone(tx);',
  '  return { ok: true, scope, deletedDocuments: docs.length, deletedChunks: chunks.length };',
  '};',
].join("\n");

const DEFAULT_RUNTIME_MODULES = [
  {
    name: "memory",
    code: DEFAULT_MEMORY_MODULE_CODE,
    enabled: true,
  },
];

const DEFAULT_RUNTIME_ACTIONS = [
  {
    name: "ingest_url",
    executor: ACTION_EXECUTOR_JS,
    code: "return await modules.memory.ingestUrl(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    name: "ingest_text",
    executor: ACTION_EXECUTOR_JS,
    code: "return await modules.memory.ingestText(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    name: "query_memory",
    executor: ACTION_EXECUTOR_JS,
    code: "return await modules.memory.queryMemory(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    name: "list_documents",
    executor: ACTION_EXECUTOR_JS,
    code: "return await modules.memory.listDocuments(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    name: "get_document",
    executor: ACTION_EXECUTOR_JS,
    code: "return await modules.memory.getDocument(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    name: "delete_document",
    executor: ACTION_EXECUTOR_JS,
    code: "return await modules.memory.deleteDocument(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    name: "clear_memory",
    executor: ACTION_EXECUTOR_JS,
    code: "return await modules.memory.clearMemory(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
];

const DEFAULT_RUNTIME_TOOLS = [
  {
    id: "tool::memory_ingest_url",
    name: "memory_ingest_url",
    code: "return await modules.memory.ingestUrl(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    id: "tool::memory_ingest_text",
    name: "memory_ingest_text",
    code: "return await modules.memory.ingestText(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    id: "tool::memory_query",
    name: "memory_query",
    code: "return await modules.memory.queryMemory(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    id: "tool::memory_list_documents",
    name: "memory_list_documents",
    code: "return await modules.memory.listDocuments(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    id: "tool::memory_get_document",
    name: "memory_get_document",
    code: "return await modules.memory.getDocument(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    id: "tool::memory_delete_document",
    name: "memory_delete_document",
    code: "return await modules.memory.deleteDocument(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
  {
    id: "tool::memory_clear",
    name: "memory_clear",
    code: "return await modules.memory.clearMemory(args, context, kernel);",
    moduleRefs: ["memory"],
    enabled: true,
  },
];

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix = "skill") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function withTimeout(promise, timeoutMs = DEFAULT_TIMEOUT_MS, label = "request") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
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

  const worker =
    navigator.serviceWorker.controller ||
    registration.active ||
    registration.waiting ||
    registration.installing;

  if (!worker) {
    throw new Error("Service worker is not active yet. Reload and retry.");
  }

  return worker;
}

async function sendToServiceWorker(payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const worker = await ensureServiceWorkerReady();

  const task = new Promise((resolve, reject) => {
    const channel = new MessageChannel();

    channel.port1.onmessage = (event) => {
      const data = event?.data || {};
      if (data?.ok === false) {
        reject(new Error(data?.error || "Service worker request failed"));
        return;
      }
      resolve(data);
    };

    try {
      worker.postMessage(payload, [channel.port2]);
    } catch (err) {
      reject(err);
    }
  });

  return withTimeout(task, timeoutMs, payload?.type || "service-worker call");
}

function normalizeActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const seen = new Set();
  const out = [];

  for (const item of list) {
    const name = String(item?.name || "").trim();
    const op = String(item?.op || "").trim();
    const code = String(item?.code || "").trim();
    const executorRaw = String(item?.executor || "").trim();

    const executor =
      executorRaw ||
      (op ? "builtin_op" : "") ||
      (code ? "js_code" : "");

    if (!name) continue;
    if (!executor) continue;
    if (executor === "builtin_op" && !op) continue;
    if (executor === "js_code" && !code) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    out.push({
      name,
      executor,
      op: executor === "builtin_op" ? (op || name) : "",
      code: executor === "js_code" ? code : "",
      enabled: item?.enabled !== false,
      moduleRefs: Array.isArray(item?.moduleRefs)
        ? item.moduleRefs.map((x) => String(x || "").trim()).filter(Boolean)
        : [],
    });
  }

  return out;
}

function normalizeModules(modules) {
  const list = Array.isArray(modules) ? modules : [];
  const seen = new Set();
  const out = [];

  for (const item of list) {
    const name = String(item?.name || "").trim();
    const code = String(item?.code || "").trim();
    if (!name || !code) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    out.push({
      name,
      code,
      enabled: item?.enabled !== false,
    });
  }

  return out;
}

function normalizeTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const seen = new Set();
  const out = [];
  const actionToMethod = {
    ingest_url: "ingestUrl",
    ingest_text: "ingestText",
    query_memory: "queryMemory",
    list_documents: "listDocuments",
    get_document: "getDocument",
    delete_document: "deleteDocument",
    clear_memory: "clearMemory",
  };

  for (const item of list) {
    const name = String(item?.name || "").trim();
    const code = String(item?.code || "").trim();
    const action = String(item?.action || "").trim();
    const inferredMethod = actionToMethod[action] || "";
    const resolvedCode =
      code || (inferredMethod
        ? `return await modules.memory.${inferredMethod}(args, context, kernel);`
        : "");

    if (!name || !resolvedCode) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    out.push({
      id: String(item?.id || `tool::${name}`),
      name,
      code: resolvedCode,
      moduleRefs: Array.isArray(item?.moduleRefs)
        ? item.moduleRefs.map((x) => String(x || "").trim()).filter(Boolean)
        : ["memory"],
      enabled: item?.enabled !== false,
    });
  }

  return out;
}

async function loadDefaultSkillFromBackend(preferredName) {
  try {
    const res = await fetch("/api/skills/bootstrap", {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      mode: "same-origin",
    });
    if (!res.ok) return null;

    const payload = await res.json();
    const skills = Array.isArray(payload?.skills) ? payload.skills : [];
    if (!skills.length) return null;

    const byName = skills.find((s) => String(s?.name || "") === String(preferredName || ""));
    return byName || skills[0] || null;
  } catch {
    return null;
  }
}

function normalizeSkill(input) {
  const name = String(input?.name || "").trim();
  if (!name) throw new Error("skill.name is required");

  const modules = normalizeModules(input?.modules);
  const actions = normalizeActions(input?.actions);
  const tools = normalizeTools(input?.tools);

  const finalTools = tools.length ? tools : DEFAULT_RUNTIME_TOOLS.map((t) => ({ ...t }));

  return {
    name,
    description: String(input?.description || ""),
    version: Number(input?.version || 1),
    language: String(input?.language || SKILL_LANGUAGE),
    entrypoint: String(input?.entrypoint || SKILL_ENTRYPOINT),
    enabled: input?.enabled !== false,
    modules,
    actions,
    tools: finalTools,
  };
}

export async function pingSkillsRuntime({ timeoutMs = 8_000 } = {}) {
  const payload = await sendToServiceWorker(
    { type: "skill.ping", id: randomId("ping") },
    { timeoutMs },
  );
  return {
    version: payload?.version || "unknown",
    skill: payload?.skill || null,
    now: payload?.now || null,
  };
}

export async function listDynamicSkills({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const payload = await sendToServiceWorker(
    { type: "skill.list", id: randomId("list") },
    { timeoutMs },
  );
  return Array.isArray(payload?.registry) ? payload.registry : [];
}

export async function registerDynamicSkill(skillInput, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const skill = normalizeSkill(skillInput);

  const payload = await sendToServiceWorker(
    { type: "skill.register", id: randomId("register"), skill },
    { timeoutMs },
  );

  return payload?.skill || null;
}

export async function setDynamicSkillActionEnabled(
  { skill, action, enabled },
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const skillName = String(skill || "").trim();
  const actionName = String(action || "").trim();

  if (!skillName) throw new Error("skill is required");
  if (!actionName) throw new Error("action is required");

  const payload = await sendToServiceWorker(
    {
      type: "skill.action.set",
      id: randomId("action-set"),
      skill: skillName,
      action: actionName,
      enabled: !!enabled,
    },
    { timeoutMs },
  );

  return payload?.updated || null;
}

let skillsManifestCache = {
  version: 1,
  updatedAt: null,
  skills: [],
};

export async function saveSkillsManifestToOpfs(manifest) {
  const payload = {
    version: Number(manifest?.version || 1),
    updatedAt: nowIso(),
    skills: Array.isArray(manifest?.skills) ? manifest.skills : [],
  };

  skillsManifestCache = payload;
  return payload;
}

export async function loadSkillsManifestFromOpfs() {
  return {
    version: Number(skillsManifestCache?.version || 1),
    updatedAt: skillsManifestCache?.updatedAt || null,
    skills: Array.isArray(skillsManifestCache?.skills) ? skillsManifestCache.skills : [],
  };
}

export async function createAndRegisterSkill({
  name,
  description = "",
  modules = [],
  actions = [],
  tools = [],
  enabled = true,
  version = 1,
}) {
  const shouldLoadDefaults =
    !modules.length &&
    !actions.length &&
    !tools.length;

  const backendDefault = shouldLoadDefaults
    ? await loadDefaultSkillFromBackend(name)
    : null;

  const source = backendDefault || {
    name,
    description,
    modules,
    actions,
    tools,
    enabled,
    version,
  };

  const skill = normalizeSkill({
    ...source,
    name: String(source?.name || name || "").trim(),
    description: String(source?.description || description || ""),
    enabled: source?.enabled !== false && enabled !== false,
    version: Number(source?.version || version || 1),
  });

  const registered = await registerDynamicSkill(skill);
  const previous = Array.isArray(skillsManifestCache?.skills) ? skillsManifestCache.skills : [];
  const filtered = previous.filter((s) => String(s?.name || "") !== skill.name);

  skillsManifestCache = {
    version: Number(skillsManifestCache?.version || 1),
    updatedAt: nowIso(),
    skills: [...filtered, skill],
  };

  return registered;
}