(function initWebagentRuntimeServiceWorkerClient(globalScope) {
  "use strict";

  const RuntimeUtils = globalScope.WebagentRuntimeUtils;
  if (!RuntimeUtils) {
    throw new Error("WebagentRuntimeUtils is required before loading WebagentRuntimeServiceWorkerClient");
  }

  class RuntimeServiceWorkerClient {
    static DEFAULT_SW_PATH = "/sw.js";
    static DEFAULT_TIMEOUT_MS = 20_000;

    static assertSupported() {
      if (!globalScope.navigator || !("serviceWorker" in globalScope.navigator)) {
        throw new Error("Service Worker is not supported in this runtime");
      }
    }

    static async ensureServiceWorkerReady(swPath = RuntimeServiceWorkerClient.DEFAULT_SW_PATH) {
      RuntimeServiceWorkerClient.assertSupported();

      const path = String(swPath || RuntimeServiceWorkerClient.DEFAULT_SW_PATH);
      let registration = await globalScope.navigator.serviceWorker.getRegistration();

      if (!registration) {
        registration = await globalScope.navigator.serviceWorker.register(path);
      }

      await globalScope.navigator.serviceWorker.ready;

      const worker =
        globalScope.navigator.serviceWorker.controller ||
        registration.active ||
        registration.waiting ||
        registration.installing;

      if (!worker) {
        throw new Error("Service worker is not active yet. Reload and retry.");
      }

      return worker;
    }

    static async send(
      payload,
      {
        timeoutMs = RuntimeServiceWorkerClient.DEFAULT_TIMEOUT_MS,
        swPath = RuntimeServiceWorkerClient.DEFAULT_SW_PATH,
        label = null,
      } = {},
    ) {
      const worker = await RuntimeServiceWorkerClient.ensureServiceWorkerReady(swPath);
      const requestPayload = payload && typeof payload === "object" ? payload : {};
      const timeout = Math.max(
        0,
        RuntimeUtils.toInt(timeoutMs, RuntimeServiceWorkerClient.DEFAULT_TIMEOUT_MS),
      );
      const timeoutLabel = String(label || requestPayload.type || "service-worker call");

      const task = new Promise((resolve, reject) => {
        const channel = new MessageChannel();

        channel.port1.onmessage = (event) => {
          const data = event?.data || {};
          if (data?.ok === false) {
            reject(new Error(data.error || "Service worker request failed"));
            return;
          }
          resolve(data);
        };

        try {
          worker.postMessage(requestPayload, [channel.port2]);
        } catch (err) {
          reject(err);
        }
      });

      return RuntimeUtils.withTimeout(task, timeout, timeoutLabel);
    }

    static async ping({
      swPath = RuntimeServiceWorkerClient.DEFAULT_SW_PATH,
      timeoutMs = 8_000,
    } = {}) {
      const id = RuntimeUtils.randomId("ping");
      const payload = await RuntimeServiceWorkerClient.send(
        { type: "skill.ping", id },
        { swPath, timeoutMs, label: "service-worker ping" },
      );

      return {
        ok: true,
        type: payload?.type || "skill.pong",
        version: payload?.version || "unknown",
        now: payload?.now || RuntimeUtils.nowIso(),
      };
    }
  }

  globalScope.WebagentRuntimeServiceWorkerClient = RuntimeServiceWorkerClient;
})(typeof globalThis !== "undefined" ? globalThis : self);