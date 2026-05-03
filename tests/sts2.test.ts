import { describe, expect, it } from "vitest";
import { normalizeGameState } from "../src/game-sts2/Sts2Client.js";

describe("normalizeGameState", () => {
  it("creates a readable summary from common STS-like state fields", () => {
    const state = normalizeGameState({
      currentHp: 40,
      maxHp: 70,
      floorNum: 6,
      act: 1,
      gold: 123,
      room: "combat",
      deck: [{ name: "打击" }, { name: "防御" }],
      hand: [{ name: "重斩" }, { name: "观察" }],
      enemies: [{ name: "史莱姆", hp: 18, intent: "攻击 5" }]
    });

    expect(state.hp).toBe(40);
    expect(state.maxHp).toBe(70);
    expect(state.inCombat).toBe(true);
    expect(state.deckSize).toBe(2);
    expect(state.summary).toContain("第 6 层");
    expect(state.summary).toContain("生命 40/70");
    expect(state.summary).toContain("史莱姆(18) 攻击 5");
  });
});
