# AGENTS.md

## Project Overview
这是一个“《杀戮尖塔2》智能体直播陪聊”项目。目标是让一个虚拟主播式智能体监听 B站直播弹幕、读取游戏状态、调用大模型和工具/MCP、用 TTS 说话，并在 OBS overlay 中展示 Live2D/PNG 形象。

当前阶段：直播外壳、debug-only 多轮对话、LangGraph 智能体、DeepSeek 工具调用、STS2-Agent v0.6.0 MCP 接入、AutoplayRunner 长任务执行器、调试控制台、Live2D overlay 适配层都已完成 MVP。智能体可以通过 MCP 读取真实游戏状态和可用动作；普通聊天 graph 不直接暴露 `act`，长任务通过 `start_autoplay` 启动后台 AutoplayRunner，且只有在 `/debug` 手动接管开启后才允许真实操作游戏。

## Tech Stack
- Frontend: 静态 HTML/CSS/JS overlay + debug console，SSE 接收事件，Pixi + Live2D Cubism Core + `pixi-live2d-display/cubism4` 渲染 hibiki Live2D。
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
debug 手动弹幕 / B站真实弹幕 / STS2 真实状态 / idle
  -> EventBus
  -> GraphAgentRuntime（只响应 raw.source=debug 的 danmaku）
  -> LangGraph: should_respond -> agent_llm -> tools -> agent_llm -> finalize_decision
  -> 可选 start_autoplay / stop_autoplay
  -> AutoplayRunner: health_check -> state-first loop -> wait_until_actionable(必要时) -> act -> stop conditions
  -> agent-reply / tool-call
  -> VoiceRuntime + OverlayServer
  -> TTS + OBS overlay + /debug + Live2D/PNG avatar
```

关键目录：

```text
src/main.ts                         程序入口
src/events/EventBus.ts              事件总线
src/agent-core/GraphAgentRuntime.ts LangGraph 智能体运行时
src/agent-core/graph/               LangGraph state / tools / graph
src/agent-core/autoplay/            AutoplayRunner 和 start/stop autoplay tools
src/mcp/                            通用 stdio MCP client 和 MCP tool -> LangChain tool 桥
scripts/mcp_probe.py                Python FastMCP 探针 server
scripts/smoke-deepseek-mcp.ts       真实 DeepSeek + MCP smoke test
scripts/smoke-sts2-mcp.ts           STS2-Agent v0.6.0 MCP smoke test
src/bili-live/                      B站弹幕源、模拟源、禁用源
src/debug/                          手动接管状态
src/game-sts2/                      STS2 状态 client；默认真实 HTTP，mock 仅显式启用
src/voice/                          TTS 队列和系统语音
src/obs-overlay/OverlayServer.ts    本地 overlay HTTP/SSE server
public/overlay/                     OBS overlay 前端
public/debug/                       本地调试控制台
live2d/runtime/                     hibiki Live2D runtime 模型资源
```

## Important Decisions
- 智能体框架已经从轻量自研 runtime 迁移到 LangGraph；旧 `src/agent-core/AgentRuntime.ts` 仍在，但入口用的是 `GraphAgentRuntime`。
- 当前主模型使用 DeepSeek：`LLM_BASE_URL=https://api.deepseek.com`，`LLM_MODEL=deepseek-chat`。
- 不用 `deepseek-v4-flash` 做工具循环：它在工具回传第二轮曾报 `reasoning_content` 兼容错误。
- MCP 方案不是 OpenAI Remote MCP；当前路线是本地 stdio MCP client 把 MCP tools 包装成 LangChain tools，再交给 DeepSeek Function Calling。
- STS2 MCP 使用本机发布包 `E:\sts2-ai-agent-v0.6.0-windows`，直接调用包内 `.venv\Scripts\python.exe -m sts2_mcp.server`，不依赖 `uv run`。
- STS2 MCP 默认 guided profile，白名单工具包括 `health_check`、`get_game_state`、`get_available_actions`、`act`、metadata 工具和 wait 工具；`run_console_command` 不启用。
- `act` 是可写动作，必须同时满足 `STS2_MCP_ALLOW_ACTIONS=true` 和 `/debug` 手动接管开启；普通聊天 graph 不直接暴露 `act`，`act` 主要由 AutoplayRunner 内部调用。
- 连续自动游玩不再依赖 LangGraph 工具循环硬跑；用户明确要求“自动玩/连续打 N 关/打完战斗”等长任务时，应调用 `start_autoplay`，由 AutoplayRunner 后台执行并检查停止条件。
- AutoplayRunner 按 STS2-Agent state-first guided loop 工作：启动时 `health_check` 一次，每步基于最新 `get_game_state`、`get_available_actions` 决策一个动作；没有动作时用 `wait_until_actionable` 多轮等待 fresh state/actions；执行一个 `act` 后重新读/使用最新状态；不要复用旧 index。
- AutoplayRunner 不使用 LangChain `withStructuredOutput`，因为 DeepSeek/OpenAI-compatible 接口曾因 `response_format: json_schema` 报 `400 This response_format type is unavailable now`；当前用普通 `model.invoke` 要求 JSON，再手动 `JSON.parse` + Zod 校验。
- AutoplayRunner 暂时不主动调用 `get_relevant_game_data`，除非能从当前 state 精确提取 `collection` 和 `item_ids`；不要再用 `{}` 调它，否则会触发 schema 错误。
- AutoplayRunner 的 `act` 参数必须按动作类型映射：`play_card` 用 `card_index`；地图、奖励、商店、事件、休息、选牌、药水等动作使用 `option_index`；`target_index` 只在当前 state/action 明确需要目标时填写。模型给通用 `index` 时可映射到正确字段，但不能把缺失索引的动作直接发给 MCP。
- AutoplayRunner 已加入商店防循环：如果刚执行 `close_shop_inventory` 且当前 `proceed` 合法，应直接 `proceed` 离开商店，避免 `open_shop_inventory` / `close_shop_inventory` 循环。
- `/debug` 是当前 agent 唯一输入入口：GraphAgentRuntime 只响应 `raw.source === "debug"` 的 `danmaku`；B站真实/模拟弹幕、礼物、live-system、game-state 可继续进入 overlay/debug，但不触发 agent 对话。
- debug 对话已支持内存中的最近多轮 user/assistant history；普通聊天不会默认注入完整游戏状态，模型需要时通过工具读取。
- B站第一版只读弹幕，不登录、不自动发弹幕；默认 `MOCK_BILI=false` 且没有 `BILI_ROOM_ID` 时使用 `DisabledLiveSource`，不会产生模拟弹幕。
- STS2 状态轮询默认 `MOCK_STS2=false`，不再生成模拟游戏局面；mock 仅在 `--mock` 或显式环境变量开启时使用。
- `/debug` 是当前主要测试入口，可手动发送弹幕、切换手动接管、查看 agent 回复、游戏状态和工具流水。
- hibiki Live2D 是 Cubism 3/4 模型：入口是 `hibiki.model3.json`，核心模型是 `hibiki.moc3`。
- 只支持 Cubism 3/4 模型时，前端应加载 `live2dcubismcore.min.js` + `pixi-live2d-display/dist/cubism4.min.js`；不要误用通用 `dist/index.min.js`。
- `pixi-live2d-display/dist/index.min.js` 是同时支持 Cubism 2/4 的通用包；如果使用它，还需要额外加载 Cubism 2 的 `live2d.min.js` 和 Cubism 4 的 `live2dcubismcore.min.js`。
- `pixi-live2d-display` 通过 CDN 或本地脚本加载成功后，`Live2DModel` 应暴露在 `PIXI.live2d.Live2DModel`。
- Live2D runtime loader 优先尝试本地 `/vendor/live2d/` 脚本，再回退 CDN；加载失败自动回退 PNG/占位形象。
- Live2D 动作自带 wav 暂不播放，避免和 TTS 冲突。
- 不要把 `.env` 或 API key 提交；用户曾在聊天中暴露过 key，正式使用前建议轮换。

## Current Status
已完成：

- Node + TypeScript 项目骨架、配置、README。
- B站弹幕真实只读源、显式 mock 源、禁用源封装。
- `/debug` 调试控制台：手动弹幕、手动接管开关、固定高度工具流水、游戏状态/回复/语音状态查看。
- STS2 真实 HTTP 状态 client 和显式 mock client。
- LangGraph 智能体核心，支持工具调用循环和 fallback。
- Debug-only 多轮对话：只响应 `/debug` 输入，并保存最近对话上下文。
- AutoplayRunner 长任务执行器：支持 `steps`、`floors`、`combat`、`until_next_room`，并通过 `start_autoplay` / `stop_autoplay` 工具接入。
- AutoplayRunner 已改为普通 JSON 决策解析，避免 DeepSeek structured output 兼容问题。
- AutoplayRunner 已接入 `wait_until_actionable` 多轮等待；`end_turn` 后不信任瞬时返回 state，而是重新等待/读取 fresh state，避免敌方回合或动画期间误停。
- AutoplayRunner 已增加动作索引参数校验和映射，能识别 `buy_card` 等 `option_index` 动作，并在索引缺失时优先选择合法的无索引安全动作。
- AutoplayRunner 已增加商店开关防循环路由，关店后优先 `proceed`。
- OverlayServer SSE 写入已增加关闭连接保护，stop 时会注销 EventBus 订阅并清空 clients，避免后台事件写入已结束 response 导致 `ERR_STREAM_WRITE_AFTER_END`。
- DeepSeek 真实 API + MCP 探针 smoke test 已通过。
- STS2-Agent v0.6.0 MCP smoke test 已通过，曾返回 `mod_version=0.6.0`、`status=ready`。
- MCP 探针验证结果曾成功写入 `mcp_probe.log`，UUID 示例：`bb6c6b94-ba5e-4e88-b80b-7f7b290c970e`。
- 通用 `StdioMcpClient` 和 MCP -> LangChain tool bridge。
- 工具调用会发布 `tool-call` 事件，`/debug` 展示工具名、参数、成功/失败和摘要结果。
- OBS overlay：弹幕、游戏状态、字幕、Live2D/PNG avatar。
- Live2D `hibiki` runtime 静态资源映射：`/assets/live2d/hibiki/hibiki.model3.json`。
- `public/overlay/live2d-runtime-loader.js` 已按 Cubism 3/4 模型调整为加载 `pixi-live2d-display-cubism4.min.js` / `pixi-live2d-display@0.4.0/dist/cubism4.min.js`。
- Live2D adapter：表情、动作、定时口型控制 `PARAM_MOUTH_OPEN_Y`。
- 测试覆盖：LLM decision normalizer、SpeakPolicy、STS2 normalizer、LangGraph fallback、本地 MCP client/bridge、AutoplayRunner、debug API、source selection、配置解析。

## Open Tasks
按优先级：

1. 真实游戏长时间运行测试：验证 AutoplayRunner、MCP 子进程、状态轮询、TTS、overlay/debug 不泄漏资源，尤其关注 `MaxListenersExceededWarning` 是否仍出现。
2. 完善 AutoplayRunner 的屏幕路由和动作参数策略，尤其是战斗、奖励、选牌、事件、商店购买索引、药水目标和低血策略。
3. 将 `GamePoller` 的真实状态读取对齐 STS2-Agent v0.6.0 `/state` schema，减少和 MCP `get_game_state` 的重复/不一致。
4. 本地化 Live2D runtime 脚本，避免 OBS 机器依赖 CDN；目标路径为 `public/vendor/live2d/pixi.min.js`、`public/vendor/live2d/live2dcubismcore.min.js`、`public/vendor/live2d/pixi-live2d-display-cubism4.min.js`。
5. 改进 Live2D 口型：从定时张合升级到 TTS 音量/播放状态驱动。
6. 完善角色人设、发言策略、直播记忆持久化。
7. 真实 B站房间长时间运行测试，验证断线重连和刷屏节流。
8. 清理旧 `AgentRuntime` 或保留为 fallback，但要避免入口混淆。

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
- `/debug` 的“手动接管”关闭时，智能体只读讲解；打开后才允许 AutoplayRunner 内部 `act` 真操作游戏。
- 普通聊天 graph 不直接暴露 `act`；如果模型没有调用 `start_autoplay`，不会进入后台连续游玩。
- `start_autoplay` 需要 STS2 MCP 已连接且 `STS2_MCP_ALLOW_ACTIONS=true` 与 `/debug` 手动接管同时开启，否则会报动作权限关闭。
- AutoplayRunner 目前按楼层/房间理解“往后打 N 关”，并采用尽量执行策略；商店、选牌、事件、低血等不会默认保守暂停，除非达到硬停止、连续失败、权限关闭或游戏结束。
- `wait_until_actionable` 不是保证一定等到动作；它可能返回中间态或空 actions。AutoplayRunner 需要把空 actions 当作 transient，多轮等待/重读，只有连续等待仍为空才停止。
- `end_turn` 后常进入敌人回合、动画、抽牌、回合切换，短时间空 actions 是正常现象；不要把一次空 actions 当成任务完成或失败。
- `buy_card`、`buy_relic`、`buy_potion`、`choose_map_node`、奖励/事件/休息/选牌等动作需要 `option_index`；`play_card` 需要 `card_index`。缺参数应先本地校验或选择合法 fallback，不要把不完整 `{ action }` 连续发给 MCP。
- 商店场景容易出现开关循环：`close_shop_inventory` 后如果 `proceed` 合法，应离开商店，不要再次 `open_shop_inventory`。
- Overlay/debug SSE 在服务关闭或浏览器断开时可能出现已结束 response；广播前必须检查连接状态，写入失败要移除 client，不要让后台 autoplay 事件崩掉 Node 进程。
- LangGraph `maxToolLoops` 应保持较小；不要为了长任务把它调大。长任务应走 `start_autoplay`，避免 `GraphRecursionError`。

## Coding Conventions
- TypeScript ESM，导入本地 TS 模块时使用 `.js` 后缀。
- 保持事件外壳稳定：不要让 LangGraph 直接控制 TTS/overlay，只发布 `agent-reply` 和 `avatar` 事件。
- 工具调用日志通过 `tool-call` 事件发布，主要给 `/debug` 展示；不要把长 JSON 原样无限塞进 UI。
- `AvatarCommand` 是形象层稳定接口，后续换模型也优先改 adapter，不改 agent 输出。
- 工具接入优先走白名单工具；游戏动作必须显式区分只读/可写，普通聊天 graph 不暴露 `act`，长任务通过 `start_autoplay` 进入 AutoplayRunner，`act` 必须受手动接管闸门保护。
- AutoplayRunner 每步只做一个动作；每次动作前基于最新 state/actions 决策，不要复用旧 hand/reward/map/event index。
- AutoplayRunner 的屏幕路由/防循环/参数补全应尽量在 runner 内完成，不要依赖聊天 graph 多轮纠错；长任务期间聊天 graph 只负责启动/停止和讲解。
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

OBS：

```text
添加浏览器源 -> http://127.0.0.1:3080/overlay
```
