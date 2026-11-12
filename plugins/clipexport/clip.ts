import type { ExportEncoding, PlayerState } from "@vestra-player/sdk";
import { Failure } from "./model.ts";

/**
 * Pure clip rules of the Clip Export tab (the Snapshots & Clips design §3.3–§3.6 of the player): the two
 * cutting methods, A-B and "Last N s" ranges, keyframe snapping, the small
 * timeline, Precise presets and the estimates. No host calls here; the parts
 * that wait for host requests R1–R7 are in seams.ts.
 */

/** Fast: stream copy, starts on a keyframe (R1). Precise: re-encode from the exact frame (today's export). */
export type Method = "fast" | "precise";
export const METHODS: readonly Method[] = ["fast", "precise"];
/** The method a clip uses: the user's choice, or Precise while the player cannot copy streams. */
export const effectiveMethod = (chosen: Method, fastCut: boolean): Method => (fastCut ? chosen : "precise");

// ---------------------------------------------------------------- ranges
/** The lengths "Last N s" offers (proposal open question 4: adjustable, 30 s by default). */
export const LAST_SECONDS = [10, 30, 60, 120] as const;
export const lastSeconds = (value: unknown) => (LAST_SECONDS as readonly number[]).includes(Number(value)) ? Number(value) : 30;

/**
 * "Last N s": from N seconds before the position (not before 0) to the
 * position. `tooEarly` when less than 0.1 s has played.
 */
export function lastRange(position: number | null, seconds: number) {
  const end = position ?? 0;
  const start = Math.max(0, end - seconds);
  if (!Number.isFinite(end) || end - start < 0.1) throw new Failure("tooEarly");
  return { start, end };
}

/**
 * "Use A-B range": a one-time copy of the player's A-B loop (public
 * `PlayerState.loop`); `null` while there is none. TODO(R7): also read the A
 * and B points while the loop is switched off, once the player reports them.
 */
export function abRange(state: Pick<PlayerState, "loop">): { start: number; end: number } | null {
  const loop = state.loop;
  if (!loop || !Number.isFinite(loop.a) || !Number.isFinite(loop.b) || loop.b <= loop.a) return null;
  return { start: loop.a, end: loop.b };
}

/**
 * Export Clip… on a fresh tab: 10 s from the position; within the last 10 s of
 * the media, its last 10 s (all of a shorter one), never past the end.
 */
export function defaultRange(position: number | null, duration: number | null) {
  const length = 10;
  const known = duration !== null && Number.isFinite(duration) && duration > 0;
  const at = Math.max(0, position ?? 0);
  if (!known || at + length <= duration) return { start: at, end: at + length };
  return { start: Math.max(0, duration - length), end: duration };
}

// ---------------------------------------------------------------- keyframes (Fast)
/**
 * ffprobe's arguments for the video key packets around a window (no decoding:
 * packet flags only). `-read_intervals` seeks to the keyframe at or before
 * `from`, so the keyframe a Fast cut starts on is always included.
 */
export const keyframeArgs = (path: string, from: number, to: number) => [
  "-v", "error",
  "-select_streams", "v:0",
  "-read_intervals", `${Math.max(0, from).toFixed(3)}%${Math.max(from, to).toFixed(3)}`,
  "-show_entries", "packet=pts_time,flags",
  "-of", "csv=p=0",
  path,
];

/**
 * The times of the key packets in ffprobe's `pts_time,flags` lines, sorted,
 * without repeats, on the player's clock: `offset` is the file's start time
 * (ffprobe reports container timestamps; the player's positions start at 0).
 */
export function parseKeyframes(stdout: string, offset = 0): number[] {
  const times = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const [time, flags] = line.split(",");
    const seconds = Number(time) - offset;
    if (time && flags?.includes("K") && Number.isFinite(seconds) && seconds >= 0) times.add(Math.round(seconds * 1000) / 1000);
  }
  return [...times].sort((a, b) => a - b);
}

/** The keyframe a Fast cut starts on: the last at or before `start`; `null` when none is known. */
export function snapStart(keyframes: readonly number[], start: number): number | null {
  let found: number | null = null;
  for (const time of keyframes) if (time <= start + 0.0005) found = time;
  return found;
}

/** ffprobe's arguments for the first video stream's codec (the Fast container preview) and the file's start time (the keyframes' offset). */
export const codecArgs = (path: string) => ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name:format=start_time", "-of", "default=noprint_wrappers=1", path];
/** The codec and start time in ffprobe's `key=value` lines; a missing or unknown start time is 0. */
export function parseCodec(stdout: string): { video: string | null; offset: number } {
  const value = (key: string) => stdout.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  const video = value("codec_name");
  const offset = Number(value("start_time"));
  return { video: video && video !== "N/A" ? video : null, offset: value("start_time") && Number.isFinite(offset) ? offset : 0 };
}

const MP4_VIDEO = new Set(["h264", "hevc", "av1", "vp9", "mpeg4"]);
const MP4_AUDIO = new Set(["aac", "mp3", "alac", "opus", "flac", "ac3", "eac3"]);
/**
 * The container a Fast cut writes (proposal §3.3): MP4 when the video and the
 * chosen audio fit in it, MKV otherwise; `""` while the video codec is unknown.
 * The player decides in the end (R1) and reports the file it wrote.
 */
export function fastContainer(video: string | null, audio: string | null): "mp4" | "mkv" | "" {
  if (!video) return "";
  return MP4_VIDEO.has(video.toLowerCase()) && (!audio || MP4_AUDIO.has(audio.toLowerCase())) ? "mp4" : "mkv";
}

// ---------------------------------------------------------------- the small timeline
export type Timeline = {
  shown: boolean;
  /** Ratios 0–1 of the window: the range typed, the range written, the playhead (-1 outside), the keyframe used (-1 none). */
  wanta: number;
  wantb: number;
  gota: number;
  gotb: number;
  head: number;
  key: number;
  /** The keyframe ticks as Path commands in a 1000 × 10 viewbox ("" without any). */
  ticks: string;
};
export const NO_TIMELINE: Timeline = { shown: false, wanta: 0, wantb: 0, gota: 0, gotb: 0, head: -1, key: -1, ticks: "" };

/** The window the small timeline shows: about 30 s around the clip, inside the media. */
export function timelineWindow(start: number, end: number, duration: number | null) {
  const length = end - start;
  const pad = Math.max(2, (30 - length) / 2);
  const from = Math.max(0, start - pad);
  const to = Math.min(duration ?? Infinity, end + pad);
  return { from, to: to > from ? to : from + 1 };
}

/** The small timeline (proposal §3.2): what was typed, what will be written, keyframes and the playhead. */
export function timeline(range: { start: number; end: number }, actual: { start: number; end: number }, keyframes: readonly number[], playhead: number | null, duration: number | null, used: number | null): Timeline {
  const { from, to } = timelineWindow(Math.min(range.start, actual.start), Math.max(range.end, actual.end), duration);
  const at = (time: number) => Math.min(1, Math.max(0, (time - from) / (to - from)));
  const round = (ratio: number) => Math.round(ratio * 10000) / 10000;
  const ticks = keyframes
    .filter((time) => time >= from && time <= to)
    .map((time) => `M ${Math.round(at(time) * 1000)} 0 V 10`)
    .join(" ");
  return {
    shown: true,
    wanta: round(at(range.start)),
    wantb: round(at(range.end)),
    gota: round(at(actual.start)),
    gotb: round(at(actual.end)),
    head: playhead === null || playhead < from || playhead > to ? -1 : round(at(playhead)),
    key: used === null ? -1 : round(at(used)),
    ticks,
  };
}

// ---------------------------------------------------------------- Precise quality (R6)
/** What a Precise cut writes: an H.264 + AAC MP4 (the player's encode), or an animated GIF or WebP (the plugin's ffmpeg step after it). */
export type Format = "mp4" | "gif" | "webp";
export type Animated = Exclude<Format, "mp4">;
/** The animated image a Precise cut writes (GIF or WebP, without sound); `null` for an MP4. */
export const animatedOf = (encode: Encode | undefined): Animated | null => (encode && encode.format !== "mp4" ? encode.format : null);

/** The encode options of a Precise cut (request R6): finite choices, never free FFmpeg arguments. */
export interface Encode {
  /**
   * `mp4`: the player writes the file. `gif` / `webp` (0.5.0): the player
   * writes an MP4 into the plugin's work folder with the fields below (fixed
   * for these presets), then the plugin's ffmpeg makes the animated image of
   * it (animated.ts).
   */
  format: Format;
  /** `crf`: a quality level; `source`: the source video's average bitrate ("Same as source"; the CRF is then unused). */
  rate: "crf" | "source";
  /** 14–30: lower is a better picture and a bigger file. */
  crf: number;
  speed: "faster" | "balanced" | "smaller";
  /** 0 = the source's height. */
  height: 0 | 1080 | 720 | 480;
  /** 0 = the source's frame rate. */
  fps: 0 | 60 | 30;
  audio: 128 | 192 | 256;
}
export type Preset = "source" | "high" | "small" | "gif" | "webp" | "custom";
/** The Quality chooser's order; Custom, when it shows, comes after them. */
export const PRESETS: readonly Exclude<Preset, "custom">[] = ["source", "high", "small", "gif", "webp"];
/**
 * The three presets (design §3.5). `high` is the encoding clips always had
 * (CRF 18, x264 veryfast, AAC 192 kb/s, the source's size and rate), so the
 * default output does not change. `source` aims at the source video's
 * average bitrate (`videoBitrate: "source"`); `small` is CRF 26 at most 1080p.
 * `gif` and `webp` (0.5.0): the H.264 fields are those of the intermediate
 * MP4 the player writes for the plugin's ffmpeg step: the best quality (CRF
 * 14, fast), at most 720p (the image is at most 640 px on its longer side, so
 * 720 lines always hold it) and 30 fps (the image has 15 or 20). A clip is
 * read without sound; a merge has the parts' sound (the parts export has no
 * way to leave it out, SDK 1.7.9), at the lowest AAC rate, and the image
 * leaves it out.
 */
const INTERMEDIATE = { rate: "crf", crf: 14, speed: "faster", height: 720, fps: 30, audio: 128 } as const;
export const PRESET_ENCODE: Readonly<Record<Exclude<Preset, "custom">, Encode>> = {
  source: { format: "mp4", rate: "source", crf: 18, speed: "balanced", height: 0, fps: 0, audio: 256 },
  high: { format: "mp4", rate: "crf", crf: 18, speed: "faster", height: 0, fps: 0, audio: 192 },
  small: { format: "mp4", rate: "crf", crf: 26, speed: "balanced", height: 1080, fps: 0, audio: 128 },
  gif: { format: "gif", ...INTERMEDIATE },
  webp: { format: "webp", ...INTERMEDIATE },
};
export const SPEEDS: readonly Encode["speed"][] = ["faster", "balanced", "smaller"];
export const HEIGHTS: readonly Encode["height"][] = [0, 1080, 720, 480];
export const RATES: readonly Encode["fps"][] = [0, 60, 30];
export const AUDIO_RATES: readonly Encode["audio"][] = [128, 192, 256];
export const crfOf = (value: unknown) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(30, Math.max(14, n)) : 18;
};
/**
 * Any valid encode options from stored data, field by field; High quality's
 * for the rest. An animated format gets its preset's fixed fields; 0.4.x
 * settings (no format) are an MP4.
 */
export function encodeOf(value: unknown): Encode {
  const v = (typeof value === "object" && value !== null ? value : {}) as Partial<Record<keyof Encode, unknown>>;
  const high = PRESET_ENCODE.high;
  const pick = <T>(list: readonly T[], item: unknown, fallback: T) => (list.includes(item as T) ? (item as T) : fallback);
  if (v.format === "gif" || v.format === "webp") return { ...PRESET_ENCODE[v.format] };
  return {
    format: "mp4",
    rate: v.rate === "source" ? "source" : "crf",
    crf: v.crf === undefined ? high.crf : crfOf(v.crf),
    speed: pick(SPEEDS, v.speed, high.speed),
    height: pick(HEIGHTS, v.height, high.height),
    fps: pick(RATES, v.fps, high.fps),
    audio: pick(AUDIO_RATES, v.audio, high.audio),
  };
}
/** The preset whose options these are, `custom` when none (the Quality box then says Custom). */
export function presetOf(encode: Encode): Preset {
  const key = (e: Encode) => JSON.stringify([e.format, e.rate, e.rate === "crf" ? e.crf : 0, e.speed, e.height, e.fps, e.audio]);
  return PRESETS.find((preset) => key(PRESET_ENCODE[preset]) === key(encode)) ?? "custom";
}

/**
 * The player's encoder settings for a Precise cut (`ExportEncoding`, SDK
 * 1.6.10): a closed set, never encoder arguments. A source bitrate replaces
 * the CRF; the source's height and rate (0) are left out. `threads: "auto"`
 * always (coordinator ruling 2026-11-07, measured: one thread encodes 4K
 * about 10x slower than real time, `auto` 4–5x faster; the player caps it at
 * half the logical processors and runs exports below normal priority, and
 * playback held its rate during a Precise export in the GUI check).
 */
export function exportEncoding(encode: Encode): ExportEncoding {
  return {
    ...(encode.rate === "source" ? { videoBitrate: "source" as const } : { crf: encode.crf }),
    speed: encode.speed,
    ...(encode.height ? { maxHeight: encode.height } : {}),
    ...(encode.fps ? { fps: encode.fps } : {}),
    audioBitrate: encode.audio,
    threads: "auto",
  };
}

// ---------------------------------------------------------------- estimates
export interface Estimate {
  /** Seconds of media. */
  length: number;
  /** Megabytes, a range (equal ends when it is one number); 0 when unknown. */
  sizelow: number;
  sizehigh: number;
  /** Seconds of work, a range; 0 when unknown. */
  timelow: number;
  timehigh: number;
}
/** A conservative disk speed for stream copies, bytes per second. */
const COPY_SPEED = 50e6;
/**
 * Megabytes per second of an animated image at its preset (GIF 480 px 15 fps,
 * WebP 640 px 20 fps): a wide range, as the content decides (measured on
 * 0.5.0's samples: detailed film about 0.4 MB/s as GIF and 0.17 as WebP, a
 * still screen a small fraction of that). The source's size does not count.
 */
const ANIMATED_MB_PER_SECOND = { gif: [0.1, 0.5], webp: [0.04, 0.2] } as const;
/**
 * Size and time of a clip (proposal §3.5), all approximate ("≈"):
 * - Fast: the source's share of its file size; time from a slow disk.
 * - Animated GIF or WebP: a wide range per second of the image.
 * - Precise: a range around the source's average rate, scaled by the
 *   quality number (each 6 CRF about halves the size) and the height cap;
 *   time from the last Precise export measured on this machine (seconds of
 *   work per second of media), else a wide range.
 */
export function estimate(input: { method: Method; length: number; fileBytes: number | null; duration: number | null; encode: Encode; secondsPerSecond: number | null; height: number | null }): Estimate {
  const { method, length, fileBytes, duration, encode, secondsPerSecond, height } = input;
  const share = fileBytes && duration && duration > 0 ? (fileBytes * Math.min(length, duration)) / duration : null;
  const mb = (bytes: number) => Math.max(0.1, Math.round((bytes / 1e6) * 10) / 10);
  if (method === "fast") {
    const time = share === null ? 0 : Math.max(1, Math.ceil(share / COPY_SPEED));
    return { length, sizelow: share === null ? 0 : mb(share), sizehigh: share === null ? 0 : mb(share), timelow: time, timehigh: time };
  }
  let sizelow = 0, sizehigh = 0;
  const animated = animatedOf(encode);
  if (animated) {
    const [low, high] = ANIMATED_MB_PER_SECOND[animated];
    sizelow = mb(length * low * 1e6);
    sizehigh = mb(length * high * 1e6);
  } else if (share !== null) {
    // A source bitrate: about the source's share, with peaks up to 1.5 times it.
    const quality = encode.rate === "source" ? 1 : Math.pow(2, (18 - encode.crf) / 6);
    const scale = encode.height && height && height > encode.height ? Math.pow(encode.height / height, 2) : 1;
    sizelow = mb(share * (encode.rate === "source" ? 0.9 : 0.7) * quality * scale);
    sizehigh = mb(share * (encode.rate === "source" ? 1.2 : 1.3) * quality * scale);
  }
  const timelow = secondsPerSecond ? Math.max(1, Math.round(length * secondsPerSecond * 0.8)) : Math.max(1, Math.round(length * 0.3));
  const timehigh = secondsPerSecond ? Math.max(timelow, Math.round(length * secondsPerSecond * 1.25)) : Math.max(timelow, Math.round(length * 3));
  return { length, sizelow, sizehigh, timelow, timehigh };
}
