import type { EventBus } from "../events/EventBus.js";
import type { AvatarCommand } from "../types.js";
import { newId } from "../utils/id.js";
import { Logger } from "../utils/logger.js";
import { isStreamingTtsEngine, type StreamingTtsEngine, type TtsEngine } from "./TtsEngine.js";

export class VoiceRuntime {
  private readonly logger = new Logger("voice");
  private queue = Promise.resolve();

  constructor(private readonly tts: TtsEngine) {}

  start(bus: EventBus): void {
    bus.on("agent-reply", (event) => {
      const text = event.decision.say?.trim();

      if (!event.decision.shouldSpeak || !text) {
        return;
      }

      this.queue = this.queue
        .then(() =>
          this.speak(bus, text, {
            emotion: event.decision.emotion,
            action: event.decision.avatarAction,
            speaking: true,
            text,
            subtitleJa: event.decision.subtitleJa || text,
            subtitleZh: event.decision.subtitleZh || ""
          })
        )
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn("Voice queue failed", message);
        });
    });
  }

  private async speak(bus: EventBus, text: string, command: AvatarCommand): Promise<void> {
    if (isStreamingTtsEngine(this.tts)) {
      await this.speakWithBrowserStream(this.tts, bus, text, command);
      return;
    }

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
      text,
      subtitleJa: command.subtitleJa,
      subtitleZh: command.subtitleZh
    });

    try {
      await this.tts.speak(text, {
        emotion: command.emotion,
        action: command.action
      });
      bus.publish({
        type: "voice",
        id: newId("voice"),
        ts: Date.now(),
        status: "end",
        text,
        subtitleJa: command.subtitleJa,
        subtitleZh: command.subtitleZh
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
        subtitleJa: command.subtitleJa,
        subtitleZh: command.subtitleZh,
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
          speaking: false,
          subtitleJa: "",
          subtitleZh: ""
        }
      });
    }
  }

  private async speakWithBrowserStream(
    tts: StreamingTtsEngine,
    bus: EventBus,
    text: string,
    command: AvatarCommand
  ): Promise<void> {
    try {
      const stream = await tts.createStream(text, {
        emotion: command.emotion,
        action: command.action
      });

      bus.publish({
        type: "voice",
        id: newId("voice"),
        ts: Date.now(),
        status: "start",
        text,
        subtitleJa: command.subtitleJa,
        subtitleZh: command.subtitleZh,
        audioUrl: stream.audioUrl,
        emotion: command.emotion,
        action: command.action
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("TTS stream failed", message);
      bus.publish({
        type: "voice",
        id: newId("voice"),
        ts: Date.now(),
        status: "error",
        text,
        subtitleJa: command.subtitleJa,
        subtitleZh: command.subtitleZh,
        emotion: command.emotion,
        action: command.action,
        error: message
      });
    }
  }
}
