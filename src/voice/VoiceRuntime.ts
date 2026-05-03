import type { EventBus } from "../events/EventBus.js";
import type { AvatarCommand } from "../types.js";
import { newId } from "../utils/id.js";
import { Logger } from "../utils/logger.js";
import type { TtsEngine } from "./TtsEngine.js";

export class VoiceRuntime {
  private readonly logger = new Logger("voice");
  private queue = Promise.resolve();

  constructor(private readonly tts: TtsEngine) {}

  start(bus: EventBus): void {
    bus.on("agent-reply", (event) => {
      this.queue = this.queue.then(() => this.speak(bus, event.decision.say, {
        emotion: event.decision.emotion,
        action: event.decision.avatarAction,
        speaking: true,
        text: event.decision.say
      }));
    });
  }

  private async speak(bus: EventBus, text: string, command: AvatarCommand): Promise<void> {
    bus.publish({
      type: "avatar",
      id: newId("avatar"),
      ts: Date.now(),
      command
    });
    bus.publish({
      type: "voice",
      id: newId("voice"),
      ts: Date.now(),
      status: "start",
      text
    });

    try {
      await this.tts.speak(text);
      bus.publish({
        type: "voice",
        id: newId("voice"),
        ts: Date.now(),
        status: "end",
        text
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("TTS failed", message);
      bus.publish({
        type: "voice",
        id: newId("voice"),
        ts: Date.now(),
        status: "error",
        text,
        error: message
      });
    } finally {
      bus.publish({
        type: "avatar",
        id: newId("avatar"),
        ts: Date.now(),
        command: {
          emotion: "neutral",
          action: "idle",
          speaking: false
        }
      });
    }
  }
}
