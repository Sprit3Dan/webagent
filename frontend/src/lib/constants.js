export const CONTEXT = {
  tenantId: "tenant-dev",
  userId: "user-001",
  agentId: "agent-main",
  sessionId: "chat-001",
  model: "nemotron-30b",
  temperature: 0.2,

};

export const SNAPSHOT_FILE_NAME =
  `${CONTEXT.tenantId}__${CONTEXT.agentId}__${CONTEXT.sessionId}.json`;


export const AGENT_SOUL_FILE_NAME = "SOUL.md";
export const AGENT_AGENTS_FILE_NAME = "AGENTS.md";
export const AGENT_USER_FILE_NAME = "USER.md";
export const AGENT_TOOLS_FILE_NAME = "TOOLS.md";

export const VIEWPORT_PAGE_TARGET_HEIGHT_RATIO = 0.88;
export const VIEWPORT_PAGE_MIN_MESSAGES = 8;
export const VIEWPORT_PAGE_MAX_MESSAGES = 60;

export const ROUTES = {
  CHAT: "/",
  STORAGE: "/storage",
};