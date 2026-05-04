import { describe, expect, it } from "vitest";
import { normalizeDecision } from "../src/agent-core/LLMClient.js";

describe("normalizeDecision", () => {
  it("keeps valid structured agent output", () => {
    expect(
      normalizeDecision({
        say: "ここは少し安全にいくね。",
        subtitleZh: "这波先稳一下。",
        emotion: "thinking",
        avatarAction: "think",
        shouldSpeak: true,
        gameIntent: "consider_card"
      })
    ).toEqual({
      say: "ここは少し安全にいくね。",
      subtitleJa: "ここは少し安全にいくね。",
      subtitleZh: "这波先稳一下。",
      emotion: "thinking",
      avatarAction: "think",
      shouldSpeak: true,
      gameIntent: "consider_card"
    });
  });

  it("falls back on invalid enum values and suppresses empty speech", () => {
    expect(
      normalizeDecision({
        say: "",
        emotion: "excited",
        avatarAction: "dance",
        shouldSpeak: true,
        gameIntent: "hack"
      })
    ).toEqual({
      say: "",
      subtitleJa: "",
      subtitleZh: "",
      emotion: "neutral",
      avatarAction: "idle",
      shouldSpeak: false,
      gameIntent: "none"
    });
  });
});
