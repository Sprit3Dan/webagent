(function initWebagentRuntimeContextBuilder(globalScope) {
  "use strict";

  const RuntimeUtils = globalScope.WebagentRuntimeUtils;
  const RuntimeMessages = globalScope.WebagentRuntimeMessages;
  const RuntimeStorage = globalScope.WebagentRuntimeStorage;

  if (!RuntimeUtils) {
    throw new Error("WebagentRuntimeUtils is required before loading WebagentRuntimeContextBuilder");
  }
  if (!RuntimeMessages) {
    throw new Error("WebagentRuntimeMessages is required before loading WebagentRuntimeContextBuilder");
  }
  if (!RuntimeStorage) {
    throw new Error("WebagentRuntimeStorage is required before loading WebagentRuntimeContextBuilder");
  }

  class RuntimeContextBuilder {
    static DEFAULT_BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"];

    static normalizeBootstrapFileList(fileNames) {
      const input = Array.isArray(fileNames) && fileNames.length
        ? fileNames
        : RuntimeContextBuilder.DEFAULT_BOOTSTRAP_FILES;

      return input
        .map((name) => String(name || "").trim())
        .filter(Boolean);
    }

    // Strict WebFS-only bootstrap loading: no in-code defaults or auto-seeding.
    static async loadBootstrapFromWebFs(fileNames = RuntimeContextBuilder.DEFAULT_BOOTSTRAP_FILES) {
      const names = RuntimeContextBuilder.normalizeBootstrapFileList(fileNames);
      const files = [];

      for (const fileName of names) {
        // eslint-disable-next-line no-await-in-loop
        const raw = await RuntimeStorage.readOpfsTextFile(fileName);
        const content = RuntimeUtils.cleanText(raw);

        if (!content) {
          throw new Error(`Bootstrap file is empty in WebFS: ${fileName}`);
        }

        files.push({
          fileName,
          title: fileName,
          content,
          section: `## ${fileName}\n\n${content}`,
        });
      }

      return {
        files,
        text: files.map((f) => f.section).join("\n\n"),
      };
    }

    static async ensureBootstrapFilesPresent(fileNames = RuntimeContextBuilder.DEFAULT_BOOTSTRAP_FILES) {
      await RuntimeContextBuilder.loadBootstrapFromWebFs(fileNames);
      return true;
    }

    static buildIdentitySection({
      tenantId = "tenant-dev",
      userId = "user-001",
      sessionId = "chat-001",
      environment = "browser",
    } = {}) {
      const ua = globalScope.navigator?.userAgent || "unknown";
      const lang = globalScope.navigator?.language || "unknown";

      return `# webagent

You are webagent, a frontend-first assistant with service-worker tools.

## Runtime
- Environment: ${environment}
- User Agent: ${ua}
- Language: ${lang}

## Scope
- sessionId: ${sessionId}`;
    }

    static buildRuntimeMetadataBlock({
      tenantId,
      userId,
      sessionId,
      route = "/",
      page = "chat",
      metadata = {},
    } = {}) {
      const lines = [
        `Current Time: ${RuntimeUtils.nowIso()}`,
        `sessionId: ${sessionId || ""}`,
      ];

      if (metadata && typeof metadata === "object") {
        for (const key of Object.keys(metadata).sort()) {
          const value = metadata[key];
          if (value == null) continue;

          const rendered = typeof value === "string"
            ? value.trim()
            : JSON.stringify(value);

          if (!rendered) continue;
          lines.push(`${key}: ${rendered}`);
        }
      }

      return lines.join("\n");
    }

    static buildSystemPrompt({
      identitySection = "",
      bootstrapText = "",
      memoryText = "",
      skillsText = "",
      extraSections = [],
    } = {}) {
      const parts = [
        RuntimeUtils.cleanText(identitySection),
        RuntimeUtils.cleanText(bootstrapText),
        RuntimeUtils.cleanText(memoryText) ? `# Memory\n\n${RuntimeUtils.cleanText(memoryText)}` : "",
        RuntimeUtils.cleanText(skillsText) ? `# Skills\n\n${RuntimeUtils.cleanText(skillsText)}` : "",
        ...(Array.isArray(extraSections) ? extraSections.map((s) => RuntimeUtils.cleanText(s)) : []),
      ].filter(Boolean);

      return parts.join("\n\n---\n\n");
    }

    static mergeRuntimeWithUserContent(runtimeBlock, userText) {
      const safeRuntime = RuntimeUtils.cleanText(runtimeBlock);
      const safeUser = String(userText || "");
      return safeRuntime ? `${safeRuntime}\n\n${safeUser}` : safeUser;
    }

    static async buildContextForLlm({
      history = [],
      currentMessage = "",
      tenantId = "tenant-dev",
      userId = "user-001",
      sessionId = "chat-001",
      route = "/",
      page = "chat",
      metadata = {},
      memoryText = "",
      skillsText = "",
      extraSections = [],
      environment = "browser",
      bootstrapFiles = RuntimeContextBuilder.DEFAULT_BOOTSTRAP_FILES,
    } = {}) {
      const bootstrap = await RuntimeContextBuilder.loadBootstrapFromWebFs(bootstrapFiles);

      const identity = RuntimeContextBuilder.buildIdentitySection({
        tenantId,
        userId,
        sessionId,
        environment,
      });

      const systemPrompt = RuntimeContextBuilder.buildSystemPrompt({
        identitySection: identity,
        bootstrapText: bootstrap.text,
        memoryText,
        skillsText,
        extraSections,
      });

      const runtimeBlock = RuntimeContextBuilder.buildRuntimeMetadataBlock({
        tenantId,
        userId,
        sessionId,
        route,
        page,
        metadata,
      });

      const normalizedHistory = RuntimeMessages
        .normalizeMessages(history)
        .filter((m) => m.role !== "system");

      const messages = [
        { role: "system", content: systemPrompt, timestamp: RuntimeUtils.nowIso() },
        ...normalizedHistory,
        {
          role: "user",
          content: RuntimeContextBuilder.mergeRuntimeWithUserContent(runtimeBlock, currentMessage),
          timestamp: RuntimeUtils.nowIso(),
        },
      ];

      return {
        systemPrompt,
        runtimeBlock,
        bootstrapFiles: bootstrap.files.map((f) => f.fileName),
        messages,
      };
    }
  }

  globalScope.WebagentRuntimeContextBuilder = RuntimeContextBuilder;
})(typeof globalThis !== "undefined" ? globalThis : self);