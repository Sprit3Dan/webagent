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

self.addEventListener("push", (event) => {
	event.waitUntil(handlePushEvent(event));
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

async function handlePushEvent(event) {
	let payload = {
		type: "heartbeat",
		createdAt: nowIso(),
	};

	try {
		if (event && event.data) {
			try {
				const parsed = event.data.json();
				if (parsed && typeof parsed === "object") {
					payload = parsed;
				}
			} catch (err) {
				void err;
				const text = String(event.data.text ? await event.data.text() : "").trim();
				if (text) {
					payload = {
						type: "heartbeat",
						message: text,
						createdAt: nowIso(),
					};
				}
			}
		}
	} catch (err) {
		void err;
	}

	console.info("[sw.push] received", payload);

	const heartbeatResult = await runHeartbeatPushFlow(payload);

	await notifyOpenClients({
		type: "push.message",
		payload,
		heartbeat: heartbeatResult,
		now: nowIso(),
	});

	if (heartbeatResult) {
		await notifyOpenClients({
			type: "heartbeat.assistant_note",
			message: {
				role: "assistant",
				content: heartbeatResult.assistantNote,
				timestamp: heartbeatResult.generatedAt,
			},
			stats: {
				pendingCount: heartbeatResult.pendingCount,
				completedCount: heartbeatResult.completedCount,
			},
		});
	}

	if (
		self.registration &&
		typeof self.registration.showNotification === "function"
	) {
		const title = String(
			(payload && typeof payload === "object" && payload.title) ||
			"webagent push received",
		);
		const body = String(
			(heartbeatResult && heartbeatResult.assistantNote) ||
			(payload && typeof payload === "object" && (payload.body || payload.message)) ||
			"Push delivery verified in service worker",
		);
		await self.registration.showNotification(title, {
			body,
			tag: String(
				(payload && typeof payload === "object" && payload.tag) ||
				"webagent-push-debug",
			),
			data: payload,
		});
	}
}

async function notifyOpenClients(message) {
	const clientsList = await self.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});

	for (const client of clientsList) {
		try {
			client.postMessage(message);
		} catch (err) {
			void err;
		}
	}
}

async function runHeartbeatPushFlow(payload) {
	const type = String((payload && payload.type) || "").trim().toLowerCase();
	if (type !== "heartbeat") return null;

	try {
		const db = await openDb();
		const markdownBefore = await loadHeartbeatMarkdown(db);
		const parsedBefore = parseHeartbeatMarkdown(markdownBefore);
		const pendingBefore = Array.isArray(parsedBefore && parsedBefore.pending)
			? parsedBefore.pending
			: [];
		const completedBefore = Array.isArray(parsedBefore && parsedBefore.completed)
			? parsedBefore.completed
			: [];

		const decision = await reviewHeartbeatActionWithLlm({
			db,
			payload,
			markdown: markdownBefore,
			pending: pendingBefore,
			completed: completedBefore,
		});

		const executedTools = [];
		const toolCalls = Array.isArray(decision && decision.toolCalls)
			? decision.toolCalls
			: [];

		for (const call of toolCalls) {
			const fn = call && call.function ? call.function : {};
			const toolName = String((fn && fn.name) || "").trim();
			if (!toolName) continue;

			const args = parseJsonObjectSafe(fn && fn.arguments);

			const handled = await executeHeartbeatPendingTool(
				toolName,
				args,
				{ source: "heartbeat_push" },
			);

			if (handled && handled.__handled) {
				executedTools.push({
					name: toolName,
					result: handled.result,
				});
				continue;
			}

			const result = await executeRegisteredToolByName(
				db,
				toolName,
				args,
				{ source: "heartbeat_push" },
			);

			executedTools.push({
				name: toolName,
				result,
			});
		}

		const markdownAfter = await loadHeartbeatMarkdown(db);
		const parsedAfter = parseHeartbeatMarkdown(markdownAfter);
		const pendingAfter = Array.isArray(parsedAfter && parsedAfter.pending)
			? parsedAfter.pending
			: [];
		const completedAfter = Array.isArray(parsedAfter && parsedAfter.completed)
			? parsedAfter.completed
			: [];

		let assistantNote = String((decision && decision.assistantNote) || "").trim();
		if (!assistantNote) {
			assistantNote = buildHeartbeatAssistantNote({
				beforePending: pendingBefore,
				afterPending: pendingAfter,
			});
		}

		if (executedTools.length) {
			const names = executedTools.map((t) => t.name).join(", ");
			assistantNote += `\n\nHeartbeat actions executed: ${names}`;
		}

		return {
			assistantNote,
			localAssistantNote: assistantNote,
			llmAssistantNote: String((decision && decision.assistantNote) || "").trim() || null,
			pendingCount: pendingAfter.length,
			completedCount: completedAfter.length,
			executedToolCount: executedTools.length,
			generatedAt: nowIso(),
		};
	} catch (err) {
		return {
			assistantNote: "Heartbeat tick received, but I couldn't process pending items.",
			pendingCount: 0,
			completedCount: 0,
			generatedAt: nowIso(),
			error: err instanceof Error ? err.message : "heartbeat processing failed",
		};
	}
}

async function reviewHeartbeatActionWithLlm({ db, payload, markdown, pending, completed }) {
	try {
		const tenantId = String((payload && payload.tenantId) || "tenant-dev");
		const userId = String((payload && payload.userId) || "user-001");
		const agentId = String((payload && payload.agentId) || "agent-main");
		const sessionId = String((payload && payload.sessionId) || "chat-001");
		const model = String((payload && payload.model) || "nemotron-30b");

		const registryTools = await getAllByStore(db, TOOLS_STORE);
		const plannerTools = (registryTools || [])
			.filter((tool) => tool && tool.enabled !== false)
			.map((tool) => ({
				type: "function",
				function: {
					name: String(tool.name || ""),
					description: "Runtime tool from backend-registered registry",
					parameters: {
						type: "object",
						properties: {},
						additionalProperties: true,
					},
				},
			}))
			.filter((toolDef) => String((toolDef.function && toolDef.function.name) || "").trim());

		if (!plannerTools.length) {
			return { assistantNote: null, toolCalls: [] };
		}

		const context = await buildHeartbeatContextForLlm({
			tenantId,
			userId,
			agentId,
			sessionId,
			payload,
			markdown,
			pending,
			completed,
		});

		const requestBody = {
			tenantId,
			userId,
			agentId,
			sessionId,
			model,
			temperature: 0.2,
			stream: false,
			messages: context.messages,
			tools: plannerTools,
		};

		const res = await fetch("/api/agent/respond", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-tenant-id": tenantId,
				"x-user-id": userId,
				"x-agent-id": agentId,
			},
			credentials: "same-origin",
			body: JSON.stringify(requestBody),
		});

		if (!res.ok) return { assistantNote: null, toolCalls: [] };

		const data = await res.json();
		const message = (data && data.message) || {};
		const assistantNote = String((message && message.content) || "").trim() || null;
		const toolCalls = Array.isArray(message && message.tool_calls)
			? message.tool_calls
			: [];

		return { assistantNote, toolCalls };
	} catch (err) {
		void err;
		return { assistantNote: null, toolCalls: [] };
	}
}

async function buildHeartbeatContextForLlm({
	tenantId,
	userId,
	agentId,
	sessionId,
	payload,
	markdown,
	pending,
	completed,
}) {
	const roleHistory = normalizeHeartbeatHistory(payload && payload.history);
	const bootstrapText = await readHeartbeatBootstrapTextFromOpfs();

	const identitySection =
		"# webagent\n\n" +
		"You are webagent, a frontend-first assistant with service-worker tools.\n\n" +
		"## Runtime\n" +
		"- Environment: service-worker\n\n" +
		"## Scope\n" +
		`- tenantId: ${tenantId}\n` +
		`- userId: ${userId}\n` +
		`- agentId: ${agentId}\n` +
		`- sessionId: ${sessionId}`;

	const memoryText =
		"## Heartbeat Pending Markdown\n\n" +
		String(markdown || "").slice(0, 12000);

	const skillsText =
		"Heartbeat runtime loop.\n" +
		"If action is needed, emit tool_calls with correct arguments.\n" +
		"If no action is needed, return a concise summary.\n" +
		"Never invent tool results; rely on tool outputs as source of truth.";

	const systemPrompt = [
		cleanHeartbeatText(identitySection),
		cleanHeartbeatText(bootstrapText),
		`# Memory\n\n${cleanHeartbeatText(memoryText)}`,
		`# Skills\n\n${cleanHeartbeatText(skillsText)}`,
	]
		.filter(Boolean)
		.join("\n\n---\n\n");

	const runtimeBlock =
		`Current Time: ${nowIso()}\n` +
		"Route: /\n" +
		"Page: chat\n" +
		`tenantId: ${tenantId}\n` +
		`userId: ${userId}\n` +
		`agentId: ${agentId}\n` +
		`sessionId: ${sessionId}`;

	const taskBlock =
		"Heartbeat run.\n" +
		"Review pending items and decide actions from current state.\n" +
		"If action is needed, use tool_calls.\n" +
		"If no action is needed, return a concise summary.\n\n" +
		`Pending count: ${Array.isArray(pending) ? pending.length : 0}\n` +
		`Completed count: ${Array.isArray(completed) ? completed.length : 0}\n\n` +
		"Heartbeat markdown:\n\n" +
		String(markdown || "").slice(0, 12000);

	const messages = [
		{ role: "system", content: systemPrompt, timestamp: nowIso() },
		...roleHistory.filter((m) => m.role !== "system"),
		{
			role: "user",
			content: `${runtimeBlock}\n\n${taskBlock}`,
			timestamp: nowIso(),
		},
	];

	return { systemPrompt, messages };
}

function normalizeHeartbeatHistory(history) {
	const list = Array.isArray(history) ? history : [];
	return list
		.map((m) => ({
			role: String((m && m.role) || ""),
			content: typeof (m && m.content) === "string" ? m.content : "",
			name: typeof (m && m.name) === "string" ? m.name : undefined,
			tool_call_id:
				typeof (m && m.tool_call_id) === "string"
					? m.tool_call_id
					: undefined,
			tool_calls: Array.isArray(m && m.tool_calls) ? m.tool_calls : undefined,
			timestamp: (m && m.timestamp) || nowIso(),
		}))
		.filter((m) => ["system", "user", "assistant", "tool"].includes(m.role));
}

function cleanHeartbeatText(value) {
	return String(value || "").replace(/\r\n/g, "\n").trim();
}

function parseJsonObjectSafe(rawArgs) {
	if (rawArgs == null) return {};
	if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) return rawArgs;
	if (typeof rawArgs !== "string") return {};

	const text = rawArgs.trim();
	if (!text) return {};

	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed;
		}
		return {};
	} catch (err) {
		void err;
		return {};
	}
}

function buildHeartbeatAssistantNote({ beforePending, afterPending }) {
	const before = Array.isArray(beforePending) ? beforePending : [];
	const after = Array.isArray(afterPending) ? afterPending : [];

	const wantsPong = [...after, ...before].some((item) => {
		const text = sanitizeHeartbeatItemText(item && item.text).toLowerCase();
		return /\bpong\b/.test(text) && /(reply|respond|say|heartbeat)/.test(text);
	});

	if (!before.length) {
		const base = "Heartbeat tick: no pending items in the markdown list.";
		return wantsPong ? `pong\n\n${base}` : base;
	}

	const nextPreview = after
		.slice(0, 3)
		.map((item, idx) => `${idx + 1}. ${sanitizeHeartbeatItemText(item && item.text)}`)
		.filter(Boolean);

	const base =
		`Heartbeat tick: pending items before=${before.length}, after=${after.length}.` +
		(nextPreview.length ? ` Next up:\n${nextPreview.join("\n")}` : "");

	return wantsPong ? `pong\n\n${base}` : base;
}





async function executeSkillTool(skillName, toolName, args, context) {
	const heartbeatHandled = await executeHeartbeatPendingTool(
		toolName,
		args || {},
		context || {},
	);
	if (heartbeatHandled && heartbeatHandled.__handled) {
		return heartbeatHandled.result;
	}

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

const HEARTBEAT_MD_DOC_ID = "system::heartbeat::pending-markdown";
const HEARTBEAT_MD_TEMPLATE =
	"# Heartbeat Pending Items\n\n" +
	"## Pending\n\n" +
	"<!-- Add pending checklist items here -->\n\n" +
	"## Completed\n\n" +
	"<!-- Completed checklist items -->\n";

const HEARTBEAT_BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"];

async function readHeartbeatBootstrapTextFromOpfs() {
	try {
		const nav = typeof self !== "undefined" ? self.navigator : null;
		if (!nav || !nav.storage || typeof nav.storage.getDirectory !== "function") {
			return "";
		}

		const root = await nav.storage.getDirectory();
		const sections = [];

		for (const fileName of HEARTBEAT_BOOTSTRAP_FILES) {
			try {
				const handle = await root.getFileHandle(fileName);
				const file = await handle.getFile();
				const text = cleanHeartbeatText(await file.text());
				if (!text) continue;
				sections.push(`## ${fileName}\n\n${text}`);
			} catch (err) {
				void err;
			}
		}

		return sections.join("\n\n");
	} catch (err) {
		void err;
		return "";
	}
}

async function executeHeartbeatPendingTool(toolName, args, context) {
	void context;

	const name = String(toolName || "").trim();
	if (!name.startsWith("heartbeat_")) return null;

	const db = await openDb();
	const markdown = await loadHeartbeatMarkdown(db);
	const parsed = parseHeartbeatMarkdown(markdown);

	if (name === "heartbeat_add_pending_item") {
		const text = sanitizeHeartbeatItemText(args && args.text);
		if (!text) throw new Error("text is required");

		const description = sanitizeHeartbeatItemText(args && args.description);
		if (!description) throw new Error("description is required");

		const itemId = randomId("hb");
		const priority = String((args && args.priority) || "").trim();

		const suffixParts = [];
		if (priority) suffixParts.push("priority:" + priority);

		const workText = text + " — " + description;

		parsed.pending.push({
			id: itemId,
			text: suffixParts.length
				? workText + " [" + suffixParts.join(", ") + "]"
				: workText,
		});

		const nextMarkdown = renderHeartbeatMarkdown(parsed);
		await saveHeartbeatMarkdown(db, nextMarkdown);

		return {
			__handled: true,
			result: {
				ok: true,
				item: {
					id: itemId,
					text,
					description,
					priority: priority || null,
				},
				pendingCount: parsed.pending.length,
			},
		};
	}

	if (name === "heartbeat_list_pending_items") {
		return {
			__handled: true,
			result: {
				ok: true,
				pending: parsed.pending.map((item) => ({
					id: item.id,
					text: item.text,
				})),
				completedCount: parsed.completed.length,
			},
		};
	}

	if (name === "heartbeat_complete_pending_item") {
		const itemId = String((args && args.itemId) || "").trim();
		if (!itemId) throw new Error("itemId is required");

		const idx = parsed.pending.findIndex((item) => item.id === itemId);
		if (idx < 0) throw new Error("Pending item not found");

		const [item] = parsed.pending.splice(idx, 1);
		parsed.completed.push({
			id: item.id,
			text: item.text + " (completed " + nowIso() + ")",
		});

		const nextMarkdown = renderHeartbeatMarkdown(parsed);
		await saveHeartbeatMarkdown(db, nextMarkdown);

		return {
			__handled: true,
			result: {
				ok: true,
				itemId,
				pendingCount: parsed.pending.length,
				completedCount: parsed.completed.length,
			},
		};
	}

	throw new Error("Unknown heartbeat tool: " + name);
}

async function executeRegisteredToolByName(db, toolName, args, context) {
	const name = String(toolName || "").trim();
	if (!name) throw new Error("tool name is required");

	const matches = await getAllByIndex(db, TOOLS_STORE, "name", name);
	const tool = (matches || []).find((t) => t && t.enabled !== false);
	if (!tool) throw new Error("Unknown tool: " + (toolName || "<missing>"));

	const skill = await getByKey(db, SKILLS_STORE, tool.skillId);
	if (!skill || skill.enabled === false) {
		throw new Error("Tool skill is disabled: " + name);
	}

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

async function loadHeartbeatMarkdown(db) {
	const doc = await getByKey(db, DOCS_STORE, HEARTBEAT_MD_DOC_ID);
	const text = String((doc && doc.text) || "").trim();
	return text || HEARTBEAT_MD_TEMPLATE;
}

async function saveHeartbeatMarkdown(db, markdown) {
	const now = nowIso();
	const existing = await getByKey(db, DOCS_STORE, HEARTBEAT_MD_DOC_ID);

	const tx = db.transaction(DOCS_STORE, "readwrite");
	tx.objectStore(DOCS_STORE).put({
		id: HEARTBEAT_MD_DOC_ID,
		scope: "system::heartbeat",
		title: "Heartbeat Pending Items",
		text: String(markdown || HEARTBEAT_MD_TEMPLATE),
		createdAt: (existing && existing.createdAt) || now,
		updatedAt: now,
	});
	await txDone(tx);
}

function parseHeartbeatMarkdown(markdown) {
	const source = String(markdown || "").replace(/\r\n/g, "\n");
	const pendingHeading = "\n## Pending\n";
	const completedHeading = "\n## Completed\n";

	const withHeading = source.startsWith("#")
		? source
		: HEARTBEAT_MD_TEMPLATE + "\n" + source;

	const pendingIdx = withHeading.indexOf("## Pending");
	const completedIdx = withHeading.indexOf("## Completed");

	if (pendingIdx < 0 || completedIdx < 0 || completedIdx < pendingIdx) {
		return {
			pending: [],
			completed: [],
		};
	}

	const pendingStart = withHeading.indexOf("\n", pendingIdx) + 1;
	const completedStart = withHeading.indexOf("\n", completedIdx) + 1;

	const pendingBody = withHeading.slice(pendingStart, completedIdx).trim();
	const completedBody = withHeading.slice(completedStart).trim();

	const pending = pendingBody
		.split("\n")
		.map((line) => parseChecklistLine(line))
		.filter((item) => item && item.checked === false)
		.map((item) => ({ id: item.id, text: item.text }));

	const completed = completedBody
		.split("\n")
		.map((line) => parseChecklistLine(line))
		.filter((item) => item && item.checked === true)
		.map((item) => ({ id: item.id, text: item.text }));

	void pendingHeading;
	void completedHeading;

	return { pending, completed };
}

function renderHeartbeatMarkdown(parsed) {
	const pendingLines = parsed.pending.length
		? parsed.pending.map((item) => toChecklistLine(item, false)).join("\n")
		: "<!-- Add pending checklist items here -->";

	const completedLines = parsed.completed.length
		? parsed.completed.map((item) => toChecklistLine(item, true)).join("\n")
		: "<!-- Completed checklist items -->";

	return (
		"# Heartbeat Pending Items\n\n" +
		"## Pending\n\n" +
		pendingLines +
		"\n\n" +
		"## Completed\n\n" +
		completedLines +
		"\n"
	);
}

function parseChecklistLine(line) {
	const text = String(line || "").trim();
	if (!text.startsWith("- [")) return null;

	const match = text.match(/^- \[( |x|X)\] \(([^)]+)\)\s*(.*)$/);
	if (!match) return null;

	return {
		checked: String(match[1]).toLowerCase() === "x",
		id: String(match[2] || "").trim(),
		text: sanitizeHeartbeatItemText(match[3]),
	};
}

function toChecklistLine(item, checked) {
	const mark = checked ? "x" : " ";
	const id = String((item && item.id) || "").trim();
	const text = sanitizeHeartbeatItemText(item && item.text);
	return "- [" + mark + "] (" + id + ") " + text;
}

function sanitizeHeartbeatItemText(value) {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim();
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
	const hasStores = REQUIRED_STORES.every((storeName) =>
		db.objectStoreNames.contains(storeName),
	);
	if (!hasStores) return false;

	try {
		const tx = db.transaction(REQUIRED_STORES, "readonly");
		const docs = tx.objectStore(DOCS_STORE);
		const chunks = tx.objectStore(CHUNKS_STORE);
		const skills = tx.objectStore(SKILLS_STORE);
		const tools = tx.objectStore(TOOLS_STORE);

		const hasDocsIndexes =
			docs.indexNames.contains("scope") &&
			docs.indexNames.contains("sourceUrl");
		const hasChunksIndexes =
			chunks.indexNames.contains("scope") &&
			chunks.indexNames.contains("docId");
		const hasSkillsIndexes =
			skills.indexNames.contains("name") &&
			skills.indexNames.contains("enabled");
		const hasToolsIndexes =
			tools.indexNames.contains("skillId") &&
			tools.indexNames.contains("name") &&
			tools.indexNames.contains("enabled");

		return (
			hasDocsIndexes &&
			hasChunksIndexes &&
			hasSkillsIndexes &&
			hasToolsIndexes
		);
	} catch (err) {
		void err;
		return false;
	}
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
		message.includes("One of the specified object stores was not found") ||
		message.includes("The specified index was not found") ||
		message.includes("Failed to execute 'index' on 'IDBObjectStore'")
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
