import { ROUTES } from "./constants";

export function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function stringifyJsonSafe(
  value,
  { pretty = true, space = 2, fallback = "{}" } = {},
) {
  try {
    return JSON.stringify(value, null, pretty ? space : 0);
  } catch {
    return fallback;
  }
}

export function normalizeRoute(pathname) {
  const route = typeof pathname === "string" ? pathname.trim() : "";
  if (route === ROUTES.STORAGE) return ROUTES.STORAGE;
  if (route === ROUTES.SETTINGS) return ROUTES.SETTINGS;
  return ROUTES.CHAT;
}

export function isChatRoute(pathname) {
  return normalizeRoute(pathname) === ROUTES.CHAT;
}

export function isStorageRoute(pathname) {
  return normalizeRoute(pathname) === ROUTES.STORAGE;
}

export function isSettingsRoute(pathname) {
  return normalizeRoute(pathname) === ROUTES.SETTINGS;
}

export function currentRoute() {
  if (typeof window === "undefined") return ROUTES.CHAT;
  return normalizeRoute(window.location.pathname);
}