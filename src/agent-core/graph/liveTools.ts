import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

export function createRecentChatMessagesTool(context: {
  getRecentLiveInputs: (input: {
    limit?: number;
    windowMs?: number;
    includeGifts?: boolean;
  }) => unknown;
}): StructuredToolInterface {
  return tool(
    async ({ limit, windowMs, includeGifts }) => {
      return JSON.stringify(
        context.getRecentLiveInputs({
          limit: limit ?? 10,
          windowMs: windowMs ?? 10_000,
          includeGifts: includeGifts ?? true
        })
      );
    },
    {
      name: "get_recent_chat_messages",
      description: "读取最近直播弹幕、礼物和投票摘要。游戏模式下用于理解观众建议。",
      schema: z.object({
        limit: z.number().int().min(1).max(50).optional(),
        windowMs: z.number().int().min(1000).max(60_000).optional(),
        includeGifts: z.boolean().optional()
      })
    }
  );
}
