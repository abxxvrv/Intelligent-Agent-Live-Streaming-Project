import type { AppConfig } from "../config.js";
import type { DebugControl } from "../debug/DebugControl.js";
import type { EventBus } from "../events/EventBus.js";
import { createMcpLangChainTools } from "../mcp/mcpToolBridge.js";
import { StdioMcpClient } from "../mcp/StdioMcpClient.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentDecision, InputEvent } from "../types.js";
import { newId } from "../utils/id.js";
import { Logger } from "../utils/logger.js";
import { AutoplayRunner } from "./autoplay/AutoplayRunner.js";
import { createAutoplayTools } from "./autoplay/tools.js";
import { Memory } from "./Memory.js";
import { describeTrigger } from "./Policy.js";
import { createAgentGraph, writeAgentGraphMermaidText } from "./graph/createAgentGraph.js";
import { createExpressTool } from "./graph/expressTool.js";
import { createRecentChatMessagesTool } from "./graph/liveTools.js";
import type { AgentGraphState, AgentMode, AudienceContext, GameSession } from "./graph/AgentState.js";

export class GraphAgentRuntime {
  private readonly memory: Memory;
  private readonly recentGifts: Array<{ user: string; giftName: string; count: number; ts: number }> = [];
  private readonly notes: string[] = [];
  private readonly logger = new Logger("graph-agent-runtime");
  private graph: ReturnType<typeof createAgentGraph>;
  private mcpClient?: StdioMcpClient;
  private bus?: EventBus;
  private mcpExtraTools: StructuredToolInterface[] = [];
  private autoplayExtraTools: StructuredToolInterface[] = [];
  private autoplayRunner?: AutoplayRunner;
  private sts2McpToolsEnabled = false;
  private graphMermaidPrinted = false;
  private readonly eventQueue: InputEvent[] = [];
  private processingQueue = false;
  private runtimeMode: AgentMode = "chat";
  private gameSession: GameSession = {
    status: "idle",
    tickCount: 0,
    actionCount: 0
  };

  constructor(
    private readonly config: AppConfig,
    private readonly debugControl?: DebugControl
  ) {
    this.memory = new Memory(config.agent.maxRecentDanmaku);
    this.graph = this.createGraph();
    this.writeGraphMermaidOnce(this.graph);
  }

  start(bus: EventBus): void {
    this.bus = bus;
    void this.connectSts2Mcp();
    bus.on("debug-control", (event) => {
      if (event.source === "runtime") return;
      this.enqueueInput(bus, event);
    });
    bus.on("danmaku", (event) => {
      this.memory.addDanmaku(event);
      if (this.runtimeMode === "game") {
        if (isGameModeControlDanmaku(event) || isDebugInput(event)) {
          this.enqueueInput(bus, event);
        }
        return;
      }

      this.enqueueInput(bus, event);
    });
    bus.on("gift", (event) => {
      this.addGiftMemory(event);
      if (this.runtimeMode === "game") {
        if (isDebugInput(event)) {
          this.enqueueInput(bus, event);
        }
        return;
      }

      this.enqueueInput(bus, event);
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

  private enqueueInput(bus: EventBus, event: InputEvent): void {
    if (event.type === "game-tick") {
      const hasPendingGameTick = this.eventQueue.some((item) => item.type === "game-tick");
      if (hasPendingGameTick) {
        this.logger.info("duplicate game tick ignored", {
          eventId: event.id,
          reason: event.reason,
          queueLength: this.eventQueue.length
        });
        return;
      }
    }

    this.eventQueue.push(event);
    const queueLength = this.eventQueue.length;
    const eventFields = eventLogFields(event);
    this.logger.info("queued live event", {
      eventType: event.type,
      eventId: event.id,
      rawSource: rawSourceOf(event),
      queueLength,
      ...eventFields
    });
    bus.publish({
      type: "agent-trace",
      id: newId("trace"),
      ts: Date.now(),
      runId: "queue",
      sourceEventId: event.id,
      stage: "queue",
      title: "事件入队",
      message: `收到 ${event.type}，当前队列 ${queueLength} 条`,
      detail: {
        eventType: event.type,
        queueLength,
        rawSource: rawSourceOf(event),
        ...eventFields
      }
    });
    void this.processQueue(bus);
  }

  private enqueueGameStep(
    bus: EventBus,
    reason: "manual" | "after-action" | "timer" = "after-action"
  ): void {
    const hasPendingGameTick = this.eventQueue.some((event) => event.type === "game-tick");

    if (hasPendingGameTick) {
      this.logger.info("game tick coalesced", {
        reason,
        queueLength: this.eventQueue.length
      });
      return;
    }

    this.enqueueInput(bus, {
      type: "game-tick",
      id: newId("game_tick"),
      ts: Date.now(),
      reason
    });
  }

  private async processQueue(bus: EventBus): Promise<void> {
    if (this.processingQueue) return;

    this.logger.info("event queue processing started", {
      queueLength: this.eventQueue.length
    });
    this.processingQueue = true;
    try {
      while (this.eventQueue.length) {
        const batch = await this.takeEventBatch();
        if (batch.length) await this.handleBatchInput(bus, batch);
      }
    } finally {
      this.processingQueue = false;
      if (this.eventQueue.length) void this.processQueue(bus);
    }
  }

  private async takeEventBatch(): Promise<InputEvent[]> {
    await sleep(300);
    const batch = this.eventQueue.splice(0, 20);
    this.logger.info("created live event batch", {
      batchSize: batch.length,
      eventIds: batch.map((event) => event.id),
      eventTypes: batch.map((event) => event.type),
      remainingQueueLength: this.eventQueue.length
    });
    return batch;
  }

  private async handleBatchInput(bus: EventBus, events: InputEvent[]): Promise<void> {
    const initialState = this.createInitialState(events);
    bus.publish({
      type: "agent-trace",
      id: newId("trace"),
      ts: Date.now(),
      runId: initialState.runId,
      sourceEventId: initialState.inputEvent.id,
      stage: "batch",
      title: "批次开始",
      message: `本批处理 ${events.length} 条事件`,
      detail: {
        batchSize: events.length,
        eventIds: events.map((event) => event.id),
        eventTypes: events.map((event) => event.type)
      }
    });
    bus.publish({
      type: "agent-trace",
      id: newId("trace"),
      ts: Date.now(),
      runId: initialState.runId,
      sourceEventId: initialState.inputEvent.id,
      stage: "run-start",
      title: "开始处理",
      message: `进入 parent_graph，事件数：${events.length}`,
      detail: {
        batchSize: events.length,
        trigger: initialState.trigger.slice(0, 160)
      }
    });
    this.logger.info("graph run started", {
      runId: initialState.runId,
      sourceEventId: initialState.inputEvent.id,
      batchSize: events.length,
      trigger: initialState.trigger.slice(0, 160)
    });

    const startedAt = Date.now();
    const result = await this.invokeGraphSafely(bus, initialState);
    const durationMs = Date.now() - startedAt;
    const previousMode = this.runtimeMode;
    this.runtimeMode = result.mode ?? this.runtimeMode;
    this.gameSession = result.gameSession ?? this.gameSession;
    const switchedIntoGameMode = previousMode !== "game" && this.runtimeMode === "game";
    const shouldScheduleNextGameStep = this.shouldScheduleNextGameStep(result);
    if (previousMode !== this.runtimeMode) {
      this.debugControl?.setMode(this.runtimeMode);
      bus.publish({
        type: "debug-control",
        id: newId("debug_ctl"),
        ts: Date.now(),
        mode: this.runtimeMode,
        source: "runtime"
      });
      bus.publish({
        type: "agent-trace",
        id: newId("trace"),
        ts: Date.now(),
        runId: initialState.runId,
        sourceEventId: initialState.inputEvent.id,
        stage: "mode-transition",
        title: "Runtime 模式切换",
        message: `${previousMode} -> ${this.runtimeMode}`,
        detail: {
          previousMode,
          mode: this.runtimeMode,
          gameSession: this.gameSession
        }
      });
    }
    this.logger.info("graph run completed", {
      runId: initialState.runId,
      durationMs,
      shouldSpeak: result.decision?.shouldSpeak ?? false,
      hasExpressedDecision: Boolean(result.expressedDecision),
      mode: result.mode,
      route: result.route,
      shouldStartGame: result.shouldStartGame,
      remainingQueueLength: this.eventQueue.length
    });
    bus.publish({
      type: "agent-trace",
      id: newId("trace"),
      ts: Date.now(),
      runId: initialState.runId,
      sourceEventId: initialState.inputEvent.id,
      stage: "run-end",
      title: "处理完成",
      message: `本次 graph run 结束，用时 ${durationMs}ms`,
      detail: {
        durationMs,
        mode: result.mode,
        route: result.route,
        runtimeMode: this.runtimeMode,
        gameSession: this.gameSession,
        shouldStartGame: result.shouldStartGame,
        shouldSpeak: result.decision?.shouldSpeak ?? false,
        hasExpressedDecision: Boolean(result.expressedDecision),
        remainingQueueLength: this.eventQueue.length
      }
    });

    if (shouldScheduleNextGameStep) {
      this.enqueueGameStep(bus, switchedIntoGameMode ? "manual" : "after-action");
    }

    if (result.expressedDecision) {
      const replyForMemory = replyTextForMemory(result.expressedDecision);
      const userText = conversationTextForBatch(events);
      if (userText) this.memory.addConversationTurn(userText, replyForMemory);
      this.memory.addReply(replyForMemory);
      return;
    }

    if (!result.decision?.shouldSpeak) return;

    const replyForMemory = replyTextForMemory(result.decision);
    const userText = conversationTextForBatch(events);
    if (userText) this.memory.addConversationTurn(userText, replyForMemory);
    this.memory.addReply(replyForMemory);
    bus.publish({
      type: "agent-reply",
      id: newId("reply"),
      ts: Date.now(),
      sourceEventId: initialState.inputEvent.id,
      decision: result.decision
    });
  }

  private shouldScheduleNextGameStep(result: AgentGraphState): boolean {
    const session = result.gameSession ?? this.gameSession;

    return (
      this.runtimeMode === "game" &&
      result.mode === "game" &&
      result.gameOver !== true &&
      session.status === "running"
    );
  }

  private createInitialState(events: InputEvent[]): AgentGraphState {
    const primaryEvent = events[0];

    return {
      inputEvent: primaryEvent,
      inputEvents: events,
      runId: newId("run"),
      persona: this.config.agent.persona,
      trigger: events.map(describeTrigger).join("\n"),
      gameSummary: this.memory.getGameState()?.summary,
      mode: this.runtimeMode,
      route: this.runtimeMode,
      shouldStartGame: false,
      gameState: undefined,
      availableActions: [],
      observedAt: undefined,
      gameOver: false,
      gameSession: this.gameSession,
      audienceContext: this.buildAudienceContext(events),
      lastToolCategory: undefined,
      gameActionExecuted: false,
      lastToolError: undefined,
      recentDanmaku: this.memory.getRecentDanmaku().map((item) => `${item.user}: ${item.text}`),
      recentReplies: this.memory.getRecentReplies(),
      conversationHistory: this.memory.getConversationHistory(),
      shouldRespond: true,
      messages: [],
      deepseekMessages: [],
      toolResults: [],
      toolLoopCount: 0,
      expressedDecision: undefined,
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

  private addGiftMemory(event: Extract<InputEvent, { type: "gift" }>): void {
    this.recentGifts.push({
      user: event.user,
      giftName: event.giftName,
      count: event.count,
      ts: event.ts
    });
    while (this.recentGifts.length > 80) this.recentGifts.shift();
  }

  private buildAudienceContext(events: InputEvent[]): AudienceContext {
    return {
      currentEvents: events,
      recentMessages: this.memory
        .getRecentDanmaku()
        .slice(-20)
        .map((item) => ({
          user: item.user,
          text: item.text,
          ts: item.ts
        })),
      giftEvents: this.recentGifts
        .slice(-20)
        .map((event) => ({
          user: event.user,
          giftName: event.giftName,
          count: event.count,
          ts: event.ts
        })),
      adminCommands: events
        .filter((event): event is Extract<InputEvent, { type: "danmaku" }> => event.type === "danmaku")
        .filter((event) => event.text.trim().startsWith("/"))
        .map((event) => event.text.trim())
    };
  }

  private getRecentLiveInputs(input: {
    limit?: number;
    windowMs?: number;
    includeGifts?: boolean;
  }): unknown {
    const limit = input.limit ?? 10;
    const windowMs = input.windowMs ?? 10_000;
    const cutoff = Date.now() - windowMs;
    const messages = this.memory
      .getRecentDanmaku()
      .filter((item) => item.ts >= cutoff)
      .slice(-limit)
      .map((item) => ({
        user: item.user,
        text: item.text,
        ts: item.ts
      }));
    const gifts = input.includeGifts === false
      ? []
      : this.recentGifts
          .filter((item) => item.ts >= cutoff)
          .slice(-limit)
          .map((item) => ({ ...item }));

    return {
      mode: this.runtimeMode,
      gameSession: this.gameSession,
      windowMs,
      messages,
      gifts
    };
  }

  private createGraph(): ReturnType<typeof createAgentGraph> {
    return createAgentGraph({
      config: this.config,
      logger: this.logger,
      sts2McpToolsEnabled: this.sts2McpToolsEnabled,
      canUseSts2Actions: () => this.canUseSts2Actions(),
      onToolCall: (event) => this.bus?.publish(event),
      onReply: (event) => this.bus?.publish(event),
      onTrace: (event) => this.bus?.publish(event),
      debugDeepSeekRawOutput: true,
      debugDeepSeekRawOutputIncludeReasoning: true,
      debugDeepSeekRawOutputToTrace: false,
      shouldRespond: () => true,
      chatTools: this.getChatTools(),
      gameTools: this.getGameTools(),
      maxToolLoops: 3
    });
  }

  private writeGraphMermaidOnce(graph: ReturnType<typeof createAgentGraph>): void {
    if (this.graphMermaidPrinted) return;
    this.graphMermaidPrinted = true;
    void writeAgentGraphMermaidText(graph)
      .then(() => {
        this.logger.info("LangGraph mermaid written to logs/agent-debug-output.log");
      })
      .catch((error) => {
        this.logger.warn("unable to write LangGraph Mermaid text", error);
      });
  }

  private getChatTools(): StructuredToolInterface[] {
    return [createExpressTool()];
  }

  private getGameTools(): StructuredToolInterface[] {
    return [
      createExpressTool(),
      createRecentChatMessagesTool({
        getRecentLiveInputs: (input) => this.getRecentLiveInputs(input)
      }),
      ...this.mcpExtraTools
    ];
  }

  private getActiveMcpTools(): StructuredToolInterface[] {
    return this.getGameTools();
  }

  private canUseSts2Actions(): boolean {
    return Boolean(this.config.sts2Mcp.allowActions);
  }

  private createAutoplayRunner(tools: StructuredToolInterface[]): AutoplayRunner {
    return new AutoplayRunner({
      config: this.config,
      tools,
      canUseActions: () => this.canUseSts2Actions(),
      onTrace: (event) => this.bus?.publish(event),
      onToolCall: (event) => this.bus?.publish(event),
      onReply: (event) => {
        this.memory.addReply(replyTextForMemory(event.decision));
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
      this.logger.warn("LangGraph run failed", {
        runId: initialState.runId,
        batchSize: initialState.inputEvents.length || 1,
        sourceEventId: initialState.inputEvent.id,
        error
      });
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
          say: "ごめん、今ちょっと処理に失敗したみたい。",
          subtitleJa: "ごめん、今ちょっと処理に失敗したみたい。",
          subtitleZh: `这次处理被中断了：${message.slice(0, 80)}`,
          emotion: "awkward",
          avatarAction: "talk",
          shouldSpeak: true,
          gameIntent: "none"
        }
      };
    }
  }

}

function getAllowedSts2McpTools(config: AppConfig): string[] {
  return config.sts2Mcp.allowedTools;
}

function isDebugInput(event: InputEvent): boolean {
  return (event.type === "danmaku" || event.type === "gift") && isRecord(event.raw) && event.raw.source === "debug";
}

function isGameModeControlDanmaku(event: InputEvent): boolean {
  if (event.type !== "danmaku") return false;

  const text = event.text.trim().toLowerCase();
  return text === "/game into" || text === "/chat" || text === "/stop";
}

function rawSourceOf(event: InputEvent): unknown {
  if (!("raw" in event)) return undefined;
  return isRecord(event.raw) ? event.raw.source : undefined;
}

function eventLogFields(event: InputEvent): Record<string, unknown> {
  if (event.type === "danmaku") {
    return {
      user: event.user,
      text: event.text.slice(0, 80)
    };
  }

  if (event.type === "gift") {
    return {
      user: event.user,
      giftName: event.giftName,
      count: event.count
    };
  }

  if (event.type === "game-tick") {
    return {
      reason: event.reason
    };
  }

  return {};
}

function replyTextForMemory(decision: AgentDecision): string {
  return decision.subtitleZh?.trim() || decision.say;
}

function conversationTextForBatch(events: InputEvent[]): string {
  return events
    .filter((event) => event.type === "danmaku")
    .map((event) => event.text)
    .join("\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
