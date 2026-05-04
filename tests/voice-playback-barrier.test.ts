import { describe, expect, it } from "vitest";
import { VoicePlaybackBarrier } from "../src/voice/VoicePlaybackBarrier.js";

describe("VoicePlaybackBarrier", () => {
  it("resolves when a matching reply completes", async () => {
    const barrier = new VoicePlaybackBarrier();
    const waitPromise = barrier.wait("reply_1", 1_000);

    barrier.complete("reply_1");

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it("resolves on timeout when no acknowledgement arrives", async () => {
    const barrier = new VoicePlaybackBarrier();

    await expect(barrier.wait("reply_timeout", 20)).resolves.toBeUndefined();
  });
});
