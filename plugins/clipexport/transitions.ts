import { availableParallelism } from "node:os";
import type { Encode } from "./clip.ts";

/**
 * Transitions between the Collection's parts (design clip-transitions, ruling
 * of 2026-11-10: no host change). The player exports the plain merge (cuts)
 * through the parts export; the plugin then runs the player's ffmpeg once over
 * that file: it cuts it at the junctions, blends neighbours with `xfade` and
 * `acrossfade` (overlap: the video gets shorter by each transition) and
 * encodes the result with the Precise settings.
 */

/** The kinds the picker offers (design §4.2, Q4 a). */
export const KINDS = ["cut", "crossfade", "fadeBlack", "fadeWhite", "wipe", "slide"] as const;
export type Kind = (typeof KINDS)[number];
/** The way the new picture moves (Wipe and Slide). */
export const DIRECTIONS = ["left", "right", "up", "down"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** The transition from a part into the next one. */
export interface Transition {
  kind: Kind;
  /** Wipe and Slide; kept (unused) for the other kinds, so a change of kind remembers it. */
  dir: Direction;
  /** Seconds, in 0.1 s steps. */
  duration: number;
}

export const CUT: Transition = { kind: "cut", dir: "left", duration: 1 };
/** The presets of the picker's duration row, and the duration a kind gets when it is first picked on a Cut (Q5 a). */
export const PRESET_DURATIONS = [0.5, 1, 1.5, 2] as const;
export const FIRST_DURATION = 1;
/** The shortest transition, and the longest one typed (the API sketch's bounds, §3.1). */
export const MIN_DURATION = 0.1;
export const MAX_DURATION = 10;

const tenth = (seconds: number) => Math.round(seconds * 10) / 10;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A stored transition, field by field; anything else is a Cut (0.2.x parts have none). */
export function transitionOf(value: unknown): Transition {
  const v = (value ?? {}) as Partial<Transition>;
  const kind = KINDS.includes(v.kind as Kind) ? (v.kind as Kind) : "cut";
  const dir = DIRECTIONS.includes(v.dir as Direction) ? (v.dir as Direction) : "left";
  const duration = finite(v.duration) && v.duration > 0 ? tenth(Math.min(MAX_DURATION, Math.max(MIN_DURATION, v.duration))) : FIRST_DURATION;
  return { kind, dir, duration };
}

/** The longest transition between two parts: half of the shorter one (CapCut's rule, §2.3), in 0.1 s steps down, at most 10 s. */
export function capOf(a: { start: number; end: number }, b: { start: number; end: number }) {
  const half = Math.min(a.end - a.start, b.end - b.start) / 2;
  return Math.min(MAX_DURATION, Math.floor(half * 10 + 1e-6) / 10);
}

/**
 * Every part's transition as it can be: the last part has none (Cut), each
 * duration is at most its neighbours' limit, and a junction whose parts are
 * too short for 0.1 s is a Cut. The parts are changed in place.
 */
export function normalize<P extends { start: number; end: number; transition: Transition }>(parts: P[]) {
  parts.forEach((part, index) => {
    const next = parts[index + 1];
    if (!next) return void (part.transition = { ...part.transition, kind: "cut" });
    if (part.transition.kind === "cut") return;
    const cap = capOf(part, next);
    if (cap < MIN_DURATION) part.transition = { ...part.transition, kind: "cut" };
    else if (part.transition.duration > cap) part.transition = { ...part.transition, duration: cap };
  });
  return parts;
}

/** A typed duration: 0.1 s steps, at least 0.1 s, at most the junction's limit; null when it is no number. */
export function typedDuration(text: unknown, cap: number): number | null {
  const n = Number(String(text ?? "").trim().replace(",", ".").replace(/\s*s$/i, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return tenth(Math.min(cap, Math.max(MIN_DURATION, n)));
}

/**
 * The xfade name of a transition. The direction is the way the new picture
 * moves (Wipe left: the new picture comes in from the right and its edge
 * moves left), which is FFmpeg's naming; a frame test checks each one.
 */
export function xfadeName(t: Transition): string {
  switch (t.kind) {
    case "crossfade":
      return "fade";
    case "fadeBlack":
      return "fadeblack";
    case "fadeWhite":
      return "fadewhite";
    case "wipe":
      return `wipe${t.dir}`;
    case "slide":
      return `slide${t.dir}`;
    default:
      return "";
  }
}

/** How the sound changes with a kind (sound follows the picture, Q7 a). */
export type Sound = "cut" | "crossfade" | "dip";
export const soundOf = (kind: Kind): Sound => (kind === "cut" ? "cut" : kind === "fadeBlack" || kind === "fadeWhite" ? "dip" : "crossfade");

/** The transitions that apply: none in Fast (the export joins with cuts, Q2 a); otherwise each junction's own. */
export const applied = (transitions: readonly Transition[], fast: boolean) => (fast ? transitions.map(() => CUT) : transitions);
/** Whether any junction is more than a cut. */
export const anyTransition = (transitions: readonly Transition[]) => transitions.slice(0, -1).some((t) => t.kind !== "cut");

/**
 * The timing on whole output frames (§2.3). `lengths[i]` is part i's length
 * in the merged file; `transitions[i]` the one into part i + 1 (the last is
 * ignored). Each length and each transition is rounded to frames (a
 * transition to at least one frame and at most the shorter part's half), so
 * the picture and the sound overlap by the same amount.
 */
export function timing(lengths: readonly number[], transitions: readonly Transition[], fps: number) {
  const frames = lengths.map((length) => Math.max(1, Math.round(length * fps)));
  const overlaps = frames.slice(0, -1).map((f, i) => {
    const t = transitions[i];
    if (!t || t.kind === "cut") return 0;
    const most = Math.floor(Math.min(f, frames[i + 1]!) / 2);
    return Math.max(1, Math.min(most, Math.round(t.duration * fps)));
  });
  // Where each part starts in the merged file, in frames.
  const starts: number[] = [];
  frames.reduce((at, f) => (starts.push(at), at + f), 0);
  // Where each junction's blend starts in the output: the length so far less the overlaps before it and its own.
  const offsets: number[] = [];
  let written = frames[0] ?? 0;
  overlaps.forEach((overlap, i) => {
    offsets.push(written - overlap);
    written += frames[i + 1]! - overlap;
  });
  return { frames, starts, overlaps, offsets, written, fps };
}

const secs = (frames: number, fps: number) => (frames / fps).toFixed(6).replace(/\.?0+$/, "") || "0";

/**
 * The filter graph over the merged file (input 0): each part cut out with
 * `trim`/`atrim`, then joined in order: `xfade` + `acrossfade` (equal power,
 * `qsin`) where a junction has a transition, a dip (out, then in) for the
 * fades through black and white, `concat` for a cut. Only the plugin's own
 * kind names and numbers go into it. `audio`: the merged file has sound.
 */
export function transitionGraph(lengths: readonly number[], transitions: readonly Transition[], fps: number, audio: boolean) {
  const t = timing(lengths, transitions, fps);
  const out: string[] = [];
  t.frames.forEach((f, i) => {
    out.push(`[0:v]trim=start_frame=${t.starts[i]}:end_frame=${t.starts[i]! + f},setpts=PTS-STARTPTS[v${i}]`);
    if (audio) out.push(`[0:a]atrim=start=${secs(t.starts[i]!, fps)}:end=${secs(t.starts[i]! + f, fps)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  let video = "v0";
  let sound = "a0";
  t.overlaps.forEach((overlap, i) => {
    const next = i + 1;
    const vOut = next === t.frames.length - 1 ? "vout" : `vj${next}`;
    const aOut = next === t.frames.length - 1 ? "aout" : `aj${next}`;
    const tr = transitions[i]!;
    if (overlap === 0) {
      out.push(`[${video}][v${next}]concat=n=2:v=1:a=0[${vOut}]`);
      if (audio) out.push(`[${sound}][a${next}]concat=n=2:v=0:a=1[${aOut}]`);
    } else {
      const d = secs(overlap, fps);
      out.push(`[${video}][v${next}]xfade=transition=${xfadeName(tr)}:duration=${d}:offset=${secs(t.offsets[i]!, fps)}[${vOut}]`);
      if (audio && soundOf(tr.kind) === "dip") {
        // Out over the first half of the overlap, in over the second: the sound dips with the picture.
        const half = secs(overlap / 2, fps);
        const lengthSoFar = t.offsets[i]! + overlap;
        out.push(`[${sound}]afade=t=out:st=${secs(lengthSoFar - overlap, fps)}:d=${half}[ad${next}]`);
        out.push(`[a${next}]afade=t=in:st=${half}:d=${half}[ai${next}]`);
        out.push(`[ad${next}][ai${next}]acrossfade=d=${d}:c1=nofade:c2=nofade[${aOut}]`);
      } else if (audio) out.push(`[${sound}][a${next}]acrossfade=d=${d}:c1=qsin:c2=qsin[${aOut}]`);
    }
    video = vOut;
    sound = aOut;
  });
  if (t.frames.length === 1) {
    out.push("[v0]null[vout]");
    if (audio) out.push("[a0]anull[aout]");
  }
  return { graph: out.join(";"), timing: t, length: t.written / fps };
}

/** x264's preset for the tab's speed, as the player's Precise encode uses it. */
export const presetOf = (speed: Encode["speed"]) => (speed === "balanced" ? "medium" : speed === "smaller" ? "slow" : "veryfast");
/** The cores a Precise export may use: half the logical processors, 1–8 (the player's `threads: "auto"`). */
export const autoThreads = () => Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2)));

export interface EncodeArgs {
  input: string;
  output: string;
  progress: string;
  lengths: readonly number[];
  transitions: readonly Transition[];
  fps: number;
  audio: boolean;
  encode: Encode;
  /** "Same as source": the bit rate the merged file has (its video stream), bits per second. */
  bitrate?: number | null;
  threads?: number;
}

/**
 * ffmpeg's arguments for the final file: the graph above, encoded as the
 * player's Precise export encodes (H.264 + AAC in MP4: the CRF or the source
 * bit rate, x264's preset for the speed, yuv420p, 48 kHz stereo at the tab's
 * AAC rate, fast start), with `-progress` into a file the plugin reads.
 */
export function transitionArgs(o: EncodeArgs) {
  const { graph, length } = transitionGraph(o.lengths, o.transitions, o.fps, o.audio);
  const threads = String(o.threads ?? autoThreads());
  const rate = o.encode.rate === "source" && o.bitrate && o.bitrate > 0
    ? ["-b:v", String(Math.round(o.bitrate)), "-maxrate", String(Math.round(o.bitrate * 1.5)), "-bufsize", String(Math.round(o.bitrate * 2))]
    : ["-crf", String(o.encode.rate === "source" ? 18 : o.encode.crf)];
  const sound = o.audio ? ["-map", "[aout]", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", `${o.encode.audio}k`] : ["-an"];
  const args = [
    "-nostdin", "-v", "error", "-y", "-threads", threads,
    "-i", o.input,
    "-filter_complex", graph, "-filter_complex_threads", threads,
    "-map", "[vout]", ...sound,
    "-c:v", "libx264", ...rate, "-preset", presetOf(o.encode.speed), "-pix_fmt", "yuv420p", "-threads", threads,
    "-movflags", "+faststart", "-progress", o.progress, "-stats_period", "0.5",
    "-f", "mp4", o.output,
  ];
  return { args, length };
}

/** The last `out_time_us` of ffmpeg's `-progress` file, in seconds; null before the first block. */
export function progressTime(text: string): number | null {
  const all = [...text.matchAll(/^out_time_us=(\d+)\s*$/gm)];
  const last = all.at(-1);
  return last ? Number(last[1]) / 1e6 : null;
}

/** Which transition the encode is at (from 1): the last one whose blend has begun at output time `at`; 1 before the first. */
export function transitionAt(offsets: readonly number[], overlaps: readonly number[], fps: number, at: number) {
  const blends = offsets.filter((_, i) => overlaps[i]! > 0);
  if (!blends.length) return 0;
  let k = 1;
  blends.forEach((offset, i) => {
    if (at * fps >= offset) k = i + 1;
  });
  return k;
}

/** Time allowed for the final encode: two minutes, plus twenty seconds per second of video (4K on one slow machine). */
export const timeoutFor = (length: number) => Math.round(120_000 + Math.max(0, length) * 20_000);

/** What a merged export with transitions needs after the player's merge (kept with the task for a retry). */
export interface Plan {
  /** Each part's transition into the next (the last is Cut). */
  transitions: Transition[];
  /** Each part's length as asked (the merge's own report wins when it has one). */
  lengths: number[];
  /** The merge's frame rate (the first part's, under the encoding's ceiling) and whether it has sound. */
  fps: number;
  audio: boolean;
  /** The Precise settings of the final file, and those of the merge (the best quality, the same ceilings). */
  encode: Encode;
  merge: Encode;
}

/** The merge's encoding: the same size and frame-rate ceilings, the best quality the player offers, so the final encode is the only loss that shows. */
export const mergeEncode = (encode: Encode): Encode => (encode.rate === "source" ? { ...encode, audio: 256 } : { ...encode, rate: "crf", crf: 14, speed: "faster", audio: 256 });

/** The parts' lengths in the merged file: as the player wrote them (`facts.join.parts`) when it says, else as asked. */
export function mergedLengths(state: { facts?: { join?: { parts?: { start: number; end: number }[] } } | null }, asked: readonly number[]) {
  const written = state.facts?.join?.parts;
  if (Array.isArray(written) && written.length === asked.length && written.every((p) => Number.isFinite(p.end - p.start) && p.end > p.start))
    return written.map((p) => p.end - p.start);
  return [...asked];
}

/** The progress bar's ticks at the junctions as the output has them (the middle of each blend, the overlaps taken off): a 1000×10 path. */
export function junctionTicks(plan: Pick<Plan, "lengths" | "transitions" | "fps">) {
  const t = timing(plan.lengths, plan.transitions, plan.fps);
  if (t.frames.length < 2 || !(t.written > 0)) return "";
  return t.offsets.map((offset, i) => `M ${Math.round(((offset + t.overlaps[i]! / 2) / t.written) * 1000)} 0 V 10`).join(" ");
}
