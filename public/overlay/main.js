import { Live2DAvatarAdapter } from "/overlay/live2d-adapter.js";

const avatarImage = document.getElementById("avatarImage");
const avatarWrap = document.getElementById("avatarWrap");
const fallbackMouth = document.getElementById("fallbackMouth");
const live2dCanvas = document.getElementById("live2dCanvas");
const speech = document.getElementById("speech");
const speechJa = document.getElementById("speechJa");
const speechZh = document.getElementById("speechZh");
const speaker = document.getElementById("speaker");
const gameSummary = document.getElementById("gameSummary");
const danmakuList = document.getElementById("danmakuList");
const overlayComposer = document.getElementById("overlayComposer");
const overlayEventType = document.getElementById("overlayEventType");
const overlayUserInput = document.getElementById("overlayUserInput");
const overlayMessageField = document.getElementById("overlayMessageField");
const overlayMessageInput = document.getElementById("overlayMessageInput");
const overlayGiftFields = document.getElementById("overlayGiftFields");
const overlayGiftNameInput = document.getElementById("overlayGiftNameInput");
const overlayGiftCountInput = document.getElementById("overlayGiftCountInput");

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
let subtitleClearTimer = null;
let currentAudio = null;
let subtitleTypeTimer = null;
const voiceQueue = [];
let voicePlaying = false;

connectEvents();
connectComposer();
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
    // Subtitles are revealed when the voice stream actually starts playing.
  });
  source.addEventListener("avatar", (message) => {
    const event = JSON.parse(message.data);
    setAvatar(event.command);
  });
  source.addEventListener("voice", (message) => {
    const event = JSON.parse(message.data);
    if (event.status === "start") {
      if (event.audioUrl) {
        enqueueVoice(event);
      } else {
        enqueueVoice({
          ...event,
          audioUrl: "",
          simulatedDurationMs: estimateVoiceDurationMs(event.text || event.subtitleJa || "")
        });
      }
      return;
    }

    if (event.status === "end" || event.status === "error") {
      if (!event.audioUrl && !voicePlaying) {
        scheduleSubtitleClear();
      }
    }

    if (event.status === "error") {
      console.warn("TTS error", event.error);
    }
  });
}

function enqueueVoice(event) {
  voiceQueue.push({
    ...event,
    queuedAt: Date.now(),
    interrupt: false
  });
  console.info("voice queued", {
    id: event.id,
    audioUrl: event.audioUrl || "",
    queueLength: voiceQueue.length,
    currentlyPlaying: voicePlaying
  });
  logVoiceQueueLength();
  playNextVoice();
}

function playNextVoice() {
  if (voicePlaying) return;
  const next = voiceQueue.shift();
  if (!next) {
    logVoiceQueueLength();
    return;
  }

  voicePlaying = true;
  console.info("voice playback started", {
    id: next.id,
    audioUrl: next.audioUrl || "",
    queueLength: voiceQueue.length
  });
  logVoiceQueueLength();

  if (next.audioUrl) {
    playQueuedVoiceStream(next);
  } else {
    playQueuedVoiceSimulation(next);
  }
}

function finishCurrentVoice(event, status, error) {
  if (error) {
    console.warn("voice playback error", {
      id: event.id,
      error,
      queueLength: voiceQueue.length
    });
  } else {
    console.info("voice playback ended", {
      id: event.id,
      status,
      queueLength: voiceQueue.length
    });
  }

  voicePlaying = false;
  currentAudio = null;
  setAvatar({
    emotion: event.emotion || currentEmotion,
    action: "idle",
    speaking: false
  });
  scheduleSubtitleClear();
  logVoiceQueueLength();
  playNextVoice();
}

function logVoiceQueueLength() {
  console.info("voice queue length", {
    queueLength: voiceQueue.length,
    playing: voicePlaying
  });
}

function playQueuedVoiceSimulation(event) {
  const ja = event.subtitleJa || event.text || "";
  const zh = event.subtitleZh || "";

  if (subtitleClearTimer) {
    clearTimeout(subtitleClearTimer);
    subtitleClearTimer = null;
  }
  setAvatar({
    emotion: event.emotion || currentEmotion,
    action: "talk",
    speaking: true
  });
  setSpeechText({
          ja: event.subtitleJa || event.text || "",
          zh: event.subtitleZh || ""
  });
  const durationMs = event.simulatedDurationMs || estimateVoiceDurationMs(ja);
  setTimeout(() => {
    finishCurrentVoice(event, "ended");
  }, durationMs);
}

function connectComposer() {
  overlayEventType.addEventListener("change", updateComposerMode);
  updateComposerMode();

  overlayComposer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const eventType = overlayEventType.value;
    const text = overlayMessageInput.value.trim();
    const giftName = overlayGiftNameInput.value.trim();
    const count = Number(overlayGiftCountInput.value);
    if (eventType === "danmaku" && !text) return;
    if (eventType === "gift" && (!giftName || !Number.isInteger(count))) return;

    const sendButton = overlayComposer.querySelector(".overlay-send-button");
    sendButton.disabled = true;
    try {
      if (eventType === "gift") {
        await postJson("/api/debug/gift", {
          user: overlayUserInput.value.trim() || "调试员",
          giftName,
          count
        });
        overlayGiftNameInput.focus();
      } else {
        await postJson("/api/debug/danmaku", {
          user: overlayUserInput.value.trim() || "调试员",
          text
        });
        overlayMessageInput.value = "";
        overlayMessageInput.focus();
      }
    } catch (error) {
      console.warn("Overlay debug event failed", error);
    } finally {
      sendButton.disabled = false;
    }
  });

  overlayMessageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      overlayComposer.requestSubmit();
    }
  });

  overlayComposer.querySelectorAll("[data-message]").forEach((button) => {
    button.addEventListener("click", () => {
      overlayEventType.value = "danmaku";
      updateComposerMode();
      overlayMessageInput.value = button.dataset.message || "";
      overlayComposer.requestSubmit();
    });
  });
}

function updateComposerMode() {
  const isGift = overlayEventType.value === "gift";
  overlayMessageField.hidden = isGift;
  overlayGiftFields.hidden = !isGift;
  overlayComposer.classList.toggle("gift-mode", isGift);
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
  const hasSubtitle = "subtitleJa" in command || "subtitleZh" in command || "text" in command;
  if (hasSubtitle) {
    const ja = command.subtitleJa || command.text || "";
    const zh = command.subtitleZh || "";
    if (command.speaking || ja || zh) {
      setSpeechText({ ja, zh });
    } else {
      scheduleSubtitleClear();
    }
  }
  live2dAdapter?.apply(command);
  if (!live2dReady) loadAvatarImage(currentEmotion, speaking);
  updateMouthLoop();
}

function setSpeechText({ ja, zh }) {
  if (subtitleClearTimer) {
    clearTimeout(subtitleClearTimer);
    subtitleClearTimer = null;
  }
  clearSubtitleTypewriter();
  speechJa.textContent = ja || "";
  speechZh.textContent = zh || "";
}

function scheduleSubtitleClear() {
  if (subtitleClearTimer) clearTimeout(subtitleClearTimer);
  subtitleClearTimer = setTimeout(() => {
    clearSubtitleTypewriter();
    speechJa.textContent = "";
    speechZh.textContent = "";
    subtitleClearTimer = null;
  }, 3000);
}

function clearSubtitleTypewriter() {
  if (subtitleTypeTimer) {
    clearInterval(subtitleTypeTimer);
    subtitleTypeTimer = null;
  }
}

function startTypewriterSubtitle({ ja, zh }) {
  clearSubtitleTypewriter();

  const fullJa = ja || "";
  const fullZh = zh || "";

  speechJa.textContent = "";
  speechZh.textContent = "";

  const maxLen = Math.max(fullJa.length, fullZh.length);
  if (!maxLen) return;

  let i = 0;
  const intervalMs = maxLen > 60 ? 45 : maxLen > 30 ? 65 : 85;

  subtitleTypeTimer = setInterval(() => {
    i += 1;
    speechJa.textContent = fullJa.slice(0, i);
    speechZh.textContent = fullZh.slice(0, i);

    if (i >= maxLen) {
      clearSubtitleTypewriter();
    }
  }, intervalMs);
}

function finishTypewriterSubtitle({ ja, zh }) {
  clearSubtitleTypewriter();
  speechJa.textContent = ja || "";
  speechZh.textContent = zh || "";
}

function estimateVoiceDurationMs(text) {
  return Math.max(800, Math.min(8000, String(text || "").length * 180));
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error || "unknown error");
}

function playQueuedVoiceStream(event) {
  const ja = event.subtitleJa || event.text || "";
  const zh = event.subtitleZh || "";

  if (subtitleClearTimer) {
    clearTimeout(subtitleClearTimer);
    subtitleClearTimer = null;
  }
  clearSubtitleTypewriter();
  speechJa.textContent = "";
  speechZh.textContent = "";

  const audio = new Audio(event.audioUrl);
  currentAudio = audio;
  audio.preload = "auto";
  let settled = false;

  const settle = (status, error) => {
    if (settled) return;
    settled = true;
    finishTypewriterSubtitle({ ja, zh });
    finishCurrentVoice(event, status, error);
  };

  audio.addEventListener("playing", () => {
    setAvatar({
      emotion: event.emotion || currentEmotion,
      action: "talk",
      speaking: true
    });
    startTypewriterSubtitle({ ja, zh });
  }, { once: true });

  audio.addEventListener("ended", () => {
    settle("ended");
  }, { once: true });

  audio.addEventListener("error", () => {
    settle("error", formatError(audio.error || "audio error"));
  }, { once: true });

  audio.play().catch((error) => {
    settle("error", formatError(error));
  });
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
