import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { Logger } from "../utils/logger.js";

export type TtsSpeakContext = {
  emotion?: string;
  action?: string;
};

export interface TtsEngine {
  speak(text: string, context?: TtsSpeakContext): Promise<void>;
}

export type TtsStreamJob = {
  id: string;
  text: string;
  context?: TtsSpeakContext;
  ref: RefAudioItem;
  createdAt: number;
};

export type TtsStreamInfo = {
  id: string;
  audioUrl: string;
};

export interface TtsStreamProvider {
  pipeStream(id: string, response: ServerResponse): Promise<void>;
}

export interface StreamingTtsEngine extends TtsEngine, TtsStreamProvider {
  createStream(text: string, context?: TtsSpeakContext): Promise<TtsStreamInfo>;
}

export function isStreamingTtsEngine(tts: TtsEngine): tts is StreamingTtsEngine {
  return (
    typeof (tts as Partial<StreamingTtsEngine>).createStream === "function" &&
    typeof (tts as Partial<StreamingTtsEngine>).pipeStream === "function"
  );
}

export class DisabledTtsEngine implements TtsEngine {
  async speak(text: string, _context?: TtsSpeakContext): Promise<void> {
    await sleep(estimateDurationMs(text));
  }
}

export class SystemTtsEngine implements TtsEngine {
  private readonly logger = new Logger("tts");

  constructor(private readonly config: AppConfig) {}

  async speak(text: string, _context?: TtsSpeakContext): Promise<void> {
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

export class GptSoVitsTtsEngine implements StreamingTtsEngine {
  private readonly logger = new Logger("gpt-sovits-tts");
  private initPromise?: Promise<void>;
  private references = new Map<string, RefAudioItem[]>();
  private allReferences: RefAudioItem[] = [];
  private readonly streamJobs = new Map<string, TtsStreamJob>();

  constructor(private readonly config: AppConfig) {}

  async speak(text: string, context?: TtsSpeakContext): Promise<void> {
    await this.ensureInitialized();

    this.logger.info("GPT-SoVITS speak start", {
      text,
      textLength: text.length,
      context
    });

    const ref = this.pickReference(context);
    const audio = await this.requestAudio(text, ref);
    const filePath = await saveTempWav(audio);

    this.logger.info("GPT-SoVITS wav generated", {
      filePath,
      bytes: audio.length
    });

    try {
      await playWavFile(filePath);
      this.logger.info("GPT-SoVITS wav kept for debug", { filePath });
    } finally {
      // Debug: keep generated wav files for inspection.
      // Restore deletion after debugging if needed.
      // await rm(filePath, { force: true }).catch((error) => {
      //   this.logger.warn("unable to remove temporary GPT-SoVITS wav file", error);
      // });
    }
  }

  async createStream(text: string, context?: TtsSpeakContext): Promise<TtsStreamInfo> {
    await this.ensureInitialized();

    const ref = this.pickReference(context);
    const id = randomUUID();
    this.streamJobs.set(id, {
      id,
      text,
      context,
      ref,
      createdAt: Date.now()
    });
    this.cleanupExpiredStreamJobs();

    this.logger.info("GPT-SoVITS stream job created", {
      id,
      textLength: text.length,
      context
    });

    return {
      id,
      audioUrl: `/api/tts/stream/${encodeURIComponent(id)}`
    };
  }

  async pipeStream(id: string, serverResponse: ServerResponse): Promise<void> {
    const job = this.streamJobs.get(id);
    if (!job) {
      serverResponse.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      serverResponse.end("TTS stream job not found");
      return;
    }

    const options = this.config.tts.gptSoVits;
    const endpoint = options.endpoint.replace(/\/+$/, "");
    const requestBody = this.createRequestBody(job.text, job.ref);
    const abortController = new AbortController();
    serverResponse.once("close", () => {
      if (!serverResponse.writableEnded) abortController.abort();
    });
    let upstream: Response;

    try {
      this.logger.info("request GPT-SoVITS audio stream", {
        id,
        textLength: job.text.length,
        refPath: job.ref.path,
        streamingMode: options.streamingMode,
        mediaType: options.streamingMediaType
      });

      upstream = await fetch(`${endpoint}/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        },
        signal: abortController.signal,
        body: JSON.stringify(requestBody)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.streamJobs.delete(id);
      if (!serverResponse.headersSent) {
        serverResponse.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        serverResponse.end(`GPT-SoVITS API request failed: ${message}`);
      } else {
        serverResponse.destroy(error instanceof Error ? error : new Error(message));
      }
      return;
    }

    this.logger.info("GPT-SoVITS stream response", {
      id,
      status: upstream.status,
      contentType: upstream.headers.get("content-type")
    });

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "");
      this.streamJobs.delete(id);
      serverResponse.writeHead(upstream.status || 502, { "content-type": "text/plain; charset=utf-8" });
      serverResponse.end(`GPT-SoVITS /tts failed: ${upstream.status} ${body || upstream.statusText}`);
      return;
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("audio")) {
      const body = await upstream.text().catch(() => "");
      this.streamJobs.delete(id);
      serverResponse.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      serverResponse.end(`GPT-SoVITS API returned non-audio content (${contentType || "unknown"}): ${body}`);
      return;
    }

    const body = upstream.body;
    if (!body) {
      this.streamJobs.delete(id);
      serverResponse.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      serverResponse.end("GPT-SoVITS returned empty stream body");
      return;
    }

    serverResponse.writeHead(200, {
      "content-type": contentType || "audio/wav",
      "cache-control": "no-cache, no-store, must-revalidate",
      connection: "keep-alive",
      "access-control-allow-origin": "*"
    });

    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await writeResponseChunk(serverResponse, Buffer.from(value));
        if (serverResponse.destroyed || serverResponse.writableEnded) break;
      }
      if (!serverResponse.destroyed && !serverResponse.writableEnded) serverResponse.end();
    } catch (error) {
      if (!serverResponse.destroyed && !serverResponse.writableEnded) {
        serverResponse.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.streamJobs.delete(id);
      reader.releaseLock();
    }
  }

  private async ensureInitialized(): Promise<void> {
    this.initPromise ??= this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const options = this.config.tts.gptSoVits;
    const endpoint = options.endpoint.replace(/\/+$/, "");

    if (options.gptWeightsPath.trim()) {
      await setGptSoVitsWeights(endpoint, "set_gpt_weights", options.gptWeightsPath);
    }

    if (options.sovitsWeightsPath.trim()) {
      await setGptSoVitsWeights(endpoint, "set_sovits_weights", options.sovitsWeightsPath);
    }

    this.references = await scanReferenceAudios(options.refAudioRoot);
    this.allReferences = Array.from(this.references.values()).flat();
  }

  private pickReference(context?: TtsSpeakContext): RefAudioItem {
    const options = this.config.tts.gptSoVits;
    const emotion = mapEmotionToFolder(context?.emotion, options.defaultRefEmotion);
    const candidates =
      this.references.get(emotion) ||
      this.references.get(options.defaultRefEmotion) ||
      this.allReferences;

    if (!candidates.length) {
      throw new Error(`GPT-SoVITS reference audio list is empty: ${options.refAudioRoot}`);
    }

    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    this.logger.info("selected GPT-SoVITS reference", {
      requestedEmotion: context?.emotion,
      mappedEmotion: emotion,
      refEmotion: selected.emotion,
      refPath: selected.path,
      promptText: selected.promptText,
      promptLang: selected.promptLang
    });

    return selected;
  }

  private async requestAudio(text: string, ref: RefAudioItem): Promise<Buffer> {
    const options = this.config.tts.gptSoVits;
    const endpoint = options.endpoint.replace(/\/+$/, "");
    const url = `${endpoint}/tts`;
    const textLang = inferTextLang(text, options.textLang || "zh");
    const requestBody = this.createRequestBody(text, ref);

    let response: Response;
    try {
      this.logger.info("request GPT-SoVITS audio", {
        text,
        textLength: text.length,
        textLang,
        refPath: ref.path,
        promptText: ref.promptText,
        promptLang: ref.promptLang || options.promptLang || "zh"
      });
      console.log("[gpt-sovits-tts] /tts request body:\n" + JSON.stringify(requestBody, null, 2));
      const requestJsonPath = await saveTempJson(requestBody);
      this.logger.info("GPT-SoVITS request body saved", { filePath: requestJsonPath });

      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(requestBody)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`GPT-SoVITS API request failed: ${message}. Is the API running at ${endpoint}?`);
    }

    this.logger.info("GPT-SoVITS response", {
      status: response.status,
      contentType: response.headers.get("content-type")
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GPT-SoVITS /tts failed: ${response.status} ${body || response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("audio")) {
      const body = await response.text().catch(() => "");
      throw new Error(`GPT-SoVITS API returned non-audio content (${contentType || "unknown"}): ${body}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  private createRequestBody(text: string, ref: RefAudioItem): GptSoVitsRequestBody {
    const options = this.config.tts.gptSoVits;
    return {
      text,
      text_lang: inferTextLang(text, options.textLang || "zh"),
      ref_audio_path: ref.path,
      prompt_text: ref.promptText,
      prompt_lang: ref.promptLang || options.promptLang || "zh",
      text_split_method: options.textSplitMethod || "cut5",
      batch_size: options.batchSize ?? 1,
      speed_factor: options.speedFactor ?? 1.0,
      media_type: options.streamingMediaType || "wav",
      streaming_mode: options.streamingMode ?? 3,
      parallel_infer: true,
      repetition_penalty: 1.35
    };
  }

  private cleanupExpiredStreamJobs(): void {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [id, job] of this.streamJobs) {
      if (job.createdAt < cutoff) this.streamJobs.delete(id);
    }
  }
}

export function createTtsEngine(config: AppConfig): TtsEngine {
  if (!config.tts.enabled || config.tts.provider === "disabled") {
    return new DisabledTtsEngine();
  }

  if (config.tts.provider === "gpt-sovits") {
    return new GptSoVitsTtsEngine(config);
  }

  return new SystemTtsEngine(config);
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

async function saveTempWav(audio: Buffer): Promise<string> {
  const dir = path.join(process.cwd(), "outputs", "tts");
  await mkdir(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `${timestamp}-${randomUUID()}.wav`);

  await writeFile(filePath, audio);
  return filePath;
}

async function saveTempJson(value: unknown): Promise<string> {
  const dir = path.join(process.cwd(), "outputs", "tts");
  await mkdir(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `${timestamp}-${randomUUID()}-request.json`);

  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  return filePath;
}

function playWavFile(filePath: string): Promise<void> {
  if (process.platform === "win32") return playWavWithPowerShell(filePath);
  if (process.platform === "darwin") return speakWithCommand("afplay", [filePath]);
  return speakWithCommand("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath]).catch(() =>
    speakWithCommand("aplay", [filePath])
  );
}

function playWavWithPowerShell(filePath: string): Promise<void> {
  const escapedPath = psSingleQuote(filePath);
  const command = [
    `$player = New-Object System.Media.SoundPlayer ${escapedPath};`,
    "$player.Load();",
    "$player.PlaySync();"
  ].join(" ");
  return speakWithCommand("powershell.exe", ["-NoProfile", "-Command", command]);
}

export type RefAudioItem = {
  emotion: string;
  path: string;
  promptText: string;
  promptLang: string;
};

type GptSoVitsRequestBody = {
  text: string;
  text_lang: string;
  ref_audio_path: string;
  prompt_text: string;
  prompt_lang: string;
  text_split_method: string;
  batch_size: number;
  speed_factor: number;
  media_type: string;
  streaming_mode: number;
  parallel_infer: boolean;
  repetition_penalty: number;
};

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".flac", ".ogg"]);
const CN_EMOTION_FOLDERS = new Set(["喜差", "撒娇", "委屈", "欣慰", "慵懒", "愤懑", "责备", "战斗", "自嘲"]);
const EN_EMOTION_MAP: Record<string, string> = {
  neutral: "慵懒",
  happy: "欣慰",
  thinking: "慵懒",
  surprised: "撒娇",
  focus: "慵懒",
  awkward: "自嘲",
  sad: "委屈",
  angry: "愤懑",
  serious: "责备",
  battle: "战斗",
  shy: "撒娇",
  lazy: "慵懒",
  mocking: "自嘲"
};

export function mapEmotionToFolder(emotion?: string, defaultEmotion = "慵懒"): string {
  const cleaned = emotion?.trim();
  if (!cleaned) return defaultEmotion;
  if (CN_EMOTION_FOLDERS.has(cleaned)) return cleaned;
  return EN_EMOTION_MAP[cleaned.toLowerCase()] || defaultEmotion;
}

async function scanReferenceAudios(root: string): Promise<Map<string, RefAudioItem[]>> {
  let folders;
  try {
    folders = await readdir(root, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GPT-SoVITS reference audio root is unavailable: ${root} (${message})`);
  }

  const references = new Map<string, RefAudioItem[]>();

  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const emotion = folder.name;
    const folderPath = path.join(root, folder.name);
    const files = await readdir(folderPath, { withFileTypes: true });

    for (const file of files) {
      if (!file.isFile()) continue;
      const ext = path.extname(file.name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) continue;

      const item: RefAudioItem = {
        emotion,
        path: toApiPath(path.join(folderPath, file.name)),
        promptText: path.basename(file.name, ext),
        promptLang: inferPromptLang(path.basename(file.name, ext))
      };
      const items = references.get(emotion) || [];
      items.push(item);
      references.set(emotion, items);
    }
  }

  const total = Array.from(references.values()).reduce((sum, items) => sum + items.length, 0);
  if (!total) {
    throw new Error(`GPT-SoVITS reference audio root has no supported audio files: ${root}`);
  }

  return references;
}

async function setGptSoVitsWeights(endpoint: string, route: "set_gpt_weights" | "set_sovits_weights", weightsPath: string): Promise<void> {
  const apiPath = toApiPath(weightsPath);
  const response = await fetch(`${endpoint}/${route}?weights_path=${encodeURIComponent(apiPath)}`, {
    method: "GET"
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GPT-SoVITS /${route} failed: ${response.status} ${body || response.statusText}`);
  }
}

function toApiPath(value: string): string {
  return value.replace(/\\/g, "/");
}

// function inferPromptLang(promptText: string): string {
//   if (/[\u3040-\u30ff]/u.test(promptText)) return "all_ja";
//   if (/[\u4e00-\u9fff]/u.test(promptText)) return "all_zh";
//   return "zh";
// }

// function inferTextLang(text: string, fallback = "zh"): string {
//   if (/[\u3040-\u30ff]/u.test(text)) return "all_ja";
//   if (/[\uac00-\ud7af]/u.test(text)) return "all_ko";
//   if (/[\u4e00-\u9fff]/u.test(text)) return "all_zh";
//   if (/[A-Za-z]/.test(text)) return "en";
//   return fallback;
// }
function inferPromptLang(promptText: string): string {
  return "all_ja";
}

function inferTextLang(text: string, fallback = "zh"): string {
  return "all_ja";
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

async function writeResponseChunk(response: ServerResponse, chunk: Buffer): Promise<void> {
  if (response.destroyed || response.writableEnded) return;
  if (response.write(chunk)) return;
  await waitForWritableResponse(response);
}

function waitForWritableResponse(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
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
