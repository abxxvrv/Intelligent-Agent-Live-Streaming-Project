import type { EventBus } from "../events/EventBus.js";

export interface LiveSource {
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
}
