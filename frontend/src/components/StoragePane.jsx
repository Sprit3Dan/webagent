import React from "react";

function prettyPathLabel(path) {
  const text = String(path || "");
  if (!text.startsWith("indexeddb/")) return text;

  const parts = text.split("/");
  if (parts.length < 3) return text;

  const [root, store, ...rest] = parts;
  const decodedTail = rest
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");

  return `${root}/${store}/${decodedTail}`;
}

export default function StoragePane({
  inspectorItems = [],
  inspectorLoading = false,
  inspectorStatus = "idle",
  selectedFilePath = "",
  selectedFileContent = "",
  selectedFileMeta = null,
  onRefresh,
  onClearSession,
  onViewFile,
}) {
  return (
    <section
      style={{
        minHeight: 0,
        overflow: "auto",
        padding: 12,
        display: "grid",
        gridTemplateColumns: "minmax(220px, 360px) minmax(0, 1fr)",
        gap: 12,
      }}
    >
      <aside
        style={{
          border: "1px solid #24303d",
          borderRadius: 8,
          background: "#0f1720",
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          minHeight: 0,
        }}
      >
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={onRefresh}
            disabled={inspectorLoading}
            style={{
              border: "1px solid #2f4257",
              borderRadius: 6,
              background: "#102132",
              color: "#c7d5e2",
              padding: "4px 8px",
              cursor: "pointer",
              opacity: inspectorLoading ? 0.7 : 1,
            }}
          >
            {inspectorLoading ? "refreshing..." : "refresh"}
          </button>

          <button
            onClick={onClearSession}
            style={{
              border: "1px solid #55333a",
              borderRadius: 6,
              background: "#2a161a",
              color: "#ffc9cf",
              padding: "4px 8px",
              cursor: "pointer",
            }}
          >
            clear session
          </button>
        </div>

        <div style={{ color: "#93a6b7", fontSize: 12 }}>
          storage index · {inspectorStatus}
        </div>

        <div
          style={{
            overflow: "auto",
            borderTop: "1px dashed #2a394a",
            paddingTop: 8,
            fontSize: 12,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {inspectorItems.length === 0 ? (
            <div style={{ color: "#6f8499" }}>
              No OPFS files or IndexedDB skill documents
            </div>
          ) : (
            inspectorItems.map((item) => {
              const isFile = item.kind === "file";
              const selected = selectedFilePath === item.path;

              return (
                <button
                  key={item.path}
                  onClick={() => isFile && onViewFile?.(item.path)}
                  disabled={!isFile}
                  title={item.path}
                  style={{
                    textAlign: "left",
                    border: "1px solid #2a394a",
                    borderRadius: 6,
                    background: selected ? "#16314f" : "#111b27",
                    color: isFile ? "#cfe0ef" : "#7e93a8",
                    padding: "6px 8px",
                    cursor: isFile ? "pointer" : "default",
                    opacity: isFile ? 1 : 0.8,
                    whiteSpace: "normal",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                  }}
                >
                  {item.kind === "directory" ? "📁" : "📄"} {prettyPathLabel(item.path)}
                </button>
              );
            })
          )}
        </div>
      </aside>

      <main
        style={{
          border: "1px solid #24303d",
          borderRadius: 8,
          background: "#0f1720",
          padding: 10,
          minHeight: 0,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ color: "#93a6b7", fontSize: 12 }}>
          {selectedFilePath
            ? `viewing: ${prettyPathLabel(selectedFilePath)}`
            : "select an OPFS file or IndexedDB skill document to view its content"}
        </div>

        {selectedFileMeta ? (
          <div style={{ color: "#7f97af", fontSize: 12 }}>
            size: {selectedFileMeta.size} bytes · type: {selectedFileMeta.type} · modified:{" "}
            {selectedFileMeta.modified}
          </div>
        ) : null}

        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "#c7d5e2",
            border: "1px dashed #2a394a",
            borderRadius: 6,
            padding: 10,
            background: "#0b121a",
            minHeight: 120,
          }}
        >
          {selectedFileContent || "(empty)"}
        </pre>
      </main>
    </section>
  );
}