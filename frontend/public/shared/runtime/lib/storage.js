(function initWebagentRuntimeStorage(globalScope) {
  "use strict";

  const RuntimeUtils = globalScope.WebagentRuntimeUtils;
  const RuntimeMessages = globalScope.WebagentRuntimeMessages;
  const RuntimeCompaction = globalScope.WebagentRuntimeCompaction;

  if (!RuntimeUtils) {
    throw new Error("WebagentRuntimeUtils is required before loading WebagentRuntimeStorage");
  }
  if (!RuntimeMessages) {
    throw new Error("WebagentRuntimeMessages is required before loading WebagentRuntimeStorage");
  }
  if (!RuntimeCompaction) {
    throw new Error("WebagentRuntimeCompaction is required before loading WebagentRuntimeStorage");
  }

  class RuntimeStorage {
    static DEFAULT_SNAPSHOT = Object.freeze({
      messages: [],
      telemetry: { usage: null, compaction: null },
    });

    static ensureNavigatorStorage() {
      const nav = globalScope.navigator;
      if (!nav || !nav.storage || typeof nav.storage.getDirectory !== "function") {
        throw new Error("OPFS is not supported in this runtime");
      }
      return nav.storage;
    }

    static async getOpfsRoot() {
      const storage = RuntimeStorage.ensureNavigatorStorage();
      return storage.getDirectory();
    }

    static async readOpfsTextFile(fileName) {
      const root = await RuntimeStorage.getOpfsRoot();
      const handle = await root.getFileHandle(String(fileName));
      const file = await handle.getFile();
      return file.text();
    }

    static async writeOpfsTextFile(fileName, text) {
      const root = await RuntimeStorage.getOpfsRoot();
      const handle = await root.getFileHandle(String(fileName), { create: true });
      const writer = await handle.createWritable();
      await writer.write(String(text ?? ""));
      await writer.close();
    }

    static async removeOpfsFile(fileName) {
      const root = await RuntimeStorage.getOpfsRoot();
      try {
        await root.removeEntry(String(fileName));
      } catch {
        // no-op when missing
      }
    }

    static async readOpfsJsonFile(fileName, fallback = null) {
      try {
        const text = await RuntimeStorage.readOpfsTextFile(fileName);
        return JSON.parse(String(text || "null"));
      } catch {
        return fallback;
      }
    }

    static async writeOpfsJsonFile(fileName, value, options = {}) {
      const pretty = options?.pretty !== false;
      const text = pretty
        ? JSON.stringify(value, null, 2)
        : JSON.stringify(value);
      await RuntimeStorage.writeOpfsTextFile(fileName, text);
    }

    static normalizeSnapshot(rawSnapshot) {
      const raw = rawSnapshot && typeof rawSnapshot === "object" ? rawSnapshot : {};
      return {
        ...raw,
        messages: RuntimeMessages.normalizeMessages(raw.messages),
        telemetry:
          raw.telemetry && typeof raw.telemetry === "object"
            ? raw.telemetry
            : { usage: null, compaction: null },
      };
    }

    static async readSnapshotFromOpfs(snapshotFileName) {
      const parsed = await RuntimeStorage.readOpfsJsonFile(snapshotFileName, null);
      if (!parsed) return RuntimeStorage.normalizeSnapshot(RuntimeStorage.DEFAULT_SNAPSHOT);
      return RuntimeStorage.normalizeSnapshot(parsed);
    }

    static async writeSnapshotToOpfs(snapshotFileName, snapshot) {
      const normalized = RuntimeStorage.normalizeSnapshot(snapshot);
      await RuntimeStorage.writeOpfsJsonFile(snapshotFileName, normalized, { pretty: true });
    }

    static buildSnapshotFileName({
      tenantId = "tenant-dev",
      agentId = "agent-main",
      sessionId = "chat-001",
    } = {}) {
      const tenant = String(tenantId || "tenant-dev").trim() || "tenant-dev";
      const agent = String(agentId || "agent-main").trim() || "agent-main";
      const session = String(sessionId || "chat-001").trim() || "chat-001";
      return `${tenant}__${agent}__${session}.json`;
    }

    static async appendMessageToSnapshot(
      snapshotFileName,
      message,
      {
        contextWindowTokens = RuntimeCompaction.DEFAULT_CONTEXT_WINDOW_TOKENS,
        targetRatio = RuntimeCompaction.DEFAULT_TARGET_RATIO,
        minTailMessages = RuntimeCompaction.DEFAULT_MIN_TAIL_MESSAGES,
        dedupe = true,
        summaryRole = "assistant",
        maxSummaryLines = RuntimeCompaction.DEFAULT_SUMMARY_MAX_LINES,
        maxHighlightChars = RuntimeCompaction.DEFAULT_HIGHLIGHT_MAX_CHARS,
      } = {},
    ) {
      const snapshot = await RuntimeStorage.readSnapshotFromOpfs(snapshotFileName);
      const update = RuntimeCompaction.appendMessageToSession(snapshot, message, {
        contextWindowTokens,
        targetRatio,
        minTailMessages,
        dedupe,
        summaryRole,
        maxSummaryLines,
        maxHighlightChars,
      });

      await RuntimeStorage.writeSnapshotToOpfs(snapshotFileName, update.snapshot);
      return update;
    }

    static async ensureContextBootstrapFilesInOpfs(fileNames) {
      const names = Array.isArray(fileNames) ? fileNames : [];
      const created = [];

      for (const fileName of names) {
        const key = String(fileName || "").trim();
        if (!key) continue;

        try {
          // eslint-disable-next-line no-await-in-loop
          const existing = await RuntimeStorage.readOpfsTextFile(key);
          if (typeof existing === "string" && existing.trim().length > 0) continue;
          throw new Error(`Bootstrap file is empty in WebFS: ${key}`);
        } catch {
          throw new Error(`Bootstrap file missing in WebFS: ${key}`);
        }
      }

      return created;
    }

    static async loadContextBootstrapFromOpfs(fileNames) {
      const names = Array.isArray(fileNames) ? fileNames : [];
      const files = [];

      for (const fileName of names) {
        const key = String(fileName || "").trim();
        if (!key) continue;

        // eslint-disable-next-line no-await-in-loop
        const raw = await RuntimeStorage.readOpfsTextFile(key);
        const content = RuntimeUtils.cleanText(raw);

        if (!content) {
          throw new Error(`Bootstrap file is empty in WebFS: ${key}`);
        }

        files.push({
          fileName: key,
          title: key,
          content,
          section: `## ${key}\n\n${content}`,
        });
      }

      return {
        files,
        text: files.map((f) => f.section).join("\n\n"),
      };
    }
  }

  globalScope.WebagentRuntimeStorage = RuntimeStorage;
})(typeof globalThis !== "undefined" ? globalThis : self);