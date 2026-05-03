import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { AutoplayGoal, AutoplayRunner } from "./AutoplayRunner.js";

export type AutoplayController = Pick<AutoplayRunner, "start" | "stop">;

export function createAutoplayTools(autoplayRunner: AutoplayController): StructuredToolInterface[] {
  return [
    tool(
      async ({ mode, count }: { mode: "steps" | "floors" | "combat" | "until_next_room"; count?: number }) => {
        const goal = toGoal(mode, count);
        const run = autoplayRunner.start(goal);
        return JSON.stringify({
          started: true,
          runId: run.id,
          goal: run.goal
        });
      },
      {
        name: "start_autoplay",
        description:
          "启动 STS2 自动游玩长任务。用于用户明确要求自动打一段时间、自动打几层、自动打完战斗等场景。不要用它处理普通聊天。",
        schema: z.object({
          mode: z.enum(["steps", "floors", "combat", "until_next_room"]),
          count: z.number().int().min(1).max(50).optional()
        })
      }
    ),
    tool(
      async ({ reason }: { reason?: string }) => {
        const stopReason = reason || "管理员要求停止";
        autoplayRunner.stop(stopReason);
        return JSON.stringify({
          stopped: true,
          reason: stopReason
        });
      },
      {
        name: "stop_autoplay",
        description: "停止当前 STS2 自动游玩任务。",
        schema: z.object({
          reason: z.string().max(100).optional()
        })
      }
    )
  ];
}

export function toGoal(mode: "steps" | "floors" | "combat" | "until_next_room", count?: number): AutoplayGoal {
  if (mode === "floors") return { kind: "floors", count: count ?? 2 };
  if (mode === "combat") return { kind: "combat" };
  if (mode === "until_next_room") return { kind: "until_next_room" };
  return { kind: "steps", maxSteps: count ?? 10 };
}
