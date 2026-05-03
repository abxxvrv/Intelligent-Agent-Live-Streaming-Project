import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { AvatarAction, Emotion } from "../../types.js";

const emotionSchema = z.enum(["neutral", "happy", "thinking", "surprised", "focus", "awkward"]);
const actionSchema = z.enum(["idle", "talk", "nod", "wave", "think", "panic"]);

export type AgentToolContext = {
  getGameSummary: () => string | undefined;
  rememberNote: (note: string) => void;
};

export function createAgentTools(context: AgentToolContext): StructuredToolInterface[] {
  return [
    tool(
      async () => {
        return JSON.stringify({
          summary: context.getGameSummary() || "暂时没有可用游戏状态"
        });
      },
      {
        name: "get_game_summary",
        description: "读取当前缓存的《杀戮尖塔2》局面摘要。只读工具，不会操作游戏。",
        schema: z.object({})
      }
    ),
    tool(
      async ({ emotion, action, reason }: { emotion: Emotion; action: AvatarAction; reason?: string }) => {
        return JSON.stringify({ emotion, action, reason: reason || "" });
      },
      {
        name: "set_avatar_intent",
        description: "为下一句回复选择虚拟形象的表情和动作，只返回意图，不直接修改 overlay。",
        schema: z.object({
          emotion: emotionSchema,
          action: actionSchema,
          reason: z.string().max(80).optional()
        })
      }
    ),
    tool(
      async ({ note }: { note: string }) => {
        const cleaned = note.trim().slice(0, 80);
        if (cleaned) context.rememberNote(cleaned);
        return JSON.stringify({ remembered: Boolean(cleaned), note: cleaned });
      },
      {
        name: "remember_note",
        description: "记录一条简短直播记忆或观众偏好。不要记录隐私、账号、联系方式或敏感信息。",
        schema: z.object({
          note: z.string().min(1).max(80)
        })
      }
    ),
    tool(
      async ({ requestedAction, reason }: { requestedAction: string; reason?: string }) => {
        return JSON.stringify({
          executed: false,
          requestedAction,
          reason: reason || "当前阶段游戏动作工具未启用，只能讨论局面，不能真正操作游戏。"
        });
      },
      {
        name: "no_op_game_action",
        description: "占位游戏动作工具。模型想出牌、选牌或走路线时调用它；它不会真的操作游戏。",
        schema: z.object({
          requestedAction: z.string().min(1).max(120),
          reason: z.string().max(120).optional()
        })
      }
    )
  ];
}
