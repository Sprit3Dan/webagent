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

function classifyStorageItem(item) {
  const path = String(item?.path || "");
  const kind = String(item?.kind || "");

  if (kind === "directory") return "opfs_directories";

  if (path.startsWith("indexeddb/tools/")) return "idb_tools";
  if (path.startsWith("indexeddb/skills/")) return "idb_skills";
  if (path.startsWith("indexeddb/skill_modules/")) return "idb_skill_modules";
  if (path.startsWith("indexeddb/docs/")) return "idb_docs";
  if (path.startsWith("indexeddb/chunks/")) return "idb_chunks";
  if (path.startsWith("indexeddb/")) return "idb_other";

  if (["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"].includes(path)) return "opfs_context";
  if (path.endsWith(".json")) return "opfs_snapshots";
  return "opfs_other";
}

function buildInspectorSections(items) {
  const order = [
    "opfs_context",
    "opfs_snapshots",
    "opfs_other",
    "opfs_directories",
    "idb_tools",
    "idb_skills",
    "idb_skill_modules",
    "idb_docs",
    "idb_chunks",
    "idb_other",
  ];

  const titles = {
    opfs_context: "OPFS · Context Files",
    opfs_snapshots: "OPFS · Session Snapshots",
    opfs_other: "OPFS · Other Files",
    opfs_directories: "OPFS · Directories",
    idb_tools: "IndexedDB · Tools",
    idb_skills: "IndexedDB · Skills",
    idb_skill_modules: "IndexedDB · Skill Modules",
    idb_docs: "IndexedDB · Docs",
    idb_chunks: "IndexedDB · Chunks",
    idb_other: "IndexedDB · Other Records",
  };

  const buckets = new Map(order.map((k) => [k, []]));
  for (const item of Array.isArray(items) ? items : []) {
    const key = classifyStorageItem(item);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }

  return order
    .map((key) => ({ key, title: titles[key] || key, items: buckets.get(key) || [] }))
    .filter((section) => section.items.length > 0);
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
  const inspectorSections = buildInspectorSections(inspectorItems);

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
          {inspectorSections.length === 0 ? (
            <div style={{ color: "#6f8499" }}>
              No OPFS files or IndexedDB skill documents
            </div>
          ) : (
            inspectorSections.map((section, sectionIdx) => (
              <div
                key={section.key}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  paddingTop: sectionIdx === 0 ? 0 : 8,
                  marginTop: sectionIdx === 0 ? 0 : 8,
                  borderTop: sectionIdx === 0 ? "none" : "1px solid #233240",
                }}
              >
                <div style={{ color: "#8fb0c9", fontSize: 11, letterSpacing: "0.02em" }}>
                  {section.title}
                </div>

                {section.items.map((item) => {
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
                })}
              </div>
            ))
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