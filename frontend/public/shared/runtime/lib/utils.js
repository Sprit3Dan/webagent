(function initWebagentRuntimeUtils(globalScope) {
  "use strict";

  class RuntimeUtils {
    static nowIso() {
      return new Date().toISOString();
    }

    static toInt(value, fallback = 0) {
      const n = Number(value);
      if (!Number.isFinite(n)) return Math.max(0, Math.floor(Number(fallback) || 0));
      return Math.max(0, Math.floor(n));
    }

    static normalizeText(value) {
      return String(value ?? "")
        .replace(/\r\n/g, "\n")
        .trim();
    }

    static cleanText(value) {
      return RuntimeUtils.normalizeText(value);
    }

    static tokenize(text) {
      return RuntimeUtils.normalizeText(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean);
    }

    static randomId(prefix = "id") {
      const p = String(prefix || "id");
      if (globalScope.crypto && typeof globalScope.crypto.randomUUID === "function") {
        return `${p}_${globalScope.crypto.randomUUID()}`;
      }
      return `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    static deepClone(value, fallback = null) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return fallback;
      }
    }

    static safeJsonStringify(value, fallback = "{}", pretty = false) {
      try {
        return JSON.stringify(value, null, pretty ? 2 : 0);
      } catch {
        return fallback;
      }
    }

    static repairLikelyTruncatedJsonObject(input) {
      let text = String(input ?? "").trim();
      if (!text.startsWith("{")) return text;

      let inString = false;
      let escaped = false;
      let openCurly = 0;
      let openSquare = 0;

      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        if (escaped) {
          escaped = false;
          continue;
        }

        if (ch === "\\") {
          escaped = true;
          continue;
        }

        if (ch === "\"") {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (ch === "{") openCurly += 1;
        else if (ch === "}") openCurly = Math.max(0, openCurly - 1);
        else if (ch === "[") openSquare += 1;
        else if (ch === "]") openSquare = Math.max(0, openSquare - 1);
      }

      if (inString) text += "\"";
      if (openSquare > 0) text += "]".repeat(openSquare);
      if (openCurly > 0) text += "}".repeat(openCurly);

      return text.replace(/,\s*([}\]])/g, "$1");
    }

    static parseJsonObjectSafe(rawArgs, fallback = {}) {
      if (rawArgs == null) return fallback;
      if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) return rawArgs;
      if (typeof rawArgs !== "string") return fallback;

      const text = rawArgs.trim();
      if (!text) return fallback;

      const repaired = RuntimeUtils.repairLikelyTruncatedJsonObject(text);
      const candidates = repaired !== text ? [text, repaired] : [text];

      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
          }
        } catch {
          // try next candidate
        }
      }

      return fallback;
    }

    static withTimeout(promise, timeoutMs = 20_000, label = "request") {
      const ms = Math.max(0, RuntimeUtils.toInt(timeoutMs, 20_000));

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${label} timed out`));
        }, ms);

        Promise.resolve(promise)
          .then((value) => {
            clearTimeout(timer);
            resolve(value);
          })
          .catch((err) => {
            clearTimeout(timer);
            reject(err);
          });
      });
    }
  }

  globalScope.WebagentRuntimeUtils = RuntimeUtils;
})(typeof globalThis !== "undefined" ? globalThis : self);