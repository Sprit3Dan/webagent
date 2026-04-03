#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

BACKEND_HOST="${BACKEND_HOST:-0.0.0.0}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

if [ ! -d "$BACKEND_DIR" ]; then
  echo "Missing backend directory: $BACKEND_DIR" >&2
  exit 1
fi

if [ ! -d "$FRONTEND_DIR" ]; then
  echo "Missing frontend directory: $FRONTEND_DIR" >&2
  exit 1
fi

cleanup() {
  trap - INT TERM EXIT
  [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "${FRONTEND_PID:-}" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}

trap cleanup INT TERM EXIT

echo "Starting backend (reload) on ${BACKEND_HOST}:${BACKEND_PORT}..."
(
  cd "$BACKEND_DIR"
  PYTHONPATH="${BACKEND_DIR}${PYTHONPATH:+:$PYTHONPATH}" \
    uvicorn app.main:app --reload --host "$BACKEND_HOST" --port "$BACKEND_PORT"
) &
BACKEND_PID=$!

echo "Starting frontend (Vite) on ${FRONTEND_HOST}:${FRONTEND_PORT}..."
(
  cd "$FRONTEND_DIR"
  if [ ! -d node_modules ]; then
    echo "Installing frontend dependencies..."
    npm install
  fi
  npm run dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT"
) &
FRONTEND_PID=$!

echo ""
echo "Dev stack is starting..."
echo "  Frontend: http://localhost:${FRONTEND_PORT}"
echo "  Backend:  http://localhost:${BACKEND_PORT}"
echo "  API docs: http://localhost:${BACKEND_PORT}/docs"
echo ""

# Keep script alive while both child processes are alive.
while :; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    wait "$BACKEND_PID" || true
    echo "Backend process exited." >&2
    exit 1
  fi

  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    wait "$FRONTEND_PID" || true
    echo "Frontend process exited." >&2
    exit 1
  fi

  sleep 1
done