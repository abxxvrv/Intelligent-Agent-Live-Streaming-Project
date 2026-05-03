import type { EventBus } from "../events/EventBus.js";
import type { GameClient } from "./Sts2Client.js";
import { newId } from "../utils/id.js";
import { Logger } from "../utils/logger.js";

export class GamePoller {
  private timer?: NodeJS.Timeout;
  private lastSummary = "";
  private readonly logger = new Logger("game-poller");

  constructor(
    private readonly client: GameClient,
    private readonly intervalMs = 15_000
  ) {}

  start(bus: EventBus): void {
    const poll = async () => {
      try {
        const state = await this.client.getState();
        if (state.summary !== this.lastSummary) {
          this.lastSummary = state.summary;
          bus.publish({
            type: "game-state",
            id: newId("game"),
            ts: Date.now(),
            state
          });
        }
      } catch (error) {
        this.logger.warn(error instanceof Error ? error.message : String(error));
      }
    };
    void poll();
    this.timer = setInterval(poll, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
