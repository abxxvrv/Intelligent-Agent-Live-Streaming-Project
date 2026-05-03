import type { EventBus } from "../events/EventBus.js";
import type { LiveSource } from "./LiveSource.js";
import { newId } from "../utils/id.js";
import { Logger } from "../utils/logger.js";

type BiliClientLike = {
  on?: (event: string, handler: (payload: unknown) => void) => void;
  addEventListener?: (event: string, handler: (payload: unknown) => void) => void;
  close?: () => void;
  terminate?: () => void;
};

export class BiliLiveSource implements LiveSource {
  private client?: BiliClientLike;
  private readonly logger = new Logger("bili-live");

  constructor(private readonly roomId: number) {}

  async start(bus: EventBus): Promise<void> {
    const mod = await import("bilibili-live-danmaku");
    const client = createClient(mod, this.roomId) as BiliClientLike;
    this.client = client;

    const listen = (event: string, handler: (payload: unknown) => void) => {
      if (client.on) client.on(event, handler);
      else if (client.addEventListener) client.addEventListener(event, handler);
      else throw new Error("bilibili-live-danmaku client does not expose on/addEventListener");
    };

    listen("DANMU_MSG", (payload) => {
      const parsed = parseDanmaku(payload);
      if (!parsed.text) return;
      bus.publish({
        type: "danmaku",
        id: newId("dm"),
        ts: Date.now(),
        user: parsed.user || "观众",
        text: parsed.text,
        raw: payload
      });
    });

    listen("SEND_GIFT", (payload) => {
      const parsed = parseGift(payload);
      bus.publish({
        type: "gift",
        id: newId("gift"),
        ts: Date.now(),
        user: parsed.user || "观众",
        giftName: parsed.giftName || "礼物",
        count: parsed.count || 1,
        raw: payload
      });
    });

    for (const eventName of ["open", "connect", "live", "close", "error"]) {
      try {
        listen(eventName, (payload) => {
          bus.publish({
            type: "live-system",
            id: newId("live"),
            ts: Date.now(),
            message: `B站弹幕事件：${eventName}`,
            raw: payload
          });
        });
      } catch {
        // Some client variants do not expose all lifecycle events.
      }
    }

    this.logger.info(`connected to B站直播间 ${this.roomId}`);
  }

  async stop(): Promise<void> {
    this.client?.close?.();
    this.client?.terminate?.();
  }
}

function createClient(mod: Record<string, unknown>, roomId: number): unknown {
  const Client =
    mod.BLiveClient ||
    mod.KeepLiveWS ||
    mod.LiveDanmaku ||
    mod.default;
  if (typeof Client !== "function") {
    throw new Error("Unsupported bilibili-live-danmaku export shape");
  }
  return new (Client as new (roomId: number) => unknown)(roomId);
}

function parseDanmaku(payload: unknown): { user?: string; text?: string } {
  const data = unwrapData(payload);
  const info = getAt(data, "info");
  const text =
    asString(getAt(data, "text")) ||
    asString(getAt(data, "msg")) ||
    asString(Array.isArray(info) ? info[1] : undefined);
  const user =
    asString(getAt(data, "uname")) ||
    asString(getAt(data, "user")) ||
    asString(Array.isArray(info) && Array.isArray(info[2]) ? info[2][1] : undefined);
  return { user, text };
}

function parseGift(payload: unknown): { user?: string; giftName?: string; count?: number } {
  const data = unwrapData(payload);
  return {
    user: asString(getAt(data, "uname")) || asString(getAt(data, "user")),
    giftName: asString(getAt(data, "giftName")) || asString(getAt(data, "gift_name")),
    count: asNumber(getAt(data, "num")) || asNumber(getAt(data, "count"))
  };
}

function unwrapData(payload: unknown): unknown {
  return getAt(payload, "data") ?? payload;
}

function getAt(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
