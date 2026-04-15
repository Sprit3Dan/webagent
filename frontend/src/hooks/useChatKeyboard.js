import { useEffect, useRef } from "react";

function isEditableTarget(target) {
  const tag = target?.tagName?.toLowerCase?.() || "";
  const editable = target?.isContentEditable || false;
  if (editable) return true;
  return tag === "input" || tag === "textarea" || tag === "select";
}

export default function useChatKeyboard({
  route,
  chatRoute = "/",
  routes = { chat: "/", storage: "/storage", settings: "/settings", a2a: "/a2a" },
  onNavigate,
  currentPageLength = 0,
  isOnLastPage = true,
  setFocusedMessageIndex,
  goPrevPage,
  goNextPage,
  focusComposer,
  copyFocusedMessage,
  setStatus,
  isEnabled = true,
}) {
  const pendingGoRef = useRef({ active: false, ts: 0 });

  useEffect(() => {
    if (!isEnabled) return;

    const onWindowKeydown = (event) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = String(event.key || "").toLowerCase();
      const editable = isEditableTarget(event.target);
      const now = Date.now();

      if (key === "escape") {
        const active = document.activeElement;
        if (active && isEditableTarget(active) && typeof active.blur === "function") {
          event.preventDefault();
          active.blur();
          setStatus?.("input unfocused");
          return;
        }
      }

      if (pendingGoRef.current.active && now - pendingGoRef.current.ts > 1200) {
        pendingGoRef.current = { active: false, ts: 0 };
      }

      if (!editable && key === "g") {
        event.preventDefault();
        pendingGoRef.current = { active: true, ts: now };
        setStatus?.("go: c=chat · s=storage · a=a2a · ,=settings");
        return;
      }

      if (!editable && pendingGoRef.current.active) {
        pendingGoRef.current = { active: false, ts: 0 };

        if (key === "c") {
          event.preventDefault();
          onNavigate?.(routes.chat || "/");
          return;
        }
        if (key === "s") {
          event.preventDefault();
          onNavigate?.(routes.storage || "/storage");
          return;
        }
        if (key === "a") {
          event.preventDefault();
          onNavigate?.(routes.a2a || "/a2a");
          return;
        }
        if (key === ",") {
          event.preventDefault();
          onNavigate?.(routes.settings || "/settings");
          return;
        }
      }

      if (editable) return;
      if (route !== chatRoute) return;

      if (event.key === "/") {
        event.preventDefault();
        focusComposer?.();
        return;
      }

      if (event.key === "y") {
        event.preventDefault();
        void copyFocusedMessage?.().then((ok) => {
          if (ok) setStatus?.("copied focused message");
        });
        return;
      }



      if (event.key === "ArrowLeft" || event.key === "h") {
        event.preventDefault();
        goPrevPage?.();
        return;
      }

      if (event.key === "ArrowRight" || event.key === "l") {
        event.preventDefault();
        goNextPage?.();
        return;
      }

      if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        setFocusedMessageIndex?.((prev) => {
          const max = currentPageLength - 1;
          if (max < 0) return -1;
          if (prev < 0) return max;
          return Math.max(0, prev - 1);
        });
        return;
      }

      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        setFocusedMessageIndex?.((prev) => {
          const max = currentPageLength - 1;
          if (max < 0) return -1;
          if (prev < 0) return 0;

          if (prev >= max) {
            if (!isOnLastPage) {
              goNextPage?.();
              return 0;
            }
            return prev;
          }

          return Math.min(max, prev + 1);
        });
      }
    };

    window.addEventListener("keydown", onWindowKeydown);
    return () => window.removeEventListener("keydown", onWindowKeydown);
  }, [
    isEnabled,
    route,
    chatRoute,
    routes,
    onNavigate,
    currentPageLength,
    isOnLastPage,
    setFocusedMessageIndex,
    goPrevPage,
    goNextPage,
    focusComposer,
    copyFocusedMessage,
    setStatus,
  ]);
}