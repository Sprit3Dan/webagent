const SW_VERSION = "3.0.0";



const CACHE_NAME = "webagent-skill-cache-v3";
const ACTION_EXECUTOR_JS = "js_code";

const DEFAULT_SKILL_ID = "registry::default";
const DEFAULT_SKILL_NAME = "sw_unified_knowledge_runtime";



importScripts("/shared/runtimeShared.js");

const runtimeShared = self.WebagentRuntimeShared;
if (!runtimeShared) {
	throw new Error("Shared runtime module failed to load in service worker");
}

const runtimeDb = runtimeShared.RuntimeDbRegistry;
if (!runtimeDb) {
	throw new Error("Shared DB registry failed to load in service worker");
}

const DB_NAME = runtimeDb.DB_NAME;
const DB_VERSION = runtimeDb.DB_VERSION;
const DOCS_STORE = runtimeDb.DOCS_STORE;
const CHUNKS_STORE = runtimeDb.CHUNKS_STORE;
const SKILLS_STORE = runtimeDb.SKILLS_STORE;
const TOOLS_STORE = runtimeDb.TOOLS_STORE;
const REQUIRED_STORES = runtimeDb.REQUIRED_STORES;

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

	await appendHeartbeatAssistantNoteToSnapshot({
		payload,
		heartbeatResult,
	});

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

const runtimeHeartbeat = runtimeShared.RuntimeHeartbeat;

async function appendHeartbeatAssistantNoteToSnapshot({ payload, heartbeatResult }) {
	try {
		const update = await runtimeHeartbeat.appendAssistantNoteToSnapshot({
			payload,
			assistantNote: heartbeatResult && heartbeatResult.assistantNote,
			generatedAt: heartbeatResult && heartbeatResult.generatedAt,
		});

		let report = update && update.report ? update.report : null;

		const toolMessages = Array.isArray(heartbeatResult && heartbeatResult.toolMessages)
			? heartbeatResult.toolMessages
			: [];

		if (toolMessages.length) {
			const storage = runtimeShared.RuntimeStorage;
			const fileName = runtimeHeartbeat.getSnapshotFileNameFromPayload(payload);
			let snapshot = await storage.readSnapshotFromOpfs(fileName);

			for (const toolMessage of toolMessages) {
				const sanitized = runtimeShared.sanitizeMessage({
					role: "tool",
					name: String((toolMessage && toolMessage.name) || "unknown"),
					tool_call_id: String((toolMessage && toolMessage.tool_call_id) || ""),
					content: String((toolMessage && toolMessage.content) || "null"),
					timestamp: String((toolMessage && toolMessage.timestamp) || nowIso()),
				});

				const next = runtimeHeartbeat.buildSessionUpdate(
					snapshot,
					sanitized,
					payload,
				);

				snapshot = (next && next.snapshot) || snapshot;
				if (next && next.report) report = next.report;
			}

			await storage.writeSnapshotToOpfs(fileName, snapshot);
		}

		if (report && report.triggered) {
			await triggerCompactionContextPersistence(payload, report);
		}
	} catch (err) {
		void err;
	}
}

async function triggerCompactionContextPersistence(payload, report) {
	if (!report || report.triggered !== true) return;

	try {
		const decision = await reviewCompactionPersistenceWithLlm({ payload, report });
		const toolCalls = Array.isArray(decision && decision.toolCalls) ? decision.toolCalls : [];
		if (!toolCalls.length) return;

		const db = await openDb();
		for (const call of toolCalls) {
			const fn = call && call.function ? call.function : {};
			const toolName = String((fn && fn.name) || "").trim();
			if (!toolName.startsWith("opfs_")) continue;

			const args = runtimeShared.RuntimeUtils.parseJsonObjectSafe(fn && fn.arguments, {});
			// eslint-disable-next-line no-await-in-loop
			await executeRegisteredToolByName(db, toolName, args, { source: "heartbeat_compaction" });
		}
	} catch (err) {
		void err;
		try {
			const db = await openDb();
			const summary = String(report.summary || "").trim();
			const threshold = runtimeShared.toInt(report.thresholdTokens, 0);
			const before = runtimeShared.toInt(report.estimatedTokensBefore, 0);
			const after = runtimeShared.toInt(report.estimatedTokensAfter, 0);
			const dropped = runtimeShared.toInt(report.droppedMessages, 0);

			const fallbackText =
				`\n\n## Compaction Notes (${nowIso()})\n` +
				`- Triggered during heartbeat persistence\n` +
				`- Tokens: ${before} -> ${after} (threshold ${threshold})\n` +
				`- Dropped messages: ${dropped}\n` +
				(summary ? `\n${summary}\n` : "\n");

			await executeRegisteredToolByName(
				db,
				"opfs_edit_file",
				{ path: "USER.md", append: fallbackText },
				{ source: "heartbeat_compaction_fallback" },
			);
		} catch (fallbackErr) {
			void fallbackErr;
		}
	}
}

async function reviewCompactionPersistenceWithLlm({ payload, report }) {
	try {
		const requestBody = runtimeHeartbeat.buildCompactionPersistenceRequestPayload({
			payload,
			report,
		});

		const res = await fetch("/api/agent/respond", {
			method: "POST",
			headers: runtimeHeartbeat.buildAgentRequestHeaders(payload),
			credentials: "same-origin",
			body: JSON.stringify(requestBody),
		});

		if (!res.ok) return { toolCalls: [] };

		const data = await res.json();
		const message = (data && data.message) || {};
		const toolCalls = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
		return { toolCalls };
	} catch (err) {
		void err;
		return { toolCalls: [] };
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

		const executedTools = Array.isArray(decision && decision.executedTools)
			? decision.executedTools.filter(
				(item) => item && String((item && item.name) || "").trim(),
			)
			: [];

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
			assistantNote = runtimeHeartbeat.buildAssistantNote({
				beforePending: pendingBefore,
				afterPending: pendingAfter,
			});
		}

		if (executedTools.length) {
			const names = executedTools.map((t) => t.name).join(", ");
			assistantNote += `\n\nHeartbeat actions executed: ${names}`;
		}

		const toolMessages = executedTools.map((tool) =>
			runtimeShared.sanitizeMessage({
				role: "tool",
				name: String((tool && tool.name) || "unknown"),
				tool_call_id: String((tool && tool.toolCallId) || ""),
				content: String(
					(tool && tool.content) ||
						(() => {
							try {
								return JSON.stringify((tool && tool.result) ?? null);
							} catch (err) {
								void err;
								return "null";
							}
						})(),
				),
				timestamp: nowIso(),
			}),
		);

		return {
			assistantNote,
			localAssistantNote: assistantNote,
			llmAssistantNote: String((decision && decision.assistantNote) || "").trim() || null,
			pendingCount: pendingAfter.length,
			completedCount: completedAfter.length,
			executedToolCount: executedTools.length,
			toolMessages,
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
		const registryTools = await getAllByStore(db, TOOLS_STORE);
		const plannerTools = runtimeHeartbeat.buildPlannerToolsFromRegistryTools(registryTools);

		if (!plannerTools.length) {
			return { assistantNote: null, toolCalls: [], executedTools: [] };
		}

		const context = await runtimeHeartbeat.buildHeartbeatContext({
			payload,
			markdown,
			pending,
			completed,
		});

		let workingMessages = runtimeShared.normalizeMessages(context.messages || []);
		let assistantNote = null;
		let lastToolCalls = [];
		const executedTools = [];
		const maxRounds = Math.max(
			1,
			Math.min(6, runtimeShared.toInt(payload && payload.maxToolRounds, 4)),
		);

		for (let round = 0; round < maxRounds; round += 1) {
			const requestBody = runtimeHeartbeat.buildHeartbeatDecisionRequestPayload({
				payload,
				contextMessages: workingMessages,
				plannerTools,
			});

			const res = await fetch("/api/agent/respond", {
				method: "POST",
				headers: runtimeHeartbeat.buildAgentRequestHeaders(payload),
				credentials: "same-origin",
				body: JSON.stringify(requestBody),
			});

			if (!res.ok) break;

			const data = await res.json();
			const message = (data && data.message) || {};
			const content = String((message && message.content) || "").trim();
			if (content) assistantNote = content;

			const toolCalls = Array.isArray(message && message.tool_calls)
				? message.tool_calls
				: [];
			lastToolCalls = toolCalls;

			const assistantMessage = runtimeShared.sanitizeMessage({
				role: "assistant",
				content: String((message && message.content) || ""),
				reasoning:
					typeof (message && message.reasoning) === "string"
						? message.reasoning
						: undefined,
				tool_calls: toolCalls.length ? toolCalls : undefined,
				timestamp: nowIso(),
			});

			workingMessages = runtimeShared.normalizeMessages([
				...workingMessages,
				assistantMessage,
			]);

			if (!toolCalls.length) break;

			for (const call of toolCalls) {
				const fn = call && call.function ? call.function : {};
				const toolName = String((fn && fn.name) || "").trim();
				if (!toolName) continue;

				const args = runtimeShared.RuntimeUtils.parseJsonObjectSafe(
					fn && fn.arguments,
					{},
				);

				let result;
				const handled = await executeHeartbeatPendingTool(
					toolName,
					args,
					{ source: "heartbeat_push", round },
				);

				if (handled && handled.__handled) {
					result = handled.result;
				} else {
					result = await executeRegisteredToolByName(
						db,
						toolName,
						args,
						{ source: "heartbeat_push", round },
					);
				}

				const callId = String((call && call.id) || "").trim() || "";
				let toolContent = "null";
				try {
					toolContent = JSON.stringify(result ?? null);
				} catch (jsonErr) {
					void jsonErr;
				}

				executedTools.push({
					toolCallId: callId,
					name: toolName,
					result,
					content: toolContent,
				});

				const toolMessage = runtimeShared.sanitizeMessage({
					role: "tool",
					name: toolName,
					tool_call_id: callId,
					content: toolContent,
					timestamp: nowIso(),
				});

				workingMessages = runtimeShared.normalizeMessages([
					...workingMessages,
					toolMessage,
				]);
			}
		}

		return {
			assistantNote,
			toolCalls: lastToolCalls,
			executedTools,
		};
	} catch (err) {
		void err;
		return { assistantNote: null, toolCalls: [], executedTools: [] };
	}
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

		nowIso: runtimeShared.nowIso,
		randomId: runtimeShared.randomId,
		normalizeText: runtimeShared.normalizeText,
		tokenize: runtimeShared.tokenize,
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

const nowIso = runtimeShared.nowIso;

const randomId = runtimeShared.randomId;

const normalizeText = runtimeShared.normalizeText;

const tokenize = runtimeShared.tokenize;

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

// runtimeDb is initialized at module bootstrap from shared runtime.

function openDb() {
	return runtimeShared.openDb();
}

const txDone = runtimeShared.dbTxDone;
const reqToPromise = runtimeShared.dbReqToPromise;

async function getAllByStore(db, storeName) {
	return runtimeShared.dbGetAllByStore(db, storeName);
}

async function getByKey(db, storeName, key) {
	return runtimeShared.dbGetByKey(db, storeName, key);
}

async function getAllByIndex(db, storeName, indexName, value) {
	return runtimeShared.dbGetAllByIndex(db, storeName, indexName, value);
}

async function findDocBySource(db, scope, sourceUrl) {
	return runtimeShared.dbFindDocBySource(db, scope, sourceUrl);
}

async function deleteChunksByDoc(chunkStore, docId) {
	return runtimeShared.dbDeleteChunksByDoc(chunkStore, docId);
}
