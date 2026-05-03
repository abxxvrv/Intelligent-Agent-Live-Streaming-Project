import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";
import { Logger } from "../utils/logger.js";

export interface TtsEngine {
  speak(text: string): Promise<void>;
}

export class SystemTtsEngine implements TtsEngine {
  private readonly logger = new Logger("tts");

  constructor(private readonly config: AppConfig) {}

  async speak(text: string): Promise<void> {
    if (!this.config.tts.enabled || this.config.tts.provider === "disabled") {
      await sleep(estimateDurationMs(text));
      return;
    }

    if (process.platform === "win32") {
      try {
        await speakWithPowerShell(text, this.config);
      } catch (error) {
        this.logger.warn("Windows system TTS unavailable, simulating speech duration", error);
        await sleep(estimateDurationMs(text));
      }
      return;
    }

    try {
      await speakWithCommand("say", [text]);
    } catch {
      this.logger.warn("no local TTS command found, simulating speech duration");
      await sleep(estimateDurationMs(text));
    }
  }
}

function speakWithPowerShell(text: string, config: AppConfig): Promise<void> {
  const escapedText = psSingleQuote(text);
  const voiceLine = config.tts.voice
    ? `$speaker.SelectVoice(${psSingleQuote(config.tts.voice)});`
    : "";
  const command = [
    "Add-Type -AssemblyName System.Speech;",
    "$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    `$speaker.Rate = ${config.tts.rate};`,
    `$speaker.Volume = ${config.tts.volume};`,
    voiceLine,
    `$speaker.Speak(${escapedText});`
  ].join(" ");
  return speakWithCommand("powershell.exe", ["-NoProfile", "-Command", command]);
}

function speakWithCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateDurationMs(text: string): number {
  return Math.max(800, Math.min(8_000, text.length * 180));
}
