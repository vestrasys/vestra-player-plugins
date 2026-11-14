import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { FilterStatus, Plugin, RenderingState, Text, TextList, VideoShaders } from "@vestra-player/sdk";
import {
  ANIME4K_MODES,
  ANIME4K_QUALITIES,
  DEFAULT_SETTINGS,
  demandingFsrcnnx,
  FSRCNNX_SIZES,
  isStoredSettings,
  type ModelId,
  MODELS,
  demandingMode,
  platformOf,
  readSettings,
  type Settings,
  shaderFiles,
} from "./presets.ts";

export { DEFAULT_SETTINGS, isSettings, shaderFiles } from "./presets.ts";

/** The one menu item: it opens the window (Video menu, after the player's own Picture ▸ Rendering ▸ AI Upscaling). */
export const WINDOW_TITLE = "Shader Upscaling…";

/** What fits the OSD's single line in a default-size window (as the player's AI Upscaling panel), in characters. */
export const OSD_BUDGET = { en: 80, zh: 40 };

/** The package directory: `main.ts` in development, the built `main.js` in the package, both at its top. */
const PACKAGE = import.meta.dirname;

/** Absolute path of a bundled shader (`files` are relative to `shaders/`, with `/`). */
export const shaderPath = (file: string) => join(PACKAGE, "shaders", ...file.split("/"));

/**
 * Shader Upscale for Vestra Player (`zysilm.shaderupscale`): real-time
 * upscaling with mpv GLSL shaders bundled in the package (Anime4K for anime,
 * AMD FSR 1 for everything else, RAVU and FSRCNNX for live action, plus
 * chroma upscaling, sharpening and SSIM downscaling as add-ons), applied
 * through the plugin's own shader handle (`plugin.video.shaders`, player
 * 0.5.20). One menu item, Video ▸ Shader Upscaling…, opens a window with the
 * upscaler, its parameters (Anime4K's mode and quality, FSRCNNX's network),
 * the three add-ons, one On/Off button and what is applied.
 *
 * Shaders run only where the player renders on the GPU (macOS; Windows with
 * Video ▸ GPU Rendering (Experimental)); under software rendering the window
 * greys the button out and says why.
 *
 * Nothing runs while it is off: the plugin holds nothing, so with lazy
 * activation the player may stop it. While on, its shaders keep it running.
 *
 * Crash safety is the player's (0.6.3): after a run that ended abnormally
 * while plugin shaders were drawing, it refuses non-empty shader lists with
 * `previous-crash` (for that start; after a second such run within a day,
 * for days) and shows its own OSD line. The plugin then keeps the user's
 * choice, sends nothing more on its own for the rest of the player run (also
 * across its own stop and wake), and says in the window why nothing runs;
 * Turn Off saves off, and an explicit Turn On tries once.
 */
export default async function activate(plugin: Plugin) {
  plugin.player.subscribe(); // the player's events from now on
  await plugin.player.read(); // the player's state and timeline, read once
  const { text, list } = plugin.i18n;
  const store = plugin.storage.json<Settings>("upscaling", {
    defaults: DEFAULT_SETTINGS,
    validate: isStoredSettings,
  });
  // An earlier version's settings (0.1.1 without the add-ons; 0.1.0's ArtCNN) as the current ones, saved at once.
  const current = readSettings(store.value) ?? DEFAULT_SETTINGS;
  if (JSON.stringify(current) !== JSON.stringify(store.value)) store.save(current);
  const save = (patch: Partial<Settings>) => store.save({ ...store.value, ...patch });
  /**
   * The player refused shaders in this player run (`previous-crash`) with
   * this message: nothing is sent again until the user turns them on
   * explicitly. Kept in session storage, so a lazy stop and wake of the
   * plugin does not send them again either.
   */
  const kept = await plugin.storage.session.get<unknown>("refused").catch(() => undefined);
  let refused: string | null = typeof kept === "string" ? kept : null;
  const remember = (message: string | null) => {
    refused = message;
    void plugin.storage.session.set("refused", message).catch(() => {});
  };
  // Unreleased builds of 0.1.1 kept their own crash flag here; the player's guard replaces it.
  await rm(join(plugin.dataDirectory, "guard.json"), { force: true }).catch(() => {});

  const window = plugin.windows.create("upscale.slint");
  /**
   * The shader handle, only while it holds shaders: a handle follows the
   * player's source state, which would keep the plugin running while off.
   */
  let shaders: VideoShaders | null = null;
  /** The list the plugin last sent (`[]` = none). */
  let sent: string[] = [];
  /** Changes go out one after another (a disposed handle's id is free only once its dispose finished). */
  let queue: Promise<void> = Promise.resolve();
  /** The player switched to software rendering during this run (a pushed `unsupported`). */
  let fellBack = false;
  /** A compile failure was told on the OSD for the current list. */
  let toldFailure = false;

  /** Show on the video; a refused text goes to the plugin log, never stops the plugin. */
  const osd = (message: Text) =>
    plugin.osd
      .show(
        // i18n-ignore: always a text() made by the caller
        message,
      )
      .catch((error: unknown) => console.error("shaderupscale: osd:", error));

  // ------------------------------------------------------------------ where shaders can run
  const system = await plugin.app.system().catch(() => null);
  /** RAVU's file differs between Windows and the other systems. */
  const platform = platformOf(system?.os);
  /** The rendering state behind the advice for software rendering; read when the window opens. */
  let rendering: RenderingState | null = null;

  /** The player draws on the GPU (an unknown renderer counts as GPU: the player's answer then decides). */
  const gpu = () => !fellBack && system?.rendering !== "software";
  /** Why the shaders cannot run here, or `null`. */
  function unavailable(): Text | null {
    return gpu() ? null : renderingAdvice();
  }

  /** Why GPU rendering is off and what to do, following the player's own order of checks (as the player's AI Upscaling panel). */
  function renderingAdvice(): Text {
    const r = rendering;
    if (!r) return text("Shader upscaling needs GPU rendering: turn on Video ▸ GPU Rendering (Experimental), then restart the player.");
    if (!r.gpu.available)
      return text(
        // TRANSLATORS: {} is the player's own message, in English.
        "Shader upscaling needs GPU rendering, which cannot be turned on here: {}",
        [r.gpu.reason?.message ?? ""],
      );
    if (fellBack || r.reason.code === "init-failed" || r.reason.code === "window-fallback")
      return text("GPU rendering stopped during this run: restart the player to use shader upscaling.");
    if (r.nextMode === "gpu") return text("GPU rendering is on from the next start: restart the player to use shader upscaling.");
    return text("Shader upscaling needs GPU rendering: turn on Video ▸ GPU Rendering (Experimental), then restart the player.");
  }

  // ------------------------------------------------------------------ names
  const qualityName = (quality: Settings["anime4k"]["quality"]) =>
    quality === "ultra" ? text("Ultra") : quality === "hq" ? text("HQ") : text("Fast");

  /** The upscaler as one short name: "Anime4K mode A (Fast)", "AMD FSR 1", "RAVU-lite-AR r3" or "FSRCNNX x2 16". */
  function upscalerName(settings: Settings): Text {
    switch (settings.model) {
      case "fsr":
        return text("AMD FSR 1");
      case "ravu":
        return text("RAVU-lite-AR r3");
      case "fsrcnnx":
        return settings.fsrcnnx.size === "16" ? text("FSRCNNX x2 16") : text("FSRCNNX x2 8");
      case "anime4k":
        return text(
          // TRANSLATORS: {} are the mode (A, B, C, A+A, B+B, C+A) and the quality (Fast, HQ or Ultra).
          "Anime4K mode {} ({})",
          [settings.anime4k.mode, qualityName(settings.anime4k.quality)],
        );
    }
  }

  /** The preset as one short name, with the add-ons: "Anime4K mode A (Fast) + chroma + downscale + sharpen". */
  function presetName(settings = store.value): Text {
    let name = upscalerName(settings);
    if (settings.chroma)
      name = text(
        // TRANSLATORS: {} is the upscaler, for example "Anime4K mode A (Fast)"; "chroma" is the chroma upscaling add-on.
        "{} + chroma",
        [name],
      );
    if (settings.downscale)
      name = text(
        // TRANSLATORS: {} is the upscaler, possibly with "+ chroma"; "downscale" is the SSIM downscaling add-on.
        "{} + downscale",
        [name],
      );
    if (settings.sharpen)
      name = text(
        // TRANSLATORS: {} is the upscaler, possibly with "+ chroma" and "+ downscale"; "sharpen" is the sharpening add-on.
        "{} + sharpen",
        [name],
      );
    return name;
  }

  // ------------------------------------------------------------------ applying
  /** Send what the settings ask for: the preset's shaders while on and possible, else none. */
  function apply() {
    queue = queue.then(applyNow).catch((error: unknown) => console.error("shaderupscale: apply:", error));
    return queue;
  }

  async function applyNow() {
    const want = store.value.on && refused === null && unavailable() === null ? shaderFiles(store.value, platform).map(shaderPath) : [];
    if (want.length === sent.length && want.every((path, i) => path === sent[i])) return;
    sent = want;
    toldFailure = false;
    if (want.length > 0) (shaders ??= handle()).set(want);
    else await release();
  }

  /** Withdraw the shaders and let the handle go (the plugin may then be stopped while idle). */
  async function release() {
    const old = shaders;
    shaders = null;
    await old?.dispose();
    plugin.update();
  }

  function handle() {
    const created = plugin.video.shaders("upscale");
    created.onStatus((status) => onStatus(created, status));
    return created;
  }

  function onStatus(from: VideoShaders, status: FilterStatus) {
    if (from !== shaders) return;
    if (status.state === "failed" && status.error.code === "unsupported") {
      // Software rendering (a switch during the run): the player removed the list.
      fellBack = true;
      sent = [];
      queue = queue.then(release).catch(() => {});
      if (window.opened)
        void plugin.rendering
          .state()
          .then((state) => {
            rendering = state;
            plugin.update();
          })
          .catch(() => {});
    } else if (status.state === "failed" && status.error.code === "previous-crash") {
      // The player's crash guard: it shows its own OSD line. Keep the choice, send nothing more
      // (a new video or preset does not try again), and let the handle go.
      remember(status.error.message);
      sent = [];
      queue = queue.then(release).catch(() => {});
    } else if (status.state === "failed" && status.error.code === "failed" && !toldFailure) {
      toldFailure = true;
      void osd(text("Shader Upscaling: a shader did not compile"));
    }
    plugin.update();
  }

  async function setOn(on: boolean) {
    // An explicit Turn On after a refusal tries once more; a refusal again shows the same reason.
    if (on && refused !== null) remember(null);
    save({ on });
    await apply();
    plugin.update();
    if (!on) return osd(text("Shader Upscaling: Off"));
    await outcome(shaders);
    // Refused: the status line says why (the player showed its OSD line at the start).
    if (refused !== null) return;
    const why = unavailable();
    return osd(
      why === null
        ? text(
            // TRANSLATORS: {} is the preset, for example "Anime4K mode A (Fast)".
            "Shader Upscaling: On, {}",
            [presetName()],
          )
        : text("Shader Upscaling needs GPU rendering"),
    );
  }

  /** Resolves once the player answered the list just sent (at most 3 s). */
  function outcome(from: VideoShaders | null) {
    if (from === null || from.status.state !== "applying") return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, 3000);
      const watch = from.onStatus((status) => status.state !== "applying" && done());
      function done() {
        clearTimeout(timer);
        void watch.dispose();
        resolve();
      }
    });
  }

  /** A new upscaler, parameter or add-on: saved, and applied at once while on (not after a refusal). */
  async function choose(patch: Partial<Settings>) {
    save(patch);
    plugin.update();
    await apply();
  }

  // ------------------------------------------------------------------ the window
  /** An upscaler as the drop-down shows it: what it is for, then its name. */
  function modelName(model: ModelId): Text {
    switch (model) {
      case "anime4k":
        return text("Anime: Anime4K");
      case "fsr":
        return text("General: AMD FSR 1");
      case "ravu":
        return text("Live action · Light: RAVU");
      case "fsrcnnx":
        return text("Live action · High: FSRCNNX");
    }
  }

  /** The headline and its tone (upscale.slint): 0 off, 1 applied, 2 on but waiting, 3 not available or failed. */
  function headline(status: FilterStatus | null): { status: Text; tone: number; detail: Text | string } {
    const why = unavailable();
    if (why !== null) return { status: text("Not available"), tone: 3, detail: why };
    if (!store.value.on) return { status: text("Off"), tone: 0, detail: "" };
    if (refused !== null)
      return {
        status: text("Not running: the player ended abnormally while shaders were drawing"),
        tone: 3,
        detail: text(
          // TRANSLATORS: {} is the player's own message, in English; it says for how long.
          "Your choice applies when the player allows shaders again; consider a preset that is not marked demanding. The player says: {}",
          [refused],
        ),
      };
    switch (status?.state) {
      case "applied":
        return {
          status: text(
            // TRANSLATORS: {} is the preset, for example "Anime4K mode A (Fast)".
            "On: {}",
            [presetName()],
          ),
          tone: 1,
          detail: "",
        };
      case "failed":
        if (status.error.code === "failed")
          return {
            status: text("On, but a shader did not compile"),
            tone: 3,
            detail: text(
              // TRANSLATORS: {} is mpv's compiler message, in English.
              "The player cannot tell whose shader failed when other plugins add shaders too. Its message: {}",
              [status.error.message],
            ),
          };
        if (status.error.code === "limit")
          return {
            status: text("On, but not applied"),
            tone: 3,
            detail: text(
              // TRANSLATORS: {} is the player's own message, in English.
              "Other plugins' shaders leave no room: at most 16 shaders run at once. {}",
              [status.error.message],
            ),
          };
        return {
          status: text("On, but not applied"),
          tone: 3,
          // The player's own message, in English.
          detail: status.error.message,
        };
      case "applying":
        return { status: text("On: applying…"), tone: 2, detail: "" };
      default:
        return { status: text("On: applies when a video plays"), tone: 2, detail: "" };
    }
  }

  /**
   * The two parameter drop-downs: labels, items and the current index. Anime4K has its mode and quality, FSRCNNX
   * its network (one row); FSR and RAVU have none.
   */
  function parameters() {
    const s = store.value;
    const none = { paramALabel: "", paramAItems: [], paramAIndex: 0, paramBLabel: "", paramBItems: [], paramBIndex: 0 };
    if (s.model === "fsr" || s.model === "ravu") return none;
    if (s.model === "fsrcnnx")
      return {
        ...none,
        paramALabel: text("Network"),
        paramAItems: FSRCNNX_SIZES.map((size) =>
          demandingFsrcnnx(size) ? text("x2 16 (demanding): the most detail, fast GPU") : text("x2 8: lighter, about half the work"),
        ),
        paramAIndex: FSRCNNX_SIZES.indexOf(s.fsrcnnx.size),
      };
    return {
      paramALabel: text("Mode"),
      paramAItems: ANIME4K_MODES.map((mode) =>
        demandingMode(mode)
          ? text(
              // TRANSLATORS: {} is the mode (A+A, B+B or C+A).
              "Mode {} (demanding)",
              [mode],
            )
          : text(
              // TRANSLATORS: {} is the mode (A, B or C).
              "Mode {}",
              [mode],
            ),
      ),
      paramAIndex: ANIME4K_MODES.indexOf(s.anime4k.mode),
      paramBLabel: text("Quality"),
      paramBItems: ANIME4K_QUALITIES.map((quality) =>
        quality === "ultra"
          ? text("Ultra (demanding): largest networks, fastest GPUs")
          : quality === "hq"
            ? text("HQ (demanding): large networks, fast GPU")
            : text("Fast: smaller networks, most GPUs"),
      ),
      paramBIndex: ANIME4K_QUALITIES.indexOf(s.anime4k.quality),
    };
  }

  /** What the chosen preset does and what it suits (one line per part). */
  function description(): TextList {
    const s = store.value;
    if (s.model === "fsr")
      return list(
        [
          text(
            "AMD FSR 1: for live action, games and anything that is not anime. Edge-aware upscaling of the brightness detail with light sharpening, up to twice the width and height; light on the GPU.",
          ),
        ],
        "lines",
      );
    if (s.model === "ravu")
      return list(
        [
          text(
            "RAVU-lite-AR r3: for live action. Enlarges the brightness detail twice the width and height with a filter learned from video, with anti-ringing for sharp edges; light on the GPU. Runs when the video is enlarged more than about 1.4×.",
          ),
        ],
        "lines",
      );
    if (s.model === "fsrcnnx")
      return list(
        [
          text(
            "FSRCNNX: for live action. A small neural network that enlarges the brightness detail twice the width and height and recovers fine detail; more work than RAVU or FSR. Runs when the video is enlarged more than 1.3×.",
          ),
          s.fsrcnnx.size === "16"
            ? text("x2 16 (demanding) runs the larger network: the most detail; for fast GPUs.")
            : text("x2 8 runs the smaller network: about half the work of x2 16, for most GPUs."),
        ],
        "lines",
      );
    const mode = {
      A: text(
        "Mode A: for most 1080p anime and blurry older or SD anime. Restores lines and removes blur, noise and compression smear; can strengthen ringing or banding already in the video.",
      ),
      B: text(
        "Mode B: for most 720p anime and anime downscaled from 1080p. A softer restore that also reduces ringing and aliasing; some blur may stay.",
      ),
      C: text(
        "Mode C: for clean sources with little blur, such as anime downscaled to 480p. Upscales with denoising and stays closest to the source.",
      ),
      "A+A": text(
        "Mode A+A (demanding): mode A with a second restore pass: the sharpest lines, but it can ring, band or alias. Only when the video is enlarged 2× or more.",
      ),
      "B+B": text("Mode B+B (demanding): mode B with a second soft restore pass. Only when the video is enlarged 2× or more."),
      "C+A": text("Mode C+A (demanding): mode C with a restore pass after it. Only when the video is enlarged 2× or more."),
    }[s.anime4k.mode];
    const quality =
      s.anime4k.quality === "ultra"
        ? text("Ultra (demanding) runs the largest networks (UL and M): about twice the work of HQ; for the fastest GPUs.")
        : s.anime4k.quality === "hq"
          ? text("HQ (demanding) runs the large networks (VL and M): about four times the work of Fast; for fast GPUs.")
          : text("Fast runs the smaller networks (M and S), for most GPUs.");
    return list(
      [
        text(
          "Anime4K: neural networks for anime and cartoons that restore and double the picture twice. Its restore steps can also remove fine detail and texture.",
        ),
        mode,
        quality,
      ],
      "lines",
    );
  }

  window.bind(() => {
    // The saved choice, also while the player refuses: Turn Off then saves off.
    const on = store.value.on;
    const head = headline(shaders?.status ?? null);
    return {
      models: MODELS.map(modelName),
      modelIndex: MODELS.indexOf(store.value.model),
      ...parameters(),
      description: description(),
      chroma: store.value.chroma,
      sharpen: store.value.sharpen,
      downscale: store.value.downscale,
      on,
      // A saved "on" can always be turned off (also while refused); turning on needs GPU rendering.
      canToggle: on || unavailable() === null,
      ...head,
    };
  });
  window.on("pickModel", (index: number) => {
    const model = MODELS[index];
    if (model && model !== store.value.model) choose({ model });
    else plugin.update();
  });
  // The first row is Anime4K's mode or FSRCNNX's network, the second Anime4K's quality.
  window.on("pickA", (index: number) => {
    if (store.value.model === "fsrcnnx") {
      const size = FSRCNNX_SIZES[index];
      if (size) return choose({ fsrcnnx: { size } });
    } else if (store.value.model === "anime4k") {
      const mode = ANIME4K_MODES[index];
      if (mode) return choose({ anime4k: { ...store.value.anime4k, mode } });
    }
    plugin.update();
  });
  window.on("pickB", (index: number) => {
    const quality = ANIME4K_QUALITIES[index];
    if (quality && store.value.model === "anime4k") return choose({ anime4k: { ...store.value.anime4k, quality } });
    plugin.update();
  });
  window.on("toggleChroma", (chroma: boolean) => {
    if (typeof chroma === "boolean" && chroma !== store.value.chroma) return choose({ chroma });
    plugin.update();
  });
  window.on("toggleSharpen", (sharpen: boolean) => {
    if (typeof sharpen === "boolean" && sharpen !== store.value.sharpen) return choose({ sharpen });
    plugin.update();
  });
  window.on("toggleDownscale", (downscale: boolean) => {
    if (typeof downscale === "boolean" && downscale !== store.value.downscale) return choose({ downscale });
    plugin.update();
  });
  window.on("toggle", () => setOn(!store.value.on));
  window.on("closeWindow", () =>
    // `missing` when the user closed it with the title bar just before.
    window.close().catch(() => {}),
  );

  async function openWindow() {
    await window.show();
    // The advice for software rendering depends on the player's rendering choice.
    if (!gpu()) {
      rendering = await plugin.rendering.state().catch(() => null);
      plugin.update();
    }
  }

  plugin.commands.add({
    id: "shaderupscale.window",
    path: ["@video", WINDOW_TITLE],
    order: 463,
    group: "video-rendering",
    run: openWindow,
  });

  // The saved choice: the shaders go to the player now and apply when a video plays.
  await apply();
}
