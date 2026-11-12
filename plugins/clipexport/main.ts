import { access, constants, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CommandOptions, ExportCheck, ExportPart, ImageRef, Panel, PanelState, Plugin, PlayerState, Text } from "@vestra-player/sdk";
import {
  abRange, animatedOf, AUDIO_RATES, codecArgs, crfOf, defaultRange, effectiveMethod, estimate, exportEncoding, fastContainer, HEIGHTS, keyframeArgs, LAST_SECONDS, lastRange, lastSeconds,
  METHODS, NO_TIMELINE, parseCodec, parseKeyframes, PRESET_ENCODE, presetOf, PRESETS, RATES, snapStart, SPEEDS, timeline, timelineWindow,
} from "./clip.ts";
import type { Animated, Encode, Method } from "./clip.ts";
import { encoderProbe, extensionOf, MAX_ANIMATED_SECONDS } from "./animated.ts";
import { blockingNote, Collection, copyNote, exportParts, lengthClock, listKey, partStates, partTicks, retryDelay, targetNote, totalLength, UNDO_MS } from "./collection.ts";
import type { Part } from "./collection.ts";
import { finisher, inflightStore, sweepWork } from "./finish.ts";
import { capturer } from "./form.ts";
import { anyTransition, capOf, CUT, DIRECTIONS, FIRST_DURATION, junctionTicks, KINDS, mergeEncode, PRESET_DURATIONS, sourceBitrate, timing, typedDuration } from "./transitions.ts";
import type { Direction, Kind, Plan, Transition } from "./transitions.ts";
import { audioChoices, clippable, clock, Failure, isLocal, message, notClippable, parseRange, parseTime, problemOf, REASON, tabMode, withExtension } from "./model.ts";
import type { Problem, Reason, Spec } from "./model.ts";
import { COLLECTION_TEMPLATE, DEFAULT_TEMPLATE, insertVariable, normalTemplate, renderName } from "./names.ts";
import { makeThumb, PART_THUMB, Results, scaleThumb, sizeOf } from "./results.ts";
import type { Saved } from "./results.ts";
import { hostSupport, rangeMarker, showDone } from "./seams.ts";
import type { HostSupport, OsdAction } from "./seams.ts";
import { openSettings, PAGES } from "./settings.ts";
import type { Page } from "./settings.ts";
import { Tasks, terminal, timeLeft } from "./tasks.ts";
import type { Task } from "./tasks.ts";

/**
 * An OSD line is at most 200 characters as shown: a path argument leaves room
 * for the words of the template (in any language) and falls back to the file
 * name when long; other arguments are cut.
 */
const ROOM = 160;
const fit = (path: string) => (path.length <= ROOM ? path : basename(path).slice(0, ROOM));
const cut = (text: string) => text.slice(0, ROOM);

/** A status line of the tab, as data; ui/parts.slint `Words.status` puts it into words. */
type Status = Problem<string> & { kind: string; name: string };
const status = (kind = "", fields: Partial<Status> = {}): Status => ({ kind, reason: "", raw: "", name: "", ...fields });
const errorStatus = (error: unknown): Status => status("error", problemOf(error));

/** The titles of the commands, by id. Export Clip… is the menu item (Video ▸); the rest are in the command palette. */
const TITLE = {
  "clip.open": "Export Clip…",
  "clip.panel": "Clip Export Tab",
  "clip.export": "Export Clip Range",
  "clip.start": "Set Clip Start",
  "clip.end": "Set Clip End",
  "clip.tasks": "Export Tasks…",
  "clip.settings": "Clip Export Settings…",
  "clip.folder": "Clip Folder…",
  "clip.openFolder": "Open Clip Folder",
  "clip.revealLast": "Show Last Clip in Folder",
  "clip.collectionAdd": "Add Range to Collection",
  "clip.collection": "Show Collection",
  "clip.collectionExport": "Export Collection",
  "clip.collectionClear": "Clear Collection",
  "clip.collectionUndo": "Undo Clear Collection",
  "clip.collectionRemove": "Remove from Collection",
  "clip.collectionUndoApply": "Undo Apply to All",
} as const;
type CommandId = keyof typeof TITLE;

/** What stops a merged export, said on screen when a key asked for it (the tab says the same with `Words.blocking`). */
const BLOCKING = {
  missing: "Part {} is missing: locate it or remove it",
  changed: "Part {} has changed: locate it or remove it",
  unknown: "Part {} is no longer known: remove it",
  noVideo: "Part {} has no video: remove it",
  range: "Part {} is outside its file: remove it",
} as const;

/**
 * A refusal of `plugin.media.sources` or of a check as one of the plugin's
 * reasons; `unsupported` means what the call was about (a stream to add, a
 * file the player cannot read).
 */
function sourceError(error: unknown, unsupported: Reason = "addLocal") {
  const code = (error as { code?: string }).code;
  const reason: Partial<Record<string, Reason>> = {
    unsupported, stale: "changed", busy: "busy", limit: "tooManyFiles", unavailable: "unavailable", capability: "noCapability",
    "source-missing": "partMissing", "source-changed": "partChanged", missing: "partUnknown",
  };
  const known = code ? reason[code] : undefined;
  if (known) return new Failure(known);
  return error;
}

/** What a field typed in the tab holds (the tab owns the text while it shows; the plugin keeps a copy). */
interface Form {
  start: string;
  end: string;
  /** The range the plugin itself last filled in (Export Clip…, Last N s): a range still equal to it was not typed by the user. */
  autoStart: string;
  autoEnd: string;
  audioIndex: number;
  processed: boolean;
  burn: boolean;
  /** The source the marks were set on (`PlayerState.sourceId`); 0 before any. */
  sourceId: number;
}

export interface Options {
  /** Pretend the player offers less than it does (tests of the tab's views; seams.ts). */
  support: Partial<HostSupport>;
  /** The free space beside a file, in bytes (tests; the system's otherwise). */
  freeSpace: (folder: string) => Promise<number>;
}

/** The frame rate a clip's intermediate MP4 is planned with (the animated presets' ceiling); the image has its own (animated.ts). */
const ANIMATED_FPS = 30;

/** Megabytes as a number for the tab ("8.1", "71"); the tab adds the unit in the user's language. "" when unknown. */
const mb = (bytes: number) => (bytes <= 0 ? "" : bytes < 10e6 ? (bytes / 1e6).toFixed(1) : String(Math.round(bytes / 1e6)));
const minutesSince = (time: number) => Math.max(0, Math.floor((Date.now() - time) / 60_000));
const elapsed = (from: number | undefined) => {
  const seconds = from ? Math.max(0, Math.floor((Date.now() - from) / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * Clip Export: one sidebar tab with Clip, Results and Settings pages. Fast
 * (stream copy) and Precise (re-encoded MP4) exports of a range of the local
 * video playing, Last N s, the running tasks and the finished clips. Every
 * text is English source text (locales/ has the translations); the tab gets
 * data and says it in its Slint files.
 */
export default async function activate(plugin: Plugin, options: Partial<Options> = {}) {
  const { player, osd } = plugin;
  const { text } = plugin.i18n;
  const support = hostSupport(plugin, options.support);
  const { settings, save: store } = openSettings(plugin);
  const results = new Results(plugin);
  let thumbFolder: string | null = null;
  try {
    thumbFolder = join(plugin.dataDirectory, "thumbs");
  } catch {
    // no data directory: rows show their icon only
  }
  /**
   * `picker`: the part whose junction's picker is open ("" closed); `pickerSerial`: counts the opens (the tab shows the
   * popup on a new one, so the popup only ever shows a picker the plugin opened); `switched`: a transition picked in
   * Fast switched the method to Precise (the footer says so until the user picks a method); `listFocus`: counts
   * Show Collection (the tab focuses the list and scrolls it into view).
   */
  const ui = { clipBusy: false, clipStatus: status(), resultsStatus: status(), adding: false, collectionBusy: false, picker: "", pickerSerial: 0, switched: false, listFocus: 0 };
  const collection = new Collection(plugin);
  let partFolder: string | null = null;
  try {
    partFolder = join(plugin.dataDirectory, "parts");
  } catch {
    // no data directory: parts show their icon only
  }
  const form: Form = { start: "", end: "", autoStart: "", autoEnd: "", audioIndex: 1, processed: false, burn: false, sourceId: 0 };
  /** Finished clips since the Results page was last on screen: the badge on its sub-tab. */
  let unseen = 0;
  // Headless hosts refuse the display; that never fails the action itself.
  const shown = (showing: Promise<void>) => void showing.catch(() => {});
  /** A reason on its own, or the player's or system's own message as it is. */
  function sayProblem({ reason, raw }: Problem) {
    if (reason) return shown(osd.show(REASON[reason]));
    // i18n-ignore: the player's or system's own message
    shown(osd.show(raw.slice(0, 200)));
  }
  /** "Export failed: …" with the reason, or the player's or system's own message. */
  const sayFailed = ({ reason, raw }: Problem) => shown(osd.show("Export failed: {}", [reason ? text(REASON[reason]) : cut(raw)]));
  // A failure while reporting a finished task goes to the log (it would otherwise be lost: no message, no result row).
  const tasks = new Tasks(plugin, (task) => void finished(task).catch((error) => console.error(`[clipexport] finishing task ${task.id}: ${message(error)}`)));
  // A merged export with transitions: the player's merge goes into the work folder, the plugin's ffmpeg writes the file.
  let workFolder: string | null = null;
  try {
    workFolder = join(plugin.dataDirectory, "work");
  } catch {
    // no data directory: merged exports join with cuts
  }
  // Half files beside the user's videos are recorded while they are written; what a crash left goes now, before any task runs.
  const inflight = inflightStore(plugin);
  const swept = workFolder ? sweepWork(workFolder, inflight).catch((error) => console.error(`[clipexport] work folder: ${message(error)}`)) : Promise.resolve();
  const exporter = capturer(plugin, tasks, workFolder ? finisher(plugin, workFolder, { inflight, ...(options.freeSpace ? { freeSpace: options.freeSpace } : {}) }) : undefined);
  const marker = rangeMarker(plugin, text("Clip"));
  /** The encoder of an animated image in the player's ffmpeg (asked once). */
  const findEncoder = encoderProbe(plugin);
  let sequence = 0;
  const nextNumber = () => ++sequence;

  // ---------------------------------------------------------------- results
  const thumbs = new Map<string, ImageRef>();
  const thumbOf = (item: Saved) => {
    if (!item.thumb || !thumbFolder) return null;
    let ref = thumbs.get(item.id);
    if (!ref) thumbs.set(item.id, (ref = plugin.ui.image(join(thumbFolder, item.thumb), { maxSide: 128 })));
    return ref;
  };
  const dropThumb = (item: Saved) => {
    thumbs.delete(item.id);
    if (item.thumb && thumbFolder) void rm(join(thumbFolder, item.thumb), { force: true });
  };
  async function thumbnail(item: Saved) {
    const name = await makeThumb(plugin, thumbFolder, item);
    if (!name || !results.find(item.id)) return;
    results.update(item, { thumb: name });
    // Past ffmpeg's await: the row's picture changed outside SDK-invoked code.
    plugin.update();
  }
  void results.check().then((changed) => changed && plugin.update());

  /** A task reached its end: a finished one becomes a result (kept across restarts); report it on screen and in the tab. */
  async function finished(task: Task) {
    // A clip reports on the Clip page's status line; a merged export on screen only (a part's file that went or changed shows on its row).
    const setStatus = (next: Status) => void (task.parts || (ui.clipStatus = next));
    if (task.parts && task.status === "failed") void recheck();
    if (task.status === "completed") {
      const path = task.output ?? task.destination;
      const actual = task.actual ?? { start: task.spec.start, end: task.spec.end };
      if (task.spec.method !== "fast" && task.started && task.ended && actual.end > actual.start)
        settings.preciseSpeed = Math.max(0.01, (task.ended - task.started) / 1000 / (actual.end - actual.start));
      store();
      // R2: the row states the range the file holds (a Fast cut's keyframe start).
      const { saved, dropped } = results.add({
        path, method: task.spec.method, bytes: await sizeOf(path), start: actual.start, end: actual.end, finished: task.ended ?? Date.now(), thumb: "",
      });
      dropped.forEach(dropThumb);
      // The Results sub-tab counts what finished while it was not in front (its badge).
      if (!(tabShown() && settings.page === "results")) unseen++;
      // R5: the buttons run commands that act on the newest result, which this now is.
      const actions: OsdAction[] = [
        { title: text("Show in Folder"), command: "clip.revealLast" },
        { title: text("Show in Tab"), command: "clip.tasks" },
      ];
      showDone(plugin, [fit(path)], actions);
      setStatus(status("exported", { name: basename(path) }));
      await tasks.forget(task);
      plugin.update();
      void thumbnail(saved);
    } else if (task.status === "failed") {
      const problem = task.error ?? { reason: "", raw: "" };
      sayFailed(problem);
      setStatus(status("clip-failed", problem));
    }
  }

  /** The Results rows: tasks still running, queued, failed or cancelled first (newest first), then the finished clips. */
  function resultRows() {
    const taskRows = tasks.list
      .filter((task) => task.status !== "completed")
      .reverse()
      .map((task) => {
        const { spec } = task;
        const { reason, raw } = task.error ?? { reason: "", raw: "" };
        const share = task.progress && task.progress.total > 0 ? task.progress.done / task.progress.total : null;
        return {
          id: `t${task.id}`,
          name: basename(task.destination),
          state: task.status,
          reason,
          raw,
          method: spec.method,
          size: "",
          // A number for the tab (its words add "s").
          badge: (spec.end - spec.start).toFixed(1),
          ago: -1,
          percent: share === null ? -1 : Math.round(share * 100),
          left: timeLeft(task),
          elapsed: elapsed(task.started),
          range: `${clock(spec.start)}–${clock(spec.end)}`,
          thumb: null,
          cancellable: !terminal(task),
          retryable: terminal(task),
          openable: false,
          revealable: false,
        };
      });
    const savedRows = results.list.map((item) => {
      const gone = results.gone.has(item.id);
      return {
        id: item.id,
        name: basename(item.path),
        state: gone ? "gone" : "completed",
        reason: "",
        raw: "",
        method: item.method,
        size: mb(item.bytes),
        badge: (item.end - item.start).toFixed(1),
        ago: minutesSince(item.finished),
        percent: -1,
        left: -1,
        elapsed: "",
        range: `${clock(item.start)}–${clock(item.end)}`,
        thumb: thumbOf(item),
        cancellable: false,
        retryable: false,
        openable: !gone,
        revealable: !gone,
      };
    });
    return [...taskRows, ...savedRows];
  }

  /** The progress card at the top of the Clip page: the running task and how many wait. */
  function card() {
    const task = tasks.running();
    if (!task) return { shown: false, id: "", name: "", method: "", preset: "", percent: -1, left: -1, elapsed: "", queued: 0, part: 0, parts: 0, transition: 0, transitions: 0, ticks: "" };
    const share = task.progress && task.progress.total > 0 ? task.progress.done / task.progress.total : null;
    const { spec } = task;
    return {
      // A merged export: which part is being written, and thin ticks at the joins.
      part: task.progress?.part ?? 0,
      parts: task.parts?.length ?? 0,
      // The plugin's step: which transition ffmpeg has reached.
      transition: task.progress?.transition ?? 0,
      transitions: task.progress?.transitions ?? 0,
      // The junctions where the output has them: with transitions, the overlaps already taken off.
      ticks: task.finish ? junctionTicks(task.finish.plan as Plan) : task.parts ? partTicks(task.parts.map((part) => part.end - part.start)) : "",
      shown: true,
      id: task.id,
      name: basename(task.destination),
      method: spec.method,
      preset: spec.method === "fast" ? "" : spec.encode ? presetOf(spec.encode) : "high",
      percent: share === null ? -1 : Math.round(share * 100),
      left: timeLeft(task),
      elapsed: elapsed(task.started),
      queued: tasks.queued(),
    };
  }

  // ---------------------------------------------------------------- folders
  /** The playing file's folder when "Save to the media folder" is on and the source is local; the clip folder otherwise. */
  const shownFolder = (source: string | null) => (settings.besideMedia && isLocal(source) ? dirname(source) : settings.folder);
  /** The folder clips go to now: falls back to the clip folder when the media folder cannot be written. */
  async function targetFolder(source: string | null) {
    const beside = settings.besideMedia && isLocal(source) ? dirname(source) : null;
    if (beside && (await access(beside, constants.W_OK).then(() => true, () => false))) return beside;
    await mkdir(settings.folder, { recursive: true }).catch(() => {
      throw new Failure("folderUnavailable");
    });
    return settings.folder;
  }
  type Flag = "besideMedia" | "advancedOpen";
  const setFlag = (field: Flag, value: boolean) => {
    if (settings[field] === value) return;
    settings[field] = value;
    store();
  };
  async function chooseFolder() {
    const chosen = await plugin.dialogs.openDirectory({ title: "Choose Clip Folder" });
    if (!chosen) return;
    if (!(await stat(chosen).catch(() => null))?.isDirectory()) return shown(osd.show("Please choose an existing folder."));
    settings.folder = chosen;
    store();
    shown(osd.show("Clip folder: {}", [fit(chosen)]));
  }
  /** The folder clips go to now, created when missing, opened in the file manager. */
  const openFolder = async () => {
    const folder = await targetFolder(player.state.source);
    await plugin.system.openPath(folder).catch(() => {
      throw new Failure("cannotOpen");
    });
  };

  // ---------------------------------------------------------------- clip
  /** What the tab knows of the source for a Fast cut: keyframes around the range, the video codec (ffprobe). */
  const probe = { source: "", from: 0, to: 0, keyframes: [] as number[], video: null as string | null, offset: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined, abort: null as AbortController | null };
  plugin.onDispose(() => {
    clearTimeout(probe.timer);
    probe.abort?.abort();
  });
  const method = (): Method => effectiveMethod(settings.method, support.fastCut);
  /** The range typed in the tab, or the reason it is none. */
  function typedRange(): { start: number; end: number } | { error: "time" | "endBeforeStart"; field: "start" | "end" } {
    const start = parseTime(form.start);
    const end = parseTime(form.end);
    if (start === null) return { error: "time", field: "start" };
    if (end === null) return { error: "time", field: "end" };
    if (end <= start) return { error: "endBeforeStart", field: "end" };
    return { start, end };
  }
  /** The audio track's codec (`AudioTrack.codec`), for the Fast container. */
  const audioCodec = (state: PlayerState) => {
    const value = audioChoices(state, text).values[form.audioIndex] ?? "none";
    if (value === "none") return null;
    const track = value === "selected" ? state.audioTracks?.find((t) => t.selected) : state.audioTracks?.find((t) => String(t.id) === value);
    return (track as { codec?: string } | undefined)?.codec ?? null;
  };
  /** Ask ffprobe for the keyframes around the range 200 ms after the typing stops (Fast only; no decoding). */
  function probeSoon() {
    clearTimeout(probe.timer);
    if (method() !== "fast") return;
    probe.timer = setTimeout(() => void probeNow(), 200);
    probe.timer.unref?.();
  }
  async function probeNow() {
    const state = player.state;
    const range = typedRange();
    if (!clippable(state) || "error" in range) return;
    const source = state.source!;
    const window = timelineWindow(range.start, range.end, state.duration);
    // Ten seconds more before the start: the keyframe a cut starts on can be that far back.
    const from = Math.max(0, window.from - 10);
    if (probe.source === source && probe.from <= from && probe.to >= window.to) return;
    probe.abort?.abort();
    const abort = (probe.abort = new AbortController());
    try {
      if (!(await plugin.tools.available("ffprobe"))) return;
      if (probe.source !== source) {
        Object.assign(probe, { video: null, offset: 0 });
        const codec = await plugin.tools.run("ffprobe", codecArgs(source), { timeoutMs: 5000, maxOutput: 4096, signal: abort.signal });
        Object.assign(probe, parseCodec(Buffer.from(codec.stdout).toString("utf8")));
      }
      // ffprobe reads container timestamps: the window moves by the file's start time, the keyframes come back by it.
      const result = await plugin.tools.run("ffprobe", keyframeArgs(source, from + probe.offset, window.to + probe.offset), { timeoutMs: 10_000, maxOutput: 4 << 20, signal: abort.signal });
      Object.assign(probe, { source, from, to: window.to, keyframes: parseKeyframes(Buffer.from(result.stdout).toString("utf8"), probe.offset) });
      // Past ffprobe's await: the note and the small timeline changed outside SDK-invoked code.
      plugin.update();
    } catch (error) {
      if (!abort.signal.aborted) console.error(`[clipexport] keyframes: ${message(error)}`);
    }
  }
  /** The Clip page's derived values: field errors, the note, the small timeline, the estimate, the file name. */
  function clipView(state: PlayerState) {
    const range = typedRange();
    const chosen = method();
    const empty = { error: "", field: "", note: { method: chosen, start: "", end: "", early: "", snapped: false, container: "" }, timeline: NO_TIMELINE, estimate: { length: "", size: "", timelow: 0, timehigh: 0 }, name: "", span: null as { start: number; end: number } | null };
    // Nothing typed yet: no complaint, the fields show their placeholders.
    if (!clippable(state) || (!form.start.trim() && !form.end.trim())) return empty;
    if ("error" in range) return { ...empty, error: range.error, field: range.field };
    const sameSource = probe.source === state.source;
    const keyframes = sameSource ? probe.keyframes : [];
    const snapped = chosen === "fast" ? snapStart(keyframes, range.start) : null;
    const start = snapped ?? range.start;
    const container = chosen === "fast" ? fastContainer(sameSource ? probe.video : null, audioCodec(state)) : "mp4";
    const length = range.end - start;
    const fileBytes = isLocal(state.source) ? fileSize(state.source) : null;
    const guess = estimate({ method: chosen, length, fileBytes, duration: state.duration, encode: settings.encode, secondsPerSecond: settings.preciseSpeed, height: null });
    const sizeText = guess.sizehigh <= 0 ? "" : guess.sizelow === guess.sizehigh ? `${guess.sizelow}` : `${Math.round(guess.sizelow)}–${Math.round(guess.sizehigh)}`;
    const extension = container === "mkv" ? ".mkv" : extensionOf(animatedNow(chosen));
    return {
      error: "",
      field: "",
      note: { method: chosen, start: clock(start), end: clock(range.end), early: snapped !== null && range.start - snapped >= 0.0005 ? (range.start - snapped).toFixed(1) : "", snapped: snapped !== null, container },
      timeline: timeline(range, { start, end: range.end }, chosen === "fast" ? keyframes : [], state.position, state.duration, snapped),
      estimate: { length: length.toFixed(1), size: sizeText, timelow: guess.timelow, timehigh: guess.timehigh },
      name: `${renderName(settings.template, { source: state.source, start, end: range.end, now: new Date(), n: sequence + 1 })}${extension}`,
      // What the file will hold: a Fast cut from its keyframe.
      span: { start, end: range.end },
    };
  }
  /** The playing file's size (the estimates), read once per source. */
  const sizes = new Map<string, number | null>();
  function fileSize(path: string) {
    if (!sizes.has(path)) {
      sizes.set(path, null);
      void stat(path).then(
        (info) => {
          sizes.set(path, info.size);
          plugin.update();
        },
        () => {},
      );
    }
    return sizes.get(path) ?? null;
  }

  /** Export a range: into the clip folder, or (`ask`) where the user picks. */
  async function exportRange(range: { start: number; end: number }, ask: boolean) {
    const seen = await player.refresh();
    if (!clippable(seen)) throw new Failure(notClippable(seen));
    const chosen = method();
    const precise = chosen === "precise";
    const animated = animatedNow(chosen);
    // An animated image: checked before the save dialog (its length, the encoder), written by the plugin's step.
    const plan = animated ? await animatedPlan(animated, [range.end - range.start], [CUT], ANIMATED_FPS, range.end - range.start) : undefined;
    const spec: Spec = {
      start: range.start, end: range.end,
      processed: precise && form.processed, subtitles: precise && form.processed && form.burn,
      // An animated image has no sound: the clip is read without it.
      track: animated ? "none" : (audioChoices(seen, text).values[form.audioIndex] ?? "none"),
      method: chosen,
      // R6: the tab's encoder settings.
      encode: precise && support.encodeOptions ? { ...settings.encode } : undefined,
    };
    const snapped = chosen === "fast" && probe.source === seen.source ? snapStart(probe.keyframes, range.start) : null;
    const container = chosen === "fast" ? fastContainer(probe.source === seen.source ? probe.video : null, audioCodec(seen)) : "mp4";
    const extension = container === "mkv" ? ".mkv" : extensionOf(animated);
    const name = `${renderName(settings.template, { source: seen.source, start: snapped ?? range.start, end: range.end, now: new Date(), n: nextNumber() })}${extension}`;
    let destination: string;
    if (ask) {
      const picked = await plugin.dialogs.saveFile({ title: "Export Clip", fileName: name });
      if (!picked) return void (ui.clipStatus = status("no-destination"));
      // The container follows the format (LosslessCut's rule): Precise writes MP4 whatever the typed extension said.
      destination = withExtension(picked, extension);
    } else destination = join(await targetFolder(seen.source), name);
    // What a crash left in the work folder is gone first.
    if (plan) await swept;
    await exporter.start(spec, seen, destination, undefined, plan);
    ui.clipStatus = status("clip-started");
  }
  /** The fields hold a range the user chose: not empty and not what the plugin last filled in. */
  const typedByUser = () =>
    !!(form.start.trim() || form.end.trim()) && !(form.start === form.autoStart && form.end === form.autoEnd);
  /** Export the typed range; `say`: a failure also goes on screen (a key, not the tab's button). */
  async function exportClip(start: string, end: string, ask: boolean, say = false) {
    if (ui.clipBusy) return;
    ui.clipBusy = true; // exclusion before the first await
    try {
      Object.assign(form, { start, end, sourceId: player.state.sourceId });
      await exportRange(parseRange(start, end), ask);
    } catch (error) {
      ui.clipStatus = errorStatus(error);
      if (say) sayFailed(problemOf(error));
    } finally {
      ui.clipBusy = false;
    }
  }
  /** "Last N s" (Ctrl+Shift+R): the seconds before the position, into the clip folder, with the tab's method. */
  async function exportLast() {
    if (ui.clipBusy) return;
    ui.clipBusy = true;
    try {
      const seen = await player.refresh();
      if (marksFor(seen)) panel.set({ clipStart: form.start, clipEnd: form.end });
      if (!clippable(seen)) throw new Failure(notClippable(seen));
      const range = lastRange(seen.position, settings.lastSeconds);
      // A range the user typed (or set with Now or A-B) stays; empty or filled in by the plugin, it shows what was exported.
      if (!typedByUser()) setRange(range, true);
      await exportRange(range, false);
      if (ui.clipStatus.kind === "clip-started") shown(osd.show("Exporting the last {} seconds", [settings.lastSeconds]));
    } catch (error) {
      ui.clipStatus = errorStatus(error);
      sayFailed(problemOf(error));
    } finally {
      ui.clipBusy = false;
    }
  }
  /**
   * Put a range into the tab's fields: the user's own (Now, A-B), or one the
   * plugin fills in (`automatic`: Export Clip… on an untouched range, Last N s),
   * which a later automatic fill may replace.
   */
  function setRange(range: { start?: number; end?: number }, automatic = false) {
    // The range is the source's playing now: a half of another file's range never stays beside it.
    marksFor(player.state);
    if (range.start !== undefined) form.start = clock(range.start);
    if (range.end !== undefined) form.end = clock(range.end);
    if (automatic) Object.assign(form, { autoStart: form.start, autoEnd: form.end });
    panel.set({ clipStart: form.start, clipEnd: form.end });
    rememberForm();
    probeSoon();
  }
  /**
   * Start and End belong to the file they were set on, as LosslessCut keeps
   * cut points per file (design §2: each file is marked on its own): another
   * source starts with none, the fields show their placeholders until the user
   * sets marks. True when marks of another source were cleared.
   */
  function marksFor(state: PlayerState) {
    if (form.sourceId === state.sourceId) return false;
    const stale = !!(form.start || form.end);
    Object.assign(form, { start: "", end: "", autoStart: "", autoEnd: "", sourceId: state.sourceId });
    if (stale) rememberForm();
    return stale;
  }
  const setMethod = (next: Method) => {
    if (!METHODS.includes(next) || settings.method === next) return;
    settings.method = next;
    store();
    probeSoon();
  };
  /** The animated image a Precise export writes now (the Quality chooser's GIF or WebP); null for an MP4 or a Fast cut. */
  const animatedNow = (chosen: Method): Animated | null => (chosen === "precise" && support.encodeOptions ? animatedOf(settings.encode) : null);
  /**
   * What the plugin's step needs for an animated image, checked before
   * anything starts: the written length (at most a minute, animated.ts), the
   * work folder, and an encoder in the player's ffmpeg.
   */
  async function animatedPlan(format: Animated, lengths: number[], transitions: Transition[], fps: number, written: number): Promise<Plan> {
    if (written > MAX_ANIMATED_SECONDS + 0.0005) throw new Failure("animatedTooLong");
    if (!workFolder) throw new Failure("animatedFailed");
    const encoder = await findEncoder(format);
    return { output: format, encoder, transitions, lengths, fps, audio: false, encode: { ...PRESET_ENCODE[format] }, merge: { ...PRESET_ENCODE[format] } };
  }
  const setEncode = (next: Encode) => {
    settings.encode = next;
    store();
    // The check's re-encode size follows the resolution and frame-rate ceilings.
    if (live) void recheck();
  };

  // ---------------------------------------------------------------- collection
  /** The last check of the list (`media.exportCheck`), and the list it answered for. */
  let check: ExportCheck | null = null;
  let checkKey = "";
  /** The check running now (one at a time), whether the list changed meanwhile, and the last check's refusal. */
  let flight: Promise<void> | null = null;
  let checkAgain = false;
  let checkError: unknown = null;
  /** `busy` answers in a row; the automatic retry backs off and stops after five (`retryDelay`). */
  let busyTries = 0;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  /** The row selected in the list (Delete removes it); cleared when another page shows. */
  let selected: string | null = null;
  /** The parts a Clear took away, while Undo can bring them back. */
  let undo: { parts: Part[]; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The tokens and thumbnails nothing uses were tidied this session (once, when the tab first shows). */
  let tidied = false;
  plugin.onDispose(() => {
    clearTimeout(checkTimer);
    if (undo) clearTimeout(undo.timer);
  });
  /**
   * One queue for everything that gets or lets go of a token: `remember` with
   * the part it makes, and each `forget`. `remember` gives the same token again
   * for the same file, so a forget decided before a new part of that file was
   * added would take the new part's file away: each forget looks at the parts
   * again inside the queue, right before it asks.
   */
  let sourceQueue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = sourceQueue.then(run, run);
    sourceQueue = next.catch(() => {});
    return next;
  }
  const encodingOption = () => (support.encodeOptions ? { encoding: exportEncoding(settings.encode) } : undefined);
  /** The check, when it answered for the list as it is now. */
  const freshCheck = () => (check && checkKey === listKey(exportParts(collection.parts)) ? check : null);
  /**
   * Check the list again (cheap: nothing is decoded): after every change, when
   * the tab shows, after Locate… and a failed merge, and before an export. One
   * check at a time; a change meanwhile asks again once it answered. `busy`
   * (the plugin's four requests) retries after 0.3, 0.6, 1.2, 2.4 and 4.8 s,
   * then stops until the next change.
   */
  function recheck(): Promise<void> {
    clearTimeout(checkTimer);
    if (!collection.parts.length) {
      check = null;
      checkKey = "";
      checkError = null;
      return Promise.resolve();
    }
    if (flight) {
      checkAgain = true;
      return flight;
    }
    flight = (async () => {
      try {
        do {
          checkAgain = false;
          const parts = exportParts(collection.parts);
          try {
            const answer = await plugin.media.exportCheck(parts, encodingOption());
            check = answer;
            checkKey = listKey(parts);
            checkError = null;
            busyTries = 0;
          } catch (error) {
            checkError = error;
            const delay = (error as { code?: string }).code === "busy" ? retryDelay(busyTries++) : null;
            if (delay !== null) {
              checkTimer = setTimeout(() => void recheck(), delay);
              checkTimer.unref?.();
            } else console.error(`[clipexport] collection check: ${message(error)}`);
            break;
          }
        } while (checkAgain);
      } finally {
        flight = null;
        // Past the check's await: the rows and the footer changed outside SDK-invoked code.
        plugin.update();
      }
    })();
    return flight;
  }
  /** A check of the list as it is now, through the same single check (an export waits for it). */
  async function currentCheck(): Promise<ExportCheck> {
    for (let i = 0; i < 2; i++) {
      await recheck();
      const fresh = freshCheck();
      if (fresh) return fresh;
      if (checkError) throw sourceError(checkError);
    }
    throw new Failure("busy");
  }
  /** Fast for the Collection: the user's choice when a copy can write the parts (or no check answered yet); Precise otherwise. */
  function collectionMethod(): Method {
    const fresh = freshCheck();
    return method() === "fast" && (!fresh || fresh.copy.ok) ? "fast" : "precise";
  }
  /** The parts of merged exports being started (a save dialog, a free name): not yet a task, already the export's. */
  const pendingParts = new Set<ExportPart[]>();
  /** Tokens still needed: the parts', those a Clear can bring back, those of merged exports (queued, running or to retry) and of exports being started. */
  function usedTokens() {
    const used = collection.tokens();
    for (const part of undo?.parts ?? []) used.add(part.token);
    for (const task of tasks.list) for (const part of task.parts ?? []) used.add(part.source);
    for (const parts of pendingParts) for (const part of parts) used.add(part.source);
    return used;
  }
  /** Let the player forget files no part names any more (each frees one of the plugin's 500 references), one at a time in the queue. */
  function forgetUnused(tokens: Iterable<string>) {
    return Promise.all(
      [...new Set(tokens)].map((token) =>
        serial(async () => {
          if (usedTokens().has(token)) return;
          await plugin.media.sources.forget(token).catch((error) => console.error(`[clipexport] forget: ${message(error)}`));
        }),
      ),
    );
  }
  /** Once a session, when the tab shows: tokens and thumbnails that a lost list or an ended session left behind go. */
  async function tidy() {
    if (tidied) return;
    tidied = true;
    try {
      const files = await serial(() => plugin.media.sources.list());
      await forgetUnused(files.map((file) => file.token));
    } catch (error) {
      console.error(`[clipexport] tidy references: ${message(error)}`);
    }
    if (!partFolder) return;
    const sweep = Date.now();
    for (const name of await readdir(partFolder).catch(() => [] as string[])) {
      const file = join(partFolder, name);
      // Written since the sweep began (a part added meanwhile): kept. A thumbnail is named after its part (`<part id>-…`).
      const info = await stat(file).catch(() => null);
      if (!info || info.mtimeMs >= sweep - 1000) continue;
      const kept = new Set([...collection.parts, ...(undo?.parts ?? [])].map((part) => part.id));
      if (!kept.has(name.split("-")[0]!)) await rm(file, { force: true }).catch(() => {});
    }
  }

  // Thumbnails: a frame captured at the part's start while its file plays (there is no thumbnail API), scaled down into the data directory.
  const partThumbs = new Map<string, ImageRef>();
  const partThumbOf = (part: Part) => {
    if (!part.thumb || !partFolder) return null;
    const key = `${part.id}/${part.thumb}`;
    let ref = partThumbs.get(key);
    if (!ref) partThumbs.set(key, (ref = plugin.ui.image(join(partFolder, part.thumb), { maxSide: 128 })));
    return ref;
  };
  const dropPartThumb = (part: Part) => {
    for (const key of partThumbs.keys()) if (key.startsWith(`${part.id}/`)) partThumbs.delete(key);
    if (part.thumb && partFolder) void rm(join(partFolder, part.thumb), { force: true }).catch(() => {});
  };
  /**
   * Capture the part's first frame from the file playing (`seen`) as a full
   * frame, then scale it with ffmpeg (the Results thumbnails' path) to twice
   * the row's size; the full frame is deleted. Without ffmpeg, or on a
   * failure, the row keeps its icon.
   */
  async function partThumbnail(part: Part, seen: PlayerState) {
    if (!partFolder || !(await plugin.tools.available("ffmpeg").catch(() => false))) return;
    let snapshot: Awaited<ReturnType<typeof plugin.media.capture>> | undefined;
    // The frame as asked for, and as the player wrote it (its outcome); only files in the plugin's own folder are deleted.
    let asked = "";
    let frame = "";
    try {
      snapshot = await plugin.media.capture({ ifCurrent: seen, at: part.start });
      await mkdir(partFolder, { recursive: true });
      // A new name each time: an export never overwrites a file.
      const stamp = Date.now();
      frame = asked = join(partFolder, `${part.id}-${stamp}.frame.jpg`);
      const end = await (await snapshot.export({ format: "jpeg", destination: asked, quality: 90 })).done;
      if (end.status !== "completed") return;
      if (end.outcome && "destination" in end.outcome) frame = end.outcome.destination;
      const name = await scaleThumb(plugin, frame, join(partFolder, `${part.id}-${stamp}.jpg`), PART_THUMB);
      if (!name) return;
      if (!collection.find(part.id)) return void rm(join(partFolder, name), { force: true }).catch(() => {});
      collection.update(part, { thumb: name });
      // Past the export's await: the row's picture changed outside SDK-invoked code.
      plugin.update();
    } catch (error) {
      console.error(`[clipexport] part thumbnail: ${message(error)}`);
    } finally {
      for (const file of new Set([asked, frame])) if (file && dirname(file) === partFolder) void rm(file, { force: true }).catch(() => {});
      await snapshot?.dispose().catch(() => {});
    }
  }

  /** The video bit rate of the part's source (it is playing: `source` is its path), for a "Same as source" export with transitions. */
  async function partBitrate(part: Part, source: string | null) {
    if (!source || !(await plugin.tools.available("ffprobe").catch(() => false))) return;
    try {
      const { stdout } = await plugin.tools.run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=bit_rate:format=bit_rate", "-of", "default=nw=1", source], { timeoutMs: 15_000, maxOutput: 4096 });
      const values = [...new TextDecoder().decode(stdout).matchAll(/bit_rate=(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0);
      if (values[0] && collection.find(part.id)) collection.update(part, { bitrate: values[0] });
    } catch (error) {
      console.error(`[clipexport] part bit rate: ${message(error)}`);
    }
  }
  /** Add the marked range (the Clip page's Start and End) of the file playing as the last part. `say`: from a key, success on screen too. */
  async function addPart(say = false, typed?: { start: string; end: string }) {
    if (ui.adding) return;
    ui.adding = true; // exclusion before the first await
    try {
      const seen = await player.refresh();
      // Pressed in the tab: the times it shows are this file's. From a key: marks of another file are not this file's range.
      if (typed) Object.assign(form, { ...typed, sourceId: seen.sourceId });
      else if (marksFor(seen)) panel.set({ clipStart: form.start, clipEnd: form.end });
      if (!clippable(seen)) throw new Failure(tabMode(seen) === "local" ? "needDuration" : "addLocal");
      const range = parseRange(form.start, form.end);
      if (range.end > seen.duration! + 0.0005) throw new Failure("outOfRange");
      if (collection.full()) throw new Failure("collectionFull");
      // In the token queue: no forget can come between the token and the part that uses it.
      const part = await serial(async () => {
        const file = await plugin.media.sources.remember({ ifCurrent: seen }).catch((error) => {
          throw sourceError(error);
        });
        // The player's own name: the file as the token stands for it.
        // The part before it joins it with the default for new parts: Cut, until Apply to All sets another (Q3 a).
        return collection.add({ token: file.token, name: file.name, start: range.start, end: Math.min(range.end, file.duration || range.end) }, settings.newTransition);
      });
      if (say) shown(osd.show("Added as part {}", [collection.parts.length]));
      plugin.update();
      void recheck();
      void partThumbnail(part, seen);
      void partBitrate(part, seen.source);
    } catch (error) {
      // The Collection has no status line (its red line is for what blocks the export): the message says it.
      sayProblem(problemOf(error));
    } finally {
      ui.adding = false;
    }
  }
  function removePart(id: string) {
    const part = collection.remove(id);
    if (!part) return;
    if (selected === id) selected = null;
    if (!collection.parts.length) ui.switched = false;
    dropPartThumb(part);
    void forgetUnused([part.token]);
    void recheck();
  }
  /** The Clip page, with the Collection, is the one on screen (Delete acts on its selection only then). */
  const collectionShown = () => tabShown() && settings.page === "clip";
  /** Delete (while the list has the focus): the selected part. */
  const removeSelected = () => selected && collectionShown() && removePart(selected);
  /** Clear Collection: empty at once, with Undo on the message for a while (no confirmation dialog). */
  function clearCollection() {
    if (!collection.parts.length) return;
    expireUndo();
    ui.switched = false;
    const parts = collection.clear();
    const timer = setTimeout(expireUndo, UNDO_MS);
    timer.unref?.();
    undo = { parts, timer };
    selected = null;
    void recheck();
    void osd.show("Collection cleared.", [], { actions: [{ title: text("Undo"), command: "clip.collectionUndo" }] }).catch(() => {});
  }
  /** Undo is no longer offered: the cleared parts' thumbnails and files go. */
  function expireUndo() {
    if (!undo) return;
    clearTimeout(undo.timer);
    const { parts } = undo;
    undo = null;
    parts.forEach(dropPartThumb);
    void forgetUnused(parts.map((part) => part.token));
    plugin.update();
  }
  /** Undo Clear: the parts come back before those added since; refused (Undo stays offered) when they would not fit. */
  function undoClear() {
    if (!undo) return;
    if (!collection.restore(undo.parts)) return sayProblem({ reason: "undoFull", raw: "" });
    clearTimeout(undo.timer);
    undo = null;
    void recheck();
  }
  /** Locate…: the player's own file dialog; the file the user picks stands for the part's file from then on. */
  async function locatePart(id: string) {
    const part = collection.find(id);
    if (!part) return;
    const found = await plugin.media.sources.locate(part.token).catch((error) => {
      throw sourceError(error, "cannotRead");
    });
    if (!found) return;
    collection.rename(part.token, found.name);
    await recheck();
  }
  /** Double-click: play the part's file from the part's start, and mark the part as Start and End. */
  async function previewPart(id: string) {
    const part = collection.find(id);
    if (!part) return;
    selected = id;
    try {
      await plugin.media.sources.open(part.token, { start: part.start });
    } catch (error) {
      void recheck();
      throw sourceError(error, "cannotRead");
    }
    // The part's file is the source now: its marks are the part (read the new source first, so they are not cleared as stale).
    await player.refresh();
    setRange({ start: part.start, end: part.end });
  }
  /** Export Merged (the clip folder, named by the Collection template) or Export As… (a save dialog). */
  async function exportCollection(ask: boolean, say = false) {
    if (ui.collectionBusy) return;
    ui.collectionBusy = true; // exclusion before the first await
    let input: ExportPart[] | null = null;
    try {
      if (!collection.parts.length) throw new Failure("emptyCollection");
      if (tasks.full()) throw new Failure("queueFull");
      const answer = await currentCheck();
      // The export works on the list it checked; later edits apply to the next one.
      const parts = collection.parts.map((part) => ({ ...part }));
      // Its files are the export's from here on (no await before): a part removed during the save dialog keeps its token.
      input = exportParts(parts);
      pendingParts.add(input);
      const first = answer.blocking[0];
      // The red line under the buttons says it (from the same check); a key says it on screen.
      if (first) return void (say && shown(osd.show(BLOCKING[first.problem], [first.part + 1])));
      const chosen: Method = method() === "fast" && answer.copy.ok ? "fast" : "precise";
      const animated = animatedNow(chosen);
      const transitions = parts.map((part) => part.transition);
      const lengths = parts.map((part) => part.end - part.start);
      // An animated image: its written length (the overlaps taken off) and the encoder are checked before the save dialog.
      const fps = answer.encode?.fps ?? ANIMATED_FPS;
      const animatedStep = animated ? await animatedPlan(animated, lengths, transitions, fps, timing(lengths, transitions, fps).written / fps) : undefined;
      // The container follows the format: a re-encode is MP4 (or the animated image), a copy what the check says the player writes.
      const extension = chosen === "fast" && answer.copy.ok ? `.${answer.copy.container}` : extensionOf(animated);
      const head = parts[0]!;
      const name = `${renderName(settings.collectionTemplate, { source: head.name, start: head.start, end: parts.at(-1)!.end, now: new Date(), n: nextNumber() }, COLLECTION_TEMPLATE)}${extension}`;
      let destination: string;
      if (ask) {
        const picked = await plugin.dialogs.saveFile({ title: "Export Collection", fileName: name });
        if (!picked) return;
        destination = withExtension(picked, extension);
      } else destination = join(await targetFolder(null), name);
      const spec: Spec = {
        start: 0, end: totalLength(parts), processed: false, subtitles: false, track: "selected", method: chosen,
        encode: chosen === "precise" && support.encodeOptions ? { ...settings.encode } : undefined,
      };
      // Precise with a transition: the plain merge, then the plugin writes the transitions (Fast joins with cuts, Q2 a).
      // An animated image: the plain merge, then the plugin writes the image (with the transitions, if any).
      const plan: Plan | undefined = animatedStep ?? (chosen === "precise" && workFolder && anyTransition(transitions) && answer.encode
        ? {
          transitions, lengths, fps: answer.encode.fps, audio: !!answer.encode.audio,
          encode: settings.encode, merge: mergeEncode(settings.encode),
          bitrate: settings.encode.rate === "source" ? sourceBitrate(parts) : null,
        }
        : undefined);
      // "Same as source" with transitions aims at the parts' own bit rate: unknown, it asks for another quality.
      if (plan && plan.encode.rate === "source" && !plan.bitrate) throw new Failure("noSourceBitrate");
      // What a crash left in the work folder is gone first.
      await swept;
      await exporter.startParts(spec, input, destination, plan);
    } catch (error) {
      sayFailed(problemOf(error));
    } finally {
      ui.collectionBusy = false;
      // The task holds the tokens now, or the export did not start: either way the pending hold ends.
      if (input) {
        pendingParts.delete(input);
        if (!tasks.list.some((task) => task.parts && listKey(task.parts) === listKey(input!))) void forgetUnused(input.map((part) => part.source));
      }
    }
  }
  /** The Collection's rows: number, file, range, length, thumbnail, the state of its file. */
  function partRows() {
    const states = partStates(freshCheck(), collection.parts.length);
    // Fast joins with cuts: the transitions are kept, greyed and struck (Q2 a).
    const fastNow = collectionMethod() === "fast";
    const playing = lastSource ? basename(lastSource) : null;
    return collection.parts.map((part, index) => ({
      id: part.id,
      number: index + 1,
      name: part.name,
      range: `${clock(part.start)} – ${clock(part.end)}`,
      badge: (part.end - part.start).toFixed(1),
      thumb: partThumbOf(part),
      current: playing !== null && part.name === playing,
      state: states[index]!,
      selected: part.id === selected,
      // The junction below the part: its transition into the next one (none below the last part).
      join: index < collection.parts.length - 1,
      kind: part.transition.kind,
      dir: part.transition.dir,
      duration: part.transition.duration.toFixed(1),
      // Fast joins with cuts: a transition is kept, greyed and struck (a Cut has nothing to strike); its chip still opens the picker.
      off: fastNow && part.transition.kind !== "cut",
    }));
  }
  /** The footer's sum: the written length (overlaps taken off, unless Fast joins with cuts) and the transitions. */
  function collectionInfo(checked: boolean) {
    const fastNow = collectionMethod() === "fast";
    const junctions = collection.parts.slice(0, -1).filter((part) => part.transition.kind !== "cut");
    // "Switched to Precise" stays only while it explains something: a transition is set and the method is still the
    // Precise it switched to. Once every junction is a Cut again (picked, Undo of Apply to All, removed, cleared) or
    // the method is Fast, the note is done and does not come back by itself.
    if (ui.switched && (fastNow || junctions.length === 0)) ui.switched = false;
    // What the export takes off: each overlap on whole frames, held to half the shorter part, at the merge's frame rate.
    const fps = freshCheck()?.encode?.fps ?? 30;
    const t = timing(collection.parts.map((part) => part.end - part.start), collection.parts.map((part) => part.transition), fps);
    const saved = t.overlaps.reduce((sum, frames) => sum + frames, 0) / fps;
    const length = totalLength(collection.parts) - (fastNow ? 0 : saved);
    return {
      count: collection.parts.length, total: lengthClock(length), checked, undo: !!undo,
      transitions: junctions.length, saved: saved.toFixed(1), off: fastNow && junctions.length > 0,
      switched: ui.switched,
    };
  }
  /** The picker of the junction below part `ui.picker`, while it is open: its kind, direction, duration, the limit, the two parts' pictures. */
  function pickerView() {
    const index = ui.picker ? collection.indexOf(ui.picker) : -1;
    const part = collection.parts[index];
    const next = collection.parts[index + 1];
    // Closed (or its junction gone: removed, moved last): the tab closes the popup; it never shows this empty one.
    if (!part || !next) return { shown: false, serial: ui.pickerSerial, id: "", from: 0, to: 0, kind: "cut", dir: "left", duration: "1.0", cap: "", custom: false, joins: 0 };
    const tr = part.transition;
    return {
      shown: true, serial: ui.pickerSerial, id: part.id, from: index + 1, to: index + 2, kind: tr.kind, dir: tr.dir,
      duration: tr.duration.toFixed(1), cap: capOf(part, next).toFixed(1),
      custom: !(PRESET_DURATIONS as readonly number[]).includes(tr.duration),
      joins: collection.parts.length - 1,
    };
  }
  function pickerPictures() {
    const index = ui.picker ? collection.indexOf(ui.picker) : -1;
    const part = collection.parts[index];
    const next = collection.parts[index + 1];
    return part && next ? [partThumbOf(part), partThumbOf(next)] : [];
  }
  /** Pick a kind, a direction or a duration for the junction below part `id`: at once (no OK). */
  function setTransition(id: string, kind: string, dir: string, duration: string) {
    const index = collection.indexOf(id);
    const part = collection.parts[index];
    const next = collection.parts[index + 1];
    if (!part || !next) return;
    const before = part.transition;
    const k = KINDS.includes(kind as Kind) ? (kind as Kind) : before.kind;
    const d = DIRECTIONS.includes(dir as Direction) ? (dir as Direction) : before.dir;
    const cap = capOf(part, next);
    // The first kind picked on a Cut gets 1 s (Q5 a); a typed value over the limit is set to the limit.
    const typed = typedDuration(duration, cap);
    const seconds = before.kind === "cut" && k !== "cut" ? Math.min(cap, FIRST_DURATION) : typed ?? before.duration;
    collection.setTransition(id, { kind: k, dir: d, duration: seconds });
    if (k !== "cut") preciseForTransitions();
  }
  /**
   * A transition picked while Fast would join the parts: the method becomes Precise (a transition needs re-encoding),
   * and the footer says so. A Cut keeps Fast. Parts Fast cannot join are Precise already: nothing changes.
   */
  function preciseForTransitions() {
    if (collectionMethod() !== "fast") return;
    setMethod("precise");
    ui.switched = true;
  }
  /** Apply to All: this junction's transition on every junction and as the default for new parts; Undo on the message. */
  function applyToAll(id: string) {
    const part = collection.find(id);
    if (!part) return;
    expireApplyUndo();
    const transition = { ...part.transition };
    const before = collection.applyAll(transition);
    if (transition.kind !== "cut") preciseForTransitions();
    const timer = setTimeout(expireApplyUndo, UNDO_MS);
    timer.unref?.();
    applyUndo = { before, defaultBefore: { ...settings.newTransition }, timer };
    settings.newTransition = transition;
    store();
    void osd.show("Transition applied to every join.", [], { actions: [{ title: text("Undo"), command: "clip.collectionUndoApply" }] }).catch(() => {});
  }
  let applyUndo: { before: Map<string, Transition>; defaultBefore: Transition; timer: ReturnType<typeof setTimeout> } | null = null;
  plugin.onDispose(() => void (applyUndo && clearTimeout(applyUndo.timer)));
  function expireApplyUndo() {
    if (!applyUndo) return;
    clearTimeout(applyUndo.timer);
    applyUndo = null;
    plugin.update();
  }
  function undoApply() {
    if (!applyUndo) return;
    clearTimeout(applyUndo.timer);
    collection.restoreTransitions(applyUndo.before);
    settings.newTransition = applyUndo.defaultBefore;
    store();
    applyUndo = null;
  }
  /** The Collection section and its footer: rows, sum, notes, the picker. */
  function collectionView() {
    const fresh = freshCheck();
    return {
      parts: partRows(),
      collectionInfo: collectionInfo(!!fresh),
      picker: pickerView(),
      // The two parts' thumbnails for the tiles: a property of its own (a missing one is null, which only a list takes).
      pickerPictures: pickerPictures(),
      blocking: blockingNote(fresh),
      copy: copyNote(fresh),
      target: targetNote(fresh),
      collectionMethodIndex: METHODS.indexOf(collectionMethod()),
      collectionBusy: ui.collectionBusy,
    };
  }

  // ---------------------------------------------------------------- the tab
  // A short title: the default sidebar width shows it whole beside Playlist and Chapters.
  const panel: Panel = plugin.panels.mount("sidebar", "ui/tab.slint", { title: "Clip Export" });
  const keyOf = (id: CommandId | "clip.last") => plugin.commands.keys(id)[0] ?? "";
  /** The source the example name uses: the playing file while the tab shows (read then only), else a sample name. */
  let lastSource: string | null = null;
  const shownSource = () => lastSource ?? "video.mp4";
  /** Whether the tab was on screen at the last pass; a timer refreshes the rows meanwhile. */
  let live = false;
  let ticker: ReturnType<typeof setInterval> | undefined;
  plugin.onDispose(() => clearInterval(ticker));
  /**
   * The tab's values. What it shows of the player's state is read only while
   * the tab is on screen (lazy activation): a background tab reads no player
   * state, so nothing keeps the plugin running while idle. The rest reads no
   * player state (cheap; no subscription).
   */
  panel.bind(() => {
    // A passive read (the player mirrors the layout to a running plugin; nothing is held): the tab came or went.
    const state = panel.state;
    const showing = !!state?.effective;
    if (showing !== live) queueMicrotask(() => follow(panel.state));
    return {
      ...(showing ? liveProps() : {}),
      keys: {
        clip: keyOf("clip.export"), last: keyOf("clip.last"), panel: keyOf("clip.panel"),
        start: keyOf("clip.start"), end: keyOf("clip.end"), add: keyOf("clip.collectionAdd"), merge: keyOf("clip.collectionExport"), remove: keyOf("clip.collectionRemove"),
      },
      ...collectionView(),
      collectionPreview: `${renderName(settings.collectionTemplate, { source: shownSource(), start: 242.3, end: 259, now: new Date(), n: sequence + 1 }, COLLECTION_TEMPLATE)}${extensionOf(animatedNow(collectionMethod()))}`,
      support: { fast: support.fastCut, encode: support.encodeOptions, progress: support.progress },
      methodIndex: METHODS.indexOf(method()),
      audioIndex: form.audioIndex,
      processed: form.processed,
      burn: form.burn,
      presetIndex: (() => {
        const preset = presetOf(settings.encode);
        // Custom comes after the presets in the Quality chooser.
        return preset === "custom" ? PRESETS.length : PRESETS.indexOf(preset);
      })(),
      encCrf: settings.encode.crf,
      encSource: settings.encode.rate === "source",
      encSpeed: SPEEDS.indexOf(settings.encode.speed),
      encHeight: HEIGHTS.indexOf(settings.encode.height),
      encFps: RATES.indexOf(settings.encode.fps),
      encAudio: AUDIO_RATES.indexOf(settings.encode.audio),
      advancedOpen: settings.advancedOpen,
      lastSeconds: settings.lastSeconds,
      lastIndex: (LAST_SECONDS as readonly number[]).indexOf(settings.lastSeconds),
      clipBusy: ui.clipBusy,
      queueFull: tasks.full(),
      clipStatus: ui.clipStatus,
      card: card(),
      results: resultRows(),
      resultsStatus: ui.resultsStatus,
      folder: settings.folder,
      besideMedia: settings.besideMedia,
      preview: `${renderName(settings.template, { source: shownSource(), start: 242.3, end: 259, now: new Date(), n: sequence + 1 })}${extensionOf(animatedNow(method()))}`,
      page: PAGES.indexOf(settings.page),
      listFocus: ui.listFocus,
      unseen,
    };
  });

  /** The part of the tab that reads the player's state; read only while the tab shows. */
  function liveProps() {
    const state = player.state;
    // A new source while the tab shows: the old file's marks go (written to the tab's own fields after this pass).
    if (marksFor(state)) queueMicrotask(() => panel.set({ clipStart: form.start, clipEnd: form.end }));
    lastSource = isLocal(state.source) ? state.source : null;
    const ab = abRange(state);
    const view = clipView(state);
    // R3: the clip's range on the seek bar while the tab shows (taken away when it goes, in `follow`).
    marker.set(view.span);
    return {
      mode: tabMode(state),
      canClip: clippable(state),
      audioLabels: audioChoices(state, text).labels,
      ab: { shown: !!ab, a: ab ? clock(ab.start) : "", b: ab ? clock(ab.end) : "" },
      canLast: clippable(state) && (state.position ?? 0) >= 0.1,
      folderShown: shownFolder(state.source),
      fieldError: view.error,
      errorField: view.field,
      note: view.note,
      timeline: view.timeline,
      estimate: view.estimate,
      clipName: view.name,
      addFrom: addFrom(state),
    };
  }
  /** The Range card's file and + Add: the file playing, its duration, the marked range's length, whether it can be added. */
  function addFrom(state: PlayerState) {
    const range = typedRange();
    const can = clippable(state);
    return {
      can,
      // A stream's name too (shown greyed beside why it cannot be added); a plugin's picture has none.
      // The file's name; a stream has no title in the public API (its address's last segment says nothing, "watch"), so none.
      name: can && lastSource ? basename(lastSource) : "",
      duration: state.duration && Number.isFinite(state.duration) ? clock(state.duration) : "",
      length: can && !("error" in range) ? (range.end - range.start).toFixed(1) : "",
      next: collection.parts.length + 1,
      full: collection.full(),
    };
  }
  /** The tab came on screen or went: what only matters while it shows starts or stops. */
  function follow(state: PanelState | null) {
    const on = !!state?.effective;
    if (on === live) return;
    live = on;
    clearInterval(ticker);
    if (on) {
      if (settings.page === "results") unseen = 0;
      void recheck();
      void tidy();
      // Rows say "1 min ago" and the card counts seconds: refresh them while the tab shows.
      ticker = setInterval(() => plugin.update(), 1000);
      ticker.unref?.();
      void results.check().then((changed) => changed && plugin.update());
      probeSoon();
    } else {
      marker.set(null);
      ui.picker = "";
      // What the user typed, written back for the next build of the tab (the player may rebuild it from the last values).
      panel.set({ clipStart: form.start, clipEnd: form.end });
    }
  }
  // Not `panel.onChange`: a listener of the layout would keep the plugin running while idle (lazy activation);
  // the binding above reads the state passively and is run again when it changes.
  void panel.ready.then(
    () => follow(panel.state),
    (error) => console.error(`[clipexport] the tab did not mount: ${message(error)}`),
  );
  /** The sub-tab shown, remembered; showing Results clears its badge. */
  function setPage(index: number) {
    const page = PAGES[index];
    if (!Number.isInteger(index) || !page) return;
    if (page === "results") unseen = 0;
    if (settings.page === page) return;
    // A selection is the Clip page's (its Collection): another page in front leaves nothing for Delete to remove.
    selected = null;
    settings.page = page;
    // The picker belongs to the Clip page's Collection.
    ui.picker = "";
    store();
  }
  /** Show the tab at a page; when it cannot open, the keys keep working. */
  async function showTab(page: Page) {
    setPage(PAGES.indexOf(page));
    try {
      await panel.show();
    } catch (error) {
      console.error(`[clipexport] the tab could not open: ${message(error)}`);
      shown(osd.show("The Clip Export tab could not open."));
    }
  }
  const tabShown = () => !!panel.state?.effective;

  // The fields the tab owns are written by the plugin only on these actions.
  panel.set({ clipStart: form.start, clipEnd: form.end, template: settings.template, collectionTemplate: settings.collectionTemplate });
  /** The typed fields survive standby (session storage), as the tab's view must. */
  let formTimer: ReturnType<typeof setTimeout> | undefined;
  function rememberForm() {
    clearTimeout(formTimer);
    formTimer = setTimeout(() => void plugin.storage.session.set("form", { ...form }).catch(() => {}), 500);
    formTimer.unref?.();
  }
  plugin.onDispose(() => clearTimeout(formTimer));
  void plugin.storage.session.get<Partial<Form>>("form").then(
    (kept) => {
      if (!kept || typeof kept !== "object") return;
      for (const key of ["start", "end", "autoStart", "autoEnd"] as const) if (typeof kept[key] === "string") form[key] = kept[key];
      if (Number.isInteger(kept.audioIndex)) form.audioIndex = kept.audioIndex!;
      for (const key of ["processed", "burn"] as const) if (typeof kept[key] === "boolean") form[key] = kept[key];
      if (Number.isInteger(kept.sourceId)) form.sourceId = kept.sourceId!;
      panel.set({ clipStart: form.start, clipEnd: form.end });
      plugin.update();
    },
    () => {},
  );

  const on = (name: string, run: (...args: never[]) => unknown) => panel.on(name, run as (...args: unknown[]) => unknown);
  on("setPage", (index: number) => setPage(Number(index)));
  // Clip
  on("setMethod", (index: number) => {
    // The user's own pick: the note that a transition switched the method goes.
    ui.switched = false;
    setMethod(METHODS[Number(index)]!);
  });
  on("clipEdited", (start: string, end: string) => {
    // Typed while the tab shows the source playing: the marks are its.
    Object.assign(form, { start: String(start), end: String(end), sourceId: player.state.sourceId });
    rememberForm();
    probeSoon();
  });
  on("clipNow", async (field: string) => {
    const position = (await player.refresh()).position ?? 0;
    setRange(field === "end" ? { end: position } : { start: position });
  });
  on("useAb", () => {
    const ab = abRange(player.state);
    if (!ab) return void (ui.clipStatus = status("error", { reason: "noLoop" }));
    setRange(ab);
  });
  on("last", () => exportLast());
  on("setAudio", (index: number) => {
    form.audioIndex = Math.max(0, Math.round(Number(index)));
    rememberForm();
  });
  on("setProcessed", (value: boolean) => {
    form.processed = value === true;
    rememberForm();
  });
  on("setBurn", (value: boolean) => {
    form.burn = value === true;
    rememberForm();
  });
  on("setPreset", (index: number) => {
    const preset = PRESETS[Number(index)];
    if (preset) setEncode({ ...PRESET_ENCODE[preset] });
  });
  on("setEncode", (field: string, value: number) => {
    // The animated presets' encoding is fixed (the tab hides these rows for them).
    if (animatedOf(settings.encode)) return;
    const next = { ...settings.encode };
    const n = Math.round(Number(value));
    // Moving the quality number leaves "Same as source" for a quality level.
    if (field === "crf") Object.assign(next, { crf: crfOf(n), rate: "crf" });
    else if (field === "speed" && SPEEDS[n]) next.speed = SPEEDS[n]!;
    else if (field === "height" && HEIGHTS[n] !== undefined) next.height = HEIGHTS[n]!;
    else if (field === "fps" && RATES[n] !== undefined) next.fps = RATES[n]!;
    else if (field === "audio" && AUDIO_RATES[n] !== undefined) next.audio = AUDIO_RATES[n]!;
    else return;
    setEncode(next);
  });
  on("resetEncode", () => setEncode({ ...PRESET_ENCODE.high }));
  on("setAdvancedOpen", (open: boolean) => setFlag("advancedOpen", open === true));
  on("exportClip", (start: string, end: string) => exportClip(String(start), String(end), false));
  on("exportAs", (start: string, end: string) => exportClip(String(start), String(end), true));
  // Results
  const onRow = (name: string, action: (id: string) => unknown) =>
    on(name, async (id: string) => {
      try {
        ui.resultsStatus = status();
        await action(String(id));
      } catch (error) {
        ui.resultsStatus = errorStatus(error);
      }
    });
  const taskOf = (id: string) => (id.startsWith("t") ? tasks.find(id.slice(1)) : undefined);
  /** A result's file, or the reason it cannot be used. */
  async function existing(id: string) {
    const item = results.find(id);
    if (!item) throw new Failure("noOutput");
    if (!(await stat(item.path).catch(() => null))) {
      results.gone.add(item.id);
      throw new Failure("folderGone");
    }
    return item;
  }
  onRow("cancelTask", async (id) => {
    const task = taskOf(id);
    if (task) await tasks.cancel(task);
  });
  onRow("retryTask", async (id) => {
    const task = taskOf(id);
    if (!task || !terminal(task) || task.status === "completed") return;
    await exporter.retry(task);
    await tasks.forget(task);
    ui.resultsStatus = status("restarted");
  });
  onRow("openResult", async (id) => {
    const item = await existing(id);
    await plugin.system.openPath(item.path).catch(() => {
      throw new Failure("cannotOpen");
    });
  });
  onRow("revealResult", async (id) => {
    const item = await existing(id);
    await plugin.system.reveal(item.path);
  });
  onRow("removeResult", async (id) => {
    const task = taskOf(id);
    if (task) return tasks.forget(task);
    const item = results.remove(id);
    if (item) dropThumb(item);
  });
  on("clearFinished", async () => {
    for (const task of tasks.list.filter(terminal)) await tasks.forget(task);
    results.clear().forEach(dropThumb);
  });
  on("openFolder", () => openFolder().catch((error) => (ui.resultsStatus = errorStatus(error))));
  // Settings
  on("pickFolder", chooseFolder);
  on("setBesideMedia", (value: boolean) => setFlag("besideMedia", value === true));
  on("templateEdited", (value: string) => {
    // An empty template is kept empty in the field while typing; names use the default meanwhile.
    settings.template = normalTemplate(value);
    store();
  });
  on("insertVariable", (variable: string) => {
    settings.template = insertVariable(settings.template, String(variable));
    store();
    panel.set({ template: settings.template });
  });
  on("resetTemplate", () => {
    settings.template = DEFAULT_TEMPLATE;
    store();
    panel.set({ template: settings.template });
  });
  on("setLastSeconds", (index: number) => {
    const next = lastSeconds(LAST_SECONDS[Number(index)]);
    if (next === settings.lastSeconds) return;
    settings.lastSeconds = next;
    store();
    void retitleLast();
  });
  // Collection
  /** A Collection action from the tab: its problem is said on screen (the page's red line is for what blocks the export). */
  const onPart = (name: string, action: (...args: string[]) => unknown) =>
    on(name, async (...args: unknown[]) => {
      try {
        await action(...args.map(String));
      } catch (error) {
        sayProblem(problemOf(error));
      }
    });
  on("addPart", (start: string, end: string) => addPart(false, { start: String(start), end: String(end) }));
  onPart("removePart", (id) => removePart(id));
  onPart("movePart", (id, to) => {
    if (collection.move(id, Number(to))) void recheck();
  });
  on("selectPart", (id: string) => {
    selected = collection.find(String(id)) ? String(id) : null;
  });
  on("clearParts", () => clearCollection());
  onPart("locatePart", (id) => locatePart(id));
  onPart("previewPart", (id) => previewPart(id));
  on("exportMerged", () => exportCollection(false));
  on("exportMergedAs", () => exportCollection(true));
  // Transitions: the picker of a junction opens and closes; a pick applies at once.
  on("openJoin", (id: string) => {
    // Any junction above the last part, in Fast too (a transition picked there switches to Precise); the tab shows
    // the popup when the serial changes, so a refused open shows nothing.
    const index = collection.indexOf(String(id));
    if (index < 0 || index >= collection.parts.length - 1) return;
    ui.picker = String(id);
    ui.pickerSerial++;
  });
  on("closeJoin", () => void (ui.picker = ""));
  on("setTransition", (id: string, kind: string, dir: string, duration: string) => setTransition(String(id), String(kind), String(dir), String(duration)));
  on("applyAll", (id: string) => applyToAll(String(id)));
  on("collectionTemplateEdited", (value: string) => {
    settings.collectionTemplate = normalTemplate(value, COLLECTION_TEMPLATE);
    store();
  });
  on("insertCollectionVariable", (variable: string) => {
    settings.collectionTemplate = insertVariable(settings.collectionTemplate, String(variable));
    store();
    panel.set({ collectionTemplate: settings.collectionTemplate });
  });
  on("resetCollectionTemplate", () => {
    settings.collectionTemplate = COLLECTION_TEMPLATE;
    store();
    panel.set({ collectionTemplate: settings.collectionTemplate });
  });
  on("focusChanged", (focused: boolean) => panel.setInteraction({ focused: focused === true }));
  plugin.onError((error) => {
    console.error(`[clipexport] ${error.message}`);
    ui.resultsStatus = errorStatus(error);
  });

  // ---------------------------------------------------------------- commands
  /**
   * A video to export as a condition the player evaluates (`plugin.when`):
   * the menu and the keys follow playback without this plugin running. The
   * player shows the reason only while the condition is false.
   */
  const { when } = plugin;
  const canExport = { enabled: when.can("snapshot").and(when.phase("ready", "ended"), when.stream.not()), reason: "Nothing to export" as const };
  /** The options besides id, path, title, order and run; `reason` is typed so that extract finds its text. */
  type Extra = Omit<CommandOptions, "id" | "path" | "title" | "order" | "run" | "reason" | "category"> & { reason?: "Nothing to export" };
  /** Where an option's control lives now: the tab. */
  const inTab = { home: "clip.panel" };
  const inSettings = { home: "clip.settings" };
  // The command palette shows "Category: Title"; every command of this plugin is an export.
  const entry = (id: CommandId, order: number, run: () => unknown, extra: Extra = {}) =>
    id === "clip.open"
      ? plugin.commands.add({ id, path: ["@video", TITLE[id]], order, run, category: "Export", ...extra })
      : plugin.commands.add({ id, title: TITLE[id], order, run, category: "Export", ...extra });
  /**
   * Export Clip… (Video ▸): opens the tab at its Clip page and never exports.
   * A range the user has not typed is set to the position → +10 s.
   */
  async function openClip() {
    const seen = await player.refresh();
    marksFor(seen);
    // Cleared above when they were another file's; the user's own range stays as typed (nothing written over it).
    if (!typedByUser()) setRange(defaultRange(seen.position, seen.duration), true);
    await showTab("clip");
  }
  entry("clip.open", 470, openClip, { group: "clip-export" });
  /**
   * Export Clip Range (Ctrl+Shift+E, the Export button's key): exports the
   * tab's range into the clip folder; a failure is said on screen. With no
   * range yet it opens the Clip page instead.
   */
  entry("clip.export", 471, async () => {
    // Another file's marks are not this one's: with none for this file the key opens the Clip page.
    if (marksFor(await player.refresh())) panel.set({ clipStart: form.start, clipEnd: form.end });
    if (!form.start.trim() && !form.end.trim()) return openClip();
    await exportClip(form.start, form.end, false, true);
  }, { bindings: ["Ctrl+Shift+E"], ...inTab, ...canExport });
  // Shows the tab, or hides the sidebar when the tab is in front (as F6 does for the playlist). No default key.
  entry("clip.panel", 472, async () => {
    try {
      await panel.toggle();
    } catch (error) {
      console.error(`[clipexport] the tab could not open: ${message(error)}`);
      shown(osd.show("The Clip Export tab could not open."));
    }
  }, { checked: () => (panel.state?.preferred ?? false) && (panel.state?.active ?? false) });
  entry("clip.tasks", 473, () => showTab("results"));
  entry("clip.settings", 474, () => showTab("settings"));
  entry("clip.folder", 475, chooseFolder, inSettings);
  entry("clip.openFolder", 476, () => openFolder().catch((error) => sayProblem(problemOf(error))));
  /**
   * The button of a finished export's message (R5) and a palette command: it
   * acts on the newest result. The same is in the tab's Results.
   */
  entry("clip.revealLast", 477, async () => {
    try {
      const item = results.list[0];
      if (!item) throw new Failure("noOutput");
      await plugin.system.reveal((await existing(item.id)).path);
    } catch (error) {
      sayProblem(problemOf(error));
    }
  }, { home: "clip.tasks" });
  entry("clip.start", 478, async () => {
    const position = (await player.refresh()).position ?? 0;
    setRange({ start: position });
    shown(osd.show("Clip start: {}", [clock(position)]));
  }, { ...inTab, ...canExport });
  entry("clip.end", 479, async () => {
    const position = (await player.refresh()).position ?? 0;
    setRange({ end: position });
    shown(osd.show("Clip end: {}", [clock(position)]));
  }, { ...inTab, ...canExport });
  // The Collection (no default keys yet: design question Q1; the key caps follow the user's own bindings).
  const inCollection = { home: "clip.collection" };
  /** Add Range to Collection: the Clip page's Start and End of the file playing, as the last part; playback does not change. */
  entry("clip.collectionAdd", 481, () => addPart(true), { ...inCollection, ...canExport });
  /** Show Collection: the Clip page, its list focused and scrolled into view (the Collection is a section of that page). */
  entry("clip.collection", 482, async () => {
    await showTab("clip");
    // After the tab is shown: a tab built by this show gets the new value as a change, which is what scrolls.
    ui.listFocus++;
    plugin.update();
  });
  /** Export Collection: Export Merged, into the clip folder; a problem is said on screen. */
  entry("clip.collectionExport", 483, () => exportCollection(false, true), inCollection);
  entry("clip.collectionClear", 484, clearCollection, inCollection);
  /** The Undo button of the "Collection cleared" message (an OSD button runs a command), while Undo is offered. */
  entry("clip.collectionUndo", 485, undoClear, { ...inCollection, enabled: () => !!undo });
  /** Delete while the list has the keyboard focus (a key of the panel's content, `focus: "panel"`). */
  /** The Undo button of the "applied to every join" message (an OSD button runs a command), while Undo is offered. */
  entry("clip.collectionUndoApply", 487, undoApply, { ...inCollection, enabled: () => !!applyUndo });
  entry("clip.collectionRemove", 486, removeSelected, { ...inCollection, bindings: ["Delete"], focus: "panel", enabled: () => !!selected && collectionShown() });
  /**
   * Export Last N Seconds (Ctrl+Shift+R): its title states the length the
   * user chose in Settings, so the command is declared again when it changes
   * (same id: the user's keys stay).
   */
  const addLast = () =>
    plugin.commands.add({
      id: "clip.last",
      // TRANSLATORS: {} is 10, 30, 60 or 120.
      title: text("Export Last {} Seconds", [settings.lastSeconds]),
      category: "Export",
      order: 480,
      bindings: ["Ctrl+Shift+R"],
      home: "clip.panel",
      run: () => exportLast(),
      ...canExport,
    });
  let lastCommand = addLast();
  async function retitleLast() {
    await lastCommand.dispose();
    lastCommand = addLast();
  }

  // Leaving the tab keeps tasks running; deactivation cancels them (the SDK releases jobs and snapshots).
  plugin.onDispose(async () => {
    exporter.stop();
    await tasks.stop();
  });
}
