import { join } from "node:path";
import { loadConfig } from "./config.js";
import { DebugControl } from "./debug/DebugControl.js";
import { EventBus } from "./events/EventBus.js";
import { GraphAgentRuntime } from "./agent-core/GraphAgentRuntime.js";
import { createLiveSource } from "./bili-live/createLiveSource.js";
import { createGameClient } from "./game-sts2/createGameClient.js";
import { GamePoller } from "./game-sts2/GamePoller.js";
import { OverlayServer } from "./obs-overlay/OverlayServer.js";
import { createTtsEngine, isStreamingTtsEngine } from "./voice/TtsEngine.js";
import { VoicePlaybackBarrier } from "./voice/VoicePlaybackBarrier.js";
import { VoiceRuntime } from "./voice/VoiceRuntime.js";
import { Logger } from "./utils/logger.js";

const publicDir = join(process.cwd(), "public");
const logger = new Logger("main");

const config = loadConfig();
const bus = new EventBus();
const debugControl = new DebugControl();
const liveSource = createLiveSource(config);
const gameClient = createGameClient(config);
const gamePoller = config.gamePollingEnabled ? new GamePoller(gameClient) : undefined;
const voicePlaybackBarrier = new VoicePlaybackBarrier();
const agent = new GraphAgentRuntime(config, debugControl, voicePlaybackBarrier);
const tts = createTtsEngine(config);
const voice = new VoiceRuntime(tts);
const overlay = new OverlayServer(
  config,
  bus,
  publicDir,
  debugControl,
  isStreamingTtsEngine(tts) ? tts : undefined,
  voicePlaybackBarrier
);

agent.start(bus);
voice.start(bus);
gamePoller?.start(bus);
await overlay.start();
await liveSource.start(bus);

logger.info("STS2 live agent is running", {
  overlay: `${config.publicBaseUrl}/overlay`,
  debug: `${config.publicBaseUrl}/debug`,
  mockBili: config.mockBili,
  mockSts2: config.mockSts2
});

const shutdown = async () => {
  logger.info("shutting down");
  await agent.stop();
  gamePoller?.stop();
  await liveSource.stop();
  await overlay.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
