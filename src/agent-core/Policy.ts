import type { AppConfig } from "../config.js";
import type { DanmakuEvent, GiftEvent, InputEvent } from "../types.js";

const QUESTION_MARKERS = ["?", "？", "怎么", "为什么", "吗", "哪", "要不要", "可以", "是不是"];
const GAME_MARKERS = ["牌", "怪", "血", "路线", "遗物", "出", "拿", "删", "boss", "战斗", "防"];

export class SpeakPolicy {
  private lastSpeakAt = 0;
  private pendingDanmaku: DanmakuEvent[] = [];

  constructor(private readonly config: AppConfig) {}

  registerSpeak(now = Date.now()): void {
    this.lastSpeakAt = now;
    this.pendingDanmaku = [];
  }

  shouldRespond(event: InputEvent, now = Date.now()): boolean {
    if (event.type === "danmaku") {
      if (isSpammy(event.text)) return false;
      this.pendingDanmaku.push(event);
      this.pendingDanmaku = this.pendingDanmaku.slice(-5);
      if (now - this.lastSpeakAt < this.config.agent.speakCooldownMs) return false;
      return isMention(event, this.config.agent.name) || isQuestion(event.text) || isGameRelated(event.text);
    }

    if (event.type === "gift") {
      return now - this.lastSpeakAt >= Math.max(3_000, this.config.agent.speakCooldownMs / 2);
    }

  if (event.type === "game-state") {
    return now - this.lastSpeakAt >= this.config.agent.speakCooldownMs * 2;
  }

    if (event.type === "idle") {
      return now - this.lastSpeakAt >= this.config.agent.idlePromptMs;
    }

    return false;
  }

  getPendingDanmaku(): DanmakuEvent[] {
    return [...this.pendingDanmaku];
  }
}

export function describeTrigger(event: InputEvent): string {
  if (event.type === "danmaku") return `观众 ${event.user} 说：${event.text}`;
  if (event.type === "gift") return describeGift(event);
  if (event.type === "game-state") return `游戏状态更新：${event.state.summary}`;
  if (event.type === "game-tick") return `游戏 tick：${event.reason || "timer"}`;
  if (event.type === "debug-control") return `控制命令：切换到 ${event.mode} mode`;
  if (event.type === "idle") return "直播间冷场了一小会儿";
  return "直播事件";
}

function describeGift(event: GiftEvent): string {
  return `观众 ${event.user} 送出 ${event.count} 个 ${event.giftName}`;
}

function isMention(event: DanmakuEvent, name: string): boolean {
  return event.text.includes(name) || event.text.includes("主播");
}

function isQuestion(text: string): boolean {
  return QUESTION_MARKERS.some((marker) => text.includes(marker));
}

function isGameRelated(text: string): boolean {
  const lower = text.toLowerCase();
  return GAME_MARKERS.some((marker) => lower.includes(marker));
}

function isSpammy(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 120) return true;
  if (/(.)\1{8,}/u.test(trimmed)) return true;
  return false;
}
