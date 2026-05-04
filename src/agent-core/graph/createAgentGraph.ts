import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inspect } from "node:util";
import OpenAI from "openai";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { AppConfig } from "../../config.js";
import type { AgentDecision, AgentReplyEvent, AgentTraceEvent, InputEvent, ToolCallEvent } from "../../types.js";
import { newId } from "../../utils/id.js";
import { Logger } from "../../utils/logger.js";
import { fallbackDecision, normalizeDecision, type AgentPrompt } from "../LLMClient.js";
import {
  AgentState,
  type AgentGraphState,
  type AgentGraphUpdate,
  type AgentMode,
  type GameSession,
  type DeepSeekMessage,
  type DeepSeekToolCall,
  type ToolResult
} from "./AgentState.js";
import { createGameSubgraph } from "./createGameSubgraph.js";
import { createAgentTools, type AgentToolContext } from "./tools.js";

export type CreateAgentGraphOptions = {
  config: AppConfig;
  shouldRespond: (state: AgentGraphState) => boolean;
  chatTools?: StructuredToolInterface[];
  gameTools?: StructuredToolInterface[];
  controlTools?: StructuredToolInterface[];
  toolContext?: AgentToolContext;
  extraTools?: StructuredToolInterface[];
  maxToolLoops?: number;
  logger?: Logger;
  sts2McpToolsEnabled?: boolean;
  canUseSts2Actions?: () => boolean;
  onToolCall?: (event: ToolCallEvent) => void;
  onReply?: (event: AgentReplyEvent) => void;
  onTrace?: (event: AgentTraceEvent) => void;
  waitForReplyPlayback?: (replyId: string, timeoutMs?: number) => Promise<void>;

  /**
   * Debug: 把 DeepSeek 原始响应写入本地日志文件。
   */
  debugDeepSeekRawOutput?: boolean;

  /**
   * Debug: 是否在原始响应日志里包含完整 reasoning_content。
   * 只建议本地开发开启。
   */
  debugDeepSeekRawOutputIncludeReasoning?: boolean;

  /**
   * Debug: 是否也把 DeepSeek 原始响应塞进 onTrace。
   * 如果你的 onTrace 会发给前端，谨慎开启。
   */
  debugDeepSeekRawOutputToTrace?: boolean;
};

const logger = new Logger("agent-graph");
const debugOutputFilePath = resolve(process.cwd(), "logs", "agent-debug-output.log");

export function createAgentGraph(options: CreateAgentGraphOptions) {
  const activeLogger = options.logger || logger;
  const chatSubgraph = createChatSubgraph(options);
  const gameSubgraph = createGameSubgraph({
    config: options.config,
    gameTools: options.gameTools || [],
    maxToolLoops: options.maxToolLoops,
    logger: activeLogger,
    canUseSts2Actions: options.canUseSts2Actions,
    onToolCall: options.onToolCall,
    onReply: options.onReply,
    onTrace: options.onTrace,
    waitForReplyPlayback: options.waitForReplyPlayback
  });

  const eventRouter = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    let route: AgentGraphUpdate["route"];
    let mode: AgentMode = state.mode === "game" ? "game" : "chat";
    if (isControlEvent(state)) {
      route = "control";
    } else if (state.mode === "game") {
      route = "game";
      mode = "game";
    } else if (state.inputEvent?.type === "idle") {
      route = "ignore";
    } else {
      route = "chat";
      mode = "chat";
    }
    const eventTypes = getInputEvents(state).map((event) => event.type);
    emitTrace(options, state, {
      stage: "router",
      title: "父图路由",
      message: `route=${route}, mode=${mode}, events=${getInputEvents(state).length}`,
      detail: {
        route,
        mode,
        eventTypes,
        shouldStartGame: state.shouldStartGame
      }
    });
    activeLogger.info("parent graph routed event", {
      runId: state.runId,
      sourceEventId: state.inputEvent.id,
      route,
      mode,
      eventTypes,
      shouldStartGame: state.shouldStartGame
    });
    return { route, mode };
  };

  const enterChatSubgraph = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    emitTrace(options, state, {
      stage: "chat-enter",
      title: "进入聊天子图",
      message: `chat_subgraph 开始处理 ${getInputEvents(state).length} 条事件`
    });
    return {};
  };

  const controlNode = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    const command = readControlCommand(state);
    const now = Date.now();
    emitTrace(options, state, {
      stage: "control_node",
      title: "控制节点",
      message: command ? `收到控制命令：${command}` : "没有识别到控制命令。",
      detail: {
        command
      }
    });

    if (command === "game") {
      const gameSession: GameSession = {
        ...state.gameSession,
        status: "running",
        startedAt: state.gameSession.startedAt ?? now,
        tickCount: state.gameSession.status === "running" ? state.gameSession.tickCount : 0,
        actionCount: state.gameSession.status === "running" ? state.gameSession.actionCount : 0
      };
      emitTrace(options, state, {
        stage: "mode-transition",
        title: "模式切换",
        message: "已切换到 game mode。"
      });
      return {
        mode: "game",
        route: "game",
        shouldStartGame: false,
        gameSession
      };
    }

    if (command === "chat" || command === "stop") {
      emitTrace(options, state, {
        stage: "mode-transition",
        title: "模式切换",
        message: command === "stop" ? "已停止游戏模式并回到聊天。" : "已切换到 chat mode。"
      });
      return {
        mode: "chat",
        route: "chat",
        shouldStartGame: false,
        gameActionExecuted: false,
        lastToolError: undefined,
        gameSession: {
          status: "idle",
          endedAt: now,
          tickCount: 0,
          actionCount: 0
        }
      };
    }

    emitTrace(options, state, {
      stage: "control_node",
      title: "控制节点跳过",
      message: "控制命令为空，保持当前模式。"
    });
    activeLogger.info("control node ignored empty command", {
      runId: state.runId,
      mode: state.mode,
      route: state.route
    });
    return {
      mode: state.mode,
      route: state.mode
    };
  };

  return new StateGraph(AgentState)
    .addNode("event_router", eventRouter)
    .addNode("enter_chat_subgraph", enterChatSubgraph)
    .addNode("chat_subgraph", chatSubgraph)
    .addNode("game_subgraph", gameSubgraph)
    .addNode("control_node", controlNode)
    .addEdge(START, "event_router")
    .addConditionalEdges("event_router", (state) => {
      if (state.route === "chat") return "enter_chat_subgraph";
      if (state.route === "game") return "game_subgraph";
      if (state.route === "control") return "control_node";
      return END;
    })
    .addEdge("enter_chat_subgraph", "chat_subgraph")
    .addEdge("chat_subgraph", END)
    .addEdge("game_subgraph", END)
    .addEdge("control_node", END)
    .compile();
}

export function createChatSubgraph(options: CreateAgentGraphOptions) {
  const activeLogger = options.logger || logger;
  const maxToolLoops = options.maxToolLoops ?? 2;
  const fallbackTools = options.toolContext ? [...createAgentTools(options.toolContext), ...(options.extraTools || [])] : [];
  const tools = options.chatTools ?? fallbackTools;
  const toolsByName = new Map(tools.map((item) => [item.name, item]));

  /**
   * 这里不再使用 ChatOpenAI.bindTools()。
   * 原因：DeepSeek thinking mode + tool call 后，后续请求必须回传 reasoning_content。
   * 普通 LangChain AIMessage 转换链路可能会丢掉 DeepSeek 的扩展字段。
   */
  const client = createDeepSeekClient(options.config);
  const deepseekTools = createDeepSeekTools(tools);

  const ingestEvent = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    emitTrace(options, state, {
      stage: "chat-ingest",
      title: "聊天子图接收事件",
      message: `收到 ${getInputEvents(state).length} 条事件`
    });
    return {
      trigger: state.trigger || "直播事件",
      messages: [],
      deepseekMessages: []
    };
  };

  const shouldRespond = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    const nextShouldRespond = options.shouldRespond(state);
    emitTrace(options, state, {
      stage: "chat-should-respond",
      title: "判断是否回复",
      message: `shouldRespond=${nextShouldRespond}`
    });
    return {
      shouldRespond: nextShouldRespond
    };
  };

  const agentLlm = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    const prompt = toPrompt(options.config, state);
    const requestMessages = buildDeepSeekMessages(options.config, state);

    emitTrace(options, state, {
      stage: "llm-start",
      title: "模型处理",
      message: "模型开始处理这条消息。"
    });
    activeLogger.info("chat llm started", {
      runId: state.runId,
      messageCount: requestMessages.length,
      toolCount: deepseekTools.length,
      batchSize: getInputEvents(state).length
    });

    if (!client) {
      emitTrace(options, state, {
        stage: "llm-message",
        title: "本地回退",
        message: "没有配置可用的 LLM API key，我会使用本地 fallback 回复。"
      });
      const decision = fallbackDecision(prompt);
      activeLogger.info("chat llm completed", {
        runId: state.runId,
        hasToolCalls: false,
        toolCallNames: [],
        contentLength: decision.say.length,
        fallback: true
      });
      const rawMessage: DeepSeekMessage = {
        role: "assistant",
        content: JSON.stringify(decision)
      };
      return {
        decision,
        deepseekMessages: [rawMessage],
        messages: [deepSeekMessageToAIMessage(rawMessage)]
      };
    }

    try {
      const response = await client.chat.completions.create({
        model: options.config.llm.model,
        messages: requestMessages as any,
        tools: deepseekTools.length ? (deepseekTools as any) : undefined,
        tool_choice: deepseekTools.length ? "auto" : undefined,
        stream: false,

        /**
         * DeepSeek thinking mode。
         *
         * 如果你以后想临时关闭思考模式，可以改成：
         * thinking: { type: "disabled" }
         *
         * 注意：thinking mode 下 temperature/top_p 等采样参数通常不会生效。
         */
        thinking: { type: "enabled" },
        reasoning_effort: "high"
      } as any);

      const rawMessage = normalizeDeepSeekAssistantMessage(response.choices[0]?.message);
      const toolCallNames = (rawMessage.tool_calls || []).map((call) => getDeepSeekToolCallName(call)).filter(Boolean);
      activeLogger.info("chat llm completed", {
        runId: state.runId,
        hasToolCalls: toolCallNames.length > 0,
        toolCallNames,
        contentLength: getDeepSeekMessageContent(rawMessage).length
      });

      emitDeepSeekRawOutputDebug(options, state, {
        request: {
          model: options.config.llm.model,
          thinking: { type: "enabled" },
          reasoning_effort: "high",
          messageCount: requestMessages.length,
          messages: requestMessages,
          toolCount: deepseekTools.length,
          tools: deepseekTools
        },
        response,
        assistantMessage: rawMessage
      });

      const publicMessage = summarizeDeepSeekMessage(rawMessage);
      if (publicMessage) {
        emitTrace(options, state, {
          stage: "llm-message",
          title: "模型说明",
          message: publicMessage
        });
      }

      if (rawMessage.tool_calls?.length) {
        for (const call of rawMessage.tool_calls) {
          const toolName = getDeepSeekToolCallName(call);
          const args = parseToolArguments(getDeepSeekToolCallArguments(call));

          emitTrace(options, state, {
            stage: "tool-intent",
            title: "准备调用工具",
            message: `我准备调用 ${toolName}。`,
            toolName,
            status: "start",
            detail: compactDetail(args)
          });
        }
      }

      return {
        /**
         * 关键：原样保存 DeepSeek assistant message。
         * 这里面包含 reasoning_content / content / tool_calls。
         * 后续 tool result 追加后，再次请求 DeepSeek 时必须把它带回去。
         */
        deepseekMessages: [rawMessage],

        /**
         * 可选：保留一份 LangChain AIMessage，供你原来的 UI / trace / debug 使用。
         * 真正发给 DeepSeek 的上下文不依赖它。
         */
        messages: [deepSeekMessageToAIMessage(rawMessage)]
      };
    } catch (error) {
      activeLogger.warn("DeepSeek LLM call failed, using fallback decision", error);
      emitTrace(options, state, {
        stage: "llm-message",
        title: "模型失败",
        message: `LLM 调用失败，使用本地 fallback 回复：${error instanceof Error ? error.message : String(error)}`
      });
      const decision = fallbackDecision(prompt);
      activeLogger.info("chat llm completed", {
        runId: state.runId,
        hasToolCalls: false,
        toolCallNames: [],
        contentLength: decision.say.length,
        fallback: true
      });
      const rawMessage: DeepSeekMessage = {
        role: "assistant",
        content: JSON.stringify(decision)
      };
      return {
        decision,
        deepseekMessages: [rawMessage],
        messages: [deepSeekMessageToAIMessage(rawMessage)]
      };
    }
  };

  const runTools = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    const last = getLastDeepSeekAssistantMessage(state);
    const toolCalls = last?.tool_calls || [];
    const toolNames = toolCalls.map((call) => getDeepSeekToolCallName(call)).filter(Boolean);
    emitTrace(options, state, {
      stage: "tool-loop",
      title: "进入工具循环",
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
    let controlUpdate: AgentGraphUpdate = {};

    for (const call of toolCalls) {
      const toolName = getDeepSeekToolCallName(call);
      const rawArgs = getDeepSeekToolCallArguments(call);
      const args = parseToolArguments(rawArgs);
      const toolCallId = call.id || toolName;

      const selectedTool = toolsByName.get(toolName);

      if (!selectedTool) {
        const content = JSON.stringify({ error: `Tool ${toolName} is not allowed` });

        emitTrace(options, state, {
          stage: "tool-result",
          title: "工具被拒绝",
          message: `工具 ${toolName} 不在白名单中。`,
          toolName,
          status: "error",
          detail: content
        });

        messages.push(new ToolMessage({ content, tool_call_id: toolCallId, status: "error" }));
        deepseekToolMessages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content
        });
        results.push({ name: toolName, content });
        continue;
      }

      try {
        if (toolName === "act" && !options.canUseSts2Actions?.()) {
          const message = "需要设置 STS2_MCP_ALLOW_ACTIONS=true 才允许操作游戏";
          const content = JSON.stringify({
            error: message
          });

          emitToolCall(options, {
            name: toolName,
            status: "error",
            args,
            error: message
          });

          emitTrace(options, state, {
            stage: "tool-result",
            title: "工具被闸门拦截",
            message,
            toolName,
            status: "error",
            detail: content
          });

          messages.push(new ToolMessage({ content, tool_call_id: toolCallId, status: "error" }));
          deepseekToolMessages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content
          });
          results.push({ name: toolName, content });
          continue;
        }

        emitToolCall(options, {
          name: toolName,
          status: "start",
          args
        });

        const output = await selectedTool.invoke(args as any);
        const content = stringifyToolOutput(output);
        const resultSummary = summarizeToolContent(content);
        const currentExpressedDecision = toolName === "express" ? parseExpressDecision(content) : undefined;
        const currentControlUpdate = toolName === "enter_game_mode" ? parseEnterGameModeUpdate(content) : undefined;

        emitToolCall(options, {
          name: toolName,
          status: "success",
          args,
          resultSummary
        });

        emitTrace(options, state, {
          stage: "tool-result",
          title: "工具完成",
          message: `${toolName} 成功：${resultSummary}`,
          toolName,
          status: "success",
          detail: resultSummary
        });

        if (currentExpressedDecision && !expressedDecision) {
          expressedDecision = currentExpressedDecision;
          options.onReply?.({
            type: "agent-reply",
            id: newId("reply"),
            ts: Date.now(),
            sourceEventId: state.inputEvent.id,
            decision: currentExpressedDecision
          });
          emitTrace(options, state, {
            stage: "final",
            title: "表达完成",
            message: currentExpressedDecision.say,
            status: "success",
            detail: {
              emotion: currentExpressedDecision.emotion,
              avatarAction: currentExpressedDecision.avatarAction,
              gameIntent: currentExpressedDecision.gameIntent
            }
          });
        }

        if (currentControlUpdate) {
          controlUpdate = currentControlUpdate;
          emitTrace(options, state, {
            stage: "mode-transition",
            title: "聊天工具切换模式",
            message: "enter_game_mode 已请求进入 game mode。",
            toolName,
            status: "success"
          });
        }

        messages.push(new ToolMessage({ content, tool_call_id: toolCallId, status: "success" }));
        deepseekToolMessages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content
        });
        results.push({ name: toolName, content });
      } catch (error) {
        const content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });

        emitToolCall(options, {
          name: toolName,
          status: "error",
          args,
          error: error instanceof Error ? error.message : String(error)
        });

        emitTrace(options, state, {
          stage: "tool-result",
          title: "工具失败",
          message: `${toolName} 失败：${error instanceof Error ? error.message : String(error)}`,
          toolName,
          status: "error",
          detail: content
        });

        messages.push(new ToolMessage({ content, tool_call_id: toolCallId, status: "error" }));
        deepseekToolMessages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content
        });
        results.push({ name: toolName, content });
      }
    }

    activeLogger.info("tool loop completed", {
      runId: state.runId,
      toolLoopCount: state.toolLoopCount + 1,
      toolNames,
      hasExpressedDecision: Boolean(expressedDecision),
      shouldStartGame: state.shouldStartGame
    });

    return {
      /**
       * 关键：把 role=tool 的原始 OpenAI-compatible message 接回 deepseekMessages。
       * 下一轮 agent_llm 会把：
       * assistant(reasoning_content + tool_calls) + tool(tool_call_id + content)
       * 一起传给 DeepSeek。
       */
      deepseekMessages: deepseekToolMessages,

      /**
       * 兼容你原本的 UI / trace 消息链。
       */
      messages,

      toolResults: results,
      toolLoopCount: state.toolLoopCount + 1,
      expressedDecision,
      ...controlUpdate
    };
  };

  const finalizeDecision = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    if (state.expressedDecision) {
      const decision: AgentDecision = {
          say: "",
          emotion: state.expressedDecision.emotion,
          avatarAction: "idle",
          shouldSpeak: false,
          gameIntent: state.expressedDecision.gameIntent
      };
      logDecisionFinalized(activeLogger, state, decision, true);
      return { decision };
    }

    if (state.decision) {
      emitFinalTrace(options, state, state.decision);
      logDecisionFinalized(activeLogger, state, state.decision, Boolean(state.expressedDecision));
      return { decision: state.decision };
    }

    const prompt = toPrompt(options.config, state);
    const content = getLastAssistantContentForDecision(state);
    const parsed = parseJsonObject(content);
    const decision = normalizeDecision(parsed);

    if (decision.shouldSpeak) {
      emitFinalTrace(options, state, decision);
      logDecisionFinalized(activeLogger, state, decision, Boolean(state.expressedDecision));
      return { decision };
    }

    if (content.trim()) {
      const textDecision = decisionFromPlainText(content);
      emitFinalTrace(options, state, textDecision);
      logDecisionFinalized(activeLogger, state, textDecision, Boolean(state.expressedDecision));
      return { decision: textDecision };
    }

    const fallback = fallbackDecision(withToolResults(prompt, state.toolResults));
    emitFinalTrace(options, state, fallback);
    logDecisionFinalized(activeLogger, state, fallback, Boolean(state.expressedDecision));
    return { decision: fallback };
  };

  return new StateGraph(AgentState)
    .addNode("ingest_event", ingestEvent)
    .addNode("should_respond", shouldRespond)
    .addNode("agent_llm", agentLlm)
    .addNode("tools", runTools)
    .addNode("finalize_decision", finalizeDecision)
    .addEdge(START, "ingest_event")
    .addEdge("ingest_event", "should_respond")
    .addConditionalEdges("should_respond", (state) => (state.shouldRespond ? "agent_llm" : END))
    .addConditionalEdges("agent_llm", (state) => (hasToolCalls(state) ? "tools" : "finalize_decision"))
    .addConditionalEdges("tools", (state) =>
      state.expressedDecision || state.toolLoopCount >= maxToolLoops ? "finalize_decision" : "agent_llm"
    )
    .addEdge("finalize_decision", END)
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

/**
 * 这个函数保留给其他地方如果还在引用 buildAgentMessages。
 * 但 DeepSeek thinking mode 的真实请求不再使用它。
 */
export function buildAgentMessages(config: AppConfig, state: AgentGraphState): BaseMessage[] {
  const messages: BaseMessage[] = [new SystemMessage(systemPrompt(config, state))];

  for (const turn of state.conversationHistory) {
    messages.push(new HumanMessage(turn.user));
    messages.push(new AIMessage(turn.assistant));
  }

  messages.push(new HumanMessage(chatInput(state)));
  messages.push(...state.messages);
  return messages;
}

function buildDeepSeekMessages(config: AppConfig, state: AgentGraphState): DeepSeekMessage[] {
  const messages: DeepSeekMessage[] = [
    {
      role: "system",
      content: systemPrompt(config, state)
    }
  ];

  for (const turn of state.conversationHistory) {
    messages.push({
      role: "user",
      content: turn.user
    });

    messages.push({
      role: "assistant",
      content: turn.assistant
    });
  }

  messages.push({
    role: "user",
    content: chatInput(state)
  });

  /**
   * 当前 LangGraph run 内的 DeepSeek 原始消息链：
   * assistant(reasoning_content + tool_calls)
   * tool(tool_call_id + content)
   * assistant(final content)
   */
  messages.push(...state.deepseekMessages);

  return messages;
}

function systemPrompt(config: AppConfig, state: AgentGraphState): string {
  const persona = config.agent.persona || state.persona;
  const remembered = state.memoryNotes.length ? `\n已记住的信息：${state.memoryNotes.join(" / ")}` : "";

  return `${persona}

请结合已有对话历史，像正常聊天一样自然、连贯地回应当前用户。
你可以在判断有帮助时使用当前提供的工具。不要声称已经执行没有实际结果的操作。
如果要对观众说出可见回复，优先调用 express 工具。express 的参数必须是严格 JSON：
{
  "textJa": "自然的日语口语回复，适合直接朗读，最多 180 个字符",
  "textZh": "对应的中文字幕，保持原意，最多 180 个字符",
  "emotion": "neutral|happy|thinking|surprised|focus|awkward",
  "avatarAction": "idle|talk|nod|wave|think|panic",
  "gameIntent": "none|explain_state|consider_card|consider_path|celebrate|warn"
}
调用 express 后，不要再输出第二段可朗读内容。
如果观众想进入游戏模式，请告诉观众调试阶段需要发送精确命令 /game into。
聊天模式不会直接暴露 act，也不会通过工具切换到游戏模式。
如果没有调用 express，最终回复应当是可解析的 JSON 对象，字段固定：
{
  "say": "自然的日语口语回复，适合直接朗读，最多 180 个字符",
  "subtitleJa": "同 say，日文字幕",
  "subtitleZh": "对应的中文字幕，保持原意，最多 180 个字符",
  "emotion": "neutral|happy|thinking|surprised|focus|awkward",
  "avatarAction": "idle|talk|nod|wave|think|panic",
  "shouldSpeak": true,
  "gameIntent": "none|explain_state|consider_card|consider_path|celebrate|warn"
}

要求：
- 游戏理解、弹幕理解、工具调用说明、内部对话历史尽量使用中文。
- 只有最终可朗读内容 say/textJa 使用日语。
- subtitleZh 必须是中文。
- 不要输出 Markdown。${remembered}`;
}

function toPrompt(config: AppConfig, state: AgentGraphState): AgentPrompt {
  return {
    persona: config.agent.persona,
    trigger: state.trigger,
    gameSummary: state.gameSummary,
    recentDanmaku: state.recentDanmaku,
    recentReplies: state.recentReplies
  };
}

function getInputEvents(state: AgentGraphState): InputEvent[] {
  return state.inputEvents.length ? state.inputEvents : [state.inputEvent];
}

function isControlEvent(state: AgentGraphState): boolean {
  return Boolean(readControlCommand(state));
}

function readControlCommand(state: AgentGraphState): "game" | "chat" | "stop" | undefined {
  for (const event of getInputEvents(state)) {
    if (event.type === "debug-control") return event.mode;
    if (event.type !== "danmaku") continue;

    const text = event.text.trim().toLowerCase();
    if (text === "/game into") return "game";
    if (text === "/chat") return "chat";
    if (text === "/stop") return "stop";
  }

  return undefined;
}

function chatInput(state: AgentGraphState): string {
  const events = getInputEvents(state);
  if (events.length > 1 || state.inputEvents.length) return events.map(formatInputEventLine).join("\n");

  const event = state.inputEvent;

  if (event.type === "danmaku") return formatInputEventLine(event);
  if (event.type === "gift") return formatInputEventLine(event);
  if (event.type === "live-system") return formatInputEventLine(event);
  if (event.type === "game-state") return formatInputEventLine(event);
  if (event.type === "game-tick") return formatInputEventLine(event);
  if (event.type === "debug-control") return formatInputEventLine(event);

  return state.trigger;
}

function formatInputEventLine(event: InputEvent): string {
  if (event.type === "danmaku") return `[弹幕] ${event.user}: ${event.text}`;
  if (event.type === "gift") return `[礼物] ${event.user} 送出 ${event.count} 个 ${event.giftName}`;
  if (event.type === "live-system") return `[系统] ${event.message}`;
  if (event.type === "game-state") return `[游戏状态] ${event.state.summary}`;
  if (event.type === "game-tick") return `[游戏tick] ${event.reason || "timer"}`;
  if (event.type === "debug-control") return `[控制] 切换到 ${event.mode} mode`;
  return `[系统] ${event.type}`;
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

function getLastAssistantContentForDecision(state: AgentGraphState): string {
  const deepseekContent = getDeepSeekMessageContent(getLastDeepSeekAssistantMessage(state));
  if (deepseekContent.trim()) return deepseekContent;

  return getLastAiMessageContent(state);
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

    /**
     * 这里仅用于本地 debug / UI。
     * 真正回传 DeepSeek 的 reasoning_content 依赖 state.deepseekMessages 原始消息链。
     */
    additional_kwargs: {
      reasoning_content: message.reasoning_content,
      tool_calls: message.tool_calls
    }
  } as any);
}

function getDeepSeekMessageContent(message: DeepSeekMessage | undefined): string {
  const content = message?.content;

  if (typeof content === "string") {
    return content;
  }

  return "";
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

function getLastAiMessage(state: AgentGraphState): AIMessage | undefined {
  const last = state.messages.at(-1);
  return AIMessage.isInstance(last) ? last : undefined;
}

function getLastAiMessageContent(state: AgentGraphState): string {
  const content = getLastAiMessage(state)?.content;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : "text" in item && typeof item.text === "string" ? item.text : ""))
      .join("\n");
  }

  return "";
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return {};

    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function parseExpressDecision(content: string): AgentDecision | undefined {
  const parsed = parseJsonObject(content);
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.expressed !== true) return undefined;
  const decision = normalizeDecision(record.decision);
  return decision.shouldSpeak ? decision : undefined;
}

function parseEnterGameModeUpdate(content: string): AgentGraphUpdate | undefined {
  const parsed = parseJsonObject(content);
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.control !== "enter_game_mode" || record.mode !== "game") return undefined;

  const now = Date.now();
  const rawSession = record.gameSession;
  const session = rawSession && typeof rawSession === "object" ? (rawSession as Partial<GameSession>) : {};
  return {
    mode: "game",
    route: "game",
    shouldStartGame: false,
    gameSession: {
      status: "running",
      startedAt: typeof session.startedAt === "number" ? session.startedAt : now,
      tickCount: typeof session.tickCount === "number" ? session.tickCount : 0,
      actionCount: typeof session.actionCount === "number" ? session.actionCount : 0
    }
  };
}

function decisionFromPlainText(content: string): AgentDecision {
  const text = content.replace(/\s+/g, " ").trim().slice(0, 180);
  return {
    say: text,
    subtitleJa: text,
    subtitleZh: "",
    emotion: "neutral",
    avatarAction: "talk",
    shouldSpeak: true,
    gameIntent: "none"
  };
}

function stringifyToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function withToolResults(prompt: AgentPrompt, toolResults: ToolResult[]): AgentPrompt {
  if (!toolResults.length) return prompt;

  return {
    ...prompt,
    trigger: `${prompt.trigger}\n工具结果：${toolResults.map((item) => `${item.name}: ${item.content}`).join(" / ")}`
  };
}

function emitToolCall(options: CreateAgentGraphOptions, event: Omit<ToolCallEvent, "type" | "id" | "ts">): void {
  options.onToolCall?.({
    type: "tool-call",
    id: newId("tool"),
    ts: Date.now(),
    ...event
  });
}

function emitTrace(
  options: CreateAgentGraphOptions,
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

function emitFinalTrace(options: CreateAgentGraphOptions, state: AgentGraphState, decision: AgentDecision): void {
  emitTrace(options, state, {
    stage: "final",
    title: "最终回复",
    message: decision.say,
    detail: {
      emotion: decision.emotion,
      avatarAction: decision.avatarAction,
      gameIntent: decision.gameIntent
    }
  });
}

function logDecisionFinalized(
  activeLogger: Logger,
  state: AgentGraphState,
  decision: AgentDecision,
  hasExpressedDecision: boolean
): void {
  activeLogger.info("decision finalized", {
    runId: state.runId,
    shouldSpeak: decision.shouldSpeak,
    emotion: decision.emotion,
    avatarAction: decision.avatarAction,
    gameIntent: decision.gameIntent,
    hasExpressedDecision
  });
}

function summarizeDeepSeekMessage(message: DeepSeekMessage): string {
  const content = getDeepSeekMessageContent(message);
  if (!content) return "";

  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 240)}...`;
}

function compactDetail(value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text || text.length <= 500) return value;

  return `${text.slice(0, 500)}...`;
}

function summarizeToolContent(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= 420) return compact;

  return `${compact.slice(0, 420)}...`;
}

type DeepSeekDebugPayload = {
  request: unknown;
  response: unknown;
  assistantMessage: unknown;
};

function emitDeepSeekRawOutputDebug(
  options: CreateAgentGraphOptions,
  state: AgentGraphState,
  payload: DeepSeekDebugPayload
): void {
  if (!options.debugDeepSeekRawOutput && !options.debugDeepSeekRawOutputToTrace) {
    return;
  }

  const clonedPayload = toJsonSafe(payload);

  const outputPayload = options.debugDeepSeekRawOutputIncludeReasoning
    ? clonedPayload
    : redactReasoningContent(clonedPayload);

  if (options.debugDeepSeekRawOutput) {
    appendDebugOutput(
      `========== DeepSeek Raw Output ==========\n${inspect(outputPayload, {
        depth: null,
        colors: false,
        maxArrayLength: null,
        maxStringLength: null
      })}\n========== End DeepSeek Raw Output ==========`
    );
  }

  if (options.debugDeepSeekRawOutputToTrace) {
    emitTrace(options, state, {
      stage: "llm-message",
      title: "DeepSeek 原始输出",
      message: options.debugDeepSeekRawOutputIncludeReasoning
        ? "已记录 DeepSeek 完整原始输出，包含 reasoning_content。"
        : "已记录 DeepSeek 原始输出，但 reasoning_content 已隐藏。",
      detail: outputPayload
    });
  }
}

function toJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, item) => {
        if (typeof item === "bigint") return item.toString();
        return item;
      })
    );
  } catch {
    return String(value);
  }
}

function redactReasoningContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactReasoningContent(item));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      if (key === "reasoning_content") {
        output[key] =
          typeof item === "string"
            ? `[hidden reasoning_content, ${item.length} chars]`
            : "[hidden reasoning_content]";
        continue;
      }

      output[key] = redactReasoningContent(item);
    }

    return output;
  }

  return value;
}

type MermaidCapableGraph = {
  getGraphAsync: () => Promise<{
    drawMermaid: () => string;
  }>;
};

export async function getAgentGraphMermaidText(graph: MermaidCapableGraph): Promise<string> {
  const drawableGraph = await graph.getGraphAsync();
  return drawableGraph.drawMermaid();
}

export async function writeAgentGraphMermaidText(graph: MermaidCapableGraph): Promise<string> {
  const mermaid = await getAgentGraphMermaidText(graph);

  appendDebugOutput(`========== LangGraph Mermaid ==========\n${mermaid}\n========== End LangGraph Mermaid ==========`);

  return mermaid;
}

function appendDebugOutput(content: string): void {
  try {
    mkdirSync(dirname(debugOutputFilePath), { recursive: true });
    writeFileSync(debugOutputFilePath, `[${new Date().toISOString()}]\n${content}\n`, "utf8");
  } catch (error) {
    logger.warn("unable to write agent debug output file", error);
  }
}
