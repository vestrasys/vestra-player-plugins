/**
 * Silence Skipper's pure parts: ffmpeg's arguments for one window of the
 * file, the parsing of its `silencedetect` output, merging the windows'
 * results, and the stretches that are actually skipped.
 */

/** A stretch of the file, in seconds from its start. */
export interface Span {
  start: number;
  end: number;
}

/** Seconds of media per ffmpeg run: the scan starts at the playhead and moves on window by window. */
export const WINDOW = 120;
/** The shortest silence ffmpeg reports; the user's minimum length filters further without a new scan. */
export const DETECT_MIN = 0.5;
/** Silence kept at each edge of a skipped stretch, so a cut does not clip the first or last syllable. */
export const PAD = 0.15;
/** A stretch whose skippable part is shorter than this is not worth a seek. */
export const MIN_JUMP = 0.3;
/** Silences that end this close to the end of the media are not skipped: the end stays visible. */
export const END_GUARD = 0.5;
/** Two silences closer than this (the seam between two windows) are one. */
const JOIN = 0.05;

/** The user's settings ranges. */
export const THRESHOLD = { min: -60, max: -20, default: -35 } as const;
export const MIN_LENGTH = { min: 0.5, max: 5, default: 1 } as const;

/**
 * ffmpeg's arguments for one window: `silencedetect` on one audio stream,
 * its metadata printed on standard output by `ametadata` (stderr keeps only
 * errors, and `tools.run` keeps only its last 64 KiB). The picture,
 * subtitles and data are not decoded.
 */
export function silenceArgs(path: string, from: number, length: number, stream: number, thresholdDb: number) {
  return [
    "-hide_banner",
    "-nostats",
    "-nostdin",
    "-loglevel",
    "error",
    "-threads",
    "1",
    "-ss",
    from.toFixed(3),
    "-t",
    length.toFixed(3),
    "-i",
    path,
    "-map",
    `0:a:${stream}?`,
    "-vn",
    "-sn",
    "-dn",
    "-af",
    `silencedetect=noise=${thresholdDb}dB:duration=${DETECT_MIN},ametadata=mode=print:file=-`,
    "-f",
    "null",
    "-",
  ];
}

/**
 * The silences of one window from `ametadata`'s lines
 * (`lavfi.silence_start=T`, `lavfi.silence_end=T`), shifted by `from` (the
 * run's timestamps start at 0). A silence still open at the end of the
 * window lasts to `to`; the next window's silence that starts at its
 * beginning joins it in {@link mergeSpans}.
 */
export function parseSilences(text: string, from: number, to: number): Span[] {
  const out: Span[] = [];
  let open: number | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const start = /^lavfi\.silence_start=(-?[\d.]+(?:e[-+]?\d+)?)$/.exec(line);
    if (start) {
      open = Math.max(from, from + Number(start[1]));
      continue;
    }
    const end = /^lavfi\.silence_end=(-?[\d.]+(?:e[-+]?\d+)?)$/.exec(line);
    if (end && open !== null) {
      const stop = Math.min(to, from + Number(end[1]));
      if (Number.isFinite(open) && Number.isFinite(stop) && stop > open) out.push({ start: open, end: stop });
      open = null;
    }
  }
  if (open !== null && Number.isFinite(open) && to > open) out.push({ start: open, end: to });
  return out;
}

/** Sorted, with touching or overlapping silences joined. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start <= last.end + JOIN) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/**
 * The stretches that are skipped: silences at least `minLength` long, less
 * {@link PAD} at each edge, without one that runs into the end of the media.
 */
export function skippable(silences: Span[], minLength: number, duration: number | null): Span[] {
  const out: Span[] = [];
  for (const s of silences) {
    if (s.end - s.start < minLength) continue;
    if (duration !== null && s.end >= duration - END_GUARD) continue;
    const start = s.start + PAD;
    const end = s.end - PAD;
    if (end - start >= MIN_JUMP) out.push({ start, end });
  }
  return out;
}

/** At most `limit` stretches for the seek bar: the longest, in time order. */
export function longest(spans: Span[], limit: number): Span[] {
  if (spans.length <= limit) return spans;
  return [...spans]
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, limit)
    .sort((a, b) => a.start - b.start);
}

/** The stretch to skip at `position`: inside it, with enough left to be worth the seek. */
export function stretchAt(spans: Span[], position: number): Span | null {
  for (const s of spans) {
    if (s.start > position) return null;
    if (position >= s.start && position < s.end - MIN_JUMP / 2) return s;
  }
  return null;
}

/** How many windows cover `duration` seconds. */
export const windowCount = (duration: number) => Math.max(1, Math.ceil(duration / WINDOW));

/** The next window to scan: the first not done at or after the playhead's, else the first not done. */
export function nextWindow(done: ReadonlySet<number>, count: number, position: number): number | null {
  const here = Math.min(count - 1, Math.max(0, Math.floor(position / WINDOW)));
  for (let i = here; i < count; i++) if (!done.has(i)) return i;
  for (let i = 0; i < here; i++) if (!done.has(i)) return i;
  return null;
}

/**
 * The ffmpeg audio stream (`0:a:N`) of the selected track: the player's
 * track ids count the file's audio streams in order, external tracks after
 * them. 0 when nothing is selected or the selection is an external file.
 */
export function audioStream(tracks: readonly { id: number; selected: boolean; external: boolean }[] | null): number {
  if (!tracks) return 0;
  const inside = tracks.filter((t) => !t.external).sort((a, b) => a.id - b.id);
  const index = inside.findIndex((t) => t.selected);
  return index < 0 ? 0 : index;
}

/** `m:ss`, or `h:mm:ss` from an hour. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
