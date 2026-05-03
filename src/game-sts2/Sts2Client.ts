import type { GameState } from "../types.js";
import { Logger } from "../utils/logger.js";

const STATE_PATHS = ["/state", "/game-state", "/api/state", "/api/game-state"];

export interface GameClient {
  getState(): Promise<GameState>;
}

export class Sts2Client implements GameClient {
  private readonly logger = new Logger("sts2");

  constructor(private readonly baseUrl: string) {}

  async getState(): Promise<GameState> {
    const errors: string[] = [];
    for (const path of STATE_PATHS) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(2_500)
        });
        if (!response.ok) {
          errors.push(`${path}: HTTP ${response.status}`);
          continue;
        }
        const raw = await response.json();
        return normalizeGameState(raw);
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.logger.warn("unable to read STS2 state", errors);
    throw new Error(`Unable to read STS2 state from ${this.baseUrl}`);
  }
}

export class MockSts2Client implements GameClient {
  private tick = 0;

  async getState(): Promise<GameState> {
    this.tick += 1;
    const inCombat = this.tick % 3 !== 0;
    return normalizeGameState({
      hp: 62 - (this.tick % 5),
      maxHp: 72,
      floor: 3 + this.tick,
      act: 1,
      gold: 99 + this.tick,
      room: inCombat ? "combat" : "event",
      inCombat,
      deckSize: 12,
      relics: ["燃烧之血", "小宝箱"],
      hand: inCombat ? ["打击", "防御", "重斩", "观察"] : [],
      enemies: inCombat ? [{ name: "邪教徒", hp: 34, intent: "攻击 6" }] : []
    });
  }
}

export function normalizeGameState(raw: unknown): GameState {
  const obj = asRecord(raw);
  const stateSource = isRecord(obj.state) ? asRecord(obj.state) : obj;
  const hp = numberField(stateSource, "hp", "currentHp", "current_hp", "playerHp");
  const maxHp = numberField(stateSource, "maxHp", "max_hp", "playerMaxHp");
  const floor = numberField(stateSource, "floor", "floorNum", "floor_num");
  const act = numberField(stateSource, "act", "actNum", "act_num");
  const gold = numberField(stateSource, "gold", "money");
  const room = stringField(stateSource, "room", "roomType", "room_type");
  const inCombat =
    booleanField(stateSource, "inCombat", "in_combat") ??
    room?.toLowerCase().includes("combat") ??
    false;
  const deckSize =
    numberField(stateSource, "deckSize", "deck_size") ??
    arrayField(stateSource, "deck", "cards", "masterDeck")?.length;
  const relics = stringArrayField(stateSource, "relics");
  const hand = stringArrayField(stateSource, "hand");
  const enemies = enemyArrayField(stateSource);

  return {
    hp,
    maxHp,
    floor,
    act,
    gold,
    room,
    inCombat,
    deckSize,
    relics,
    hand,
    enemies,
    raw,
    summary: summarize({ hp, maxHp, floor, act, gold, room, inCombat, deckSize, relics, hand, enemies })
  };
}

function summarize(state: Omit<GameState, "raw" | "summary">): string {
  const parts = [
    state.act ? `第 ${state.act} 幕` : undefined,
    state.floor ? `第 ${state.floor} 层` : undefined,
    state.hp !== undefined && state.maxHp !== undefined ? `生命 ${state.hp}/${state.maxHp}` : undefined,
    state.gold !== undefined ? `金币 ${state.gold}` : undefined,
    state.room ? `房间 ${state.room}` : undefined,
    state.inCombat ? "战斗中" : "非战斗",
    state.deckSize !== undefined ? `牌组 ${state.deckSize} 张` : undefined,
    state.hand?.length ? `手牌：${state.hand.slice(0, 5).join("、")}` : undefined,
    state.enemies?.length
      ? `敌人：${state.enemies
          .slice(0, 3)
          .map((enemy) => `${enemy.name}${enemy.hp !== undefined ? `(${enemy.hp})` : ""}${enemy.intent ? ` ${enemy.intent}` : ""}`)
          .join("；")}`
      : undefined
  ].filter(Boolean);
  return parts.join("，") || "暂时没有可用游戏状态";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberField(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function booleanField(obj: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function arrayField(obj: Record<string, unknown>, ...keys: string[]): unknown[] | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function stringArrayField(obj: Record<string, unknown>, key: string): string[] | undefined {
  const value = obj[key];
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      return stringField(record, "name", "id", "cardId");
    })
    .filter((item): item is string => Boolean(item));
}

function enemyArrayField(obj: Record<string, unknown>): Array<{ name: string; hp?: number; intent?: string }> | undefined {
  const value = arrayField(obj, "enemies", "monsters");
  if (!value) return undefined;
  return value.map((item) => {
    const record = asRecord(item);
    return {
      name: stringField(record, "name", "id") || "敌人",
      hp: numberField(record, "hp", "currentHp", "current_hp"),
      intent: stringField(record, "intent", "move", "nextMove")
    };
  });
}
