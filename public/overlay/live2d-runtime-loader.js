const runtimeScripts = [
  {
    name: "PixiJS",
    test: () => Boolean(window.PIXI?.Application),
    sources: [
      "/vendor/live2d/pixi.min.js",
      "https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js"
    ]
  },
  {
    name: "Live2D Cubism Core",
    test: () => Boolean(window.Live2DCubismCore),
    sources: [
      "/vendor/live2d/live2dcubismcore.min.js",
      "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"
    ]
  },
  {
    name: "pixi-live2d-display cubism4",
    test: () => Boolean(window.PIXI?.live2d?.Live2DModel),
    sources: [
      "/vendor/live2d/pixi-live2d-display-cubism4.min.js",
      "https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js"
    ]
  }
];

loadRuntime()
  .catch((error) => {
    console.warn("Live2D runtime preload failed; overlay will use fallback avatar", error);
  })
  .finally(() => {
    import("/overlay/main.js").catch((error) => {
      console.error("Overlay main script failed to load", error);
    });
  });

async function loadRuntime() {
  for (const script of runtimeScripts) {
    if (script.test()) continue;
    await loadFirstAvailable(script);

    if (!script.test()) {
      throw new Error(`${script.name} loaded but did not expose the expected browser global`);
    }
  }
}

async function loadFirstAvailable(script) {
  const errors = [];

  for (const source of script.sources) {
    try {
      await loadScript(source);

      if (script.test()) {
        console.info(`Live2D runtime loaded: ${script.name} from ${source}`);
        return;
      }

      errors.push(`${source}: loaded but did not expose expected global`);
    } catch (error) {
      errors.push(`${source}: ${error.message || error}`);
    }
  }

  throw new Error(`${script.name} could not be loaded. Tried ${errors.join("; ")}`);
}

function loadScript(source) {
  return new Promise((resolve, reject) => {
    const element = document.createElement("script");
    element.src = source;
    element.async = false;

    if (source.startsWith("http")) {
      element.crossOrigin = "anonymous";
    }

    element.onload = () => resolve();
    element.onerror = () => reject(new Error("script load failed"));

    document.head.appendChild(element);
  });
}