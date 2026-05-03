import type { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import type { ConversationTurn } from "../Memory.js";
import type { AgentDecision, InputEvent } from "../../types.js";

export type ToolResult = {
  name: string;
  content: string;
};

export const AgentState = Annotation.Root({
  inputEvent: Annotation<InputEvent>(),
  runId: Annotation<string>(),
  persona: Annotation<string>(),
  trigger: Annotation<string>(),
  gameSummary: Annotation<string | undefined>(),
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
  messages: Annotation<BaseMessage[]>({
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
  memoryNotes: Annotation<string[]>({
    reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => []
  }),
  decision: Annotation<AgentDecision | undefined>()
});

export type AgentGraphState = typeof AgentState.State;
export type AgentGraphUpdate = Partial<AgentGraphState>;
