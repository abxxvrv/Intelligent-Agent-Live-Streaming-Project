import "dotenv/config";

export type AppConfig = {
  host: string;
  port: number;
  publicBaseUrl: string;
  mockBili: boolean;
  mockSts2: boolean;
  biliRoomId?: number;
  sts2ApiUrl: string;
  sts2Mcp: {
    enabled: boolean;
    command: string;
    args: string[];
    cwd: string;
    apiBaseUrl: string;
    toolProfile: "guided" | "layered" | "full";
    allowedTools: string[];
    allowActions: boolean;
  };
  llm: {
    provider: string;
    apiKey?: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
  };
  tts: {
    provider: "system" | "disabled";
    enabled: boolean;
    voice?: string;
    rate: number;
    volume: number;
  };
  agent: {
    name: string;
    persona: string;
    speakCooldownMs: number;
    idlePromptMs: number;
    maxRecentDanmaku: number;
  };
};

export function loadConfig(argv = process.argv): AppConfig {
  const forceMock = argv.includes("--mock");
  const port = numberFromEnv("PORT", 3080);
  const host = process.env.HOST || "127.0.0.1";

  return {
    host,
    port,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://${host}:${port}`,
    mockBili: forceMock || boolFromEnv("MOCK_BILI", false),
    mockSts2: forceMock || boolFromEnv("MOCK_STS2", false),
    biliRoomId: optionalNumberFromEnv("BILI_ROOM_ID"),
    sts2ApiUrl: stripTrailingSlash(process.env.STS2_API_URL || "http://localhost:15526"),
    sts2Mcp: {
      enabled: boolFromEnv("STS2_MCP_ENABLED", false),
      command:
        process.env.STS2_MCP_COMMAND ||
        "E:\\sts2-ai-agent-v0.6.0-windows\\mcp_server\\.venv\\Scripts\\python.exe",
      args: listFromEnv("STS2_MCP_ARGS", ["-m", "sts2_mcp.server"]),
      cwd: process.env.STS2_MCP_CWD || "E:\\sts2-ai-agent-v0.6.0-windows\\mcp_server",
      apiBaseUrl: stripTrailingSlash(process.env.STS2_API_BASE_URL || "http://127.0.0.1:8080"),
      toolProfile: toolProfileFromEnv("STS2_MCP_TOOL_PROFILE", "guided"),
      allowedTools: listFromEnv("STS2_MCP_ALLOWED_TOOLS", [
        "health_check",
        "get_game_state",
        "get_raw_game_state",
        "get_available_actions",
        "act",
        "get_game_data_item",
        "get_game_data_items",
        "get_relevant_game_data",
        "wait_for_event",
        "wait_until_actionable"
      ]),
      allowActions: boolFromEnv("STS2_MCP_ALLOW_ACTIONS", false)
    },
    llm: {
      provider: process.env.LLM_PROVIDER || "openai-compatible",
      apiKey: process.env.LLM_API_KEY || undefined,
      baseUrl: stripTrailingSlash(process.env.LLM_BASE_URL || "https://api.openai.com/v1"),
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      timeoutMs: numberFromEnv("LLM_TIMEOUT_MS", 30_000)
    },
    tts: {
      provider: boolFromEnv("TTS_ENABLED", true) ? "system" : "disabled",
      enabled: boolFromEnv("TTS_ENABLED", true),
      voice: process.env.TTS_VOICE || undefined,
      rate: numberFromEnv("TTS_RATE", 0),
      volume: numberFromEnv("TTS_VOLUME", 90)
    },
    agent: {
      name: process.env.AGENT_NAME || "一白",
      persona:
        process.env.AGENT_PERSONA ||
        "你是一个普通的中文 AI 助手。请自然、简洁地回答用户问题。",
      speakCooldownMs: numberFromEnv("SPEAK_COOLDOWN_MS", 8_000),
      idlePromptMs: numberFromEnv("IDLE_PROMPT_MS", 45_000),
      maxRecentDanmaku: numberFromEnv("MAX_RECENT_DANMAKU", 20)
    }
  };
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function optionalNumberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function listFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toolProfileFromEnv(name: string, fallback: "guided" | "layered" | "full"): "guided" | "layered" | "full" {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "layered" || raw === "full" || raw === "guided") return raw;
  return fallback;
}
