/**
 * Highlights, step 3 (design clipexport-highlights §9): the sound model.
 * CED-mini (an audio tagger trained on AudioSet, Apache-2.0, by mispeech;
 * the ONNX int8 conversion of k2-fsa's sherpa-onnx) gives, for each 10 s of
 * the sound, how likely it holds laughter, applause, cheering and a crowd.
 * Pure functions here: ffmpeg's arguments for the sound as samples, the
 * model's input (a Kaldi-style log-mel filterbank, as sherpa-onnx computes
 * it), the classes kept from its 527, and what stands out in a video.
 */

/** The model's sample rate (Hz). */
export const SAMPLE_RATE = 16000;
/** Seconds of sound per tag (the model was trained on 10 s clips). */
export const TAG_SECONDS = 10;
/** A last piece shorter than this is not tagged. */
const MIN_TAG_SECONDS = 1;

/** The sounds the page names, in the order a tie is broken. */
export const SOUNDS = ["laughter", "applause", "cheering", "crowd"] as const;
export type Sound = (typeof SOUNDS)[number];

/**
 * The model's classes for each sound (AudioSet's indices in its
 * class_labels_indices.csv): Laughter 16, Snicker 19, Belly laugh 20,
 * Chuckle 21, Giggle 18; Applause 67, Clapping 63; Cheering 66; Crowd 69.
 * Only these numbers are kept, not the label file.
 */
export const CLASSES: Record<Sound, readonly number[]> = {
  laughter: [16, 18, 19, 20, 21],
  applause: [67, 63],
  cheering: [66],
  crowd: [69],
};
/** The model's number of classes (AudioSet). */
export const CLASS_COUNT = 527;

/** One tagged piece of the sound: where it starts (s) and each sound's probability (the most likely of its classes). */
export type Tag = { t: number } & Record<Sound, number>;

/** The probabilities of one piece, from the model's 527. */
export function soundsOf(prob: ArrayLike<number>, t: number): Tag {
  const tag = { t } as Tag;
  for (const sound of SOUNDS) {
    let top = 0;
    for (const index of CLASSES[sound]) top = Math.max(top, Number(prob[index]) || 0);
    tag[sound] = Math.round(top * 1000) / 1000;
  }
  return tag;
}

/**
 * ffmpeg's arguments for one window of the sound as the model reads it: one
 * audio stream, mono, 16 kHz, 16-bit samples on standard output (10 MB per
 * 300 s). The picture, subtitles and data are not decoded; one thread.
 */
export function samplesArgs(source: string, from: number, length: number, stream: number) {
  return [
    "-hide_banner", "-nostats", "-nostdin", "-loglevel", "error", "-threads", "1",
    "-ss", from.toFixed(3), "-t", length.toFixed(3), "-i", source,
    "-map", `0:a:${stream}`, "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-",
  ];
}

/** 16-bit little-endian samples as floats in −1…1. */
export function samplesOf(bytes: Uint8Array) {
  const count = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** The pieces a window's samples are tagged in: 10 s each from its start; a last one of at least 1 s. */
export function pieces(count: number) {
  const size = SAMPLE_RATE * TAG_SECONDS;
  const out: { offset: number; length: number }[] = [];
  for (let offset = 0; offset < count; offset += size) {
    const length = Math.min(size, count - offset);
    if (length >= SAMPLE_RATE * MIN_TAG_SECONDS) out.push({ offset, length });
  }
  return out;
}

// ---------------------------------------------------------------- the model's input

/** The filterbank CED was exported with (sherpa-onnx): 32 ms Hann frames every 10 ms, 64 mel bands up to 8 kHz, in dB. */
const FRAME = 512;
const SHIFT = 160;
export const BANDS = 64;

const mel = (f: number) => 1127 * Math.log(1 + f / 700);
let tables: { banks: { first: number; last: number; w: Float32Array }[]; window: Float64Array; rev: Uint32Array; cos: Float64Array; sin: Float64Array } | null = null;
function prepare() {
  if (tables) return tables;
  const half = FRAME / 2;
  const binWidth = SAMPLE_RATE / FRAME;
  const low = mel(0);
  const high = mel(SAMPLE_RATE / 2);
  const step = (high - low) / (BANDS + 1);
  const banks = [];
  for (let b = 0; b < BANDS; b++) {
    const l = low + b * step;
    const c = l + step;
    const r = c + step;
    const w = new Float32Array(half);
    let first = -1;
    let last = -1;
    for (let i = 0; i < half; i++) {
      const m = mel(binWidth * i);
      if (m > l && m < r) {
        w[i] = m <= c ? (m - l) / (c - l) : (r - m) / (r - c);
        if (first < 0) first = i;
        last = i;
      }
    }
    banks.push({ first, last, w });
  }
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const bits = Math.log2(FRAME);
  const rev = new Uint32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    let r = 0;
    for (let k = 0; k < bits; k++) r |= ((i >> k) & 1) << (bits - 1 - k);
    rev[i] = r;
  }
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / FRAME);
    sin[i] = Math.sin((-2 * Math.PI * i) / FRAME);
  }
  return (tables = { banks, window, rev, cos, sin });
}

/** In-place radix-2 FFT of one frame. */
function fft(re: Float64Array, im: Float64Array) {
  const { rev, cos, sin } = prepare();
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = rev[i]!;
    if (j > i) {
      let t = re[i]!;
      re[i] = re[j]!;
      re[j] = t;
      t = im[i]!;
      im[i] = im[j]!;
      im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const a = i + j;
        const b = a + half;
        const tr = re[b]! * cos[k]! - im[b]! * sin[k]!;
        const ti = re[b]! * sin[k]! + im[b]! * cos[k]!;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

/**
 * The model's input for one piece: 64 mel bands × frames (band-major, as
 * its `feats` input [1, 64, frames] wants), one frame per 10 ms centred on
 * it (the edges mirrored), each band's power in dB.
 */
export function features(x: Float32Array) {
  const { banks, window } = prepare();
  const n = x.length;
  const frames = Math.floor((n + SHIFT / 2) / SHIFT);
  const out = new Float32Array(BANDS * frames);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const start = f * SHIFT + Math.floor(SHIFT / 2) - Math.floor(FRAME / 2);
    for (let i = 0; i < FRAME; i++) {
      let s = start + i;
      if (s < 0) s = -s - 1;
      else if (s >= n) s = 2 * n - 1 - s;
      re[i] = (x[Math.max(0, Math.min(n - 1, s))] ?? 0) * window[i]!;
    }
    im.fill(0);
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      const { first, last, w } = banks[b]!;
      let e = 0;
      for (let i = first; i <= last; i++) e += w[i]! * (re[i]! * re[i]! + im[i]! * im[i]!);
      out[b * frames + f] = 10 * Math.log10(Math.max(e, 1e-10));
    }
  }
  return { data: out, frames };
}

// ---------------------------------------------------------------- what stands out

/** A sound counts in a piece when its probability is at least this… */
const FLOOR = 0.2;
/** …and it rose this far above its usual level in the video, as a share of the room above it (0–1). */
export const RISE = 0.15;
/** Strength: strong from this rise, medium from `MEDIUM`, else weak. */
const STRONG = 0.45;
const MEDIUM = 0.25;

/** A sound's usual level in a video: the median of its probabilities. */
export function baselines(tags: readonly Tag[]): Record<Sound, number> {
  const out = {} as Record<Sound, number>;
  for (const sound of SOUNDS) {
    const values = tags.map((tag) => tag[sound]).sort((a, b) => a - b);
    out[sound] = values.length ? values[values.length >> 1]! : 0;
  }
  return out;
}

/**
 * How far each sound of a piece rose above its usual level (0–1, two
 * decimals): a sound that does not count there is left out. Stand-up has
 * laughter most of the time, so a laugh counts when it is louder than the
 * usual; a film without any counts none.
 */
export function risesOf(tag: Tag, base: Record<Sound, number>) {
  const rises: Partial<Record<Sound, number>> = {};
  for (const sound of SOUNDS) {
    const p = tag[sound];
    const rise = (p - base[sound]) / Math.max(0.05, 1 - base[sound]);
    if (p >= FLOOR && rise >= RISE) rises[sound] = Math.round(Math.min(1, rise) * 100) / 100;
  }
  return rises;
}

/** 1 weak, 2 medium, 3 strong: a sound's rise. */
export const strengthOf = (rise: number) => (rise >= STRONG ? 3 : rise >= MEDIUM ? 2 : 1);
/** 1–3 for a loud moment alone: how many LU it is above the video's average. */
export const loudStrength = (lu: number) => (lu >= 12 ? 3 : lu >= 8 ? 2 : 1);

/** A suggestion's sounds, strongest first (ties in `SOUNDS` order). */
export function ranked(sounds: Partial<Record<Sound, number>> | undefined) {
  return SOUNDS.filter((sound) => (sounds?.[sound] ?? 0) > 0).sort((a, b) => sounds![b]! - sounds![a]! || SOUNDS.indexOf(a) - SOUNDS.indexOf(b));
}

/**
 * The order of the suggestions: the sounds first (their strongest rise),
 * then how loud (up to 20 LU above the average, worth at most 0.3). A
 * loudness-only scan orders by loudness alone, as before.
 */
export const rankOf = (candidate: { peak: number; sounds?: Partial<Record<Sound, number>> }) => {
  const sound = Math.max(0, ...Object.values(candidate.sounds ?? {}));
  return sound + Math.max(0, Math.min(1, candidate.peak / 20)) * 0.3;
};
