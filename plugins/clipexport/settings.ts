import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Scope } from "@vestra-player/sdk";
import { encodeOf, lastSeconds, METHODS } from "./clip.ts";
import type { Encode, Method } from "./clip.ts";
import { normalTemplate } from "./names.ts";

/** Everything kept in `settings.json`. */
export interface Settings {
  /** The clip folder. */
  folder: string;
  /** Save into the media's folder when possible. */
  besideMedia: boolean;
  /** The clip method the user picked; Fast by default. */
  method: Method;
  /** A Precise cut's options (R6), High quality by default. */
  encode: Encode;
  /** The file-name template. */
  template: string;
  /** "Last N s" length. */
  lastSeconds: number;
  /** The Clip page's Advanced rows are open. */
  advancedOpen: boolean;
  /** The sub-tab shown last: 0 Clip, 1 Results, 2 Settings. */
  page: number;
  /** Seconds of work per second of media of the last Precise export on this machine (the time estimate); null before one. */
  preciseSpeed: number | null;
}

/** The pages of the tab, as its sub-tab strip orders them. */
export const PAGES = ["clip", "results", "settings"] as const;
export type Page = (typeof PAGES)[number];

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
    method: METHODS.includes(s.method as Method) ? (s.method as Method) : "fast",
    encode: encodeOf(s.encode),
    template: normalTemplate(s.template),
    lastSeconds: lastSeconds(s.lastSeconds),
    advancedOpen: flag(s.advancedOpen, false),
    page: Number.isInteger(s.page) ? inRange(s.page, 0, PAGES.length - 1, 0) : 0,
    preciseSpeed: s.preciseSpeed === null || s.preciseSpeed === undefined ? null : inRange(s.preciseSpeed, 0.01, 1000, 0) || null,
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
