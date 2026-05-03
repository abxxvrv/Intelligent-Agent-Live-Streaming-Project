import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { createMcpLangChainTools } from "../src/mcp/mcpToolBridge.js";
import { StdioMcpClient } from "../src/mcp/StdioMcpClient.js";

const config = loadConfig(["node", "smoke-sts2-mcp"]);
const client = new StdioMcpClient({
  name: "sts2-live-agent-sts2-smoke",
  command: config.sts2Mcp.command,
  args: config.sts2Mcp.args,
  cwd: config.sts2Mcp.cwd,
  env: {
    STS2_API_BASE_URL: config.sts2Mcp.apiBaseUrl,
    STS2_MCP_TOOL_PROFILE: config.sts2Mcp.toolProfile,
    STS2_ENABLE_DEBUG_ACTIONS: "0"
  }
});

try {
  await client.connect();
  const tools = await client.listTools();
  const toolNames = tools.map((item) => item.name).sort();
  const wrappedTools = await createMcpLangChainTools(client, {
    allowedTools: config.sts2Mcp.allowedTools
  });
  const healthTool = wrappedTools.find((item) => item.name === "health_check");

  if (!healthTool) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: "health_check was not exposed by the STS2 MCP server",
          toolNames
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } else {
    try {
      const health = await healthTool.invoke({});
      console.log(
        JSON.stringify(
          {
            ok: true,
            health: parseToolJson(String(health)),
            toolNames,
            command: config.sts2Mcp.command,
            cwd: config.sts2Mcp.cwd
          },
          null,
          2
        )
      );
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            reason:
              "STS2 MCP started and listed tools, but health_check could not reach the game Mod. Start Slay the Spire 2 with the STS2AIAgent mod, then verify http://127.0.0.1:8080/health.",
            error: error instanceof Error ? error.message : String(error),
            toolNames,
            command: config.sts2Mcp.command,
            cwd: config.sts2Mcp.cwd
          },
          null,
          2
        )
      );
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        reason:
          "Unable to start the STS2 MCP stdio server. Check STS2_MCP_COMMAND, STS2_MCP_ARGS, and STS2_MCP_CWD.",
        error: error instanceof Error ? error.message : String(error),
        command: config.sts2Mcp.command,
        args: config.sts2Mcp.args,
        cwd: config.sts2Mcp.cwd
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  await client.close();
}

function parseToolJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
