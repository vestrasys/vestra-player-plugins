import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { FilterStatus, PluginError, Plugin } from "@vestra-player/sdk";
import {
  analyseFrame,
  cropNodes,
  type CropNode,
  decide,
  displaySize,
  type FrameResult,
  type NoCrop,
  type Rect,
  sampleTimes,
} from "./detect.ts";

/** What the plugin keeps across restarts (`settings.json` in its data directory). */
export interface Settings {
  /** Video ▸ Auto Frame ▸ Auto-Frame Videos. */
  enabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = { enabled: true };

const isSettings = (value: unknown): value is Settings =>
  typeof value === "object" && value !== null && typeof (value as Settings).enabled === "boolean";

/** The picture size and pixel aspect of a file's video, after its rotation. */
export interface Picture {
  width: number;
  height: number;
  /** Pixel aspect `num:den` (1:1 when the file says nothing). */
  sar: [number, number];
}

/** What the plugin found in one file. */
export interface Detected extends Picture {
  /** The content box, or `null` when the file is not cropped. */
  rect: Rect | null;
  /** Why it is not cropped (`null` with a box). */
  reason: NoCrop | null;
}

/** One file in the cache (`cache.json`), by {@link fileKey}. */
export interface Entry {
  /** The last detection; `null` before one finished. */
  detected: Detected | null;
  /** Show Full Picture for This File. */
  full: boolean;
  /** When the file was last played (ms since 1970), to drop the oldest entries. */
  used: number;
}

export interface Cache {
  files: Record<string, Entry>;
}

const isCache = (value: unknown): value is Cache =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Cache).files === "object" &&
  (value as Cache).files !== null &&
  !Array.isArray((value as Cache).files);

/** The cache keeps this many files, the most recently played. */
export const CACHE_FILES = 500;

/** Frames sampled from a file. */
export const SAMPLES = 8;

/** How long one ffprobe or ffmpeg run may take. */
const PROBE_TIMEOUT = 15_000;
const FRAME_TIMEOUT = 30_000;

/** After applying a crop: how often and how long the player's display size is read back. */
export const VERIFY_INTERVAL = 250;
export const VERIFY_TRIES = 12;
/** While a crop is on: how often the player's display size is checked for another plugin's geometry change. */
export const WATCH_INTERVAL = 1000;

/** Menu path of the plugin's submenu (Video ▸ Auto Frame). */
export const MENU = ["@video", "Auto Frame"] as const;

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

/** The cache key of a file: its real path, size and modification time, so a changed file is detected again. */
export async function fileKey(path: string): Promise<string> {
  const real = await realpath(path);
  const info = await stat(real);
  return `${real}|${info.size}|${Math.trunc(info.mtimeMs)}`;
}

/** "num:den" from ffprobe ("0:1" and "N/A" mean square pixels). */
function parseSar(value: unknown): [number, number] {
  const match = typeof value === "string" ? /^(\d+):(\d+)$/.exec(value) : null;
  const num = match ? Number(match[1]) : 0;
  const den = match ? Number(match[2]) : 0;
  return num > 0 && den > 0 ? [num, den] : [1, 1];
}

/**
 * The picture of the first video stream from ffprobe's JSON (`-show_streams
 * -show_format`), with a 90° rotation applied as ffmpeg and the player apply
 * it; `null` without a video stream or for a cover picture.
 */
export function parseProbe(json: unknown): (Picture & { duration: number }) | null {
  const root = json as {
    streams?: {
      width?: number;
      height?: number;
      sample_aspect_ratio?: string;
      disposition?: { attached_pic?: number };
      tags?: { rotate?: string };
      side_data_list?: { rotation?: number }[];
      duration?: string;
    }[];
    format?: { duration?: string };
  };
  const stream = root?.streams?.[0];
  if (!stream || !(Number(stream.width) > 0) || !(Number(stream.height) > 0)) return null;
  if (stream.disposition?.attached_pic === 1) return null;
  let width = Number(stream.width);
  let height = Number(stream.height);
  let sar = parseSar(stream.sample_aspect_ratio);
  const rotation =
    stream.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation ?? Number(stream.tags?.rotate ?? 0);
  if (Math.abs(Math.round(rotation)) % 180 === 90) {
    [width, height] = [height, width];
    sar = [sar[1], sar[0]];
  }
  // The container's duration, else the stream's (some containers leave one out).
  const durations = [root.format?.duration, stream.duration].map(Number).filter((d) => Number.isFinite(d) && d > 0);
  return { width, height, sar, duration: durations[0] ?? 0 };
}

/** ffprobe's arguments: the first video stream (`V`: not a cover picture) and the container. */
export const probeArgs = (path: string) => [
  "-v",
  "error",
  "-select_streams",
  "V:0",
  "-show_streams",
  "-show_format",
  "-of",
  "json",
  path,
];

/**
 * ffmpeg's arguments: the last keyframe at or before `time` (a fast seek
 * that decodes keyframes only), one frame of raw `rgb24` on stdout, as the
 * player's own thumbnails read frames; `V`: the first video stream that is
 * not a cover picture.
 */
export const frameArgs = (path: string, time: number) => [
  "-nostdin",
  "-v",
  "error",
  "-skip_frame",
  "nokey",
  "-noaccurate_seek",
  "-ss",
  time.toFixed(3),
  "-i",
  path,
  "-map",
  "0:V:0",
  "-frames:v",
  "1",
  "-an",
  "-sn",
  "-dn",
  "-pix_fmt",
  "rgb24",
  "-f",
  "rawvideo",
  "-",
];

const same = (a: { width: number; height: number }, b: { width: number; height: number }) =>
  a.width === b.width && a.height === b.height;

/** The file playing now, once its cache key is known. */
interface Current {
  sourceId: number;
  path: string;
  key: string;
}

/**
 * Auto Frame for Vestra Player (`zysilm.autoframe`): when a local video's
 * picture sits in a solid-colour frame (a 2560×1440 picture in the corner of
 * a 3840×2160 video), crop the video to the picture with two `reframe`
 * nodes in the plugin's own filter chain.
 *
 * At each new local file (phase `ready`), the plugin reads the picture size
 * with ffprobe and {@link SAMPLES} keyframes with ffmpeg, finds the content
 * box ({@link decide}), caches the answer per file, applies the crop and
 * checks the size the player reports. A file with no border gets an empty
 * chain, which keeps zero-copy hardware decoding.
 */
export default async function activate(plugin: Plugin) {
  plugin.player.subscribe(); // the player's events from now on
  await plugin.player.read(); // the player's state and timeline, read once
  const { text } = plugin.i18n;
  const settings = plugin.storage.json<Settings>("settings", { defaults: DEFAULT_SETTINGS, validate: isSettings });
  const cache = plugin.storage.json<Cache>("cache", { defaults: { files: {} }, validate: isCache });
  const filter = plugin.video.filter("autoframe");

  /** The crop nodes last set (`[]`: none). */
  let nodes: CropNode[] = [];
  /** `filter.set` was called at least once (before that the chain has no status worth waiting for). */
  let everSet = false;
  let current: Current | null = null;
  /** The detection running now. */
  let job: AbortController | null = null;
  /** The source whose crop the OSD already announced. */
  let announced: number | null = null;
  let stopped = false;
  /** ffmpeg or ffprobe was missing: said once per run. */
  let toldMissing = false;
  /**
   * Bumped by every change that decides the crop anew (another source, the
   * menu items, a new detection): work started before it sets no chain.
   */
  let generation = 0;
  /** The check of the display size while a crop is on. */
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  const unwatch = () => {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  };
  plugin.onDispose(() => {
    stopped = true;
    job?.abort();
    unwatch();
  });

  const log = (...args: unknown[]) => console.error("autoframe:", ...args);

  function setChain(next: CropNode[]) {
    // Nothing to withdraw: an empty chain is never sent first.
    if (next.length === 0 && nodes.length === 0) return;
    if (next.length === 0) unwatch();
    nodes = next;
    everSet = true;
    filter.set(next);
  }
  const clear = () => setChain([]);

  /** The file is still the one playing. */
  const live = (c: Current) => !stopped && current === c && plugin.player.state.sourceId === c.sourceId;

  function entry(key: string): Entry | undefined {
    return cache.value.files[key];
  }

  function saveEntry(key: string, change: Partial<Entry>) {
    const files = { ...cache.value.files };
    const old = files[key];
    files[key] = {
      detected: change.detected !== undefined ? change.detected : (old?.detected ?? null),
      full: change.full ?? old?.full ?? false,
      used: Date.now(),
    };
    const keys = Object.keys(files);
    if (keys.length > CACHE_FILES) {
      keys
        .sort((a, b) => files[a]!.used - files[b]!.used)
        .slice(0, keys.length - CACHE_FILES)
        .forEach((old) => delete files[old]);
    }
    cache.save({ files });
  }

  /** Waits until the chain is applied or refused (at most 3 s). */
  function settled(): Promise<FilterStatus> {
    const done = (s: FilterStatus) => s.state === "applied" || s.state === "failed";
    if (done(filter.status)) return Promise.resolve(filter.status);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        listener.dispose();
        resolve(filter.status);
      }, 3000);
      const listener = filter.onStatus((s) => {
        if (!done(s)) return;
        clearTimeout(timer);
        listener.dispose();
        resolve(s);
      });
    });
  }

  /** The size the player shows the video at now, `null` when it does not say. */
  async function shownSize(): Promise<{ width: number; height: number } | null> {
    const stats = await plugin.player.stats().catch(() => null);
    const width = stats?.video?.displayWidth;
    const height = stats?.video?.displayHeight;
    return typeof width === "number" && typeof height === "number" ? { width, height } : null;
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // ------------------------------------------------------------------ detection
  /** Reads the file and finds its content box; `null` when it could not (told on the OSD when `manual`). */
  async function detect(
    c: Current,
    signal: AbortSignal,
    manual: boolean,
  ): Promise<{ detected: Detected; conclusive: boolean } | null> {
    const fail = async (error: unknown) => {
      const code = (error as PluginError).code;
      if (code === "aborted" || signal.aborted) return null;
      log("cannot read", c.path, error);
      if (code === "unavailable") {
        if (manual || !toldMissing) await plugin.osd.show("Auto Frame needs ffmpeg, which was not found");
        toldMissing = true;
      } else if (manual) {
        await plugin.osd.show("Auto Frame could not read this video");
      }
      return null;
    };
    let picture: (Picture & { duration: number }) | null;
    try {
      const { stdout } = await plugin.tools.run("ffprobe", probeArgs(c.path), {
        timeoutMs: PROBE_TIMEOUT,
        maxOutput: 1 << 20,
        signal,
      });
      picture = parseProbe(JSON.parse(new TextDecoder().decode(stdout)));
    } catch (error) {
      return fail(error);
    }
    if (signal.aborted) return null;
    if (!picture) {
      // Audio only, or a cover picture: nothing to frame.
      return { detected: { width: 0, height: 0, sar: [1, 1], rect: null, reason: "no-border" }, conclusive: true };
    }
    const { width, height, sar } = picture;
    const bytes = width * height * 3;
    const results: FrameResult[] = [];
    /** Hashes of the frames read: two times can land on the same keyframe, which counts once. */
    const seenFrames = new Set<string>();
    /** A frame could not be read (a timeout, an error): the answer is used now but not cached. */
    let failed = false;
    for (const time of sampleTimes(picture.duration, SAMPLES)) {
      try {
        const { stdout } = await plugin.tools.run("ffmpeg", frameArgs(c.path, time), {
          timeoutMs: FRAME_TIMEOUT,
          maxOutput: bytes + 1024,
          signal,
        });
        if (signal.aborted) return null;
        // A frame of another size (a stream that changes size): not used.
        if (stdout.length !== bytes) continue;
        const hash = createHash("sha1").update(stdout).digest("hex");
        if (seenFrames.has(hash)) continue;
        seenFrames.add(hash);
        results.push(analyseFrame({ width, height, data: stdout }));
      } catch (error) {
        const code = (error as PluginError).code;
        if (code === "aborted" || signal.aborted) return null;
        if (code === "unavailable") return fail(error);
        // One unreadable position: try the others.
        log("frame", time, error);
        failed = true;
      }
    }
    const decision = decide(results, width, height, sar[0] / sar[1]);
    const detected: Detected =
      "rect" in decision
        ? { width, height, sar, rect: decision.rect, reason: null }
        : { width, height, sar, rect: null, reason: decision.reason };
    return { detected, conclusive: !failed };
  }

  /** Why a detection does not crop, on the OSD: only when the user asked, except a shape the player cannot crop to. */
  async function tell(reason: NoCrop, manual: boolean) {
    if (reason === "aspect") return plugin.osd.show("Auto Frame: the picture is too narrow or too wide to frame");
    if (!manual) return;
    if (reason === "few-frames") return plugin.osd.show("Auto Frame: too few frames show a picture to decide");
    if (reason === "no-border") return plugin.osd.show("Auto Frame: no solid border around the picture");
    if (reason === "one-axis") return plugin.osd.show("Auto Frame: bars only above and below or only at the sides are kept");
    if (reason === "unstable") return plugin.osd.show("Auto Frame: the picture moves on a plain background, not cropped");
    return plugin.osd.show("Auto Frame: the picture inside the border is too small to frame");
  }

  // ------------------------------------------------------------------ applying
  /**
   * Crops the playing file to `d.rect` and checks the size the player then
   * reports. Another geometry change (the built-in Crop/Stretch, a rotation)
   * runs before this chain and would make the crop land elsewhere: when the
   * player's size before or after does not match, the crop is withdrawn and
   * the OSD says why.
   */
  async function apply(c: Current, d: Detected & { rect: Rect }, gen: number) {
    // Still wanted: the same file, nothing changed since, on, and not shown in full.
    const wanted = () => live(c) && gen === generation && settings.value.enabled && !entry(c.key)?.full;
    const sar = d.sar[0] / d.sar[1];
    const chain = cropNodes(d.rect, d.width, d.height, sar);
    if (!chain) {
      log("no crop chain gives", d.rect, "in", d.width, d.height);
      clear();
      return;
    }
    const full = displaySize(d.width, d.height, ...d.sar);
    const cropped = displaySize(d.rect.width, d.rect.height, ...d.sar);
    if (nodes.length === 0) {
      if (everSet) await settled();
      if (!wanted()) return;
      const before = await shownSize();
      if (!wanted()) return;
      if (before && !same(before, full)) {
        log("shown at", before, "expected", full);
        await plugin.osd.show("Auto Frame paused: Crop/Stretch or rotation changes the picture");
        return;
      }
    }
    if (!wanted()) return;
    setChain(chain);
    plugin.update();
    const status = await settled();
    if (!live(c) || nodes !== chain) return;
    if (status.state === "failed") {
      log("crop refused", status.error);
      clear();
      plugin.update();
      return;
    }
    let shown: { width: number; height: number } | null = null;
    for (let i = 0; i < VERIFY_TRIES; i++) {
      shown = await shownSize();
      if (!live(c) || nodes !== chain) return;
      if (shown === null || same(shown, cropped)) break;
      await wait(VERIFY_INTERVAL);
      if (!live(c) || nodes !== chain) return;
    }
    if (shown && !same(shown, cropped) && !same(shown, full)) {
      log("shown at", shown, "expected", cropped);
      clear();
      plugin.update();
      await plugin.osd.show("Auto Frame undone: Crop/Stretch or rotation changes the picture");
      return;
    }
    watch(c, chain, cropped, full);
    if (announced !== c.sourceId) {
      announced = c.sourceId;
      await plugin.osd.show("Auto-framed to {}", [`${d.rect.width}×${d.rect.height}`]);
    }
  }

  /**
   * While the crop is on, checks the size the player shows every
   * {@link WATCH_INTERVAL}: when another plugin changes the picture later
   * (the built-in Crop/Stretch, a rotation), the crop lands in the wrong
   * place, so it is withdrawn once two checks in a row disagree. The player
   * sends no event for another plugin's filters, hence the timer.
   */
  function watch(
    c: Current,
    chain: CropNode[],
    cropped: { width: number; height: number },
    full: { width: number; height: number },
  ) {
    unwatch();
    let misses = 0;
    let checking = false;
    watchTimer = setInterval(async () => {
      if (checking) return;
      if (!live(c) || nodes !== chain) return unwatch();
      if (plugin.player.state.phase !== "ready") return;
      checking = true;
      try {
        const shown = await shownSize();
        if (!live(c) || nodes !== chain) return;
        // `full`: the crop has not taken effect yet (a slow decoder, paused), as the verify loop accepts it.
        if (!shown || same(shown, cropped) || same(shown, full)) {
          misses = 0;
          return;
        }
        if (++misses < 2) return;
        log("shown at", shown, "expected", cropped);
        generation++;
        clear();
        plugin.update();
        await plugin.osd.show("Auto Frame undone: Crop/Stretch or rotation changes the picture");
      } finally {
        checking = false;
      }
    }, WATCH_INTERVAL);
  }

  /** Frames the playing file: from the cache, or detects it first (always when `manual`). */
  async function frame(manual: boolean) {
    const c = current;
    if (!c || stopped) return;
    const gen = ++generation;
    const saved = entry(c.key);
    if (!settings.value.enabled || saved?.full) {
      clear();
      return;
    }
    let detected = manual ? null : (saved?.detected ?? null);
    let fresh = false;
    if (!detected) {
      job?.abort();
      const controller = new AbortController();
      job = controller;
      plugin.update();
      let found: Awaited<ReturnType<typeof detect>>;
      try {
        found = await detect(c, controller.signal, manual);
      } finally {
        if (job === controller) job = null;
        plugin.update();
      }
      if (!found || !live(c) || controller.signal.aborted || gen !== generation) return;
      detected = found.detected;
      // Only a conclusive answer is cached: after a timeout the file is read again next time.
      saveEntry(c.key, found.conclusive ? { detected } : {});
      fresh = true;
    } else {
      saveEntry(c.key, {});
    }
    if (!settings.value.enabled || entry(c.key)?.full) return;
    if (!detected.rect) {
      clear();
      plugin.update();
      if (fresh && detected.reason) await tell(detected.reason, manual);
      return;
    }
    if (manual) announced = null;
    await apply(c, detected as Detected & { rect: Rect }, gen);
  }

  // ------------------------------------------------------------------ the player
  let seen: number | null = null;
  let handled: number | null = null;

  async function begin(sourceId: number, path: string) {
    let key: string;
    try {
      key = await fileKey(path);
    } catch (error) {
      log("cannot read", path, error);
      return;
    }
    if (stopped || plugin.player.state.sourceId !== sourceId) return;
    current = { sourceId, path, key };
    plugin.update();
    await frame(false);
  }

  const onPlayer = () => {
    const state = plugin.player.state;
    if (stopped) return;
    if (state.sourceId !== seen) {
      // Another source: what was found for the last one does not apply.
      seen = state.sourceId;
      generation++;
      job?.abort();
      job = null;
      current = null;
      clear();
      plugin.update();
    }
    if (state.phase !== "ready" || state.sourceId === handled) return;
    handled = state.sourceId;
    const path = state.kind === "media" ? localPath(state.source) : null;
    if (path) void begin(state.sourceId, path).catch((error) => log(error));
  };
  plugin.player.onChange(onPlayer);
  onPlayer();

  // ------------------------------------------------------------------ the menu
  const noFile = () => (current ? null : text("Play a video file on this computer to use Auto Frame"));

  plugin.commands.add({
    id: "auto",
    path: [...MENU, "Auto-Frame Videos"],
    checked: () => settings.value.enabled,
    async run() {
      const enabled = !settings.value.enabled;
      settings.save({ enabled });
      plugin.update();
      if (!enabled) {
        generation++;
        job?.abort();
        clear();
        plugin.update();
        await plugin.osd.show("Auto Frame: Off");
        return;
      }
      await plugin.osd.show("Auto Frame: On");
      announced = null;
      await frame(false);
    },
  });

  plugin.commands.add({
    id: "detect",
    path: [...MENU, "Detect Again"],
    enabled: () => current !== null && settings.value.enabled && !entry(current.key)?.full,
    busy: () => job !== null,
    reason: () =>
      noFile() ??
      (!settings.value.enabled
        ? text("Auto-Frame Videos is off")
        : current && entry(current.key)?.full
          ? text("The full picture is shown for this file")
          : null),
    run: () => frame(true),
  });

  plugin.commands.add({
    id: "full",
    path: [...MENU, "Show Full Picture for This File"],
    checked: () => current !== null && entry(current.key)?.full === true,
    enabled: () => current !== null && settings.value.enabled,
    reason: () => noFile() ?? (!settings.value.enabled ? text("Auto-Frame Videos is off") : null),
    async run() {
      const c = current;
      if (!c) return;
      const full = !(entry(c.key)?.full ?? false);
      saveEntry(c.key, { full });
      plugin.update();
      if (full) {
        generation++;
        job?.abort();
        clear();
        plugin.update();
        await plugin.osd.show("Showing the full picture of this file");
        return;
      }
      announced = null;
      await frame(false);
    },
  });
}
