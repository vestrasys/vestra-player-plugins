import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Scope } from "@vestra-player/sdk";
import { encodeOf, lastSeconds, OUTPUTS } from "./clip.ts";
import type { Encode, Output } from "./clip.ts";
import { COUNTS, DEFAULT_COUNT } from "./highlights.ts";
import { COLLECTION_TEMPLATE, normalTemplate } from "./names.ts";
import { transitionOf } from "./transitions.ts";
import type { Transition } from "./transitions.ts";

/** Everything kept in `settings.json`. */
export interface Settings {
  /** The clip folder. */
  folder: string;
  /** Save into the media's folder when possible. */
  besideMedia: boolean;
  /**
   * The Output the user picked (Fast, Precise, GIF or WebP); Fast by default.
   * Kept under its old name: 0.1.0–0.6.x stored Fast or Precise here.
   */
  method: Output;
  /** A Precise cut's MP4 options (R6), High quality by default; GIF and WebP have fixed ones. */
  encode: Encode;
  /** The file-name template. */
  template: string;
  /** "Last N s" length. */
  lastSeconds: number;
  /** The Clip page's Advanced rows are open. */
  advancedOpen: boolean;
  /** The merged export's file-name template (the Collection). */
  collectionTemplate: string;
  /** The transition a new part gets from the part before it: Cut until Apply to All sets another (Q3 a). */
  newTransition: Transition;
  /** The sub-tab shown last. */
  page: Page;
  /** Seconds of work per second of media of the last Precise export on this machine (the time estimate); null before one. */
  preciseSpeed: number | null;
  /** How many suggestions the Highlights page lists (5, 10 or 20). */
  highlightCount: number;
  /**
   * The user chose Loudness Only without the sound model: Find Highlights (the command) then scans that way; the
   * page still offers the download above a file not scanned. Set back when the model is downloaded.
   */
  highlightLoudness: boolean;
}

/** The pages of the tab, as its sub-tab strip orders them (0.4.0: the Collection is a section of the Clip page; 0.6.0: Highlights). */
export const PAGES = ["clip", "highlights", "results", "settings"] as const;
export type Page = (typeof PAGES)[number];
/** The pages 0.1.x numbered (it kept the index). */
const NUMBERED: readonly Page[] = ["clip", "results", "settings"];
/**
 * A stored page: its name; 0.2.x and 0.3.x kept "collection" (now the Clip
 * page); 0.1.x kept its index among Clip, Results, Settings.
 */
const pageOf = (value: unknown): Page =>
  value === "collection" ? "clip" : PAGES.includes(value as Page) ? (value as Page) : Number.isInteger(value) ? (NUMBERED[value as number] ?? "clip") : "clip";

/**
 * A stored Output. 0.5.0–0.6.x offered Animated GIF and Animated WebP as
 * Precise's Quality (`encode.format`): with Precise chosen that is the GIF
 * or WebP Output now, so the next export writes what the last one did. With
 * Fast chosen the quality was not used (Fast copied): Fast stays.
 */
export function outputOf(method: unknown, encode: unknown): Output {
  const format = isObject(encode) ? encode.format : undefined;
  if (method === "precise" && (format === "gif" || format === "webp")) return format;
  return OUTPUTS.includes(method as Output) ? (method as Output) : "fast";
}

/** The user's Videos folder, else the home folder. */
export const defaultFolder = () => {
  const videos = join(homedir(), "Videos");
  return existsSync(videos) ? videos : homedir();
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isFolder = (path: unknown) => {
  try {
    return typeof path === "string" && !!path && statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const inRange = (value: unknown, low: number, high: number, fallback: number) => {
  const n = Number(value);
  return typeof value === "number" && Number.isFinite(n) && n >= low && n <= high ? n : fallback;
};

/** Settings from stored data, field by field: an invalid field falls back alone. */
export function settingsOf(stored: unknown, folder = defaultFolder()): Settings {
  const s = isObject(stored) ? stored : {};
  return {
    folder: isFolder(s.folder) ? (s.folder as string) : folder,
    besideMedia: flag(s.besideMedia, false),
    method: outputOf(s.method, s.encode),
    encode: encodeOf(s.encode),
    template: normalTemplate(s.template),
    lastSeconds: lastSeconds(s.lastSeconds),
    advancedOpen: flag(s.advancedOpen, false),
    collectionTemplate: normalTemplate(s.collectionTemplate, COLLECTION_TEMPLATE),
    newTransition: transitionOf(s.newTransition),
    page: pageOf(s.page),
    preciseSpeed: s.preciseSpeed === null || s.preciseSpeed === undefined ? null : inRange(s.preciseSpeed, 0.01, 1000, 0) || null,
    highlightCount: (COUNTS as readonly unknown[]).includes(s.highlightCount) ? (s.highlightCount as number) : DEFAULT_COUNT,
    highlightLoudness: flag(s.highlightLoudness, false),
  };
}

/**
 * The settings in `<dataDirectory>/settings.json` (`plugin.storage`): a damaged
 * file is set aside by the SDK; a partly invalid one falls back field by field,
 * and a folder that no longer exists falls back to Videos. `save()` writes the
 * current values (debounced, and on deactivation). Without a data directory
 * they are kept for this session only.
 */
export function openSettings(plugin: Scope) {
  let store: { value: Record<string, unknown>; save(next: Record<string, unknown>): void } | null = null;
  try {
    store = plugin.storage.json<Record<string, unknown>>("settings", { defaults: {}, validate: isObject });
  } catch {
    // no data directory
  }
  const settings = settingsOf(store?.value);
  return { settings, save: () => store?.save(structuredClone(settings) as unknown as Record<string, unknown>) };
}
