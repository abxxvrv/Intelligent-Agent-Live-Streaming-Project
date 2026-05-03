import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export type StdioMcpClientOptions = {
  name?: string;
  version?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export class StdioMcpClient {
  private client?: Client;
  private transport?: StdioClientTransport;

  constructor(private readonly options: StdioMcpClientOptions) {}

  async connect(): Promise<void> {
    if (this.client) return;

    this.transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args || [],
      cwd: this.options.cwd || process.cwd(),
      env: filterEnv({
        ...process.env,
        ...(this.options.env || {})
      }),
      stderr: "pipe"
    });
    this.client = new Client({
      name: this.options.name || "sts2-live-agent-mcp",
      version: this.options.version || "0.1.0"
    });
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client?.close();
    await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
  }

  async listTools(): Promise<Tool[]> {
    const result = await this.ensureClient().listTools();
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return this.ensureClient().callTool({ name, arguments: args }) as Promise<CallToolResult>;
  }

  private ensureClient(): Client {
    if (!this.client) throw new Error("MCP client is not connected");
    return this.client;
  }
}

export type McpToolClient = Pick<StdioMcpClient, "listTools" | "callTool">;

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") filtered[key] = value;
  }
  return filtered;
}
