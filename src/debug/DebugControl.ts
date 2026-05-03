export class DebugControl {
  private autoplayEnabled = false;

  isAutoplayEnabled(): boolean {
    return this.autoplayEnabled;
  }

  setAutoplayEnabled(enabled: boolean): boolean {
    this.autoplayEnabled = enabled;
    return this.autoplayEnabled;
  }
}
