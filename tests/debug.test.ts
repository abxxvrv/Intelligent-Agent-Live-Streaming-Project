import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { DebugControl } from "../src/debug/DebugControl.js";
import { EventBus } from "../src/events/EventBus.js";
import { OverlayServer } from "../src/obs-overlay/OverlayServer.js";
import type { RuntimeEvent } from "../src/types.js";

describe("debug control API", () => {
  const servers: OverlayServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers.length = 0;
  });

  it("injects debug danmaku into the event bus", async () => {
    const { baseUrl, bus } = await startDebugServer(31801);
    const events: RuntimeEvent[] = [];
    bus.subscribe((event) => events.push(event));

    const response = await fetch(`${baseUrl}/api/debug/danmaku`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "测试员", text: "塔塔看看现在能做什么" })
    });
    const body = await response.json();

    expect(response.ok).toBe(true);
    expect(body.ok).toBe(true);
    expect(events.some((event) => event.type === "danmaku" && event.text.includes("看看"))).toBe(true);
  });

  it("toggles autoplayEnabled and exposes it through debug state", async () => {
    const { baseUrl, control } = await startDebugServer(31802);

    const response = await fetch(`${baseUrl}/api/debug/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoplayEnabled: true })
    });
    const body = await response.json();
    const state = await fetch(`${baseUrl}/api/debug/state`).then((item) => item.json());

    expect(response.ok).toBe(true);
    expect(body.autoplayEnabled).toBe(true);
    expect(control.isAutoplayEnabled()).toBe(true);
    expect(state.autoplayEnabled).toBe(true);
  });

  it("stores agent trace events in debug state", async () => {
    const { baseUrl, bus } = await startDebugServer(31803);
    bus.publish({
      type: "agent-trace",
      id: "trace_1",
      ts: Date.now(),
      runId: "run_1",
      sourceEventId: "dm_1",
      stage: "llm-start",
      title: "模型处理",
      message: "我开始理解这条消息。"
    });

    const state = await fetch(`${baseUrl}/api/debug/state`).then((item) => item.json());

    expect(state.events.some((event: RuntimeEvent) => event.type === "agent-trace" && event.runId === "run_1")).toBe(
      true
    );
  });

  async function startDebugServer(port: number) {
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = {
      ...loadConfig(["node", "test", "--mock"]),
      host: "127.0.0.1",
      port,
      publicBaseUrl: baseUrl
    };
    const bus = new EventBus();
    const control = new DebugControl();
    const server = new OverlayServer(config, bus, resolve(process.cwd(), "public"), control);
    servers.push(server);
    await server.start();
    return { baseUrl, bus, control };
  }
});
