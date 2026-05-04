import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildAgentMessages, createAgentGraph } from "../src/agent-core/graph/createAgentGraph.js";
import type { AgentGraphState } from "../src/agent-core/graph/AgentState.js";
import { createAgentTools } from "../src/agent-core/graph/tools.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

describe("LangGraph agent core", () => {
  it("produces a valid fallback decision for plain chat without an API key", async () => {
    const config = testConfig();
    const traces: string[] = [];
    const graph = createAgentGraph({
      config,
      shouldRespond: () => true,
      toolContext: {
        getGameSummary: () => "第 1 幕，第 3 层，生命 60/70",
        rememberNote: vi.fn()
      },
      onTrace: (event) => traces.push(event.stage)
    });

    const result = await graph.invoke(baseState(config, "观众 小路 说：用之前的存档"));

    expect(result.shouldRespond).toBe(true);
    expect(result.decision?.shouldSpeak).toBe(true);
    expect(result.decision?.say.length).toBeGreaterThan(0);
    expect(traces).toEqual(expect.arrayContaining(["llm-start", "llm-message", "final"]));
  });

  it("produces a valid fallback decision without an API key", async () => {
    const config = testConfig();
    const graph = createAgentGraph({
      config,
      shouldRespond: () => true,
      toolContext: {
        getGameSummary: () => "第 1 幕，第 3 层，生命 60/70",
        rememberNote: vi.fn()
      }
    });

    const result = await graph.invoke(baseState(config, "观众 小路 说：主播这张牌要不要拿？"));

    expect(result.shouldRespond).toBe(true);
    expect(result.decision?.shouldSpeak).toBe(true);
    expect(result.decision?.say.length).toBeGreaterThan(0);
    expect(result.decision?.avatarAction).toBeDefined();
  });

  it("keeps game action tool as no-op", async () => {
    const tools = createAgentTools({
      getGameSummary: () => "第 1 幕，第 3 层，生命 60/70",
      rememberNote: vi.fn()
    });
    const gameAction = tools.find((item) => item.name === "no_op_game_action");

    const result = await gameAction?.invoke({
      requestedAction: "play_card Strike",
      reason: "测试模型请求出牌"
    });

    expect(String(result)).toContain('"executed":false');
    expect(String(result)).toContain("play_card Strike");
  });

  it("formats expression tool output as an agent decision", async () => {
    const tools = createAgentTools({
      getGameSummary: () => "第 1 幕，第 3 层，生命 60/70",
      rememberNote: vi.fn()
    });
    const express = tools.find((item) => item.name === "express");

    const result = await express?.invoke({
      textJa: "ここは少し安全にいくね。",
      textZh: "我来稳一点打。",
      emotion: "focus"
    });

    expect(String(result)).toContain('"expressed":true');
    expect(String(result)).toContain('"say":"ここは少し安全にいくね。"');
    expect(String(result)).toContain('"subtitleZh":"我来稳一点打。"');
    expect(String(result)).toContain('"avatarAction":"talk"');
  });

  it("preloads MCP available actions from structuredContent.result", async () => {
    const config = testConfig();
    const traces: string[] = [];
    const actions = [{ name: "end_turn", requires_index: false, requires_target: false }];
    const graph = createAgentGraph({
      config,
      shouldRespond: () => true,
      toolContext: {
        getGameSummary: () => "第 1 幕，第 3 层，生命 60/70",
        rememberNote: vi.fn()
      },
      gameTools: [
        fakeMcpTool("health_check", { status: "ready" }),
        fakeMcpTool("get_game_state", { screen: "COMBAT", in_combat: true }),
        fakeMcpTool("get_available_actions", { result: actions })
      ],
      onTrace: (event) => {
        if (event.stage === "preload_game_snapshot") traces.push(event.message);
      }
    });

    const result = await graph.invoke({
      ...baseState(config, "game tick"),
      mode: "game",
      route: "game"
    });

    expect(result.availableActions).toEqual(actions);
    expect(traces).toContain("读取到 1 个可用动作。");
  });

  it("builds model messages with system prompt, history, and current debug input", () => {
    const config = testConfig();
    const messages = buildAgentMessages(config, {
      ...baseState(config, "观众 小路 说：刚才那句话是什么意思？"),
      conversationHistory: [
        {
          user: "你好",
          assistant: "你好呀，我在。"
        }
      ]
    });

    expect(String(messages[0].content)).toContain("已有对话历史");
    expect(messages.map((message) => message.content)).toEqual(
      expect.arrayContaining(["你好", "你好呀，我在。", "[弹幕] 小路: 主播这张牌要不要拿？"])
    );
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

function baseState(config: ReturnType<typeof testConfig>, trigger: string): AgentGraphState {
    return {
    inputEvent: {
      type: "danmaku",
      id: "dm_1",
      ts: Date.now(),
      user: "小路",
      text: "主播这张牌要不要拿？"
    },
    inputEvents: [
      {
        type: "danmaku",
        id: "dm_1",
        ts: Date.now(),
        user: "小路",
        text: "主播这张牌要不要拿？"
      }
    ],
    runId: "run_test",
    persona: config.agent.persona,
    trigger,
    gameSummary: "第 1 幕，第 3 层，生命 60/70",
    mode: "chat",
    route: "chat",
    shouldStartGame: false,
    gameState: undefined,
    availableActions: [],
    observedAt: undefined,
    gameOver: false,
    gameSession: {
      status: "idle",
      tickCount: 0,
      actionCount: 0
    },
    audienceContext: {
      currentEvents: [
        {
          type: "danmaku",
          id: "dm_1",
          ts: Date.now(),
          user: "小路",
          text: "主播这张牌要不要拿？"
        }
      ],
      recentMessages: [],
      giftEvents: [],
      adminCommands: []
    },
    lastToolCategory: undefined,
    gameActionExecuted: false,
    lastToolError: undefined,
    recentDanmaku: ["小路: 主播这张牌要不要拿？"],
    recentReplies: [],
    conversationHistory: [],
    shouldRespond: false,
    messages: [],
    deepseekMessages: [],
    toolResults: [],
    toolLoopCount: 0,
    expressedDecision: undefined,
    memoryNotes: [],
    decision: undefined
  };
}

function fakeMcpTool(name: string, structuredContent: unknown): StructuredToolInterface {
  return {
    name,
    description: name,
    schema: z.object({}),
    invoke: async () => JSON.stringify({ structuredContent })
  } as unknown as StructuredToolInterface;
}
