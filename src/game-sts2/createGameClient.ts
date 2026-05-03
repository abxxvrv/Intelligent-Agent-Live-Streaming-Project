import type { AppConfig } from "../config.js";
import type { GameClient } from "./Sts2Client.js";
import { MockSts2Client, Sts2Client } from "./Sts2Client.js";

export function createGameClient(config: AppConfig): GameClient {
  return config.mockSts2 ? new MockSts2Client() : new Sts2Client(config.sts2ApiUrl);
}
