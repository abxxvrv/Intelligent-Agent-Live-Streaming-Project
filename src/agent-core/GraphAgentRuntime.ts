import type { AppConfig } from "../config.js";
import type { DebugControl } from "../debug/DebugControl.js";
import type { EventBus } from "../events/EventBus.js";
import { createMcpLangChainTools } from "../mcp/mcpToolBridge.js";
import { StdioMcpClient } from "../mcp/StdioMcpClient.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { InputEvent } from "../types.js";
import { newId } from "../utils/id.js";
import { Logger } from "../utils/logger.js";
import { AutoplayRunner } from "./autoplay/AutoplayRunner.js";
import { createAutoplayTools } from "./autoplay/tools.js";
import { Memory } from "./Memory.js";
import { describeTrigger } from "./Policy.js";
import { createAgentGraph } from "./graph/createAgentGraph.js";
import type { AgentGraphState } from "./graph/AgentState.js";

export class GraphAgentRuntime {
  private readonly memory: Memory;
  private readonly notes: string[] = [];
  private readonly logger = new Logger("graph-agent-runtime");
  private graph: ReturnType<typeof createAgentGraph>;
  private mcpClient?: StdioMcpClient;
  private bus?: EventBus;
  private mcpExtraTools: StructuredToolInterface[] = [];
  private autoplayExtraTools: StructuredToolInterface[] = [];
  private autoplayRunner?: AutoplayRunner;
  private sts2McpToolsEnabled = false;

  constructor(
    private readonly config: AppConfig,
    private readonly debugControl?: DebugControl
  ) {
    this.memory = new Memory(config.agent.maxRecentDanmaku);
    this.graph = this.createGraph();
  }

  start(bus: EventBus): void {
    this.bus = bus;
    void this.connectSts2Mcp();
    bus.on("debug-control", (event) => {
      if (!event.autoplayEnabled) this.autoplayRunner?.stop("手动接管已关闭");
      this.graph = this.createGraph();
    });
    bus.on("danmaku", (event) => {
      if (isDebugDanmaku(event)) void this.handleInput(bus, event);
    });
    bus.on("game-state", (event) => this.memory.setGameState(event.state));
  }

  async stop(): Promise<void> {
    this.autoplayRunner?.stop("服务关闭");
    await this.mcpClient?.close();
    this.mcpClient = undefined;
  }

  private async connectSts2Mcp(): Promise<void> {
    if (!this.config.sts2Mcp.enabled) return;

    const mcpClient = new StdioMcpClient({
      name: "sts2-live-agent-sts2-mcp",
      command: this.config.sts2Mcp.command,
      args: this.config.sts2Mcp.args,
      cwd: this.config.sts2Mcp.cwd,
      env: {
        STS2_API_BASE_URL: this.config.sts2Mcp.apiBaseUrl,
        STS2_MCP_TOOL_PROFILE: this.config.sts2Mcp.toolProfile,
        STS2_ENABLE_DEBUG_ACTIONS: "0"
      }
    });

    try {
      await mcpClient.connect();
      const extraTools = await createMcpLangChainTools(mcpClient, {
        allowedTools: getAllowedSts2McpTools(this.config)
      });
      this.mcpExtraTools = extraTools;
      this.autoplayRunner = this.createAutoplayRunner(extraTools);
      this.autoplayExtraTools = createAutoplayTools(this.autoplayRunner);
      this.sts2McpToolsEnabled = true;
      this.graph = this.createGraph();
      this.mcpClient = mcpClient;
      this.logger.info("connected STS2 MCP", {
        cwd: this.config.sts2Mcp.cwd,
        tools: extraTools.map((item) => item.name)
      });
    } catch (error) {
      await mcpClient.close();
      this.logger.warn("unable to connect STS2 MCP; continuing without MCP tools", error);
    }
  }

  private async handleInput(bus: EventBus, event: InputEvent): Promise<void> {
    if (event.type === "danmaku") this.memory.addDanmaku(event);
    if (event.type === "danmaku") this.applyDebugControlCommand(bus, event.text);

    const initialState = this.createInitialState(event);
    bus.publish({
      type: "agent-trace",
      id: newId("trace"),
      ts: Date.now(),
      runId: initialState.runId,
      sourceEventId: event.id,
      stage: "run-start",
      title: "开始处理",
      message: describeTrigger(event)
    });
    const result = await this.invokeGraphSafely(bus, initialState);

    if (!result.decision?.shouldSpeak) return;

    if (event.type === "danmaku") this.memory.addConversationTurn(event.text, result.decision.say);
    this.memory.addReply(result.decision.say);
    bus.publish({
      type: "agent-reply",
      id: newId("reply"),
      ts: Date.now(),
      sourceEventId: event.id,
      decision: result.decision
    });
  }

  private createInitialState(event: InputEvent): AgentGraphState {
    return {
      inputEvent: event,
      runId: newId("run"),
      persona: this.config.agent.persona,
      trigger: describeTrigger(event),
      gameSummary: undefined,
      recentDanmaku: this.memory.getRecentDanmaku().map((item) => `${item.user}: ${item.text}`),
      recentReplies: this.memory.getRecentReplies(),
      conversationHistory: this.memory.getConversationHistory(),
      shouldRespond: true,
      messages: [],
      toolResults: [],
      toolLoopCount: 0,
      memoryNotes: [...this.notes],
      decision: undefined
    };
  }

  private rememberNote(note: string): void {
    const cleaned = note.trim();
    if (!cleaned) return;
    this.notes.push(cleaned);
    while (this.notes.length > 50) this.notes.shift();
  }

  private createGraph(): ReturnType<typeof createAgentGraph> {
    return createAgentGraph({
      config: this.config,
      logger: this.logger,
      sts2McpToolsEnabled: this.sts2McpToolsEnabled,
      canUseSts2Actions: () => this.canUseSts2Actions(),
      onToolCall: (event) => this.bus?.publish(event),
      onTrace: (event) => this.bus?.publish(event),
      shouldRespond: () => true,
      toolContext: {
        getGameSummary: () => this.memory.getGameState()?.summary,
        rememberNote: (note) => this.rememberNote(note)
      },
      extraTools: this.getActiveMcpTools(),
      maxToolLoops: this.config.sts2Mcp.allowActions ? 4 : 2
    });
  }

  private getActiveMcpTools(): StructuredToolInterface[] {
    const mcpTools = this.mcpExtraTools.filter((tool) => tool.name !== "act");
    return [...mcpTools, ...this.autoplayExtraTools];
  }

  private canUseSts2Actions(): boolean {
    return Boolean(this.config.sts2Mcp.allowActions && this.debugControl?.isAutoplayEnabled());
  }

  private createAutoplayRunner(tools: StructuredToolInterface[]): AutoplayRunner {
    return new AutoplayRunner({
      config: this.config,
      tools,
      canUseActions: () => this.canUseSts2Actions(),
      onTrace: (event) => this.bus?.publish(event),
      onToolCall: (event) => this.bus?.publish(event),
      onReply: (event) => {
        this.memory.addReply(event.decision.say);
        this.bus?.publish(event);
      }
    });
  }

  private async invokeGraphSafely(bus: EventBus, initialState: AgentGraphState): Promise<AgentGraphState> {
    try {
      return await this.graph.invoke(initialState, {
        recursionLimit: 30
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("LangGraph run failed", error);
      bus.publish({
        type: "agent-trace",
        id: newId("trace"),
        ts: Date.now(),
        runId: initialState.runId,
        sourceEventId: initialState.inputEvent.id,
        stage: "final",
        title: "运行失败",
        message,
        status: "error"
      });
      return {
        ...initialState,
        decision: {
          say: `这次处理被中断了：${message.slice(0, 80)}`,
          emotion: "awkward",
          avatarAction: "talk",
          shouldSpeak: true,
          gameIntent: "none"
        }
      };
    }
  }

  private applyDebugControlCommand(bus: EventBus, text: string): void {
    if (!this.debugControl) return;
    const normalized = text.trim();
    const shouldStart = /开始接管|自动玩|接管|开始玩/.test(normalized);
    const shouldStop = /暂停|停手|别动|不要动|停止接管|只讲解/.test(normalized);
    if (!shouldStart && !shouldStop) return;

    const autoplayEnabled = this.debugControl.setAutoplayEnabled(shouldStart && !shouldStop);
    bus.publish({
      type: "debug-control",
      id: newId("debug_ctl"),
      ts: Date.now(),
      autoplayEnabled,
      source: "danmaku-command"
    });
  }
}

function getAllowedSts2McpTools(config: AppConfig): string[] {
  if (config.sts2Mcp.allowActions) return config.sts2Mcp.allowedTools;
  return config.sts2Mcp.allowedTools.filter((name) => name !== "act");
}

function isDebugDanmaku(event: InputEvent): boolean {
  return event.type === "danmaku" && isRecord(event.raw) && event.raw.source === "debug";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
