import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { GraphAgentRuntime } from "../src/agent-core/GraphAgentRuntime.js";
import { EventBus } from "../src/events/EventBus.js";
import type { AgentReplyEvent } from "../src/types.js";

describe("chat response routing", () => {
  it("responds to plain debug chat without mention, question mark, or game keyword", async () => {
    const config = loadConfig(["node", "test", "--mock"]);
    const agent = new GraphAgentRuntime({
      ...config,
      sts2Mcp: {
        ...config.sts2Mcp,
        enabled: false
      },
      llm: {
        ...config.llm,
        apiKey: undefined
      }
    });
    const bus = new EventBus();
    const replyPromise = waitForReply(bus);

    agent.start(bus);
    bus.publish({
      type: "danmaku",
      id: "dm_plain",
      ts: Date.now(),
      user: "调试员",
      text: "用之前的存档",
      raw: { source: "debug" }
    });

    const reply = await replyPromise;
    await agent.stop();

    expect(reply.decision.shouldSpeak).toBe(true);
    expect(reply.decision.say.length).toBeGreaterThan(0);
  });
});

function waitForReply(bus: EventBus): Promise<AgentReplyEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for agent reply")), 2_000);
    const unsubscribe = bus.on("agent-reply", (event) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}
