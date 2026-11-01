import { join } from "node:path";
import type { FilterStatus, Plugin, RenderingState, Text, TextList, VideoShaders } from "@vestra-player/sdk";
import {
  ANIME4K_MODES,
  ANIME4K_QUALITIES,
  ARTCNN_SIZES,
  ARTCNN_STYLES,
  DEFAULT_SETTINGS,
  isSettings,
  MODELS,
  demandingMode,
  type Guard,
  isGuard,
  needsCompute,
  type Settings,
  shaderFiles,
} from "./presets.ts";

export { DEFAULT_SETTINGS, isSettings, shaderFiles } from "./presets.ts";

/** The one menu item: it opens the window (Video menu, after RTX Upscale's "AI Upscaling…" when that is installed). */
export const WINDOW_TITLE = "Shader Upscaling…";

/** What fits the OSD's single line in a default-size window (as RTX Upscale), in characters. */
export const OSD_BUDGET = { en: 80, zh: 40 };

/** The package directory: `main.ts` in development, the built `main.js` in the package, both at its top. */
const PACKAGE = import.meta.dirname;

/** Absolute path of a bundled shader (`files` are relative to `shaders/`, with `/`). */
export const shaderPath = (file: string) => join(PACKAGE, "shaders", ...file.split("/"));

/**
 * Shader Upscale for Vestra Player (`zysilm.shaderupscale`): real-time
 * upscaling with mpv GLSL shaders bundled in the package (Anime4K, ArtCNN),
 * applied through the plugin's own shader handle (`plugin.video.shaders`,
 * player 0.5.20). One menu item, Video ▸ Shader Upscaling…, opens a window
 * with the model, its parameters, one On/Off button and what is applied.
 *
 * Shaders run only where the player renders on the GPU (macOS; Windows with
 * Video ▸ GPU Rendering (Experimental)); under software rendering the window
 * greys the button out and says why. ArtCNN's shaders are compute shaders,
 * which macOS's OpenGL 4.1 lacks, so it is greyed out there too.
 *
 * Nothing runs while it is off: the plugin holds nothing, so with lazy
 * activation the player may stop it. While on, its shaders keep it running.
 *
 * Crash safety: while shaders are applied, `guard.json` says so
 * (`active: true`); a clean stop clears it. Found set at the next start of
 * the player (session storage empty, so not a restart of the plugin within
 * one player run), the player did not close normally while the shaders ran,
 * so the plugin starts with them off and says why, rather than risk the same
 * end again.
 */
export default async function activate(plugin: Plugin) {
  const { text, list } = plugin.i18n;
  const store = plugin.storage.json<Settings>("upscaling", {
    defaults: DEFAULT_SETTINGS,
    validate: isSettings,
  });
  const save = (patch: Partial<Settings>) => store.save({ ...store.value, ...patch });
  /** Shaders are applied (written before they are sent, cleared when they are withdrawn and at a clean stop). */
  const guard = plugin.storage.json<Guard>("guard", { defaults: { active: false }, validate: isGuard, debounceMs: 0 });
  // Registered after the store, so it runs first and the store's own disposal writes the cleared flag.
  plugin.onDispose(async () => {
    if (!guard.value.active) return;
    guard.save({ active: false });
    await guard.flush().catch((error: unknown) => console.error("shaderupscale: guard:", error));
  });
  /** Turned off at this start because the player did not close normally while the shaders ran (until turned on again). */
  let recovered = false;

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
  /** The rendering state behind the advice for software rendering; read when the window opens. */
  let rendering: RenderingState | null = null;

  /** The player draws on the GPU (an unknown renderer counts as GPU: the player's answer then decides). */
  const gpu = () => !fellBack && system?.rendering !== "software";
  /** ArtCNN on macOS: compute shaders, which macOS's OpenGL lacks. */
  const noCompute = () => system?.os === "macos" && needsCompute(store.value.model);
  /** Why the chosen model cannot run here, or `null`. */
  function unavailable(): Text | null {
    if (!gpu()) return renderingAdvice();
    if (noCompute())
      return text(
        "ArtCNN needs compute shaders, which macOS's OpenGL does not have. Choose Anime4K, which runs everywhere the player renders on the GPU.",
      );
    return null;
  }

  /** Why GPU rendering is off and what to do, following the player's own order of checks (as RTX Upscale). */
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
  const qualityName = (quality: Settings["anime4k"]["quality"]) => (quality === "hq" ? text("HQ") : text("Fast"));
  const styleName = (style: Settings["artcnn"]["style"]) =>
    style === "ds" ? text("Denoise and sharpen") : style === "dn" ? text("Denoise and soften") : text("Neutral");
  const sizeName = (size: Settings["artcnn"]["size"]) => size.toUpperCase();

  /** The preset as one short name: "Anime4K mode A (Fast)", "ArtCNN C4F16 (Neutral)". */
  function presetName(settings = store.value): Text {
    return settings.model === "anime4k"
      ? text(
          // TRANSLATORS: {} are the mode (A, B, C, A+A, B+B, C+A) and the quality (Fast or HQ).
          "Anime4K mode {} ({})",
          [settings.anime4k.mode, qualityName(settings.anime4k.quality)],
        )
      : text(
          // TRANSLATORS: {} are the network size (C4F16 or C4F32) and the variant (Neutral, …).
          "ArtCNN {} ({})",
          [sizeName(settings.artcnn.size), styleName(settings.artcnn.style)],
        );
  }

  // ------------------------------------------------------------------ applying
  /** Send what the settings ask for: the preset's shaders while on and possible, else none. */
  function apply() {
    queue = queue.then(applyNow).catch((error: unknown) => console.error("shaderupscale: apply:", error));
    return queue;
  }

  async function applyNow() {
    const want = store.value.on && unavailable() === null ? shaderFiles(store.value).map(shaderPath) : [];
    if (want.length === sent.length && want.every((path, i) => path === sent[i])) return;
    sent = want;
    toldFailure = false;
    if (want.length > 0) {
      if (!guard.value.active) {
        guard.save({ active: true });
        // On disk before the player runs them: a crash from here on is noticed at the next start.
        await guard.flush().catch((error: unknown) => console.error("shaderupscale: guard:", error));
      }
      (shaders ??= handle()).set(want);
    } else await release();
  }

  /** Withdraw the shaders and let the handle go (the plugin may then be stopped while idle). */
  async function release() {
    const old = shaders;
    shaders = null;
    await old?.dispose();
    if (guard.value.active) guard.save({ active: false });
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
    } else if (status.state === "failed" && status.error.code === "failed" && !toldFailure) {
      toldFailure = true;
      void osd(text("Shader Upscaling: a shader did not compile"));
    }
    plugin.update();
  }

  async function setOn(on: boolean) {
    recovered = false;
    save({ on });
    await apply();
    plugin.update();
    if (!on) return osd(text("Shader Upscaling: Off"));
    const why = unavailable();
    return osd(
      why === null
        ? text(
            // TRANSLATORS: {} is the preset, for example "Anime4K mode A (Fast)".
            "Shader Upscaling: On, {}",
            [presetName()],
          )
        : gpu()
          ? text("Shader Upscaling: ArtCNN does not run on macOS")
          : text("Shader Upscaling needs GPU rendering"),
    );
  }

  /** A new model or parameter: saved, and applied at once while on. */
  async function choose(patch: Partial<Settings>) {
    save(patch);
    plugin.update();
    await apply();
  }

  // ------------------------------------------------------------------ the window
  /** The headline and its tone (upscale.slint): 0 off, 1 applied, 2 on but waiting, 3 not available or failed. */
  function headline(status: FilterStatus | null): { status: Text; tone: number; detail: Text | string } {
    const why = unavailable();
    if (why !== null) return { status: text("Not available"), tone: 3, detail: why };
    if (!store.value.on)
      return {
        status: text("Off"),
        tone: 0,
        detail: recovered
          ? text(
              "Shader upscaling was turned off because the player did not close normally while it was on. Turn it on again, or first choose a preset that is not marked demanding.",
            )
          : "",
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

  /** The two parameter drop-downs of the chosen model: labels, items and the current index. */
  function parameters() {
    const s = store.value;
    if (s.model === "anime4k")
      return {
        paramALabel: text("Mode"),
        paramAItems: ANIME4K_MODES.map((mode) =>
          demandingMode(mode)
            ? text(
                // TRANSLATORS: {} is the mode (A+A, B+B or C+A).
                "Mode {} (demanding)",
                [mode],
              )
            : text("Mode {}", [mode]),
        ),
        paramAIndex: ANIME4K_MODES.indexOf(s.anime4k.mode),
        paramBLabel: text("Quality"),
        paramBItems: ANIME4K_QUALITIES.map((quality) =>
          quality === "hq" ? text("HQ (demanding): large networks, fast GPU") : text("Fast: smaller networks, most GPUs"),
        ),
        paramBIndex: ANIME4K_QUALITIES.indexOf(s.anime4k.quality),
      };
    return {
      paramALabel: text("Size"),
      paramAItems: ARTCNN_SIZES.map((size) =>
        size === "c4f32" ? text("C4F32 (demanding): more detail, needs a faster GPU") : text("C4F16: light on the GPU"),
      ),
      paramAIndex: ARTCNN_SIZES.indexOf(s.artcnn.size),
      paramBLabel: text("Variant"),
      paramBItems: ARTCNN_STYLES.map(styleName),
      paramBIndex: ARTCNN_STYLES.indexOf(s.artcnn.style),
    };
  }

  /** What the chosen preset does and what it suits (one line per part). */
  function description(): TextList {
    const s = store.value;
    if (s.model === "anime4k") {
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
        s.anime4k.quality === "hq"
          ? text("HQ (demanding) runs the large networks (VL and M): about four times the work of Fast; for fast GPUs.")
          : text("Fast runs the smaller networks (M and S), for most GPUs.");
      return list(
        [text("Anime4K: neural networks for anime and cartoons that restore and double the picture twice."), mode, quality],
        "lines",
      );
    }
    const style = {
      neutral: text("Neutral: doubles the detail without changing the picture's character."),
      ds: text("Denoise and sharpen: also removes noise and sharpens lines."),
      dn: text("Denoise and soften: removes noise, with a softer result."),
    }[s.artcnn.style];
    return list(
      [
        text(
          "ArtCNN: a small neural network trained on anime that doubles the brightness (luma) detail once; the player scales the colour.",
        ),
        style,
        ...(s.artcnn.size === "c4f32"
          ? [text("C4F32 (demanding) runs a network four times the size of C4F16; for fast GPUs.")]
          : []),
      ],
      "lines",
    );
  }

  window.bind(() => {
    const on = store.value.on;
    const head = headline(shaders?.status ?? null);
    return {
      models: MODELS.map((model) => (model === "anime4k" ? text("Anime4K") : text("ArtCNN"))),
      modelIndex: MODELS.indexOf(store.value.model),
      ...parameters(),
      description: description(),
      on,
      // A saved "on" can always be turned off; turning on needs a model that runs here.
      canToggle: on || unavailable() === null,
      ...head,
    };
  });
  window.on("pickModel", (index: number) => {
    const model = MODELS[index];
    if (model && model !== store.value.model) choose({ model });
    else plugin.update();
  });
  window.on("pickA", (index: number) => {
    const s = store.value;
    if (s.model === "anime4k") {
      const mode = ANIME4K_MODES[index];
      if (mode) return choose({ anime4k: { ...s.anime4k, mode } });
    } else {
      const size = ARTCNN_SIZES[index];
      if (size) return choose({ artcnn: { ...s.artcnn, size } });
    }
    plugin.update();
  });
  window.on("pickB", (index: number) => {
    const s = store.value;
    if (s.model === "anime4k") {
      const quality = ANIME4K_QUALITIES[index];
      if (quality) return choose({ anime4k: { ...s.anime4k, quality } });
    } else {
      const style = ARTCNN_STYLES[index];
      if (style) return choose({ artcnn: { ...s.artcnn, style } });
    }
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

  // A crash while the shaders ran: start with them off. Session storage tells a restart of the
  // plugin within one player run (the player kept running: nothing to undo) from a new player run.
  const sameRun = (await plugin.storage.session.get<boolean>("running").catch(() => undefined)) === true;
  await plugin.storage.session.set("running", true).catch(() => {});
  if (guard.value.active) {
    guard.save({ active: false });
    if (!sameRun && store.value.on) {
      recovered = true;
      save({ on: false });
      void osd(text("Shader Upscaling turned off: the player did not close normally"));
    }
  }

  // The saved choice: the shaders go to the player now and apply when a video plays.
  await apply();
}
