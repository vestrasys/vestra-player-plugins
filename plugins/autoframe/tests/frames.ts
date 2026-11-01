/** Synthetic `rgb24` frames and the player's crop expression, for the tests. */
import type { Rect } from "../detect.ts";

export type Rgb = readonly [number, number, number];

/**
 * A `width × height` frame of `background` with a busy pattern inside
 * `content` (every row and column of it differs from the background).
 */
export function makeFrame(width: number, height: number, background: Rgb, content: Rect | null, seed = 0): Uint8Array {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = background[0];
    data[i + 1] = background[1];
    data[i + 2] = background[2];
  }
  if (!content) return data;
  for (let y = content.y; y < content.y + content.height; y++) {
    for (let x = content.x; x < content.x + content.width; x++) {
      const i = (y * width + x) * 3;
      data[i] = (x * 5 + y * 11 + seed * 37) & 255;
      data[i + 1] = (x * 3 + y * 7 + 90 + seed * 13) & 255;
      data[i + 2] = (x * 13 + y * 2 + 200) & 255;
    }
  }
  return data;
}

// ---------------------------------------------------------------- the host's expression

/** A number as Rust's `{}` (f64 Display) writes it: shortest round trip, never an exponent. */
export function rustNumber(value: number): string {
  const s = String(value);
  if (!/e/i.test(s)) return s;
  const [mantissa, exponent] = s.split(/e/i) as [string, string];
  const negative = mantissa.startsWith("-");
  const m = mantissa.replace(/^-/, "");
  const dot = m.indexOf(".");
  const digits = m.replace(".", "");
  // Where the decimal point goes in `digits`.
  const point = (dot < 0 ? m.length : dot) + Number(exponent);
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? "-" : "") + out;
}

/** The FFmpeg crop filter the player writes for a `reframe` crop node (`effects.rs`). */
export function hostCropFilter(aspect: number, x: number, y: number): { w: string; h: string; x: string; y: string } {
  const a = rustNumber(aspect);
  return {
    w: `2*trunc(min(iw,ih*${a}/sar)/2)`,
    h: `2*trunc(min(ih,iw*sar/${a})/2)`,
    x: `(iw-ow)*(1+(${rustNumber(x)}))/2`,
    y: `(ih-oh)*(1+(${rustNumber(y)}))/2`,
  };
}

/** A small evaluator of FFmpeg's expression language: numbers, variables, + − * /, unary minus, min and trunc, in doubles. */
export function evaluate(expression: string, vars: Record<string, number>): number {
  let i = 0;
  const s = expression.replace(/\s+/g, "");
  const peek = () => s[i];
  function primary(): number {
    if (peek() === "(") {
      i++;
      const v = sum();
      if (s[i++] !== ")") throw new Error(`) expected in ${s}`);
      return v;
    }
    if (peek() === "-") {
      i++;
      return -primary();
    }
    const number = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (number) {
      i += number[0].length;
      return Number(number[0]);
    }
    const name = /^[a-z_]+/.exec(s.slice(i));
    if (!name) throw new Error(`unexpected ${s.slice(i)}`);
    i += name[0].length;
    if (peek() === "(") {
      i++;
      const args = [sum()];
      while (peek() === ",") {
        i++;
        args.push(sum());
      }
      if (s[i++] !== ")") throw new Error(`) expected in ${s}`);
      if (name[0] === "min") return Math.min(args[0]!, args[1]!);
      if (name[0] === "trunc") return Math.trunc(args[0]!);
      throw new Error(`unknown function ${name[0]}`);
    }
    if (!(name[0] in vars)) throw new Error(`unknown variable ${name[0]}`);
    return vars[name[0]]!;
  }
  function product(): number {
    let v = primary();
    while (peek() === "*" || peek() === "/") {
      const op = s[i++];
      const r = primary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function sum(): number {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const v = sum();
  if (i !== s.length) throw new Error(`trailing ${s.slice(i)}`);
  return v;
}

/** C's lrint: nearest, halves to even. */
const lrint = (v: number) => {
  const f = Math.floor(v);
  return v - f > 0.5 ? f + 1 : v - f < 0.5 ? f : f % 2 === 0 ? f : f + 1;
};

/**
 * FFmpeg's crop filter (`vf_crop.c`, not `exact`) on a 4:2:0 picture: `w`,
 * `h` evaluated (w, h, then w again), rounded with lrint; `x`, `y`
 * evaluated, rounded, clamped into the picture and moved down to even.
 */
export function ffmpegCrop(
  filter: { w: string; h: string; x: string; y: string },
  iw: number,
  ih: number,
  sar: number,
): Rect {
  const vars: Record<string, number> = { iw, ih, in_w: iw, in_h: ih, sar, a: iw / ih };
  let ow = evaluate(filter.w, vars);
  vars.ow = vars.out_w = ow;
  const oh = evaluate(filter.h, vars);
  vars.oh = vars.out_h = oh;
  ow = evaluate(filter.w, vars);
  vars.ow = vars.out_w = ow;
  const w = lrint(ow);
  const h = lrint(oh);
  vars.ow = w;
  vars.oh = h;
  let x = lrint(evaluate(filter.x, vars));
  let y = lrint(evaluate(filter.y, vars));
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > iw) x = iw - w;
  if (y + h > ih) y = ih - h;
  return { x: x & ~1, y: y & ~1, width: w & ~1, height: h & ~1 };
}

/** What the player's chain of `reframe` crop nodes leaves of a frame, through the host's own expressions. */
export function hostChain(
  iw: number,
  ih: number,
  sar: number,
  nodes: readonly { aspect: number; x: number; y: number }[],
): Rect {
  let rect: Rect = { x: 0, y: 0, width: iw, height: ih };
  for (const node of nodes) {
    const cut = ffmpegCrop(hostCropFilter(node.aspect, node.x, node.y), rect.width, rect.height, sar);
    rect = { x: rect.x + cut.x, y: rect.y + cut.y, width: cut.width, height: cut.height };
  }
  return rect;
}
