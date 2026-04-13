(function initWebagentRuntimeHeartbeat(globalScope) {
  "use strict";

  const RuntimeUtils = globalScope.WebagentRuntimeUtils;
  const RuntimeMessages = globalScope.WebagentRuntimeMessages;
  const RuntimeCompaction = globalScope.WebagentRuntimeCompaction;
  const RuntimeStorage = globalScope.WebagentRuntimeStorage;
  const RuntimeContextBuilder = globalScope.WebagentRuntimeContextBuilder;

  if (!RuntimeUtils) {
    throw new Error("WebagentRuntimeUtils is required before loading WebagentRuntimeHeartbeat");
  }
  if (!RuntimeMessages) {
    throw new Error("WebagentRuntimeMessages is required before loading WebagentRuntimeHeartbeat");
  }
  if (!RuntimeCompaction) {
    throw new Error("WebagentRuntimeCompaction is required before loading WebagentRuntimeHeartbeat");
  }
  if (!RuntimeStorage) {
    throw new Error("WebagentRuntimeStorage is required before loading WebagentRuntimeHeartbeat");
  }
  if (!RuntimeContextBuilder) {
    throw new Error("WebagentRuntimeContextBuilder is required before loading WebagentRuntimeHeartbeat");
  }

  class RuntimeHeartbeat {
    static DEFAULT_CONTEXT_WINDOW_TOKENS = RuntimeCompaction.DEFAULT_CONTEXT_WINDOW_TOKENS;
    static DEFAULT_TARGET_RATIO = RuntimeCompaction.DEFAULT_TARGET_RATIO;
    static DEFAULT_MIN_TAIL_MESSAGES = RuntimeCompaction.DEFAULT_MIN_TAIL_MESSAGES;
    static DEFAULT_MODEL = "nemotron-30b";
    static DEFAULT_ENVIRONMENT = "service-worker";
    static HEARTBEAT_DOC_TITLE = "Heartbeat Pending Markdown";
    static ALLOWED_CONTEXT_PATHS = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"];

    static getScopeFromPayload(payload) {
      return {
        tenantId: String(payload?.tenantId || "tenant-dev"),
        userId: String(payload?.userId || "user-001"),
        sessionId: String(payload?.sessionId || "chat-001"),
      };
    }

    static getSnapshotFileNameFromPayload(payload) {
      const scope = RuntimeHeartbeat.getScopeFromPayload(payload);
      return RuntimeStorage.buildSnapshotFileName(scope);
    }

    static normalizeCount(value) {
      return RuntimeUtils.toInt(value, 0);
    }

    static sanitizeHeartbeatItemText(value) {
      return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    }

    static buildHeartbeatTaskBlock({ markdown = "", pending = [], completed = [] } = {}) {
      const pendingCount = Array.isArray(pending) ? pending.length : 0;
      const completedCount = Array.isArray(completed) ? completed.length : 0;

      return (
        "Heartbeat run.\n" +
        "Review pending items and decide actions from current state.\n" +
        "If action is needed, use tool_calls.\n" +
        "If no action is needed, return a concise summary.\n\n" +
        `Pending count: ${pendingCount}\n` +
        `Completed count: ${completedCount}\n\n` +
        "Heartbeat markdown:\n\n" +
        String(markdown || "").slice(0, 12000)
      );
    }

    static buildHeartbeatSkillsText() {
      return (
        "Heartbeat runtime loop.\n" +
        "If action is needed, emit tool_calls with correct arguments.\n" +
        "If no action is needed, return a concise summary.\n" +
        "Never invent tool results; rely on tool outputs as source of truth."
      );
    }

    static async buildHeartbeatContext({
      payload = {},
      markdown = "",
      pending = [],
      completed = [],
      history = null,
      route = "/",
      page = "chat",
    } = {}) {
      const scope = RuntimeHeartbeat.getScopeFromPayload(payload);
      const normalizedHistory = RuntimeMessages.normalizeMessages(history || payload?.history || []);

      const taskBlock = RuntimeHeartbeat.buildHeartbeatTaskBlock({
        markdown,
        pending,
        completed,
      });

      return RuntimeContextBuilder.buildContextForLlm({
        history: normalizedHistory,
        currentMessage: taskBlock,
        tenantId: scope.tenantId,
        userId: scope.userId,
        sessionId: scope.sessionId,
        route,
        page,
        environment: RuntimeHeartbeat.DEFAULT_ENVIRONMENT,
        memoryText: `## ${RuntimeHeartbeat.HEARTBEAT_DOC_TITLE}\n\n${String(markdown || "").slice(0, 12000)}`,
        skillsText: RuntimeHeartbeat.buildHeartbeatSkillsText(),
      });
    }

    static buildAssistantNote({ beforePending = [], afterPending = [] } = {}) {
      const before = Array.isArray(beforePending) ? beforePending : [];
      const after = Array.isArray(afterPending) ? afterPending : [];

      const wantsPong = [...after, ...before].some((item) => {
        const text = RuntimeHeartbeat.sanitizeHeartbeatItemText(item?.text).toLowerCase();
        return /\bpong\b/.test(text) && /(reply|respond|say|heartbeat)/.test(text);
      });

      if (!before.length) {
        const base = "Heartbeat tick: no pending items in the markdown list.";
        return wantsPong ? `pong\n\n${base}` : base;
      }

      const nextPreview = after
        .slice(0, 3)
        .map((item, idx) => `${idx + 1}. ${RuntimeHeartbeat.sanitizeHeartbeatItemText(item?.text)}`)
        .filter(Boolean);

      const base =
        `Heartbeat tick: pending items before=${before.length}, after=${after.length}.` +
        (nextPreview.length ? ` Next up:\n${nextPreview.join("\n")}` : "");

      return wantsPong ? `pong\n\n${base}` : base;
    }

    static buildSessionUpdate(snapshot, nextMessage, payload = {}, options = {}) {
      const contextWindowTokens = Math.max(
        1,
        Number(payload?.contextWindowTokens || RuntimeHeartbeat.DEFAULT_CONTEXT_WINDOW_TOKENS) ||
          RuntimeHeartbeat.DEFAULT_CONTEXT_WINDOW_TOKENS,
      );

      return RuntimeCompaction.appendMessageToSession(snapshot, nextMessage, {
        contextWindowTokens,
        targetRatio:
          options.targetRatio == null
            ? RuntimeHeartbeat.DEFAULT_TARGET_RATIO
            : Number(options.targetRatio),
        minTailMessages:
          options.minTailMessages == null
            ? RuntimeHeartbeat.DEFAULT_MIN_TAIL_MESSAGES
            : RuntimeUtils.toInt(options.minTailMessages, RuntimeHeartbeat.DEFAULT_MIN_TAIL_MESSAGES),
        dedupe: options.dedupe !== false,
        summaryRole: options.summaryRole || "assistant",
      });
    }

    static async appendAssistantNoteToSnapshot({
      payload = {},
      assistantNote = "",
      generatedAt = null,
      options = {},
    } = {}) {
      const content = String(assistantNote || "").trim();
      if (!content) {
        return {
          snapshot: null,
          report: null,
          appended: false,
          skipped: true,
          reason: "empty_note",
        };
      }

      const fileName = RuntimeHeartbeat.getSnapshotFileNameFromPayload(payload);
      const snapshot = await RuntimeStorage.readSnapshotFromOpfs(fileName);
      const nextMessage = RuntimeMessages.sanitizeMessage({
        role: "assistant",
        content,
        timestamp: String(generatedAt || RuntimeUtils.nowIso()),
      });

      const update = RuntimeHeartbeat.buildSessionUpdate(snapshot, nextMessage, payload, options);
      await RuntimeStorage.writeSnapshotToOpfs(fileName, update.snapshot);

      return {
        ...update,
        fileName,
        skipped: false,
      };
    }

    static buildPlannerToolsFromRegistryTools(registryTools) {
      const tools = Array.isArray(registryTools) ? registryTools : [];
      return tools
        .filter((tool) => tool && tool.enabled !== false && String(tool.name || "").trim())
        .map((tool) => ({
          type: "function",
          function: {
            name: String(tool.name || "").trim(),
            description: "Runtime tool from backend-registered registry",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: true,
            },
          },
        }));
    }

    static buildHeartbeatDecisionRequestPayload({
      payload = {},
      contextMessages = [],
      plannerTools = [],
      model = null,
      temperature = 0.2,
    } = {}) {
      const scope = RuntimeHeartbeat.getScopeFromPayload(payload);

      return {
        tenantId: scope.tenantId,
        userId: scope.userId,
        sessionId: scope.sessionId,
        model: String(model || payload?.model || RuntimeHeartbeat.DEFAULT_MODEL),
        temperature: Number(temperature),
        stream: false,
        messages: RuntimeMessages.normalizeMessages(contextMessages),
        tools: Array.isArray(plannerTools) ? plannerTools : [],
      };
    }

    static buildCompactionPersistencePrompt(report = {}) {
      const threshold = RuntimeHeartbeat.normalizeCount(report?.thresholdTokens);
      const before = RuntimeHeartbeat.normalizeCount(report?.estimatedTokensBefore);
      const after = RuntimeHeartbeat.normalizeCount(report?.estimatedTokensAfter);
      const dropped = RuntimeHeartbeat.normalizeCount(report?.droppedMessages);
      const summary = String(report?.summary || "").slice(0, 6000);

      return (
        "Heartbeat compaction was triggered.\n" +
        "Persist important long-term guidance into context files.\n" +
        "Prefer appending concise factual notes to USER.md.\n" +
        "Use only opfs_* tools with allowed paths.\n" +
        "Do not rewrite personality unless explicitly required.\n\n" +
        `thresholdTokens: ${threshold}\n` +
        `estimatedTokensBefore: ${before}\n` +
        `estimatedTokensAfter: ${after}\n` +
        `droppedMessages: ${dropped}\n\n` +
        `summary:\n${summary}`
      );
    }

    static buildCompactionPersistenceTools() {
      const pathSchema = {
        type: "string",
        enum: RuntimeHeartbeat.ALLOWED_CONTEXT_PATHS.slice(),
      };

      return [
        {
          type: "function",
          function: {
            name: "opfs_read_file",
            description: "Read one allowed OPFS context file",
            parameters: {
              type: "object",
              properties: { path: pathSchema },
              required: ["path"],
              additionalProperties: false,
            },
          },
        },
        {
          type: "function",
          function: {
            name: "opfs_edit_file",
            description: "Edit one allowed OPFS context file via append, prepend, or find/replace",
            parameters: {
              type: "object",
              properties: {
                path: pathSchema,
                append: { type: "string" },
                prepend: { type: "string" },
                find: { type: "string" },
                replace: { type: "string" },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
        },
        {
          type: "function",
          function: {
            name: "opfs_write_file",
            description: "Write full content to one allowed OPFS context file",
            parameters: {
              type: "object",
              properties: {
                path: pathSchema,
                content: { type: "string" },
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
        },
      ];
    }

    static buildCompactionPersistenceRequestPayload({
      payload = {},
      report = {},
      model = null,
      temperature = 0.1,
    } = {}) {
      const scope = RuntimeHeartbeat.getScopeFromPayload(payload);

      return {
        tenantId: scope.tenantId,
        userId: scope.userId,
        sessionId: scope.sessionId,
        model: String(model || payload?.model || RuntimeHeartbeat.DEFAULT_MODEL),
        temperature: Number(temperature),
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "You are a context-maintenance operator. Persist compacted knowledge safely using opfs_* tools.",
            timestamp: RuntimeUtils.nowIso(),
          },
          {
            role: "user",
            content: RuntimeHeartbeat.buildCompactionPersistencePrompt(report),
            timestamp: RuntimeUtils.nowIso(),
          },
        ],
        tools: RuntimeHeartbeat.buildCompactionPersistenceTools(),
      };
    }

    static buildAgentRequestHeaders(payload = {}) {
      const scope = RuntimeHeartbeat.getScopeFromPayload(payload);
      const headers = {
        "content-type": "application/json",
        "x-tenant-id": scope.tenantId,
        "x-user-id": scope.userId,
      };

      const agentId = String(payload?.agentId || "").trim();
      if (agentId) {
        headers["x-agent-id"] = agentId;
      }

      return headers;
    }
  }

  globalScope.WebagentRuntimeHeartbeat = RuntimeHeartbeat;
})(typeof globalThis !== "undefined" ? globalThis : self);
