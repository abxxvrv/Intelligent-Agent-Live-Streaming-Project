import OpenAI from "openai";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { AppConfig } from "../../config.js";
import type { AgentDecision, AgentReplyEvent, AgentTraceEvent, ToolCallEvent } from "../../types.js";
import { newId } from "../../utils/id.js";
import { Logger } from "../../utils/logger.js";
import { normalizeDecision } from "../LLMClient.js";
import {
  AgentState,
  type AgentGraphState,
  type AgentGraphUpdate,
  type DeepSeekMessage,
  type DeepSeekToolCall,
  type ToolResult
} from "./AgentState.js";
import { STS2_MCP_PLAYER_POLICY } from "./prompts/sts2McpPlayerPrompt.js";

type ToolCategory = "observe" | "metadata" | "express" | "game_action" | "control" | "error";

export type CreateGameSubgraphOptions = {
  config: AppConfig;
  gameTools: StructuredToolInterface[];
  maxToolLoops?: number;
  logger?: Logger;
  canUseSts2Actions?: () => boolean;
  onToolCall?: (event: ToolCallEvent) => void;
  onReply?: (event: AgentReplyEvent) => void;
  onTrace?: (event: AgentTraceEvent) => void;
};

const logger = new Logger("game-subgraph");

const OBSERVE_TOOLS = new Set([
  "get_game_state",
  "get_available_actions",
  "get_recent_chat_messages",
  "wait_until_actionable"
]);

const METADATA_TOOLS = new Set(["get_relevant_game_data", "get_game_data_item", "get_game_data_items"]);
const EXPRESS_TOOLS = new Set(["express"]);
const GAME_ACTION_TOOLS = new Set(["act"]);

export function createGameSubgraph(options: CreateGameSubgraphOptions) {
  const activeLogger = options.logger || logger;
  const maxToolLoops = options.maxToolLoops ?? 4;
  const toolsByName = new Map(options.gameTools.map((item) => [item.name, item]));
  const client = createDeepSeekClient(options.config);
  const deepseekTools = createDeepSeekTools(options.gameTools);

  const preloadGameSnapshot = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    emitTrace(options, state, {
      stage: "preload_game_snapshot",
      title: "预加载游戏快照",
      message: "读取最新 gameState 和 availableActions。"
    });

    const missing = ["get_game_state", "get_available_actions"].filter((name) => !toolsByName.has(name));
    if (missing.length) {
      const message = `STS2 MCP 工具缺失：${missing.join(", ")}`;
      emitTrace(options, state, {
        stage: "preload_game_snapshot",
        title: "预加载失败",
        message,
        status: "error"
      });
      activeLogger.warn("game preload failed because required tools are missing", {
        runId: state.runId,
        missing
      });
      return {
        mode: "chat",
        route: "chat",
        lastToolCategory: "error",
        lastToolError: message,
        gameSession: {
          ...state.gameSession,
          status: "idle"
        }
      };
    }

    try {
      const healthTool = toolsByName.get("health_check");
      let healthChecked = state.gameSession.healthChecked;
      if (!healthChecked && healthTool) {
        await invokeToolWithTelemetry(options, state, healthTool, {}, "preload_game_snapshot");
        healthChecked = true;
      }

      const gameStateOutput = await invokeToolWithTelemetry(
        options,
        state,
        toolsByName.get("get_game_state")!,
        {},
        "preload_game_snapshot"
      );
      const availableActionsOutput = await invokeToolWithTelemetry(
        options,
        state,
        toolsByName.get("get_available_actions")!,
        {},
        "preload_game_snapshot"
      );
      const now = Date.now();
      const gameState = extractMcpPayload(gameStateOutput);
      const availableActions = normalizeAvailableActions(extractMcpPayload(availableActionsOutput));

      emitTrace(options, state, {
        stage: "preload_game_snapshot",
        title: "预加载完成",
        message: `读取到 ${availableActions.length} 个可用动作。`,
        status: "success",
        detail: {
          actionCount: availableActions.length,
          healthChecked: Boolean(healthChecked)
        }
      });

      return {
        mode: "game",
        route: "game",
        gameState,
        availableActions,
        observedAt: now,
        lastToolCategory: "observe",
        lastToolError: undefined,
        gameActionExecuted: false,
        toolLoopCount: 0,
        messages: [],
        deepseekMessages: [],
        gameSession: {
          ...state.gameSession,
          status: "running",
          startedAt: state.gameSession.startedAt ?? now,
          healthChecked: Boolean(healthChecked),
          tickCount: state.gameSession.tickCount + 1
        }
      };
    } catch (error) {
      const message = errorMessage(error);
      emitTrace(options, state, {
        stage: "preload_game_snapshot",
        title: "预加载失败",
        message,
        status: "error"
      });
      activeLogger.warn("game preload failed", {
        runId: state.runId,
        error
      });
      return {
        mode: "chat",
        route: "chat",
        lastToolCategory: "error",
        lastToolError: message,
        gameSession: {
          ...state.gameSession,
          status: "idle"
        }
      };
    }
  };

  const gameAgentNode = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    if (state.mode !== "game") return {};

    emitTrace(options, state, {
      stage: "game_agent_node",
      title: "游戏代理决策",
      message: "DeepSeek 开始基于最新局面和观众上下文决策。"
    });

    if (!client) {
      emitTrace(options, state, {
        stage: "game_agent_node",
        title: "游戏代理跳过",
        message: "没有配置可用的 LLM API key，本轮只保持游戏模式等待下一 tick。"
      });
      const rawMessage: DeepSeekMessage = {
        role: "assistant",
        content: ""
      };
      return {
        deepseekMessages: [rawMessage],
        messages: [deepSeekMessageToAIMessage(rawMessage)]
      };
    }

    const requestMessages = buildGameDeepSeekMessages(options.config, state);
    activeLogger.info("game llm started", {
      runId: state.runId,
      messageCount: requestMessages.length,
      toolCount: deepseekTools.length,
      actionCount: state.availableActions.length
    });

    try {
      const response = await client.chat.completions.create({
        model: options.config.llm.model,
        messages: requestMessages as any,
        tools: deepseekTools.length ? (deepseekTools as any) : undefined,
        tool_choice: deepseekTools.length ? "auto" : undefined,
        stream: false,
        thinking: { type: "enabled" },
        reasoning_effort: "high"
      } as any);

      const rawMessage = normalizeDeepSeekAssistantMessage(response.choices[0]?.message);
      const toolCallNames = (rawMessage.tool_calls || []).map((call) => getDeepSeekToolCallName(call)).filter(Boolean);

      activeLogger.info("game llm completed", {
        runId: state.runId,
        hasToolCalls: toolCallNames.length > 0,
        toolCallNames,
        contentLength: getDeepSeekMessageContent(rawMessage).length
      });

      const publicMessage = summarizeDeepSeekMessage(rawMessage);
      if (publicMessage) {
        emitTrace(options, state, {
          stage: "game_agent_node",
          title: "游戏代理说明",
          message: publicMessage
        });
      }

      for (const call of rawMessage.tool_calls || []) {
        const toolName = getDeepSeekToolCallName(call);
        const args = parseToolArguments(getDeepSeekToolCallArguments(call));
        emitTrace(options, state, {
          stage: "tool-intent",
          title: "准备调用游戏工具",
          message: `我准备调用 ${toolName}。`,
          toolName,
          status: "start",
          detail: compactDetail(args)
        });
      }

      return {
        deepseekMessages: [rawMessage],
        messages: [deepSeekMessageToAIMessage(rawMessage)]
      };
    } catch (error) {
      const message = errorMessage(error);
      activeLogger.warn("game llm failed", {
        runId: state.runId,
        error
      });
      emitTrace(options, state, {
        stage: "game_agent_node",
        title: "游戏代理失败",
        message,
        status: "error"
      });
      return {
        deepseekMessages: [
          {
            role: "assistant",
            content: ""
          }
        ],
        lastToolCategory: "error",
        lastToolError: message
      };
    }
  };

  const routeAfterGameAgent = (state: AgentGraphState) => {
    if (state.mode !== "game") return "evaluate_game_status";
    if (!hasToolCalls(state)) return "evaluate_game_status";
    if (state.toolLoopCount >= maxToolLoops) {
      emitTrace(options, state, {
        stage: "game_agent_node",
        title: "工具循环达到上限",
        message: `toolLoopCount=${state.toolLoopCount}，本轮进入状态评估。`
      });
      return "evaluate_game_status";
    }
    return "game_toolnode";
  };

  const gameToolNode = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    const last = getLastDeepSeekAssistantMessage(state);
    const toolCalls = last?.tool_calls || [];
    const toolNames = toolCalls.map((call) => getDeepSeekToolCallName(call)).filter(Boolean);

    emitTrace(options, state, {
      stage: "game_toolnode",
      title: "游戏工具循环",
      message: `本轮工具数：${toolCalls.length}，toolLoopCount=${state.toolLoopCount}`,
      detail: {
        toolNames,
        toolLoopCount: state.toolLoopCount
      }
    });

    const messages: ToolMessage[] = [];
    const deepseekToolMessages: DeepSeekMessage[] = [];
    const results: ToolResult[] = [];
    let expressedDecision: AgentDecision | undefined;
    let lastToolCategory: ToolCategory | undefined;
    let lastToolError: string | undefined;
    let actionExecuted = Boolean(state.gameActionExecuted);
    let actionSucceeded = false;
    let stopAfterAct = false;
    let observedGameState: unknown;
    let observedAvailableActions: unknown[] | undefined;
    let observedAt: number | undefined;

    for (const call of toolCalls) {
      const toolName = getDeepSeekToolCallName(call);
      const rawArgs = getDeepSeekToolCallArguments(call);
      const args = parseToolArguments(rawArgs);
      const toolCallId = call.id || toolName;
      const selectedTool = toolsByName.get(toolName);

      if (stopAfterAct) {
        const content = JSON.stringify({ error: "本轮已经执行过游戏动作，act 后不再调用后续工具" });
        pushToolMessage(messages, deepseekToolMessages, results, toolName, toolCallId, content, "error");
        emitTrace(options, state, {
          stage: "game_toolnode",
          title: "工具被跳过",
          message: `${toolName} 被跳过：本轮已经执行过游戏动作。`,
          toolName,
          status: "error"
        });
        continue;
      }

      if (!selectedTool) {
        const content = JSON.stringify({ error: `Tool ${toolName} is not allowed` });
        lastToolCategory = "error";
        lastToolError = `Tool ${toolName} is not allowed`;
        pushToolMessage(messages, deepseekToolMessages, results, toolName, toolCallId, content, "error");
        emitTrace(options, state, {
          stage: "game_toolnode",
          title: "工具被拒绝",
          message: `工具 ${toolName} 不在游戏白名单中。`,
          toolName,
          status: "error",
          detail: content
        });
        continue;
      }

      if (toolName === "act" && actionExecuted) {
        const content = JSON.stringify({ error: "本轮已经执行过游戏动作" });
        lastToolCategory = "error";
        lastToolError = "本轮已经执行过游戏动作";
        pushToolMessage(messages, deepseekToolMessages, results, toolName, toolCallId, content, "error");
        emitTrace(options, state, {
          stage: "game_toolnode",
          title: "act 被拒绝",
          message: "本轮已经执行过游戏动作。",
          toolName,
          status: "error"
        });
        continue;
      }

      if (toolName === "act" && !options.canUseSts2Actions?.()) {
        const message = "需要设置 STS2_MCP_ALLOW_ACTIONS=true 才允许操作游戏";
        const content = JSON.stringify({ error: message });
        lastToolCategory = "error";
        lastToolError = message;
        emitToolCall(options, {
          name: toolName,
          status: "error",
          args,
          error: message
        });
        emitTrace(options, state, {
          stage: "game_toolnode",
          title: "act 被环境开关拦截",
          message,
          toolName,
          status: "error",
          detail: content
        });
        pushToolMessage(messages, deepseekToolMessages, results, toolName, toolCallId, content, "error");
        continue;
      }

      emitToolCall(options, {
        name: toolName,
        status: "start",
        args
      });

      try {
        const output = await selectedTool.invoke(args as any);
        const content = stringifyToolOutput(output);
        const resultSummary = summarizeToolContent(content);
        const category = categoryForTool(toolName);
        const currentExpressedDecision = toolName === "express" ? parseExpressDecision(content) : undefined;

        if (toolName === "get_game_state") {
          observedGameState = extractMcpPayload(content);
          observedAt = Date.now();
        } else if (toolName === "get_available_actions") {
          observedAvailableActions = normalizeAvailableActions(extractMcpPayload(content));
          observedAt = Date.now();
        } else if (toolName === "wait_until_actionable") {
          const payload = extractMcpPayload(content);
          const waitState = readFirstUnknown(payload, ["state", "gameState", "game_state"]);
          const waitActions = readFirstUnknown(payload, ["actions", "availableActions", "available_actions"]);
          if (waitState !== undefined) observedGameState = waitState;
          if (waitActions !== undefined) observedAvailableActions = normalizeAvailableActions(waitActions);
          observedAt = Date.now();
        }

        if (currentExpressedDecision && !expressedDecision) {
          expressedDecision = currentExpressedDecision;
          options.onReply?.({
            type: "agent-reply",
            id: newId("reply"),
            ts: Date.now(),
            sourceEventId: state.inputEvent.id,
            decision: currentExpressedDecision
          });
        }

        if (toolName === "act") {
          actionExecuted = true;
          actionSucceeded = true;
          stopAfterAct = true;
          emitTrace(options, state, {
            stage: "game_toolnode",
            title: "act 已执行",
            message: `act 成功：${resultSummary}`,
            toolName,
            status: "success",
            detail: resultSummary
          });
        } else {
          emitTrace(options, state, {
            stage: "tool-result",
            title: "游戏工具完成",
            message: `${toolName} 成功：${resultSummary}`,
            toolName,
            status: "success",
            detail: resultSummary
          });
        }

        emitToolCall(options, {
          name: toolName,
          status: "success",
          args,
          resultSummary
        });

        lastToolCategory = category;
        lastToolError = undefined;
        pushToolMessage(messages, deepseekToolMessages, results, toolName, toolCallId, content, "success");
      } catch (error) {
        const message = errorMessage(error);
        const content = JSON.stringify({ error: message });
        lastToolCategory = "error";
        lastToolError = message;
        emitToolCall(options, {
          name: toolName,
          status: "error",
          args,
          error: message
        });
        emitTrace(options, state, {
          stage: "game_toolnode",
          title: toolName === "act" ? "act 执行失败" : "游戏工具失败",
          message: `${toolName} 失败：${message}`,
          toolName,
          status: "error",
          detail: content
        });
        pushToolMessage(messages, deepseekToolMessages, results, toolName, toolCallId, content, "error");
      }
    }

    if (actionSucceeded) {
      lastToolCategory = "game_action";
      lastToolError = undefined;
    }

    const update: AgentGraphUpdate = {
      deepseekMessages: deepseekToolMessages,
      messages,
      toolResults: results,
      toolLoopCount: state.toolLoopCount + 1,
      expressedDecision,
      lastToolCategory,
      lastToolError,
      gameActionExecuted: actionExecuted
    };

    if (observedGameState !== undefined) update.gameState = observedGameState;
    if (observedAvailableActions !== undefined) update.availableActions = observedAvailableActions;
    if (observedAt !== undefined) update.observedAt = observedAt;
    if (actionSucceeded) {
      update.gameSession = {
        ...state.gameSession,
        actionCount: state.gameSession.actionCount + 1
      };
    }

    activeLogger.info("game tool loop completed", {
      runId: state.runId,
      toolLoopCount: state.toolLoopCount + 1,
      toolNames,
      lastToolCategory,
      hasError: Boolean(lastToolError),
      actionExecuted
    });

    return update;
  };

  const routeAfterGameTool = (state: AgentGraphState) => {
    if (state.gameActionExecuted || state.lastToolCategory === "game_action") return "evaluate_game_status";
    return "game_agent_node";
  };

  const evaluateGameStatus = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    if (state.mode !== "game" && state.lastToolError) {
      emitTrace(options, state, {
        stage: "evaluate_game_status",
        title: "游戏状态评估",
        message: `游戏子图停留在聊天模式：${state.lastToolError}`,
        status: "error"
      });
      return {
        mode: "chat",
        route: "chat",
        gameSession: {
          ...state.gameSession,
          status: "idle"
        }
      };
    }

    const status = detectGameStatus(state.gameState);
    emitTrace(options, state, {
      stage: "evaluate_game_status",
      title: "游戏状态评估",
      message: status.ended ? `检测到 ${status.reason}` : "游戏仍在进行，保持 game mode。",
      detail: {
        ended: status.ended,
        reason: status.reason,
        actionCount: state.gameSession.actionCount,
        tickCount: state.gameSession.tickCount
      }
    });

    if (status.ended) {
      return {
        mode: "chat",
        route: "chat",
        gameOver: true,
        gameSession: {
          ...state.gameSession,
          status: "ended",
          endedAt: Date.now(),
          lastGameStatus: status.reason
        }
      };
    }

    return {
      mode: "game",
      route: "game",
      gameOver: false,
      gameSession: {
        ...state.gameSession,
        status: "running"
      }
    };
  };

  return new StateGraph(AgentState)
    .addNode("preload_game_snapshot", preloadGameSnapshot)
    .addNode("game_agent_node", gameAgentNode)
    .addNode("game_toolnode", gameToolNode)
    .addNode("evaluate_game_status", evaluateGameStatus)
    .addEdge(START, "preload_game_snapshot")
    .addEdge("preload_game_snapshot", "game_agent_node")
    .addConditionalEdges("game_agent_node", routeAfterGameAgent)
    .addConditionalEdges("game_toolnode", routeAfterGameTool)
    .addEdge("evaluate_game_status", END)
    .compile();
}

function createDeepSeekClient(config: AppConfig) {
  if (!config.llm.apiKey) return undefined;

  return new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseUrl,
    timeout: config.llm.timeoutMs
  });
}

function createDeepSeekTools(tools: StructuredToolInterface[]) {
  return tools.map((tool) => convertToOpenAITool(tool));
}

function buildGameDeepSeekMessages(config: AppConfig, state: AgentGraphState): DeepSeekMessage[] {
  return [
    {
      role: "system",
      content: gameSystemPrompt(config, state)
    },
    {
      role: "user",
      content: gameInput(state)
    },
    ...state.deepseekMessages
  ];
}

function gameSystemPrompt(config: AppConfig, state: AgentGraphState): string {
  const persona = config.agent.persona || state.persona;
  return `${persona}

${STS2_MCP_PLAYER_POLICY}

你现在运行在 LangGraph game_subgraph 中。每一轮 invocation 最多允许一个 act；act 后系统会进入状态评估并等待下一次 game tick。
不要输出 Markdown。内部分析使用中文；通过 express 给观众说话时，textJa 使用自然日语，textZh 使用中文。`;
}

function gameInput(state: AgentGraphState): string {
  return JSON.stringify(
    {
      audienceContext: state.audienceContext,
      gameState: state.gameState,
      availableActions: state.availableActions,
      observedAt: state.observedAt,
      gameSession: state.gameSession,
      lastToolError: state.lastToolError
    },
    null,
    2
  );
}

function normalizeDeepSeekAssistantMessage(message: unknown): DeepSeekMessage {
  const raw = (message || {}) as DeepSeekMessage;

  return {
    ...raw,
    role: "assistant",
    content: raw.content ?? ""
  };
}

function deepSeekMessageToAIMessage(message: DeepSeekMessage): AIMessage {
  const toolCalls = (message.tool_calls || [])
    .map((call) => {
      const name = getDeepSeekToolCallName(call);
      if (!name) return undefined;

      return {
        id: call.id || name,
        name,
        args: parseToolArguments(getDeepSeekToolCallArguments(call)),
        type: "tool_call"
      };
    })
    .filter(Boolean);

  return new AIMessage({
    content: getDeepSeekMessageContent(message),
    tool_calls: toolCalls as any,
    additional_kwargs: {
      reasoning_content: message.reasoning_content,
      tool_calls: message.tool_calls
    }
  } as any);
}

function hasToolCalls(state: AgentGraphState): boolean {
  const last = getLastDeepSeekAssistantMessage(state);
  return Boolean(last?.tool_calls?.length);
}

function getLastDeepSeekAssistantMessage(state: AgentGraphState): DeepSeekMessage | undefined {
  for (let index = state.deepseekMessages.length - 1; index >= 0; index -= 1) {
    const message = state.deepseekMessages[index];
    if (message?.role === "assistant") return message;
  }

  return undefined;
}

function getDeepSeekMessageContent(message: DeepSeekMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

function getDeepSeekToolCallName(call: DeepSeekToolCall): string {
  return call.function?.name || "";
}

function getDeepSeekToolCallArguments(call: DeepSeekToolCall): string {
  return call.function?.arguments || "{}";
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};

  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function invokeToolWithTelemetry(
  options: CreateGameSubgraphOptions,
  state: AgentGraphState,
  selectedTool: StructuredToolInterface,
  args: Record<string, unknown>,
  stage: AgentTraceEvent["stage"]
): Promise<string> {
  emitToolCall(options, {
    name: selectedTool.name,
    status: "start",
    args
  });
  try {
    const output = await selectedTool.invoke(args as any);
    const content = stringifyToolOutput(output);
    emitToolCall(options, {
      name: selectedTool.name,
      status: "success",
      args,
      resultSummary: summarizeToolContent(content)
    });
    return content;
  } catch (error) {
    const message = errorMessage(error);
    emitToolCall(options, {
      name: selectedTool.name,
      status: "error",
      args,
      error: message
    });
    emitTrace(options, state, {
      stage,
      title: "预加载工具失败",
      message: `${selectedTool.name} 失败：${message}`,
      toolName: selectedTool.name,
      status: "error"
    });
    throw error;
  }
}

function pushToolMessage(
  messages: ToolMessage[],
  deepseekToolMessages: DeepSeekMessage[],
  results: ToolResult[],
  toolName: string,
  toolCallId: string,
  content: string,
  status: "success" | "error"
): void {
  messages.push(new ToolMessage({ content, tool_call_id: toolCallId, status }));
  deepseekToolMessages.push({
    role: "tool",
    tool_call_id: toolCallId,
    content
  });
  results.push({ name: toolName, content });
}

function categoryForTool(toolName: string): ToolCategory {
  if (OBSERVE_TOOLS.has(toolName)) return "observe";
  if (METADATA_TOOLS.has(toolName)) return "metadata";
  if (EXPRESS_TOOLS.has(toolName)) return "express";
  if (GAME_ACTION_TOOLS.has(toolName)) return "game_action";
  return "control";
}

function parseExpressDecision(content: string): AgentDecision | undefined {
  const parsed = parseJsonObject(content);
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.expressed !== true) return undefined;
  const decision = normalizeDecision(record.decision);
  return decision.shouldSpeak ? decision : undefined;
}

function extractMcpPayload(content: unknown): unknown {
  const parsed = typeof content === "string" ? parseJsonObject(content) : content;
  if (!parsed || typeof parsed !== "object") return parsed;
  const record = parsed as Record<string, unknown>;
  if (record.structuredContent !== undefined) return record.structuredContent;
  if (record.structured_content !== undefined) return record.structured_content;

  const text = extractFirstText(record.content);
  if (text) {
    const textParsed = parseJsonObject(text);
    return Object.keys(textParsed as Record<string, unknown>).length ? textParsed : text;
  }

  return parsed;
}

function normalizeAvailableActions(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["actions", "availableActions", "available_actions", "result"]) {
    const item = record[key];
    if (Array.isArray(item)) return item;
  }
  return [];
}

function detectGameStatus(gameState: unknown): { ended: boolean; reason?: string } {
  const screen = readString(gameState, ["screen", "state.screen", "raw.screen"]);
  const gameOver = readBool(gameState, ["gameOver", "game_over", "state.gameOver", "state.game_over"]);
  const victory = readBool(gameState, ["victory", "is_victory", "state.victory"]);

  if (gameOver || screen === "GAME_OVER") return { ended: true, reason: "game_over" };
  if (victory || screen === "VICTORY") return { ended: true, reason: "victory" };
  return { ended: false };
}

function readString(value: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const item = readUnknown(value, path.split("."));
    if (typeof item === "string") return item;
  }
  return undefined;
}

function readBool(value: unknown, paths: string[]): boolean {
  for (const path of paths) {
    const item = readUnknown(value, path.split("."));
    if (typeof item === "boolean") return item;
  }
  return false;
}

function readUnknown(value: unknown, path: string[] | string): unknown {
  const parts = Array.isArray(path) ? path : path.split(".");
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function readFirstUnknown(value: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const item = readUnknown(value, path);
    if (item !== undefined) return item;
  }
  return undefined;
}

function extractFirstText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  return undefined;
}

function parseJsonObject(content: unknown): unknown {
  if (typeof content !== "string") return content ?? {};
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return {};

    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function stringifyToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function summarizeDeepSeekMessage(message: DeepSeekMessage): string {
  const content = getDeepSeekMessageContent(message);
  if (!content) return "";

  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 240)}...`;
}

function summarizeToolContent(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= 420) return compact;

  return `${compact.slice(0, 420)}...`;
}

function compactDetail(value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text || text.length <= 500) return value;

  return `${text.slice(0, 500)}...`;
}

function emitToolCall(options: CreateGameSubgraphOptions, event: Omit<ToolCallEvent, "type" | "id" | "ts">): void {
  options.onToolCall?.({
    type: "tool-call",
    id: newId("tool"),
    ts: Date.now(),
    ...event
  });
}

function emitTrace(
  options: CreateGameSubgraphOptions,
  state: AgentGraphState,
  event: Omit<AgentTraceEvent, "type" | "id" | "ts" | "runId" | "sourceEventId">
): void {
  options.onTrace?.({
    type: "agent-trace",
    id: newId("trace"),
    ts: Date.now(),
    runId: state.runId,
    sourceEventId: state.inputEvent.id,
    ...event
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
