(function initWebagentRuntimeDbRegistry(globalScope) {
  "use strict";

  class RuntimeDbRegistry {
    static DB_NAME = "webagent-skills-db";
    static DB_VERSION = 3;

    static DOCS_STORE = "docs";
    static CHUNKS_STORE = "chunks";
    static SKILLS_STORE = "skills";
    static TOOLS_STORE = "tools";

    static STORES = Object.freeze({
      docs: RuntimeDbRegistry.DOCS_STORE,
      chunks: RuntimeDbRegistry.CHUNKS_STORE,
      skills: RuntimeDbRegistry.SKILLS_STORE,
      tools: RuntimeDbRegistry.TOOLS_STORE,
    });

    static REQUIRED_STORES = Object.freeze([
      RuntimeDbRegistry.DOCS_STORE,
      RuntimeDbRegistry.CHUNKS_STORE,
      RuntimeDbRegistry.SKILLS_STORE,
      RuntimeDbRegistry.TOOLS_STORE,
    ]);

    static _dbPromise = null;
    static _toolsInlineMigrated = false;

    static assertIndexedDbAvailable() {
      if (typeof globalScope.indexedDB === "undefined") {
        throw new Error("IndexedDB is not available in this runtime");
      }
    }

    static reqToPromise(req) {
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
      });
    }

    static txDone(tx) {
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
        tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
      });
    }

    static hasRequiredStores(db) {
      const hasStores = RuntimeDbRegistry.REQUIRED_STORES.every((storeName) =>
        db.objectStoreNames.contains(storeName),
      );
      if (!hasStores) return false;

      try {
        const tx = db.transaction(RuntimeDbRegistry.REQUIRED_STORES, "readonly");

        const docs = tx.objectStore(RuntimeDbRegistry.DOCS_STORE);
        const chunks = tx.objectStore(RuntimeDbRegistry.CHUNKS_STORE);
        const skills = tx.objectStore(RuntimeDbRegistry.SKILLS_STORE);
        const tools = tx.objectStore(RuntimeDbRegistry.TOOLS_STORE);

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

        return hasDocsIndexes && hasChunksIndexes && hasSkillsIndexes && hasToolsIndexes;
      } catch {
        return false;
      }
    }

    static createStoreSchema(db) {
      if (!db.objectStoreNames.contains(RuntimeDbRegistry.DOCS_STORE)) {
        const docs = db.createObjectStore(RuntimeDbRegistry.DOCS_STORE, { keyPath: "id" });
        docs.createIndex("scope", "scope", { unique: false });
        docs.createIndex("sourceUrl", "sourceUrl", { unique: false });
      }

      if (!db.objectStoreNames.contains(RuntimeDbRegistry.CHUNKS_STORE)) {
        const chunks = db.createObjectStore(RuntimeDbRegistry.CHUNKS_STORE, { keyPath: "id" });
        chunks.createIndex("scope", "scope", { unique: false });
        chunks.createIndex("docId", "docId", { unique: false });
      }

      if (!db.objectStoreNames.contains(RuntimeDbRegistry.SKILLS_STORE)) {
        const skills = db.createObjectStore(RuntimeDbRegistry.SKILLS_STORE, { keyPath: "id" });
        skills.createIndex("name", "name", { unique: false });
        skills.createIndex("enabled", "enabled", { unique: false });
      }

      if (!db.objectStoreNames.contains(RuntimeDbRegistry.TOOLS_STORE)) {
        const tools = db.createObjectStore(RuntimeDbRegistry.TOOLS_STORE, { keyPath: "id" });
        tools.createIndex("skillId", "skillId", { unique: false });
        tools.createIndex("name", "name", { unique: false });
        tools.createIndex("enabled", "enabled", { unique: false });
      }
    }

    static deleteDatabase(dbName = RuntimeDbRegistry.DB_NAME) {
      RuntimeDbRegistry.assertIndexedDbAvailable();
      return new Promise((resolve, reject) => {
        const req = globalScope.indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error || new Error("Failed to delete IndexedDB"));
        req.onblocked = () => reject(new Error("IndexedDB delete blocked by another open connection"));
      });
    }

    static async recreateDatabase() {
      RuntimeDbRegistry._dbPromise = null;
      try {
        await RuntimeDbRegistry.deleteDatabase(RuntimeDbRegistry.DB_NAME);
      } catch {
        // best effort
      }
      return RuntimeDbRegistry.openDb();
    }

    static openDb() {
      RuntimeDbRegistry.assertIndexedDbAvailable();
      if (RuntimeDbRegistry._dbPromise) return RuntimeDbRegistry._dbPromise;

      RuntimeDbRegistry._dbPromise = new Promise((resolve, reject) => {
        const req = globalScope.indexedDB.open(
          RuntimeDbRegistry.DB_NAME,
          RuntimeDbRegistry.DB_VERSION,
        );

        req.onupgradeneeded = () => {
          const db = req.result;
          RuntimeDbRegistry.createStoreSchema(db);
        };

        req.onsuccess = () => {
          const db = req.result;

          db.onversionchange = () => {
            try {
              db.close();
            } finally {
              RuntimeDbRegistry._dbPromise = null;
            }
          };

          db.onclose = () => {
            RuntimeDbRegistry._dbPromise = null;
          };

          if (!RuntimeDbRegistry.hasRequiredStores(db)) {
            try {
              db.close();
            } finally {
              RuntimeDbRegistry._dbPromise = null;
            }
            RuntimeDbRegistry.recreateDatabase().then(resolve).catch(reject);
            return;
          }

          RuntimeDbRegistry.migrateLegacyToolRuntimeRecords(db)
            .then(() => resolve(db))
            .catch(() => resolve(db));
        };

        req.onerror = () => {
          RuntimeDbRegistry._dbPromise = null;
          reject(req.error || new Error("Failed to open IndexedDB"));
        };
      });

      return RuntimeDbRegistry._dbPromise;
    }

    static async migrateLegacyToolRuntimeRecords(db) {
      if (RuntimeDbRegistry._toolsInlineMigrated) return;
      RuntimeDbRegistry._toolsInlineMigrated = true;

      const tx = db.transaction(
        [RuntimeDbRegistry.TOOLS_STORE, RuntimeDbRegistry.DOCS_STORE],
        "readwrite",
      );
      const toolsStore = tx.objectStore(RuntimeDbRegistry.TOOLS_STORE);
      const docsStore = tx.objectStore(RuntimeDbRegistry.DOCS_STORE);

      const allTools = await RuntimeDbRegistry.reqToPromise(toolsStore.getAll());
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
          next.updatedAt = new Date().toISOString();
          toolsStore.put(next);
        }
      }

      const allDocs = await RuntimeDbRegistry.reqToPromise(docsStore.getAll());
      for (const doc of allDocs || []) {
        const docId = String((doc && doc.id) || "");
        if (docId.includes("::doc::tool::")) {
          docsStore.delete(docId);
        }
      }

      await RuntimeDbRegistry.txDone(tx);
    }

    static isClosingDbError(err) {
      const message = String((err && err.message) || "");
      return (
        message.includes("database connection is closing") ||
        message.includes("connection is closing") ||
        message.includes("close pending") ||
        message.includes("The database connection is closing")
      );
    }

    static isMissingStoreError(err) {
      const message = String((err && err.message) || "");
      return (
        message.includes("object stores was not found") ||
        message.includes("object store was not found") ||
        message.includes("One of the specified object stores was not found") ||
        message.includes("The specified index was not found") ||
        message.includes("Failed to execute 'index' on 'IDBObjectStore'")
      );
    }

    static async withDbReadRetry(readOp) {
      try {
        return await readOp();
      } catch (err) {
        if (!RuntimeDbRegistry.isClosingDbError(err) && !RuntimeDbRegistry.isMissingStoreError(err)) {
          throw err;
        }

        RuntimeDbRegistry._dbPromise = null;

        if (RuntimeDbRegistry.isMissingStoreError(err)) {
          const recreated = await RuntimeDbRegistry.recreateDatabase();
          return readOp(recreated);
        }

        const reopened = await RuntimeDbRegistry.openDb();
        return readOp(reopened);
      }
    }

    static async getAllByStore(db, storeName) {
      return RuntimeDbRegistry.withDbReadRetry(async (maybeDb) => {
        const activeDb = maybeDb || db || (await RuntimeDbRegistry.openDb());
        const tx = activeDb.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).getAll();
        const out = await RuntimeDbRegistry.reqToPromise(req);
        await RuntimeDbRegistry.txDone(tx);
        return out || [];
      });
    }

    static async getByKey(db, storeName, key) {
      return RuntimeDbRegistry.withDbReadRetry(async (maybeDb) => {
        const activeDb = maybeDb || db || (await RuntimeDbRegistry.openDb());
        const tx = activeDb.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(String(key));
        const out = await RuntimeDbRegistry.reqToPromise(req);
        await RuntimeDbRegistry.txDone(tx);
        return out;
      });
    }

    static async getAllByIndex(db, storeName, indexName, value) {
      return RuntimeDbRegistry.withDbReadRetry(async (maybeDb) => {
        const activeDb = maybeDb || db || (await RuntimeDbRegistry.openDb());
        const tx = activeDb.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const idx = store.index(indexName);
        const req = idx.getAll(IDBKeyRange.only(value));
        const out = await RuntimeDbRegistry.reqToPromise(req);
        await RuntimeDbRegistry.txDone(tx);
        return out || [];
      });
    }

    static async findDocBySource(db, scope, sourceUrl) {
      if (!sourceUrl) return null;
      const docs = await RuntimeDbRegistry.getAllByIndex(
        db,
        RuntimeDbRegistry.DOCS_STORE,
        "sourceUrl",
        sourceUrl,
      );
      return docs.find((d) => d && d.scope === scope) || null;
    }

    static async deleteChunksByDoc(chunkStore, docId) {
      const idx = chunkStore.index("docId");
      const all = await RuntimeDbRegistry.reqToPromise(idx.getAll(IDBKeyRange.only(docId)));
      for (const c of all || []) {
        if (c && c.id != null) {
          chunkStore.delete(c.id);
        }
      }
    }
  }

  globalScope.WebagentRuntimeDbRegistry = RuntimeDbRegistry;
})(typeof globalThis !== "undefined" ? globalThis : self);