import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Scope } from "@vestra-player/sdk";
import type { Method } from "./clip.ts";

/**
 * Finished clips shown in the tab's Results. The most recent twenty are kept
 * in `<dataDirectory>/results.json` across restarts (finished results only;
 * tasks and failed input stay in the session). A row whose file is gone says
 * so.
 */
export interface Saved {
  id: string;
  /** The clip's file. */
  path: string;
  method: Method;
  bytes: number;
  /** Media times: the clip's range as written. */
  start: number;
  end: number;
  /** When it finished (ms since the epoch). */
  finished: number;
  /** The thumbnail file in `<dataDirectory>/thumbs`, "" without one. */
  thumb: string;
}

export const RESULT_LIMIT = 20;

const isSaved = (value: unknown): value is Saved => {
  const v = value as Partial<Saved>;
  return (
    typeof v === "object" && v !== null &&
    typeof v.id === "string" && typeof v.path === "string" && !!v.path &&
    typeof v.finished === "number" && Number.isFinite(v.finished)
  );
};
const number = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** Stored results, the valid ones, newest first, at most twenty. */
export function savedOf(stored: unknown): Saved[] {
  const list = Array.isArray((stored as { list?: unknown })?.list) ? (stored as { list: unknown[] }).list : [];
  return list
    .filter(isSaved)
    .map((v) => ({
      id: v.id, path: v.path, finished: v.finished,
      method: (v.method === "fast" ? "fast" : "precise") as Method,
      bytes: number(v.bytes),
      start: number(v.start), end: number(v.end, number(v.start)),
      thumb: typeof v.thumb === "string" ? basename(v.thumb) : "",
    }))
    .sort((a, b) => b.finished - a.finished)
    .slice(0, RESULT_LIMIT);
}

type ResultStore = { value: { list: unknown[] }; save(next: { list: Saved[] }): void; flush(): Promise<void> } | null;

export class Results {
  list: Saved[] = [];
  /** Ids whose file is gone (checked at start and when the tab shows). */
  readonly gone = new Set<string>();
  readonly #store: ResultStore;
  #sequence = 0;
  constructor(plugin: Scope) {
    let store = null;
    try {
      store = plugin.storage.json<{ list: unknown[] }>("results", { defaults: { list: [] }, validate: (v): v is { list: unknown[] } => Array.isArray((v as { list?: unknown })?.list) });
    } catch {
      // no data directory: results last for the session
    }
    this.#store = store as unknown as ResultStore;
    this.list = savedOf(store?.value);
    this.#sequence = this.list.reduce((top, item) => Math.max(top, Number(item.id.replace(/\D/g, "")) || 0), 0);
  }

  #save() {
    this.#store?.save({ list: this.list.map((item) => ({ ...item })) });
  }

  /** A finished clip, first in the list; the twenty-first goes (returned, for its thumbnail). */
  add(fields: Omit<Saved, "id">): { saved: Saved; dropped: Saved[] } {
    const saved: Saved = { ...fields, id: `r${++this.#sequence}` };
    this.list.unshift(saved);
    const dropped = this.list.splice(RESULT_LIMIT);
    for (const item of dropped) this.gone.delete(item.id);
    this.#save();
    return { saved, dropped };
  }
  find = (id: string) => this.list.find((item) => item.id === id);
  update(item: Saved, patch: Partial<Saved>) {
    Object.assign(item, patch);
    this.#save();
  }
  remove(id: string) {
    const index = this.list.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [item] = this.list.splice(index, 1);
    this.gone.delete(id);
    this.#save();
    return item!;
  }
  clear() {
    const all = this.list;
    this.list = [];
    this.gone.clear();
    this.#save();
    return all;
  }
  /** Look again whether each file exists; true when anything changed. */
  async check() {
    let changed = false;
    for (const item of this.list) {
      const there = !!(await stat(item.path).catch(() => null));
      if (there === this.gone.has(item.id)) {
        changed = true;
        if (there) this.gone.delete(item.id);
        else this.gone.add(item.id);
      }
    }
    return changed;
  }
  flush() {
    return this.#store?.flush();
  }
}

/** A finished clip's size. */
export async function sizeOf(path: string) {
  return (await stat(path).catch(() => null))?.size ?? 0;
}

/** 64×36 thumbnails (twice that for sharp HiDPI rows). */
const THUMB_W = 128;
const THUMB_H = 72;
const THUMB_TIMEOUT_MS = 10_000;
/**
 * ffmpeg's arguments for one small JPEG of a clip's first keyframe on stdout:
 * one thread, as the playlist's thumbnails, so the player keeps the other
 * cores. `at` (seconds): the first keyframe from there (a Highlights row's
 * start), found by seeking the input; only keyframes are decoded. `before`:
 * the keyframe at or before `at` instead (the seek lands there and keeps it),
 * for a start in the last keyframe interval, after which there is none.
 */
export function thumbArgs(path: string, size: { width: number; height: number } = { width: THUMB_W, height: THUMB_H }, at?: number, before = false) {
  return [
    "-nostdin", "-v", "error", "-threads", "1", "-skip_frame", "nokey",
    ...(at === undefined ? [] : [...(before ? ["-noaccurate_seek"] : []), "-ss", Math.max(0, at).toFixed(3)]),
    "-i", path,
    "-map", "0:V:0", "-an", "-sn", "-dn", "-frames:v", "1", "-filter_threads", "1",
    // The keyframe before the seek point is timed before it: the default frame-rate handling would drop it.
    ...(before ? ["-fps_mode", "passthrough"] : []),
    "-vf", `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease:flags=bilinear,format=yuvj420p`,
    "-threads", "1", "-q:v", "5", "-f", "image2pipe", "-c:v", "mjpeg", "-",
  ];
}

/**
 * Make a result's thumbnail in `folder` (the data directory's `thumbs`); its
 * file name, or "" when ffmpeg is missing or fails (the row then shows its
 * icon only). The player shows images only from the package and data
 * directories.
 */
export async function makeThumb(plugin: Scope, folder: string | null, item: Saved): Promise<string> {
  if (!folder) return "";
  try {
    if (!(await plugin.tools.available("ffmpeg"))) return "";
    const { stdout } = await plugin.tools.run("ffmpeg", thumbArgs(item.path), { timeoutMs: THUMB_TIMEOUT_MS, maxOutput: 1 << 20 });
    if (!stdout.length) return "";
    await mkdir(folder, { recursive: true });
    const name = `${item.id}-${item.finished}.jpg`;
    await writeFile(join(folder, name), stdout);
    return name;
  } catch (error) {
    console.error(`[clipexport] thumbnail: ${(error as Error).message}`);
    return "";
  }
}

/** A Collection row's thumbnail: twice the row's 64×36, so the data directory keeps small files (max side 256). */
export const PART_THUMB = { width: 256, height: 144 };
/**
 * Scale the picture at `input` (a captured frame; or a video, from `at`
 * seconds, see `thumbArgs`) down to `size` with ffmpeg, the same way as the
 * Results thumbnails, into `output`; its file name, or "" when ffmpeg is
 * missing or fails (or `signal` stopped it). The picture is written under a
 * temporary name and then renamed, so a half-written one is never kept.
 */
export async function scaleThumb(
  plugin: Scope, input: string, output: string, size: { width: number; height: number },
  options: { at?: number; before?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    if (!(await plugin.tools.available("ffmpeg"))) return "";
    const { stdout } = await plugin.tools.run("ffmpeg", thumbArgs(input, size, options.at, options.before), {
      timeoutMs: THUMB_TIMEOUT_MS, maxOutput: 1 << 20, ...(options.signal ? { signal: options.signal } : {}),
    });
    // Stopped while it ran (another file, deactivated): nothing is written.
    options.signal?.throwIfAborted();
    if (!stdout.length) return "";
    // Its folder is made with the first picture in it.
    await mkdir(dirname(output), { recursive: true });
    await writeFile(temporary, stdout);
    await rename(temporary, output);
    return basename(output);
  } catch (error) {
    if (!options.signal?.aborted) console.error(`[clipexport] thumbnail: ${(error as Error).message}`);
    await rm(temporary, { force: true }).catch(() => {});
    return "";
  }
}
