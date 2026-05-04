import "dotenv/config";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { createAgentGraph } from "../src/agent-core/graph/createAgentGraph.js";
import type { AgentGraphState } from "../src/agent-core/graph/AgentState.js";
import { McpProbeClient, readProbeLog } from "../src/mcp/McpProbeClient.js";
import { createMcpLangChainTools } from "../src/mcp/mcpToolBridge.js";

const config = loadConfig(["node", "smoke", "--mock"]);
const logFile = resolve(process.cwd(), "mcp_probe.log");
const probeMessage = `deepseek-mcp-smoke-${Date.now()}`;

if (!config.llm.apiKey) {
  throw new Error("LLM_API_KEY is required for real DeepSeek MCP smoke test");
}

await rm(logFile, { force: true });

const mcpClient = new McpProbeClient({ logFile });
try {
  await mcpClient.connect();
  const mcpTools = await createMcpLangChainTools(mcpClient, { allowedTools: ["probe_tool", "fail_tool"] });
  const notes: string[] = [];
  const graph = createAgentGraph({
    config: {
      ...config,
      agent: {
        ...config.agent,
        persona:
          "你是 MCP smoke test 智能体。你必须先调用 probe_tool，message 必须完全使用用户给出的 probeMessage，然后再输出最终 JSON。"
      }
    },
    shouldRespond: () => true,
    extraTools: mcpTools,
    maxToolLoops: 2,
    toolContext: {
      getGameSummary: () => "MCP smoke test: no game state",
      rememberNote: (note) => notes.push(note)
    }
  });

  const inputEvent = {
      type: "danmaku",
      id: "dm_mcp_smoke",
      ts: Date.now(),
      user: "测试观众",
      text: `请调用 probe_tool，probeMessage=${probeMessage}`
    } as const;

  const initialState: AgentGraphState = {
    inputEvent,
    inputEvents: [inputEvent],
    runId: "run_mcp_smoke",
    persona: config.agent.persona,
    trigger: `请调用 probe_tool，probeMessage=${probeMessage}`,
    gameSummary: undefined,
    mode: "chat",
    route: "chat",
    shouldStartGame: false,
    gameState: undefined,
    availableActions: [],
    observedAt: undefined,
    gameOver: false,
    gameSession: {
      status: "idle",
      tickCount: 0,
      actionCount: 0
    },
    audienceContext: {
      currentEvents: [inputEvent],
      recentMessages: [],
      giftEvents: [],
      adminCommands: []
    },
    lastToolCategory: undefined,
    gameActionExecuted: false,
    lastToolError: undefined,
    recentDanmaku: [`测试观众: 请调用 probe_tool，probeMessage=${probeMessage}`],
    recentReplies: [],
    conversationHistory: [],
    shouldRespond: false,
    messages: [],
    deepseekMessages: [],
    toolResults: [],
    toolLoopCount: 0,
    expressedDecision: undefined,
    memoryNotes: [],
    decision: undefined
  };

  const result = await graph.invoke(initialState);
  const logEvents = await readProbeLog(logFile);
  const matched = logEvents.find((event) => event.message === probeMessage);

  if (!matched) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: "probe_tool did not write a matching log event",
          probeMessage,
          toolResults: result.toolResults,
          decision: result.decision,
          logEvents
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify(
        {
          ok: true,
          uuid: matched.id,
          probeMessage,
          toolResults: result.toolResults,
          decision: result.decision,
          logFile
        },
        null,
        2
      )
    );
  }
} finally {
  await mcpClient.close();
}
