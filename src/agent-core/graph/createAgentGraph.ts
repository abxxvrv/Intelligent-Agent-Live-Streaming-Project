import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import type { AppConfig } from "../../config.js";
import type { AgentDecision, AgentTraceEvent, ToolCallEvent } from "../../types.js";
import { newId } from "../../utils/id.js";
import { Logger } from "../../utils/logger.js";
import { fallbackDecision, normalizeDecision, type AgentPrompt } from "../LLMClient.js";
import { AgentState, type AgentGraphState, type AgentGraphUpdate, type ToolResult } from "./AgentState.js";
import { createAgentTools, type AgentToolContext } from "./tools.js";

type CreateAgentGraphOptions = {
  config: AppConfig;
  shouldRespond: (state: AgentGraphState) => boolean;
  toolContext: AgentToolContext;
  extraTools?: StructuredToolInterface[];
  maxToolLoops?: number;
  logger?: Logger;
  sts2McpToolsEnabled?: boolean;
  canUseSts2Actions?: () => boolean;
  onToolCall?: (event: ToolCallEvent) => void;
  onTrace?: (event: AgentTraceEvent) => void;
};

const logger = new Logger("agent-graph");

export function createAgentGraph(options: CreateAgentGraphOptions) {
  const activeLogger = options.logger || logger;
  const maxToolLoops = options.maxToolLoops ?? 2;
  const tools = [...createAgentTools(options.toolContext), ...(options.extraTools || [])];
  const toolsByName = new Map(tools.map((item) => [item.name, item]));
  const model = createModel(options.config, tools);

  const ingestEvent = async (state: AgentGraphState): Promise<AgentGraphUpdate> => ({
    trigger: state.trigger || "直播事件",
    messages: []
  });

  const shouldRespond = async (state: AgentGraphState): Promise<AgentGraphUpdate> => ({
    shouldRespond: options.shouldRespond(state)
  });

  const agentLlm = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    const prompt = toPrompt(options.config, state);
    emitTrace(options, state, {
      stage: "llm-start",
      title: "模型处理",
      message: "模型开始处理这条消息。"
    });
    if (!model) {
      emitTrace(options, state, {
        stage: "llm-message",
        title: "本地回退",
        message: "没有配置可用的 LLM API key，我会使用本地 fallback 回复。"
      });
      return { decision: fallbackDecision(prompt) };
    }

    try {
      const response = await model.invoke(buildAgentMessages(options.config, state));
      const publicMessage = summarizeAiMessage(response);
      if (publicMessage) {
        emitTrace(options, state, {
          stage: "llm-message",
          title: "模型说明",
          message: publicMessage
        });
      }
      if (response.tool_calls?.length) {
        for (const call of response.tool_calls) {
          emitTrace(options, state, {
            stage: "tool-intent",
            title: "准备调用工具",
            message: `我准备调用 ${call.name}。`,
            toolName: call.name,
            status: "start",
            detail: compactDetail(call.args)
          });
        }
      }
      return { messages: [response] };
    } catch (error) {
      activeLogger.warn("LangGraph LLM call failed, using fallback decision", error);
      emitTrace(options, state, {
        stage: "llm-message",
        title: "模型失败",
        message: `LLM 调用失败，使用本地 fallback 回复：${error instanceof Error ? error.message : String(error)}`
      });
      return { decision: fallbackDecision(prompt) };
    }
  };

  const runTools = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    const last = getLastAiMessage(state);
    const toolCalls = last?.tool_calls || [];
    const messages: ToolMessage[] = [];
    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      const selectedTool = toolsByName.get(call.name);
      if (!selectedTool) {
        const content = JSON.stringify({ error: `Tool ${call.name} is not allowed` });
        emitTrace(options, state, {
          stage: "tool-result",
          title: "工具被拒绝",
          message: `工具 ${call.name} 不在白名单中。`,
          toolName: call.name,
          status: "error",
          detail: content
        });
        messages.push(new ToolMessage({ content, tool_call_id: call.id || call.name, status: "error" }));
        results.push({ name: call.name, content });
        continue;
      }

      try {
        if (call.name === "act" && !options.canUseSts2Actions?.()) {
          const content = JSON.stringify({
            error: "autoplay is disabled; enable manual takeover from /debug before calling act"
          });
          emitToolCall(options, {
            name: call.name,
            status: "error",
            args: call.args,
            error: "autoplay is disabled"
          });
          emitTrace(options, state, {
            stage: "tool-result",
            title: "工具被闸门拦截",
            message: "act 需要先在 /debug 开启手动接管。",
            toolName: call.name,
            status: "error",
            detail: content
          });
          messages.push(new ToolMessage({ content, tool_call_id: call.id || call.name, status: "error" }));
          results.push({ name: call.name, content });
          continue;
        }

        emitToolCall(options, {
          name: call.name,
          status: "start",
          args: call.args
        });
        const output = await selectedTool.invoke(call.args);
        const content = stringifyToolOutput(output);
        const resultSummary = summarizeToolContent(content);
        emitToolCall(options, {
          name: call.name,
          status: "success",
          args: call.args,
          resultSummary
        });
        emitTrace(options, state, {
          stage: "tool-result",
          title: "工具完成",
          message: `${call.name} 成功：${resultSummary}`,
          toolName: call.name,
          status: "success",
          detail: resultSummary
        });
        messages.push(new ToolMessage({ content, tool_call_id: call.id || call.name, status: "success" }));
        results.push({ name: call.name, content });
      } catch (error) {
        const content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        emitToolCall(options, {
          name: call.name,
          status: "error",
          args: call.args,
          error: error instanceof Error ? error.message : String(error)
        });
        emitTrace(options, state, {
          stage: "tool-result",
          title: "工具失败",
          message: `${call.name} 失败：${error instanceof Error ? error.message : String(error)}`,
          toolName: call.name,
          status: "error",
          detail: content
        });
        messages.push(new ToolMessage({ content, tool_call_id: call.id || call.name, status: "error" }));
        results.push({ name: call.name, content });
      }
    }

    return { messages, toolResults: results, toolLoopCount: state.toolLoopCount + 1 };
  };

  const finalizeDecision = async (state: AgentGraphState): Promise<AgentGraphUpdate> => {
    if (state.decision) {
      emitFinalTrace(options, state, state.decision);
      return { decision: state.decision };
    }
    const prompt = toPrompt(options.config, state);
    const content = getLastAiMessageContent(state);
    const parsed = parseJsonObject(content);
    const decision = normalizeDecision(parsed);
    if (decision.shouldSpeak) {
      emitFinalTrace(options, state, decision);
      return { decision };
    }
    if (content.trim()) {
      const textDecision = decisionFromPlainText(content);
      emitFinalTrace(options, state, textDecision);
      return { decision: textDecision };
    }
    const fallback = fallbackDecision(withToolResults(prompt, state.toolResults));
    emitFinalTrace(options, state, fallback);
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
    .addConditionalEdges("tools", (state) => (state.toolLoopCount < maxToolLoops ? "agent_llm" : "finalize_decision"))
    .addEdge("finalize_decision", END)
    .compile();
}

function createModel(config: AppConfig, tools: StructuredToolInterface[]) {
  if (!config.llm.apiKey) return undefined;
  return new ChatOpenAI({
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    temperature: 0.8,
    timeout: config.llm.timeoutMs,
    configuration: {
      baseURL: config.llm.baseUrl
    }
  }).bindTools(tools);
}

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

function systemPrompt(config: AppConfig, state: AgentGraphState): string {
  const persona = config.agent.persona || state.persona;
  const remembered = state.memoryNotes.length ? `\n已记住的信息：${state.memoryNotes.join(" / ")}` : "";
  return `${persona}

请结合已有对话历史，像正常聊天一样自然、连贯地回应当前用户。
你可以在判断有帮助时使用当前提供的工具。不要声称已经执行没有实际结果的操作。
最终回复应当是可解析的 JSON 对象，字段固定：
{
  "say": "中文口语回复，最多 90 个汉字",
  "emotion": "neutral|happy|thinking|surprised|focus|awkward",
  "avatarAction": "idle|talk|nod|wave|think|panic",
  "shouldSpeak": true,
  "gameIntent": "none|explain_state|consider_card|consider_path|celebrate|warn"
}

不要输出 Markdown。${remembered}`;
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

function chatInput(state: AgentGraphState): string {
  const event = state.inputEvent;
  if (event.type === "danmaku") return event.text;
  if (event.type === "gift") return `${event.user} 送出 ${event.count} 个 ${event.giftName}`;
  if (event.type === "live-system") return event.message;
  if (event.type === "game-state") return event.state.summary;
  return state.trigger;
}

function hasToolCalls(state: AgentGraphState): boolean {
  return Boolean(getLastAiMessage(state)?.tool_calls?.length);
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

function decisionFromPlainText(content: string): AgentDecision {
  return {
    say: content.replace(/\s+/g, " ").trim().slice(0, 180),
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

function emitToolCall(
  options: CreateAgentGraphOptions,
  event: Omit<ToolCallEvent, "type" | "id" | "ts">
): void {
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

function summarizeAiMessage(message: AIMessage): string {
  const content = getMessageContent(message);
  if (!content) return "";
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 240)}...`;
}

function getMessageContent(message: AIMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((item) => (typeof item === "string" ? item : "text" in item && typeof item.text === "string" ? item.text : ""))
      .join("\n")
      .trim();
  }
  return "";
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
