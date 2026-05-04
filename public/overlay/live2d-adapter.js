const MODEL_URL = "/assets/live2d/hibiki/hibiki.model3.json";
const MOUTH_PARAM_ID = "PARAM_MOUTH_OPEN_Y";

const expressionMap = {
  neutral: "Normal",
  happy: "f01",
  thinking: "Normal",
  surprised: "Surprised",
  focus: "Normal",
  awkward: "Blushing",
  panic: "Surprised"
};

const motionMap = {
  idle: "Idle",
  talk: "Idle",
  nod: "Tap",
  wave: "Flick",
  think: "Tap",
  panic: "Flick"
};

export class Live2DAvatarAdapter {
  constructor({ canvas, container }) {
    this.canvas = canvas;
    this.container = container;
    this.app = null;
    this.model = null;
    this.ready = false;
    this.speaking = false;
    this.mouthPhase = 0;
    this.lastExpression = "";
    this.lastMotionAt = 0;
  }

  async init() {
    const Live2DModel = getLive2DModelClass();
    if (!window.PIXI?.Application) {
      throw new Error("PixiJS is not available; window.PIXI.Application was not found");
    }
    if (!window.Live2DCubismCore) {
      throw new Error("Live2D Cubism Core is not available; window.Live2DCubismCore was not found");
    }
    if (!Live2DModel) {
      throw new Error("pixi-live2d-display is not available; Live2DModel was not found");
    }

    const modelSettings = await createSilentModelSettings(MODEL_URL);
    this.ensureContainerSize();

    this.app = new window.PIXI.Application({
      view: this.canvas,
      autoStart: true,
      backgroundAlpha: 0,
      antialias: true,
      resizeTo: this.container
    });

    try {
      this.model = await Live2DModel.from(modelSettings, { autoInteract: false });
    } catch (error) {
      throw new Error(`Live2D model failed to initialize from ${MODEL_URL}: ${formatError(error)}`);
    }

    this.model.visible = true;
    this.model.alpha = 1;
    this.app.stage.addChild(this.model);
    this.fitModel();
    window.addEventListener("resize", () => this.fitModel());
    this.app.ticker.add((delta) => this.tick(delta));
    this.ready = true;
    this.apply({ emotion: "neutral", action: "idle", speaking: false, forceMotion: true });
  }

  apply(command) {
    if (!this.ready || !this.model) return;
    const emotion = command.emotion || "neutral";
    const action = command.action || "idle";
    this.speaking = Boolean(command.speaking);
    this.applyExpression(emotion);
    this.applyMotion(action, Boolean(command.forceMotion));
    if (!this.speaking) this.setMouthOpen(0);
  }

  fitModel() {
    if (!this.model || !this.container) return;
    const width = this.container.clientWidth || 440;
    const height = this.container.clientHeight || 620;
    const bounds = this.model.getLocalBounds();
    if (!bounds.width || !bounds.height) {
      console.warn("Live2D model has empty bounds; keeping default transform", bounds);
      return;
    }
    const scale = Math.min(width / bounds.width, height / bounds.height) * 0.95;
    this.model.scale.set(scale);
    this.model.x = width / 2;
    this.model.y = height;
    if ("anchor" in this.model) {
      this.model.anchor.set(0.5, 1);
    }
  }

  applyExpression(emotion) {
    const expression = expressionMap[emotion] || "Normal";
    if (expression === this.lastExpression) return;
    this.lastExpression = expression;
    try {
      this.model.expression(expression);
    } catch (error) {
      console.warn("Live2D expression failed", expression, error);
    }
  }

  applyMotion(action, force = false) {
    const group = motionMap[action];
    if (!group) return;
    const now = Date.now();
    if (!force && group === "Idle" && now - this.lastMotionAt < 5000) return;
    if (!force && group !== "Idle" && now - this.lastMotionAt < 800) return;
    this.lastMotionAt = now;
    try {
      this.model.motion(group);
    } catch (error) {
      console.warn("Live2D motion failed", group, error);
    }
  }

  tick(delta) {
    if (!this.ready || !this.model) return;
    if (!this.speaking) return;
    this.mouthPhase += delta * 0.28;
    const open = 0.15 + Math.abs(Math.sin(this.mouthPhase)) * 0.85;
    this.setMouthOpen(open);
  }

  setMouthOpen(value) {
    try {
      this.model.internalModel?.coreModel?.setParameterValueById?.(MOUTH_PARAM_ID, value);
    } catch (error) {
      console.warn("Live2D mouth parameter failed", error);
    }
  }

  ensureContainerSize() {
    const width = this.container?.clientWidth || 0;
    const height = this.container?.clientHeight || 0;
    if (width <= 0 || height <= 0) {
      throw new Error(`Live2D canvas container has invalid size: ${width}x${height}`);
    }
  }
}

function getLive2DModelClass() {
  return window.PIXI?.live2d?.Live2DModel || window.Live2DModel || window.PIXI?.Live2DModel || null;
}

async function createSilentModelSettings(modelUrl) {
  const model = await fetchJson(modelUrl, "Live2D model manifest");
  await verifyModelAssets(modelUrl, model);
  removeMotionSounds(model);
  model.url = new URL(modelUrl, window.location.href).href;
  return model;
}

function removeMotionSounds(model) {
  const motions = model?.FileReferences?.Motions || {};
  for (const items of Object.values(motions)) {
    for (const item of items || []) {
      if (item && typeof item === "object") delete item.Sound;
    }
  }
}

async function verifyModelAssets(modelUrl, model) {
  const references = model?.FileReferences || {};
  const base = new URL(modelUrl, window.location.href);
  const assets = [
    references.Moc,
    references.Physics,
    references.DisplayInfo,
    ...(references.Textures || []),
    ...(references.Expressions || []).map((item) => item.File),
    ...Object.values(references.Motions || {}).flat().map((item) => item.File)
  ].filter(Boolean);

  await Promise.all(
    assets.map(async (asset) => {
      const url = new URL(asset, base).href;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Live2D asset failed to load: ${url} (${response.status})`);
      }
    })
  );
}

async function fetchJson(url, label) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${label} failed to load: ${url} (${response.status})`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${formatError(error)}`);
  }
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
