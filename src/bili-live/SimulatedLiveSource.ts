import type { EventBus } from "../events/EventBus.js";
import type { LiveSource } from "./LiveSource.js";
import { newId } from "../utils/id.js";
import { Logger } from "../utils/logger.js";

const SAMPLES = [
  { user: "小路", text: "主播这把走毒还是走刀啊？" },
  { user: "纸杯", text: "塔塔看一下怪的意图！" },
  { user: "阿眠", text: "感觉这张牌可以先不拿" },
  { user: "星野", text: "今天声音状态不错" },
  { user: "路过的观众", text: "这游戏新作节奏怎么样？" }
];

export class SimulatedLiveSource implements LiveSource {
  private timer?: NodeJS.Timeout;
  private index = 0;
  private readonly logger = new Logger("sim-bili");

  async start(bus: EventBus): Promise<void> {
    this.logger.info("using simulated B站弹幕源");
    bus.publish({
      type: "live-system",
      id: newId("live"),
      ts: Date.now(),
      message: "模拟弹幕已启动"
    });

    this.timer = setInterval(() => {
      const item = SAMPLES[this.index % SAMPLES.length];
      this.index += 1;
      bus.publish({
        type: "danmaku",
        id: newId("dm"),
        ts: Date.now(),
        user: item.user,
        text: item.text
      });
    }, 12_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }
}
