# AGENTS.md

## Project Overview
这是一个“《杀戮尖塔2》智能体直播陪聊”项目。目标是让一个虚拟主播式智能体监听 B站直播弹幕、读取游戏状态、调用大模型和工具/MCP、用 TTS 说话，并在 OBS overlay 中展示 Live2D/PNG 形象。

当前阶段：直播外壳、debug-only 多轮对话、LangGraph parent graph + chat_subgraph + game_subgraph、DeepSeek 工具调用、STS2-Agent v0.6.0 MCP 接入、调试控制台、Live2D overlay 适配层、overlay 语音播放队列都已完成 MVP。智能体可以通过 MCP 读取真实游戏状态和可用动作，并在 `runtimeMode === "game"` 时由 `game_agent` 按 game tick 持续决策。普通聊天 graph 不直接暴露 `act`；游戏动作只在 game tools 中可用，且只受 `.env` 总开关 `STS2_MCP_ALLOW_ACTIONS=true` 控制。

`AutoplayRunner` 相关代码暂时保留为旧路径/测试覆盖，但不再是新 game agent 主路径；新 graph 不注入 `start_autoplay` / `stop_autoplay`。

## Tech Stack
- Frontend: 静态 HTML/CSS/JS overlay + debug console，SSE 接收事件，Pixi + Live2D Cubism Core + `pixi-live2d-display/cubism4` 渲染 hibiki Live2D；overlay 前端维护浏览器 TTS 播放队列。
- Backend: Node.js 20 + TypeScript，本地 HTTP server，EventBus 事件流。
- Agent: LangGraph.js + LangChain tools + DeepSeek OpenAI-compatible API。
- MCP: `@modelcontextprotocol/sdk` TypeScript stdio client；STS2-Agent v0.6.0 发布包内置 FastMCP server；Python `mcp.server.fastmcp` 探针 server 仍用于测试。
- Live: `bilibili-live-danmaku` 只读监听弹幕；默认不启用真实/模拟弹幕，调试主要走 `/debug` 手动输入。
- Voice: Windows/System TTS，失败时模拟说话时长。
- Tests: Vitest。
- Database: 暂无；记忆目前是内存。
- Deployment: 本机运行，OBS 浏览器源捕获 `http://127.0.0.1:3080/overlay`。

## Current Architecture
主要数据流：

```text
debug 弹幕 / debug 礼物 / debug control / B站真实弹幕 / game-tick / idle
  -> EventBus
  -> GraphAgentRuntime
     - 持久 runtimeMode: "chat" | "game"
     - 持久 gameSession
     - game_tick_loop: GAME_TICK_MS，只有 game mode 时入队 game-tick
     - eventQueue: 300ms 聚合，最多 20 条，同一 Runtime 内串行 graph.invoke
  -> parent_graph: START -> event_router -> chat_subgraph / game_subgraph / control_node / END
  -> chat_subgraph: ingest_event -> should_respond -> agent_llm -> tools -> agent_llm -> finalize_decision
     - chat tools: express, enter_game_mode
  -> game_subgraph:
     START -> preload_game_snapshot -> game_agent_node -> route_after_game_agent
       -> game_toolnode -> route_after_game_tool
       -> evaluate_game_status -> END
     - preload 每轮 deterministic 调 get_game_state / get_available_actions
     - session 首次进入 game mode 时调 health_check
     - game tools: express, get_recent_chat_messages, STS2 MCP tools
     - act 后本轮进入 evaluate_game_status，不再执行第二个关键游戏动作
  -> agent-reply / tool-call / agent-trace
  -> VoiceRuntime + OverlayServer
  -> TTS + OBS overlay voiceQueue + /debug + Live2D/PNG avatar
```

关键目录：

```text
src/main.ts                                  程序入口
src/events/EventBus.ts                       事件总线
src/agent-core/GraphAgentRuntime.ts          LangGraph 智能体运行时、runtimeMode、game_tick_loop
src/agent-core/graph/AgentState.ts           LangGraph state annotations
src/agent-core/graph/createAgentGraph.ts     parent graph + chat_subgraph
src/agent-core/graph/createGameSubgraph.ts   真正的 STS2 game_subgraph
src/agent-core/graph/expressTool.ts          express 工具
src/agent-core/graph/controlTools.ts         enter_game_mode 控制工具
src/agent-core/graph/liveTools.ts            get_recent_chat_messages 工具
src/agent-core/graph/prompts/                game agent prompt / policy
src/agent-core/autoplay/                     旧 AutoplayRunner 路径，保留但非新主路径
src/mcp/                                     通用 stdio MCP client 和 MCP tool -> LangChain tool 桥
scripts/mcp_probe.py                         Python FastMCP 探针 server
scripts/smoke-deepseek-mcp.ts                真实 DeepSeek + MCP smoke test
scripts/smoke-sts2-mcp.ts                    STS2-Agent v0.6.0 MCP smoke test
src/bili-live/                               B站弹幕源、模拟源、禁用源
src/debug/                                   debug 控制状态，目前保存 chat/game mode
src/game-sts2/                               旧 HTTP STS2 状态 client；GamePoller 默认关闭
src/voice/                                   TTS 队列和系统语音
src/obs-overlay/OverlayServer.ts             本地 overlay HTTP/SSE server
public/overlay/                              OBS overlay 前端
public/debug/                                本地调试控制台
live2d/runtime/                              hibiki Live2D runtime 模型资源
```

## Important Decisions
- 智能体框架已经从轻量自研 runtime 迁移到 LangGraph；旧 `src/agent-core/AgentRuntime.ts` 仍在，但入口用的是 `GraphAgentRuntime`。
- live event loop 保持在 LangGraph 外部。`GraphAgentRuntime` 维护内部事件队列，300ms 小批次串行调用 graph，避免同一个 Runtime 并发多个 graph run。
- `GraphAgentRuntime` 维护持久 `runtimeMode: "chat" | "game"` 和 `gameSession`。graph run 完成后会把 `result.mode` / `result.gameSession` 回写 runtime。
- `GraphAgentRuntime` 有 `game_tick_loop`：仅当 `runtimeMode === "game"` 时，每 `GAME_TICK_MS` 入队一个 `game-tick` 事件。
- `createAgentGraph` 当前是 parent graph：`START -> event_router -> chat_subgraph / game_subgraph / control_node / END`。
- `event_router` 优先识别 control 事件；`mode === "game"` 时路由到 `game_subgraph`；否则普通 debug 输入走 `chat_subgraph`。
- `control_node` 支持 debug control 事件和 debug 弹幕命令 `/game`、`/chat`、`/stop`。`/game` 进入 game mode，`/chat` / `/stop` 回到 chat mode 并清理/结束 gameSession。
- `/debug` 顶部 checkbox 语义是“游戏模式”，不是手动接管。`POST /api/debug/control` body 为 `{ "mode": "game" | "chat" }`。
- `AgentState` 保留 `inputEvent`、`inputEvents`、`mode`、`route`、`gameSummary`、`recentDanmaku` 等，同时新增 `gameState`、`availableActions`、`observedAt`、`gameOver`、`gameSession`、`audienceContext`、`lastToolCategory`、`gameActionExecuted`、`lastToolError`。
- `chatInput(state)` 支持批量事件格式化：`[弹幕] user: text`、`[礼物] user 送出 count 个 giftName`、`[系统] message`、`[游戏状态] summary`、`[游戏tick] reason`、`[控制] 切换到 mode`。
- graph 运行日志分两层：后端 `Logger` 输出结构化字段，前端 `/debug` 通过 `agent-trace` 查看 `queue`、`batch`、`router`、`control_node`、`chat-ingest`、`chat-should-respond`、`tool-loop`、`preload_game_snapshot`、`game_agent_node`、`game_toolnode`、`evaluate_game_status`、`mode-transition`、`run-end` 等阶段；不要把完整 DeepSeek `reasoning_content` 发到 overlay trace。
- 当前主模型使用 DeepSeek：`LLM_BASE_URL=https://api.deepseek.com`，`LLM_MODEL=deepseek-chat`。
- 不用 `deepseek-v4-flash` 做工具循环：它在工具回传第二轮曾报 `reasoning_content` 兼容错误。
- DeepSeek 原始消息链必须保留 `reasoning_content` / `tool_calls` / `tool_call_id`。不要把真实请求链路替换成会丢字段的 LangChain message 转换。
- MCP 方案不是 OpenAI Remote MCP；当前路线是本地 stdio MCP client 把 MCP tools 包装成 LangChain tools，再交给 DeepSeek Function Calling。
- STS2 MCP 使用本机发布包 `E:\sts2-ai-agent-v0.6.0-windows`，直接调用包内 `.venv\Scripts\python.exe -m sts2_mcp.server`，不依赖 `uv run`。
- STS2 MCP 默认 guided profile，白名单工具包括 `health_check`、`get_game_state`、`get_available_actions`、`act`、metadata 工具和 wait 工具；`run_console_command` 不启用。
- `act` 是可写动作，只受 `.env` 总开关 `STS2_MCP_ALLOW_ACTIONS=true` 控制。不要再让 `/debug` checkbox、`DebugControl` 或任何“手动接管”状态影响 `act`。
- 当 `STS2_MCP_ALLOW_ACTIONS=false` 或未设置时，`act` 应被拒绝，错误文案应说明：`需要设置 STS2_MCP_ALLOW_ACTIONS=true 才允许操作游戏`。
- 普通聊天 graph 不直接暴露 `act`。chat tools 只应包含 `express` 和 `enter_game_mode`。
- game tools 包含 `express`、`get_recent_chat_messages` 和 STS2 MCP tools。`act` 只应存在于 game tools。
- game_subgraph 每轮先 deterministic preload `get_game_state` / `get_available_actions`；首次进入 game mode 时调一次 `health_check`。
- game agent prompt 必须强调 state-first：基于最新 `gameState` / `availableActions` 决策，只执行 availableActions 中存在的动作，`act` 后本轮结束，不复用旧索引。
- 项目侧不要实现复杂 `act` 参数预校验。不要新增 `gameActionValidation.ts`，不要在本项目重复校验 action 是否存在、索引是否缺失或越界、`card_index` / `option_index` / `target_index` 是否合规。这些交给 STS2 MCP 的 `act`、MCP 错误、prompt 规则和 tool error 恢复路径处理。
- game_toolnode 只保留基础 gate：`.env` 总开关、单轮最多一个 `act`、工具异常捕获和 trace/tool-call 反馈。`act` 失败不能让 Node 崩溃，也不能无限重试。
- `evaluate_game_status` 是 deterministic 节点，只宽松判断 game over / victory；不要因为 `availableActions.length === 0` 就退出 game mode。
- `GamePoller` 默认关闭。新 game agent 的主状态来源是 MCP `get_game_state` / `get_available_actions`，不是旧 HTTP poller。只有 `GAME_POLLING_ENABLED=true` 时才启动旧 HTTP `GamePoller`。
- `AutoplayRunner` 相关代码、测试和工具文件暂时保留，但新主路径不注入 `start_autoplay` / `stop_autoplay`，也不要让新需求依赖 AutoplayRunner。
- `/debug` 和 overlay 调试表单是当前 agent 输入入口。chat mode 下 GraphAgentRuntime 只响应 `raw.source === "debug"` 的 danmaku / gift；game mode 下会把实时 danmaku / gift 也纳入输入队列和 audienceContext。
- `POST /api/debug/gift` 已接入：body 为 `user`、`giftName`、`count`，`count` 限制 1 到 999 的整数，发布 `raw.source=debug` 的 `gift` 事件。
- debug 对话已支持内存中的最近多轮 user/assistant history；普通聊天不会默认注入完整游戏状态，模型需要进入 game mode 后由 game_subgraph 通过 MCP 读取。
- B站第一版只读弹幕，不登录、不自动发弹幕；默认 `MOCK_BILI=false` 且没有 `BILI_ROOM_ID` 时使用 `DisabledLiveSource`，不会产生模拟弹幕。
- STS2 状态 mock 仅在 `--mock` 或显式环境变量开启时使用。
- hibiki Live2D 是 Cubism 3/4 模型：入口是 `hibiki.model3.json`，核心模型是 `hibiki.moc3`。
- 只支持 Cubism 3/4 模型时，前端应加载 `live2dcubismcore.min.js` + `pixi-live2d-display/dist/cubism4.min.js`；不要误用通用 `dist/index.min.js`。
- `pixi-live2d-display/dist/index.min.js` 是同时支持 Cubism 2/4 的通用包；如果使用它，还需要额外加载 Cubism 2 的 `live2d.min.js` 和 Cubism 4 的 `live2dcubismcore.min.js`。
- `pixi-live2d-display` 通过 CDN 或本地脚本加载成功后，`Live2DModel` 应暴露在 `PIXI.live2d.Live2DModel`。
- Live2D runtime loader 优先尝试本地 `/vendor/live2d/` 脚本，再回退 CDN；加载失败自动回退 PNG/占位形象。
- Live2D 动作自带 wav 暂不播放，避免和 TTS 冲突。
- overlay 前端 `public/overlay/main.js` 维护 `voiceQueue`，所有普通 TTS 语音按顺序播放。收到新的 `voice start` 时，如果当前 audio 正在播放则入队，等 `ended` 或 `error` 后再播放下一条；当前阶段没有默认 interrupt。
- `src/voice/TtsEngine.ts` 的 browser streaming 响应写入已清理 backpressure listener，避免 `Promise.race(once(...))` 残留 listener；排查 `MaxListenersExceededWarning` 时优先用 `node --trace-warnings` 定位，不要直接用 `setMaxListeners` 压掉。
- 不要把 `.env` 或 API key 提交；用户曾在聊天中暴露过 key，正式使用前建议轮换。

## Current Status
已完成：

- Node + TypeScript 项目骨架、配置、README。
- B站弹幕真实只读源、显式 mock 源、禁用源封装。
- `/debug` 调试控制台：手动弹幕、debug 礼物、游戏模式切换、固定高度工具流水、游戏状态/回复/语音状态查看。
- Overlay 调试 UI：可选择发送 debug 弹幕或 debug 礼物；快捷按钮只用于弹幕模式。
- STS2 真实 HTTP 状态 client 和显式 mock client；旧 HTTP `GamePoller` 默认关闭。
- LangGraph 智能体核心，支持 parent graph、chat_subgraph、game_subgraph、control_node、工具调用循环和 fallback。
- 真正的 `game_subgraph` 已接入：preload MCP 状态和动作、game agent LLM 决策、game_toolnode 工具分类、act 后评估、game over / victory 回 chat。
- Debug-only 多轮聊天：chat mode 下只响应 debug 弹幕/礼物输入，并保存最近对话上下文。
- 持久 `runtimeMode` 和 `gameSession` 已接入；`/game`、`/chat`、`/stop` 和 debug UI 可切换模式。
- `game_tick_loop` 已接入：game mode 下按 `GAME_TICK_MS` 持续产生 `game-tick`。
- chat/game tools 已分离：chat 不绑定 STS2 MCP tools，也不绑定 Autoplay tools；game tools 绑定 STS2 MCP tools。
- `act` gate 已改为仅检查 `STS2_MCP_ALLOW_ACTIONS=true`。
- AutoplayRunner 长任务执行器仍保留：支持 `steps`、`floors`、`combat`、`until_next_room`，但不参与新 game agent 主路径。
- AutoplayRunner 已改为普通 JSON 决策解析，避免 DeepSeek structured output 兼容问题。
- AutoplayRunner 已接入 `wait_until_actionable` 多轮等待；`end_turn` 后不信任瞬时返回 state，而是重新等待/读取 fresh state，避免敌方回合或动画期间误停。
- AutoplayRunner 已增加动作索引参数校验和映射，能识别 `buy_card` 等 `option_index` 动作，并在索引缺失时优先选择合法的无索引安全动作。注意：这是旧 AutoplayRunner 内部逻辑，不是新 game agent 主路径。
- AutoplayRunner 已增加商店开关防循环路由，关店后优先 `proceed`。
- OverlayServer SSE 写入已增加关闭连接保护，stop 时会注销 EventBus 订阅并清空 clients，避免后台事件写入已结束 response 导致 `ERR_STREAM_WRITE_AFTER_END`。
- GraphAgentRuntime 已增加内部事件队列和结构化运行日志；`/debug` 可通过 agent-trace 观察外部队列、批次、parent graph 路由、聊天子图、游戏子图、工具循环和 run 结束。
- DeepSeek 真实 API + MCP 探针 smoke test 已通过。
- STS2-Agent v0.6.0 MCP smoke test 已通过，曾返回 `mod_version=0.6.0`、`status=ready`。
- MCP 探针验证结果曾成功写入 `mcp_probe.log`，UUID 示例：`bb6c6b94-ba5e-4e88-b80b-7f7b290c970e`。
- 通用 `StdioMcpClient` 和 MCP -> LangChain tool bridge。
- 工具调用会发布 `tool-call` 事件，`/debug` 展示工具名、参数、成功/失败和摘要结果。
- OBS overlay：弹幕、游戏状态、字幕、Live2D/PNG avatar。
- Live2D `hibiki` runtime 静态资源映射：`/assets/live2d/hibiki/hibiki.model3.json`。
- `public/overlay/live2d-runtime-loader.js` 已按 Cubism 3/4 模型调整为加载 `pixi-live2d-display-cubism4.min.js` / `pixi-live2d-display@0.4.0/dist/cubism4.min.js`。
- Live2D adapter：表情、动作、定时口型控制 `PARAM_MOUTH_OPEN_Y`。
- Overlay 前端语音播放队列已接入，避免新的 TTS 抢播并截断上一段语音。
- 测试覆盖：LLM decision normalizer、SpeakPolicy、STS2 normalizer、LangGraph fallback、本地 MCP client/bridge、AutoplayRunner、debug API、source selection、配置解析、TTS engine。

## Open Tasks
按优先级：

1. 真实游戏长时间运行测试：验证 `game_subgraph`、MCP 子进程、game_tick_loop、TTS、overlay/debug 不泄漏资源，尤其关注 `MaxListenersExceededWarning` 是否仍出现。
2. 完善 game agent 的屏幕路由 prompt 和 tool error 恢复策略，尤其是战斗、奖励、选牌、事件、商店购买、药水目标和低血策略。注意不要在项目侧新增复杂 act 参数预校验。
3. 优化 `evaluate_game_status` 的胜利/失败识别，必要时补充更多 STS2 v0.6.0 schema 路径。
4. 梳理旧 AutoplayRunner 是否继续作为 fallback 保留；若不保留，后续可移除旧工具和相关测试。
5. 将 `GamePoller` 的真实状态读取对齐 STS2-Agent v0.6.0 `/state` schema；如果主要依赖 MCP，可继续默认关闭旧 HTTP poller，减少 warning 噪音。
6. 本地化 Live2D runtime 脚本，避免 OBS 机器依赖 CDN；目标路径为 `public/vendor/live2d/pixi.min.js`、`public/vendor/live2d/live2dcubismcore.min.js`、`public/vendor/live2d/pixi-live2d-display-cubism4.min.js`。
7. 改进 Live2D 口型：从定时张合升级到 TTS 音量/播放状态驱动。
8. 完善角色人设、发言策略、直播记忆持久化。
9. 真实 B站房间长时间运行测试，验证断线重连和刷屏节流。
10. 清理旧 `AgentRuntime` 或保留为 fallback，但要避免入口混淆。

## Known Issues / Pitfalls
- `npm run dev` 使用 `tsx`，在某些沙箱/Windows 环境会因 esbuild 子进程 `spawn EPERM` 失败；可先 `npm run build` 后用 `npm run start:mock`。
- Vitest 在沙箱里可能也因 worker/fork `spawn EPERM` 失败，需要按权限放行测试。
- `node dist/src/main.js` 只能占用一个 `127.0.0.1:3080`；如果报 `EADDRINUSE`，通常是已有后台服务，先访问 `/debug` 或停止旧 Node 进程。
- STS2 MCP smoke / runtime 需要启动发布包内 Python 子进程；沙箱环境可能 `spawn EPERM`，需要放行。
- `uv` 在当前机器曾因缓存目录权限失败；STS2 MCP 启动不要走 `uv run`，而是使用发布包 `.venv\Scripts\python.exe -m sts2_mcp.server`。
- Python `pip install mcp` 曾升级用户环境 `starlette` 到 `1.0.0`，并提示与 FastAPI 版本冲突；如果继续做 Python MCP，建议后续改用 venv。
- DeepSeek 余额不足时真实 smoke 会报 `402 Insufficient Balance`。
- `deepseek-v4-flash` 在工具回传时曾报 `The reasoning_content in the thinking mode must be passed back to the API`；当前已改用 `deepseek-chat`。
- Live2D 不显示时，优先检查 runtime 是否加载了 `pixi-live2d-display/dist/cubism4.min.js`，以及 `PIXI.live2d.Live2DModel` 是否存在；hibiki 这类 `model3.json` + `.moc3` 模型不要误用只加载 `dist/index.min.js` 的路线。
- 控制台出现 `talk_open.png` / `talk_closed.png` 404 通常只是 Live2D 初始化失败后进入 PNG fallback 的现象，不代表 Live2D 模型资源本体损坏。
- `package.json` 曾出现重复 `@modelcontextprotocol/sdk`，已清理。
- `live2d/runtime` 是导出的 runtime 资源，不是源 PSD / `.cmo3`，不能深改模型结构。
- 动作文件里带 wav，但 overlay 暂不播放它们。
- 默认没有模拟弹幕和模拟游戏局面；测试对话请打开 `/debug` 手动发送消息。
- `GamePoller` 默认不启动。只有 `GAME_POLLING_ENABLED=true` 时才会读取 `STS2_API_URL`（默认 `http://localhost:15526`）下的 `/state`、`/game-state`、`/api/state`、`/api/game-state`。
- 新 game agent 主状态来源是 MCP；如果旧 HTTP 状态服务没开，不代表 MCP game agent 链路坏了。
- `/debug` 的“游戏模式”只切换 runtime mode，不是动作权限开关。只要 `STS2_MCP_ALLOW_ACTIONS=true`，game agent 的 `act` 不会因为 debug UI 未勾选而被拦截。
- 当 `STS2_MCP_ALLOW_ACTIONS=false` 或未设置时，game agent 的 `act` 会被拒绝，文案应提示需要设置 `STS2_MCP_ALLOW_ACTIONS=true`。
- 普通聊天 graph 不直接暴露 `act`；如果模型没有调用 `enter_game_mode`，或用户没有 `/game` / debug UI 切换，就不会进入持续游戏模式。
- `wait_until_actionable` 不是保证一定等到动作；它可能返回中间态或空 actions。game agent 不要把一次空 actions 当成任务完成或失败。
- `end_turn` 后常进入敌人回合、动画、抽牌、回合切换，短时间空 actions 是正常现象。
- game agent 主路径不要在项目侧重复校验 `buy_card`、`play_card` 等参数。动作参数问题交给 STS2 MCP `act` 返回错误，再由 tool error 恢复路径处理。
- 商店场景容易出现开关循环；优先通过 prompt 和 MCP tool error 恢复改善，不要急着在项目侧写复杂动作参数预校验。
- Overlay/debug SSE 在服务关闭或浏览器断开时可能出现已结束 response；广播前必须检查连接状态，写入失败要移除 client，不要让后台事件崩掉 Node 进程。
- overlay 前端已经有 TTS 播放队列；后续新增语音事件时不要重新引入“新 audio 直接 pause 当前 audio”的抢播逻辑。若实现 interrupt，也必须显式区分 normal 和 interrupt。
- LangGraph `maxToolLoops` 应保持较小；不要为了长任务把它调大。持续运行由 runtime game_tick_loop + game_subgraph 多次 invocation 完成。

## Coding Conventions
- TypeScript ESM，导入本地 TS 模块时使用 `.js` 后缀。
- 保持事件外壳稳定：不要让 LangGraph 直接控制 TTS/overlay，只发布 `agent-reply`、`tool-call`、`agent-trace` 和 avatar/voice 相关事件。
- live event loop、game_tick_loop 和输入队列保持在 `GraphAgentRuntime`，不要把外部长循环塞进 LangGraph；同一个 Runtime 内保持 graph run 串行。
- parent graph 只负责路由，聊天逻辑放在 `createChatSubgraph`，游戏逻辑放在 `createGameSubgraph`。
- chat tools 和 game tools 必须分离。chat 只保留 `express`、`enter_game_mode`；game 使用 `express`、`get_recent_chat_messages`、STS2 MCP tools。
- 不要把 AutoplayRunner 长任务硬塞进聊天工具循环；新主路径不要注入 `start_autoplay` / `stop_autoplay`。
- 工具调用日志通过 `tool-call` 事件发布，主要给 `/debug` 展示；不要把长 JSON 原样无限塞进 UI。
- 运行链路日志通过后端 `Logger` 和前端 `agent-trace` 双通道输出；overlay trace 不应包含完整 DeepSeek `reasoning_content`。
- `AvatarCommand` 是形象层稳定接口，后续换模型也优先改 adapter，不改 agent 输出。
- 工具接入优先走白名单工具；游戏动作必须显式区分只读/可写，普通聊天 graph 不暴露 `act`，game graph 的 `act` 只受 `STS2_MCP_ALLOW_ACTIONS=true` 控制。
- game_subgraph 每轮只允许一个 `act`；act 后进入 `evaluate_game_status`，等待下一次 tick。
- 不要新增 `gameActionValidation.ts`，不要在项目侧重复 STS2 MCP 的动作参数校验。
- 手工编辑文件用 `apply_patch`。
- 不提交 `.env`、日志、临时测试文件、API key。
- 前端 overlay 目前是无打包静态 JS；新增浏览器代码时避免引入需要构建的语法/依赖，除非同时引入构建流程。

## How to Run / Test
安装：

```bash
npm install
python -m pip install mcp
```

配置：

```bash
copy .env.example .env
```

关键配置：

```env
STS2_MCP_ENABLED=true
STS2_MCP_ALLOW_ACTIONS=true
GAME_TICK_MS=2500
GAME_POLLING_ENABLED=false
```

开发/真实默认：

```bash
npm run build
npm run start
```

显式 mock：

```bash
npm run build
npm run start:mock
```

打开：

```text
http://127.0.0.1:3080/overlay
http://127.0.0.1:3080/debug
http://127.0.0.1:3080/health
http://127.0.0.1:3080/assets/live2d/hibiki/hibiki.model3.json
```

测试：

```bash
npm run typecheck
npm test
npm run build
```

真实 DeepSeek + MCP 探针 smoke test：

```bash
npm run smoke:deepseek-mcp
```

该命令会真实调用 DeepSeek API，并启动本地 Python MCP 探针。成功时会打印 `ok: true`、UUID、probeMessage，并在 `mcp_probe.log` 中写入同一个 UUID。

STS2-Agent v0.6.0 MCP smoke test：

```bash
npm run smoke:sts2-mcp
```

该命令会启动发布包 MCP server 并调用 `health_check`。如果游戏/Mod 未运行，会提示先确认 `http://127.0.0.1:8080/health`。

Debug game mode：

```text
/debug 页面勾选“游戏模式”
或发送 debug 弹幕：/game
回聊天模式：/chat
停止游戏模式：/stop
```

OBS：

```text
添加浏览器源 -> http://127.0.0.1:3080/overlay
```
