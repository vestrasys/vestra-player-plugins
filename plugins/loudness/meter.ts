/**
 * The measurement side of the meter, without the player: the mpv filter that
 * measures, how its metadata reads, and how the readings look on screen.
 *
 * FFmpeg's `ebur128` filter (EBU R128 / ITU-R BS.1770) with `metadata=1`
 * passes the sound through unchanged and tags every 100 ms of it with the
 * current values; `peak=true` adds the true peak (4× oversampled), per
 * channel and overall. mpv shows a labelled audio filter's tags as the
 * property `af-metadata/<label>`: a map of strings such as
 * `{ "lavfi.r128.M": "-18.234", "lavfi.r128.true_peak": "0.700", … }`.
 * Loudness is in LUFS (LU for the range); the peaks are linear amplitudes
 * (1 = full scale), the highest since the filter started (checked with
 * FFmpeg 9.0's ebur128).
 */

/** The label of the plugin's filter in mpv's audio chain (`@loudness`). */
export const LABEL = "loudness";

/** The filter as mpv's `af add` takes it (appended to mpv's chain; in player 0.9.0 it measures before the built-in Normalize). */
export const FILTER = `@${LABEL}:lavfi=[ebur128=metadata=1:peak=true]`;

/** The mpv property that carries the filter's tags. */
export const METADATA = `af-metadata/${LABEL}`;

/**
 * Loudness at or below this is silence: `ebur128` reports −70 LUFS (its
 * absolute gate) for an integrated value it has not measured yet, and
 * −120.7 LUFS for digital silence.
 */
export const SILENCE = -70;

/**
 * The bars' scale: EBU Tech 3341's "EBU +18" scale, −59 to −5 LUFS
 * (−23 LUFS, the R128 target, at 0 LU in the middle of its upper half).
 */
export const SCALE = { low: -59, high: -5 } as const;

/** EBU R128's highest permitted true peak: above it the peak value turns red. */
export const PEAK_LIMIT = -1;

/** What the meter shows; `null` = not measured yet. */
export interface Readings {
  /** Momentary loudness (400 ms window), LUFS. */
  momentary: number | null;
  /** Short-term loudness (3 s window), LUFS. */
  shortTerm: number | null;
  /** Integrated loudness of what has played since the filter started, LUFS (gated). */
  integrated: number | null;
  /** Loudness range (LRA), LU. */
  range: number | null;
  /** The highest true peak since the filter started, dBTP. */
  truePeak: number | null;
  /** At least one set of values arrived. */
  seen: boolean;
}

export const EMPTY: Readings = {
  momentary: null,
  shortTerm: null,
  integrated: null,
  range: null,
  truePeak: null,
  seen: false,
};

const number = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const loudness = (value: unknown): number | null => {
  const n = number(value);
  return n === null || n <= SILENCE ? null : n;
};

/** A linear peak amplitude in dBTP; `null` for silence. */
const decibels = (linear: number | null): number | null =>
  linear === null || linear <= 0 ? null : 20 * Math.log10(linear);

/**
 * The readings after one value of `af-metadata/loudness`: all of them from
 * that value, so they always cover the same span. `ebur128` keeps the
 * integrated loudness, the range and the true peak from its own start, and
 * mpv starts a new instance when it rebuilds the audio chain (a seek, another
 * file, Restart): the three then start over together, as an EBU Tech 3341
 * meter's reset clears them together. Holding the peak across a rebuild
 * would show a peak from audio the integrated value no longer covers.
 * A value without the filter's tags (`null` while mpv rebuilds the chain, a
 * map of another kind) keeps the previous readings. The true peak is the
 * highest channel's.
 */
export function readMetadata(value: unknown, previous: Readings): Readings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return previous;
  const tags = value as Record<string, unknown>;
  if (!("lavfi.r128.M" in tags)) return previous;
  let peak: number | null = null;
  for (const [key, raw] of Object.entries(tags)) {
    if (!key.startsWith("lavfi.r128.true_peak")) continue;
    const n = decibels(number(raw));
    if (n !== null && (peak === null || n > peak)) peak = n;
  }
  return {
    momentary: loudness(tags["lavfi.r128.M"]),
    shortTerm: loudness(tags["lavfi.r128.S"]),
    integrated: loudness(tags["lavfi.r128.I"]),
    range: number(tags["lavfi.r128.LRA"]),
    truePeak: peak,
    seen: true,
  };
}

/** A value with one decimal and a real minus sign; "—" when not measured. */
export const format = (value: number | null): string =>
  value === null ? "—" : (Math.round(value * 10) / 10).toFixed(1).replace(/^-(?=.*[1-9])/, "−").replace(/^-/, "");

/** Where a loudness sits on the bars' scale, 0 to 1. */
export const level = (value: number | null): number =>
  value === null ? 0 : Math.round(Math.min(1, Math.max(0, (value - SCALE.low) / (SCALE.high - SCALE.low))) * 200) / 200;

/**
 * The window's values for the readings. Rounded as shown (0.1 LU, half a
 * percent of a bar), so a change the eye cannot see sends nothing.
 */
export const display = (r: Readings) => ({
  momentary: format(r.momentary),
  momentaryLevel: level(r.momentary),
  shortTerm: format(r.shortTerm),
  shortTermLevel: level(r.shortTerm),
  integrated: format(r.integrated),
  range: format(r.range),
  truePeak: format(r.truePeak),
  peakOver: r.truePeak !== null && r.truePeak > PEAK_LIMIT,
});
