import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { AgentDecision, AvatarAction, Emotion, GameIntent } from "../../types.js";

export const emotionSchema = z.enum(["neutral", "happy", "thinking", "surprised", "focus", "awkward"]);
export const actionSchema = z.enum(["idle", "talk", "nod", "wave", "think", "panic"]);
export const gameIntentSchema = z.enum(["none", "explain_state", "consider_card", "consider_path", "celebrate", "warn"]);

export function createExpressTool(): StructuredToolInterface {
  return tool(
    async ({
      textJa,
      textZh,
      emotion,
      avatarAction,
      gameIntent
    }: {
      textJa: string;
      textZh: string;
      emotion: Emotion;
      avatarAction?: AvatarAction;
      gameIntent?: GameIntent;
    }) => {
      const ja = textJa.trim().slice(0, 180);
      const zh = textZh.trim().slice(0, 180);
      const decision: AgentDecision = {
        say: ja,
        subtitleJa: ja,
        subtitleZh: zh,
        emotion,
        avatarAction: avatarAction || "talk",
        shouldSpeak: true,
        gameIntent: gameIntent || "none"
      };
      return JSON.stringify({ expressed: true, decision });
    },
    {
      name: "express",
      description:
        "通用表达工具。用严格 JSON 参数给出日文朗读文本 textJa、对应中文字幕 textZh、表情和动作；普通可见回复优先使用这个工具。",
      schema: z.object({
        textJa: z.string().trim().min(1).max(180),
        textZh: z.string().trim().min(1).max(180),
        emotion: emotionSchema,
        avatarAction: actionSchema.optional(),
        gameIntent: gameIntentSchema.optional()
      })
    }
  );
}
