import { useEffect } from "react";

function isEditableTarget(target) {
  const tag = target?.tagName?.toLowerCase?.() || "";
  const editable = target?.isContentEditable || false;
  if (editable) return true;
  return tag === "input" || tag === "textarea" || tag === "select";
}

export default function useChatKeyboard({
  route,
  chatRoute = "/",
  currentPageLength = 0,
  isOnLastPage = true,
  setFocusedMessageIndex,
  goPrevPage,
  goNextPage,
  focusComposer,
  copyFocusedMessage,
  toggleFocusedMessageDetails,
  setStatus,
  isEnabled = true,
}) {
  useEffect(() => {
    if (!isEnabled) return;
    if (route !== chatRoute) return;

    const onWindowKeydown = (event) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (isEditableTarget(event.target)) return;

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

      if (event.key === "Enter") {
        event.preventDefault();
        void toggleFocusedMessageDetails?.();
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
    currentPageLength,
    isOnLastPage,
    setFocusedMessageIndex,
    goPrevPage,
    goNextPage,
    focusComposer,
    copyFocusedMessage,
    toggleFocusedMessageDetails,
    setStatus,
  ]);
}