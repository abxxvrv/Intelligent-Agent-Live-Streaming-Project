const connectionState = document.getElementById("connectionState");
const autoplayToggle = document.getElementById("autoplayToggle");
const composer = document.getElementById("composer");
const userInput = document.getElementById("userInput");
const messageInput = document.getElementById("messageInput");
const feed = document.getElementById("feed");
const traceList = document.getElementById("traceList");
const toolList = document.getElementById("toolList");
const gameSummary = document.getElementById("gameSummary");
const lastVoice = document.getElementById("lastVoice");
const clearTools = document.getElementById("clearTools");

const feedItems = [];
const traceItems = [];
const toolItems = [];
const seenEvents = new Set();

await loadInitialState();
connectEvents();

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  await postJson("/api/debug/danmaku", {
    user: userInput.value.trim() || "调试员",
    text
  });
  messageInput.value = "";
  messageInput.focus();
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    composer.requestSubmit();
  }
});

document.querySelectorAll("[data-message]").forEach((button) => {
  button.addEventListener("click", () => {
    messageInput.value = button.dataset.message || "";
    composer.requestSubmit();
  });
});

autoplayToggle.addEventListener("change", async () => {
  const result = await postJson("/api/debug/control", {
    autoplayEnabled: autoplayToggle.checked
  });
  autoplayToggle.checked = Boolean(result.autoplayEnabled);
  renderConnectionState();
});

clearTools.addEventListener("click", () => {
  toolItems.length = 0;
  renderTools();
});

async function loadInitialState() {
  const state = await fetchJson("/api/debug/state");
  autoplayToggle.checked = Boolean(state.autoplayEnabled);
  for (const event of state.events || []) {
    applyEvent(event);
  }
  renderConnectionState();
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    connectionState.textContent = "SSE 已连接";
  });
  source.addEventListener("error", () => {
    connectionState.textContent = "SSE 重连中";
  });

  for (const type of [
    "danmaku",
    "gift",
    "game-state",
    "agent-reply",
    "agent-trace",
    "voice",
    "tool-call",
    "debug-control",
    "live-system"
  ]) {
    source.addEventListener(type, (message) => {
      applyEvent(JSON.parse(message.data));
    });
  }
}

function applyEvent(event) {
  if (event.id && seenEvents.has(event.id)) return;
  if (event.id) seenEvents.add(event.id);

  if (event.type === "danmaku") {
    pushFeed("弹幕", `${event.user}: ${event.text}`);
  } else if (event.type === "gift") {
    pushFeed("礼物", `${event.user}: ${event.giftName} x${event.count}`);
  } else if (event.type === "agent-reply") {
    pushFeed("塔塔", event.decision?.say || "", "reply");
  } else if (event.type === "agent-trace") {
    pushTrace(event);
  } else if (event.type === "game-state") {
    gameSummary.textContent = event.state?.summary || "游戏状态已更新";
  } else if (event.type === "voice") {
    lastVoice.textContent =
      event.status === "error" ? `语音错误：${event.error || ""}` : `语音 ${event.status}`;
  } else if (event.type === "tool-call") {
    pushTool(event);
  } else if (event.type === "debug-control") {
    autoplayToggle.checked = Boolean(event.autoplayEnabled);
    pushFeed("控制", event.autoplayEnabled ? "手动接管已开启" : "手动接管已关闭");
    renderConnectionState();
  } else if (event.type === "live-system") {
    pushFeed("系统", event.message || "");
  }
}

function pushFeed(label, text, variant = "") {
  feedItems.push({
    label,
    text,
    variant,
    time: formatTime(Date.now())
  });
  while (feedItems.length > 80) feedItems.shift();
  renderFeed();
}

function pushTrace(event) {
  traceItems.push({
    runId: event.runId,
    stage: event.stage,
    title: event.title || event.stage,
    text: event.message || "",
    status: event.status || "",
    toolName: event.toolName || "",
    time: formatTime(event.ts || Date.now())
  });
  while (traceItems.length > 160) traceItems.shift();
  renderTrace();
}

function pushTool(event) {
  if (event.status === "start") {
    toolItems.push({
      id: event.id,
      name: event.name,
      status: event.status,
      text: formatArgs(event.args),
      time: formatTime(event.ts || Date.now())
    });
  } else {
    const text = event.status === "error" ? event.error || "工具失败" : event.resultSummary || "工具成功";
    toolItems.push({
      id: event.id,
      name: event.name,
      status: event.status,
      text,
      time: formatTime(event.ts || Date.now())
    });
  }
  while (toolItems.length > 120) toolItems.shift();
  renderTools();
}

function renderFeed() {
  feed.replaceChildren(...feedItems.map(renderFeedItem));
  feed.scrollTop = feed.scrollHeight;
}

function renderTrace() {
  traceList.replaceChildren(...traceItems.map(renderTraceItem));
  traceList.scrollTop = traceList.scrollHeight;
}

function renderTools() {
  toolList.replaceChildren(...toolItems.map(renderToolItem));
  toolList.scrollTop = toolList.scrollHeight;
}

function renderFeedItem(item) {
  const row = document.createElement("article");
  row.className = "feed-item";
  row.append(meta(item.variant ? `${item.label}` : item.label, item.time, item.variant));
  const text = document.createElement("div");
  text.className = "feed-text";
  text.textContent = item.text;
  row.append(text);
  return row;
}

function renderTraceItem(item, index) {
  const row = document.createElement("article");
  row.className = "trace-item";
  const previous = traceItems[index - 1];
  if (!previous || previous.runId !== item.runId) {
    const group = document.createElement("div");
    group.className = "trace-run";
    group.textContent = `run ${shortRunId(item.runId)}`;
    row.append(group);
  }
  const variant = item.status ? `trace-${item.status}` : `trace-${item.stage}`;
  row.append(meta(stageLabel(item), item.time, variant));
  const text = document.createElement("div");
  text.className = "trace-text";
  text.textContent = item.text;
  row.append(text);
  return row;
}

function renderToolItem(item) {
  const row = document.createElement("article");
  row.className = "tool-item";
  row.append(meta(item.name, `${item.time} · ${item.status}`, `tool-${item.status}`));
  const text = document.createElement("div");
  text.className = "tool-text";
  text.textContent = item.text;
  row.append(text);
  return row;
}

function meta(label, time, variant = "") {
  const wrap = document.createElement("div");
  wrap.className = "meta";
  const badge = document.createElement("span");
  badge.className = `badge ${variant}`;
  badge.textContent = label;
  const clock = document.createElement("span");
  clock.textContent = time;
  wrap.append(badge, clock);
  return wrap;
}

function renderConnectionState() {
  const mode = autoplayToggle.checked ? "手动接管开启" : "只读讲解";
  connectionState.textContent = `${connectionState.textContent.split(" · ")[0] || "SSE"} · ${mode}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }
  return result;
}

function formatArgs(args) {
  if (!args || Object.keys(args).length === 0) return "无参数";
  const text = JSON.stringify(args);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function stageLabel(item) {
  if (item.toolName) return `${item.title} · ${item.toolName}`;
  return item.title;
}

function shortRunId(runId) {
  return String(runId || "").replace(/^run_/, "").slice(0, 10) || "unknown";
}
