export type Emotion =
  | "neutral"
  | "happy"
  | "thinking"
  | "surprised"
  | "focus"
  | "awkward";

export type AvatarAction =
  | "idle"
  | "talk"
  | "nod"
  | "wave"
  | "think"
  | "panic";

export type GameIntent =
  | "none"
  | "explain_state"
  | "consider_card"
  | "consider_path"
  | "celebrate"
  | "warn";

export type AgentDecision = {
  say: string;
  subtitleJa?: string;
  subtitleZh?: string;
  emotion: Emotion;
  avatarAction: AvatarAction;
  shouldSpeak: boolean;
  gameIntent: GameIntent;
};

export type AvatarCommand = {
  emotion: Emotion;
  action: AvatarAction;
  speaking: boolean;
  text?: string;
  subtitleJa?: string;
  subtitleZh?: string;
  durationMs?: number;
};

export type DanmakuEvent = {
  type: "danmaku";
  id: string;
  ts: number;
  user: string;
  text: string;
  raw?: unknown;
};

export type GiftEvent = {
  type: "gift";
  id: string;
  ts: number;
  user: string;
  giftName: string;
  count: number;
  raw?: unknown;
};

export type LiveSystemEvent = {
  type: "live-system";
  id: string;
  ts: number;
  message: string;
  raw?: unknown;
};

export type GameState = {
  hp?: number;
  maxHp?: number;
  floor?: number;
  act?: number;
  gold?: number;
  room?: string;
  inCombat?: boolean;
  deckSize?: number;
  relics?: string[];
  hand?: string[];
  enemies?: Array<{ name: string; hp?: number; intent?: string }>;
  raw?: unknown;
  summary: string;
};

export type GameEvent = {
  type: "game-state";
  id: string;
  ts: number;
  state: GameState;
};

export type IdleEvent = {
  type: "idle";
  id: string;
  ts: number;
};

export type GameTickEvent = {
  type: "game-tick";
  id: string;
  ts: number;
  reason?: "timer" | "manual" | "after-action";
};

export type AgentReplyEvent = {
  type: "agent-reply";
  id: string;
  ts: number;
  decision: AgentDecision;
  sourceEventId?: string;
};

export type VoiceEvent = {
  type: "voice";
  id: string;
  ts: number;
  status: "start" | "end" | "error";
  text?: string;
  subtitleJa?: string;
  subtitleZh?: string;
  audioUrl?: string;
  emotion?: Emotion;
  action?: AvatarAction;
  error?: string;
};

export type ToolCallEvent = {
  type: "tool-call";
  id: string;
  ts: number;
  name: string;
  status: "start" | "success" | "error";
  args?: unknown;
  resultSummary?: string;
  error?: string;
};

export type AgentTraceStage =
  | "queue"
  | "batch"
  | "run-start"
  | "run-end"
  | "router"
  | "control_node"
  | "mode-transition"
  | "chat-enter"
  | "chat-complete"
  | "chat-ingest"
  | "chat-should-respond"
  | "llm-start"
  | "llm-message"
  | "tool-loop"
  | "tool-intent"
  | "tool-result"
  | "preload_game_snapshot"
  | "game_agent_node"
  | "game_toolnode"
  | "evaluate_game_status"
  | "game-stub"
  | "final";

export type AgentTraceEvent = {
  type: "agent-trace";
  id: string;
  ts: number;
  runId: string;
  sourceEventId?: string;
  stage: AgentTraceStage;
  title: string;
  message: string;
  toolName?: string;
  status?: "start" | "success" | "error";
  detail?: unknown;
};

export type DebugControlEvent = {
  type: "debug-control";
  id: string;
  ts: number;
  mode: "chat" | "game";
  source?: string;
};

export type OverlayEvent =
  | DanmakuEvent
  | GiftEvent
  | LiveSystemEvent
  | GameEvent
  | AgentReplyEvent
  | VoiceEvent
  | ToolCallEvent
  | AgentTraceEvent
  | DebugControlEvent
  | {
      type: "avatar";
      id: string;
      ts: number;
      command: AvatarCommand;
    };

export type InputEvent =
  | DanmakuEvent
  | GiftEvent
  | LiveSystemEvent
  | GameEvent
  | IdleEvent
  | GameTickEvent
  | DebugControlEvent;

export type RuntimeEvent = InputEvent | OverlayEvent;
