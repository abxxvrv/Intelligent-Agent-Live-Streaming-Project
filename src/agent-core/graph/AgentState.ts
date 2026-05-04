import type { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import type { ConversationTurn } from "../Memory.js";
import type { AgentDecision, InputEvent } from "../../types.js";

export type AgentMode = "chat" | "game";
export type AgentRoute = "chat" | "game" | "control" | "ignore";

export type GameSession = {
  status: "idle" | "running" | "ended";
  startedAt?: number;
  endedAt?: number;
  tickCount: number;
  actionCount: number;
  healthChecked?: boolean;
  lastGameStatus?: string;
};

export type AudienceContext = {
  currentEvents: InputEvent[];
  recentMessages: Array<{ user: string; text: string; ts: number }>;
  giftEvents: Array<{ user: string; giftName: string; count: number; ts: number }>;
  adminCommands: string[];
  voteSummary?: Record<string, number>;
  dominantSuggestion?: string;
};

export type ToolResult = {
  name: string;
  content: string;
};

export type DeepSeekToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  index?: number;
  [key: string]: unknown;
};

export type DeepSeekMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;

  /**
   * DeepSeek thinking mode 的关键字段。
   * 如果 assistant message 发生了 tool call，后续请求必须原样带回这个字段。
   */
  reasoning_content?: string | null;

  tool_calls?: DeepSeekToolCall[] | null;
  tool_call_id?: string;
  name?: string;

  /**
   * 保留 DeepSeek / OpenAI-compatible API 未来可能返回的扩展字段。
   */
  [key: string]: unknown;
};

export const AgentState = Annotation.Root({
  inputEvent: Annotation<InputEvent>(),
  inputEvents: Annotation<InputEvent[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  runId: Annotation<string>(),
  persona: Annotation<string>(),
  trigger: Annotation<string>(),
  gameSummary: Annotation<string | undefined>(),
  mode: Annotation<AgentMode>({
    reducer: (_left, right) => right,
    default: () => "chat"
  }),
  route: Annotation<AgentRoute>({
    reducer: (_left, right) => right,
    default: () => "chat"
  }),
  shouldStartGame: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false
  }),

  gameState: Annotation<unknown>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),

  availableActions: Annotation<unknown[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),

  observedAt: Annotation<number | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),

  gameOver: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false
  }),

  gameSession: Annotation<GameSession>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({
      status: "idle",
      tickCount: 0,
      actionCount: 0
    })
  }),

  audienceContext: Annotation<AudienceContext>({
    reducer: (_left, right) => right,
    default: () => ({
      currentEvents: [],
      recentMessages: [],
      giftEvents: [],
      adminCommands: []
    })
  }),

  lastToolCategory: Annotation<
    "observe" | "metadata" | "express" | "game_action" | "control" | "error" | undefined
  >({
    reducer: (_left, right) => right,
    default: () => undefined
  }),

  gameActionExecuted: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false
  }),

  lastToolError: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),

  recentDanmaku: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),

  recentReplies: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),

  conversationHistory: Annotation<ConversationTurn[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),

  shouldRespond: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false
  }),

  /**
   * 原来的 LangChain 消息。
   * 可以继续用于 UI、trace、debug、兼容原有逻辑。
   */
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => []
  }),

  /**
   * 新增：DeepSeek 原始消息链。
   *
   * 这个数组不要转换成 LangChain AIMessage 再传给 DeepSeek。
   * 它的作用是保留 reasoning_content / tool_calls / tool_call_id 等原始字段。
   */
  deepseekMessages: Annotation<DeepSeekMessage[]>({
    reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => []
  }),

  toolResults: Annotation<ToolResult[]>({
    reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => []
  }),

  toolLoopCount: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0
  }),

  expressedDecision: Annotation<AgentDecision | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),

  memoryNotes: Annotation<string[]>({
    reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => []
  }),

  decision: Annotation<AgentDecision | undefined>()
});

export type AgentGraphState = typeof AgentState.State;
export type AgentGraphUpdate = Partial<AgentGraphState>;
