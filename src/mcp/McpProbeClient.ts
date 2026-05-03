import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { StdioMcpClient } from "./StdioMcpClient.js";

export type McpProbeEvent = {
  id: string;
  message: string;
  executed_at: string;
  pid: number;
};

export type McpProbeClientOptions = {
  command?: string;
  serverPath?: string;
  logFile?: string;
  cwd?: string;
};

export class McpProbeClient {
  private client?: StdioMcpClient;

  constructor(private readonly options: McpProbeClientOptions = {}) {}

  async connect(): Promise<void> {
    if (this.client) return;
    const cwd = this.options.cwd || process.cwd();
    const serverPath = this.options.serverPath || resolve(cwd, "scripts", "mcp_probe.py");
    const logFile = this.options.logFile || resolve(cwd, "mcp_probe.log");
    const env = {
      ...process.env,
      MCP_PROBE_LOG: logFile
    };

    this.client = new StdioMcpClient({
      name: "sts2-live-agent-mcp-probe",
      command: this.options.command || "python",
      args: [serverPath],
      cwd,
      env
    });
    await this.client.connect();
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  async listTools(): Promise<Tool[]> {
    return this.ensureClient().listTools();
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return this.ensureClient().callTool(name, args);
  }

  async callProbeTool(message: string): Promise<McpProbeEvent> {
    const result = await this.callTool("probe_tool", { message });
    return extractProbeEvent(result);
  }

  private ensureClient(): StdioMcpClient {
    if (!this.client) throw new Error("MCP probe client is not connected");
    return this.client;
  }
}

export async function readProbeLog(logFile: string): Promise<McpProbeEvent[]> {
  try {
    const content = await readFile(logFile, "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as McpProbeEvent);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function extractProbeEvent(result: CallToolResult): McpProbeEvent {
  const structured = result.structuredContent;
  if (isProbeEvent(structured)) return structured;
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("MCP probe result did not include text content");
  const parsed = JSON.parse(text) as unknown;
  if (!isProbeEvent(parsed)) {
    throw new Error(`MCP probe result was not a probe event: ${text}`);
  }
  return parsed;
}

function isProbeEvent(value: unknown): value is McpProbeEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.message === "string" &&
    typeof record.executed_at === "string" &&
    typeof record.pid === "number"
  );
}
