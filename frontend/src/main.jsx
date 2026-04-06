import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import {
  WEBGPU_EMBEDDINGS_DEFAULTS,
  benchmarkEmbeddingLatency,
  getWebGpuAdapterName,
  isWebGpuSupported,
} from "./lib/webgpuEmbeddings";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

async function registerWebPushSubscription(registration) {
  try {
    console.info("[push] requesting config...");
    const configRes = await fetch("/api/push/config", {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      mode: "same-origin",
    });

    if (!configRes.ok) {
      console.warn("[push] config request failed", configRes.status);
      return;
    }

    const config = await configRes.json();
    console.info("[push] config loaded", {
      enabled: !!config?.enabled,
      hasVapidPublicKey: !!config?.vapidPublicKey,
    });

    if (!config?.enabled || !config?.vapidPublicKey) {
      console.info("[push] disabled or missing VAPID public key");
      return;
    }

    if (!("PushManager" in window)) {
      console.warn("[push] PushManager is not available in this browser");
      return;
    }

    if (Notification.permission === "denied") {
      console.warn("[push] notification permission is denied");
      return;
    }

    const permission =
      Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();

    console.info("[push] notification permission", permission);

    if (permission !== "granted") return;

    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(String(config.vapidPublicKey)),
      }));

    console.info("[push] subscription ready", {
      reusedExisting: !!existing,
      endpoint: subscription?.endpoint || null,
    });

    const subscribeRes = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      mode: "same-origin",
      body: JSON.stringify({
        subscription: subscription?.toJSON ? subscription.toJSON() : subscription,
      }),
    });

    if (!subscribeRes.ok) {
      console.warn("[push] backend subscribe failed", subscribeRes.status);
      return;
    }

    const payload = await subscribeRes.json().catch(() => null);
    console.info("[push] backend subscribe ok", payload);
  } catch (err) {
    console.error("[push] web push subscription failed", err);
  }
}



function shouldRunWebGpuEmbeddingDiagnostics() {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = String(params.get("wgpuEmbedDiag") || "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  } catch {
    return false;
  }
}

async function runStartupWebGpuEmbeddingDiagnostics() {
  if (!shouldRunWebGpuEmbeddingDiagnostics()) return;

  console.groupCollapsed("[embed:webgpu] startup diagnostics");
  try {
    console.info("[embed:webgpu] model defaults", WEBGPU_EMBEDDINGS_DEFAULTS);

    if (!isWebGpuSupported()) {
      console.warn("[embed:webgpu] WebGPU is not supported in this browser/runtime");
      return;
    }

    const adapterName = await getWebGpuAdapterName();
    console.info("[embed:webgpu] adapter", adapterName || "unknown");

    const report = await benchmarkEmbeddingLatency({
      texts: [
        "webagent diagnostics warmup sentence",
        "this is an english-only embedding benchmark sample",
        "local vector generation should stay on device",
      ],
      runs: 5,
      warmupRuns: 1,
      model: WEBGPU_EMBEDDINGS_DEFAULTS.model,
      device: WEBGPU_EMBEDDINGS_DEFAULTS.device,
    });

    console.info("[embed:webgpu] benchmark", report);
  } catch (err) {
    console.error("[embed:webgpu] diagnostics failed", err);
  } finally {
    console.groupEnd();
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    console.warn("[sw] service workers are not supported in this browser");
    return;
  }
  try {
    console.info("[sw] registering /sw.js ...");
    const registration = await navigator.serviceWorker.register("/sw.js");
    console.info("[sw] registration succeeded", registration.scope);
    const readyRegistration = await navigator.serviceWorker.ready;
    console.info("[sw] ready state reached");



    await registerWebPushSubscription(readyRegistration || registration);
  } catch (err) {
    console.error("[sw] service worker registration failed", err);
  }
}

void registerServiceWorker();
void runStartupWebGpuEmbeddingDiagnostics();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);