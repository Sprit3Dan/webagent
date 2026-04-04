const SW_VERSION = "3.0.0";

const DB_NAME = "webagent-skills-db";
const DB_VERSION = 3;

const DOCS_STORE = "docs";
const CHUNKS_STORE = "chunks";
const SKILLS_STORE = "skills";
const TOOLS_STORE = "tools";

const CACHE_NAME = "webagent-skill-cache-v3";
const ACTION_EXECUTOR_JS = "js_code";

const DEFAULT_SKILL_ID = "registry::default";
const DEFAULT_SKILL_NAME = "sw_unified_knowledge_runtime";

const REQUIRED_STORES = [
	DOCS_STORE,
	CHUNKS_STORE,
	SKILLS_STORE,
	TOOLS_STORE,
];

self.addEventListener("install", (event) => {
	self.skipWaiting();
	event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			await self.clients.claim();
			await openDb();
		})(),
	);
});

self.addEventListener("message", (event) => {
	event.waitUntil(handleMessageEvent(event));
});

async function handleMessageEvent(event) {
	const req = event.data || {};
	const reply = makeReply(event);

	if (req && req.type === "skill.ping") {
		return reply({
			ok: true,
			type: "skill.pong",
			version: SW_VERSION,
			now: nowIso(),
		});
	}

	if (req && req.type === "skill.list") {
		try {
			const registry = await listRegisteredSkills();
			return reply({
				ok: true,
				type: "skill.list.result",
				id: (req && req.id) || null,
				registry,
				now: nowIso(),
			});
		} catch (err) {
			return reply({
				ok: false,
				type: "skill.list.result",
				id: (req && req.id) || null,
				error:
					err instanceof Error
						? err.message
						: "Failed to list skills",
				now: nowIso(),
			});
		}
	}

	if (req && req.type === "skill.register") {
		try {
			const registered = await registerDynamicSkill(
				(req && req.skill) || {},
			);
			return reply({
				ok: true,
				type: "skill.register.result",
				id: (req && req.id) || null,
				skill: registered,
				now: nowIso(),
			});
		} catch (err) {
			return reply({
				ok: false,
				type: "skill.register.result",
				id: (req && req.id) || null,
				error:
					err instanceof Error
						? err.message
						: "Failed to register skill",
				now: nowIso(),
			});
		}
	}

	if (req && req.type === "skill.tool.set") {
		try {
			const updated = await setSkillToolEnabled(
				String((req && req.skill) || ""),
				String((req && req.tool) || ""),
				!!(req && req.enabled),
			);
			return reply({
				ok: true,
				type: "skill.tool.set.result",
				id: (req && req.id) || null,
				updated,
				now: nowIso(),
			});
		} catch (err) {
			return reply({
				ok: false,
				type: "skill.tool.set.result",
				id: (req && req.id) || null,
				error:
					err instanceof Error
						? err.message
						: "Failed to update tool",
				now: nowIso(),
			});
		}
	}

	if (!req || req.type !== "skill.run") {
		return reply({
			ok: false,
			type: "skill.result",
			id: (req && req.id) || null,
			error: "Unsupported message type",
		});
	}

	const started = Date.now();
	const id = (req && req.id) || randomId("req");
	const skill = String((req && req.skill) || "");
	const action = String((req && req.action) || "");
	const args = (req && req.args) || {};
	const context = (req && req.context) || {};

	try {
		const result = await executeSkillTool(skill, action, args, context);
		return reply({
			ok: true,
			type: "skill.result",
			id,
			skill,
			action,
			result,
			durationMs: Date.now() - started,
			now: nowIso(),
		});
	} catch (err) {
		return reply({
			ok: false,
			type: "skill.result",
			id,
			skill,
			action,
			error:
				err instanceof Error ? err.message : "Skill execution failed",
			durationMs: Date.now() - started,
			now: nowIso(),
		});
	}
}

function makeReply(event) {
	const port = event.ports && event.ports[0];
	if (port) return (payload) => port.postMessage(payload);

	const source = event.source;
	return (payload) => {
		if (source && typeof source.postMessage === "function")
			source.postMessage(payload);
	};
}

async function executeSkillTool(skillName, toolName, args, context) {
	const db = await openDb();

	const skills = await getAllByIndex(
		db,
		SKILLS_STORE,
		"name",
		String(skillName || ""),
	);
	const skill = skills.find((s) => s && s.enabled !== false);
	if (!skill) throw new Error("Unknown skill: " + (skillName || "<missing>"));

	const tools = await getAllByIndex(db, TOOLS_STORE, "skillId", skill.id);
	const tool = tools.find(
		(t) => t && t.name === toolName && t.enabled !== false,
	);
	if (!tool) throw new Error("Unknown tool: " + (toolName || "<missing>"));

	const code = getInlineToolCode(tool);

	const kernel = buildKernelApi();
	const runner = new Function(
		"args",
		"context",
		"kernel",
		"skill",
		"tool",
		'"use strict";\nreturn (async () => {\n' + code + "\n})();",
	);

	return await runner(
		args || {},
		context || {},
		kernel,
		skill,
		tool,
	);
}

function getInlineToolCode(tool) {
	const code = String((tool && tool.code) || "").trim();
	if (code) return code;

	throw new Error(
		"Tool has no inline code. Runtime is configured for inline tool execution only.",
	);
}

async function listRegisteredSkills() {
	const db = await openDb();
	const [skills, tools] = await Promise.all([
		getAllByStore(db, SKILLS_STORE),
		getAllByStore(db, TOOLS_STORE),
	]);

	const toolsBySkill = new Map();

	for (const toolRec of tools) {
		const key = String((toolRec && toolRec.skillId) || "");
		if (!toolsBySkill.has(key)) toolsBySkill.set(key, []);
		toolsBySkill.get(key).push({
			id: toolRec.id,
			name: toolRec.name,
			enabled: toolRec.enabled !== false,
			updatedAt: toolRec.updatedAt || null,
			hasInlineCode: String((toolRec && toolRec.code) || "").trim().length > 0,
		});
	}

	return skills.map((skill) => ({
		id: skill.id,
		name: skill.name,
		description: skill.description || "",
		enabled: skill.enabled !== false,
		version: skill.version || 1,
		language: skill.language || "javascript",
		entrypoint: skill.entrypoint || "executeSkillTool",
		updatedAt: skill.updatedAt || null,
		tools: toolsBySkill.get(skill.id) || [],
	}));
}

async function registerDynamicSkill(skillInput) {
	const name = String((skillInput && skillInput.name) || "").trim();
	if (!name) throw new Error("skill.name is required");

	const toolsInput = normalizeToolsInput(skillInput && skillInput.tools);
	if (!toolsInput.length)
		throw new Error("skill.tools must be a non-empty array");

	const db = await openDb();
	const now = nowIso();
	const existing = (await getByKey(db, SKILLS_STORE, DEFAULT_SKILL_ID)) || null;
	const skillId = DEFAULT_SKILL_ID;
	const skillName = DEFAULT_SKILL_NAME;
	const allSkills = await getAllByStore(db, SKILLS_STORE);
	const legacySkillIds = (allSkills || [])
		.map((rec) => String((rec && rec.id) || ""))
		.filter((id) => id && id !== skillId);

	const tx = db.transaction([SKILLS_STORE, TOOLS_STORE], "readwrite");

	const skillsStore = tx.objectStore(SKILLS_STORE);
	const toolsStore = tx.objectStore(TOOLS_STORE);

	await pruneLegacySkillsForRegistration(tx, legacySkillIds);

	skillsStore.put({
		id: skillId,
		name: skillName,
		description: String((skillInput && skillInput.description) || ""),
		version: Number((skillInput && skillInput.version) || 1),
		language: String((skillInput && skillInput.language) || "javascript"),
		entrypoint: "executeSkillTool",
		enabled: !skillInput || skillInput.enabled !== false,
		createdAt: (existing && existing.createdAt) || now,
		updatedAt: now,
	});

	const priorTools = await reqToPromise(
		toolsStore.index("skillId").getAll(IDBKeyRange.only(skillId)),
	);

	for (const rec of priorTools || []) {
		toolsStore.delete(rec.id);
	}

	for (const toolDef of toolsInput) {
		const toolName = toolDef.name;

		toolsStore.put({
			id:
				toolDef.id ||
				"tool::" + String(skillId) + "::" + String(toolName),
			skillId,
			name: toolName,
			executor: ACTION_EXECUTOR_JS,
			code: toolDef.code,
			enabled: toolDef.enabled,
			createdAt: now,
			updatedAt: now,
		});
	}

	await txDone(tx);

	return {
		id: skillId,
		name: skillName,
		enabled: !skillInput || skillInput.enabled !== false,
		toolCount: toolsInput.length,
		updatedAt: now,
	};
}

async function pruneLegacySkillsForRegistration(tx, legacySkillIds) {
	const ids = Array.isArray(legacySkillIds) ? legacySkillIds : [];
	if (!ids.length) return;

	const skillsStore = tx.objectStore(SKILLS_STORE);
	const toolsStore = tx.objectStore(TOOLS_STORE);

	for (const legacySkillId of ids) {
		const legacyTools = await reqToPromise(
			toolsStore.index("skillId").getAll(IDBKeyRange.only(legacySkillId)),
		);

		for (const rec of legacyTools || []) {
			toolsStore.delete(rec.id);
		}

		skillsStore.delete(legacySkillId);
	}
}

async function setSkillToolEnabled(skillName, toolName, enabled) {
	const name = String(skillName || "").trim();
	const tool = String(toolName || "").trim();
	if (!name) throw new Error("skill is required");
	if (!tool) throw new Error("tool is required");

	const db = await openDb();
	const skill = (await getAllByIndex(db, SKILLS_STORE, "name", name)).find(
		(s) => s && s.enabled !== false,
	);
	if (!skill) throw new Error("Skill not found");

	const tools = await getAllByIndex(db, TOOLS_STORE, "skillId", skill.id);
	const target = tools.find((t) => t?.name === tool);
	if (!target) throw new Error("Skill tool not found");

	const updated = {
		...target,
		enabled: !!enabled,
		updatedAt: nowIso(),
	};

	const tx = db.transaction(TOOLS_STORE, "readwrite");
	tx.objectStore(TOOLS_STORE).put(updated);
	await txDone(tx);

	return {
		id: updated.id,
		skillId: updated.skillId,
		name: updated.name,
		enabled: updated.enabled,
		updatedAt: updated.updatedAt,
	};
}



function normalizeToolsInput(tools) {
	const list = Array.isArray(tools) ? tools : [];
	const seen = new Set();
	const out = [];

	for (const item of list) {
		const name = String((item && item.name) || "").trim();
		const code = String((item && item.code) || "").trim();
		if (!name || !code) continue;
		if (seen.has(name)) continue;
		seen.add(name);

		out.push({
			id: String(item?.id || ""),
			name,
			code,
			enabled: item?.enabled !== false,
		});
	}

	return out;
}

function buildKernelApi() {
	return {
		cacheName: CACHE_NAME,
		stores: {
			docs: DOCS_STORE,
			chunks: CHUNKS_STORE,
			skills: SKILLS_STORE,
			tools: TOOLS_STORE,
		},

		nowIso,
		randomId,
		normalizeText,
		tokenize,
		freqMap,
		chunkText,
		stripHtmlToText,

		openDb,
		txDone,
		reqToPromise,

		getByKey,
		getAllByStore,
		getAllByIndex,
		findDocBySource,
		deleteChunksByDoc,
	};
}

function nowIso() {
	return new Date().toISOString();
}

function randomId(prefix = "id") {
	if (self.crypto && typeof self.crypto.randomUUID === "function") {
		return String(prefix) + "_" + self.crypto.randomUUID();
	}
	return (
		String(prefix) +
		"_" +
		String(Date.now()) +
		"_" +
		Math.random().toString(36).slice(2, 10)
	);
}

function normalizeText(value) {
	return String(value || "")
		.replace(/\r\n/g, "\n")
		.trim();
}

function tokenize(text) {
	return String(text || "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 1);
}

function freqMap(tokens) {
	const out = Object.create(null);
	for (const t of tokens) out[t] = (out[t] || 0) + 1;
	return out;
}

function chunkText(text, { targetChars = 800, overlapChars = 180 } = {}) {
	const src = normalizeText(text);
	if (!src) return [];

	const chunks = [];
	let i = 0;

	while (i < src.length) {
		let end = Math.min(src.length, i + targetChars);
		if (end < src.length) {
			const nl = src.lastIndexOf("\n", end);
			const sp = src.lastIndexOf(" ", end);
			const soft = Math.max(nl, sp);
			if (soft > i + Math.floor(targetChars * 0.6)) end = soft;
		}

		const piece = src.slice(i, end).trim();
		if (piece) chunks.push(piece);

		if (end >= src.length) break;
		i = Math.max(end - overlapChars, i + 1);
	}

	return chunks;
}

function stripHtmlToText(html) {
	const withoutScripts = String(html || "")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ");
	return withoutScripts
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

let _dbPromise = null;
let _toolsInlineMigrated = false;

function hasRequiredStores(db) {
	return REQUIRED_STORES.every((storeName) =>
		db.objectStoreNames.contains(storeName),
	);
}

function deleteDatabase(dbName) {
	return new Promise((resolve, reject) => {
		const req = indexedDB.deleteDatabase(dbName);
		req.onsuccess = () => resolve();
		req.onerror = () =>
			reject(req.error || new Error("Failed to delete IndexedDB"));
		req.onblocked = () =>
			reject(
				new Error(
					"IndexedDB delete blocked by another open connection",
				),
			);
	});
}

async function recreateDatabase() {
	_dbPromise = null;
	try {
		await deleteDatabase(DB_NAME);
	} catch (err) {
		void err;
	}
	return openDb();
}

function openDb() {
	if (_dbPromise) return _dbPromise;

	_dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);

		req.onupgradeneeded = () => {
			const db = req.result;

			if (!db.objectStoreNames.contains(DOCS_STORE)) {
				const docs = db.createObjectStore(DOCS_STORE, {
					keyPath: "id",
				});
				docs.createIndex("scope", "scope", { unique: false });
				docs.createIndex("sourceUrl", "sourceUrl", { unique: false });
			}

			if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
				const chunks = db.createObjectStore(CHUNKS_STORE, {
					keyPath: "id",
				});
				chunks.createIndex("scope", "scope", { unique: false });
				chunks.createIndex("docId", "docId", { unique: false });
			}

			if (!db.objectStoreNames.contains(SKILLS_STORE)) {
				const skills = db.createObjectStore(SKILLS_STORE, {
					keyPath: "id",
				});
				skills.createIndex("name", "name", { unique: false });
				skills.createIndex("enabled", "enabled", { unique: false });
			}

			if (!db.objectStoreNames.contains(TOOLS_STORE)) {
				const toolStoreDef = db.createObjectStore(TOOLS_STORE, {
					keyPath: "id",
				});
				toolStoreDef.createIndex("skillId", "skillId", {
					unique: false,
				});
				toolStoreDef.createIndex("name", "name", { unique: false });
				toolStoreDef.createIndex("enabled", "enabled", {
					unique: false,
				});
			}
		};

		req.onsuccess = () => {
			const db = req.result;

			db.onversionchange = () => {
				try {
					db.close();
				} catch (err) {
					void err;
				} finally {
					_dbPromise = null;
				}
			};

			db.onclose = () => {
				_dbPromise = null;
			};

			if (!hasRequiredStores(db)) {
				try {
					db.close();
				} catch (err) {
					void err;
				} finally {
					_dbPromise = null;
				}

				recreateDatabase().then(resolve).catch(reject);
				return;
			}

			migrateLegacyToolRuntimeRecords(db)
				.then(() => resolve(db))
				.catch(() => resolve(db));
		};

		req.onerror = () => {
			_dbPromise = null;
			reject(req.error || new Error("Failed to open IndexedDB"));
		};
	});

	return _dbPromise;
}

async function migrateLegacyToolRuntimeRecords(db) {
	if (_toolsInlineMigrated) return;
	_toolsInlineMigrated = true;

	const tx = db.transaction([TOOLS_STORE, DOCS_STORE], "readwrite");
	const toolsStore = tx.objectStore(TOOLS_STORE);
	const docsStore = tx.objectStore(DOCS_STORE);

	const allTools = await reqToPromise(toolsStore.getAll());
	for (const toolRec of allTools || []) {
		if (!toolRec) continue;

		const next = { ...toolRec };
		let changed = false;

		if (Object.prototype.hasOwnProperty.call(next, "codeDocId")) {
			delete next.codeDocId;
			changed = true;
		}

		if (Object.prototype.hasOwnProperty.call(next, "moduleRefs")) {
			delete next.moduleRefs;
			changed = true;
		}

		if (changed) {
			next.updatedAt = nowIso();
			toolsStore.put(next);
		}
	}

	const allDocs = await reqToPromise(docsStore.getAll());
	for (const doc of allDocs || []) {
		const docId = String((doc && doc.id) || "");
		if (docId.includes("::doc::tool::")) {
			docsStore.delete(docId);
		}
	}

	await txDone(tx);
}



function txDone(tx) {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
		tx.onerror = () => reject(tx.error || new Error("Transaction failed"));
	});
}

function reqToPromise(req) {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () =>
			reject(req.error || new Error("IndexedDB request failed"));
	});
}

function isClosingDbError(err) {
	const message = String(err?.message || "");
	return (
		message.includes("database connection is closing") ||
		message.includes("connection is closing") ||
		message.includes("close pending") ||
		message.includes("The database connection is closing")
	);
}

function isMissingStoreError(err) {
	const message = String(err?.message || "");
	return (
		message.includes("object stores was not found") ||
		message.includes("object store was not found") ||
		message.includes("One of the specified object stores was not found")
	);
}

async function withDbReadRetry(readOp) {
	try {
		return await readOp();
	} catch (err) {
		if (!isClosingDbError(err) && !isMissingStoreError(err)) throw err;

		_dbPromise = null;

		if (isMissingStoreError(err)) {
			const recreated = await recreateDatabase();
			return readOp(recreated);
		}

		const reopened = await openDb();
		return readOp(reopened);
	}
}

async function getAllByStore(db, storeName) {
	return withDbReadRetry(async (maybeDb) => {
		const activeDb = maybeDb || db || (await openDb());
		const tx = activeDb.transaction(storeName, "readonly");
		const req = tx.objectStore(storeName).getAll();
		const out = await reqToPromise(req);
		await txDone(tx);
		return out || [];
	});
}

async function getByKey(db, storeName, key) {
	return withDbReadRetry(async (maybeDb) => {
		const activeDb = maybeDb || db || (await openDb());
		const tx = activeDb.transaction(storeName, "readonly");
		const req = tx.objectStore(storeName).get(String(key));
		const out = await reqToPromise(req);
		await txDone(tx);
		return out;
	});
}

async function getAllByIndex(db, storeName, indexName, value) {
	return withDbReadRetry(async (maybeDb) => {
		const activeDb = maybeDb || db || (await openDb());
		const tx = activeDb.transaction(storeName, "readonly");
		const store = tx.objectStore(storeName);
		const idx = store.index(indexName);
		const req = idx.getAll(IDBKeyRange.only(value));
		const out = await reqToPromise(req);
		await txDone(tx);
		return out || [];
	});
}

async function findDocBySource(db, scope, sourceUrl) {
	if (!sourceUrl) return null;
	const docs = await getAllByIndex(db, DOCS_STORE, "sourceUrl", sourceUrl);
	return docs.find((d) => d.scope === scope) || null;
}

async function deleteChunksByDoc(chunkStore, docId) {
	const idx = chunkStore.index("docId");
	const all = await reqToPromise(idx.getAll(IDBKeyRange.only(docId)));
	for (const c of all || []) chunkStore.delete(c.id);
}
