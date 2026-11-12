import type { MotionMode, MotionReason, MotionState, Plugin, PluginError } from "@vestra-player/sdk";

/** The one menu item: it opens the window (Video menu, beside Shader Upscaling…). */
export const WINDOW_TITLE = "AMD Motion Smoothing…";

/** The modes in the window's drop-down order, with their on-screen texts. */
export const MODES = [
  { mode: "off", title: "Off", osd: "AMD motion smoothing: off" },
  { mode: "double", title: "Double Frame Rate", osd: "AMD motion smoothing: double frame rate" },
  { mode: "display", title: "Match Display", osd: "AMD motion smoothing: match display" },
] as const satisfies readonly { mode: MotionMode; title: string; osd: string }[];

/** What the plugin saves: the chosen mode (off by default). */
export interface Settings {
  mode: MotionMode;
}
export const DEFAULT_SETTINGS: Settings = { mode: "off" };
export const isSettings = (value: unknown): value is Settings =>
  !!value &&
  typeof value === "object" &&
  MODES.some((m) => m.mode === (value as { mode?: unknown }).mode);

/** Reasons that hold for the whole player run: the window says the plugin cannot work here. */
const FIXED = ["engine", "platform", "no-gpu", "runtime", "filter"];

/**
 * AMD Motion Smoothing (`zysilm.amdmotion`): the player's motion smoothing
 * with AMD AMF's frame-rate converter (`plugin.video.motion("amd")`, player
 * 0.8.1), which makes real in-between frames on an AMD Radeon GPU. One
 * menu item, Video ▸ AMD Motion Smoothing…, opens a window with the mode
 * (Off, Double Frame Rate, Match Display), what it does and why a mode
 * cannot work. The player owns the converter: the AMD check, the size and
 * rate rules per renderer, copy-back decoding and the fallback when the GPU
 * falls behind; the plugin asks for a mode and shows the player's reasons.
 *
 * Off by default (doubling makes film look like video). The chosen mode is
 * saved and asked for again at each start. While a mode is on the request
 * keeps the plugin running; while off it holds nothing.
 */
export default async function activate(plugin: Plugin) {
  const { text } = plugin.i18n;
  const motion = plugin.video.motion("amd");
  const store = plugin.storage.json<Settings>("settings", {
    defaults: DEFAULT_SETTINGS,
    validate: isSettings,
  });
  /** The player's state as last read; `null` until then. */
  let state: MotionState | null = null;
  let busy = false;
  const window = plugin.windows.create("motion.slint");

  const reasonOf = (mode: MotionMode): MotionReason | null =>
    state === null || mode === "off" ? null : mode === "display" ? state.display : state.double;
  const fps = (value: number | null) => (value === null ? "" : String(Math.round(value * 100) / 100));

  /** The status line, its tone (0 off, 1 running, 2 waiting, 3 not available) and the reason under it. */
  const status = () => {
    const mode = store.value.mode;
    if (busy) return { status: text("Switching…"), tone: 2, detail: "" };
    if (state === null) return { status: mode === "off" ? text("Off") : text("On"), tone: mode === "off" ? 0 : 2, detail: "" };
    const fixed = state.double && FIXED.includes(state.double.code) ? state.double : null;
    if (fixed) return { status: text("Not available on this computer"), tone: 3, detail: fixed.message };
    if (mode === "off") return { status: text("Off"), tone: 0, detail: "" };
    if (state.active !== "off") {
      const from = fps(state.sourceFps);
      const to = fps(state.outputFps ?? (state.sourceFps ?? 0) * 2);
      return {
        status: state.gpu ? text("On: {} → {} fps on {}", [from, to, state.gpu]) : text("On: {} → {} fps", [from, to]),
        tone: 1,
        detail: state.searchMode === "performance" ? text("The GPU uses the faster motion search to keep up.") : "",
      };
    }
    const reason = reasonOf(mode);
    if (reason) return { status: text("Waiting"), tone: 2, detail: reason.message };
    return { status: text("On: applies when a video plays"), tone: 2, detail: "" };
  };

  window.bind(() => ({
    modes: MODES.map((m) => text(m.title)),
    modeIndex: MODES.findIndex((m) => m.mode === store.value.mode),
    busy,
    ...status(),
  }));

  const read = async () => {
    state = await motion.state().catch(() => state);
    plugin.update();
  };

  const choose = async (mode: MotionMode) => {
    if (busy || mode === store.value.mode) return plugin.update();
    busy = true;
    plugin.update();
    try {
      try {
        state = await motion.set(mode);
      } catch (error) {
        // `unsupported`: it cannot work in this run (no AMD GPU, Match Display without GPU rendering).
        const refused = error as PluginError;
        state = await motion.state().catch(() => state);
        await plugin.osd.show("AMD motion smoothing unavailable: {}", [reasonOf(mode)?.message ?? refused.message]);
        return;
      }
      store.save({ mode });
      const reason = reasonOf(mode);
      const { osd } = MODES.find((m) => m.mode === mode)!;
      if (reason && state.active === "off") await plugin.osd.show("{} (waiting: {})", [text(osd), reason.message]);
      else await plugin.osd.show(osd);
    } finally {
      busy = false;
      plugin.update();
    }
  };

  window.on("pickMode", (index: number) => {
    const picked = MODES[index];
    if (picked) void choose(picked.mode);
    else plugin.update();
  });

  // While the window is open the state follows the player (a listener keeps the plugin running, so only then).
  let following: { dispose(): unknown } | null = null;
  const unfollow = () => {
    void following?.dispose();
    following = null;
  };
  window.onClose(unfollow);
  window.on("closeWindow", () => {
    unfollow();
    // `missing` when the user closed it with the title bar just before.
    return window.close().catch(() => {});
  });
  async function openWindow() {
    await window.show();
    following ??= motion.onChange((next) => {
      state = next;
      plugin.update();
    });
    await read();
  }

  plugin.commands.add({
    id: "amdmotion.window",
    path: ["@video", WINDOW_TITLE],
    order: 464,
    group: "video-rendering",
    run: openWindow,
  });

  // The saved mode: asked for again for this run (refused where it cannot work: the window says why).
  if (store.value.mode !== "off")
    await motion.set(store.value.mode).then(
      (next) => {
        state = next;
      },
      () => read(),
    );
}
