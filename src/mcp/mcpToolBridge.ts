import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolClient } from "./StdioMcpClient.js";

export async function createMcpLangChainTools(
  client: McpToolClient,
  options: { allowedTools?: string[] } = {}
): Promise<StructuredToolInterface[]> {
  const mcpTools = await client.listTools();
  const allow = new Set(options.allowedTools || mcpTools.map((item) => item.name));
  return mcpTools
    .filter((item) => allow.has(item.name))
    .map((mcpTool) => wrapMcpTool(client, mcpTool));
}

function wrapMcpTool(client: McpToolClient, mcpTool: Tool): StructuredToolInterface {
  return tool(
    async (input: Record<string, unknown>) => {
      const result = await client.callTool(mcpTool.name, input);
      if (result.isError) {
        throw new Error(extractToolText(result) || `MCP tool ${mcpTool.name} failed`);
      }
      return JSON.stringify({
        content: result.content,
        structuredContent: result.structuredContent
      });
    },
    {
      name: mcpTool.name,
      description: mcpTool.description || `MCP tool ${mcpTool.name}`,
      schema: mcpTool.inputSchema
    }
  );
}

function extractToolText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content || [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}
