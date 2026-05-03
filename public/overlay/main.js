import { Live2DAvatarAdapter } from "/overlay/live2d-adapter.js";

const avatarImage = document.getElementById("avatarImage");
const avatarWrap = document.getElementById("avatarWrap");
const fallbackMouth = document.getElementById("fallbackMouth");
const live2dCanvas = document.getElementById("live2dCanvas");
const speech = document.getElementById("speech");
const speaker = document.getElementById("speaker");
const gameSummary = document.getElementById("gameSummary");
const danmakuList = document.getElementById("danmakuList");

const emotionFiles = {
  neutral: "idle.png",
  happy: "happy.png",
  thinking: "thinking.png",
  surprised: "surprised.png",
  focus: "focus.png",
  awkward: "awkward.png"
};

let speaking = false;
let mouthTimer = null;
let currentEmotion = "neutral";
let live2dAdapter = null;
let live2dReady = false;

connectEvents();
initLive2D();
setAvatar({ emotion: "neutral", action: "idle", speaking: false });

function connectEvents() {
  const source = new EventSource("/api/events");
  source.addEventListener("danmaku", (message) => {
    const event = JSON.parse(message.data);
    addDanmaku(event.user, event.text);
  });
  source.addEventListener("gift", (message) => {
    const event = JSON.parse(message.data);
    addDanmaku(event.user, `送出了 ${event.count} 个 ${event.giftName}`);
  });
  source.addEventListener("game-state", (message) => {
    const event = JSON.parse(message.data);
    gameSummary.textContent = event.state.summary || "游戏状态已更新";
  });
  source.addEventListener("agent-reply", (message) => {
    const event = JSON.parse(message.data);
    speaker.textContent = "塔塔";
    speech.textContent = event.decision.say;
  });
  source.addEventListener("avatar", (message) => {
    const event = JSON.parse(message.data);
    setAvatar(event.command);
  });
  source.addEventListener("voice", (message) => {
    const event = JSON.parse(message.data);
    if (event.status === "error") {
      console.warn("TTS error", event.error);
    }
  });
}

function addDanmaku(user, text) {
  const row = document.createElement("div");
  row.className = "danmaku";
  const safeUser = document.createElement("strong");
  safeUser.textContent = `${user}: `;
  row.appendChild(safeUser);
  row.append(document.createTextNode(text));
  danmakuList.appendChild(row);
  while (danmakuList.children.length > 6) {
    danmakuList.removeChild(danmakuList.firstChild);
  }
}

function setAvatar(command) {
  currentEmotion = command.emotion || currentEmotion;
  speaking = Boolean(command.speaking);
  avatarWrap.className = `avatar-wrap ${command.action || "idle"}${live2dReady ? " live2d-ready" : ""}`;
  avatarWrap.classList.toggle("live2d-ready", live2dReady);
  if (command.text) speech.textContent = command.text;
  live2dAdapter?.apply(command);
  if (!live2dReady) loadAvatarImage(currentEmotion, speaking);
  updateMouthLoop();
}

async function initLive2D() {
  try {
    live2dAdapter = new Live2DAvatarAdapter({
      canvas: live2dCanvas,
      container: avatarWrap
    });
    await live2dAdapter.init();
    live2dReady = true;
    avatarWrap.classList.add("live2d-ready");
    live2dAdapter.apply({ emotion: currentEmotion, action: "idle", speaking });
    stopFallbackMouthLoop();
  } catch (error) {
    live2dReady = false;
    avatarWrap.classList.remove("live2d-ready");
    console.warn("Live2D unavailable, using PNG fallback", error);
  }
}

function loadAvatarImage(emotion, isSpeaking) {
  const file = isSpeaking ? "talk_open.png" : emotionFiles[emotion] || "idle.png";
  const src = `/assets/avatar/${file}`;
  if (avatarImage.dataset.src === src) return;
  avatarImage.dataset.src = src;
  avatarImage.classList.remove("loaded");
  avatarImage.onload = () => avatarImage.classList.add("loaded");
  avatarImage.onerror = () => avatarImage.classList.remove("loaded");
  avatarImage.src = src;
}

function updateMouthLoop() {
  if (live2dReady) {
    stopFallbackMouthLoop();
    return;
  }
  startFallbackMouthLoop();
}

function startFallbackMouthLoop() {
  if (mouthTimer) {
    clearInterval(mouthTimer);
    mouthTimer = null;
  }
  fallbackMouth.classList.toggle("open", speaking);
  if (!speaking) {
    loadAvatarImage(currentEmotion, false);
    return;
  }
  mouthTimer = setInterval(() => {
    const open = fallbackMouth.classList.toggle("open");
    avatarImage.src = `/assets/avatar/${open ? "talk_open.png" : "talk_closed.png"}`;
  }, 160);
}

function stopFallbackMouthLoop() {
  if (mouthTimer) {
    clearInterval(mouthTimer);
    mouthTimer = null;
  }
  fallbackMouth.classList.remove("open");
}
