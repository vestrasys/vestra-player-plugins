import type { ExportCheck, ExportPart, Scope } from "@vestra-player/sdk";
import { CUT, normalize, transitionOf } from "./transitions.ts";
import type { Transition } from "./transitions.ts";

/**
 * The Collection: ranges of several local files, gathered in one list and
 * exported as one merged file. A part names its file by the player's token
 * (`plugin.media.sources`), never by its path; the list is kept in
 * `<dataDirectory>/collection.json` across restarts, and the player keeps the
 * tokens.
 */
export interface Part {
  id: string;
  /** The file's token (`SourceReference.token`). */
  token: string;
  /** The file's name as the player gave it (display only). */
  name: string;
  /** Seconds of the file. */
  start: number;
  end: number;
  /** The thumbnail file in `<dataDirectory>/parts`, "" without one. */
  thumb: string;
  /**
   * The transition into the next part (Cut: none). It belongs to the end of
   * this part, so a reorder carries it; the last part's is always Cut.
   */
  transition: Transition;
  /** The source's video bit rate (bits per second) as ffprobe read it when the part was added: a "Same as source" export with transitions aims at it. */
  bitrate?: number;
}

/** Parts of one merged export (the SDK's `MEDIA_SOURCE_LIMITS.parts`): the Collection holds no more. */
export const PART_LIMIT = 100;
/** The wait before the next automatic check after `busy` answers in a row: 0.3 s doubling, none after five. */
export const retryDelay = (tries: number) => (tries < 5 ? 300 * 2 ** tries : null);
/** How long Clear Collection can be undone. */
export const UNDO_MS = 30_000;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isPart = (value: unknown): value is Part => {
  const v = value as Partial<Part>;
  return (
    typeof v === "object" && v !== null &&
    typeof v.id === "string" && !!v.id && typeof v.token === "string" && !!v.token &&
    finite(v.start) && finite(v.end) && v.start >= 0 && v.end > v.start
  );
};

/** Stored parts, the valid ones in their order, at most {@link PART_LIMIT}; a repeated id keeps its first part. */
export function partsOf(stored: unknown): Part[] {
  const list = Array.isArray((stored as { parts?: unknown })?.parts) ? (stored as { parts: unknown[] }).parts : [];
  const seen = new Set<string>();
  const parts: Part[] = [];
  for (const v of list) {
    if (!isPart(v) || seen.has(v.id)) continue;
    seen.add(v.id);
    parts.push({
      id: v.id, token: v.token, start: v.start, end: v.end,
      name: typeof v.name === "string" ? v.name : "",
      // A file name in the plugin's own folder: never a path.
      thumb: typeof v.thumb === "string" && /^[\w.-]+$/.test(v.thumb) ? v.thumb : "",
      ...(typeof (v as { bitrate?: unknown }).bitrate === "number" && (v as { bitrate: number }).bitrate > 0 ? { bitrate: (v as { bitrate: number }).bitrate } : {}),
      // 0.2.x parts have none: a Cut, so their export is unchanged.
      transition: transitionOf((v as { transition?: unknown }).transition),
    });
    if (parts.length >= PART_LIMIT) break;
  }
  return normalize(parts);
}

/** The parts as the export and its check take them. */
export const exportParts = (parts: readonly Part[]): ExportPart[] => parts.map(({ token, start, end }) => ({ source: token, start, end }));
/** One string per list of parts: a check answers for the list it was asked about. */
export const listKey = (parts: readonly ExportPart[]) => JSON.stringify(parts.map(({ source, start, end }) => [source, start, end]));
/** The parts' length together, in seconds. */
export const totalLength = (parts: readonly { start: number; end: number }[]) => parts.reduce((sum, part) => sum + (part.end - part.start), 0);

/** `list` with the item at `from` moved to `to` (both clamped into the list); a new array. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item!);
  return next;
}

/** What stops a part, from a check (`blocking`): `ok` for none; the first problem a part has. */
export function partStates(check: ExportCheck | null, count: number): string[] {
  const states = Array.from({ length: count }, () => "ok");
  for (const { part, problem } of check?.blocking ?? []) if (part >= 0 && part < count && states[part] === "ok") states[part] = problem;
  return states;
}

/** The first thing that stops the export, as data for the tab (parts from 1); none: `shown` false. */
export function blockingNote(check: ExportCheck | null) {
  const first = check?.blocking[0];
  return first ? { shown: true, part: String(first.part + 1), problem: first.problem } : { shown: false, part: "", problem: "" };
}

const valueText = (value: string | number | null) => (value === null ? "none" : String(value));
/**
 * Why Fast cannot write these parts, as data (the first difference from part
 * 1); `checked` false while no check answered for the list, `ok` when a copy
 * can write them.
 */
export function copyNote(check: ExportCheck | null) {
  if (!check) return { checked: false, ok: false, part: "", field: "", value: "", expected: "", container: "" };
  if (check.copy.ok) return { checked: true, ok: true, part: "", field: "", value: "", expected: "", container: check.copy.container };
  const first = check.copy.reasons[0];
  return {
    checked: true, ok: false,
    part: first ? String(first.part + 1) : "",
    field: first?.field ?? "",
    value: first ? valueText(first.value) : "",
    expected: first ? valueText(first.expected) : "",
    container: "",
  };
}

/** What a re-encode writes (the check's `encode`), as data; `shown` false without one. */
export function targetNote(check: ExportCheck | null) {
  const encode = check?.encode;
  if (!encode) return { shown: false, size: "", fps: "", audio: false };
  return { shown: true, size: `${encode.width}×${encode.height}`, fps: String(Math.round(encode.fps * 100) / 100), audio: !!encode.audio };
}

/** The progress bar's ticks at the joins between parts: a path in a 1000×10 box (as the small timeline's). */
export function partTicks(lengths: readonly number[]): string {
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (lengths.length < 2 || !(total > 0)) return "";
  let at = 0;
  const ticks: string[] = [];
  for (const length of lengths.slice(0, -1)) {
    at += length;
    ticks.push(`M ${Math.round((at / total) * 1000)} 0 V 10`);
  }
  return ticks.join(" ");
}

/** `m:ss.t` for the Collection's total length ("1:02.2"); hours when there are some. */
export function lengthClock(seconds: number) {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const h = Math.floor(tenths / 36_000), m = Math.floor(tenths / 600) % 60, s = Math.floor(tenths / 10) % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${h ? `${h}:${two(m)}` : m}:${two(s)}.${tenths % 10}`;
}

type PartStore = { value: { parts: unknown[] }; save(next: { parts: Part[] }): void; flush(): Promise<void> } | null;

/** The list itself: parts in order, kept in the data directory (for this session only without one). */
export class Collection {
  parts: Part[] = [];
  readonly #store: PartStore;
  #sequence = 0;
  constructor(plugin: Scope) {
    let store = null;
    try {
      store = plugin.storage.json<{ parts: unknown[] }>("collection", { defaults: { parts: [] }, validate: (v): v is { parts: unknown[] } => Array.isArray((v as { parts?: unknown })?.parts) });
    } catch {
      // no data directory: the Collection lasts for the session
    }
    this.#store = store as unknown as PartStore;
    this.parts = partsOf(store?.value);
    this.#sequence = this.parts.reduce((top, part) => Math.max(top, Number(part.id.replace(/\D/g, "")) || 0), 0);
  }

  /** Every change ends here: the transitions are fitted to their (new) neighbours first. */
  #save() {
    normalize(this.parts);
    this.#store?.save({ parts: this.parts.map((part) => ({ ...part, transition: { ...part.transition } })) });
  }
  full = () => this.parts.length >= PART_LIMIT;
  find = (id: string) => this.parts.find((part) => part.id === id);
  indexOf = (id: string) => this.parts.findIndex((part) => part.id === id);
  /** The tokens the parts use. */
  tokens = () => new Set(this.parts.map((part) => part.token));

  /** A new part at the end of the list; the part before it joins it with `join` (the default for new parts, Cut at first). */
  add(fields: Omit<Part, "id" | "thumb" | "transition">, join: Transition = CUT): Part {
    const part: Part = { ...fields, id: `p${++this.#sequence}`, thumb: "", transition: { ...CUT } };
    const last = this.parts.at(-1);
    if (last) last.transition = { ...join };
    this.parts.push(part);
    this.#save();
    return part;
  }
  update(part: Part, patch: Partial<Omit<Part, "id">>) {
    Object.assign(part, patch);
    this.#save();
  }
  /** Every part of a file gets its new name (after Locate…). */
  rename(token: string, name: string) {
    for (const part of this.parts) if (part.token === token) part.name = name;
    this.#save();
  }
  remove(id: string): Part | null {
    const index = this.indexOf(id);
    if (index < 0) return null;
    const [part] = this.parts.splice(index, 1);
    this.#save();
    return part!;
  }
  /** Move a part to `to` (an index of the list as it is); false when nothing moved. */
  move(id: string, to: number): boolean {
    const from = this.indexOf(id);
    const target = Math.max(0, Math.min(Math.round(to), this.parts.length - 1));
    if (from < 0 || !Number.isFinite(to) || target === from) return false;
    this.parts = moved(this.parts, from, target);
    this.#save();
    return true;
  }
  /** Empty the list; the parts it held are returned (for Undo). */
  clear(): Part[] {
    const all = this.parts;
    this.parts = [];
    this.#save();
    return all;
  }
  /**
   * Undo a Clear: the old parts come back first, parts added since stay after
   * them. Nothing is dropped: false (and nothing changes) when they would not
   * fit within {@link PART_LIMIT} together.
   */
  restore(old: Part[]): boolean {
    const ids = new Set(this.parts.map((part) => part.id));
    const back = old.filter((part) => !ids.has(part.id));
    if (back.length + this.parts.length > PART_LIMIT) return false;
    this.parts = [...back, ...this.parts];
    this.#save();
    return true;
  }
  /** The transition from part `id` into the next one (fitted to their limit). */
  setTransition(id: string, transition: Transition) {
    const part = this.find(id);
    if (!part) return;
    part.transition = { ...transition };
    this.#save();
  }
  /** Every junction gets `transition` (each fitted to its own limit); the transitions before, by part id (for Undo). */
  applyAll(transition: Transition): Map<string, Transition> {
    const before = new Map(this.parts.map((part) => [part.id, { ...part.transition }]));
    for (const part of this.parts.slice(0, -1)) part.transition = { ...transition };
    this.#save();
    return before;
  }
  /** Undo Apply to All: each part that is still there gets its transition back. */
  restoreTransitions(before: ReadonlyMap<string, Transition>) {
    for (const part of this.parts) {
      const old = before.get(part.id);
      if (old) part.transition = { ...old };
    }
    this.#save();
  }
  flush() {
    return this.#store?.flush();
  }
}
