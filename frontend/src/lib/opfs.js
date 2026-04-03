import { parseJsonSafe, stringifyJsonSafe } from "./utils";

/**
 * Resolve Origin Private File System root handle.
 */
export async function getOpfsRoot() {
  if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) {
    throw new Error("OPFS is not supported in this browser");
  }
  return navigator.storage.getDirectory();
}

/**
 * Read one text file from OPFS root.
 */
export async function readOpfsTextFile(fileName) {
  const root = await getOpfsRoot();
  const fileHandle = await root.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return file.text();
}

/**
 * Read one JSON file from OPFS root.
 */
export async function readOpfsJsonFile(fileName, fallback = null) {
  try {
    const text = await readOpfsTextFile(fileName);
    return parseJsonSafe(text, fallback);
  } catch {
    return fallback;
  }
}

/**
 * Write one text file into OPFS root.
 */
export async function writeOpfsTextFile(fileName, text) {
  const root = await getOpfsRoot();
  const fileHandle = await root.getFileHandle(fileName, { create: true });
  const writer = await fileHandle.createWritable();
  await writer.write(String(text));
  await writer.close();
}

/**
 * Write one JSON file into OPFS root.
 */
export async function writeOpfsJsonFile(fileName, value, options = {}) {
  const text = stringifyJsonSafe(value, {
    pretty: options.pretty ?? true,
    space: options.space ?? 2,
    fallback: "{}",
  });
  await writeOpfsTextFile(fileName, text);
}

/**
 * Remove one file from OPFS root. Ignores missing file errors.
 */
export async function removeOpfsFile(fileName) {
  const root = await getOpfsRoot();
  try {
    await root.removeEntry(fileName);
  } catch {
    // no-op for missing entries
  }
}

/**
 * Read app snapshot from OPFS.
 */
export async function readSnapshotFromOpfs(
  snapshotFileName,
  {
    sanitizeMessage = (m) => m,
    emptySnapshot = () => ({ messages: [], telemetry: { usage: null, compaction: null } }),
  } = {},
) {
  try {
    const parsed = await readOpfsJsonFile(snapshotFileName, null);
    return {
      messages: Array.isArray(parsed?.messages)
        ? parsed.messages.map(sanitizeMessage)
        : [],
      telemetry: parsed?.telemetry || { usage: null, compaction: null },
    };
  } catch {
    return emptySnapshot();
  }
}

/**
 * Persist app snapshot into OPFS.
 */
export async function writeSnapshotToOpfs(snapshotFileName, payload) {
  await writeOpfsJsonFile(snapshotFileName, payload, { pretty: true, space: 2 });
}

/**
 * Clear app snapshot from OPFS.
 */
export async function clearSnapshotFromOpfs(snapshotFileName) {
  await removeOpfsFile(snapshotFileName);
}

/**
 * Recursively walk OPFS entries from a directory handle.
 */
export async function walkOpfs(dirHandle, prefix = "") {
  const out = [];

  for await (const [name, entry] of dirHandle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;

    if (entry.kind === "directory") {
      out.push({ kind: "directory", path, name });
      const nested = await walkOpfs(entry, path);
      out.push(...nested);
    } else {
      out.push({ kind: "file", path, name });
    }
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Read OPFS file by path (e.g., "dir/file.json").
 */
export async function readOpfsFileByPath(path) {
  const root = await getOpfsRoot();
  const parts = String(path).split("/").filter(Boolean);

  if (!parts.length) {
    throw new Error("Invalid file path");
  }

  let current = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = await current.getDirectoryHandle(parts[i]);
  }

  const fileHandle = await current.getFileHandle(parts[parts.length - 1]);
  const file = await fileHandle.getFile();
  const text = await file.text();

  return { file, text };
}