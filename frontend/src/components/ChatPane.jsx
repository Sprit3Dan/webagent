import React, { useEffect, useRef } from "react";
import MessageCard from "./MessageCard";



export default function ChatPane({
  listRef,
  pageIndex,
  pages,
  currentPage,
  onPrevPage,
  onNextPage,
  onTouchStart,
  onTouchEnd,
  isLoading,
  focusedMessageIndex = -1,
  prompt,
  onPromptChange,
  onSend,
  composerDisabled = false,
  composerPlaceholder = "Type your message. Enter=send, Shift+Enter=newline, swipe L/R for pages",
  showComposer = true,
}) {
  const totalPages = Math.max(1, pages?.length || 0);
  const activePage = Math.min(pageIndex + 1, totalPages);
  const composerRef = useRef(null);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(72, el.scrollHeight)}px`;
  }, [prompt]);





  return (
    <section
      ref={listRef}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      style={{
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          color: "#89a0b6",
          fontSize: 12,
        }}
      >
        <span>
          PAGE {activePage}/{totalPages}
        </span>

        <span style={{ display: "flex", gap: 6 }}>
          <button
            onClick={onPrevPage}
            disabled={pageIndex <= 0}
            style={{
              background: "#102132",
              color: "#c7d5e2",
              border: "1px solid #2f4257",
              borderRadius: 6,
              padding: "2px 8px",
              opacity: pageIndex <= 0 ? 0.4 : 1,
            }}
          >
            ←
          </button>

          <button
            onClick={onNextPage}
            disabled={pageIndex >= totalPages - 1}
            style={{
              background: "#102132",
              color: "#c7d5e2",
              border: "1px solid #2f4257",
              borderRadius: 6,
              padding: "2px 8px",
              opacity: pageIndex >= totalPages - 1 ? 0.4 : 1,
            }}
          >
            →
          </button>
        </span>
      </div>

      {!currentPage || currentPage.length === 0 ? (
        <div
          style={{
            color: "#6f8499",
            border: "1px dashed #2a394a",
            borderRadius: 8,
            padding: 12,
          }}
        >
          No messages yet.
        </div>
      ) : (
        currentPage.map((m, i) => {
          const focused = i === focusedMessageIndex;
          const messagePromptMemories = Array.isArray(m?.prompt_memories) ? m.prompt_memories : [];
          const messagePromptMeta =
            m?.prompt_memory_meta && typeof m.prompt_memory_meta === "object"
              ? m.prompt_memory_meta
              : null;

          return (
            <React.Fragment key={`${m.timestamp || "msg"}-${pageIndex}-${i}`}>
              <div
                style={{
                  outline: focused ? "1px solid #8aa7c4" : "1px solid transparent",
                  outlineOffset: 2,
                  background: focused ? "rgba(138, 167, 196, 0.08)" : "transparent",
                }}
              >
                <MessageCard msg={m} />
              </div>

              {messagePromptMemories.length ? (
                <div
                  style={{
                    border: "1px solid #2f4257",
                    background: "rgba(115, 208, 255, 0.08)",
                    borderRadius: 8,
                    padding: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    marginTop: 6,
                  }}
                >
                  <div style={{ fontSize: 12, color: "#73d0ff", fontWeight: 700 }}>
                    MEMORIES INCLUDED IN PROMPT ({messagePromptMemories.length})
                  </div>

                  {messagePromptMeta ? (
                    <div style={{ fontSize: 11, color: "#8fb2cf" }}>
                      minScore={Number(messagePromptMeta.minScore || 0).toFixed(3)} · topK=
                      {Number(messagePromptMeta.topK || 0)} · retrievalMs=
                      {Math.round(Number(messagePromptMeta.retrievalMs || 0))} · hits=
                      {Number(messagePromptMeta.hitCount || 0)}
                    </div>
                  ) : null}

                  {messagePromptMemories.map((item, idx) => {
                    const score = Number(item?.score || 0).toFixed(3);
                    const sessionId = String(item?.sessionId || "");
                    const turnIndex = Math.max(0, Number(item?.turnIndex || 0));
                    const kind = String(item?.kind || "conversation_turn");
                    const userText = String(item?.userText || "").replace(/\s+/g, " ").trim();
                    const assistantText = String(item?.assistantText || "").replace(/\s+/g, " ").trim();
                    const factText = String(item?.factText || "").replace(/\s+/g, " ").trim();

                    return (
                      <div
                        key={`${item?.id || "memory"}-${idx}`}
                        style={{
                          borderLeft: "3px solid #73d0ff",
                          background: "rgba(10, 15, 20, 0.5)",
                          padding: "8px 10px",
                        }}
                      >
                        <div style={{ fontSize: 11, color: "#8fb2cf", marginBottom: 4 }}>
                          score={score} · kind={kind} · session={sessionId || "unknown"} · turn={turnIndex}
                        </div>
                        {factText ? (
                          <div style={{ fontSize: 12, color: "#d6e2ee", marginBottom: 2 }}>
                            <strong>fact:</strong> {factText.slice(0, 280)}
                          </div>
                        ) : (
                          <>
                            <div style={{ fontSize: 12, color: "#d6e2ee", marginBottom: 2 }}>
                              <strong>user:</strong> {userText.slice(0, 220)}
                            </div>
                            <div style={{ fontSize: 12, color: "#c7d5e2" }}>
                              <strong>assistant:</strong> {assistantText.slice(0, 220)}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </React.Fragment>
          );
        })
      )}

      {isLoading ? (
        <div style={{ color: "#ffd166", fontSize: 12, padding: "6px 2px" }}>
          [loading]
          <span
            style={{ animation: "blinkBlock 0.9s steps(1,end) infinite", marginLeft: 4 }}
          >
            █
          </span>
        </div>
      ) : null}

      {showComposer ? (
        <div
          style={{
            paddingTop: 6,
            marginTop: 2,
          }}
        >
          <textarea
            ref={composerRef}
            tabIndex={0}
            aria-label="New message"
            value={prompt}
            onChange={(e) => onPromptChange?.(e.target.value)}
            onInput={(e) => {
              e.currentTarget.style.height = "0px";
              e.currentTarget.style.height = `${Math.max(72, e.currentTarget.scrollHeight)}px`;
            }}
            placeholder={`${composerPlaceholder} (press "/" to focus)`}
            disabled={composerDisabled}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend?.();
              }
            }}
            style={{
              width: "100%",
              minHeight: 72,
              resize: "none",
              overflow: "hidden",
              borderRadius: 0,
              border: "none",
              outline: "none",
              boxShadow: "none",
              appearance: "none",
              background: "transparent",
              color: "#d6e2ee",
              padding: "2px 0",
              opacity: composerDisabled ? 0.6 : 1,
            }}
          />
        </div>
      ) : null}
    </section>
  );
}