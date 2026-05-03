import type { AppConfig } from "../config.js";
import type { EventBus } from "../events/EventBus.js";
import type { InputEvent } from "../types.js";
import { newId } from "../utils/id.js";
import { LLMClient } from "./LLMClient.js";
import { Memory } from "./Memory.js";
import { describeTrigger, SpeakPolicy } from "./Policy.js";

export class AgentRuntime {
  private readonly memory: Memory;
  private readonly policy: SpeakPolicy;
  private readonly llm: LLMClient;
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly config: AppConfig) {
    this.memory = new Memory(config.agent.maxRecentDanmaku);
    this.policy = new SpeakPolicy(config);
    this.llm = new LLMClient(config);
  }

  start(bus: EventBus): void {
    bus.on("danmaku", (event) => this.handleInput(bus, event));
    bus.on("gift", (event) => this.handleInput(bus, event));
    bus.on("game-state", (event) => this.handleInput(bus, event));
    this.idleTimer = setInterval(() => {
      void this.handleInput(bus, { type: "idle", id: newId("idle"), ts: Date.now() });
    }, this.config.agent.idlePromptMs);
  }

  stop(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
  }

  private async handleInput(bus: EventBus, event: InputEvent): Promise<void> {
    if (event.type === "danmaku") this.memory.addDanmaku(event);
    if (event.type === "game-state") this.memory.setGameState(event.state);
    if (!this.policy.shouldRespond(event)) return;

    const recentDanmaku = mergeRecentDanmaku(
      this.memory.getRecentDanmaku(),
      event.type === "danmaku" ? this.policy.getPendingDanmaku() : []
    );
    const decision = await this.llm.decide({
      persona: this.config.agent.persona,
      trigger: describeTrigger(event),
      gameSummary: this.memory.getGameState()?.summary,
      recentDanmaku: recentDanmaku.map((item) => `${item.user}: ${item.text}`),
      recentReplies: this.memory.getRecentReplies()
    });

    if (!decision.shouldSpeak) return;
    this.policy.registerSpeak();
    this.memory.addReply(decision.say);
    bus.publish({
      type: "agent-reply",
      id: newId("reply"),
      ts: Date.now(),
      sourceEventId: event.id,
      decision
    });
  }
}

function mergeRecentDanmaku<T extends { id: string }>(left: T[], right: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of left) map.set(item.id, item);
  for (const item of right) map.set(item.id, item);
  return [...map.values()].slice(-20);
}
