import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { DebugControl } from "../src/debug/DebugControl.js";
import { EventBus } from "../src/events/EventBus.js";
import { GraphAgentRuntime } from "../src/agent-core/GraphAgentRuntime.js";
import type { AgentReplyEvent, AgentTraceEvent, InputEvent } from "../src/types.js";
import type { StructuredToolInterface } from "@langchain/core/tools";

describe("GraphAgentRuntime debug input filtering", () => {
  it("responds to debug danmaku", async () => {
    const bus = new EventBus();
    const agent = new GraphAgentRuntime(testConfig(), new DebugControl());
    const replies: AgentReplyEvent[] = [];
    bus.on("agent-reply", (event) => replies.push(event));

    agent.start(bus);
    bus.publish({
      type: "danmaku",
      id: "debug_dm_1",
      ts: Date.now(),
      user: "调试员",
      text: "你好，先正常聊两句",
      raw: { source: "debug" }
    });

    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await agent.stop();
  });

  it("responds to debug gifts", async () => {
    const bus = new EventBus();
    const agent = new GraphAgentRuntime(testConfig(), new DebugControl());
    const replies: AgentReplyEvent[] = [];
    bus.on("agent-reply", (event) => replies.push(event));

    agent.start(bus);
    bus.publish({
      type: "gift",
      id: "debug_gift_1",
      ts: Date.now(),
      user: "调试员",
      giftName: "小花花",
      count: 2,
      raw: { source: "debug" }
    });

    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await agent.stop();
  });

  it("enqueues non-debug danmaku and gifts in chat mode", async () => {
    const bus = new EventBus();
    const agent = new GraphAgentRuntime(testConfig(), new DebugControl());
    const replies: AgentReplyEvent[] = [];
    const queueTraces: AgentTraceEvent[] = [];
    bus.on("agent-reply", (event) => replies.push(event));
    bus.on("agent-trace", (event) => {
      if (event.stage === "queue") queueTraces.push(event);
    });

    agent.start(bus);
    bus.publish({
      type: "danmaku",
      id: "dm_1",
      ts: Date.now(),
      user: "观众",
      text: "主播能看到这句吗？"
    });
    bus.publish({
      type: "gift",
      id: "gift_1",
      ts: Date.now(),
      user: "观众",
      giftName: "小花花",
      count: 1
    });

    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(queueTraces.map((event) => event.sourceEventId)).toEqual(["dm_1", "gift_1"]);
    await agent.stop();
  });

  it("only enters game mode from chat on exact /game into command", async () => {
    const bus = new EventBus();
    const agent = new GraphAgentRuntime(testConfig(), new DebugControl());
    const runtime = agent as unknown as { runtimeMode: string };
    const endedRuns: string[] = [];
    const queuedGameTicks: AgentTraceEvent[] = [];
    bus.on("agent-trace", (event) => {
      if (event.stage === "run-end" && event.sourceEventId) endedRuns.push(event.sourceEventId);
      if (event.stage === "queue" && event.detail && (event.detail as { eventType?: string }).eventType === "game-tick") {
        queuedGameTicks.push(event);
      }
    });

    agent.start(bus);
    bus.publish({
      type: "danmaku",
      id: "dm_old_game",
      ts: Date.now(),
      user: "观众",
      text: "/game"
    });

    await vi.waitFor(() => expect(endedRuns).toContain("dm_old_game"));
    expect(runtime.runtimeMode).toBe("chat");

    bus.publish({
      type: "danmaku",
      id: "dm_game_into",
      ts: Date.now(),
      user: "观众",
      text: "/game into"
    });

    await vi.waitFor(() => expect(runtime.runtimeMode).toBe("game"));
    await vi.waitFor(() => expect(queuedGameTicks.length).toBeGreaterThan(0));
    expect((queuedGameTicks[0].detail as { reason?: string }).reason).toBe("after-action");
    await agent.stop();
  });

  it("coalesces pending game ticks without blocking other event types", () => {
    const bus = new EventBus();
    const agent = new GraphAgentRuntime(testConfig(), new DebugControl());
    const runtime = agent as unknown as {
      processingQueue: boolean;
      eventQueue: InputEvent[];
      enqueueInput: (bus: EventBus, event: InputEvent) => void;
      enqueueGameStep: (bus: EventBus, reason?: "manual" | "after-action" | "timer") => void;
    };

    runtime.processingQueue = true;
    runtime.enqueueGameStep(bus, "after-action");
    runtime.enqueueGameStep(bus, "after-action");
    runtime.enqueueInput(bus, {
      type: "game-tick",
      id: "manual_tick",
      ts: Date.now(),
      reason: "manual"
    });
    runtime.enqueueInput(bus, {
      type: "danmaku",
      id: "dm_after_tick",
      ts: Date.now(),
      user: "观众",
      text: "这个不应该被 tick 合并挡住"
    });

    expect(runtime.eventQueue.filter((event) => event.type === "game-tick")).toHaveLength(1);
    expect(runtime.eventQueue.map((event) => event.id)).toEqual(
      expect.arrayContaining(["dm_after_tick"])
    );
  });

  it("only schedules next game step for a running unfinished game result", () => {
    const agent = new GraphAgentRuntime(testConfig(), new DebugControl());
    const runtime = agent as unknown as {
      runtimeMode: string;
      gameSession: { status: "idle" | "running" | "ended"; tickCount: number; actionCount: number };
      shouldScheduleNextGameStep: (state: { mode?: string; gameOver?: boolean; gameSession?: { status: string } }) => boolean;
    };

    runtime.runtimeMode = "game";
    runtime.gameSession = { status: "running", tickCount: 1, actionCount: 0 };

    expect(
      runtime.shouldScheduleNextGameStep({
        mode: "game",
        gameOver: false,
        gameSession: { status: "running" }
      })
    ).toBe(true);
    expect(
      runtime.shouldScheduleNextGameStep({
        mode: "chat",
        gameOver: false,
        gameSession: { status: "idle" }
      })
    ).toBe(false);
    expect(
      runtime.shouldScheduleNextGameStep({
        mode: "game",
        gameOver: true,
        gameSession: { status: "running" }
      })
    ).toBe(false);
    expect(
      runtime.shouldScheduleNextGameStep({
        mode: "game",
        gameOver: false,
        gameSession: { status: "ended" }
      })
    ).toBe(false);
  });

  it("stores ordinary live input without enqueueing it in game mode", async () => {
    const bus = new EventBus();
    const agent = new GraphAgentRuntime(testConfig(), new DebugControl());
    const runtime = agent as unknown as {
      runtimeMode: string;
      createInitialState: (events: InputEvent[]) => { audienceContext: { recentMessages: unknown[]; giftEvents: unknown[] } };
      getRecentLiveInputs: (input: { windowMs: number; includeGifts: boolean }) => { messages: unknown[]; gifts: unknown[] };
    };
    const queueTraces: AgentTraceEvent[] = [];
    bus.on("agent-trace", (event) => {
      if (event.stage === "queue") queueTraces.push(event);
    });

    agent.start(bus);
    runtime.runtimeMode = "game";
    bus.publish({
      type: "danmaku",
      id: "dm_game_chat",
      ts: Date.now(),
      user: "观众",
      text: "这张牌可以打"
    });
    bus.publish({
      type: "gift",
      id: "gift_game",
      ts: Date.now(),
      user: "观众",
      giftName: "小花花",
      count: 3
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queueTraces).toHaveLength(0);

    const state = runtime.createInitialState([
      {
        type: "game-tick",
        id: "tick_test",
        ts: Date.now(),
        reason: "manual"
      }
    ]);
    const recent = runtime.getRecentLiveInputs({ windowMs: 60_000, includeGifts: true });

    expect(state.audienceContext.recentMessages).toEqual(
      expect.arrayContaining([expect.objectContaining({ user: "观众", text: "这张牌可以打" })])
    );
    expect(state.audienceContext.giftEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ user: "观众", giftName: "小花花", count: 3 })])
    );
    expect(recent.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ user: "观众", text: "这张牌可以打" })])
    );
    expect(recent.gifts).toEqual(
      expect.arrayContaining([expect.objectContaining({ user: "观众", giftName: "小花花", count: 3 })])
    );
    await agent.stop();
  });

  it("allows /chat and /stop danmaku to leave game mode", async () => {
    const bus = new EventBus();
    const agent = new GraphAgentRuntime(testConfig(), new DebugControl());
    const runtime = agent as unknown as { runtimeMode: string };

    agent.start(bus);
    runtime.runtimeMode = "game";
    bus.publish({
      type: "danmaku",
      id: "dm_chat",
      ts: Date.now(),
      user: "观众",
      text: "/chat"
    });

    await vi.waitFor(() => expect(runtime.runtimeMode).toBe("chat"));

    runtime.runtimeMode = "game";
    bus.publish({
      type: "danmaku",
      id: "dm_stop",
      ts: Date.now(),
      user: "观众",
      text: "/stop"
    });

    await vi.waitFor(() => expect(runtime.runtimeMode).toBe("chat"));
    await agent.stop();
  });

  it("keeps chat and game tools separated without autoplay tools on the main path", () => {
    const agent = new GraphAgentRuntime(testConfig(), new DebugControl());
    const runtime = agent as unknown as {
      mcpExtraTools: StructuredToolInterface[];
      autoplayExtraTools: StructuredToolInterface[];
      getChatTools: () => StructuredToolInterface[];
      getGameTools: () => StructuredToolInterface[];
    };
    runtime.mcpExtraTools = [fakeTool("get_game_state"), fakeTool("act")];
    runtime.autoplayExtraTools = [fakeTool("start_autoplay")];

    expect(runtime.getChatTools().map((item) => item.name)).toEqual(["express"]);
    expect(runtime.getGameTools().map((item) => item.name)).toEqual([
      "express",
      "get_recent_chat_messages",
      "get_game_state",
      "act"
    ]);
  });
});

function testConfig() {
  const config = loadConfig(["node", "test", "--mock"]);
  return {
    ...config,
    sts2Mcp: {
      ...config.sts2Mcp,
      enabled: false
    },
    llm: {
      ...config.llm,
      apiKey: undefined
    }
  };
}

function fakeTool(name: string): StructuredToolInterface {
  return {
    name,
    description: name,
    invoke: async () => "{}"
  } as unknown as StructuredToolInterface;
}
