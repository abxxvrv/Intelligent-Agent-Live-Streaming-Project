export class VoicePlaybackBarrier {
  private readonly pending = new Map<
    string,
    {
      resolve: () => void;
      timeout: NodeJS.Timeout;
    }
  >();

  wait(replyId: string, timeoutMs = 30_000): Promise<void> {
    if (!replyId) return Promise.resolve();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(replyId);
        resolve();
      }, timeoutMs);

      this.pending.set(replyId, {
        resolve: () => {
          clearTimeout(timeout);
          this.pending.delete(replyId);
          resolve();
        },
        timeout
      });
    });
  }

  complete(replyId: string): void {
    const item = this.pending.get(replyId);
    if (!item) return;
    item.resolve();
  }
}
