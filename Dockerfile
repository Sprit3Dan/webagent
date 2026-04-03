# syntax=docker/dockerfile:1.7

############################
# Stage 1: Build React app #
############################
FROM node:20-alpine AS frontend-builder

WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

COPY frontend/ ./
RUN npm run build


################################
# Stage 2: FastAPI app runtime #
################################
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_NAME=webagent-backend \
    ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    OPENAI_MODEL=nemotron-30b \
    OPENAI_BASE_URL=http://inference.sprit3dan-labs.net/nemotron-30b/v1/

WORKDIR /app

# Optional: install curl for container health checks/debugging
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Install backend Python dependencies
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# Copy backend source
COPY backend/ /app/backend/

# Copy built frontend artifacts (served by FastAPI fallback)
COPY --from=frontend-builder /build/frontend/dist /app/frontend/dist

EXPOSE 8000

# Run FastAPI
CMD ["uvicorn", "app.main:app", "--app-dir", "/app/backend", "--host", "0.0.0.0", "--port", "8000"]