const FRONTEND_INSTANCE_ID_KEY = "webagent.frontend.instanceId";
const FRONTEND_INSTANCE_ID_PREFIX = "webagent";

function getStorage(providedStorage) {
  if (providedStorage) return providedStorage;
  try {
    return globalThis?.localStorage || null;
  } catch {
    return null;
  }
}

function generateSuffix() {
  try {
    if (globalThis?.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return Math.random().toString(36).slice(2, 10);
}

export function createFrontendInstanceId(prefix = FRONTEND_INSTANCE_ID_PREFIX) {
  const safePrefix = String(prefix || FRONTEND_INSTANCE_ID_PREFIX).trim() || FRONTEND_INSTANCE_ID_PREFIX;
  return `${safePrefix}-${generateSuffix()}`;
}

export function readFrontendInstanceId(storage) {
  const targetStorage = getStorage(storage);
  if (!targetStorage) return "";
  try {
    return String(targetStorage.getItem(FRONTEND_INSTANCE_ID_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function getOrCreateFrontendInstanceId({
  storage,
  key = FRONTEND_INSTANCE_ID_KEY,
  prefix = FRONTEND_INSTANCE_ID_PREFIX,
} = {}) {
  const targetStorage = getStorage(storage);

  if (!targetStorage) {
    return createFrontendInstanceId(prefix);
  }

  try {
    const existing = String(targetStorage.getItem(key) || "").trim();
    if (existing) return existing;

    const created = createFrontendInstanceId(prefix);
    targetStorage.setItem(key, created);
    return created;
  } catch {
    return createFrontendInstanceId(prefix);
  }
}

export function clearFrontendInstanceId({ storage, key = FRONTEND_INSTANCE_ID_KEY } = {}) {
  const targetStorage = getStorage(storage);
  if (!targetStorage) return;
  try {
    targetStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export const FRONTEND_IDENTITY_STORAGE_KEY = FRONTEND_INSTANCE_ID_KEY;