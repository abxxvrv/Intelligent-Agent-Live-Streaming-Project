import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { DebugControl } from "../src/debug/DebugControl.js";
import { EventBus } from "../src/events/EventBus.js";
import { GraphAgentRuntime } from "../src/agent-core/GraphAgentRuntime.js";
import type { AgentReplyEvent } from "../src/types.js";
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

  it("ignores non-debug danmaku and gifts as agent input", async () => {
    const bus = new EventBus();
    const agent = new GraphAgentRuntime(testConfig(), new DebugControl());
    const replies: AgentReplyEvent[] = [];
    bus.on("agent-reply", (event) => replies.push(event));

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

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(replies).toHaveLength(0);
    await agent.stop();
  });

  it("does not expose direct act to the chat graph", () => {
    const agent = new GraphAgentRuntime(testConfig(), new DebugControl());
    const runtime = agent as unknown as {
      mcpExtraTools: StructuredToolInterface[];
      autoplayExtraTools: StructuredToolInterface[];
      getActiveMcpTools: () => StructuredToolInterface[];
    };
    runtime.mcpExtraTools = [fakeTool("get_game_state"), fakeTool("act")];
    runtime.autoplayExtraTools = [fakeTool("start_autoplay")];

    expect(runtime.getActiveMcpTools().map((item) => item.name)).toEqual(["get_game_state", "start_autoplay"]);
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
