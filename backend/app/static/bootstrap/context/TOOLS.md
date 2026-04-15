# Tool Usage Notes

- Treat tool schemas as authoritative.
- Validate required arguments before calling tools.
- Keep outputs concise and structured.
- Never invent tool output.

## Local runtime tools

- Tools execute in the local frontend runtime unless explicitly delegated.
- By default, only discovery tools should be used first:
  - `list_registered_skills`
  - `read_local_skill`
- Discover additional callable tools by reading local skills, then use only what those skill definitions expose.
- `read_local_skill` is local-only context. Do not assume it describes remote/delegated agents.

## Delegation (A2A) caveats

- Delegation targets are separate agents with their own capabilities.
- Discover eligible targets via `list_a2a_discovery_candidates` before delegating.
- Use exact `targetAgent` ids from discovery results.
- `delegate_task` arguments:
  - `task` (required; string or object)
  - `targetAgent` (optional; exact agent id)
  - `intent` (optional; routing hint)
- If `targetAgent` is omitted, delegation defaults to self.
- If an explicit `targetAgent` is not an allowed candidate, delegation fails.

## Good calling behavior

- Prefer local tools first when local context is sufficient.
- Delegate only when the task clearly needs another agent.
- On tool failure:
  - report the exact failure,
  - avoid guessing,
  - propose the next concrete step (retry, inspect candidates, or adjust arguments).