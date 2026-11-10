import type { ExportOptions, ExportPart, JobState, PartsExportOptions, Plugin, Text } from "@vestra-player/sdk";
import { exportEncoding } from "./clip.ts";
import type { Encode, Method } from "./clip.ts";

/**
 * The host features of the Snapshots & Clips design (player §7), in one
 * place: each is a small function over the public API that answers it.
 *
 * | Request | API (SDK) | Here |
 * | --- | --- | --- |
 * | R1 stream copy | `format: "copy"` (1.6.10) | `clipExport` (Fast) |
 * | R2 actual range | `outcome.start` / `outcome.end` (1.6.10) | `actualRange` |
 * | R3 range marks | `TimelineLayer.setRanges` (1.6.9) | `rangeMarker` |
 * | R4 progress | `JobState.progress` (1.6.10) | `jobProgress` |
 * | R5 OSD actions | `osd.show(…, { actions })` (1.6.9) | `showDone` |
 * | R6 encode options | `ExportEncoding` (1.6.10) | `clipExport` (Precise), `clip.ts` `exportEncoding` |
 * | R7 A-B points | none yet | `clip.ts` `abRange` (needs the loop switched on) |
 * | Collection: remembered files, merged exports, the check | `media.sources`, `media.export` with `parts`, `media.exportCheck` (1.7.8) | `collection.ts`, `partsExport` |
 *
 * R1–R6 and the Collection need player 0.7.6, which `minPlayerVersion`
 * requires, so the plugin uses them without asking (the SDK says not to probe
 * by trying).
 */
export interface HostSupport {
  /** R1 (with R2): `Snapshot.export` can copy streams. */
  fastCut: boolean;
  /** R2: a finished clip reports the times its file starts and ends. */
  actualRange: boolean;
  /** R3: the timeline takes ranges. */
  rangeMarks: boolean;
  /** R4: a running clip reports its progress. */
  progress: boolean;
  /** R5: `osd.show` takes buttons. */
  osdActions: boolean;
  /** R6: a Precise export takes encode options. */
  encodeOptions: boolean;
}

/** What the player offers: everything, from player 0.7.6 on. Tests may turn parts off (`activate(plugin, { support })`). */
export function hostSupport(_plugin: Plugin, overrides: Partial<HostSupport> = {}): HostSupport {
  return { fastCut: true, actualRange: true, rangeMarks: true, progress: true, osdActions: true, encodeOptions: true, ...overrides };
}

/**
 * The export options of a clip. Fast: a stream copy from the keyframe at or
 * before the snapshot time; the player picks MP4 or MKV and gives the file
 * that extension. Precise: a re-encode with the tab's encoder settings
 * (`encode`; without them, the player's default H.264 + AAC settings).
 */
export function clipExport(destination: string, end: number, method: Method, encode: Encode | undefined): ExportOptions {
  if (method === "fast") return { format: "copy", destination, end, container: "auto" };
  return encode ? { format: "mp4", destination, end, encoding: exportEncoding(encode) } : { format: "mp4", destination, end };
}

/**
 * The export options of a merged export of the Collection (SDK 1.7.8
 * `plugin.media.export` with `parts`): Fast copies every part (the player
 * picks MP4 or MKV), Precise re-encodes them to the first part's size and
 * frame rate with the tab's encoder settings.
 */
export function partsExport(parts: ExportPart[], destination: string, method: Method, encode: Encode | undefined): PartsExportOptions {
  const copy = parts.map(({ source, start, end }) => ({ source, start, end }));
  if (method === "fast") return { parts: copy, destination, format: "copy", container: "auto" };
  return encode ? { parts: copy, destination, format: "mp4", encoding: exportEncoding(encode) } : { parts: copy, destination, format: "mp4" };
}

/** A running export's progress: seconds written of all, and for a merged export the part being written (from 1) of how many (0 for a clip). */
export interface Progress {
  done: number;
  total: number;
  part: number;
  parts: number;
}

/** The times the finished file holds (R2): the player's `outcome.start` / `end`, the range asked for when it gives none. */
export function actualRange(state: JobState, asked: { start: number; end: number }): { start: number; end: number } {
  const outcome = state.outcome && "destination" in state.outcome ? state.outcome : null;
  const start = outcome?.start;
  const end = outcome?.end;
  return typeof start === "number" && typeof end === "number" && Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : asked;
}

/** A running clip's progress in seconds of the clip (R4); `null` while unknown (before writing starts). */
export function jobProgress(state: JobState): Progress | null {
  const progress = state.progress;
  if (!(progress && Number.isFinite(progress.done) && Number.isFinite(progress.total) && progress.total > 0)) return null;
  const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0);
  const parts = count(progress.parts);
  return { done: Math.min(progress.done, progress.total), total: progress.total, part: parts ? Math.min(count(progress.part), parts) : 0, parts };
}

/** A button of a finished export's message (R5): a label and one of the plugin's own commands. */
export interface OsdAction {
  /** Translated by the player like the text: a `plugin.i18n.text` value, so that extract finds it. */
  title: Text;
  command: "clip.revealLast" | "clip.tasks" | "clip.collectionUndo";
}
/**
 * Show a finished export's message with its buttons (at most two). The
 * buttons run commands that act on the newest result, so every action is
 * also in the tab and the command palette.
 */
export function showDone(plugin: Plugin, args: (string | number)[], actions: OsdAction[]) {
  // A refusal is logged: a "saved" message that does not show is otherwise invisible.
  void plugin.osd.show("Clip exported as {}", args, { actions: actions.slice(0, 2) }).catch((error: Error) => console.error(`[clipexport] osd: ${error.message}`));
}

/**
 * The clip's range on the seek bar while the tab shows (R3), as a
 * `selection` range of this plugin's timeline layer; `null` removes it. The
 * same range is not sent twice; a new source clears the layer by itself.
 */
export function rangeMarker(plugin: Plugin, title: Text) {
  let layer: ReturnType<Plugin["timeline"]["layer"]> | null = null;
  let last = "none";
  return {
    set(range: { start: number; end: number } | null) {
      // Clearing reads no player state: it also runs when the tab goes to the background.
      if (!range) {
        if (layer && last !== "none") layer.setRanges([]);
        last = "none";
        return;
      }
      const state = plugin.player.state;
      const duration = state.duration ?? Infinity;
      const ranges = range.start < Math.min(range.end, duration)
        ? [{ start: Math.max(0, range.start), end: Math.min(range.end, duration), style: "selection" as const, title }]
        : [];
      const key = JSON.stringify([state.sourceId, ranges.map((r) => [r.start, r.end])]);
      if (key === last || (!layer && !ranges.length)) return;
      last = key;
      layer ??= plugin.timeline.layer();
      layer.setRanges(ranges, { ifCurrent: state });
    },
  };
}
