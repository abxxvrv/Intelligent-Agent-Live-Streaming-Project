import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { McpProbeClient, readProbeLog } from "../src/mcp/McpProbeClient.js";
import { createMcpLangChainTools } from "../src/mcp/mcpToolBridge.js";

describe("MCP probe client", () => {
  it("lists probe tools and verifies probe_tool writes a UUID to the log", async () => {
    const logFile = resolve(process.cwd(), "tests", ".tmp", "probe-direct.mcp_probe.log");
    await resetLog(logFile);
    const client = new McpProbeClient({ logFile });

    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((item) => item.name).sort()).toEqual(["fail_tool", "probe_tool"]);

      const event = await client.callProbeTool("direct-test");
      expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(event.message).toBe("direct-test");

      const logEvents = await readProbeLog(logFile);
      expect(logEvents.some((item) => item.id === event.id)).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("wraps MCP tools as LangChain tools and preserves fail_tool errors", async () => {
    const logFile = resolve(process.cwd(), "tests", ".tmp", "probe-bridge.mcp_probe.log");
    await resetLog(logFile);
    const client = new McpProbeClient({ logFile });

    try {
      await client.connect();
      const tools = await createMcpLangChainTools(client, { allowedTools: ["probe_tool", "fail_tool"] });
      expect(tools.map((item) => item.name).sort()).toEqual(["fail_tool", "probe_tool"]);

      const probe = tools.find((item) => item.name === "probe_tool");
      const output = await probe?.invoke({ message: "bridge-test" });
      expect(String(output)).toContain("bridge-test");

      const fail = tools.find((item) => item.name === "fail_tool");
      await expect(fail?.invoke({ reason: "expected failure" })).rejects.toThrow(/expected failure/);
    } finally {
      await client.close();
    }
  }, 30_000);
});

async function resetLog(logFile: string): Promise<void> {
  await mkdir(dirname(logFile), { recursive: true });
  await rm(logFile, { force: true });
}
