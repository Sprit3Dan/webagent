import { useCallback, useEffect, useRef } from "react";
import { ROUTES } from "../lib/constants";
import { normalizeRoute } from "../lib/utils";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export default function useChatNavigation({
  route,
  setRoute,
  safePageIndex,
  lastPageIndex,
  setPageIndex,
  focusedMessageIndex,
  currentPage,
  listRef,
} = {}) {
  const swipeRef = useRef({ x: 0, y: 0 });
  const spaceToggleIntentRef = useRef(false);

  const navigate = useCallback(
    (nextRoute) => {
      if (!nextRoute || nextRoute === route) return;
      history.pushState({}, "", nextRoute);
      setRoute?.(nextRoute);
    },
    [route, setRoute],
  );

  const goPrevPage = useCallback(() => {
    setPageIndex?.((prev) => {
      const current = Number.isFinite(prev) ? prev : safePageIndex;
      return clamp(current - 1, 0, lastPageIndex);
    });
  }, [lastPageIndex, safePageIndex, setPageIndex]);

  const goNextPage = useCallback(() => {
    setPageIndex?.((prev) => {
      const current = Number.isFinite(prev) ? prev : safePageIndex;
      return clamp(current + 1, 0, lastPageIndex);
    });
  }, [lastPageIndex, safePageIndex, setPageIndex]);

  const focusComposer = useCallback(() => {
    const el = document.querySelector('textarea[aria-label="New message"]');
    el?.focus();
  }, []);

  const toggleFocusedMessageDetails = useCallback(() => {
    if (!spaceToggleIntentRef.current) return false;
    if (focusedMessageIndex < 0) return false;
    const root = listRef?.current;
    if (!root) return false;

    const cards = root.querySelectorAll("article");
    const card = cards?.[focusedMessageIndex];
    if (!card) return false;

    const details = card.querySelectorAll("details");
    if (!details.length) return false;

    const shouldOpenAll = Array.from(details).some((node) => !node.open);
    details.forEach((node) => {
      node.open = shouldOpenAll;
    });
    return true;
  }, [focusedMessageIndex, listRef]);

  const copyFocusedMessage = useCallback(async () => {
    if (focusedMessageIndex < 0) return false;
    const msg = currentPage?.[focusedMessageIndex];
    const role = String(msg?.role || "").toLowerCase();
    let text = typeof msg?.content === "string" ? msg.content : "";
    if (!text || !navigator?.clipboard?.writeText) return false;

    if (role === "tool") {
      const marker = "\n\nresult:\n";
      const idx = text.indexOf(marker);

      const toQuotedBlock = (prefix, value) =>
        String(value || "")
          .split("\n")
          .map((line) => `${prefix} ${line}`)
          .join("\n");

      if (idx >= 0) {
        const callText = text.slice(0, idx).trim();
        const resultText = text.slice(idx + marker.length).trim();
        const callBlock = toQuotedBlock(">", callText || "toolcall");
        const resultBlock = toQuotedBlock("<", resultText || "");
        text = resultText ? `${callBlock}\n${resultBlock}` : callBlock;
      } else {
        text = toQuotedBlock(">", text.trim());
      }
    }

    await navigator.clipboard.writeText(text);
    return true;
  }, [currentPage, focusedMessageIndex]);

  const onTouchStart = useCallback((e) => {
    const t = e.touches?.[0];
    if (!t) return;
    swipeRef.current = { x: t.clientX, y: t.clientY };
  }, []);

  const onTouchEnd = useCallback(
    (e) => {
      const t = e.changedTouches?.[0];
      if (!t) return;

      const dx = t.clientX - swipeRef.current.x;
      const dy = t.clientY - swipeRef.current.y;

      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx > 0) goPrevPage();
      else goNextPage();
    },
    [goNextPage, goPrevPage],
  );

  useEffect(() => {
    const onKeyDown = (event) => {
      if (route !== ROUTES.CHAT) return;
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== " ") return;

      const target = event.target;
      const tag = target?.tagName?.toLowerCase?.() || "";
      const editable =
        target?.isContentEditable ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select";
      if (editable) return;

      event.preventDefault();
      spaceToggleIntentRef.current = true;
      try {
        void toggleFocusedMessageDetails();
      } finally {
        spaceToggleIntentRef.current = false;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [route, toggleFocusedMessageDetails]);

  useEffect(() => {
    const onPopState = () => {
      setRoute?.(normalizeRoute(window.location.pathname));
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [setRoute]);

  return {
    navigate,
    goPrevPage,
    goNextPage,
    focusComposer,
    toggleFocusedMessageDetails,
    copyFocusedMessage,
    onTouchStart,
    onTouchEnd,
  };
}