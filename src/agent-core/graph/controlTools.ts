import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

export function createEnterGameModeTool(): StructuredToolInterface {
  return tool(
    async ({ reason }: { reason?: string }) => {
      return JSON.stringify({
        control: "enter_game_mode",
        mode: "game",
        route: "game",
        reason: reason || "",
        gameSession: {
          status: "running",
          startedAt: Date.now(),
          tickCount: 0,
          actionCount: 0
        }
      });
    },
    {
      name: "enter_game_mode",
      description:
        "进入持续游戏模式。观众明确要求开始玩、自动打、连续推进、进入游戏代理时调用；调用后后续 game_tick 会由游戏子图读取状态并决定动作。",
      schema: z.object({
        reason: z.string().max(120).optional()
      })
    }
  );
}
