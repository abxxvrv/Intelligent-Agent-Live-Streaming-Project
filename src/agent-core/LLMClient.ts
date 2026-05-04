import type { AppConfig } from "../config.js";
import type { AgentDecision, Emotion, GameIntent, AvatarAction } from "../types.js";
import { Logger } from "../utils/logger.js";

export type AgentPrompt = {
  persona: string;
  trigger: string;
  gameSummary?: string;
  recentDanmaku: string[];
  recentReplies: string[];
};

const EMOTIONS: Emotion[] = ["neutral", "happy", "thinking", "surprised", "focus", "awkward"];
const ACTIONS: AvatarAction[] = ["idle", "talk", "nod", "wave", "think", "panic"];
const INTENTS: GameIntent[] = ["none", "explain_state", "consider_card", "consider_path", "celebrate", "warn"];

export class LLMClient {
  private readonly logger = new Logger("llm");

  constructor(private readonly config: AppConfig) {}

  async decide(prompt: AgentPrompt): Promise<AgentDecision> {
    if (!this.config.llm.apiKey) {
      return fallbackDecision(prompt);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.llm.timeoutMs);
      const response = await fetch(`${this.config.llm.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.llm.apiKey}`
        },
        body: JSON.stringify({
          model: this.config.llm.model,
          temperature: 0.8,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt(prompt.persona) },
            { role: "user", content: userPrompt(prompt) }
          ]
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`LLM HTTP ${response.status}: ${await response.text()}`);
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content || "";
      return normalizeDecision(parseJsonObject(content));
    } catch (error) {
      this.logger.warn("LLM failed, using fallback decision", error);
      return fallbackDecision(prompt);
    }
  }
}

export function normalizeDecision(value: unknown): AgentDecision {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const say = sanitizeSay(stringFrom(obj.say) || stringFrom(obj.textJa));
  const subtitleJa = sanitizeSubtitle(stringFrom(obj.subtitleJa) || stringFrom(obj.textJa) || say);
  const subtitleZh = sanitizeSubtitle(stringFrom(obj.subtitleZh) || stringFrom(obj.textZh));
  const emotion = pick(EMOTIONS, obj.emotion, "neutral");
  const avatarAction = pick(ACTIONS, obj.avatarAction, say ? "talk" : "idle");
  const shouldSpeak = typeof obj.shouldSpeak === "boolean" ? obj.shouldSpeak : Boolean(say);
  const gameIntent = pick(INTENTS, obj.gameIntent, "none");
  return {
    say,
    subtitleJa,
    subtitleZh,
    emotion,
    avatarAction,
    shouldSpeak: shouldSpeak && Boolean(say),
    gameIntent
  };
}

function systemPrompt(persona: string): string {
  return `${persona}

你必须只输出 JSON，不要 Markdown，不要解释。字段固定：
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
- 不要逐字复读弹幕。
- 不要承诺现实世界能力。
- 不要自动发送弹幕。
- 直播冷场时可以自然抛话题。
- 游戏建议保持谨慎，像主播在思考，而不是绝对命令。
- 游戏理解、弹幕理解、内部上下文尽量使用中文。
- 只有最终可朗读内容 say 使用日语。
- subtitleZh 必须是中文。`;
}

function userPrompt(prompt: AgentPrompt): string {
  return [
    `触发事件：${prompt.trigger}`,
    `当前游戏：${prompt.gameSummary || "暂时没有游戏状态"}`,
    `最近弹幕：${prompt.recentDanmaku.length ? prompt.recentDanmaku.join(" / ") : "无"}`,
    `最近回复：${prompt.recentReplies.length ? prompt.recentReplies.join(" / ") : "无"}`
  ].join("\n");
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return {};
    return JSON.parse(match[0]);
  }
}

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function sanitizeSay(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function sanitizeSubtitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function stringFrom(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bilingualFallback(say: string, subtitleZh: string, rest: Omit<AgentDecision, "say" | "subtitleJa" | "subtitleZh">): AgentDecision {
  return {
    say,
    subtitleJa: say,
    subtitleZh,
    ...rest
  };
}

export function fallbackDecision(prompt: AgentPrompt): AgentDecision {
  const trigger = prompt.trigger;
  const gameSummary = prompt.gameSummary || "";
  if (trigger.includes("冷场")) {
    return bilingualFallback(
      gameSummary ? "まず盤面を見て、少し慎重にいくね。" : "ちょっと静かだね。頭を起動しておくよ。",
      gameSummary ? `我先看一眼局面，${gameSummary}，这把得稳一点。` : "直播间突然安静，我先偷偷把脑子开机一下。",
      {
        emotion: "thinking",
        avatarAction: "think",
        shouldSpeak: true,
        gameIntent: gameSummary ? "explain_state" : "none"
      }
    );
  }
  if (trigger.includes("送出")) {
    return bilingualFallback(
      "応援ありがとう。このエネルギー、ちゃんと受け取ったよ。",
      "谢谢支持！这份能量我收下了，下一步尽量不乱来。",
      {
        emotion: "happy",
        avatarAction: "wave",
        shouldSpeak: true,
        gameIntent: "none"
      }
    );
  }
  if (trigger.includes("游戏状态")) {
    return bilingualFallback(
      gameSummary ? "今の盤面を確認したよ。まずは安全寄りに考えるね。" : "盤面を見ているところだよ。まだ急いで決めないね。",
      gameSummary ? `现在局面是${gameSummary}，我先按保守路线想一下。` : "我在看局面，先不急着下判断。",
      {
        emotion: "focus",
        avatarAction: "think",
        shouldSpeak: true,
        gameIntent: "explain_state"
      }
    );
  }
  return bilingualFallback(
    "その提案、見えたよ。今の状況と合わせて考えてみるね。",
    "这个建议我看到了，我先结合当前局面想一下，不急着莽。",
    {
      emotion: "thinking",
      avatarAction: "nod",
      shouldSpeak: true,
      gameIntent: "consider_card"
    }
  );
}
