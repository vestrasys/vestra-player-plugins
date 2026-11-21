import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, PlayerState, PluginError, Scope, TriggerEvent } from "@vestra-player/sdk";
import {
  audioStream,
  clock,
  longest,
  MIN_JUMP,
  MIN_LENGTH,
  mergeSpans,
  nextWindow,
  parseSilences,
  silenceArgs,
  skippable,
  type Span,
  THRESHOLD,
  WINDOW,
  windowCount,
} from "./silence.ts";

/** What the plugin keeps across restarts (`settings.json` in its data directory). */
export interface Settings {
  /** Playback ▸ Skip Silence. */
  enabled: boolean;
  /** Sound quieter than this (dBFS) is silence. */
  thresholdDb: number;
  /** Shorter silences are played (seconds). */
  minLength: number;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  thresholdDb: THRESHOLD.default,
  minLength: MIN_LENGTH.default,
};

const isSettings = (v: unknown): v is Settings =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Settings).enabled === "boolean" &&
  Number.isFinite((v as Settings).thresholdDb) &&
  Number.isFinite((v as Settings).minLength);

const clamp = (value: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, value));

/** How long one ffmpeg window may take. */
const WINDOW_TIMEOUT = 60_000;
/**
 * The stretches skipped and shown on the seek bar: at most this many, the
 * longest (`TIMELINE_LIMITS.ranges`, also the limit of a trigger's position list).
 */
export const SHOWN_RANGES = 1000;
/**
 * Media seconds before a silence at which the player wakes the plugin: the
 * wake of a plugin in standby takes a fraction of a second, so it is told
 * early and waits the rest with one timer of its own.
 */
export const LEAD = 2;
/**
 * Skipping from further back than this before where the last skip landed
 * is a new playthrough (a replay, or the user went back); from there or
 * later (the next silence, or the rest of one that a scan window cut and a
 * later window extended) it is the same one. Seconds.
 */
const BACK = 0.5;
/** Files whose scan is kept in the player's session storage, the most recent. */
const KEPT_FILES = 20;

/** A local path from the player's source, or `null` (a URL, a stream, nothing). */
export function localPath(source: string | null): string | null {
  if (!source) return null;
  if (/^file:\/\//i.test(source)) {
    try {
      return fileURLToPath(source);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(source)) return null;
  return isAbsolute(source) ? source : null;
}

/** What a scan found in one file at one threshold (in session storage: it outlives the plugin's process). */
interface Scan {
  silences: Span[];
  done: number[];
  count: number;
}

/** The time saved in one playthrough (session storage `saved`). */
interface Saved {
  sourceId: number;
  seconds: number;
  /** Where the last skip jumped to. */
  last: number;
}

/** The id of the selected audio track of `state`, `null` without one. */
const selectedTrack = (state: PlayerState) => state.audioTracks?.find((t) => t.selected)?.id ?? null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Silence Skipper (`zysilm.silenceskip`): while a local file plays, skip the
 * stretches with no sound, as podcast players trim silence.
 *
 * Detection runs ffmpeg's `silencedetect` on the file with the player's
 * FFmpeg (`plugin.tools`), {@link WINDOW} seconds at a time, starting at the
 * playhead, when the file is ready (`source.ready`). The silences go to the
 * player twice: drawn on the seek bar (the timeline layer) and as the
 * condition of one trigger, which the player evaluates by itself. Between
 * silences the plugin holds nothing and may be stopped; the player starts it
 * again {@link LEAD} seconds before the next one. Skipping is a seek past the
 * silence: one action per stretch that leaves the user's speed alone, and
 * each skip says on the video how much time was saved.
 */
export default function activate(plugin: Plugin) {
  const { player, when } = plugin;
  const { text } = plugin.i18n;
  const settings = plugin.storage.json<Settings>("settings", { defaults: DEFAULT_SETTINGS, validate: isSettings });
  const session = plugin.storage.session;
  const layer = plugin.timeline.layer();
  const log = (...args: unknown[]) => console.error("silenceskip:", ...args);

  // The player calls this when playback is about to reach a silence: LEAD
  // seconds before it, or at once when a seek lands inside it.
  const silence = plugin.trigger().enter(({ range, state }) => skip(range, state));
  // Armed with the audio track a scan read: the player calls `leave` when
  // another one is selected (also in its own menu), and the file is scanned
  // again for that track's sound. `enter` (the track already selected when
  // armed) needs nothing.
  const track = plugin
    .trigger()
    .enter(() => {})
    .leave(() => void rescan().catch((error) => log(error)));

  /** While on: the event listener and the scan. */
  let active: Scope | null = null;
  /** The scan running now. */
  let job: AbortController | null = null;

  function save(change: Partial<Settings>) {
    settings.save({ ...settings.value, ...change });
    plugin.update();
  }

  // ------------------------------------------------------------------ skipping
  async function skip(range: TriggerEvent["range"], seen: PlayerState) {
    if (!range || range.end === null || !settings.value.enabled) return;
    // The notification's state is from when the player saw the flip; the
    // process may just have started, so read the position now.
    const now = await player.refresh();
    if (now.sourceId !== seen.sourceId || now.phase !== "ready" || now.paused || now.position === null) return;
    // Already past it: the seek landed (a replaced list, or the same range
    // entered again after a pause during the seek), or too little is left.
    if (now.position >= range.end - MIN_JUMP / 2) return;
    const from = Math.max(range.start, now.position);
    const wait = ((range.start - now.position) / now.rate) * 1000;
    if (wait > 0) await sleep(wait);
    if (!settings.value.enabled) return;
    try {
      // `stale`: the user paused, moved the playhead, changed the speed or
      // opened something meanwhile; their action wins.
      await player.seek(range.end, { ifCurrent: now });
    } catch (error) {
      if ((error as PluginError).code !== "stale") log("seek", error);
      return;
    }
    // The count is one playthrough: another file, or a skip from before where
    // the last one landed (a replay, or the user went back), starts it again.
    const saved = await session.get<Saved>("saved");
    const same = saved?.sourceId === now.sourceId && from >= saved.last - BACK;
    const seconds = (same ? saved.seconds : 0) + (range.end - from);
    await session.set("saved", { sourceId: now.sourceId, seconds, last: range.end } satisfies Saved);
    await plugin.osd.show("Silence skipped · {} saved", [clock(seconds)]);
  }

  // ------------------------------------------------------------------ scanning
  /** Where a file's scan is kept: a key of 1 KiB at most whatever the path. */
  async function scanKey(path: string, stream: number) {
    const real = await realpath(path);
    const info = await stat(real);
    const id = `${real}|${info.size}|${Math.trunc(info.mtimeMs)}|${settings.value.thresholdDb}|${stream}`;
    return `scan:${createHash("sha256").update(id).digest("hex")}`;
  }

  /** Keep `scan` under `key`, the most recent of at most {@link KEPT_FILES}. */
  async function keep(key: string, scan: Scan) {
    const order = ((await session.get<string[]>("scans")) ?? []).filter((k) => k !== key);
    order.push(key);
    while (order.length > KEPT_FILES) await session.delete(order.shift()!);
    for (;;) {
      try {
        await session.set(key, scan);
        await session.set("scans", order);
        return;
      } catch (error) {
        // Full: drop the oldest file's scan; a scan that does not fit at all is not kept.
        if ((error as PluginError).code !== "limit" || order.length <= 1) return;
        await session.delete(order.shift()!);
      }
    }
  }

  /**
   * Draw the stretches and hand them to the trigger, while the source of
   * `state` is still the one playing. Only the source and its audio track
   * are compared, read just before: a pause or a seek (also this plugin's
   * own skip) during the scan must not stop it from drawing and arming.
   */
  async function publish(state: PlayerState, silences: Span[], duration: number, signal: AbortSignal) {
    const now = await player.refresh();
    if (now.sourceId !== state.sourceId || signal.aborted) return;
    const selected = selectedTrack(state);
    // Another track was picked before the trigger below could see it change.
    if (selectedTrack(now) !== selected) return void rescan().catch((error) => log(error));
    if (selected === null) track.off();
    else track.firesOn(when.audioTrack(selected));
    const spans = longest(skippable(silences, settings.value.minLength, duration), SHOWN_RANGES);
    layer.setRanges(
      spans.map((s) => ({ start: s.start, end: s.end, style: "region" as const, title: text("Silence") })),
      { ifCurrent: state },
    );
    // The player binds the list to the source that is current when it gets it.
    if (spans.length) silence.firesOn(when.playing.and(when.can("seek"), when.position.in(spans, { lead: LEAD })));
    else silence.off();
  }

  /**
   * Scan the file of `state`, drawing and arming as windows finish. What
   * session storage has of it is not read again, so for a file scanned
   * already this only draws and arms (the same list again changes nothing).
   */
  async function begin(state: PlayerState) {
    const path = state.kind === "media" ? localPath(state.source) : null;
    const duration = state.duration;
    // A duration is needed to plan the windows; a live stream has none.
    const scope = active;
    // Whatever comes next, the scan running now is of something else: stop
    // its ffmpeg window before any return.
    job?.abort();
    job = null;
    if (!scope || state.phase !== "ready" || !path || duration === null || duration <= 0) return;
    const controller = new AbortController();
    job = controller;
    const { signal } = controller;
    try {
      const stream = audioStream(state.audioTracks);
      let key: string;
      try {
        key = await scanKey(path, stream);
      } catch (error) {
        log("cannot read", path, error);
        return;
      }
      if (signal.aborted) return;
      const scan = (await session.get<Scan>(key)) ?? { silences: [], done: [], count: windowCount(duration) };
      await publish(state, scan.silences, duration, signal);
      const threshold = settings.value.thresholdDb;
      for (;;) {
        // The playhead now: the next window is the one it plays, or the first not read after it.
        const now = await player.refresh();
        if (signal.aborted || now.sourceId !== state.sourceId) return;
        const index = nextWindow(new Set(scan.done), scan.count, now.position ?? 0);
        if (index === null) break;
        const from = index * WINDOW;
        const to = Math.min(duration, from + WINDOW);
        try {
          const { stdout } = await scope.tools.run("ffmpeg", silenceArgs(path, from, to - from, stream, threshold), {
            timeoutMs: WINDOW_TIMEOUT,
            maxOutput: 4 << 20,
            signal,
          });
          if (signal.aborted) return;
          const found = parseSilences(new TextDecoder().decode(stdout), from, to);
          scan.silences = mergeSpans([...scan.silences, ...found]);
        } catch (error) {
          const code = (error as PluginError).code;
          if (code === "aborted" || signal.aborted) return;
          if (code === "unavailable") {
            if (!(await session.get<boolean>("toldMissing"))) {
              await session.set("toldMissing", true);
              await plugin.osd.show("Silence Skipper needs ffmpeg, which was not found");
            }
            break;
          }
          if (code !== "timeout") {
            // No sound track, or a file ffmpeg cannot read: nothing to skip.
            log("cannot read", path, error);
            await plugin.osd.show("Silence Skipper cannot read the sound of this file");
            break;
          }
          log("window", index, "timed out");
        }
        scan.done.push(index);
        await keep(key, scan);
        await publish(state, scan.silences, duration, signal);
      }
    } finally {
      if (job === controller) job = null;
    }
  }

  /**
   * The file playing now, while on: at every start of the process (a
   * `source.ready` before it listened, a scan cut short), when turned on
   * mid-file, and after a settings change. `clear`: another threshold, what
   * was found no longer holds.
   */
  async function rescan(clear = false) {
    if (!active) return;
    // The scan running now must not draw or arm its list while this one starts.
    job?.abort();
    if (clear) {
      layer.setRanges([]);
      silence.off();
    }
    await begin(await player.refresh());
  }

  // ------------------------------------------------------------------ on and off
  /** Listen for files while on; hold nothing while off. */
  function follow(on: boolean) {
    if (on && !active) {
      const scope = plugin.scope();
      active = scope;
      scope.onDispose(() => job?.abort());
      scope.player.on("source.ready", ({ state }) => void begin(state).catch((error) => log(error)));
    } else if (!on && active) {
      void active.dispose();
      active = null;
      layer.setRanges([]);
      silence.off();
      track.off();
    }
  }

  // ------------------------------------------------------------------ the menu
  plugin.commands.add({
    id: "toggle",
    path: ["@playback", "Skip Silence"],
    checked: () => settings.value.enabled,
    async run() {
      const enabled = !settings.value.enabled;
      save({ enabled });
      follow(enabled);
      if (enabled) void rescan().catch((error) => log(error));
      await plugin.osd.show(enabled ? "Skip Silence: On" : "Skip Silence: Off");
    },
  });

  // ------------------------------------------------------------------ the settings page
  const page = plugin.settings.page("ui/settings.slint", {
    id: "silenceskip",
    category: "playback",
    title: "Silence Skipper",
  });
  page.bind(() => ({
    enabled: settings.value.enabled,
    threshold: settings.value.thresholdDb,
    minLength: settings.value.minLength,
  }));
  const setThreshold = (value: number) => {
    const thresholdDb = Math.round(clamp(value, THRESHOLD));
    if (thresholdDb === settings.value.thresholdDb) return;
    save({ thresholdDb });
    void rescan(true).catch((error) => log(error));
  };
  const setMinLength = (value: number) => {
    const minLength = Math.round(clamp(value, MIN_LENGTH) * 10) / 10;
    if (minLength === settings.value.minLength) return;
    save({ minLength });
    void rescan().catch((error) => log(error));
  };
  page.on("enabledToggled", (on: boolean) => {
    save({ enabled: on });
    follow(on);
    if (on) void rescan().catch((error) => log(error));
  });
  page.on("thresholdChanged", (value: number) => setThreshold(value));
  page.on("minLengthChanged", (value: number) => setMinLength(value));
  page.on("thresholdDefault", () => setThreshold(THRESHOLD.default));
  page.on("minLengthDefault", () => setMinLength(MIN_LENGTH.default));
  page.ready.catch((error: PluginError) => log("settings page", error.message));

  follow(settings.value.enabled);
  if (settings.value.enabled) void rescan().catch((error) => log(error));
}
