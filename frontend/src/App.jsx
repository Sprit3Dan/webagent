import React, { useEffect } from "react";
import ChatPane from "./components/ChatPane";
import StoragePane from "./components/StoragePane";
import SettingsPane from "./components/SettingsPane";
import A2APane from "./components/A2APane";
import TopBar from "./components/TopBar";
import { AppProvider } from "./context/AppContext";
import useChatKeyboard from "./hooks/useChatKeyboard";
import useChatSession from "./hooks/useChatSession";
import { ROUTES, SNAPSHOT_FILE_NAME } from "./lib/constants";

function AppShell() {

  const {
    route,
    navigate,
    prompt,
    setPrompt,
    status,
    setStatus,
    isLoading,
    telemetryText,
    pageIndex,
    pages,
    currentPage,
    isOnLastPage,
    focusedMessageIndex,
    setFocusedMessageIndex,
    goPrevPage,
    goNextPage,
    listRef,
    onTouchStart,
    onTouchEnd,
    focusComposer,
    toggleFocusedMessageDetails,
    copyFocusedMessage,
    send,
    composerDisabled,
    inspectorItems,
    inspectorStatus,
    inspectorLoading,
    selectedFilePath,
    selectedFileContent,
    selectedFileMeta,
    refreshInspector,
    reseedContextBootstrap,
    viewFile,
    clearCurrentSession,
    llmProviders,
    activeLlmProviderId,
    setActiveLlmProviderId,
    updateActiveLlmProvider,
    addLlmProvider,
    removeLlmProvider,
    saveLlmSettings,
    delegations,
    a2aEnabled,
    a2aBackendDefaults,
    setA2aEnabledPreference,
    setA2aConfigDefaultsPreference,
    refreshDelegations,
    delegateTask,
  } = useChatSession();

  const a2aBackendDefaultEnabled = Boolean(a2aBackendDefaults?.a2aEnabled);

  // Probe A2A health when navigating to the A2A pane
  useEffect(() => {
    if (route === ROUTES.A2A) refreshDelegations();
  }, [route]);

  useChatKeyboard({
    route,
    chatRoute: ROUTES.CHAT,
    routes: {
      chat: ROUTES.CHAT,
      storage: ROUTES.STORAGE,
      settings: ROUTES.SETTINGS,
    },
    onNavigate: navigate,
    currentPageLength: currentPage.length,
    isOnLastPage,
    setFocusedMessageIndex,
    goPrevPage,
    goNextPage,
    focusComposer,
    copyFocusedMessage,
    toggleFocusedMessageDetails,
    setStatus,
  });

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0f14",
        color: "#d6e2ee",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      }}
    >
      <style>
        {`
          @keyframes pulseDots { 0%{opacity:.2} 50%{opacity:1} 100%{opacity:.2} }
          @keyframes blinkBlock { 0%,49%{opacity:1} 50%,100%{opacity:0} }
        `}
      </style>

      <TopBar
        route={route}
        onNavigate={navigate}
        isLoading={isLoading}
        status={status}
        inspectorStatus={inspectorStatus}
        telemetryText={telemetryText}
        llmProviders={llmProviders}
        activeLlmProviderId={activeLlmProviderId}
        onActiveLlmProviderChange={setActiveLlmProviderId}
      />

      {route === ROUTES.CHAT ? (
        <ChatPane
          listRef={listRef}
          pageIndex={pageIndex}
          pages={pages}
          currentPage={currentPage}
          onPrevPage={goPrevPage}
          onNextPage={goNextPage}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          isLoading={isLoading}
          focusedMessageIndex={focusedMessageIndex}
          showComposer={isOnLastPage}
          prompt={prompt}
          onPromptChange={setPrompt}
          onSend={send}
          composerDisabled={composerDisabled}
          composerPlaceholder="Type your message. Enter=send, Shift+Enter=newline, swipe L/R for pages"
        />
      ) : route === ROUTES.SETTINGS ? (
        <SettingsPane
          llmProviders={llmProviders}
          activeLlmProviderId={activeLlmProviderId}
          onActiveLlmProviderChange={setActiveLlmProviderId}
          onUpdateActiveProvider={updateActiveLlmProvider}
          onAddProvider={addLlmProvider}
          onRemoveProvider={removeLlmProvider}
          onSave={saveLlmSettings}
          a2aEnabled={a2aEnabled}
          a2aBackendDefaults={a2aBackendDefaults}
          onA2aEnabledChange={setA2aEnabledPreference}
          onA2aConfigChange={setA2aConfigDefaultsPreference}
        />
      ) : route === ROUTES.A2A ? (
        <A2APane
          delegations={delegations}
          a2aEnabled={a2aEnabled}
          a2aBackendDefaultEnabled={a2aBackendDefaultEnabled}
          onA2aEnabledChange={setA2aEnabledPreference}
          onRefresh={refreshDelegations}
          onDelegate={delegateTask}
        />
      ) : (
        <StoragePane
          inspectorItems={inspectorItems}
          inspectorLoading={inspectorLoading}
          inspectorStatus={inspectorStatus}
          selectedFilePath={selectedFilePath}
          selectedFileContent={selectedFileContent}
          selectedFileMeta={selectedFileMeta}
          onRefresh={refreshInspector}
          onReseedBootstrap={reseedContextBootstrap}
          onClearSession={clearCurrentSession}
          onViewFile={viewFile}
        />
      )}

      {route === ROUTES.STORAGE && (
        <footer
          style={{
            borderTop: "1px solid #24303d",
            padding: 12,
            background: "#0f1720",
          }}
        >
          <div style={{ color: "#8ca1b4", fontSize: 12 }}>
            Active session snapshot file: <code>{SNAPSHOT_FILE_NAME}</code>
          </div>
        </footer>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}