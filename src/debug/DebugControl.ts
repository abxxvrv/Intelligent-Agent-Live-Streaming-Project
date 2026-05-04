export class DebugControl {
  private mode: "chat" | "game" = "chat";

  getMode(): "chat" | "game" {
    return this.mode;
  }

  setMode(mode: "chat" | "game"): "chat" | "game" {
    this.mode = mode;
    return this.mode;
  }
}
