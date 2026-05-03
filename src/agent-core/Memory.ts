import type { DanmakuEvent, GameState } from "../types.js";

export type ConversationTurn = {
  user: string;
  assistant: string;
};

export class Memory {
  private readonly danmaku: DanmakuEvent[] = [];
  private replies: string[] = [];
  private readonly conversation: ConversationTurn[] = [];
  private gameState?: GameState;

  constructor(
    private readonly maxDanmaku: number,
    private readonly maxConversationTurns = 12
  ) {}

  addDanmaku(event: DanmakuEvent): void {
    this.danmaku.push(event);
    while (this.danmaku.length > this.maxDanmaku) this.danmaku.shift();
  }

  setGameState(state: GameState): void {
    this.gameState = state;
  }

  addReply(text: string): void {
    if (!text.trim()) return;
    this.replies.push(text.trim());
    while (this.replies.length > 8) this.replies.shift();
  }

  addConversationTurn(user: string, assistant: string): void {
    const cleanedUser = user.trim();
    const cleanedAssistant = assistant.trim();
    if (!cleanedUser || !cleanedAssistant) return;
    this.conversation.push({
      user: cleanedUser.slice(0, 600),
      assistant: cleanedAssistant.slice(0, 600)
    });
    while (this.conversation.length > this.maxConversationTurns) this.conversation.shift();
  }

  getRecentDanmaku(): DanmakuEvent[] {
    return [...this.danmaku];
  }

  getRecentReplies(): string[] {
    return [...this.replies];
  }

  getConversationHistory(): ConversationTurn[] {
    return this.conversation.map((turn) => ({ ...turn }));
  }

  getGameState(): GameState | undefined {
    return this.gameState;
  }
}
