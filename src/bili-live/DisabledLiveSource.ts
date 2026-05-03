import type { EventBus } from "../events/EventBus.js";
import { newId } from "../utils/id.js";
import { Logger } from "../utils/logger.js";
import type { LiveSource } from "./LiveSource.js";

export class DisabledLiveSource implements LiveSource {
  private readonly logger = new Logger("bili-live");

  async start(bus: EventBus): Promise<void> {
    this.logger.info("B站弹幕源未启用");
    bus.publish({
      type: "live-system",
      id: newId("live"),
      ts: Date.now(),
      message: "B站弹幕源未启用，请在 /debug 手动发送测试消息"
    });
  }

  async stop(): Promise<void> {}
}
