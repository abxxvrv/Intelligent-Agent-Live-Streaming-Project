import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { DebugControl } from "../src/debug/DebugControl.js";
import { EventBus } from "../src/events/EventBus.js";
import { OverlayServer } from "../src/obs-overlay/OverlayServer.js";
import type { RuntimeEvent } from "../src/types.js";
import type { TtsStreamProvider } from "../src/voice/TtsEngine.js";

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

  it("injects debug gifts into the event bus", async () => {
    const { baseUrl, bus } = await startDebugServer(31805);
    const events: RuntimeEvent[] = [];
    bus.subscribe((event) => events.push(event));

    const response = await fetch(`${baseUrl}/api/debug/gift`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "测试员", giftName: "小花花", count: 3 })
    });
    const body = await response.json();

    expect(response.ok).toBe(true);
    expect(body.ok).toBe(true);
    expect(events.some((event) => event.type === "gift" && event.giftName === "小花花" && event.count === 3)).toBe(
      true
    );
  });

  it("toggles game mode and exposes it through debug state", async () => {
    const { baseUrl, control } = await startDebugServer(31802);

    const response = await fetch(`${baseUrl}/api/debug/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "game" })
    });
    const body = await response.json();
    const state = await fetch(`${baseUrl}/api/debug/state`).then((item) => item.json());

    expect(response.ok).toBe(true);
    expect(body.mode).toBe("game");
    expect(control.getMode()).toBe("game");
    expect(state.mode).toBe("game");
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

  it("serves browser TTS streams from a stream provider", async () => {
    const provider: TtsStreamProvider = {
      async pipeStream(_id, response) {
        response.writeHead(200, { "content-type": "audio/wav" });
        response.end(Buffer.from("RIFF"));
      }
    };
    const { baseUrl } = await startDebugServer(31804, provider);

    const response = await fetch(`${baseUrl}/api/tts/stream/job_1`);
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("audio/wav");
    expect(body.toString("utf8")).toBe("RIFF");
  });

  async function startDebugServer(port: number, ttsStreamProvider?: TtsStreamProvider) {
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = {
      ...loadConfig(["node", "test", "--mock"]),
      host: "127.0.0.1",
      port,
      publicBaseUrl: baseUrl
    };
    const bus = new EventBus();
    const control = new DebugControl();
    const server = new OverlayServer(config, bus, resolve(process.cwd(), "public"), control, ttsStreamProvider);
    servers.push(server);
    await server.start();
    return { baseUrl, bus, control };
  }
});
