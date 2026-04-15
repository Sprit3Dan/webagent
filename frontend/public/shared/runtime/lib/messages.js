(function initWebagentRuntimeMessages(globalScope) {
  "use strict";

  const RuntimeUtils = globalScope.WebagentRuntimeUtils;
  if (!RuntimeUtils) {
    throw new Error("WebagentRuntimeUtils is required before loading WebagentRuntimeMessages");
  }

  class RuntimeMessageModel {
    static VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);

    static sanitizeMessage(input, fallbackRole = "assistant") {
      const requestedRole = String((input && input.role) || fallbackRole || "assistant");
      const role = RuntimeMessageModel.VALID_ROLES.has(requestedRole)
        ? requestedRole
        : String(fallbackRole || "assistant");

      return {
        role,
        content: String((input && input.content) ?? ""),
        timestamp: String((input && input.timestamp) || RuntimeUtils.nowIso()),
        name: typeof (input && input.name) === "string" ? input.name : undefined,
        tool_call_id:
          typeof (input && input.tool_call_id) === "string"
            ? input.tool_call_id
            : undefined,
        tool_calls: Array.isArray(input && input.tool_calls)
          ? input.tool_calls
          : undefined,
        reasoning: typeof (input && input.reasoning) === "string"
          ? input.reasoning
          : undefined,
        message_type: typeof (input && input.message_type) === "string"
          ? input.message_type
          : undefined,
        prompt_memories: Array.isArray(input && input.prompt_memories)
          ? input.prompt_memories
          : undefined,
        prompt_memory_meta:
          input && input.prompt_memory_meta && typeof input.prompt_memory_meta === "object"
            ? input.prompt_memory_meta
            : undefined,
      };
    }

    static normalizeMessages(input, fallbackRole = "assistant") {
      const list = Array.isArray(input) ? input : [];
      return list
        .map((m) => RuntimeMessageModel.sanitizeMessage(m, fallbackRole))
        .filter((m) => RuntimeMessageModel.VALID_ROLES.has(m.role));
    }

    static makeUserMessage(content, timestamp = RuntimeUtils.nowIso()) {
      return RuntimeMessageModel.sanitizeMessage({
        role: "user",
        content: String(content ?? ""),
        timestamp,
      });
    }

    static estimateMessageTokens(message) {
      const normalized = RuntimeMessageModel.sanitizeMessage(message);
      return RuntimeUtils.tokenize(normalized.content).length;
    }

    static estimateMessagesTokens(messages) {
      const list = RuntimeMessageModel.normalizeMessages(messages);
      let total = 0;
      for (const message of list) {
        total += RuntimeMessageModel.estimateMessageTokens(message);
      }
      return total;
    }

    static appendMessage(messages, nextMessage, { dedupe = true } = {}) {
      const base = RuntimeMessageModel.normalizeMessages(messages);
      const candidate = RuntimeMessageModel.sanitizeMessage(nextMessage);

      if (!dedupe || base.length === 0) {
        return [...base, candidate];
      }

      const last = base[base.length - 1];
      const isDuplicate =
        last.role === candidate.role &&
        last.content === candidate.content &&
        last.timestamp === candidate.timestamp;

      return isDuplicate ? base : [...base, candidate];
    }
  }

  globalScope.WebagentRuntimeMessages = RuntimeMessageModel;
})(typeof globalThis !== "undefined" ? globalThis : self);