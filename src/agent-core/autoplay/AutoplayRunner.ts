import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { AgentDecision, AgentReplyEvent, AgentTraceEvent, ToolCallEvent } from "../../types.js";
import { newId } from "../../utils/id.js";
import { Logger } from "../../utils/logger.js";

export type AutoplayGoal =
  | { kind: "steps"; maxSteps: number }
  | { kind: "floors"; count: number }
  | { kind: "combat" }
  | { kind: "until_next_room" };

export type AutoplayStatus = "idle" | "running" | "stopping" | "stopped" | "error";

export type AutoplayRun = {
  id: string;
  goal: AutoplayGoal;
  status: AutoplayStatus;
  startedAt: number;
  stepsUsed: number;
  startFloor?: number;
  startScreen?: string;
  startedInCombat?: boolean;
  enteredCombat?: boolean;
  stopReason?: string;
};

export type AutoplayRunnerOptions = {
  config: AppConfig;
  tools: StructuredToolInterface[];
  canUseActions: () => boolean;
  decideAction?: (input: AutoplayDecisionInput) => Promise<AutoplayDecision>;
  onTrace?: (event: AgentTraceEvent) => void;
  onToolCall?: (event: ToolCallEvent) => void;
  onReply?: (event: AgentReplyEvent) => void;
};

export type NormalizedAction = {
  name: string;
  requiresIndex?: boolean;
  requiredIndex?: "card_index" | "option_index";
  requiresTarget?: boolean;
  raw: unknown;
};

export type AutoplayDecisionInput = {
  run: AutoplayRun;
  gameState: unknown;
  availableActions: NormalizedAction[];
  metadata?: unknown;
};

const DecisionSchema = z.object({
  action: z.string().min(1),
  card_index: z.number().int().optional(),
  target_index: z.number().int().optional(),
  option_index: z.number().int().optional(),
  index: z.number().int().optional(),
  reason: z.string().max(300),
  confidence: z.number().min(0).max(1)
});

export type AutoplayDecision = z.infer<typeof DecisionSchema>;

const REQUIRED_TOOLS = ["health_check", "get_game_state", "get_available_actions", "wait_until_actionable", "act"];
const FALLBACK_ACTION_PRIORITY = [
  "collect_rewards_and_proceed",
  "skip_reward_cards",
  "close_shop_inventory",
  "proceed",
  "end_turn",
  "confirm_selection",
  "confirm_modal",
  "dismiss_modal"
];
const CARD_INDEX_ACTIONS = new Set(["play_card"]);
const OPTION_INDEX_ACTIONS = new Set([
  "choose_map_node",
  "resolve_rewards",
  "claim_reward",
  "choose_reward_card",
  "select_deck_card",
  "choose_treasure_relic",
  "choose_event_option",
  "choose_capstone_option",
  "choose_bundle",
  "choose_rest_option",
  "buy_card",
  "buy_relic",
  "buy_potion",
  "choose_timeline_epoch",
  "select_character",
  "use_potion",
  "discard_potion"
]);

export class AutoplayRunner {
  private readonly logger = new Logger("autoplay");
  private readonly toolsByName: Map<string, StructuredToolInterface>;
  private readonly model?: ChatOpenAI;
  private currentRun: AutoplayRun | null = null;
  private stopRequested = false;

  constructor(private readonly options: AutoplayRunnerOptions) {
    this.toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
    if (options.config.llm.apiKey) {
      this.model = new ChatOpenAI({
        model: options.config.llm.model,
        apiKey: options.config.llm.apiKey,
        temperature: 0.2,
        timeout: options.config.llm.timeoutMs,
        configuration: {
          baseURL: options.config.llm.baseUrl
        }
      });
    }
  }

  get status(): AutoplayRun | null {
    return this.currentRun ? { ...this.currentRun } : null;
  }

  start(goal: AutoplayGoal): AutoplayRun {
    if (this.currentRun?.status === "running" || this.currentRun?.status === "stopping") {
      throw new Error("Autoplay is already running.");
    }
    if (!this.options.canUseActions()) {
      throw new Error("Autoplay actions are disabled.");
    }
    this.requireTools(REQUIRED_TOOLS);

    const run: AutoplayRun = {
      id: newId("autoplay"),
      goal,
      status: "running",
      startedAt: Date.now(),
      stepsUsed: 0
    };

    this.currentRun = run;
    this.stopRequested = false;

    void this.runLoop(run).catch((error) => {
      run.status = "error";
      run.stopReason = error instanceof Error ? error.message : String(error);
      this.emitTrace(run, {
        stage: "final",
        title: "自动游玩失败",
        message: run.stopReason,
        status: "error"
      });
      this.emitFinalReply(run, run.stopReason || "自动游玩失败");
      this.logger.warn("Autoplay failed", error);
    });

    return { ...run };
  }

  stop(reason = "手动停止"): void {
    this.stopRequested = true;
    if (this.currentRun?.status === "running") {
      this.currentRun.status = "stopping";
      this.currentRun.stopReason = reason;
    }
  }

  private async runLoop(run: AutoplayRun): Promise<AutoplayRun> {
    const maxHardSteps = this.getHardStepLimit(run.goal);
    let toolFailures = 0;
    let noActionTicks = 0;
    let lastAction: string | undefined;
    let latestState: unknown;

    this.emitTrace(run, {
      stage: "run-start",
      title: "自动游玩启动",
      message: `目标：${describeGoal(run.goal)}`
    });

    await this.invokeTool(run, "health_check", {});

    for (;;) {
      const stopReason = this.basicStopReason(run, latestState, maxHardSteps);
      if (stopReason) return this.finish(run, stopReason);

      try {
        latestState = latestState ?? (await this.invokeTool(run, "get_game_state", {}));
        this.initializeRunContext(run, latestState);

        const goalStopReason = this.shouldStopByGoal(run, latestState);
        if (goalStopReason) return this.finish(run, goalStopReason);
        if (this.isGameOver(latestState)) return this.finish(run, "游戏已经结束");

        let availableActions = normalizeAvailableActions(await this.invokeTool(run, "get_available_actions", {}));
        if (!availableActions.length) {
          const waited = await this.waitForActions(run, latestState, Math.max(1, 6 - noActionTicks));
          latestState = waited.state;
          availableActions = waited.actions;
          noActionTicks += waited.attempts;
        }
        if (!availableActions.length) {
          if (this.isGameOver(latestState)) return this.finish(run, "游戏已经结束");
          if (noActionTicks >= 6) return this.finish(run, "连续等待后仍没有可用动作");

          this.emitTrace(run, {
            stage: "tool-result",
            title: "等待可用动作",
            message: `当前暂时没有可用动作，继续等待 ${noActionTicks}/6。`
          });
          latestState = undefined;
          await sleep(1_000);
          continue;
        }

        noActionTicks = 0;

        const forcedDecision = this.forcedRoutingDecision(latestState, availableActions, lastAction);
        const decision =
          forcedDecision ??
          (await this.decideNextAction({
            run: { ...run },
            gameState: latestState,
            availableActions,
            metadata: await this.maybeGetRelevantGameData(run)
          }));
        const selectedAction = availableActions.find((action) => action.name === decision.action);
        let normalizedDecision = selectedAction ? normalizeDecisionForAction(decision, selectedAction) : decision;
        const validationError = this.validateDecision(normalizedDecision, availableActions);
        if (validationError) {
          const fallback = fallbackDecisionForInvalidDecision(availableActions, validationError);
          if (!fallback) return this.finish(run, validationError);
          this.emitTrace(run, {
            stage: "llm-message",
            title: "修正无效决策",
            message: `${validationError}，改用 ${fallback.action}。`
          });
          normalizedDecision = fallback;
        }
        if (normalizedDecision.confidence < 0.45) return this.finish(run, `模型置信度太低：${normalizedDecision.confidence}`);

        this.emitTrace(run, {
          stage: "llm-message",
          title: "决策动作",
          message: `${normalizedDecision.action}：${normalizedDecision.reason}`
        });

        const actResult = await this.invokeTool(run, "act", compactActArgs(normalizedDecision));
        run.stepsUsed += 1;
        toolFailures = 0;
        lastAction = normalizedDecision.action;
        latestState =
          normalizedDecision.action === "end_turn" ? undefined : extractStateFromActResult(actResult) ?? undefined;

        const afterActionStopReason = this.shouldStopByGoal(run, latestState);
        if (afterActionStopReason) return this.finish(run, afterActionStopReason);
      } catch (error) {
        toolFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.emitTrace(run, {
          stage: "tool-result",
          title: "自动游玩步骤失败",
          message,
          status: "error"
        });
        if (toolFailures >= 2) {
          return this.finish(run, `连续失败：${message}`);
        }
        lastAction = undefined;
        latestState = undefined;
      }
    }
  }

  private async decideNextAction(input: AutoplayDecisionInput): Promise<AutoplayDecision> {
    if (this.options.decideAction) return this.options.decideAction(input);
    if (!this.model) throw new Error("LLM API key is required for autoplay decisions.");

    const response = await this.model.invoke([
      new SystemMessage(
        [
          "你是 STS2 自动游玩决策器。",
          "每次只能选择一个下一步动作。",
          "只能从 availableActions 里选择 action。",
          "不要复用旧索引；所有 index 必须来自当前最新状态。",
          "如果动作需要 card_index、target_index 或 option_index，必须填写对应字段。",
          "play_card 必须使用 card_index。",
          "地图、奖励、商店、事件、休息、选牌、药水动作必须使用 option_index；例如 buy_card/buy_relic/buy_potion 必须带 option_index。",
          "如果你不确定某个购买或选择动作的 option_index，就选择 proceed/close_shop_inventory/skip_reward_cards 等无需索引且合法的动作。",
          "",
          "你必须只输出 JSON，不要 Markdown，不要解释。",
          "JSON 格式如下：",
          "{",
          '  "action": "play_card",',
          '  "card_index": 1,',
          '  "target_index": 0,',
          '  "option_index": 0,',
          '  "reason": "简短说明为什么这么做",',
          '  "confidence": 0.8',
          "}",
          "",
          "如果某个 index 不需要，就不要输出那个字段。"
        ].join("\n")
      ),
      new HumanMessage(
        JSON.stringify({
          goal: input.run.goal,
          stepsUsed: input.run.stepsUsed,
          gameState: input.gameState,
          availableActions: input.availableActions,
          metadata: input.metadata
        })
      )
    ]);
    const decision = parseJsonObject(getMessageText(response));
    return DecisionSchema.parse(decision);
  }

  private validateDecision(decision: AutoplayDecision, availableActions: NormalizedAction[]): string {
    const selected = availableActions.find((action) => action.name === decision.action);
    if (!selected) return `模型选择了非法动作：${decision.action}`;
    if (selected.requiredIndex === "card_index" && decision.card_index === undefined) {
      return `${decision.action} 需要 card_index，但模型没有提供`;
    }
    if (selected.requiredIndex === "option_index" && decision.option_index === undefined) {
      return `${decision.action} 需要 option_index，但模型没有提供`;
    }
    if (selected.requiresIndex && !selected.requiredIndex && !hasAnyIndex(decision)) {
      return `${decision.action} 需要 index，但模型没有提供`;
    }
    if (selected.requiresTarget && decision.target_index === undefined) {
      return `${decision.action} 需要 target_index，但模型没有提供`;
    }
    return "";
  }

  private forcedRoutingDecision(
    gameState: unknown,
    availableActions: NormalizedAction[],
    lastAction: string | undefined
  ): AutoplayDecision | undefined {
    if (lastAction === "close_shop_inventory" && hasAction(availableActions, "proceed")) {
      return {
        action: "proceed",
        reason: "刚关闭商店库存，继续离开商店推进楼层，避免反复开关商店。",
        confidence: 0.95
      };
    }

    if (
      extractScreen(gameState).toUpperCase() === "SHOP" &&
      hasAction(availableActions, "proceed") &&
      !hasAction(availableActions, "close_shop_inventory") &&
      lastAction === "open_shop_inventory"
    ) {
      return {
        action: "proceed",
        reason: "商店库存已关闭且可以前进，离开商店继续推进目标。",
        confidence: 0.9
      };
    }

    return undefined;
  }

  private basicStopReason(run: AutoplayRun, gameState: unknown, maxHardSteps: number): string {
    if (this.stopRequested) return run.stopReason || "收到停止请求";
    if (!this.options.canUseActions()) return "动作权限已关闭";
    if (run.stepsUsed >= maxHardSteps) return `达到最大步数限制：${maxHardSteps}`;
    if (gameState && this.isGameOver(gameState)) return "游戏已经结束";
    return "";
  }

  private shouldStopByGoal(run: AutoplayRun, gameState: unknown): string {
    if (run.goal.kind === "steps" && run.stepsUsed >= run.goal.maxSteps) {
      return `已执行 ${run.goal.maxSteps} 步`;
    }

    if (run.goal.kind === "floors") {
      const currentFloor = extractFloor(gameState);
      if (
        run.startFloor !== undefined &&
        currentFloor !== undefined &&
        currentFloor >= run.startFloor + run.goal.count
      ) {
        return `已推进 ${run.goal.count} 层`;
      }
    }

    if (run.goal.kind === "combat") {
      const inCombat = isInCombat(gameState);
      if (inCombat) run.enteredCombat = true;
      if ((run.startedInCombat || run.enteredCombat) && !inCombat && run.stepsUsed > 0) {
        return "战斗已结束";
      }
    }

    if (run.goal.kind === "until_next_room") {
      const currentFloor = extractFloor(gameState);
      const currentScreen = extractScreen(gameState);
      if (run.stepsUsed > 0 && currentFloor !== undefined && run.startFloor !== undefined && currentFloor !== run.startFloor) {
        return "已进入下一层";
      }
      if (run.stepsUsed > 0 && currentScreen && run.startScreen && currentScreen !== run.startScreen) {
        return "已进入新的房间状态";
      }
    }

    return "";
  }

  private initializeRunContext(run: AutoplayRun, gameState: unknown): void {
    if (run.startFloor === undefined) run.startFloor = extractFloor(gameState);
    if (!run.startScreen) run.startScreen = extractScreen(gameState);
    if (run.startedInCombat === undefined) run.startedInCombat = isInCombat(gameState);
  }

  private async waitUntilActionable(run: AutoplayRun): Promise<{ state?: unknown; actions: NormalizedAction[] }> {
    const result = await this.invokeTool(run, "wait_until_actionable", { timeout_seconds: 20 });
    const record = asRecord(result);
    return {
      state: record.state,
      actions: normalizeAvailableActions(record.actions)
    };
  }

  private async waitForActions(
    run: AutoplayRun,
    latestState: unknown,
    maxAttempts: number
  ): Promise<{ state: unknown; actions: NormalizedAction[]; attempts: number }> {
    let state = latestState;
    let actions: NormalizedAction[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const waited = await this.waitUntilActionable(run);
      state = waited.state ?? state ?? (await this.invokeTool(run, "get_game_state", {}));
      actions = waited.actions.length
        ? waited.actions
        : normalizeAvailableActions(await this.invokeTool(run, "get_available_actions", {}));

      if (actions.length || this.isGameOver(state)) {
        return { state, actions, attempts: attempt };
      }

      this.emitTrace(run, {
        stage: "tool-result",
        title: "等待可用动作",
        message: `暂时没有可用动作，第 ${attempt}/${maxAttempts} 次等待。`
      });
      await sleep(500);
    }

    return { state, actions, attempts: maxAttempts };
  }

  private async maybeGetRelevantGameData(run: AutoplayRun): Promise<unknown> {
    void run;
    return undefined;
  }

  private async invokeTool(run: AutoplayRun, name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.toolsByName.get(name);
    if (!tool) throw new Error(`Missing STS2 tool: ${name}`);

    this.emitToolCall({ name, status: "start", args });
    try {
      const output = await tool.invoke(args);
      const parsed = parseMcpToolOutput(output);
      this.emitToolCall({ name, status: "success", args, resultSummary: summarizeValue(parsed) });
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitToolCall({ name, status: "error", args, error: message });
      throw error;
    }
  }

  private finish(run: AutoplayRun, reason: string): AutoplayRun {
    run.status = "stopped";
    run.stopReason = reason;
    this.stopRequested = false;

    this.emitTrace(run, {
      stage: "final",
      title: "自动游玩停止",
      message: `${reason}，共执行 ${run.stepsUsed} 步。`
    });
    this.emitFinalReply(run, `${reason}，我先停在这里。共执行 ${run.stepsUsed} 步。`);
    return { ...run };
  }

  private requireTools(names: string[]): void {
    const missing = names.filter((name) => !this.toolsByName.has(name));
    if (missing.length) throw new Error(`Missing STS2 tools: ${missing.join(", ")}`);
  }

  private getHardStepLimit(goal: AutoplayGoal): number {
    if (goal.kind === "steps") return goal.maxSteps;
    if (goal.kind === "combat") return 40;
    if (goal.kind === "until_next_room") return 25;
    if (goal.kind === "floors") return Math.max(20, goal.count * 35);
    return 30;
  }

  private isGameOver(gameState: unknown): boolean {
    const screen = extractScreen(gameState).toLowerCase();
    return screen.includes("game_over") || screen.includes("victory");
  }

  private emitTrace(run: AutoplayRun, event: Omit<AgentTraceEvent, "type" | "id" | "ts" | "runId">): void {
    this.options.onTrace?.({
      type: "agent-trace",
      id: newId("trace"),
      ts: Date.now(),
      runId: run.id,
      ...event
    });
  }

  private emitToolCall(event: Omit<ToolCallEvent, "type" | "id" | "ts">): void {
    this.options.onToolCall?.({
      type: "tool-call",
      id: newId("tool"),
      ts: Date.now(),
      ...event
    });
  }

  private emitFinalReply(run: AutoplayRun, text: string): void {
    const decision: AgentDecision = {
      say: text.slice(0, 180),
      emotion: "focus",
      avatarAction: "talk",
      shouldSpeak: true,
      gameIntent: "explain_state"
    };
    this.options.onReply?.({
      type: "agent-reply",
      id: newId("reply"),
      ts: Date.now(),
      sourceEventId: run.id,
      decision
    });
  }
}

export function parseMcpToolOutput(output: unknown): unknown {
  const value = typeof output === "string" ? safeJsonParse(output) : output;
  if (!isRecord(value)) return value;
  if ("structuredContent" in value && value.structuredContent !== undefined) return value.structuredContent;

  const content = value.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return safeJsonParse(text);
  }
  return value;
}

export function normalizeAvailableActions(value: unknown): NormalizedAction[] {
  const source = isRecord(value) && Array.isArray(value.result) ? value.result : value;
  if (!Array.isArray(source)) return [];
  return source
    .map((item): NormalizedAction | undefined => {
      if (typeof item === "string") return { name: item, raw: item };
      if (!isRecord(item)) return undefined;
      const name = stringField(item, "name") || stringField(item, "action");
      if (!name) return undefined;
      return {
        name,
        requiresIndex: booleanField(item, "requires_index") || booleanField(item, "requiresIndex") || Boolean(inferRequiredIndex(name)),
        requiredIndex: inferRequiredIndex(name),
        requiresTarget: booleanField(item, "requires_target") || booleanField(item, "requiresTarget"),
        raw: item
      };
    })
    .filter((item): item is NormalizedAction => Boolean(item));
}

export function extractStateFromActResult(value: unknown): unknown {
  if (isRecord(value) && "state" in value) return value.state;
  return undefined;
}

function compactActArgs(decision: AutoplayDecision): Record<string, unknown> {
  const args: Record<string, unknown> = { action: decision.action };
  for (const key of ["card_index", "target_index", "option_index"] as const) {
    if (decision[key] !== undefined) args[key] = decision[key];
  }
  return args;
}

function normalizeDecisionForAction(decision: AutoplayDecision, action: NormalizedAction): AutoplayDecision {
  if (action.requiredIndex === "card_index" && decision.card_index === undefined && decision.index !== undefined) {
    return { ...decision, card_index: decision.index };
  }
  if (action.requiredIndex === "option_index" && decision.option_index === undefined && decision.index !== undefined) {
    return { ...decision, option_index: decision.index };
  }
  return decision;
}

function fallbackDecisionForInvalidDecision(
  availableActions: NormalizedAction[],
  reason: string
): AutoplayDecision | undefined {
  for (const actionName of FALLBACK_ACTION_PRIORITY) {
    const action = availableActions.find((item) => item.name === actionName);
    if (action && !action.requiredIndex && !action.requiresIndex && !action.requiresTarget) {
      return {
        action: action.name,
        reason: `上一个决策参数不完整：${reason}`,
        confidence: 0.6
      };
    }
  }
  return undefined;
}

function hasAction(availableActions: NormalizedAction[], actionName: string): boolean {
  return availableActions.some((action) => action.name === actionName);
}

function describeGoal(goal: AutoplayGoal): string {
  if (goal.kind === "steps") return `执行 ${goal.maxSteps} 步`;
  if (goal.kind === "floors") return `推进 ${goal.count} 层`;
  if (goal.kind === "combat") return "打完战斗";
  return "进入下一房间";
}

function hasAnyIndex(decision: AutoplayDecision): boolean {
  return (
    decision.card_index !== undefined ||
    decision.target_index !== undefined ||
    decision.option_index !== undefined ||
    decision.index !== undefined
  );
}

function inferRequiredIndex(actionName: string): "card_index" | "option_index" | undefined {
  if (CARD_INDEX_ACTIONS.has(actionName)) return "card_index";
  if (OPTION_INDEX_ACTIONS.has(actionName)) return "option_index";
  return undefined;
}

function extractFloor(gameState: unknown): number | undefined {
  const state = asRecord(gameState);
  const run = asRecord(state.run);
  const act = asRecord(state.act);
  const session = asRecord(state.session);
  for (const value of [run.floor, state.floor, act.floor, session.floor]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function extractScreen(gameState: unknown): string {
  const state = asRecord(gameState);
  return typeof state.screen === "string" ? state.screen : "";
}

function isInCombat(gameState: unknown): boolean {
  const state = asRecord(gameState);
  if (typeof state.in_combat === "boolean") return state.in_combat;
  if (typeof state.inCombat === "boolean") return state.inCombat;
  return extractScreen(gameState).toUpperCase() === "COMBAT";
}

function summarizeValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 420 ? compact : `${compact.slice(0, 420)}...`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function getMessageText(message: AIMessage): string {
  if (typeof message.content === "string") return message.content.trim();

  if (Array.isArray(message.content)) {
    return message.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

export function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // Fall through to object extraction below.
      }
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`Model did not return JSON: ${trimmed.slice(0, 300)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function stringField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function booleanField(obj: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (typeof obj[key] === "boolean") return Boolean(obj[key]);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
