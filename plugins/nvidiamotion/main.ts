import type { MotionMode, MotionReason, MotionState, Plugin, PluginError } from "@vestra-player/sdk";

/** The one menu item: it opens the window (Video menu, beside Shader Upscaling…). */
export const WINDOW_TITLE = "NVIDIA Motion Smoothing…";

/**
 * The modes in the window's drop-down order, with their on-screen texts and
 * the title of the command that chooses each one (`command`: the command
 * palette and Ask Vestra read it as `NVIDIA Motion Smoothing: <command>`,
 * so it carries the words people ask with).
 */
export const MODES = [
  { mode: "off", title: "Off", osd: "NVIDIA motion smoothing: off", command: "Off" },
  {
    mode: "double",
    title: "Double Frame Rate",
    osd: "NVIDIA motion smoothing: double frame rate",
    command: "Double Frame Rate (Smoother Video)",
  },
  {
    mode: "display",
    title: "Match Display",
    osd: "NVIDIA motion smoothing: match display",
    command: "Match Display (Smoothest Motion)",
  },
] as const satisfies readonly { mode: MotionMode; title: string; osd: string; command: string }[];

/** The window command's id; the mode commands name it as their home. */
export const WINDOW_ID = "nvidiamotion.window";
/** The mode commands' category: their palette rows read `NVIDIA Motion Smoothing: …`. */
export const CATEGORY = "NVIDIA Motion Smoothing";
/** The command that chooses a mode: `nvidiamotion.off`, `nvidiamotion.double`, `nvidiamotion.display`. */
export const modeCommandId = (mode: MotionMode) => `nvidiamotion.${mode}`;

/** What the plugin saves: the chosen mode (off by default). */
export interface Settings {
  mode: MotionMode;
}
export const DEFAULT_SETTINGS: Settings = { mode: "off" };
export const isSettings = (value: unknown): value is Settings =>
  !!value &&
  typeof value === "object" &&
  MODES.some((m) => m.mode === (value as { mode?: unknown }).mode);

/** How often the open window reads the player's dropped frames while the converter runs. */
export const DROP_CHECK_MS = 2000;
/** The span the drop rate is judged over: the last samples covering it. */
export const DROP_WINDOW_MS = 6000;
/** Sustained dropping: at least this many frames a second over the span (60 → 1 of 60 lost). */
export const DROPS_PER_SECOND = 1;
/**
 * After the converter (re)starts, its first frames come in a burst that
 * can span two readings (measured 2026-11-23: NVIDIA 4K30 dropped 42 in
 * its first 5 s, then none; AMD 4K24 alike): the readings of this long
 * after a start are not judged.
 */
export const SETTLE_MS = DROP_WINDOW_MS;

/**
 * What starts the converter again when it changes: running or not and the
 * mode, the fallback step (`searchMode`), the video (its rate). A new
 * video or a seek also shows as mpv's dropped count falling.
 */
export const runKey = (state: Pick<MotionState, "active" | "searchMode" | "sourceFps">) =>
  `${state.active}|${state.searchMode}|${state.sourceFps}`;

/** One reading of `player.stats().framesDropped`. */
export interface DropSample {
  at: number;
  dropped: number;
}

/**
 * Whether frames are being dropped steadily: the samples span at least
 * {@link DROP_WINDOW_MS}, the dropped count rose by
 * {@link DROPS_PER_SECOND} a second or more over the newest such span, and
 * it rose in at least two readings in a row within it. One burst (a seek,
 * the decoder reopening, a resize, the converter starting) falls within one
 * reading and is not steady. A seek or a new video resets mpv's count: a
 * fall starts afresh.
 */
export function dropping(samples: readonly DropSample[]): boolean {
  const last = samples.at(-1);
  if (!last) return false;
  const from = samples.findLastIndex((s) => last.at - s.at >= DROP_WINDOW_MS);
  const first = samples[from];
  if (!first || last.dropped < first.dropped) return false;
  if ((last.dropped - first.dropped) / ((last.at - first.at) / 1000) < DROPS_PER_SECOND) return false;
  const span = samples.slice(from);
  return span.some((s, i) => i >= 2 && s.dropped > span[i - 1]!.dropped && span[i - 1]!.dropped > span[i - 2]!.dropped);
}

/** Reasons that hold for the whole player run: the window says the plugin cannot work here. */
const FIXED = ["engine", "platform", "no-gpu", "runtime", "filter"];
/**
 * Reasons `set` refuses for the whole run, which grey a mode command out:
 * the fixed ones and `rendering` (Match Display with software rendering),
 * except while GPU rendering is still starting.
 */
const REFUSED = [...FIXED, "rendering"];

/**
 * NVIDIA Motion Smoothing (`zysilm.nvidiamotion`): the player's motion
 * smoothing with NVIDIA's frame-rate converter (`plugin.video.motion("nvidia")`:
 * FFmpeg's `fruc_vulkan`, the optical flow hardware of GeForce RTX 30 and
 * newer GPUs), which makes real in-between frames. The twin of AMD Motion
 * Smoothing (`zysilm.amdmotion`): one menu item, Video ▸ NVIDIA Motion
 * Smoothing…, opens a window with the mode (Off, Double Frame Rate, Match
 * Display), what it does and why a mode cannot work. The player owns the
 * converter: the NVIDIA check, its settings (optical flow quality and grid,
 * faster for 4K), the size and rate rules per renderer, copy-back decoding
 * and the fallback when the GPU falls behind; the plugin asks for a mode and
 * shows the player's reasons. A player before the NVIDIA engine answers
 * `engine` for every mode: the window says it is not available.
 *
 * Three commands outside the menus choose a mode in one step from the
 * command palette and Ask Vestra (Off, Double Frame Rate, Match Display:
 * radio items, checked on the saved mode). A mode that cannot work on this
 * computer (no RTX 30 or newer GPU, Match Display with software rendering)
 * is greyed out with the player's reason, so Ask Vestra picks the engine of
 * the user's GPU. Their state is the plugin's own (the mode, and the
 * player's motion state, which `plugin.when` cannot name): values set with
 * `Command.set` whenever the state is read (at start, after a choice, while
 * the window follows the player). The reasons that grey them hold for the
 * run, so nothing needs to listen while the window is closed.
 *
 * Off by default (doubling makes film look like video). The chosen mode is
 * saved and asked for again at each start. While a mode is on the request
 * keeps the plugin running; while off it holds nothing.
 */
export default async function activate(plugin: Plugin) {
  const { text } = plugin.i18n;
  const motion = plugin.video.motion("nvidia");
  const store = plugin.storage.json<Settings>("settings", {
    defaults: DEFAULT_SETTINGS,
    validate: isSettings,
  });
  /** The player's state as last read; `null` until then. */
  let state: MotionState | null = null;
  /** Dropped-frame readings while the window is open and the converter runs; the hint they lead to, by renderer ("" = none). */
  let drops: DropSample[] = [];
  let hint: "" | "gpu" | "software" = "";
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
        detail: state.searchMode === "performance" ? text("The GPU uses the faster optical flow setting to keep up.") : "",
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
    // What helps: with GPU rendering, Double Frame Rate instead of Match
    // Display (when that is the mode) or a lower resolution.
    hint:
      hint === "gpu"
        ? store.value.mode === "display"
          ? text("Frames are being dropped: a lower resolution or Double Frame Rate instead of Match Display helps.")
          : text("Frames are being dropped: a lower resolution helps.")
        : hint === "software"
          ? text("Frames are being dropped: rendering on the CPU cannot keep up; GPU Rendering (Picture ▸ Rendering) or a lower resolution helps.")
          : "",
  }));

  /**
   * While the window is open and the converter runs: read the player's
   * dropped frames every {@link DROP_CHECK_MS} and, when they are dropped
   * steadily, show a hint (what helps depends on the renderer). Only the
   * open window reads; nothing runs while it is closed.
   */
  let checking: ReturnType<typeof setInterval> | null = null;
  /** The converter run the readings belong to ({@link runKey}) and when its start-up burst is over. */
  let run: string | null = null;
  let settled = 0;
  const stopChecking = () => {
    if (checking) clearInterval(checking);
    checking = null;
    drops = [];
    run = null;
    if (hint) {
      hint = "";
      plugin.update();
    }
  };
  const checkDrops = async () => {
    if (!following || state?.active === "off" || state === null) return stopChecking();
    const stats = await plugin.player.stats().catch(() => null);
    if (stats === null || stats.framesDropped === null) return;
    const now = Date.now();
    // A (re)start: its burst is not judged; the readings start afresh after it.
    const key = runKey(state);
    if (key !== run || stats.framesDropped < (drops.at(-1)?.dropped ?? 0)) {
      run = key;
      settled = now + SETTLE_MS;
      drops = [];
    }
    if (now < settled) return;
    drops = [...drops.filter((s) => now - s.at <= DROP_WINDOW_MS + DROP_CHECK_MS), { at: now, dropped: stats.framesDropped }];
    // Shown while frames are dropped steadily; cleared after a full span without.
    let next = hint;
    if (dropping(drops)) next = (await plugin.rendering.state().catch(() => null))?.mode === "gpu" ? "gpu" : "software";
    else if (drops.at(-1)!.at - drops[0]!.at >= DROP_WINDOW_MS) next = "";
    if (next !== hint) {
      hint = next;
      plugin.update();
    }
  };
  // The plugin stopping ends the readings too.
  plugin.onDispose(() => {
    if (checking) clearInterval(checking);
    checking = null;
  });
  const followDrops = () => {
    if (following && state?.active && state.active !== "off") checking ??= setInterval(() => void checkDrops(), DROP_CHECK_MS);
    else stopChecking();
  };

  /** GPU rendering is still starting: a `rendering` reason then passes ({@link REFUSED}). */
  let renderingStarting = false;
  /** Why a mode cannot work on this computer in this run (its command is greyed out), else `null`. */
  const refusal = (mode: MotionMode): MotionReason | null => {
    const reason = reasonOf(mode);
    if (!reason || !REFUSED.includes(reason.code)) return null;
    return reason.code === "rendering" && renderingStarting ? null : reason;
  };
  const modeCommands = MODES.map((m) =>
    plugin.commands.add({
      id: modeCommandId(m.mode),
      title: m.command,
      category: CATEGORY,
      home: WINDOW_ID,
      radio: true,
      checked: store.value.mode === m.mode,
      run: () => choose(m.mode),
    }),
  );
  /** The mode commands' check marks and greying: the saved mode and the state as last read. */
  const syncCommands = () =>
    MODES.forEach((m, i) => {
      const reason = refusal(m.mode);
      modeCommands[i]!.set({
        checked: store.value.mode === m.mode,
        enabled: reason === null,
        reason: reason ? text("Not available: {}", [reason.message]) : null,
      });
    });
  /** Take a new state; whether GPU rendering is starting matters only for a `rendering` reason. */
  const took = async (next: MotionState) => {
    state = next;
    if (next.double?.code === "rendering" || next.display?.code === "rendering")
      renderingStarting = (await plugin.rendering.state().catch(() => null))?.reason.code === "pending";
    syncCommands();
    return next;
  };

  const read = async () => {
    const next = await motion.state().catch(() => null);
    if (next) await took(next);
    plugin.update();
  };

  const choose = async (mode: MotionMode) => {
    if (busy || mode === store.value.mode) return plugin.update();
    busy = true;
    plugin.update();
    try {
      let next: MotionState;
      try {
        next = await took(await motion.set(mode));
      } catch (error) {
        // `unsupported`: it cannot work in this run (no RTX 30 or newer GPU, Match Display without GPU rendering).
        const refused = error as PluginError;
        await read();
        await plugin.osd.show("NVIDIA motion smoothing unavailable: {}", [reasonOf(mode)?.message ?? refused.message]);
        return;
      }
      store.save({ mode });
      syncCommands();
      followDrops();
      const reason = reasonOf(mode);
      const { osd } = MODES.find((m) => m.mode === mode)!;
      if (reason && next.active === "off") await plugin.osd.show("{} (waiting: {})", [text(osd), reason.message]);
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
    stopChecking();
  };
  window.onClose(unfollow);
  window.on("closeWindow", () => {
    unfollow();
    // `missing` when the user closed it with the title bar just before.
    return window.close().catch(() => {});
  });
  async function openWindow() {
    await window.show();
    following ??= motion.onChange(async (next) => {
      await took(next);
      followDrops();
      plugin.update();
    });
    await read();
    followDrops();
  }

  plugin.commands.add({
    id: WINDOW_ID,
    path: ["@video", WINDOW_TITLE],
    order: 465,
    group: "video-rendering",
    run: openWindow,
  });

  // The saved mode: asked for again for this run (refused where it cannot work: the window says why).
  // Either way the state is read once, for the mode commands' greying.
  if (store.value.mode !== "off") await motion.set(store.value.mode).then(took, read);
  else await read();
}
