(function initWebagentRuntimeCompaction(globalScope) {
  "use strict";

  const RuntimeUtils = globalScope.WebagentRuntimeUtils;
  const RuntimeMessages = globalScope.WebagentRuntimeMessages;

  if (!RuntimeUtils) {
    throw new Error("WebagentRuntimeUtils is required before loading WebagentRuntimeCompaction");
  }
  if (!RuntimeMessages) {
    throw new Error("WebagentRuntimeMessages is required before loading WebagentRuntimeCompaction");
  }

  class RuntimeCompaction {
    static DEFAULT_CONTEXT_WINDOW_TOKENS = 64_000;
    static DEFAULT_TARGET_RATIO = 0.7;
    static DEFAULT_MIN_TAIL_MESSAGES = 12;
    static DEFAULT_SUMMARY_MAX_LINES = 8;
    static DEFAULT_HIGHLIGHT_MAX_CHARS = 180;

    static buildCompactionSummary(
      droppedMessages,
      {
        maxSummaryLines = RuntimeCompaction.DEFAULT_SUMMARY_MAX_LINES,
        maxHighlightChars = RuntimeCompaction.DEFAULT_HIGHLIGHT_MAX_CHARS,
        title = "[Compaction] Earlier session content was compacted.",
      } = {},
    ) {
      const dropped = RuntimeMessages.normalizeMessages(droppedMessages);
      if (!dropped.length) return null;

      const lines = dropped
        .slice(-RuntimeUtils.toInt(maxSummaryLines, RuntimeCompaction.DEFAULT_SUMMARY_MAX_LINES))
        .map((message, idx) => {
          const role = String(message.role || "assistant").toUpperCase();
          const text = String(message.content || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, RuntimeUtils.toInt(maxHighlightChars, RuntimeCompaction.DEFAULT_HIGHLIGHT_MAX_CHARS));

          return `${idx + 1}. ${role}: ${text}`;
        });

      return [
        title,
        `Dropped messages: ${dropped.length}`,
        lines.length ? `Highlights:\n${lines.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    static compactMessagesByTokens(
      messages,
      {
        contextWindowTokens = RuntimeCompaction.DEFAULT_CONTEXT_WINDOW_TOKENS,
        targetRatio = RuntimeCompaction.DEFAULT_TARGET_RATIO,
        targetTokens = null,
        minTailMessages = RuntimeCompaction.DEFAULT_MIN_TAIL_MESSAGES,
        summaryRole = "assistant",
        maxSummaryLines = RuntimeCompaction.DEFAULT_SUMMARY_MAX_LINES,
        maxHighlightChars = RuntimeCompaction.DEFAULT_HIGHLIGHT_MAX_CHARS,
      } = {},
    ) {
      const threshold = Math.max(
        1,
        RuntimeUtils.toInt(contextWindowTokens, RuntimeCompaction.DEFAULT_CONTEXT_WINDOW_TOKENS),
      );

      const target = Math.max(
        1,
        targetTokens == null
          ? RuntimeUtils.toInt(Math.floor(threshold * Number(targetRatio || RuntimeCompaction.DEFAULT_TARGET_RATIO)), 1)
          : RuntimeUtils.toInt(targetTokens, 1),
      );

      const minTail = Math.max(
        1,
        RuntimeUtils.toInt(minTailMessages, RuntimeCompaction.DEFAULT_MIN_TAIL_MESSAGES),
      );

      const list = RuntimeMessages.normalizeMessages(messages);
      const beforeTokens = RuntimeMessages.estimateMessagesTokens(list);

      if (beforeTokens <= threshold) {
        return {
          messages: list,
          report: {
            triggered: false,
            strategy: "none",
            thresholdTokens: threshold,
            targetTokens: target,
            estimatedTokensBefore: beforeTokens,
            estimatedTokensAfter: beforeTokens,
            droppedMessages: 0,
            summary: null,
          },
        };
      }

      const tail = [];
      let tailTokens = 0;

      for (let i = list.length - 1; i >= 0; i -= 1) {
        const candidate = list[i];
        const candidateTokens = RuntimeMessages.estimateMessageTokens(candidate);
        const canAddByBudget = tailTokens + candidateTokens <= target;

        if (tail.length < minTail || canAddByBudget) {
          tail.unshift(candidate);
          tailTokens += candidateTokens;
        } else {
          break;
        }
      }

      const droppedCount = Math.max(0, list.length - tail.length);
      const dropped = droppedCount > 0 ? list.slice(0, droppedCount) : [];
      const summaryText = RuntimeCompaction.buildCompactionSummary(dropped, {
        maxSummaryLines,
        maxHighlightChars,
      });

      let compacted = tail;
      if (summaryText) {
        compacted = [
          RuntimeMessages.sanitizeMessage({
            role: summaryRole,
            content: summaryText,
            timestamp: RuntimeUtils.nowIso(),
          }),
          ...tail,
        ];
      }

      let afterTokens = RuntimeMessages.estimateMessagesTokens(compacted);
      while (afterTokens > target && compacted.length > 1) {
        compacted = compacted.slice(1);
        afterTokens = RuntimeMessages.estimateMessagesTokens(compacted);
      }

      return {
        messages: compacted,
        report: {
          triggered: true,
          strategy: "token-compaction",
          thresholdTokens: threshold,
          targetTokens: target,
          estimatedTokensBefore: beforeTokens,
          estimatedTokensAfter: afterTokens,
          droppedMessages: droppedCount,
          summary: summaryText,
        },
      };
    }

    static appendMessageToSession(snapshot, message, options = {}) {
      const baseSnapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
      const currentMessages = RuntimeMessages.normalizeMessages(baseSnapshot.messages);
      const nextMessages = RuntimeMessages.appendMessage(currentMessages, message, {
        dedupe: options.dedupe !== false,
      });

      const compaction = RuntimeCompaction.compactMessagesByTokens(nextMessages, options);
      const normalizedIncoming = RuntimeMessages.sanitizeMessage(message);

      const appended = compaction.messages.some(
        (m) =>
          m.role === normalizedIncoming.role &&
          m.content === normalizedIncoming.content &&
          m.timestamp === normalizedIncoming.timestamp,
      );

      return {
        snapshot: {
          ...baseSnapshot,
          updatedAt: RuntimeUtils.nowIso(),
          messages: compaction.messages,
          telemetry: {
            ...(baseSnapshot.telemetry && typeof baseSnapshot.telemetry === "object"
              ? baseSnapshot.telemetry
              : { usage: null, compaction: null }),
            compaction: compaction.report,
          },
        },
        report: compaction.report,
        appended,
      };
    }
  }

  globalScope.WebagentRuntimeCompaction = RuntimeCompaction;
})(typeof globalThis !== "undefined" ? globalThis : self);