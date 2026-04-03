from __future__ import annotations

import inspect
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

ToolHandler = Callable[[dict[str, Any], dict[str, Any], dict[str, Any]], Any | Awaitable[Any]]


@dataclass
class RegisteredTool:
    definition: dict[str, Any]
    handler: ToolHandler


_registry: dict[str, RegisteredTool] = {}


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dumps(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return json.dumps({"ok": False, "error": "Failed to serialize tool result"})


def _parse_args(raw_args: Any) -> dict[str, Any]:
    if raw_args is None:
        return {}
    if isinstance(raw_args, dict):
        return raw_args
    if not isinstance(raw_args, str):
        raise ValueError("Tool arguments must be a JSON string or object")

    text = raw_args.strip()
    if not text:
        return {}

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid JSON in tool arguments") from exc

    if parsed is None:
        return {}
    if not isinstance(parsed, dict):
        raise ValueError("Tool arguments JSON must decode to an object")
    return parsed


def register_tool(definition: dict[str, Any], handler: ToolHandler, *, replace: bool = True) -> RegisteredTool:
    name = ((definition or {}).get("function") or {}).get("name")
    if not name or not isinstance(name, str):
        raise ValueError("Tool definition.function.name is required")
    if not callable(handler):
        raise ValueError(f'Tool "{name}" handler must be callable')

    if not replace and name in _registry:
        raise ValueError(f'Tool "{name}" is already registered')

    tool = RegisteredTool(definition=definition, handler=handler)
    _registry[name] = tool
    return tool


def has_tool(name: str) -> bool:
    return name in _registry


def get_tool(name: str) -> RegisteredTool | None:
    return _registry.get(name)


def list_tool_definitions() -> list[dict[str, Any]]:
    return [item.definition for item in _registry.values()]


def clear_tools() -> None:
    _registry.clear()


async def execute_tool_call(tool_call: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
    started_at = datetime.now(timezone.utc)
    context = context or {}

    call_id = str(tool_call.get("id") or "")
    fn = tool_call.get("function") or {}
    name = fn.get("name")

    if not call_id:
        call_id = f"tool-{int(started_at.timestamp() * 1000)}"

    if not name or not isinstance(name, str) or name not in _registry:
        error = f'Unknown tool: {name or "<missing>"}'
        return {
            "toolCallId": call_id,
            "name": name or "unknown",
            "ok": False,
            "error": error,
            "content": _json_dumps({"ok": False, "error": error}),
            "durationMs": int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000),
        }

    reg = _registry[name]

    try:
        args = _parse_args(fn.get("arguments"))
        result = reg.handler(args, context, tool_call)
        if inspect.isawaitable(result):
            result = await result

        return {
            "toolCallId": call_id,
            "name": name,
            "ok": True,
            "result": result,
            "content": result if isinstance(result, str) else _json_dumps(result),
            "durationMs": int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000),
        }
    except Exception as exc:
        error = str(exc) or "Tool execution failed"
        return {
            "toolCallId": call_id,
            "name": name,
            "ok": False,
            "error": error,
            "content": _json_dumps({"ok": False, "error": error}),
            "durationMs": int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000),
        }


async def execute_tool_calls(
    tool_calls: list[dict[str, Any]] | None,
    context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for call in tool_calls or []:
        results.append(await execute_tool_call(call, context=context))
    return results


def to_tool_message(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_call_id": result.get("toolCallId"),
        "name": result.get("name"),
        "content": result.get("content", ""),
        "timestamp": _iso_now(),
    }


def register_builtin_tools(*, include_if_exists: bool = True) -> list[dict[str, Any]]:
    def _safe_register(definition: dict[str, Any], handler: ToolHandler) -> None:
        name = ((definition or {}).get("function") or {}).get("name")
        if include_if_exists and name in _registry:
            return
        register_tool(definition, handler, replace=True)

    async def get_server_time(
        args: dict[str, Any],
        context: dict[str, Any],
        raw: dict[str, Any],
    ) -> dict[str, Any]:
        _ = (args, raw)
        return {
            "now": _iso_now(),
            "timezone": "UTC",
            "tenantId": context.get("tenantId"),
        }

    async def add_numbers(
        args: dict[str, Any],
        context: dict[str, Any],
        raw: dict[str, Any],
    ) -> dict[str, Any]:
        _ = (context, raw)
        values = args.get("values")
        if not isinstance(values, list) or any(not isinstance(v, (int, float)) for v in values):
            raise ValueError("values must be an array of numbers")
        return {"sum": float(sum(values)), "count": len(values)}

    async def tenant_echo(
        args: dict[str, Any],
        context: dict[str, Any],
        raw: dict[str, Any],
    ) -> dict[str, Any]:
        _ = raw
        return {
            "tenantId": context.get("tenantId"),
            "userId": context.get("userId"),
            "agentId": context.get("agentId"),
            "sessionId": context.get("sessionId"),
            "text": str(args.get("text", "")),
        }

    _safe_register(
        {
            "type": "function",
            "function": {
                "name": "get_server_time",
                "description": "Get current backend server time in ISO format",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        },
        get_server_time,
    )

    _safe_register(
        {
            "type": "function",
            "function": {
                "name": "add_numbers",
                "description": "Sum an array of numeric values",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "values": {
                            "type": "array",
                            "items": {"type": "number"},
                        }
                    },
                    "required": ["values"],
                    "additionalProperties": False,
                },
            },
        },
        add_numbers,
    )

    _safe_register(
        {
            "type": "function",
            "function": {
                "name": "tenant_echo",
                "description": "Echo text with tenant/user/session context for diagnostics",
                "parameters": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": False,
                },
            },
        },
        tenant_echo,
    )

    return list_tool_definitions()