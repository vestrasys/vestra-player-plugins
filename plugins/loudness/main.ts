import type { Disposable, Plugin, PluginError, Scope } from "@vestra-player/sdk";
import { display, EMPTY, FILTER, LABEL, METADATA, readMetadata, type Readings } from "./meter.ts";

/** The one menu item: Tools ▸ Loudness Meter… opens the meter window. */
export const WINDOW_TITLE = "Loudness Meter…";

/**
 * Loudness (`zysilm.loudness`): a live EBU R128 loudness meter.
 *
 * While its window is open the plugin puts FFmpeg's `ebur128` filter at the
 * end of mpv's audio chain through the mpv pass-through (`plugin.mpv`,
 * `af add @loudness:…`) and observes the values it tags the sound with
 * (`af-metadata/loudness`). The filter only measures: the sound passes
 * through unchanged. Closing the window takes the filter out again and drops
 * the observer, so a closed meter holds nothing and the player may stop the
 * plugin.
 *
 * Refresh: `ebur128` tags every 100 ms of sound and the player sends an
 * observed property at most every 100 ms, so the window gets at most ten
 * values a second, the rate EBU Tech 3341 asks of a momentary meter. The
 * values are rounded as shown before they are bound, so only a visible
 * change is sent; the window is a tool window of its own, so its redraws
 * never touch the main window and the video.
 *
 * No night mode or normalizer: the player's built-in Audio plugin has
 * Normalize (Shift+N), the dynamic normalizer that mpv and VLC users turn on
 * for the same purpose.
 */
export default async function activate(plugin: Plugin) {
  const { text } = plugin.i18n;
  plugin.player.subscribe();
  await plugin.player.read();

  let readings: Readings = EMPTY;
  /** mpv's or the player's message when the meter could not start; `null` while it works. */
  let failure: string | null = null;
  /** Everything that lives while the window is open: the source listener and the observer. */
  let session: Scope | null = null;
  let observer: Disposable | null = null;
  /** The filter is in mpv's audio chain. */
  let filterIn = false;

  // Filter changes run one after another: a quick close and open, or Restart
  // pressed twice, never sends `remove` before the `add` it undoes.
  let queue: Promise<void> = Promise.resolve();
  const serial = (job: () => Promise<void>) => (queue = queue.then(job, job));

  const addFilter = async () => {
    try {
      await plugin.mpv.command(["af", "add", FILTER]);
      filterIn = true;
      failure = null;
    } catch (error) {
      // `refused`, `conflict` (another plugin took the label), `backend` (mpv: no audio filter support…).
      failure = (error as PluginError).message;
    }
  };
  const removeFilter = async () => {
    if (!filterIn) return;
    filterIn = false;
    // `backend` when mpv already dropped it: nothing left to do.
    await plugin.mpv.command(["af", "remove", `@${LABEL}`]).catch(() => {});
  };
  /** Follow the filter's values; a fresh observer, so a value of a filter taken out never arrives after a restart. */
  const follow = (scope: Scope) => {
    void observer?.dispose();
    observer = null;
    if (!filterIn || session !== scope) return;
    observer = scope.mpv.observe(METADATA, (value) => {
      readings = readMetadata(value, readings);
      // An mpv observer runs without an update pass (as `player.on` does): ask for one.
      // The window's values are rounded as shown, so the pass sends only what visibly changed.
      plugin.update();
    });
  };

  /** Start measuring again from nothing: a new filter has no integrated loudness, range or peak yet. */
  const restart = (scope: Scope) =>
    serial(async () => {
      if (session !== scope) return;
      // Stop listening first: a value of the old filter still on its way would bring back its peak.
      void observer?.dispose();
      observer = null;
      readings = EMPTY;
      plugin.update();
      await removeFilter();
      if (session !== scope) return;
      await addFilter();
      follow(scope);
      plugin.update();
    });

  const begin = () => {
    if (session) return;
    const scope = (session = plugin.scope());
    readings = EMPTY;
    failure = null;
    void serial(async () => {
      if (session !== scope) return;
      await addFilter();
      follow(scope);
      plugin.update();
    });
    // Another file: its loudness is measured on its own.
    let source = plugin.player.state.sourceId;
    scope.player.onChange((state) => {
      if (state.sourceId === source) return;
      source = state.sourceId;
      void restart(scope);
    });
  };

  const end = () => {
    const scope = session;
    session = null;
    observer = null;
    readings = EMPTY;
    failure = null;
    if (scope) void scope.dispose();
    void serial(removeFilter);
  };

  /** The status line and its tone: 0 idle, 1 measuring, 2 waiting, 3 failed. Read only while open. */
  const status = () => {
    if (failure !== null) return { status: text("The meter could not start: {}", [failure]), tone: 3 };
    const state = plugin.player.state;
    if (state.phase === "loading") return { status: text("Waiting for sound…"), tone: 2 };
    if (state.phase !== "ready") return { status: text("Nothing is playing"), tone: 0 };
    if (state.audioTracks !== null && state.audioTracks.length === 0) return { status: text("This media has no sound"), tone: 0 };
    if (!readings.seen) return { status: text("Waiting for sound…"), tone: 2 };
    if (state.paused) return { status: text("Paused: the values hold"), tone: 0 };
    return { status: text("Measuring"), tone: 1 };
  };

  const window = plugin.windows.create("meter.slint");
  // While closed the binding reads nothing of the player's state, so it keeps no plugin running.
  window.bind(() => ({
    ...display(readings),
    ...(session ? status() : { status: "", tone: 0 }),
    canRestart: session !== null && filterIn,
  }));
  window.on("restart", () => {
    if (session) void restart(session);
  });
  // When the plugin stops, the player removes its filter and observers by itself.
  window.onClose(end);

  plugin.commands.add({
    id: "loudness.window",
    path: ["@tools", WINDOW_TITLE],
    run: async () => {
      await window.show();
      begin();
    },
  });
}
