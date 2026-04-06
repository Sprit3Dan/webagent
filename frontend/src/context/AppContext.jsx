import React, { createContext, useContext, useMemo, useState } from "react";
import {
  CONTEXT,
  ROUTES,
  VIEWPORT_PAGE_MAX_MESSAGES,
  VIEWPORT_PAGE_MIN_MESSAGES,
  VIEWPORT_PAGE_TARGET_HEIGHT_RATIO,
} from "../lib/constants";
import { normalizeRoute } from "../lib/utils";

const AppContext = createContext(null);

function getViewportPageSize() {
  if (typeof window === "undefined") return VIEWPORT_PAGE_MIN_MESSAGES;

  const reservedChrome = 220;
  const availableHeight = Math.max(
    220,
    Math.floor(window.innerHeight * VIEWPORT_PAGE_TARGET_HEIGHT_RATIO) - reservedChrome,
  );
  const approxMessageRowHeight = 140;
  const estimated = Math.floor(availableHeight / approxMessageRowHeight);

  return Math.max(
    VIEWPORT_PAGE_MIN_MESSAGES,
    Math.min(VIEWPORT_PAGE_MAX_MESSAGES, estimated),
  );
}

export function AppProvider({ children }) {
  const [route, setRoute] = useState(() =>
    normalizeRoute(
      typeof window !== "undefined" ? window.location.pathname : ROUTES.CHAT,
    ),
  );
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("storage: initializing");
  const [autoScroll, setAutoScroll] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  const [llmProviders, setLlmProviders] = useState(() => [
    {
      id: "default",
      name: "default",
      provider: "openai-compatible",
      baseUrl: "",
      model: String(CONTEXT.model || "nemotron-30b"),
      contextWindowTokens: Number(CONTEXT.contextWindowTokens || 64_000),
      tokenBudget: 0,
      tokenSecret: "",
    },
  ]);
  const [activeLlmProviderId, setActiveLlmProviderId] = useState("default");

  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(() => getViewportPageSize());
  const [focusedMessageIndex, setFocusedMessageIndex] = useState(-1);

  const [inspectorStatus, setInspectorStatus] = useState("idle");
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedFileContent, setSelectedFileContent] = useState("");
  const [selectedFileMeta, setSelectedFileMeta] = useState(null);

  const resetInspectorSelection = () => {
    setSelectedFilePath("");
    setSelectedFileContent("");
    setSelectedFileMeta(null);
  };

  const value = useMemo(
    () => ({
      route,
      setRoute,
      prompt,
      setPrompt,
      status,
      setStatus,
      autoScroll,
      setAutoScroll,
      isLoading,
      setIsLoading,
      llmProviders,
      setLlmProviders,
      activeLlmProviderId,
      setActiveLlmProviderId,
      activeLlmProvider:
        llmProviders.find((p) => p?.id === activeLlmProviderId) || llmProviders[0] || null,
      pageIndex,
      setPageIndex,
      pageSize,
      setPageSize,
      focusedMessageIndex,
      setFocusedMessageIndex,
      inspectorStatus,
      setInspectorStatus,
      inspectorLoading,
      setInspectorLoading,
      selectedFilePath,
      setSelectedFilePath,
      selectedFileContent,
      setSelectedFileContent,
      selectedFileMeta,
      setSelectedFileMeta,
      resetInspectorSelection,
      getViewportPageSize,
    }),
    [
      route,
      prompt,
      status,
      autoScroll,
      isLoading,
      llmProviders,
      activeLlmProviderId,
      pageIndex,
      pageSize,
      focusedMessageIndex,
      inspectorStatus,
      inspectorLoading,
      selectedFilePath,
      selectedFileContent,
      selectedFileMeta,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useAppContext must be used within AppProvider");
  }
  return ctx;
}