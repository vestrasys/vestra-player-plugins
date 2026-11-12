import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Highlights, step 1 (design clipexport-highlights §9): the loudness of the
 * sound, measured by ffmpeg, gives the moments that stand out; each becomes a
 * suggested range whose edges sit in the pauses around it. Pure functions
 * here (arguments, parsing, the analysis, the strip's paths); the scan runs
 * ffmpeg window by window, and the result is kept per file.
 */

/** Momentary loudness values a second: ffmpeg's `ebur128` with `metadata=1` cuts the sound into 100 ms frames. */
export const RATE = 10;
/** Seconds of media per ffmpeg run: progress, cancel and the source check come between runs. */
export const WINDOW = 300;
/** The momentary loudness looks 400 ms back: each run starts this much before its window, and those values are dropped. */
const LEAD = 0.5;
/** How many suggestions the list shows (the 5 · 10 · 20 segments). */
export const COUNTS = [5, 10, 20] as const;
export const DEFAULT_COUNT = 10;
/** Videos whose result is kept (the most recently used). */
export const CACHE_LIMIT = 50;
/** Momentary loudness of silence, as ffmpeg reports it (−120.7 LUFS) and lower, is kept at this floor. */
const SILENT = -70;
/** Louder than this is sound; quieter is silence (no average, no peak). */
const AUDIBLE = -60;
/** The short-term window the peaks are found on: 3 s, as EBU R 128's short-term loudness. */
const SHORT = 3 * RATE;
/** A moment stands out when its short-term loudness is this many LU above the video's average. */
export const STAND_OUT = 5;
/** A pause: momentary loudness this many LU under the average, for at least `PAUSE_FRAMES` frames (0.3 s). */
const PAUSE_BELOW = 10;
const PAUSE_FRAMES = 3;
/** A range starts at least this long before the loud moment (what caused the reaction), and at a pause at most `LOOK_BACK` before it. */
const LEAD_IN = 4;
const LOOK_BACK = 60;
/** It ends at the first pause at most `LOOK_AHEAD` after the moment. */
const LOOK_AHEAD = 20;
/** Ranges are 6–90 s long. */
export const MIN_LENGTH = 6;
export const MAX_LENGTH = 90;
/** Loud parts closer than this are one moment. */
const JOIN_GAP = 3;
/** Candidates kept per video (the list shows at most 20). */
const KEEP = 100;
/** The strip's curve: this many columns over the whole video. */
const BINS = 240;
/** The thinnest band on the strip, in its 1000-wide view box: about 3 px at the 240 px a narrow tab gives it. */
export const MIN_BAND = 13;

/**
 * ffmpeg's arguments for one window: the momentary loudness (`lavfi.r128.M`)
 * of one audio stream, one line pair per 100 ms on standard output. The
 * picture, subtitles and data are not decoded; one thread (sound decoding
 * barely uses more).
 */
export function loudnessArgs(source: string, from: number, length: number, stream: number) {
  const at = Math.max(0, from - LEAD);
  return [
    "-hide_banner", "-nostats", "-nostdin", "-loglevel", "error", "-threads", "1",
    "-ss", at.toFixed(3), "-t", (from + length - at).toFixed(3), "-i", source,
    "-map", `0:a:${stream}`, "-vn", "-sn", "-dn",
    "-af", "ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-",
    "-f", "null", "-",
  ];
}

/**
 * Put one run's output into `values` (one per 100 ms of the whole video): a
 * `frame:… pts_time:T` line, then `lavfi.r128.M=V`. `at` is where the run
 * started reading, `from` where its window starts (earlier values are the
 * warm-up). The value whose 100 ms ends at `from` is kept too: ffmpeg leaves
 * out a last frame shorter than 100 ms, so the run before never prints it. A
 * value given by both runs lands on the same index (it is set, never added).
 * Returns how many values it set.
 */
export function parseMomentary(text: string, at: number, from: number, values: Float32Array) {
  let time = Number.NaN;
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("frame:")) {
      const match = /pts_time:(-?[\d.]+(?:e[-+]?\d+)?)/.exec(line);
      time = match ? at + Number(match[1]) : Number.NaN;
    } else if (line.startsWith("lavfi.r128.M=")) {
      const value = Number(line.slice(13));
      if (!Number.isFinite(time) || time < from - 0.15) continue;
      const index = Math.round(time * RATE);
      if (index < 0 || index >= values.length) continue;
      values[index] = Number.isFinite(value) ? Math.max(SILENT, value) : SILENT;
      count++;
    }
  }
  return count;
}

/** A fresh array for a video's values; what no run reaches stays silent. */
export const emptyValues = (duration: number) => new Float32Array(Math.max(1, Math.ceil(duration * RATE))).fill(SILENT);

/** The short-term loudness (3 s, centred) of each 100 ms, from the momentary values: the mean of their energy. */
export function shortTerm(values: Float32Array, upTo = values.length) {
  const out = new Float32Array(upTo);
  const energy = new Float64Array(upTo + 1);
  for (let i = 0; i < upTo; i++) energy[i + 1] = energy[i]! + 10 ** (values[i]! / 10);
  const half = SHORT >> 1;
  for (let i = 0; i < upTo; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(upTo, i + half + 1);
    const mean = (energy[b]! - energy[a]!) / (b - a);
    out[i] = mean > 0 ? Math.max(SILENT, 10 * Math.log10(mean)) : SILENT;
  }
  return out;
}

/** The video's average loudness: the median of its audible momentary values (LUFS); `null` when there is no sound. */
export function averageOf(values: Float32Array, upTo = values.length) {
  const audible: number[] = [];
  for (let i = 0; i < upTo; i++) if (values[i]! > AUDIBLE) audible.push(values[i]!);
  if (audible.length < RATE) return null;
  audible.sort((a, b) => a - b);
  return audible[audible.length >> 1]!;
}

/** One suggestion as the scan found it: seconds, and how far its loudest moment is above the video's average (LU). */
export interface Candidate {
  id: string;
  start: number;
  end: number;
  peak: number;
}

export interface Analysis {
  /** The median loudness of the sound (LUFS); `null` without sound. */
  average: number | null;
  /** One value a second: the loudest short-term loudness in it (LUFS, one decimal). */
  curve: number[];
  /** Every candidate (at most 100), the strongest first. */
  candidates: Candidate[];
}

const tenth = (seconds: number) => Math.round(seconds * 10) / 10;

/** One value a second from the short-term loudness: the loudest in each second. */
export function curveOf(short: Float32Array) {
  const curve: number[] = [];
  for (let i = 0; i < short.length; i += RATE) {
    let top = SILENT;
    for (let j = i; j < Math.min(short.length, i + RATE); j++) top = Math.max(top, short[j]!);
    curve.push(tenth(top));
  }
  return curve;
}

/**
 * The moments that stand out, as ranges. A moment is where the short-term
 * loudness is `STAND_OUT` LU above the average (parts closer than 3 s are
 * one). A reaction follows what caused it, so its range starts at the pause
 * before it (at least 4 s, at most 60 s before) and ends at the first pause
 * after it (at most 20 s after); without a pause there, at the quietest
 * moment. Ranges are 6–90 s; overlapping ones merge.
 */
export function analyse(values: Float32Array, duration: number): Analysis {
  const short = shortTerm(values);
  const curve = curveOf(short);
  const average = averageOf(values);
  if (average === null) return { average: null, curve, candidates: [] };
  const n = values.length;
  const loud = average + STAND_OUT;
  // The loud parts: [first, last] frame indices and their loudest short-term value.
  const moments: { a: number; b: number; top: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (short[i]! <= loud) continue;
    let j = i;
    let top = short[i]!;
    while (j + 1 < n && short[j + 1]! > loud) top = Math.max(top, short[++j]!);
    const last = moments.at(-1);
    if (last && i - last.b <= JOIN_GAP * RATE) Object.assign(last, { b: j, top: Math.max(last.top, top) });
    else moments.push({ a: i, b: j, top });
    i = j;
  }
  const quietLevel = Math.max(SILENT + 1, average - PAUSE_BELOW);
  const quiet = (i: number) => values[i]! < quietLevel;
  /** The last frame of the latest pause ending at or before `from` (searching back to `to`). */
  const pauseBefore = (from: number, to: number) => {
    let run = -1;
    for (let i = from; i >= to; i--) {
      if (!quiet(i)) run = -1;
      else if (run < 0) run = i;
      if (run >= 0 && run - i + 1 >= PAUSE_FRAMES) return run;
    }
    return null;
  };
  /** The first frame of the first pause starting at or after `from` (searching up to `to`). */
  const pauseAfter = (from: number, to: number) => {
    let run = -1;
    for (let i = from; i <= to; i++) {
      if (!quiet(i)) run = -1;
      else if (run < 0) run = i;
      if (run >= 0 && i - run + 1 >= PAUSE_FRAMES) return run;
    }
    return null;
  };
  const quietest = (from: number, to: number) => {
    let best = from;
    for (let i = from; i <= to; i++) if (values[i]! < values[best]!) best = i;
    return best;
  };
  const end = Math.max(0, duration);
  const ranges: { start: number; end: number; peak: number }[] = [];
  for (const moment of moments) {
    // The short-term window smears a moment by 1.5 s each way: take its middle back.
    const a = Math.min(n - 1, moment.a + (SHORT >> 1));
    const b = Math.max(a, moment.b - (SHORT >> 1));
    const backFrom = a - LEAD_IN * RATE;
    const backTo = Math.max(0, a - LOOK_BACK * RATE);
    let start: number;
    if (backFrom <= 0) start = 0;
    else {
      const pause = pauseBefore(backFrom, backTo);
      // Inside the pause, just before the sound comes back (a value covers the 400 ms before its time).
      start = pause !== null ? pause / RATE - 0.3 : quietest(Math.max(backTo, a - 30 * RATE), backFrom) / RATE - 0.2;
    }
    const aheadTo = Math.min(n - 1, b + LOOK_AHEAD * RATE);
    let stop: number;
    if (b + 1 > aheadTo) stop = end;
    else {
      const pause = pauseAfter(b + 1, aheadTo);
      stop = pause !== null ? pause / RATE : quietest(b + 1, Math.min(aheadTo, b + 10 * RATE)) / RATE - 0.2;
    }
    start = Math.max(0, start);
    stop = Math.min(end, Math.max(stop, start));
    if (stop - start < MIN_LENGTH) {
      stop = Math.min(end, start + MIN_LENGTH);
      start = Math.max(0, stop - MIN_LENGTH);
    }
    if (stop - start > MAX_LENGTH) {
      // Too long a lead: the range keeps the moment and ends where it did.
      start = Math.max(0, stop - MAX_LENGTH);
      if (start > a / RATE) {
        start = Math.max(0, a / RATE - LEAD_IN);
        stop = Math.min(end, start + MAX_LENGTH);
      }
    }
    if (stop - start < 1) continue;
    ranges.push({ start: tenth(start), end: tenth(stop), peak: tenth(moment.top - average) });
  }
  // Overlapping ranges merge; a merge longer than 90 s keeps the stronger one, the weaker one shortened (or dropped) to touch it.
  ranges.sort((x, y) => x.start - y.start);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (!last || range.start >= last.end) {
      merged.push({ ...range });
      continue;
    }
    if (Math.max(last.end, range.end) - last.start <= MAX_LENGTH) {
      Object.assign(last, { end: Math.max(last.end, range.end), peak: Math.max(last.peak, range.peak) });
    } else if (range.peak > last.peak) {
      last.end = range.start;
      if (last.end - last.start < MIN_LENGTH) merged.pop();
      merged.push({ ...range });
    } else if (range.end - last.end >= MIN_LENGTH) merged.push({ ...range, start: last.end });
  }
  const candidates = merged
    .map((range) => ({ id: String(Math.round(range.start * 10)), ...range }))
    .sort((x, y) => y.peak - x.peak || x.start - y.start)
    .slice(0, KEEP);
  return { average: tenth(average), curve, candidates };
}

/** What the user did with a suggestion. */
export type Handled = "added" | "dismissed";

/**
 * The suggestions the list shows: the `count` strongest of all (those added
 * or dismissed count too, so the list is what is left of them), in time
 * order; `total` is how many were picked, `dismissed` the ids of those
 * dismissed among them (Restore N dismissed brings them back).
 */
export function pick(candidates: readonly Candidate[], count: number, handled: Readonly<Record<string, Handled>>) {
  const strongest = [...candidates].sort((x, y) => y.peak - x.peak || x.start - y.start).slice(0, count);
  const left = strongest.filter((candidate) => !handled[candidate.id]).sort((x, y) => x.start - y.start);
  const dismissed = strongest.filter((candidate) => handled[candidate.id] === "dismissed").map((candidate) => candidate.id);
  return { left, total: strongest.length, dismissed };
}

/**
 * The row to select once `id` leaves the list (Enter, Delete): the next one,
 * or the one before when it was the last; "" when none is left.
 */
export function nextAfter(ids: readonly string[], id: string) {
  const index = ids.indexOf(id);
  if (index < 0) return "";
  return ids[index + 1] ?? ids[index - 1] ?? "";
}

/** Up and Down in the list: the row `step` away from `id`, held at the ends; from none, Down takes the first and Up the last. */
export function stepFrom(ids: readonly string[], id: string, step: number) {
  if (!ids.length) return "";
  const index = ids.indexOf(id);
  if (index < 0) return step > 0 ? ids[0]! : ids.at(-1)!;
  return ids[Math.max(0, Math.min(ids.length - 1, index + step))]!;
}

/** A row's thumbnail file: its suggestion and where it starts (an edited start is another picture). */
export const thumbName = (id: string, start: number) => `${id.replace(/[^\w-]/g, "")}-${Math.round(start * 10)}.jpg`;

const x = (seconds: number, duration: number) => (duration > 0 ? Math.max(0, Math.min(1000, (seconds / duration) * 1000)) : 0);
const fixed = (n: number) => String(Math.round(n * 10) / 10);

/**
 * The strip's curve as one path in a 1000 × 100 view box: a column per bin
 * (the loudest second in it), 0 at the bottom. Loudness is shown from 15 LU
 * under the average up to the loudest moment (at least 12 LU over it).
 * `seconds` limits it to what was scanned so far.
 */
export function curvePath(curve: readonly number[], average: number | null, duration: number, seconds = curve.length) {
  const known = Math.min(curve.length, Math.ceil(seconds));
  if (average === null || known <= 0 || duration <= 0) return "";
  let top = average + 12;
  for (let i = 0; i < known; i++) top = Math.max(top, curve[i]!);
  const low = average - 15;
  const height = (value: number) => 100 - Math.max(0, Math.min(1, (value - low) / (top - low))) * 92;
  const bins = Math.max(1, Math.min(BINS, Math.ceil(duration)));
  let path = "M 0 100";
  let reached = 0;
  for (let bin = 0; bin < bins; bin++) {
    const from = Math.floor((bin * duration) / bins);
    const to = Math.min(known, Math.max(from + 1, Math.floor(((bin + 1) * duration) / bins)));
    if (from >= known) break;
    let value = -Infinity;
    for (let i = from; i < to; i++) value = Math.max(value, curve[i]!);
    const y = fixed(height(value));
    path += ` L ${fixed(x(from, duration))} ${y} L ${fixed(x(to, duration))} ${y}`;
    reached = to;
  }
  return `${path} L ${fixed(x(reached, duration))} 100 Z`;
}

/** Bands for ranges in a 1000 × 10 view box, each at least `MIN_BAND` wide; "" for none. */
export function bandsPath(ranges: readonly { start: number; end: number }[], duration: number) {
  if (duration <= 0) return "";
  return ranges
    .map((range) => {
      const a = x(range.start, duration);
      const width = Math.max(MIN_BAND, x(range.end, duration) - a);
      const left = Math.max(0, Math.min(1000 - width, a));
      return `M ${fixed(left)} 0 H ${fixed(left + width)} V 10 H ${fixed(left)} Z`;
    })
    .join(" ");
}

/** The range whose band a click at `ratio` (0–1) of the strip falls on, as drawn (at least `MIN_BAND` wide). */
export function bandAt<T extends { start: number; end: number }>(ranges: readonly T[], ratio: number, duration: number): T | null {
  const at = ratio * 1000;
  for (const range of ranges) {
    const a = x(range.start, duration);
    const width = Math.max(MIN_BAND, x(range.end, duration) - a);
    const left = Math.max(0, Math.min(1000 - width, a));
    if (at >= left && at <= left + width) return range;
  }
  return null;
}

/** A time for the rows: `4:12.4`, `1:02:44.8` (tenths), or without them (`4:12`). */
export function short(seconds: number, tenths = true) {
  const t = Math.max(0, tenths ? Math.round(seconds * 10) / 10 : Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  const sec = tenths ? s.toFixed(1).padStart(4, "0") : String(Math.floor(s)).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** A total length for the footer: `5:08`. */
export function total(seconds: number) {
  const t = Math.round(Math.max(0, seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// ---------------------------------------------------------------- the scan

type Run = (args: string[], options: { timeoutMs: number; maxOutput?: number; signal?: AbortSignal }) => Promise<{ stdout: Uint8Array }>;

/**
 * Measure a video's sound, window by window (`WINDOW` seconds per ffmpeg
 * run, so that no output is large and a cancel or a new file stops it
 * within one run). After each run `between` gets the seconds done and the
 * values so far; it may throw to stop the scan (another file opened).
 */
export async function scanLoudness(run: Run, source: string, stream: number, duration: number, options: { signal: AbortSignal; between?: (done: number, values: Float32Array) => void | Promise<void>; window?: number }) {
  const values = emptyValues(duration);
  const window = options.window ?? WINDOW;
  for (let from = 0; from < duration; from += window) {
    options.signal.throwIfAborted();
    const length = Math.min(window, duration - from);
    const at = Math.max(0, from - LEAD);
    // About 60 bytes per 100 ms: a window's output is far under the limit.
    const { stdout } = await run(loudnessArgs(source, from, length, stream), { timeoutMs: 180_000, maxOutput: 8 << 20, signal: options.signal });
    parseMomentary(new TextDecoder().decode(stdout), at, from, values);
    await options.between?.(Math.min(duration, from + length), values);
  }
  return values;
}

/** ffprobe's arguments for the file's audio streams: one line per stream. */
export const audioStreamArgs = (source: string) => ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", source];
/** How many audio streams ffprobe listed. */
export const audioStreamCount = (text: string) => text.split("\n").filter((line) => line.trim() !== "").length;

// ---------------------------------------------------------------- the kept results

/** A scan as kept in the plugin's data folder: one small file per video and sound track. */
export interface HighlightScan {
  version: 1;
  path: string;
  size: number;
  mtimeMs: number;
  /** The audio stream scanned (ffmpeg's `0:a:N`). */
  stream: number;
  /** When it was scanned (ms since 1970). */
  scanned: number;
  /** Step 1 measures loudness only. */
  mode: "loudness";
  duration: number;
  average: number | null;
  curve: number[];
  candidates: Candidate[];
  /** Added or dismissed suggestions, by id. */
  handled: Record<string, Handled>;
  /** A suggestion's edges as the user moved them (Set Clip Start / End while it was selected). */
  edits: Record<string, { start: number; end: number }>;
}

export interface Stamp {
  path: string;
  size: number;
  mtimeMs: number;
  stream: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRange = (value: unknown): value is { start: number; end: number } => isObject(value) && isNumber(value.start) && isNumber(value.end) && value.end > value.start;

/** A kept file as data, or `null` when it is not one (damaged, another version). */
export function savedOf(value: unknown): HighlightScan | null {
  if (!isObject(value) || value.version !== 1 || value.mode !== "loudness") return null;
  const { path, size, mtimeMs, stream, scanned, duration, average, curve, candidates, handled, edits } = value;
  if (typeof path !== "string" || !isNumber(size) || !isNumber(mtimeMs) || !Number.isInteger(stream) || !isNumber(scanned) || !isNumber(duration)) return null;
  if (!(average === null || isNumber(average)) || !Array.isArray(curve) || !curve.every(isNumber) || !Array.isArray(candidates)) return null;
  const list = candidates.filter((c): c is Candidate => isRange(c) && typeof (c as Candidate).id === "string" && isNumber((c as Candidate).peak));
  const states: Record<string, Handled> = {};
  for (const [id, state] of Object.entries(isObject(handled) ? handled : {})) if (state === "added" || state === "dismissed") states[id] = state;
  const moved: Record<string, { start: number; end: number }> = {};
  for (const [id, range] of Object.entries(isObject(edits) ? edits : {})) if (isRange(range)) moved[id] = { start: range.start, end: range.end };
  return { version: 1, path, size, mtimeMs, stream: stream as number, scanned, mode: "loudness", duration, average: average as number | null, curve: curve as number[], candidates: list, handled: states, edits: moved };
}

/** A kept scan's file name: a hash of the video's path and its track. */
export const keptName = (path: string, stream: number) => `${createHash("sha256").update(`${path}\0${stream}`).digest("hex").slice(0, 24)}.json`;

/**
 * The kept scans in `<data>/highlights/`: one JSON file per video and sound
 * track, named by a hash of its path and track. A file is the same file
 * while its size and modification time are (VestraBili's stamp); a changed
 * one drops its result. The 50 most recently used are kept.
 */
export class HighlightStore {
  #writes = new Map<string, Promise<void>>();
  readonly folder: string | null;
  constructor(folder: string | null) {
    this.folder = folder;
  }

  #file(path: string, stream: number) {
    return this.folder ? join(this.folder, keptName(path, stream)) : null;
  }

  /** The folder of a kept scan's row thumbnails (`<hash>/` beside `<hash>.json`); it goes with its scan. */
  thumbFolder(path: string, stream: number) {
    return this.folder ? join(this.folder, keptName(path, stream).slice(0, -".json".length)) : null;
  }

  /**
   * The thumbnails kept for a scan: those still wanted (`wanted`, file names)
   * are returned; the others (a suggestion scanned again, an edge moved) are
   * deleted.
   */
  async thumbs(path: string, stream: number, wanted: ReadonlySet<string>) {
    const folder = this.thumbFolder(path, stream);
    const found = new Set<string>();
    if (!folder) return found;
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (wanted.has(name)) found.add(name);
      else await rm(join(folder, name), { force: true }).catch(() => {});
    }
    return found;
  }

  /** A kept scan and its thumbnails go. */
  async #drop(file: string) {
    await Promise.all([rm(file, { force: true }), rm(file.slice(0, -".json".length), { recursive: true, force: true })]).catch(() => {});
  }

  /** The file's stamp now; `null` when it cannot be read. */
  async stamp(path: string, stream: number): Promise<Stamp | null> {
    const info = await stat(path).catch(() => null);
    return info?.isFile() ? { path, size: info.size, mtimeMs: Math.round(info.mtimeMs), stream } : null;
  }

  /** The kept scan of this file and track; `changed` when the file is not the one scanned (its result is dropped). */
  async load(stamp: Stamp): Promise<HighlightScan | "changed" | null> {
    const file = this.#file(stamp.path, stamp.stream);
    if (!file) return null;
    await this.#writes.get(file);
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) return null;
    let saved: HighlightScan | null = null;
    try {
      saved = savedOf(JSON.parse(text));
    } catch {
      // damaged: dropped below
    }
    if (!saved || saved.path !== stamp.path || saved.stream !== stamp.stream) {
      await this.#drop(file);
      return null;
    }
    if (saved.size !== stamp.size || saved.mtimeMs !== stamp.mtimeMs) {
      await this.#drop(file);
      return "changed";
    }
    // Used now: the most recent.
    const now = new Date();
    await utimes(file, now, now).catch(() => {});
    return saved;
  }

  /** Keep a scan (replacing the file's earlier one); the oldest beyond 50 go. Writes of one file are in order. */
  save(saved: HighlightScan) {
    const file = this.#file(saved.path, saved.stream);
    if (!file || !this.folder) return Promise.resolve();
    const folder = this.folder;
    const text = JSON.stringify(saved);
    const write = (this.#writes.get(file) ?? Promise.resolve()).then(async () => {
      await mkdir(folder, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, text);
      await rename(temporary, file);
      await this.#prune();
    });
    const settled = write.catch((error: unknown) => console.error(`[clipexport] highlights: ${(error as Error).message}`));
    this.#writes.set(file, settled);
    return settled;
  }

  async #prune() {
    if (!this.folder) return;
    const all = await readdir(this.folder).catch(() => [] as string[]);
    // A write a crash or a full disk cut short leaves its temporary file: gone once it is a minute old (none is written that long).
    for (const name of all.filter((name) => name.endsWith(".tmp"))) {
      const info = await stat(join(this.folder, name)).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 60_000) await rm(join(this.folder, name), { force: true }).catch(() => {});
    }
    const names = all.filter((name) => name.endsWith(".json"));
    // A thumbnail folder whose scan is gone goes too.
    const scans = new Set(names);
    for (const name of all) {
      if (name.endsWith(".json") || name.endsWith(".tmp") || scans.has(`${name}.json`)) continue;
      if ((await stat(join(this.folder, name)).catch(() => null))?.isDirectory()) await rm(join(this.folder, name), { recursive: true, force: true }).catch(() => {});
    }
    if (names.length <= CACHE_LIMIT) return;
    const dated = await Promise.all(names.map(async (name) => ({ name, time: (await stat(join(this.folder!, name)).catch(() => null))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => b.time - a.time);
    for (const { name } of dated.slice(CACHE_LIMIT)) await this.#drop(join(this.folder, name));
  }
}
