import type { Plugin, PluginError, Text, UpscalingState } from "@vestra-player/sdk";

/** What the plugin keeps across restarts (`upscaling.json` in its data directory). */
export interface Settings {
  /** The user turned AI upscaling on (and has not turned it off). */
  on: boolean;
  /** The note about the NVIDIA app's Super Resolution switch was shown once. */
  noted: boolean;
}

export const DEFAULT_SETTINGS: Settings = { on: false, noted: false };

export const isSettings = (value: unknown): value is Settings =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Settings).on === "boolean" &&
  typeof (value as Settings).noted === "boolean";

export const TITLE = "AI Upscaling (RTX Video Super Resolution)";

/** One line of at most `max` characters. */
const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join("")}…` : flat;
};

/**
 * Reasons that can pass while the player runs: `set(true)` keeps the request
 * (`decoding`: another video filter needs the frames in memory), and
 * `unchecked` only means the player has not checked the GPU yet. Neither greys
 * the item out.
 */
const PASSING = new Set(["decoding", "unchecked"]);

/**
 * VestraUpscale: one Video menu item that turns NVIDIA RTX Video Super
 * Resolution on and off through `plugin.video.upscaling`.
 *
 * The player's GPU check wakes a sleeping discrete GPU, so nothing asks the
 * player at start-up: the state is read the first time the user picks the
 * item, or, when the user turned upscaling on in an earlier run, when the
 * first video plays (`set(true)` then checks).
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
  let busy = false;
  /** The saved choice still waits for the first playback of this run. */
  let pending = store.value.on;
  let stopped = false;
  plugin.onDispose(() => {
    stopped = true;
  });

  const save = (patch: Partial<Settings>) => store.save({ ...store.value, ...patch });

  /** The player said upscaling cannot work in this run (a reason that does not pass). */
  const blocked = () => state !== null && !state.available && state.reason !== null && !PASSING.has(state.reason.code);

  /**
   * Our words for why it cannot work. `detail` (the menu item's reason) adds
   * the player's English message, which names the GPUs; the OSD (at most 200
   * characters) gets the advice alone, or a shortened message.
   */
  function why(current: UpscalingState, detail: boolean): Text | null {
    const reason = current.reason;
    if (!reason) return null;
    const message = detail ? reason.message : clip(reason.message, 140);
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
      case "no-gpu":
        return text("AI upscaling is not available here. It needs Windows and an NVIDIA RTX GPU.");
      case "rendering":
        return withMessage(text("Needs GPU rendering: turn on Video ▸ GPU Rendering (Experimental), then restart the player."));
      case "adapter":
        return withMessage(
          text(
            "The player runs on a GPU that cannot upscale: in Windows Settings ▸ System ▸ Display ▸ Graphics, choose the high-performance GPU for Vestra Player, then restart it.",
          ),
        );
      case "driver":
        return withMessage(text("The NVIDIA driver is too old for AI upscaling: update it to 531.18 or newer."));
      case "decoding":
        return text("AI upscaling is paused while another video filter is active; it comes back when that filter is off.");
      default:
        // `gpu-unsupported` and any code of a newer player: the player's message says it all.
        return text(
          // TRANSLATORS: {} is the player's own message, in English.
          "AI upscaling is not available here: {}",
          [message],
        );
    }
  }

  /** Keep what the player said, except an `unchecked` answer to `set(false)`, which says nothing new. */
  function remember(next: UpscalingState) {
    if (next.reason?.code === "unchecked") {
      if (state) state = { ...next, reason: state.reason, available: state.available };
      return;
    }
    state = next;
  }

  /** Once ever: the NVIDIA app's own switch must be on, and no program can read it. */
  async function noteOnce() {
    if (store.value.noted) return false;
    save({ noted: true });
    await plugin.osd
      .show(
        "AI upscaling on. Also turn on Super Resolution in the NVIDIA app (System ▸ Video ▸ RTX Video Enhancement): the player cannot see that switch.",
      )
      .catch(() => {});
    return true;
  }

  /** Ask the player for upscaling; `false` when it cannot work in this run. */
  async function turnOn(interactive: boolean): Promise<boolean> {
    try {
      remember(await upscaling.set(true));
    } catch (error) {
      if ((error as PluginError).code !== "unsupported") throw error;
      // The check ran with `set(true)`: this answer is the cached one, no new GPU check.
      remember(await upscaling.state());
      const reason = state ? why(state, false) : null;
      if (interactive || reason) await plugin.osd.show(reason ?? text("AI upscaling is not available here.")).catch(() => {});
      return false;
    }
    if (stopped) return true;
    if (state?.reason?.code === "decoding") {
      await plugin.osd
        .show("AI upscaling is on; it starts when no other video filter needs the picture in memory.")
        .catch(() => {});
    } else if (state?.reason?.code === "rendering") {
      await plugin.osd.show("AI upscaling is on; it starts when GPU rendering is ready.").catch(() => {});
    } else if (!(await noteOnce()) && interactive) {
      await plugin.osd.show("AI upscaling on").catch(() => {});
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
        save({ on: false });
        remember(await upscaling.set(false));
        await plugin.osd.show("AI upscaling off").catch(() => {});
      } else if (await turnOn(true)) {
        save({ on: true });
      }
    } finally {
      busy = false;
      plugin.update();
    }
  }

  /** The saved choice, applied when the first video of this run plays. */
  async function applySaved() {
    if (!pending || busy) return;
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

  /** On each new video, read the state again once the plugin has asked before (the GPU check is cached). */
  async function refresh() {
    if (state === null || busy) return;
    const next = await upscaling.state().catch(() => null);
    if (next && !stopped) {
      remember(next);
      plugin.update();
    }
  }

  let lastSource: string | null = null;
  const onPlayer = () => {
    const player = plugin.player.state;
    if (player.phase !== "ready" || player.source === lastSource) return;
    lastSource = player.source;
    if (pending) void applySaved().catch((error: unknown) => console.error("upscaling:", error));
    else void refresh();
  };
  plugin.player.onChange(onPlayer);

  plugin.commands.add({
    id: "upscaling",
    path: ["@video", TITLE],
    order: 461,
    group: "video-rendering",
    // The user's choice, as the GPU Rendering item shows its saved choice.
    checked: () => store.value.on,
    // Greyed out once the player said it cannot work here; a saved "on" stays usable so it can be turned off.
    enabled: () => store.value.on || !blocked(),
    busy: () => busy,
    reason: () => (busy ? null : state && blocked() ? why(state, true) : null),
    run: toggle,
  });

  // Loaded while a video already plays (installed or reloaded mid-playback).
  onPlayer();
}
