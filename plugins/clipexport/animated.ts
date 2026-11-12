import type { Scope } from "@vestra-player/sdk";
import type { Animated } from "./clip.ts";
import { Failure } from "./model.ts";
import { autoThreads, transitionGraph } from "./transitions.ts";
import type { Layout, Transition } from "./transitions.ts";

/**
 * Animated GIF and WebP (0.5.0, Precise only). The player writes the clip or
 * the merged Collection as an MP4 into the plugin's work folder (the GIF and
 * WebP presets' intermediate encoding, clip.ts), with the video effects and
 * burned-in subtitles when asked; the plugin then runs the player's ffmpeg
 * over that file (GIF: twice, the palette first), as it does for the
 * transitions (finish.ts), and writes
 * the image beside the destination under a hidden name first.
 *
 * The defaults follow the common practice of GIF makers (Giphy's and ezgif's
 * guidance, the mpv GIF scripts): small and short. GIF: at most 480 px on the
 * longer side, 15 fps, one 256-colour palette for the whole clip made from
 * the clip itself (`palettegen`), applied with ordered (Bayer) dithering and
 * only the changed rectangle per frame (`paletteuse`), FFmpeg's documented
 * high-quality GIF recipe; error-diffusion dithering made the files nearly
 * twice as large in the 0.5.0 measurements, as it changes pixels between
 * frames. WebP: libwebp's animated encoder at its default quality (75) and
 * effort (4), at most 640 px and 20 fps (WebP is about a third of a GIF's
 * size). Both loop forever and have no sound.
 */

/** The size box (longer side, never enlarged) and frame rate of each format. */
export const ANIMATED: Readonly<Record<Animated, { box: number; fps: number }>> = {
  gif: { box: 480, fps: 15 },
  webp: { box: 640, fps: 20 },
};
/** libwebp's default quality and effort (cwebp's `-q 75 -m 4`). */
export const WEBP_QUALITY = 75;
export const WEBP_EFFORT = 4;
/**
 * The longest animated image, in seconds of output. GIF makers keep clips
 * short (Giphy recommends at most 15 s; ezgif converts at most 60 s of
 * video): a minute at 480 px is already tens of megabytes as a GIF. A longer
 * range is refused before anything starts, with the reason on the Clip page.
 */
export const MAX_ANIMATED_SECONDS = 60;

/** The scale step: the longer side at most `box` (never enlarged), the other by the aspect ratio (even), square pixels. */
export const scaleFilter = (box: number) =>
  `scale='if(gte(iw,ih),min(${box},iw),-2)':'if(gte(iw,ih),-2,min(${box},ih))':flags=lanczos,setsar=1`;

/** The picture step from the video `from` to the label `to` (graph syntax, labels without brackets): the frame rate, then the size. */
export function animatedChain(format: Animated, from: string, to: string) {
  const { box, fps } = ANIMATED[format];
  return `[${from}]fps=${fps},${scaleFilter(box)}[${to}]`;
}
/** One 256-colour palette for the whole clip, from the clip itself (FFmpeg's default statistics over every frame). */
export const PALETTEGEN = "palettegen=max_colors=256";
/** Ordered (Bayer) dithering, only the changed rectangle of each frame. */
export const PALETTEUSE = "paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";

export interface AnimatedArgs {
  input: string;
  output: string;
  progress: string;
  /** The graph's file (`-/filter_complex`); the caller writes each pass's `graph` to its `script`. */
  script: string;
  format: Animated;
  /**
   * GIF: the palette image the first pass writes (in the work folder); its
   * graph and progress files are beside it (`<palette>.graph`,
   * `<palette>.progress`).
   */
  palette?: string;
  /** The WebP encoder found (`libwebp_anim`, else `libwebp`); unused for GIF. */
  encoder?: string;
  /** A merged export with transitions: the parts in the merge and each junction's transition (the picture only). */
  transitions?: { lengths: readonly number[] | Layout; transitions: readonly Transition[]; fps: number } | null;
  /** Seconds of output without transitions (the progress and the time allowed). */
  length: number;
  threads?: number;
}

/** One ffmpeg run: its arguments, the graph to write to `script` first, and its progress file. */
export interface AnimatedPass {
  args: string[];
  graph: string;
  script: string;
  progress: string;
}

/**
 * ffmpeg's runs for the animated image, in order, each with its graph (the
 * transitions first, if any): loop forever, no sound, `-progress` into a
 * file. WebP is one run. GIF is two, as FFmpeg's GIF recipe does it: the
 * palette of the whole clip into a PNG, then the image with it. One graph
 * with `split` would keep every frame in memory until the palette is known
 * at the end (about 800 MB for a minute at 960×720 in the review's
 * measurement); two runs read the merge twice and hold one frame.
 */
export function animatedArgs(o: AnimatedArgs): { passes: AnimatedPass[]; length: number } {
  const threads = String(o.threads ?? autoThreads());
  let prefix = "";
  let from = "0:v";
  let length = o.length;
  if (o.transitions) {
    const joined = transitionGraph(o.transitions.lengths, o.transitions.transitions, o.transitions.fps, false);
    prefix = `${joined.graph};`;
    from = "vout";
    length = joined.length;
  }
  const head = ["-nostdin", "-v", "error", "-y", "-threads", threads, "-i", o.input];
  const graphFlags = (script: string) => ["-/filter_complex", script, "-filter_complex_threads", threads];
  const tail = (progress: string, output: string) => ["-progress", progress, "-stats_period", "0.5", output];
  if (o.format === "webp") {
    const graph = `${prefix}${animatedChain("webp", from, "out")}`;
    const codec = ["-c:v", o.encoder ?? "libwebp_anim", "-lossless", "0", "-q:v", String(WEBP_QUALITY), "-compression_level", String(WEBP_EFFORT), "-loop", "0", "-f", "webp"];
    return { passes: [{ args: [...head, ...graphFlags(o.script), "-map", "[out]", "-an", "-sn", "-dn", ...codec, ...tail(o.progress, o.output)], graph, script: o.script, progress: o.progress }], length };
  }
  const palette = o.palette ?? `${o.output}.palette.png`;
  const first: AnimatedPass = {
    graph: `${prefix}${animatedChain("gif", from, "gifv")};[gifv]${PALETTEGEN}[out]`,
    script: `${palette}.graph`,
    progress: `${palette}.progress`,
    args: [],
  };
  first.args = [...head, ...graphFlags(first.script), "-map", "[out]", "-an", "-sn", "-dn", "-frames:v", "1", "-update", "1", "-f", "image2", ...tail(first.progress, palette)];
  const second: AnimatedPass = {
    graph: `${prefix}${animatedChain("gif", from, "gifv")};[gifv][1:v]${PALETTEUSE}[out]`,
    script: o.script,
    progress: o.progress,
    args: [...head, "-i", palette, ...graphFlags(o.script), "-map", "[out]", "-an", "-sn", "-dn", "-c:v", "gif", "-loop", "0", "-f", "gif", ...tail(o.progress, o.output)],
  };
  return { passes: [first, second], length };
}

/** The encoder names in `ffmpeg -encoders` (lines such as ` V....D gif   GIF (…)` after the legend). */
export function encodersOf(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    // A name (the legend's ` V..... = Video` has none).
    const match = /^\s*[VAS][F.][S.][X.][B.][D.]\s+([A-Za-z0-9_][\w.-]*)\s/.exec(line);
    if (match) names.add(match[1]!);
  }
  return names;
}

/** The encoder a format needs from those found: GIF's own, libwebp's animated encoder (the still one can animate too); `null` when none. */
export function encoderFor(format: Animated, encoders: ReadonlySet<string>): string | null {
  if (format === "gif") return encoders.has("gif") ? "gif" : null;
  return encoders.has("libwebp_anim") ? "libwebp_anim" : encoders.has("libwebp") ? "libwebp" : null;
}

/**
 * Which encoders the player's ffmpeg has, asked once (a failed question is
 * asked again next time). `find(format)` gives the encoder to use, or fails
 * with the plugin's reason: no ffmpeg at all, or none for this format (an
 * FFmpeg built without libwebp, say).
 */
export function encoderProbe(plugin: Scope) {
  let known: Set<string> | null = null;
  return async function find(format: Animated): Promise<string> {
    if (!known) {
      if (!(await plugin.tools.available("ffmpeg").catch(() => false))) throw new Failure("noAnimatedFfmpeg");
      try {
        const { stdout } = await plugin.tools.run("ffmpeg", ["-hide_banner", "-v", "error", "-encoders"], { timeoutMs: 15_000, maxOutput: 1 << 20 });
        known = encodersOf(new TextDecoder().decode(stdout));
      } catch (error) {
        console.error(`[clipexport] ffmpeg -encoders: ${(error as Error).message}`);
        throw new Failure((error as { code?: string }).code === "unavailable" ? "noAnimatedFfmpeg" : "animatedFailed");
      }
    }
    const encoder = encoderFor(format, known);
    if (!encoder) throw new Failure("noAnimatedEncoder");
    return encoder;
  };
}

/** The extension of what a Precise cut writes. */
export const extensionOf = (format: Animated | null) => (format ? `.${format}` : ".mp4");
