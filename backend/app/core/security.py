from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from typing import Any

from fastapi import HTTPException, Request, status
from pydantic import BaseModel, Field


DEFAULT_HEADERS = {
    "authorization": "authorization",
    "tenant_id": "x-tenant-id",
    "user_id": "x-user-id",
    "agent_id": "x-agent-id",
    "session_id": "x-session-id",
    "api_key": "x-api-key",
}


class AuthContext(BaseModel):
    auth_type: str = "anonymous"
    token: str | None = None
    claims: dict[str, Any] = Field(default_factory=dict)
    tenant_id: str | None = None
    user_id: str | None = None
    agent_id: str | None = None
    session_id: str | None = None
    api_key: str | None = None
    principal_id: str | None = None
    is_authenticated: bool = False


def _norm(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def parse_bearer_token(header_value: str | None) -> str | None:
    if not header_value:
        return None
    text = header_value.strip()
    if not text.lower().startswith("bearer "):
        return None
    token = text[7:].strip()
    return token or None


def decode_jwt_payload(token: str) -> dict[str, Any] | None:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        payload_raw = _b64url_decode(parts[1])
        payload = json.loads(payload_raw.decode("utf-8"))
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def verify_hs256_jwt(token: str, secret: str) -> bool:
    parts = token.split(".")
    if len(parts) != 3:
        return False

    signing_input = f"{parts[0]}.{parts[1]}".encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    expected_sig = _b64url_encode(expected)
    return hmac.compare_digest(expected_sig, parts[2])


def resolve_claim(
    claims: dict[str, Any],
    *keys: str,
) -> Any:
    for key in keys:
        if key in claims and claims[key] is not None:
            return claims[key]
    return None


def build_auth_context(
    request: Request,
    *,
    require_tenant: bool = True,
    require_user: bool = True,
    require_auth: bool = False,
    allow_header_fallback: bool = True,
    headers: dict[str, str] | None = None,
    jwt_secret: str | None = None,
    jwt_algorithm: str = "HS256",
    allow_api_key: bool = True,
) -> AuthContext:
    header_names = {**DEFAULT_HEADERS, **(headers or {})}
    auth_header = request.headers.get(header_names["authorization"])
    token = parse_bearer_token(auth_header)
    claims: dict[str, Any] = {}

    if token:
        claims = decode_jwt_payload(token) or {}
        if jwt_secret and jwt_algorithm.upper() == "HS256":
            if not verify_hs256_jwt(token, jwt_secret):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid bearer token signature",
                )

    api_key = _norm(request.headers.get(header_names["api_key"])) if allow_api_key else None

    tenant_from_header = _norm(request.headers.get(header_names["tenant_id"]))
    user_from_header = _norm(request.headers.get(header_names["user_id"]))
    agent_from_header = _norm(request.headers.get(header_names["agent_id"]))
    session_from_header = _norm(request.headers.get(header_names["session_id"]))

    tenant_id = _norm(
        resolve_claim(claims, "tenantId", "tenant_id")
        or (tenant_from_header if allow_header_fallback else None)
    )
    user_id = _norm(
        resolve_claim(claims, "userId", "user_id", "sub")
        or (user_from_header if allow_header_fallback else None)
    )
    agent_id = _norm(resolve_claim(claims, "agentId", "agent_id") or agent_from_header)
    session_id = _norm(resolve_claim(claims, "sessionId", "session_id") or session_from_header)

    auth_type = "bearer" if token else ("api_key" if api_key else "anonymous")
    is_authenticated = bool(token or api_key)

    if require_auth and not is_authenticated:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication is required",
        )
    if require_tenant and not tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing tenant context",
        )
    if require_user and not user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing user context",
        )

    principal_id = user_id or api_key

    return AuthContext(
        auth_type=auth_type,
        token=token,
        claims=claims,
        tenant_id=tenant_id,
        user_id=user_id,
        agent_id=agent_id,
        session_id=session_id,
        api_key=api_key,
        principal_id=principal_id,
        is_authenticated=is_authenticated,
    )


def require_tenant_scope(ctx: AuthContext) -> str:
    if not ctx.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tenant scope is required",
        )
    return ctx.tenant_id


def enforce_tenant_match(ctx: AuthContext, tenant_id: str) -> None:
    required = _norm(tenant_id)
    actual = _norm(ctx.tenant_id)
    if required and actual and required != actual:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tenant scope mismatch",
        )


def default_jwt_secret() -> str | None:
    return _norm(os.getenv("JWT_SECRET"))