import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { BiliLiveSource } from "../src/bili-live/BiliLiveSource.js";
import { DisabledLiveSource } from "../src/bili-live/DisabledLiveSource.js";
import { SimulatedLiveSource } from "../src/bili-live/SimulatedLiveSource.js";
import { createLiveSource } from "../src/bili-live/createLiveSource.js";
import { createGameClient } from "../src/game-sts2/createGameClient.js";
import { MockSts2Client, Sts2Client } from "../src/game-sts2/Sts2Client.js";

describe("source selection", () => {
  it("does not fall back to simulated danmaku when Bili is disabled and room id is missing", () => {
    const source = createLiveSource(config({ mockBili: false, biliRoomId: undefined }));

    expect(source).toBeInstanceOf(DisabledLiveSource);
  });

  it("uses simulated danmaku only when mockBili is enabled", () => {
    const source = createLiveSource(config({ mockBili: true, biliRoomId: undefined }));

    expect(source).toBeInstanceOf(SimulatedLiveSource);
  });

  it("uses real Bili source when room id is configured", () => {
    const source = createLiveSource(config({ mockBili: false, biliRoomId: 123 }));

    expect(source).toBeInstanceOf(BiliLiveSource);
  });

  it("uses real STS2 client unless mockSts2 is enabled", () => {
    expect(createGameClient(config({ mockSts2: false }))).toBeInstanceOf(Sts2Client);
    expect(createGameClient(config({ mockSts2: true }))).toBeInstanceOf(MockSts2Client);
  });
});

function config(overrides: Partial<AppConfig>): AppConfig {
  return {
    ...loadConfig(["node", "test"]),
    ...overrides
  };
}
