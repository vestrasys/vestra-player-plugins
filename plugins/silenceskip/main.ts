import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, PlayerState, PluginError, Scope } from "@vestra-player/sdk";
import {
  audioStream,
  clock,
  longest,
  MIN_LENGTH,
  mergeSpans,
  nextWindow,
  parseSilences,
  silenceArgs,
  skippable,
  type Span,
  stretchAt,
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
/** The seek bar shows at most this many ranges (`TIMELINE_LIMITS.ranges`): the longest silences. */
export const SHOWN_RANGES = 100;
/** Files whose scan is kept in memory, the most recent. */
const KEPT_FILES = 20;
/** A backward jump larger than this (the user seeking back) lets silences already skipped be skipped again. */
const BACK_JUMP = 1;

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

/** What a scan found in one file at one threshold. */
interface Scan {
  silences: Span[];
  done: Set<number>;
  count: number;
}

/** The file playing now. */
interface Current {
  sourceId: number;
  path: string;
  duration: number;
  stream: number;
  scan: Scan;
  /** The stretches skipped for the user's minimum length. */
  spans: Span[];
  /** Starts of the stretches already skipped (until the user seeks back before them). */
  skipped: Set<number>;
  /** Seconds saved in this file. */
  saved: number;
}

/**
 * Silence Skipper (`zysilm.silenceskip`): while a local file plays, skip the
 * stretches with no sound, as podcast players trim silence.
 *
 * Detection runs ffmpeg's `silencedetect` on the file with the player's
 * FFmpeg (`plugin.tools`), {@link WINDOW} seconds at a time, starting at the
 * playhead, so skipping starts after the first window. Skipping is a seek
 * past the silence: one action per stretch that leaves the user's speed
 * alone. The silences show on the seek bar as ranges, and each skip says on
 * the video how much time was saved.
 */
export default async function activate(plugin: Plugin) {
  plugin.player.subscribe(); // the player's events from now on
  await plugin.player.read(); // the player's state and timeline, read once
  const { text } = plugin.i18n;
  const settings = plugin.storage.json<Settings>("settings", { defaults: DEFAULT_SETTINGS, validate: isSettings });
  const layer = plugin.timeline.layer();
  const scans = new Map<string, Scan>();
  const log = (...args: unknown[]) => console.error("silenceskip:", ...args);

  /** ffmpeg was missing: said once per run. */
  let toldMissing = false;
  /** While on: the listener, the scan and their cleanup. */
  let active: Scope | null = null;

  function save(change: Partial<Settings>) {
    settings.save({ ...settings.value, ...change });
    plugin.update();
  }

  /** Follow playback while on; hold nothing while off, so the player may stop the plugin. */
  function follow(on: boolean) {
    if (on && !active) {
      active = plugin.scope();
      start(active);
    } else if (!on && active) {
      void active.dispose();
      active = null;
      layer.setRanges([]);
    }
  }

  function start(scope: Scope) {
    let current: Current | null = null;
    let seenSource: number | null = null;
    let job: AbortController | null = null;
    let lastPosition: number | null = null;
    let seeking = false;
    /** The first position after this plugin's seek is where it landed, not a jump of the user's. */
    let landing = false;
    /** The source whose scan was started. */
    let handled: number | null = null;
    /** Bumped by another source or a new threshold: a `begin` started before it does nothing. */
    let generation = 0;
    scope.onDispose(() => job?.abort());

    const live = (c: Current) => current === c && plugin.player.state.sourceId === c.sourceId;

    function publish(c: Current) {
      if (!live(c)) return;
      layer.setRanges(
        longest(c.spans, SHOWN_RANGES).map((s) => ({ start: s.start, end: s.end, style: "region" as const, title: text("Silence") })),
        { ifCurrent: plugin.player.state },
      );
    }

    function recompute(c: Current) {
      c.spans = skippable(c.scan.silences, settings.value.minLength, c.duration);
      publish(c);
    }

    async function scanFile(c: Current, signal: AbortSignal) {
      const threshold = settings.value.thresholdDb;
      while (!signal.aborted && live(c)) {
        const index = nextWindow(c.scan.done, c.scan.count, plugin.player.state.position ?? 0);
        if (index === null) return;
        const from = index * WINDOW;
        const to = Math.min(c.duration, from + WINDOW);
        try {
          const { stdout } = await scope.tools.run("ffmpeg", silenceArgs(c.path, from, to - from, c.stream, threshold), {
            timeoutMs: WINDOW_TIMEOUT,
            maxOutput: 4 << 20,
            signal,
          });
          if (signal.aborted) return;
          const found = parseSilences(new TextDecoder().decode(stdout), from, to);
          c.scan.silences = mergeSpans([...c.scan.silences, ...found]);
        } catch (error) {
          const code = (error as PluginError).code;
          if (code === "aborted" || signal.aborted) return;
          if (code === "unavailable") {
            if (!toldMissing) await plugin.osd.show("Silence Skipper needs ffmpeg, which was not found");
            toldMissing = true;
            return;
          }
          if (code !== "timeout") {
            // No sound track, or a file ffmpeg cannot read: nothing to skip.
            log("cannot read", c.path, error);
            await plugin.osd.show("Silence Skipper cannot read the sound of this file");
            return;
          }
          log("window", index, "timed out");
        }
        c.scan.done.add(index);
        recompute(c);
      }
    }

    async function begin(state: PlayerState, path: string, duration: number) {
      const gen = generation;
      let key: string;
      try {
        const real = await realpath(path);
        const info = await stat(real);
        key = `${real}|${info.size}|${Math.trunc(info.mtimeMs)}|${settings.value.thresholdDb}`;
      } catch (error) {
        log("cannot read", path, error);
        return;
      }
      if (gen !== generation || plugin.player.state.sourceId !== state.sourceId) return;
      let scan = scans.get(key);
      if (scan) scans.delete(key);
      else scan = { silences: [], done: new Set(), count: windowCount(duration) };
      scans.set(key, scan); // most recent last
      while (scans.size > KEPT_FILES) scans.delete(scans.keys().next().value!);
      const c: Current = {
        sourceId: state.sourceId,
        path,
        duration,
        stream: audioStream(state.audioTracks),
        scan,
        spans: [],
        skipped: new Set(),
        saved: 0,
      };
      current = c;
      recompute(c);
      const controller = new AbortController();
      job = controller;
      try {
        await scanFile(c, controller.signal);
      } finally {
        if (job === controller) job = null;
      }
    }

    async function skip(c: Current, state: PlayerState, stretch: Span, position: number) {
      seeking = true;
      c.skipped.add(stretch.start);
      try {
        await plugin.player.seek(stretch.end, { ifCurrent: state });
        c.saved += stretch.end - position;
        landing = true;
        await plugin.osd.show("Silence skipped · {} saved", [clock(c.saved)]);
      } catch (error) {
        // `stale`: the user paused, moved the playhead or opened something meanwhile; their action wins.
        if ((error as PluginError).code !== "stale") log("seek", error);
      } finally {
        seeking = false;
      }
    }

    function onPlayer(state: PlayerState) {
      if (state.sourceId !== seenSource) {
        seenSource = state.sourceId;
        generation++;
        handled = null;
        job?.abort();
        job = null;
        current = null;
        lastPosition = null;
        landing = false;
      }
      if (state.phase === "ended" && current) {
        // The time saved counts one playthrough: a replay starts again from 0:00.
        current.saved = 0;
        current.skipped.clear();
        lastPosition = null;
        landing = false;
      }
      if (state.phase !== "ready") return;
      if (handled !== state.sourceId) {
        const path = state.kind === "media" ? localPath(state.source) : null;
        // A duration is needed to plan the windows; a live stream has none.
        if (!path || state.duration === null || state.duration <= 0) return;
        handled = state.sourceId;
        void begin(state, path, state.duration).catch((error) => log(error));
        return;
      }
      const c = current;
      const position = state.position;
      if (!c || position === null) return;
      if (landing) {
        // Where the seek landed: a seek that lands early (on a keyframe) must not count as the user going back.
        landing = false;
      } else if (lastPosition !== null && position < lastPosition - BACK_JUMP && !seeking) {
        // The user went back: the silences after the new position are skipped again.
        for (const start of c.skipped) if (start > position) c.skipped.delete(start);
      }
      lastPosition = position;
      if (seeking || state.paused || !state.can.seek) return;
      const stretch = stretchAt(c.spans, position);
      if (stretch && !c.skipped.has(stretch.start)) void skip(c, state, stretch, position);
    }

    // Settings that change while on.
    restartScan = () => {
      generation++;
      handled = null;
      job?.abort();
      job = null;
      current = null;
      layer.setRanges([]);
      onPlayer(plugin.player.state);
    };
    refilter = () => {
      if (current) recompute(current);
    };
    scope.onDispose(() => {
      restartScan = () => {};
      refilter = () => {};
    });

    scope.player.onChange(onPlayer);
    onPlayer(plugin.player.state);
  }

  /** Scan the playing file again (a new threshold); a no-op while off. */
  let restartScan = () => {};
  /** Apply a new minimum length to what was found; a no-op while off. */
  let refilter = () => {};

  // ------------------------------------------------------------------ the menu
  plugin.commands.add({
    id: "toggle",
    path: ["@playback", "Skip Silence"],
    checked: () => settings.value.enabled,
    async run() {
      const enabled = !settings.value.enabled;
      save({ enabled });
      follow(enabled);
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
    restartScan();
  };
  const setMinLength = (value: number) => {
    const minLength = Math.round(clamp(value, MIN_LENGTH) * 10) / 10;
    if (minLength === settings.value.minLength) return;
    save({ minLength });
    refilter();
  };
  page.on("enabledToggled", (on: boolean) => {
    save({ enabled: on });
    follow(on);
  });
  page.on("thresholdChanged", (value: number) => setThreshold(value));
  page.on("minLengthChanged", (value: number) => setMinLength(value));
  page.on("thresholdDefault", () => setThreshold(THRESHOLD.default));
  page.on("minLengthDefault", () => setMinLength(MIN_LENGTH.default));
  page.ready.catch((error: PluginError) => log("settings page", error.message));

  follow(settings.value.enabled);
}
