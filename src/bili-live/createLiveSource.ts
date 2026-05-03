import type { AppConfig } from "../config.js";
import type { LiveSource } from "./LiveSource.js";
import { BiliLiveSource } from "./BiliLiveSource.js";
import { DisabledLiveSource } from "./DisabledLiveSource.js";
import { SimulatedLiveSource } from "./SimulatedLiveSource.js";

export function createLiveSource(config: AppConfig): LiveSource {
  if (config.mockBili) {
    return new SimulatedLiveSource();
  }
  if (!config.biliRoomId) return new DisabledLiveSource();
  return new BiliLiveSource(config.biliRoomId);
}
