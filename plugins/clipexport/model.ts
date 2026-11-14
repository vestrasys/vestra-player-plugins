import { lstat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { I18n, PlayerState } from "@vestra-player/sdk";
import type { Encode, Method } from "./clip.ts";

/** Pure export rules: parsing, validation, ranges and file naming. */
export interface Spec {
  start: number;
  end: number;
  /** Re-encode with the video effects (Precise only). */
  processed: boolean;
  /** Burn in the subtitles shown (Precise, with `processed`). */
  subtitles: boolean;
  /** Clip audio: a track id, `selected` or `none`. */
  track: string;
  /** Stream copy (`fast`) or re-encode (`precise`). */
  method: Method;
  /** The encode options of a Precise cut (R6); the encoding clips always had when absent. */
  encode?: Encode;
}

/**
 * Every reason the plugin gives in its own words (English source text). The
 * tab says the same texts through `Words.reason` in ui/parts.slint (a test
 * keeps the two lists equal); the OSD shows them as text values.
 */
export const REASON = {
  time: "Enter a time such as 1:02:03.450, or seconds.",
  endBeforeStart: "The end must be after the start.",
  noName: "No free file name found.",
  unexportable: "Nothing to export. Open a local video file first.",
  needDuration: "Clips need a known media duration.",
  outOfRange: "The selected range is past the end of the media.",
  track: "The selected audio track cannot be exported. Choose another track or No Audio.",
  changed: "The media changed; nothing was started.",
  busy: "The player is busy. Try again later.",
  unavailable: "This video cannot be exported now.",
  captureFailed: "Could not read the video for the export.",
  queueFull: "One export is running and four are queued. Please wait.",
  expired: "The kept input has expired. Retry with the current video.",
  released: "The kept input was released.",
  cancelled: "Cancelled.",
  space: "Not enough disk space",
  exists: "The target file already exists",
  permission: "No write permission",
  encoder: "This media cannot be encoded",
  exportFailed: "Export failed",
  noOutput: "This task has no output file yet.",
  cannotOpen: "Could not open the folder.",
  folderUnavailable: "The clip folder is unavailable. Please choose it again.",
  needLocal: "Clips need a local file.",
  noLoop: "Set A and B with A-B Loop (Chapters tab).",
  tooEarly: "Nothing has played before the current position yet.",
  fastImpossible: "Fast cut is not possible for this file. Use Precise.",
  noSourceBitrate: "The bitrate of this file is unknown. Choose another quality.",
  folderGone: "The file or folder was moved or deleted.",
  addLocal: "Only local files can be added to the Collection.",
  collectionFull: "The Collection holds 100 parts. Remove one first.",
  tooManyFiles: "Clip Export remembers at most 500 files. Remove parts of other files first.",
  emptyCollection: "The Collection is empty. Add a range first.",
  partMissing: "A part's file is missing. Locate it or remove the part.",
  partChanged: "A part's file has changed. Locate it or remove the part.",
  // The player keeps no reference for the token: forgotten (a development load's references end with the player's run).
  partUnknown: "The player no longer remembers a part's file. Remove the part and add its range again.",
  cannotRead: "The player cannot read this file.",
  noCapability: "This version of the player cannot do this.",
  noFfmpeg: "The transitions need FFmpeg, which the player could not find.",
  transitionFailed: "Could not write the transitions.",
  undoFull: "There is no room to bring the cleared parts back: the Collection holds at most 100. Remove parts, then Undo again.",
  noAnimatedFfmpeg: "Animated GIF and WebP need FFmpeg, which the player could not find.",
  noAnimatedEncoder: "The player's FFmpeg cannot write this format. Choose another output.",
  animatedTooLong: "Animated GIF and WebP are at most 60 seconds long. Choose a shorter range.",
  animatedFailed: "Could not write the animated image.",
  noScanFfmpeg: "Finding highlights needs FFmpeg.",
  modelFailed: "The sound model could not start on this computer.",
} as const;
export type Reason = keyof typeof REASON;

/** The reasons an export job ends with (`jobError`, a released input). */
export type JobReason = "space" | "exists" | "permission" | "encoder" | "exportFailed" | "released" | "fastImpossible" | "noSourceBitrate" | "partMissing" | "partChanged" | "partUnknown" | "noFfmpeg" | "transitionFailed" | "noAnimatedFfmpeg" | "animatedFailed";
const JOB_REASONS: readonly Reason[] = ["space", "exists", "permission", "encoder", "exportFailed", "released", "fastImpossible", "noSourceBitrate", "partMissing", "partChanged", "partUnknown", "noFfmpeg", "transitionFailed", "noAnimatedFfmpeg", "animatedFailed"];

/** A failure in the plugin's own words: `code` names its text in {@link REASON}. */
export class Failure extends Error {
  readonly code: Reason;
  constructor(code: Reason) {
    super(REASON[code]);
    this.code = code;
  }
}

/** A failure as data for the tab or the OSD: the plugin's reason, or (reason "") the player's or system's own message. */
export type Problem<R extends string = Reason> = { reason: R | ""; raw: string };
export const problemOf = (error: unknown): Problem =>
  error instanceof Failure ? { reason: error.code, raw: "" } : { reason: "", raw: message(error) };
/** A task failure: a job reason, or the message of anything else. */
export const jobProblem = (error: unknown): Problem<JobReason> =>
  error instanceof Failure && JOB_REASONS.includes(error.code) ? { reason: error.code as JobReason, raw: "" } : { reason: "", raw: message(error) };

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A time as the user types it: `1:02:03.450`, `02:03.450` or seconds (`62.5`).
 * Minutes and seconds after a colon are below 60; `null` when it is none of these.
 */
export function parseTime(value: unknown): number | null {
  const text = String(value ?? "").trim();
  const parts = text.split(":");
  if (!text || parts.length > 3) return null;
  // The seconds may be `5`, `5.25`, `.5` or `5.`; the parts before them are whole numbers.
  if (!parts.every((part, index) => (index === parts.length - 1 ? /^(\d+\.?\d*|\.\d+)$/ : /^\d+$/).test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((n) => n >= 60)) return null;
  const seconds = numbers.reduce((total, n) => total * 60 + n, 0);
  return Number.isFinite(seconds) ? seconds : null;
}

/** A start and end as typed: `time` when one is no time, `endBeforeStart` when the end is not after the start. */
export function parseRange(start: unknown, end: unknown) {
  const a = parseTime(start);
  const b = parseTime(end);
  if (a === null || b === null) throw new Failure("time");
  if (b <= a) throw new Failure("endBeforeStart");
  return { start: a, end: b };
}

/** The first unused `name (n).ext` next to `path`; existing files and `taken` paths are never chosen. */
export async function uniqueFile(path: string, taken: ReadonlySet<string> = new Set()) {
  const absolute = resolve(path);
  const extension = extname(absolute);
  const stem = basename(absolute, extension);
  for (let i = 0; i < 1000; i++) {
    const candidate = i ? join(dirname(absolute), `${stem} (${i})${extension}`) : absolute;
    if (taken.has(candidate)) continue;
    try {
      await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Failure("noName");
}

/** `1:02:03.450` style time for file names and rows (no hours below one hour). */
export function clock(seconds: number, separator = ":") {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${h ? `${h}${separator}` : ""}${two(m)}${separator}${two(s)}.${String(ms % 1000).padStart(3, "0")}`;
}

/** The source's file name without its extension (`clip` without one), safe in a file name. */
export function stemOf(source: string | null) {
  const path = source?.split(/[?#]/)[0] ?? "";
  const stem = path ? basename(path, extname(path)) : "";
  return (stem || "clip").replace(/[\\/:*?"<>|]/g, "_");
}

/** The player can take a snapshot of the source now (the input of every export). */
export const usable = (state: PlayerState) =>
  state.kind === "media" && (state.phase === "ready" || state.phase === "ended") && state.can.snapshot;

/**
 * A chosen file name with the extension of what will be written: the
 * container follows the format (as LosslessCut does), so a re-encode named
 * `.mkv` in the save dialog becomes `.mp4` instead of an MP4 inside an MKV name
 * (and an animated GIF named `.mp4` becomes `.gif`).
 */
export const withExtension = (path: string, extension: string) => `${path.replace(/\.(mp4|mkv|gif|webp)$/i, "")}${extension}`;

/** A local file path (not a URL). */
export const isLocal = (source: string | null): source is string =>
  !!source && isAbsolute(source) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(source);

/**
 * What the tab offers for the current source: `local` everything; `network`
 * nothing (clips need a local file); `stream` a picture made by a plugin;
 * `none` nothing playing.
 */
export type TabMode = "local" | "network" | "stream" | "none";
export function tabMode(state: PlayerState): TabMode {
  if (state.kind === "stream") return "stream";
  if (!usable(state)) return "none";
  return isLocal(state.source) ? "local" : "network";
}
/** A clip can be cut: a local file with a known duration. */
export const clippable = (state: PlayerState) =>
  tabMode(state) === "local" && state.duration !== null && Number.isFinite(state.duration) && state.duration > 0;
/** Why no clip can be cut now. */
export const notClippable = (state: PlayerState): Reason =>
  tabMode(state) === "local" ? "needDuration" : tabMode(state) === "network" ? "needLocal" : "unexportable";

export function validate(spec: Spec, state: PlayerState) {
  if (!usable(state)) throw new Failure("unexportable");
  const { duration } = state;
  if (duration === null || !Number.isFinite(duration)) throw new Failure("needDuration");
  if (spec.start >= duration || spec.end > duration) throw new Failure("outOfRange");
}

/** One source-internal audio track for a clip, or none. */
export function chooseAudio(spec: Spec, state: PlayerState): number | "none" {
  if (spec.track === "none") return "none";
  const tracks = state.audioTracks;
  const track = spec.track === "selected" ? tracks?.find((t) => t.selected) : tracks?.find((t) => t.id === Number(spec.track));
  if (!track && spec.track === "selected" && !tracks?.length) return "none";
  if (!track || !track.exportable) throw new Failure("track");
  return track.id;
}

/**
 * Clip audio choices: index 0 none, 1 the selected track, then each track.
 * The labels are text values: the player says the words, the track is data.
 */
export function audioChoices(state: PlayerState, text: I18n["text"]) {
  const tracks = state.audioTracks ?? [];
  return {
    labels: [
      text("No Audio"),
      text("Current Track"),
      ...tracks.map((t) => (t.title || t.language ? text("Track {} · {}", [t.id, t.title ?? t.language!]) : text("Track {}", [t.id]))),
    ],
    values: ["none", "selected", ...tracks.map((t) => String(t.id))],
  };
}
