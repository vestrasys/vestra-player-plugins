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

/** The player's OSD takes at most 200 characters; the player's own messages are cut to this. */
const OSD_DETAIL = 120;

/** One line of at most `max` characters. */
export const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join("")}…` : flat;
};

/**
 * Reasons that can pass while the player runs: `set(true)` keeps the request
 * (`decoding`: another video filter needs the frames in memory), and
 * `unchecked` only means the player has not checked the GPU yet. Neither greys
 * the item out. `rendering` while GPU rendering is still starting passes too
 * (see `blocked`).
 */
const PASSING = new Set(["decoding", "unchecked"]);

/** Codecs of still pictures: an audio file's cover art is not a video worth waking the GPU for. */
const STILL = new Set(["png", "bmp", "webp", "tiff", "gif"]);

/** The source shows moving video (not audio only, not cover art). */
export function hasVideo(video: PlaybackStats["video"]): boolean {
  if (!video || video.width === null || video.height === null) return false;
  const codec = video.codec?.toLowerCase() ?? "";
  if (STILL.has(codec)) return false;
  // Cover art as JPEG: mjpeg without a frame rate (or a single frame per second).
  if (codec === "mjpeg" && (video.fps === null || video.fps <= 1)) return false;
  return true;
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
  plugin.onDispose(() => {
    stopped = true;
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
    if (reason.code === "rendering") return rendering !== null && !starting();
    return true;
  };

  /** Fixed for good on this system: the saved choice cannot matter here. */
  const permanent = () => state?.reason?.code === "platform";

  /** Why GPU rendering is off, in our words, following the player's own order of checks. */
  function renderingAdvice(detail: boolean): Text {
    const r = rendering;
    if (!r) return text("AI upscaling needs GPU rendering.");
    if (r.reason.code === "pending") return text("AI upscaling starts when GPU rendering is ready.");
    if (!r.gpu.available) {
      const why = r.gpu.reason?.message ?? "";
      return text(
        // TRANSLATORS: {} is the player's own message, in English.
        "AI upscaling needs GPU rendering, which cannot be turned on here: {}",
        [detail ? why : clip(why, OSD_DETAIL)],
      );
    }
    if (r.reason.code === "init-failed" || r.reason.code === "window-fallback")
      return text("GPU rendering stopped during this run: restart the player to use AI upscaling.");
    if (r.nextMode === "gpu") return text("GPU rendering is on from the next start: restart the player to use AI upscaling.");
    return text("AI upscaling needs GPU rendering: turn on Video ▸ GPU Rendering (Experimental), then restart the player.");
  }

  /**
   * Our words for why it cannot work. `detail` (the menu item's reason) adds
   * the player's English message, which names the GPUs; the OSD (at most 200
   * characters) gets the advice alone, or a shortened message.
   */
  function why(current: UpscalingState, detail: boolean): Text | null {
    const reason = current.reason;
    if (!reason) return null;
    const message = detail ? reason.message : clip(reason.message, OSD_DETAIL);
    const withMessage = (advice: Text) =>
      detail
        ? text(
            // TRANSLATORS: the first {} is our advice, the second the player's own message, in English.
            "{} ({})",
            [advice, message],
          )
        : advice;
    switch (reason.code) {
      case "platform":
        return text("AI upscaling is not available on this system. It needs Windows and an NVIDIA RTX GPU.");
      case "no-gpu":
        return text("AI upscaling is not available on this computer. It needs an NVIDIA RTX GPU.");
      case "rendering":
        return withMessage(renderingAdvice(detail));
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
          [message],
        );
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
        "AI Upscaling: On. Also turn on Super Resolution in the NVIDIA app (System ▸ Video ▸ RTX Video Enhancement): the player cannot see that switch.",
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
        await osd((state && why(state, false)) ?? text("AI upscaling is not available on this computer."));
      }
      return false;
    }
    if (stopped) return true;
    if (store.value.refused) save({ refused: null });
    if (state?.reason?.code === "decoding") {
      await osd(text("AI Upscaling: On. It starts when no other video filter needs the picture in memory."));
    } else if (state?.reason?.code === "rendering") {
      await osd(text("AI Upscaling: On. It starts when GPU rendering is ready."));
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
      await new Promise((resolve) => setTimeout(resolve, 1500));
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
    reason: () => (busy ? null : state && blocked() ? why(state, true) : null),
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
