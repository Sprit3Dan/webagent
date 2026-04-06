const DEFAULT_MODEL = "Xenova/bge-large-en-v1.5";
const DEFAULT_TASK = "feature-extraction";
const DEFAULT_DEVICE = "webgpu";

let transformersModulePromise = null;
let pipelinePromise = null;
let activeConfigKey = "";

function buildConfigKey({ task, model, device }) {
  return [task, model, device].join("::");
}

async function loadTransformersModule() {
  if (!transformersModulePromise) {
    transformersModulePromise = import("@xenova/transformers");
  }
  return transformersModulePromise;
}

function normalizeText(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function tensorToArray(tensorLike) {
  if (!tensorLike) return [];
  if (Array.isArray(tensorLike)) return tensorLike;
  if (tensorLike.data && typeof tensorLike.data.length === "number") {
    return Array.from(tensorLike.data);
  }
  if (typeof tensorLike.length === "number") {
    return Array.from(tensorLike);
  }
  return [];
}

export function isWebGpuSupported() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

export async function getWebGpuAdapterName() {
  if (!isWebGpuSupported()) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const info = await adapter.requestAdapterInfo?.();
    return info?.description || null;
  } catch {
    return null;
  }
}

export async function getEmbeddingPipeline({
  task = DEFAULT_TASK,
  model = DEFAULT_MODEL,
  device = DEFAULT_DEVICE,
} = {}) {
  if (device === "webgpu" && !isWebGpuSupported()) {
    throw new Error("WebGPU is not available in this browser/runtime");
  }

  const config = { task, model, device };
  const key = buildConfigKey(config);

  if (pipelinePromise && activeConfigKey === key) {
    return pipelinePromise;
  }

  const module = await loadTransformersModule();
  const { env, pipeline } = module;

  env.allowLocalModels = false;

  pipelinePromise = pipeline(task, model, { device });
  activeConfigKey = key;

  return pipelinePromise;
}

export async function embedText(
  text,
  {
    model = DEFAULT_MODEL,
    device = DEFAULT_DEVICE,
    normalize = true,
    pooling = "mean",
  } = {},
) {
  const input = normalizeText(text);
  if (!input) {
    throw new Error("text is required");
  }

  const extractor = await getEmbeddingPipeline({
    task: DEFAULT_TASK,
    model,
    device,
  });

  const output = await extractor(input, {
    pooling,
    normalize,
  });

  const embedding = tensorToArray(output);
  if (!embedding.length) {
    throw new Error("Failed to produce embedding vector");
  }

  return {
    model,
    device,
    dimensions: embedding.length,
    embedding,
  };
}

export async function embedTexts(
  texts,
  {
    model = DEFAULT_MODEL,
    device = DEFAULT_DEVICE,
    normalize = true,
    pooling = "mean",
  } = {},
) {
  const list = Array.isArray(texts) ? texts.map(normalizeText).filter(Boolean) : [];
  if (!list.length) {
    throw new Error("texts must include at least one non-empty string");
  }

  const extractor = await getEmbeddingPipeline({
    task: DEFAULT_TASK,
    model,
    device,
  });

  const output = await extractor(list, {
    pooling,
    normalize,
  });

  const raw = output?.data;
  const dims = Number(output?.dims?.at?.(-1) || 0);

  if (!raw || !dims) {
    throw new Error("Failed to produce embedding batch");
  }

  const flat = Array.from(raw);
  const embeddings = [];
  for (let i = 0; i < flat.length; i += dims) {
    embeddings.push(flat.slice(i, i + dims));
  }

  return {
    model,
    device,
    dimensions: dims,
    count: embeddings.length,
    embeddings,
  };
}

export function cosineSimilarity(a, b) {
  const v1 = Array.isArray(a) ? a : [];
  const v2 = Array.isArray(b) ? b : [];
  if (!v1.length || !v2.length || v1.length !== v2.length) {
    return 0;
  }

  let dot = 0;
  let n1 = 0;
  let n2 = 0;

  for (let i = 0; i < v1.length; i += 1) {
    const x = Number(v1[i]) || 0;
    const y = Number(v2[i]) || 0;
    dot += x * y;
    n1 += x * x;
    n2 += y * y;
  }

  if (!n1 || !n2) return 0;
  return dot / (Math.sqrt(n1) * Math.sqrt(n2));
}

export async function benchmarkEmbeddingLatency({
  texts = ["hello world"],
  runs = 5,
  warmupRuns = 1,
  model = DEFAULT_MODEL,
  device = DEFAULT_DEVICE,
  normalize = true,
  pooling = "mean",
} = {}) {
  const samples = Array.isArray(texts)
    ? texts.map((t) => normalizeText(t)).filter(Boolean)
    : [];

  if (!samples.length) {
    throw new Error("texts must include at least one non-empty string");
  }

  const safeRuns = Math.max(1, Number(runs) || 1);
  const safeWarmup = Math.max(0, Number(warmupRuns) || 0);

  const extractor = await getEmbeddingPipeline({
    task: DEFAULT_TASK,
    model,
    device,
  });

  let dimensions = 0;

  for (let i = 0; i < safeWarmup; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const output = await extractor(samples, { pooling, normalize });
    if (!dimensions) {
      dimensions = Number(output?.dims?.at?.(-1) || 0);
    }
  }

  const now =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now();

  const perRunMs = [];

  for (let i = 0; i < safeRuns; i += 1) {
    const t0 = now();
    // eslint-disable-next-line no-await-in-loop
    const output = await extractor(samples, { pooling, normalize });
    if (!dimensions) {
      dimensions = Number(output?.dims?.at?.(-1) || 0);
    }
    perRunMs.push(now() - t0);
  }

  const sorted = [...perRunMs].sort((a, b) => a - b);
  const sum = perRunMs.reduce((acc, n) => acc + n, 0);
  const pick = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];

  return {
    ok: true,
    model,
    device,
    pooling,
    normalize,
    runs: safeRuns,
    warmupRuns: safeWarmup,
    inputsPerRun: samples.length,
    totalEmbeddings: samples.length * safeRuns,
    dimensions,
    minMs: sorted[0] || 0,
    maxMs: sorted[sorted.length - 1] || 0,
    avgMs: perRunMs.length ? sum / perRunMs.length : 0,
    p50Ms: sorted.length ? pick(0.5) : 0,
    p95Ms: sorted.length ? pick(0.95) : 0,
    perRunMs,
    startedAt: new Date().toISOString(),
  };
}

export const WEBGPU_EMBEDDINGS_DEFAULTS = Object.freeze({
  model: DEFAULT_MODEL,
  task: DEFAULT_TASK,
  device: DEFAULT_DEVICE,
});