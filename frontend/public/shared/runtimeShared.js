(function bootstrapWebagentRuntimeShared(globalScope) {
  "use strict";

  var MODULE_PATHS = [
    "/shared/runtime/lib/utils.js",
    "/shared/runtime/lib/messages.js",
    "/shared/runtime/lib/compaction.js",
    "/shared/runtime/lib/db/registry.js",
    "/shared/runtime/lib/storage.js",
    "/shared/runtime/lib/swClient.js",
    "/shared/runtime/lib/contextBuilder.js",
    "/shared/runtime/lib/heartbeat.js",
  ];

  function loadInWorker(paths) {
    if (typeof globalScope.importScripts !== "function") return false;
    globalScope.importScripts.apply(globalScope, paths);
    return true;
  }

  function loadInWindow(paths) {
    if (typeof XMLHttpRequest !== "function") {
      throw new Error("Runtime bootstrap requires XMLHttpRequest in window context");
    }

    for (var i = 0; i < paths.length; i += 1) {
      var url = paths[i];
      var req = new XMLHttpRequest();
      req.open("GET", url, false); // intentional sync bootstrap
      req.send(null);

      if (req.status < 200 || req.status >= 300) {
        throw new Error("Failed to load shared runtime module: " + url + " (" + req.status + ")");
      }

      var source = String(req.responseText || "");
      if (!source.trim()) {
        throw new Error("Shared runtime module is empty: " + url);
      }

      // Execute in global scope so each module can attach its class singleton.
      (0, eval)(source);
    }

    return true;
  }

  function ensureModulesLoaded() {
    if (loadInWorker(MODULE_PATHS)) return;

    loadInWindow(MODULE_PATHS);
  }

  function assertRuntimeClass(name) {
    var ref = globalScope[name];
    if (!ref) {
      throw new Error("Shared runtime class missing after bootstrap: " + name);
    }
    return ref;
  }

  ensureModulesLoaded();

  var RuntimeUtils = assertRuntimeClass("WebagentRuntimeUtils");
  var RuntimeMessages = assertRuntimeClass("WebagentRuntimeMessages");
  var RuntimeCompaction = assertRuntimeClass("WebagentRuntimeCompaction");
  var RuntimeDbRegistry = assertRuntimeClass("WebagentRuntimeDbRegistry");
  var RuntimeStorage = assertRuntimeClass("WebagentRuntimeStorage");
  var RuntimeServiceWorkerClient = assertRuntimeClass("WebagentRuntimeServiceWorkerClient");
  var RuntimeContextBuilder = assertRuntimeClass("WebagentRuntimeContextBuilder");
  var RuntimeHeartbeat = assertRuntimeClass("WebagentRuntimeHeartbeat");

  var api = {
    RuntimeUtils: RuntimeUtils,
    RuntimeMessageModel: RuntimeMessages,
    RuntimeCompaction: RuntimeCompaction,
    RuntimeDbRegistry: RuntimeDbRegistry,
    RuntimeStorage: RuntimeStorage,
    RuntimeServiceWorkerClient: RuntimeServiceWorkerClient,
    RuntimeContextBuilder: RuntimeContextBuilder,
    RuntimeHeartbeat: RuntimeHeartbeat,

    nowIso: RuntimeUtils.nowIso,
    toInt: RuntimeUtils.toInt,
    randomId: RuntimeUtils.randomId,
    normalizeText: RuntimeUtils.normalizeText,
    cleanText: RuntimeUtils.cleanText,
    tokenize: RuntimeUtils.tokenize,
    repairLikelyTruncatedJsonObject: RuntimeUtils.repairLikelyTruncatedJsonObject,
    parseJsonObjectSafe: RuntimeUtils.parseJsonObjectSafe,
    withTimeout: RuntimeUtils.withTimeout,

    sanitizeMessage: RuntimeMessages.sanitizeMessage,
    normalizeMessages: RuntimeMessages.normalizeMessages,
    estimateMessageTokens: RuntimeMessages.estimateMessageTokens,
    estimateMessagesTokens: RuntimeMessages.estimateMessagesTokens,

    compactMessagesByTokens: RuntimeCompaction.compactMessagesByTokens,
    appendMessageToSession: RuntimeCompaction.appendMessageToSession,

    getOpfsRoot: RuntimeStorage.getOpfsRoot,
    readOpfsTextFile: RuntimeStorage.readOpfsTextFile,
    writeOpfsTextFile: RuntimeStorage.writeOpfsTextFile,
    readOpfsJsonFile: RuntimeStorage.readOpfsJsonFile,
    writeOpfsJsonFile: RuntimeStorage.writeOpfsJsonFile,
    readSnapshotFromOpfs: RuntimeStorage.readSnapshotFromOpfs,
    writeSnapshotToOpfs: RuntimeStorage.writeSnapshotToOpfs,
    buildSnapshotFileName: RuntimeStorage.buildSnapshotFileName,

    openDb: RuntimeDbRegistry.openDb,
    dbReqToPromise: RuntimeDbRegistry.reqToPromise,
    dbTxDone: RuntimeDbRegistry.txDone,
    dbGetAllByStore: RuntimeDbRegistry.getAllByStore,
    dbGetByKey: RuntimeDbRegistry.getByKey,
    dbGetAllByIndex: RuntimeDbRegistry.getAllByIndex,
    dbFindDocBySource: RuntimeDbRegistry.findDocBySource,
    dbDeleteChunksByDoc: RuntimeDbRegistry.deleteChunksByDoc,

    ensureServiceWorkerReady: RuntimeServiceWorkerClient.ensureServiceWorkerReady,
    sendToServiceWorker: RuntimeServiceWorkerClient.send,

    buildIdentitySection: RuntimeContextBuilder.buildIdentitySection,
    buildRuntimeMetadataBlock: RuntimeContextBuilder.buildRuntimeMetadataBlock,
    buildSystemPrompt: RuntimeContextBuilder.buildSystemPrompt,
    mergeRuntimeWithUserContent: RuntimeContextBuilder.mergeRuntimeWithUserContent,
    ensureContextBootstrapFilesInOpfs: RuntimeContextBuilder.ensureBootstrapFilesPresent,
    loadContextBootstrapFromOpfs: RuntimeContextBuilder.loadBootstrapFromWebFs,
    buildContextForLlm: RuntimeContextBuilder.buildContextForLlm,

    constants: {
      DEFAULT_CONTEXT_WINDOW_TOKENS: RuntimeCompaction.DEFAULT_CONTEXT_WINDOW_TOKENS,
      DEFAULT_TARGET_RATIO: RuntimeCompaction.DEFAULT_TARGET_RATIO,
      DEFAULT_MIN_TAIL_MESSAGES: RuntimeCompaction.DEFAULT_MIN_TAIL_MESSAGES,
      DEFAULT_SUMMARY_MAX_LINES: RuntimeCompaction.DEFAULT_SUMMARY_MAX_LINES,
      DEFAULT_HIGHLIGHT_MAX_CHARS: RuntimeCompaction.DEFAULT_HIGHLIGHT_MAX_CHARS,
      DEFAULT_SW_TIMEOUT_MS: RuntimeServiceWorkerClient.DEFAULT_TIMEOUT_MS,
      DEFAULT_CONTEXT_FILES: [].concat(RuntimeContextBuilder.DEFAULT_BOOTSTRAP_FILES || []),
    },

    // Intentionally empty by policy: bootstrap context must come strictly from WebFS files.
    defaults: {
      bootstrapContent: {},
    },
  };

  globalScope.WebagentRuntimeShared = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : self);