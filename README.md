# webagent

## Mission

Build a frontend-first, tool-using web agent with explicit trust boundaries:

- **Local-first data boundary**: user context and working memory stay on-device (OPFS + IndexedDB in the browser runtime).
- **Inference boundary**: model calls go only to configured OpenAI-compatible endpoints; the app does not require central storage of user data.
- **Operational boundary**: backend orchestrates request/response flow and tool-call routing, while frontend/service worker owns local state and persistence.

## Architecture at a Glance

- **Backend**: FastAPI (`backend/`) for API surface, auth/multitenant scope checks, and OpenAI-compatible chat completion calls
- **Frontend**: Vite + React (`frontend/`) for chat UX and runtime controls
- **Runtime tools**: service-worker skill runtime with OPFS (fast prompt-path context) + IndexedDB (long-term retrieval memory)
- **Dev containers**: Docker Compose (`docker-compose.dev.yml`)

---

## Prerequisites

- **Node.js** 20+
- **Python** 3.12+
- **npm**
- **Docker** + Docker Compose (optional, recommended for quick startup)

Optional (for LLM calls):
- `OPENAI_API_KEY`

---

## Project Layout

- `backend/` — FastAPI API server
- `frontend/` — Vite app
- `docker-compose.dev.yml` — dev stack (backend + frontend)
- `dev-start.sh` — local script to run backend + frontend together

---

## Quick Start (Docker)

From project root:

```/dev/null/shell.sh#L1-5
npm run dev:compose:up
npm run dev:compose:logs
# stop:
npm run dev:compose:down
```

Services:
- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8000`
- API docs: `http://localhost:8000/docs`

Restart dev stack:

```/dev/null/shell.sh#L1-1
npm run dev:compose:restart
```

---

## Quick Start (Local, no Docker)

Install deps:

```/dev/null/shell.sh#L1-3
npm install
npm run install:backend
npm run install:frontend
```

Run both apps:

```/dev/null/shell.sh#L1-1
npm run dev
```

Or run via helper script:

```/dev/null/shell.sh#L1-2
chmod +x ./dev-start.sh
./dev-start.sh
```

---

## Handy Scripts (root `package.json`)

```/dev/null/text.txt#L1-12
npm run dev                 # run backend + frontend together (local)
npm run dev:backend         # backend only
npm run dev:frontend        # frontend only

npm run dev:compose         # docker compose up --build (foreground)
npm run dev:compose:up      # docker compose up -d --build
npm run dev:compose:logs    # follow compose logs
npm run dev:compose:down    # stop compose stack
npm run dev:compose:restart # rebuild/restart compose stack

npm run install:backend
npm run install:frontend
```
