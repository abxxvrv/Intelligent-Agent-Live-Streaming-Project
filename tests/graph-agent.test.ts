import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildAgentMessages, createAgentGraph } from "../src/agent-core/graph/createAgentGraph.js";
import type { AgentGraphState } from "../src/agent-core/graph/AgentState.js";
import { createAgentTools } from "../src/agent-core/graph/tools.js";

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
      expect.arrayContaining(["你好", "你好呀，我在。", "主播这张牌要不要拿？"])
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
    runId: "run_test",
    persona: config.agent.persona,
    trigger,
    gameSummary: "第 1 幕，第 3 层，生命 60/70",
    recentDanmaku: ["小路: 主播这张牌要不要拿？"],
    recentReplies: [],
    conversationHistory: [],
    shouldRespond: false,
    messages: [],
    toolResults: [],
    toolLoopCount: 0,
    memoryNotes: [],
    decision: undefined
  };
}
