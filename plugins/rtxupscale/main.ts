import type {
  Disposable,
  PlaybackStats,
  Plugin,
  PluginError,
  RenderingState,
  Text,
  TextList,
  UpscalingReason,
  UpscalingState,
} from "@vestra-player/sdk";

/** What the plugin keeps across restarts (`upscaling.json` in its data directory). */
export interface Settings {
  /** The user turned AI upscaling on (and has not turned it off). */
  on: boolean;
  /** The note about the NVIDIA app's Super Resolution switch was shown once. */
  noted: boolean;
  /**
   * The reason code last told when the saved "on" could not be restored at a
   * start; the same reason is not told again at every start. Missing in 0.1.0.
   */
  refused?: string | null;
}

export const DEFAULT_SETTINGS: Settings = { on: false, noted: false, refused: null };

export const isSettings = (value: unknown): value is Settings =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Settings).on === "boolean" &&
  typeof (value as Settings).noted === "boolean" &&
  ((value as Settings).refused === undefined ||
    (value as Settings).refused === null ||
    typeof (value as Settings).refused === "string");

export const TITLE = "AI Upscaling (RTX Video Super Resolution)";

/** The menu item that opens the window (Video menu, next to {@link TITLE}). */
export const WINDOW_TITLE = "AI Upscaling…";

/**
 * The player's built-in Picture Adjustments plugin: only for it does the
 * window add where its reset is (Video ▸ Reset, key Q). Its name is always
 * the one the player reports.
 */
export const PICTURE_ADJUSTMENTS = "vestra.video";

/**
 * The causes of a `decoding` reason the plugin words itself (player 0.6.0;
 * the SDK docs say 0.5.25, a version that was never released).
 * A newer player's cause, and an older player without causes, show the
 * player's own message.
 */
const CAUSES = new Set(["copy-back", "hwdec-off", "software", "other-hwdec"]);

/** The cause of a `decoding` reason when the plugin knows it, else `null`. */
export function causeOf(reason: UpscalingReason | null | undefined): string | null {
  if (reason?.code !== "decoding" || reason.cause === undefined) return null;
  return CAUSES.has(reason.cause) ? reason.cause : null;
}

/** "1920×1080": a size is data, the same in every language. */
const size = (width: number, height: number) => `${width}×${height}`;

/**
 * The size the upscaler scales the video to: the video's display size
 * fitted into the area it is shown in (the aspect ratio stays).
 */
export function targetSize(
  video: { displayWidth: number; displayHeight: number },
  area: { width: number; height: number },
): string {
  const scale = Math.min(area.width / video.displayWidth, area.height / video.displayHeight);
  return size(Math.round(video.displayWidth * scale), Math.round(video.displayHeight * scale));
}

/** What fits the OSD's single line in a default-size window (coordinator's GUI check), in characters. */
export const OSD_BUDGET = { en: 80, zh: 40 };

/**
 * Reasons that can pass while the player runs: `set(true)` keeps the request
 * (`decoding`: the video is not decoded on the GPU that renders it, see
 * {@link causeOf}), and
 * `unchecked` only means the player has not checked the GPU yet. Neither greys
 * the item out. `rendering` while GPU rendering is still starting passes too
 * (see `blocked`).
 */
const PASSING = new Set(["decoding", "unchecked"]);

/**
 * Decoders of still-picture formats (`stats.video.decoder`, the short name):
 * an audio file's cover art is not a video worth waking the GPU for. JPEG is
 * not here: its decoder (`mjpeg`) also plays Motion JPEG video, and the
 * player does not say whether a track is cover art.
 */
const STILL = new Set(["png", "apng", "bmp", "webp", "tiff", "gif", "qoi"]);

/**
 * The same formats in `stats.video.codec`, mpv's long description ("PNG
 * (Portable Network Graphics) image"), for a player that leaves `decoder` out.
 */
const STILL_CODEC = /\b(a?png|bmp|webp|tiff|gif|qoi)\b|portable network graphics|windows bitmap|graphics interchange format/i;

/** The source shows moving video (not audio only, not a still cover picture). */
export function hasVideo(video: PlaybackStats["video"]): boolean {
  if (!video || video.width === null || video.height === null) return false;
  const decoder = video.decoder?.toLowerCase() ?? null;
  if (decoder !== null) return !STILL.has(decoder);
  return !STILL_CODEC.test(video.codec ?? "");
}

/**
 * RTX Upscale for Vestra Player (`zysilm.rtxupscale`): a Video menu item that turns NVIDIA RTX Video Super
 * Resolution on and off through `plugin.video.upscaling`, and a window that
 * does the same and shows how it runs.
 *
 * On Windows the player's GPU check wakes a sleeping discrete GPU, so nothing
 * asks the player at start-up: the state is read the first time the user
 * picks the item, or, when the user turned upscaling on in an earlier run,
 * when the first video plays (`set(true)` then checks). Elsewhere the player
 * answers `platform` without touching a GPU, so the plugin asks at once and
 * the item is greyed out from the start.
 */
export default async function activate(plugin: Plugin) {
  const { text, list } = plugin.i18n;
  const upscaling = plugin.video.upscaling;
  const store = plugin.storage.json<Settings>("upscaling", {
    defaults: DEFAULT_SETTINGS,
    validate: isSettings,
  });

  /** The player's last answer; `null` until the plugin first asked (no GPU check yet). */
  let state: UpscalingState | null = null;
  /** The rendering state behind a `rendering` reason; `null` when not read or not available. */
  let rendering: RenderingState | null = null;
  let busy = false;
  /** The saved choice still waits for the first video of this run. */
  let pending = store.value.on;
  let stopped = false;
  /** The second look for a video track (`applySaved`), and how to end the wait early. */
  let retry: { timer: ReturnType<typeof setTimeout>; done: () => void } | null = null;
  plugin.onDispose(() => {
    stopped = true;
    if (retry) {
      clearTimeout(retry.timer);
      retry.done();
      retry = null;
    }
  });

  const save = (patch: Partial<Settings>) => store.save({ ...store.value, ...patch });

  /** Show on the video; a refused text (too long, …) goes to the plugin log, never stops the plugin. */
  const osd = (message: Text) =>
    plugin.osd
      .show(
        // i18n-ignore: always a text() made by the caller
        message,
      )
      .catch((error: unknown) => console.error("upscaling: osd:", error));

  /** GPU rendering is still starting: the `rendering` reason passes by itself. */
  const starting = () => state?.reason?.code === "rendering" && rendering?.reason.code === "pending";

  /** The player said upscaling cannot work in this run (a reason that does not pass). */
  const blocked = () => {
    const reason = state?.reason;
    if (!state || state.available || !reason || PASSING.has(reason.code)) return false;
    // Without the rendering state the plugin cannot tell "starting" apart: leave the item usable.
    // GPU rendering drawing now: it finished starting between the two reads, so the reason has passed.
    if (reason.code === "rendering") return rendering !== null && !starting() && rendering.mode !== "gpu";
    return true;
  };

  /** Fixed for good on this system: the saved choice cannot matter here. */
  const permanent = () => state?.reason?.code === "platform";

  /** Why GPU rendering is off, for the menu item, following the player's own order of checks. */
  function renderingAdvice(): Text {
    const r = rendering;
    if (!r) return text("AI upscaling needs GPU rendering.");
    if (r.reason.code === "pending") return text("AI upscaling starts when GPU rendering is ready.");
    if (!r.gpu.available)
      return text(
        // TRANSLATORS: {} is the player's own message, in English.
        "AI upscaling needs GPU rendering, which cannot be turned on here: {}",
        [r.gpu.reason?.message ?? ""],
      );
    if (r.reason.code === "init-failed" || r.reason.code === "window-fallback")
      return text("GPU rendering stopped during this run: restart the player to use AI upscaling.");
    if (r.nextMode === "gpu") return text("GPU rendering is on from the next start: restart the player to use AI upscaling.");
    return text("AI upscaling needs GPU rendering: turn on Video ▸ GPU Rendering (Experimental), then restart the player.");
  }

  /**
   * Why a `decoding` reason holds upscaling back, by its cause (player
   * 0.6.0): the part after "AI upscaling waits:". A player without a cause,
   * or with a cause this plugin does not know, gives its message. The
   * plugins whose filters cause copy-back are named in the window's box
   * ({@link blockers}), not here.
   */
  function decodingCause(reason: UpscalingReason): Text | string {
    switch (causeOf(reason)) {
      case "copy-back":
        if ((reason.plugins ?? []).length > 0)
          return text(
            "other plugins' video filters need the frames in memory, so the video is not decoded on the GPU. Turn those filters off or reset them there; upscaling then starts by itself.",
          );
        return text(
          "hardware decoding copies the frames back to memory (copy-back), as the player's hardware decoding setting asks. Upscaling needs the video decoded on the GPU without copy-back.",
        );
      case "hwdec-off":
        return text("hardware decoding is off. Upscaling needs the video decoded on the GPU.");
      case "software":
        return text(
          "this video is decoded in software, for example a cover picture or a format the GPU cannot decode. It starts again with a video the GPU decodes.",
        );
      case "other-hwdec":
        return text("this video is decoded with another hardware decoder than the one upscaling needs.");
      default:
        return reason.message; // the player's own message, in English
    }
  }

  /**
   * A `decoding` reason for the window and the menu item: "waits" while the
   * user has upscaling on, "would wait" while it is off.
   */
  function waiting(reason: UpscalingReason, on = true): Text {
    return on
      ? text(
          // TRANSLATORS: {} is why (a translated clause, or the player's own message in English).
          "AI upscaling waits: {}",
          [decodingCause(reason)],
        )
      : text(
          // TRANSLATORS: {} is why (a translated clause, or the player's own message in English).
          "When turned on, AI upscaling will wait: {}",
          [decodingCause(reason)],
        );
  }

  /** The OSD after turning it on while a `decoding` reason holds it back: one short line by cause. */
  function onWaiting(reason: UpscalingReason): Text {
    switch (causeOf(reason)) {
      case "copy-back":
        // Copy-back without plugins: the user's own hardware decoding setting, no filter is on.
        return (reason.plugins ?? []).length > 0
          ? text("AI Upscaling: On, waits until other video filters are off")
          : text("AI Upscaling: On, waits: hardware decoding copies frames back");
      case "hwdec-off":
        return text("AI Upscaling: On, waits until hardware decoding is on");
      case "software":
        return text("AI Upscaling: On, waits: this video is decoded in software");
      case "other-hwdec":
        return text("AI Upscaling: On, waits: the video uses another hardware decoder");
      default:
        return text("AI Upscaling: On, waits until the video is decoded on the GPU");
    }
  }

  /**
   * Why it cannot work, for the menu item's reason: our advice plus the
   * player's English message, which names the GPUs. The OSD gets {@link brief}.
   */
  function why(current: UpscalingState): Text | null {
    const reason = current.reason;
    if (!reason) return null;
    const withMessage = (advice: Text) =>
      text(
        // TRANSLATORS: the first {} is our advice, the second the player's own message, in English.
        "{} ({})",
        [advice, reason.message],
      );
    switch (reason.code) {
      case "platform":
        return text("AI upscaling is not available on this system. It needs Windows and an NVIDIA RTX GPU.");
      case "no-gpu":
        return text("AI upscaling is not available on this computer. It needs an NVIDIA RTX GPU.");
      case "rendering":
        return withMessage(renderingAdvice());
      case "adapter":
        return withMessage(
          text(
            "The player runs on a GPU that cannot upscale: in Windows Settings ▸ System ▸ Display ▸ Graphics, choose the high-performance GPU for Vestra Player, then restart it.",
          ),
        );
      case "driver":
        return withMessage(text("The NVIDIA driver is too old for AI upscaling: update it to version 530 or newer."));
      case "decoding":
        return waiting(reason);
      default:
        // `gpu-unsupported` and any code of a newer player: the player's message says it all.
        return text(
          // TRANSLATORS: {} is the player's own message, in English.
          "AI upscaling is not available on this computer: {}",
          [reason.message],
        );
    }
  }

  /**
   * Why it cannot work, for the OSD: one short line (the OSD is a single line;
   * at most 80 characters in English, 40 in Chinese: `OSD_BUDGET`). The menu
   * item's reason has the details.
   */
  function brief(current: UpscalingState | null): Text {
    const reason = current?.reason;
    switch (reason?.code) {
      case "platform":
        return text("AI upscaling needs Windows and an NVIDIA RTX GPU");
      case "no-gpu":
        return text("AI upscaling needs an NVIDIA RTX GPU");
      case "driver":
        return text("AI upscaling needs NVIDIA driver 530 or newer");
      case "adapter":
        return text("AI upscaling: choose the NVIDIA GPU in Windows graphics settings");
      case "decoding":
        // Not reached today: `set(true)` keeps a `decoding` request instead of refusing it (the
        // OSD then comes from `onWaiting`). Kept short in case a player ever refuses it.
        return text("AI upscaling waits until the video is decoded on the GPU");
      case "rendering": {
        const r = rendering;
        if (!r) return text("AI upscaling needs GPU rendering");
        if (r.reason.code === "pending") return text("AI upscaling starts when GPU rendering is ready");
        if (!r.gpu.available) return text("AI upscaling needs GPU rendering, which is unavailable here");
        if (r.reason.code === "init-failed" || r.reason.code === "window-fallback" || r.nextMode === "gpu")
          return text("Restart the player to use AI upscaling");
        return text("AI upscaling: turn on Video ▸ GPU Rendering, then restart");
      }
      default:
        return text("AI upscaling is not available on this computer");
    }
  }

  /** Keep what the player said, except an `unchecked` answer to `set(false)`, which says nothing new. */
  async function remember(next: UpscalingState) {
    if (next.reason?.code === "unchecked") {
      if (state) state = { ...next, reason: state.reason, available: state.available };
      return;
    }
    state = next;
    // `rendering` covers several cases (not allowed here, restart pending, fell back, starting).
    rendering = next.reason?.code === "rendering" ? await plugin.rendering.state().catch(() => null) : null;
  }

  /** Once ever: the NVIDIA app's own switch must be on, and no program can read it. */
  async function noteOnce() {
    if (store.value.noted) return false;
    save({ noted: true });
    await osd(
      text(
        "AI Upscaling: On — also turn on Super Resolution in the NVIDIA app",
      ),
    );
    return true;
  }

  /**
   * Ask the player for upscaling; `false` when it cannot work in this run.
   * `interactive`: the user picked the item (always told); else the saved
   * choice at a start, told only when the reason is new.
   */
  async function turnOn(interactive: boolean): Promise<boolean> {
    try {
      await remember(await upscaling.set(true));
    } catch (error) {
      if ((error as PluginError).code !== "unsupported") throw error;
      // The check ran with `set(true)`: this answer is the cached one, no new GPU check.
      await remember(await upscaling.state());
      if (stopped) return false;
      const code = state?.reason?.code ?? null;
      if (interactive || code !== (store.value.refused ?? null)) {
        if (!interactive) save({ refused: code });
        await osd(brief(state));
      }
      return false;
    }
    if (stopped) return true;
    if (store.value.refused) save({ refused: null });
    if (state?.reason?.code === "decoding") {
      await osd(onWaiting(state.reason));
    } else if (state?.reason?.code === "rendering") {
      await osd(text("AI Upscaling: On, starts when GPU rendering is ready"));
    } else if (!(await noteOnce()) && interactive) {
      await osd(text("AI Upscaling: On"));
    }
    return true;
  }

  async function toggle() {
    if (busy) return;
    busy = true;
    pending = false;
    plugin.update();
    try {
      if (store.value.on) {
        save({ on: false, refused: null });
        await remember(await upscaling.set(false));
        await osd(text("AI Upscaling: Off"));
      } else if (await turnOn(true)) {
        save({ on: true });
      }
    } finally {
      busy = false;
      plugin.update();
    }
  }

  /** The saved choice, applied when the first video of this run plays (not for audio only). */
  async function applySaved(sourceId: number) {
    if (!pending || busy) return;
    let stats = await plugin.player.stats().catch(() => null);
    // The video track may be known a moment after the source is ready.
    if (stats && !hasVideo(stats.video)) {
      await new Promise<void>((resolve) => {
        retry = { timer: setTimeout(resolve, 1500), done: resolve };
      });
      retry = null;
      if (stopped || plugin.player.state.sourceId !== sourceId) return;
      stats = await plugin.player.stats().catch(() => null);
    }
    if (!stats || !hasVideo(stats.video) || !pending || busy || stopped) return;
    pending = false;
    busy = true;
    plugin.update();
    try {
      // A refusal keeps the saved choice: it applies again once the cause is fixed and the player restarts.
      await turnOn(false);
    } finally {
      busy = false;
      plugin.update();
    }
  }

  /** On each new source, read the state again once the plugin has asked before (the GPU check is cached). */
  async function refresh() {
    if (state === null || busy || permanent()) return;
    const next = await upscaling.state().catch(() => null);
    if (next && !stopped) {
      await remember(next);
      plugin.update();
    }
  }

  let lastSource: number | null = null;
  const onPlayer = () => {
    const player = plugin.player.state;
    if (stopped || player.phase !== "ready" || player.sourceId === lastSource) return;
    lastSource = player.sourceId;
    const failed = (error: unknown) => console.error("upscaling:", error);
    if (pending) void applySaved(player.sourceId).catch(failed);
    else void refresh().catch(failed);
  };
  plugin.player.onChange(onPlayer);

  plugin.commands.add({
    id: "upscaling",
    path: ["@video", TITLE],
    order: 461,
    group: "video-rendering",
    // The user's choice, as the GPU Rendering item shows its saved choice.
    checked: () => store.value.on && !permanent(),
    // Greyed out once the player said it cannot work here; a saved "on" stays usable so it can be turned off.
    enabled: () => (store.value.on && !permanent()) || !blocked(),
    busy: () => busy,
    reason: () => (busy ? null : state && blocked() ? why(state) : null),
    run: toggle,
  });

  // ------------------------------------------------------------------ the window
  /**
   * The AI Upscaling window: one button turns upscaling on and off, and the
   * rest shows how it runs, live while the window is open. The player's
   * change event keeps the plugin running, so it is listened to only while
   * the window is open.
   */
  const window = plugin.windows.create("upscale.slint");
  /** The `video.upscaling.changed` listener; only while the window is open. */
  let watch: Disposable | null = null;

  const unwatch = () => {
    const listener = watch;
    watch = null;
    return listener?.dispose();
  };

  /** "—": the player does not report it (older players) or there is nothing to show. */
  const NONE = "—";

  /** The headline: on or off, and whether the player asked the GPU to upscale. */
  function headline(): { status: Text; tone: number } {
    // Tones (upscale.slint): 0 off, 1 requested, 2 on but waiting or idle, 3 not available.
    const on = store.value.on && !permanent();
    if (busy) return { status: text("Please wait…"), tone: on ? 2 : 0 };
    if (state && blocked()) return { status: text("Not available"), tone: 3 };
    if (!on) return { status: text("Off"), tone: 0 };
    if (!state || !state.enabled) return { status: text("On: starts when a video plays"), tone: 2 };
    if (state.reason) return { status: text("On, waiting"), tone: 2 };
    if (state.requested) return { status: text("On: upscaling requested"), tone: 1 };
    if (state.video === null) return { status: text("On: no video"), tone: 2 };
    return { status: text("On: not needed for this video"), tone: 2 };
  }

  /** Why it works as it does, under the headline; "" when the headline says it all. */
  function detail(): Text | string {
    const current = state;
    if (!current) return "";
    const reason = current.reason;
    if (reason?.code === "unchecked") return "";
    // While off the player sends no changes (see `live` in the window): say what would happen.
    if (reason?.code === "decoding") return waiting(reason, store.value.on && !permanent());
    if (reason) return why(current) ?? reason.message;
    if (store.value.on && current.enabled && !current.requested && current.video)
      return text("The video is shown at its own size or smaller: upscaling starts when it is shown larger.");
    return "";
  }

  /** For copy-back caused by plugins' filters: whose filters, and what to do in each plugin. */
  function blockers(): { blocker: Text | string; advice: Text | TextList | string } {
    const reason = state?.reason;
    const plugins = causeOf(reason) === "copy-back" ? (reason?.plugins ?? []) : [];
    if (plugins.length === 0) return { blocker: "", advice: "" };
    const steps = plugins.map(({ id, name }) =>
      id === PICTURE_ADJUSTMENTS
        ? text(
            // TRANSLATORS: {} is the plugin's name as the player reports it (Picture Adjustments, the built-in plugin).
            "{}: press Q (Video ▸ Reset) to reset the picture, and turn off its other video effects.",
            [name],
          )
        : text(
            // TRANSLATORS: {} is the plugin's name as the player reports it.
            "{}: turn off or reset its video filters there.",
            [name],
          ),
    );
    return {
      blocker: text(
        // TRANSLATORS: {} is one or more plugin names, as their manifests give them.
        "Upscaling waits for the video filters of: {}",
        [list(plugins.map((p) => p.name))],
      ),
      advice: list(steps, "lines"),
    };
  }

  /** What the player reports about the upscaler; "—" for what an older player leaves out. */
  function monitor() {
    const current = state;
    const video = current?.video;
    const area = current?.area;
    const factor = current?.factor ?? null;
    const source =
      video === undefined
        ? NONE
        : video === null
          ? text("No video")
          : video.width === video.displayWidth && video.height === video.displayHeight
            ? size(video.width, video.height)
            : text(
                // TRANSLATORS: the stored size, then the size the video is meant to be shown at.
                "{} (shown as {})",
                [size(video.width, video.height), size(video.displayWidth, video.displayHeight)],
              );
    return {
      // The monitoring fields came with player 0.6.0; `inChain` is always there from it on.
      reported: current !== null && current.inChain !== undefined,
      source,
      target: video && area && factor !== null ? targetSize(video, area) : NONE,
      factor: factor !== null ? `×${factor.toFixed(2)}` : NONE,
      area: area ? size(area.width, area.height) : NONE,
      gpu: current?.gpu === undefined ? NONE : current.gpu === null ? text("Unknown") : current.gpu,
      decoding:
        current?.hwdecCurrent === undefined || current.hwdecCurrent === null
          ? NONE
          : current.hwdecCurrent === "no"
            ? text("Software (no)")
            : current.hwdecCurrent,
      chain: current?.inChain === undefined ? NONE : current.inChain ? text("Yes") : text("No"),
    };
  }

  window.bind(() => {
    const { status, tone } = headline();
    return {
      on: store.value.on && !permanent(),
      // The player sends changes only while some plugin has upscaling on; the window does not poll.
      live: store.value.on && !permanent(),
      canToggle: !busy && ((store.value.on && !permanent()) || !blocked()),
      status,
      tone,
      detail: detail(),
      ...blockers(),
      ...monitor(),
    };
  });
  window.on("toggle", () => toggle());
  window.on("closeWindow", async () => {
    await unwatch();
    // `missing` when the user closed it with the title bar just before.
    await window.close().catch(() => {});
  });
  window.onClose(() => unwatch());

  /** Open the window: listen for changes while it is open, then read the state once. */
  async function openWindow() {
    watch ??= upscaling.onChange((next) => {
      if (stopped || !watch) return;
      void remember(next)
        .then(() => plugin.update())
        .catch((error: unknown) => console.error("upscaling: change:", error));
    });
    try {
      await window.show();
    } catch (error) {
      // No window, no listener: it would keep the plugin running for nothing.
      if (!window.opened) await unwatch();
      throw error;
    }
    // The first read checks the GPU (as the first pick of the menu item does).
    const next = await upscaling.state().catch(() => null);
    if (next && !stopped && watch) {
      await remember(next);
      plugin.update();
    }
  }

  plugin.commands.add({
    id: "upscaling.window",
    path: ["@video", WINDOW_TITLE],
    order: 462,
    group: "video-rendering",
    run: openWindow,
  });

  // Not Windows: the player answers `platform` without touching a GPU, so the item is greyed from the start.
  const system = await plugin.app.system().catch(() => null);
  if (system && system.os !== "windows") {
    const answer = await upscaling.state().catch(() => null);
    if (answer) await remember(answer);
    if (permanent()) pending = false;
    plugin.update();
  }

  // Loaded while a video already plays (installed or reloaded mid-playback).
  onPlayer();
}
