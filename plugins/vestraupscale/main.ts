import type { PlaybackStats, Plugin, PluginError, RenderingState, Text, UpscalingState } from "@vestra-player/sdk";

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

/** What fits the OSD's single line in a default-size window (coordinator's GUI check), in characters. */
export const OSD_BUDGET = { en: 80, zh: 40 };

/**
 * Reasons that can pass while the player runs: `set(true)` keeps the request
 * (`decoding`: another video filter needs the frames in memory), and
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
 * VestraUpscale: one Video menu item that turns NVIDIA RTX Video Super
 * Resolution on and off through `plugin.video.upscaling`.
 *
 * On Windows the player's GPU check wakes a sleeping discrete GPU, so nothing
 * asks the player at start-up: the state is read the first time the user
 * picks the item, or, when the user turned upscaling on in an earlier run,
 * when the first video plays (`set(true)` then checks). Elsewhere the player
 * answers `platform` without touching a GPU, so the plugin asks at once and
 * the item is greyed out from the start.
 */
export default async function activate(plugin: Plugin) {
  const { text } = plugin.i18n;
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
        return text("AI upscaling is paused while another video filter is active; it comes back when that filter is off.");
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
        return text("AI upscaling paused while another video filter is on");
      case "rendering": {
        const r = rendering;
        if (!r) return text("AI upscaling needs GPU rendering");
        if (r.reason.code === "pending") return text("AI upscaling starts when GPU rendering is ready");
        if (!r.gpu.available) return text("AI upscaling needs GPU rendering, unavailable here");
        if (r.reason.code === "init-failed" || r.reason.code === "window-fallback" || r.nextMode === "gpu")
          return text("Restart the player to use AI upscaling");
        return text("AI upscaling: turn on Video ▸ GPU Rendering, then restart");
      }
      default:
        return text("AI upscaling is not available here (details in the Video menu)");
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
      await osd(text("AI Upscaling: On, waits until other video filters are off"));
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
