/**
 * The content box of a video whose picture sits in a solid-colour frame, and
 * the player's `reframe` crop nodes that cut it out exactly. Pure functions,
 * no player calls: `main.ts` feeds them decoded frames.
 */
import type { VideoNode } from "@vestra-player/sdk";

/** A decoded frame: `width × height` pixels, 3 bytes each (ffmpeg `rgb24`). */
export interface Frame {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A rectangle in pixels; `x`, `y` is its top-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Colour = readonly [number, number, number];

/** A pixel differs from the border colour when one channel differs by more than this. */
export const TOLERANCE = 16;
/** An edge is border when at least this share of its pixels has the border colour. */
export const EDGE_SHARE = 0.95;
/** No crop when the content covers at least this share of the frame in both directions. */
export const FULL_SHARE = 0.95;
/** The content must cover at least this share of the frame's area. */
export const MIN_AREA = 0.1;
/** The content must be at least this many pixels on each side. */
export const MIN_SIDE = 160;
/** The display aspect the player's `reframe` node accepts. */
export const MIN_ASPECT = 0.25;
export const MAX_ASPECT = 4;
/** At least this many frames must show content (not only the border colour). */
export const MIN_FRAMES = 3;
/** A detected size within this share of a standard size becomes that size. */
export const SNAP_SHARE = 0.01;

/** Common picture sizes a content box is snapped to (portrait ones are added below). */
const LANDSCAPE: readonly (readonly [number, number])[] = [
  [7680, 4320],
  [5120, 2880],
  [4096, 2160],
  [3840, 2160],
  [3840, 1600],
  [3440, 1440],
  [2560, 1600],
  [2560, 1440],
  [2560, 1080],
  [2048, 1080],
  [1920, 1200],
  [1920, 1080],
  [1920, 800],
  [1680, 1050],
  [1600, 900],
  [1440, 1080],
  [1440, 900],
  [1366, 768],
  [1280, 1024],
  [1280, 800],
  [1280, 720],
  [1024, 768],
  [1024, 576],
  [960, 720],
  [960, 540],
  [854, 480],
  [800, 600],
  [720, 576],
  [720, 480],
  [640, 480],
  [640, 360],
];
export const STANDARD_SIZES: readonly (readonly [number, number])[] = [
  ...LANDSCAPE,
  ...LANDSCAPE.filter(([w, h]) => w !== h).map(([w, h]) => [h, w] as const),
];

const at = (frame: Frame, x: number, y: number) => (y * frame.width + x) * 3;

/** One channel differs by more than `tolerance`. */
function differs(data: Uint8Array, offset: number, colour: Colour, tolerance: number) {
  return (
    Math.abs(data[offset]! - colour[0]) > tolerance ||
    Math.abs(data[offset + 1]! - colour[1]) > tolerance ||
    Math.abs(data[offset + 2]! - colour[2]) > tolerance
  );
}

/** The offsets of the outer 1-pixel ring, each pixel once, edge by edge. */
function edges(frame: Frame): number[][] {
  const { width: w, height: h } = frame;
  const top: number[] = [];
  const bottom: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  for (let x = 0; x < w; x++) {
    top.push(at(frame, x, 0));
    bottom.push(at(frame, x, h - 1));
  }
  for (let y = 0; y < h; y++) {
    left.push(at(frame, 0, y));
    right.push(at(frame, w - 1, y));
  }
  return [top, bottom, left, right];
}

/**
 * The colour of the solid frame around the picture: the most common colour
 * of the outer 1-pixel ring (in 4-level buckets per channel, so the noise of
 * a compressed solid colour stays in one, then averaged over the pixels near
 * it). It is a border only when at least one whole edge has that colour
 * ({@link EDGE_SHARE}); `null` otherwise.
 */
export function borderColour(frame: Frame, tolerance = TOLERANCE): Colour | null {
  if (frame.width < 2 || frame.height < 2) return null;
  const sides = edges(frame);
  const ring = new Set(sides.flat());
  const counts = new Map<number, number>();
  const { data } = frame;
  for (const offset of ring) {
    const key = ((data[offset]! >> 2) << 12) | ((data[offset + 1]! >> 2) << 6) | (data[offset + 2]! >> 2);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = -1;
  let most = 0;
  for (const [key, count] of counts) {
    if (count > most) [best, most] = [key, count];
  }
  const centre: Colour = [((best >> 12) << 2) + 2, (((best >> 6) & 63) << 2) + 2, ((best & 63) << 2) + 2];
  const sum = [0, 0, 0];
  let n = 0;
  for (const offset of ring) {
    if (differs(data, offset, centre, tolerance)) continue;
    sum[0] += data[offset]!;
    sum[1] += data[offset + 1]!;
    sum[2] += data[offset + 2]!;
    n++;
  }
  const colour: Colour = [Math.round(sum[0]! / n), Math.round(sum[1]! / n), Math.round(sum[2]! / n)];
  const solid = sides.some((side) => {
    let same = 0;
    for (const offset of side) if (!differs(data, offset, colour, tolerance)) same++;
    return same >= EDGE_SHARE * side.length;
  });
  return solid ? colour : null;
}

/** What one frame shows. */
export type FrameResult =
  /** The content sits in a solid border of `colour`; `box` holds every content pixel. */
  | { kind: "border"; colour: Colour; box: Rect }
  /** Only the border colour (a fade, a black frame): says nothing about the content. */
  | { kind: "blank"; colour: Colour }
  /** No solid edge: the content fills the frame. */
  | { kind: "full" };

/**
 * Where the content is in one frame. A row or column is content when more
 * than a few of its pixels (0.2 %, at least 2) differ from the border colour
 * by more than `tolerance` in some channel; the box runs from the first to
 * the last such row and column.
 */
export function analyseFrame(frame: Frame, tolerance = TOLERANCE): FrameResult {
  const colour = borderColour(frame, tolerance);
  if (!colour) return { kind: "full" };
  const { width: w, height: h, data } = frame;
  const rows = new Uint32Array(h);
  const columns = new Uint32Array(w);
  for (let y = 0, offset = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < w; x++, offset += 3) {
      if (
        Math.abs(data[offset]! - colour[0]) > tolerance ||
        Math.abs(data[offset + 1]! - colour[1]) > tolerance ||
        Math.abs(data[offset + 2]! - colour[2]) > tolerance
      ) {
        count++;
        columns[x]!++;
      }
    }
    rows[y] = count;
  }
  const rowMin = Math.max(2, Math.ceil(w * 0.002));
  const columnMin = Math.max(2, Math.ceil(h * 0.002));
  const first = (counts: Uint32Array, min: number) => counts.findIndex((c) => c >= min);
  const last = (counts: Uint32Array, min: number) => counts.findLastIndex((c) => c >= min);
  const top = first(rows, rowMin);
  const left = first(columns, columnMin);
  if (top < 0 || left < 0) return { kind: "blank", colour };
  const bottom = last(rows, rowMin);
  const right = last(columns, columnMin);
  return { kind: "border", colour, box: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } };
}

/** Why there is nothing to crop. */
export type NoCrop =
  /** Fewer than {@link MIN_FRAMES} frames showed content (dark, fading or too short). */
  | "few-frames"
  /** No solid border, or the content fills (almost) the whole frame. */
  | "no-border"
  /** The content is smaller than {@link MIN_AREA} of the frame or {@link MIN_SIDE} pixels. */
  | "small"
  /** The content's display aspect is outside {@link MIN_ASPECT}–{@link MAX_ASPECT}. */
  | "aspect";

export type Decision = { rect: Rect } | { reason: NoCrop };

const sameColour = (a: Colour, b: Colour, tolerance: number) =>
  Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance && Math.abs(a[2] - b[2]) <= tolerance;

/**
 * The content box of a video from its sampled frames, or why it is not
 * cropped.
 *
 * - Blank frames (only the border colour) are skipped; at least
 *   {@link MIN_FRAMES} others are needed.
 * - The border colour must be the same in every frame that has one: a frame
 *   whose border has another colour (or none) counts as content everywhere.
 * - The box is the union over the frames, widened to even edges, then
 *   snapped to a standard size ({@link STANDARD_SIZES}) within
 *   {@link SNAP_SHARE}, keeping the side that touches the frame's edge.
 * - No crop when the box covers {@link FULL_SHARE} of the frame in both
 *   directions, is smaller than {@link MIN_AREA} or {@link MIN_SIDE}, or its
 *   display aspect (`sar` is the pixel aspect) is outside 0.25–4.
 */
export function decide(results: FrameResult[], width: number, height: number, sar = 1, tolerance = TOLERANCE): Decision {
  const shown = results.filter((r) => r.kind !== "blank");
  if (shown.length < MIN_FRAMES) return { reason: "few-frames" };
  // The border colour most frames agree on.
  const colours = shown.flatMap((r) => (r.kind === "border" ? [r.colour] : []));
  let colour: Colour | null = null;
  let votes = 0;
  for (const candidate of colours) {
    const n = colours.filter((c) => sameColour(c, candidate, tolerance)).length;
    if (n > votes) [colour, votes] = [candidate, n];
  }
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  for (const r of shown) {
    const box =
      r.kind === "border" && colour && sameColour(r.colour, colour, tolerance)
        ? r.box
        : { x: 0, y: 0, width, height };
    x0 = Math.min(x0, box.x);
    y0 = Math.min(y0, box.y);
    x1 = Math.max(x1, box.x + box.width);
    y1 = Math.max(y1, box.y + box.height);
  }
  // Even edges keep 4:2:0 chroma whole, as the player's crop needs (its
  // crop never keeps the last column or row of an odd size).
  x0 -= x0 % 2;
  y0 -= y0 % 2;
  x1 = Math.min(x1 + (x1 % 2), width & ~1);
  y1 = Math.min(y1 + (y1 % 2), height & ~1);
  let rect: Rect = { x: x0, y: y0, width: (x1 - x0) & ~1, height: (y1 - y0) & ~1 };
  if (rect.width >= FULL_SHARE * width && rect.height >= FULL_SHARE * height) return { reason: "no-border" };
  rect = snapStandard(rect, width, height);
  if (rect.width * rect.height < MIN_AREA * width * height || rect.width < MIN_SIDE || rect.height < MIN_SIDE) {
    return { reason: "small" };
  }
  const aspect = (rect.width * sar) / rect.height;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) return { reason: "aspect" };
  return { rect };
}

/** Move a box edge after a size change: keep a side that touches the frame, else stay centred; even, inside the frame. */
function place(start: number, size: number, next: number, frame: number): number {
  let at: number;
  if (start === 0) at = 0;
  else if (start + size >= frame) at = frame - next;
  else at = start + Math.round((size - next) / 4) * 2;
  at = Math.max(0, Math.min(at, frame - next));
  return at - (at % 2);
}

/**
 * The nearest standard size ({@link STANDARD_SIZES}) when both sides are
 * within {@link SNAP_SHARE} of it and it fits the frame; otherwise the box
 * as it is. Compression blurs a box edge by a pixel or two.
 */
export function snapStandard(rect: Rect, width: number, height: number): Rect {
  let best: readonly [number, number] | null = null;
  let distance = Infinity;
  for (const size of STANDARD_SIZES) {
    const [w, h] = size;
    if (w > width || h > height) continue;
    if (Math.abs(rect.width - w) > SNAP_SHARE * w || Math.abs(rect.height - h) > SNAP_SHARE * h) continue;
    const d = Math.abs(rect.width - w) + Math.abs(rect.height - h);
    if (d < distance) [best, distance] = [size, d];
  }
  if (!best || distance === 0) return rect;
  const [w, h] = best;
  return { x: place(rect.x, rect.width, w, width), y: place(rect.y, rect.height, h, height), width: w, height: h };
}

/** A `reframe` crop node (the player's `VideoNode`). */
export type CropNode = Extract<VideoNode, { kind: "reframe" }>;

/** C's `lrint` in the default rounding mode: to the nearest integer, halves to even. */
function lrint(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * What the player's FFmpeg crop makes of a `reframe` crop node on an
 * `iw × ih` picture with pixel aspect `sar`. The player maps the node to
 *
 * `crop=w='2*trunc(min(iw,ih*A/sar)/2)':h='2*trunc(min(ih,iw*sar/A)/2)':x='(iw-ow)*(1+(X))/2':y='(ih-oh)*(1+(Y))/2'`
 *
 * (`effects.rs`), which FFmpeg evaluates in doubles in this order, rounds
 * with `lrint`, and, for 4:2:0 video, moves `x` and `y` down to even.
 */
export function simulateCrop(iw: number, ih: number, sar: number, node: CropNode): Rect {
  const a = node.aspect;
  const w = lrint(2 * Math.trunc(Math.min(iw, (ih * a) / sar) / 2));
  const h = lrint(2 * Math.trunc(Math.min(ih, (iw * sar) / a) / 2));
  let x = lrint(((iw - w) * (1 + node.x)) / 2);
  let y = lrint(((ih - h) * (1 + node.y)) / 2);
  x = Math.max(0, Math.min(x, iw - w));
  y = Math.max(0, Math.min(y, ih - h));
  return { x: x & ~1, y: y & ~1, width: w, height: h };
}

/** The picture that a chain of crop nodes leaves of an `iw × ih` frame, in the frame's pixels. */
export function simulateChain(iw: number, ih: number, sar: number, nodes: readonly CropNode[]): Rect {
  let rect: Rect = { x: 0, y: 0, width: iw, height: ih };
  for (const node of nodes) {
    const cut = simulateCrop(rect.width, rect.height, sar, node);
    rect = { x: rect.x + cut.x, y: rect.y + cut.y, width: cut.width, height: cut.height };
  }
  return rect;
}

/** The position field of a crop node: where `start` sits in the `free` pixels the crop leaves (−1 … 1). */
const position = (start: number, free: number) => (free === 0 ? 0 : (2 * start) / free - 1);

const inRange = (node: CropNode) =>
  node.aspect >= MIN_ASPECT && node.aspect <= MAX_ASPECT && Math.abs(node.x) <= 1 && Math.abs(node.y) <= 1;

/**
 * The crop nodes that cut `rect` out of a `width × height` frame with pixel
 * aspect `sar`: one that narrows the picture and one that lowers it, each
 * left out when that side is not cropped; `null` when no such chain gives
 * exactly `rect` (checked with {@link simulateChain}).
 *
 * A node's aspect is aimed half a pixel past the wanted size, so the
 * player's `2*trunc(…/2)` lands on the even size however the division
 * rounds. The two orders differ only in the aspect of the first node (the
 * second always has the content's), so the one whose first aspect the
 * player accepts (0.25–4) is used.
 */
export function cropNodes(rect: Rect, width: number, height: number, sar = 1): CropNode[] | null {
  // Each node takes a `w × h` picture. The side it does not cut comes out
  // at its even size (`2*trunc(…/2)`), so an odd frame loses its last column
  // or row there, as `decide` already assumes.
  const narrow = (w: number, h: number): CropNode => ({
    kind: "reframe",
    mode: "crop",
    aspect: ((rect.width + 1) * sar) / h,
    x: position(rect.x, w - rect.width),
    y: 0,
  });
  const lower = (w: number, h: number): CropNode => ({
    kind: "reframe",
    mode: "crop",
    aspect: ((w & ~1) * sar) / (rect.height + 1),
    x: 0,
    y: position(rect.y, h - rect.height),
  });
  const cutW = rect.width < (width & ~1);
  const cutH = rect.height < (height & ~1);
  const orders: CropNode[][] = [];
  if (cutW && cutH) {
    orders.push([narrow(width, height), lower(rect.width, height & ~1)]);
    orders.push([lower(width, height), narrow(width & ~1, rect.height)]);
  } else if (cutW) orders.push([narrow(width, height)]);
  else if (cutH) orders.push([lower(width, height)]);
  else return [];
  for (const nodes of orders) {
    if (!nodes.every(inRange)) continue;
    const got = simulateChain(width, height, sar, nodes);
    if (got.x === rect.x && got.y === rect.y && got.width === rect.width && got.height === rect.height) return nodes;
  }
  return null;
}

/**
 * The size mpv reports for a `w × h` picture with pixel aspect `num:den`
 * (`displayWidth`, `displayHeight`): the wider side is stretched, as
 * `mp_image_params_get_dsize` does.
 */
export function displaySize(w: number, h: number, num = 1, den = 1): { width: number; height: number } {
  if (num > den && den >= 1) return { width: Math.trunc((w * num) / den), height: h };
  if (den > num && num >= 1) return { width: w, height: Math.trunc((h * den) / num) };
  return { width: w, height: h };
}

/** The sample times: `count` evenly spaced between 5 % and 95 % of the duration. */
export function sampleTimes(duration: number, count = 8): number[] {
  if (!(duration > 0)) return [0];
  if (count === 1) return [duration / 2];
  return Array.from({ length: count }, (_, i) => duration * (0.05 + (0.9 * i) / (count - 1)));
}
