# STS2 Live Agent MVP

一个轻量事件驱动的《杀戮尖塔2》直播陪聊智能体原型：监听 B站弹幕、读取 STS2 状态、调用大模型生成结构化回复、播放本地 TTS，并驱动 OBS 浏览器源中的 PNG/Live2D 风格形象。

## Quick Start

```powershell
npm install
Copy-Item .env.example .env
npm run dev:mock
```

默认 `.env.example` 使用模拟弹幕和模拟 STS2 状态。启动后打开：

- Overlay: http://127.0.0.1:3080/overlay
- Health: http://127.0.0.1:3080/health
- Event Stream: http://127.0.0.1:3080/api/events

OBS 中添加“浏览器源”，地址填 `http://127.0.0.1:3080/overlay`，背景会保持透明。

## Connect Real B站 Danmaku

在 `.env` 中设置：

```env
MOCK_BILI=false
BILI_ROOM_ID=你的直播间房间号
```

本项目只读监听弹幕，不登录、不发弹幕。

## Connect Real STS2

在 `.env` 中设置：

```env
MOCK_STS2=false
STS2_API_URL=http://localhost:15526
```

当前适配器会依次尝试这些只读状态接口：

- `GET /state`
- `GET /game-state`
- `GET /api/state`
- `GET /api/game-state`

如果所用 STS2 Mod/MCP 桥接地址不同，在 `src/game-sts2/Sts2Client.ts` 里扩展候选路径即可。

## Avatar Assets

把透明 PNG 放到：

```text
public/assets/avatar/
```

推荐文件名：

- `idle.png`
- `talk_open.png`
- `talk_closed.png`
- `happy.png`
- `thinking.png`
- `surprised.png`
- `focus.png`
- `awkward.png`
- `wave.png`
- `panic.png`

没有素材时 overlay 会显示 CSS 占位形象，方便先调通链路。

## Live2D Overlay

当前 overlay 会优先尝试加载已有 Live2D 模型：

```text
/assets/live2d/hibiki/hibiki.model3.json
```

它映射到本地目录：

```text
live2d/runtime/
```

加载成功后，overlay 会用 Live2D canvas 显示角色，并把 `AvatarCommand` 翻译成表情、动作和嘴型控制。加载失败时会自动回退到 PNG/占位形象，不影响弹幕、字幕和 TTS。

第一版 Live2D 适配使用 CDN 加载 Pixi、Cubism Core 和 `pixi-live2d-display`，OBS 机器需要能访问这些脚本；后续如果要完全离线直播，可以把这些 runtime 脚本下载到本地并改成 `/vendor/...` 路径。

## Agent Output Shape

大模型应输出 JSON：

```json
{
  "say": "这波我感觉要冷静一点。",
  "emotion": "thinking",
  "avatarAction": "think",
  "shouldSpeak": true,
  "gameIntent": "explain_state"
}
```

如果没有配置 `LLM_API_KEY`，系统会使用本地规则回复，方便离线调试。DeepSeek 工具调用建议使用 `LLM_MODEL=deepseek-chat`，这是官方文档中用于非思考模式工具调用的模型。

如果当前环境不允许 `tsx` 启动 esbuild 子进程，可以改用编译后运行：

```powershell
npm run build
npm run start:mock
```
