function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function normalizeHeaders(input) {
  const out = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...(input || {}),
  }

  if (!out.Accept && !out.accept) out.accept = "text/event-stream"
  if (!out["Content-Type"] && !out["content-type"]) {
    out["content-type"] = "application/json"
  }

  return out
}

function makeSseEvent() {
  return {
    event: "",
    dataLines: [],
    id: "",
    retry: null,
  }
}

function dispatchSseEvent(state, handlers = {}) {
  const { onEvent } = handlers
  const hasData = state.dataLines.length > 0
  const hasMeta = !!state.event || !!state.id || state.retry != null
  if (!hasData && !hasMeta) return

  const event = state.event || "message"
  const dataText = state.dataLines.join("\n")
  const dataJson = parseJsonSafe(dataText, null)

  onEvent?.({
    event,
    id: state.id || undefined,
    retry: state.retry ?? undefined,
    data: dataText,
    json: dataJson,
  })
}

function processSseLine(line, state, handlers) {
  if (!line) {
    dispatchSseEvent(state, handlers)
    state.event = ""
    state.dataLines = []
    state.id = ""
    state.retry = null
    return
  }

  if (line.startsWith(":")) return

  const sep = line.indexOf(":")
  const field = sep >= 0 ? line.slice(0, sep) : line
  let value = sep >= 0 ? line.slice(sep + 1) : ""
  if (value.startsWith(" ")) value = value.slice(1)

  if (field === "event") state.event = value
  else if (field === "data") state.dataLines.push(value)
  else if (field === "id") state.id = value
  else if (field === "retry") {
    const n = Number(value)
    state.retry = Number.isFinite(n) ? n : null
  }
}

export async function consumeSseResponse(response, handlers = {}) {
  const { onOpen, onEvent, onClose, onError, signal } = handlers

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    const message = text || `SSE request failed with status ${response.status}`
    const err = new Error(message)
    onError?.(err)
    throw err
  }

  if (!response.body) {
    const err = new Error("SSE response has no readable body")
    onError?.(err)
    throw err
  }

  onOpen?.(response)

  const reader = response.body.getReader()
  const decoder = new TextDecoder("utf-8")
  const state = makeSseEvent()
  const events = []

  const emit = (evt) => {
    events.push(evt)
    onEvent?.(evt)
  }

  let buffer = ""
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let idx = buffer.indexOf("\n")
      while (idx >= 0) {
        const rawLine = buffer.slice(0, idx)
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
        buffer = buffer.slice(idx + 1)

        processSseLine(line, state, { onEvent: emit })
        idx = buffer.indexOf("\n")
      }
    }

    buffer += decoder.decode()
    if (buffer.length > 0) {
      const rest = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer
      processSseLine(rest, state, { onEvent: emit })
    }
    dispatchSseEvent(state, { onEvent: emit })

    onClose?.()
    return events
  } catch (err) {
    onError?.(err)
    throw err
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // no-op
    }
  }
}

export async function postJsonAndConsumeSse(
  url,
  payload,
  {
    headers,
    signal,
    credentials = "same-origin",
    mode = "same-origin",
    onOpen,
    onEvent,
    onClose,
    onError,
  } = {},
) {
  const res = await fetch(url, {
    method: "POST",
    headers: normalizeHeaders(headers),
    body: JSON.stringify(payload ?? {}),
    signal,
    credentials,
    mode,
  })

  return consumeSseResponse(res, {
    signal,
    onOpen,
    onEvent,
    onClose,
    onError,
  })
}