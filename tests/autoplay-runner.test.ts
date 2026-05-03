import { describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import {
  AutoplayRunner,
  getMessageText,
  parseJsonObject,
  parseMcpToolOutput
} from "../src/agent-core/autoplay/AutoplayRunner.js";
import { createAutoplayTools, toGoal } from "../src/agent-core/autoplay/tools.js";

describe("AutoplayRunner", () => {
  it("stops after the requested step count", async () => {
    const calls: string[] = [];
    const runner = new AutoplayRunner({
      config: testConfig(),
      tools: fakeTools({
        onAct: (args) => {
          calls.push(String(args.action));
          return { screen: "MAP", run: { floor: 1 }, in_combat: false };
        }
      }),
      canUseActions: () => true,
      decideAction: async () => ({ action: "advance", reason: "测试推进", confidence: 0.9 })
    });

    runner.start({ kind: "steps", maxSteps: 2 });

    await vi.waitFor(() => expect(runner.status?.status).toBe("stopped"));
    expect(calls).toEqual(["advance", "advance"]);
    expect(runner.status?.stopReason).toContain("已执行 2 步");
  });

  it("stops after advancing the requested floor count", async () => {
    let floor = 3;
    const runner = new AutoplayRunner({
      config: testConfig(),
      tools: fakeTools({
        getState: () => ({ screen: "MAP", run: { floor }, in_combat: false }),
        onAct: () => {
          floor += 1;
          return { screen: "MAP", run: { floor }, in_combat: false };
        }
      }),
      canUseActions: () => true,
      decideAction: async () => ({ action: "advance", reason: "测试推进楼层", confidence: 0.9 })
    });

    runner.start({ kind: "floors", count: 2 });

    await vi.waitFor(() => expect(runner.status?.status).toBe("stopped"));
    expect(floor).toBe(5);
    expect(runner.status?.stopReason).toContain("已推进 2 层");
  });

  it("stops after consecutive tool failures", async () => {
    const runner = new AutoplayRunner({
      config: testConfig(),
      tools: fakeTools({
        onAct: () => {
          throw new Error("boom");
        }
      }),
      canUseActions: () => true,
      decideAction: async () => ({ action: "advance", reason: "测试失败", confidence: 0.9 })
    });

    runner.start({ kind: "steps", maxSteps: 5 });

    await vi.waitFor(() => expect(runner.status?.status).toBe("stopped"));
    expect(runner.status?.stopReason).toContain("连续失败");
  });

  it("does not call relevant game data metadata without scoped ids", async () => {
    const metadataTool = vi.fn(async () => wrap({ unused: true }));
    const runner = new AutoplayRunner({
      config: testConfig(),
      tools: [...fakeTools({}), fakeTool("get_relevant_game_data", metadataTool)],
      canUseActions: () => true,
      decideAction: async () => ({ action: "advance", reason: "测试推进", confidence: 0.9 })
    });

    runner.start({ kind: "steps", maxSteps: 1 });

    await vi.waitFor(() => expect(runner.status?.status).toBe("stopped"));
    expect(metadataTool).not.toHaveBeenCalled();
  });

  it("waits for an actionable phase when actions are temporarily empty", async () => {
    const calls: string[] = [];
    const wait = vi.fn(async () =>
      wrap({
        state: { screen: "COMBAT", run: { floor: 1 }, in_combat: true },
        actions: [{ name: "end_turn", requires_index: false, requires_target: false }]
      })
    );
    const runner = new AutoplayRunner({
      config: testConfig(),
      tools: [
        ...fakeTools({
          getActions: () => [],
          onAct: (args) => {
            calls.push(String(args.action));
            return { screen: "COMBAT", run: { floor: 1 }, in_combat: true };
          }
        }).filter((tool) => tool.name !== "wait_until_actionable"),
        fakeTool("wait_until_actionable", wait)
      ],
      canUseActions: () => true,
      decideAction: async () => ({ action: "end_turn", reason: "等待后可行动", confidence: 0.9 })
    });

    runner.start({ kind: "steps", maxSteps: 1 });

    await vi.waitFor(() => expect(runner.status?.status).toBe("stopped"));
    expect(wait).toHaveBeenCalledWith({ timeout_seconds: 20 });
    expect(calls).toEqual(["end_turn"]);
  });

  it("rejects option-index actions before calling act when option_index is missing", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runner = new AutoplayRunner({
      config: testConfig(),
      tools: fakeTools({
        getActions: () => [{ name: "buy_card", requires_index: false, requires_target: false }],
        onAct: (args) => {
          calls.push(args);
          return { screen: "SHOP", run: { floor: 14 }, in_combat: false };
        }
      }),
      canUseActions: () => true,
      decideAction: async () => ({ action: "buy_card", reason: "测试购买", confidence: 0.9 })
    });

    runner.start({ kind: "steps", maxSteps: 1 });

    await vi.waitFor(() => expect(runner.status?.status).toBe("stopped"));
    expect(runner.status?.stopReason).toContain("需要 option_index");
    expect(calls).toEqual([]);
  });

  it("falls back to a safe no-index action when an indexed decision is incomplete", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runner = new AutoplayRunner({
      config: testConfig(),
      tools: fakeTools({
        getActions: () => [
          { name: "buy_card", requires_index: false, requires_target: false },
          { name: "close_shop_inventory", requires_index: false, requires_target: false }
        ],
        onAct: (args) => {
          calls.push(args);
          return { screen: "SHOP", run: { floor: 14 }, in_combat: false };
        }
      }),
      canUseActions: () => true,
      decideAction: async () => ({ action: "buy_card", reason: "测试购买", confidence: 0.9 })
    });

    runner.start({ kind: "steps", maxSteps: 1 });

    await vi.waitFor(() => expect(runner.status?.status).toBe("stopped"));
    expect(calls).toEqual([{ action: "close_shop_inventory" }]);
  });

  it("proceeds after closing shop inventory instead of reopening it", async () => {
    const calls: string[] = [];
    let actions = [
      { name: "open_shop_inventory", requires_index: false, requires_target: false },
      { name: "proceed", requires_index: false, requires_target: false }
    ];
    const runner = new AutoplayRunner({
      config: testConfig(),
      tools: fakeTools({
        getState: () => ({ screen: "SHOP", run: { floor: 14 }, in_combat: false }),
        getActions: () => actions,
        onAct: (args) => {
          const action = String(args.action);
          calls.push(action);
          if (action === "open_shop_inventory") {
            actions = [
              { name: "buy_card", requires_index: false, requires_target: false },
              { name: "close_shop_inventory", requires_index: false, requires_target: false }
            ];
          }
          if (action === "close_shop_inventory") {
            actions = [
              { name: "open_shop_inventory", requires_index: false, requires_target: false },
              { name: "proceed", requires_index: false, requires_target: false }
            ];
          }
          return { screen: "SHOP", run: { floor: 14 }, in_combat: false };
        }
      }),
      canUseActions: () => true,
      decideAction: async ({ run }) =>
        run.stepsUsed === 0
          ? { action: "open_shop_inventory", reason: "先打开商店", confidence: 0.9 }
          : { action: "buy_card", reason: "模型又想买但没给索引", confidence: 0.9 }
    });

    runner.start({ kind: "steps", maxSteps: 3 });

    await vi.waitFor(() => expect(runner.status?.status).toBe("stopped"));
    expect(calls).toEqual(["open_shop_inventory", "close_shop_inventory", "proceed"]);
  });

  it("maps generic index to option_index for option-index actions", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runner = new AutoplayRunner({
      config: testConfig(),
      tools: fakeTools({
        getActions: () => [{ name: "buy_card", requires_index: false, requires_target: false }],
        onAct: (args) => {
          calls.push(args);
          return { screen: "SHOP", run: { floor: 14 }, in_combat: false };
        }
      }),
      canUseActions: () => true,
      decideAction: async () => ({ action: "buy_card", index: 2, reason: "测试购买", confidence: 0.9 })
    });

    runner.start({ kind: "steps", maxSteps: 1 });

    await vi.waitFor(() => expect(runner.status?.status).toBe("stopped"));
    expect(calls).toEqual([{ action: "buy_card", option_index: 2 }]);
  });

  it("rejects start when actions are disabled", () => {
    const runner = new AutoplayRunner({
      config: testConfig(),
      tools: fakeTools({}),
      canUseActions: () => false,
      decideAction: async () => ({ action: "advance", reason: "不会执行", confidence: 0.9 })
    });

    expect(() => runner.start({ kind: "steps", maxSteps: 1 })).toThrow(/disabled/);
  });

  it("parses MCP wrapper structuredContent and text content", () => {
    expect(parseMcpToolOutput(JSON.stringify({ structuredContent: { ok: true } }))).toEqual({ ok: true });
    expect(
      parseMcpToolOutput(
        JSON.stringify({
          content: [{ type: "text", text: "{\"status\":\"ready\"}" }]
        })
      )
    ).toEqual({ status: "ready" });
  });

  it("parses autoplay decision JSON from plain model text", () => {
    expect(
      parseJsonObject(
        '决策如下：{"action":"end_turn","reason":"没有可用攻击牌，结束回合","confidence":0.72}'
      )
    ).toEqual({
      action: "end_turn",
      reason: "没有可用攻击牌，结束回合",
      confidence: 0.72
    });
  });

  it("extracts text from AI message content arrays", () => {
    const message = new AIMessage({
      content: [
        { type: "text", text: "{\"action\":\"advance\"," },
        { type: "text", text: "\"reason\":\"测试\",\"confidence\":0.9}" }
      ]
    });

    expect(getMessageText(message)).toBe("{\"action\":\"advance\",\n\"reason\":\"测试\",\"confidence\":0.9}");
  });

  it("creates start and stop autoplay tools", async () => {
    const start = vi.fn(() => ({
      id: "autoplay_test",
      goal: { kind: "floors" as const, count: 2 },
      status: "running" as const,
      startedAt: Date.now(),
      stepsUsed: 0
    }));
    const stop = vi.fn();
    const tools = createAutoplayTools({ start, stop });

    const startOutput = await tools.find((item) => item.name === "start_autoplay")?.invoke({
      mode: "floors",
      count: 2
    });
    const stopOutput = await tools.find((item) => item.name === "stop_autoplay")?.invoke({
      reason: "测试停止"
    });

    expect(start).toHaveBeenCalledWith({ kind: "floors", count: 2 });
    expect(stop).toHaveBeenCalledWith("测试停止");
    expect(String(startOutput)).toContain("autoplay_test");
    expect(String(stopOutput)).toContain("测试停止");
    expect(toGoal("steps", undefined)).toEqual({ kind: "steps", maxSteps: 10 });
  });
});

function testConfig() {
  const config = loadConfig(["node", "test", "--mock"]);
  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: undefined
    }
  };
}

function fakeTools(options: {
  getState?: () => unknown;
  getActions?: () => Array<Record<string, unknown>>;
  onAct?: (args: Record<string, unknown>) => unknown;
}): StructuredToolInterface[] {
  let state = options.getState?.() || { screen: "MAP", run: { floor: 1 }, in_combat: false };
  const getState = () => options.getState?.() || state;
  const getActions = () =>
    options.getActions?.() || [{ name: "advance", requires_index: false, requires_target: false }];
  return [
    fakeTool("health_check", async () => wrap({ status: "ready" })),
    fakeTool("get_game_state", async () => wrap(getState())),
    fakeTool("get_available_actions", async () =>
      wrap({
        result: getActions()
      })
    ),
    fakeTool("wait_until_actionable", async () =>
      wrap({
        state: getState(),
        actions: getActions()
      })
    ),
    fakeTool("act", async (args) => {
      state = options.onAct?.(args) || state;
      return wrap({ action: args.action, status: "completed", state });
    })
  ];
}

function fakeTool(
  name: string,
  invoke: (args: Record<string, unknown>) => Promise<string>
): StructuredToolInterface {
  return {
    name,
    description: name,
    schema: z.object({}),
    invoke
  } as unknown as StructuredToolInterface;
}

function wrap(structuredContent: unknown): string {
  return JSON.stringify({ structuredContent });
}
