import { describe, expect, it } from "vitest";
import { mapEmotionToFolder } from "../src/voice/TtsEngine.js";

describe("GPT-SoVITS emotion mapping", () => {
  it("maps known Chinese and English emotions to reference folders", () => {
    expect(mapEmotionToFolder("责备")).toBe("责备");
    expect(mapEmotionToFolder("happy")).toBe("欣慰");
    expect(mapEmotionToFolder("battle")).toBe("战斗");
    expect(mapEmotionToFolder("neutral")).toBe("慵懒");
  });

  it("falls back to the configured default emotion", () => {
    expect(mapEmotionToFolder("unknown", "自嘲")).toBe("自嘲");
    expect(mapEmotionToFolder(undefined, "慵懒")).toBe("慵懒");
  });
});
