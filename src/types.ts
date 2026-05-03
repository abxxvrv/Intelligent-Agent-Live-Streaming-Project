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

export type AgentTraceStage = "run-start" | "llm-start" | "llm-message" | "tool-intent" | "tool-result" | "final";

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
  autoplayEnabled: boolean;
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

export type InputEvent = DanmakuEvent | GiftEvent | LiveSystemEvent | GameEvent | IdleEvent;

export type RuntimeEvent = InputEvent | OverlayEvent;
