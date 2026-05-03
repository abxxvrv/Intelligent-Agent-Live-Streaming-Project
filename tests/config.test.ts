import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig MCP settings", () => {
  it("keeps mock sources disabled by default and allows --mock override", () => {
    const previous = snapshotEnv(["MOCK_BILI", "MOCK_STS2"]);

    try {
      delete process.env.MOCK_BILI;
      delete process.env.MOCK_STS2;

      const defaultConfig = loadConfig(["node", "test"]);
      const mockConfig = loadConfig(["node", "test", "--mock"]);

      expect(defaultConfig.mockBili).toBe(false);
      expect(defaultConfig.mockSts2).toBe(false);
      expect(mockConfig.mockBili).toBe(true);
      expect(mockConfig.mockSts2).toBe(true);
    } finally {
      restoreEnv(previous);
    }
  });

  it("parses STS2 MCP settings from environment", () => {
    const previous = snapshotEnv([
      "STS2_MCP_ENABLED",
      "STS2_MCP_COMMAND",
      "STS2_MCP_ARGS",
      "STS2_MCP_CWD",
      "STS2_API_BASE_URL",
      "STS2_MCP_TOOL_PROFILE",
      "STS2_MCP_ALLOWED_TOOLS",
      "STS2_MCP_ALLOW_ACTIONS"
    ]);

    try {
      process.env.STS2_MCP_ENABLED = "true";
      process.env.STS2_MCP_COMMAND = "python.exe";
      process.env.STS2_MCP_ARGS = "-m,sts2_mcp.server";
      process.env.STS2_MCP_CWD = "E:\\sts2-ai-agent-v0.6.0-windows\\mcp_server";
      process.env.STS2_API_BASE_URL = "http://127.0.0.1:8080/";
      process.env.STS2_MCP_TOOL_PROFILE = "guided";
      process.env.STS2_MCP_ALLOWED_TOOLS = "health_check,get_game_state,act";
      process.env.STS2_MCP_ALLOW_ACTIONS = "1";

      const config = loadConfig(["node", "test"]);

      expect(config.sts2Mcp.enabled).toBe(true);
      expect(config.sts2Mcp.command).toBe("python.exe");
      expect(config.sts2Mcp.args).toEqual(["-m", "sts2_mcp.server"]);
      expect(config.sts2Mcp.cwd).toBe("E:\\sts2-ai-agent-v0.6.0-windows\\mcp_server");
      expect(config.sts2Mcp.apiBaseUrl).toBe("http://127.0.0.1:8080");
      expect(config.sts2Mcp.toolProfile).toBe("guided");
      expect(config.sts2Mcp.allowedTools).toEqual(["health_check", "get_game_state", "act"]);
      expect(config.sts2Mcp.allowActions).toBe(true);
    } finally {
      restoreEnv(previous);
    }
  });
});

function snapshotEnv(names: string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
