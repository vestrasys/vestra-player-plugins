import { access, constants, mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CommandOptions, ImageRef, Panel, PanelState, Plugin, PlayerState, Text } from "@vestra-player/sdk";
import {
  abRange, AUDIO_RATES, codecArgs, crfOf, defaultRange, effectiveMethod, estimate, fastContainer, HEIGHTS, keyframeArgs, LAST_SECONDS, lastRange, lastSeconds,
  METHODS, NO_TIMELINE, parseCodec, parseKeyframes, PRESET_ENCODE, presetOf, PRESETS, RATES, snapStart, SPEEDS, timeline, timelineWindow,
} from "./clip.ts";
import type { Encode, Method } from "./clip.ts";
import { capturer } from "./form.ts";
import { audioChoices, clippable, clock, Failure, isLocal, message, notClippable, parseRange, parseTime, problemOf, REASON, tabMode } from "./model.ts";
import type { Problem, Spec } from "./model.ts";
import { DEFAULT_TEMPLATE, insertVariable, normalTemplate, renderName } from "./names.ts";
import { makeThumb, Results, sizeOf } from "./results.ts";
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
} as const;
type CommandId = keyof typeof TITLE;

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
}

export interface Options {
  /** Pretend the player offers less than it does (tests of the tab's views; seams.ts). */
  support: Partial<HostSupport>;
}

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
  const ui = { clipBusy: false, clipStatus: status(), resultsStatus: status() };
  const form: Form = { start: "", end: "", autoStart: "", autoEnd: "", audioIndex: 1, processed: false, burn: false };
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
  const exporter = capturer(plugin, tasks);
  const marker = rangeMarker(plugin, text("Clip"));
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
      if (!(tabShown() && settings.page === 1)) unseen++;
      // R5: the buttons run commands that act on the newest result, which this now is.
      const actions: OsdAction[] = [
        { title: text("Show in Folder"), command: "clip.revealLast" },
        { title: text("Show in Tab"), command: "clip.tasks" },
      ];
      showDone(plugin, [fit(path)], actions);
      ui.clipStatus = status("exported", { name: basename(path) });
      await tasks.forget(task);
      plugin.update();
      void thumbnail(saved);
    } else if (task.status === "failed") {
      const problem = task.error ?? { reason: "", raw: "" };
      sayFailed(problem);
      ui.clipStatus = status("clip-failed", problem);
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
    if (!task) return { shown: false, id: "", name: "", method: "", preset: "", percent: -1, left: -1, elapsed: "", queued: 0 };
    const share = task.progress && task.progress.total > 0 ? task.progress.done / task.progress.total : null;
    const { spec } = task;
    return {
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
    const extension = container === "mkv" ? ".mkv" : ".mp4";
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
    const spec: Spec = {
      start: range.start, end: range.end,
      processed: precise && form.processed, subtitles: precise && form.processed && form.burn,
      track: audioChoices(seen, text).values[form.audioIndex] ?? "none",
      method: chosen,
      // R6: the tab's encoder settings.
      encode: precise && support.encodeOptions ? { ...settings.encode } : undefined,
    };
    const snapped = chosen === "fast" && probe.source === seen.source ? snapStart(probe.keyframes, range.start) : null;
    const container = chosen === "fast" ? fastContainer(probe.source === seen.source ? probe.video : null, audioCodec(seen)) : "mp4";
    const extension = container === "mkv" ? ".mkv" : ".mp4";
    const name = `${renderName(settings.template, { source: seen.source, start: snapped ?? range.start, end: range.end, now: new Date(), n: nextNumber() })}${extension}`;
    let destination: string;
    if (ask) {
      const picked = await plugin.dialogs.saveFile({ title: "Export Clip", fileName: name });
      if (!picked) return void (ui.clipStatus = status("no-destination"));
      destination = /\.(mp4|mkv)$/i.test(picked) ? picked : `${picked}${extension}`;
    } else destination = join(await targetFolder(seen.source), name);
    await exporter.start(spec, seen, destination);
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
      Object.assign(form, { start, end });
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
    if (range.start !== undefined) form.start = clock(range.start);
    if (range.end !== undefined) form.end = clock(range.end);
    if (automatic) Object.assign(form, { autoStart: form.start, autoEnd: form.end });
    panel.set({ clipStart: form.start, clipEnd: form.end });
    rememberForm();
    probeSoon();
  }
  const setMethod = (next: Method) => {
    if (!METHODS.includes(next) || settings.method === next) return;
    settings.method = next;
    store();
    probeSoon();
  };
  const setEncode = (next: Encode) => {
    settings.encode = next;
    store();
  };

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
      keys: { clip: keyOf("clip.export"), last: keyOf("clip.last"), panel: keyOf("clip.panel") },
      support: { fast: support.fastCut, encode: support.encodeOptions, progress: support.progress },
      methodIndex: METHODS.indexOf(method()),
      audioIndex: form.audioIndex,
      processed: form.processed,
      burn: form.burn,
      presetIndex: (() => {
        const preset = presetOf(settings.encode);
        return preset === "custom" ? 3 : PRESETS.indexOf(preset);
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
      preview: `${renderName(settings.template, { source: shownSource(), start: 242.3, end: 259, now: new Date(), n: sequence + 1 })}.mp4`,
      page: settings.page,
      unseen,
    };
  });

  /** The part of the tab that reads the player's state; read only while the tab shows. */
  function liveProps() {
    const state = player.state;
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
    };
  }
  /** The tab came on screen or went: what only matters while it shows starts or stops. */
  function follow(state: PanelState | null) {
    const on = !!state?.effective;
    if (on === live) return;
    live = on;
    clearInterval(ticker);
    if (on) {
      if (settings.page === 1) unseen = 0;
      // Rows say "1 min ago" and the card counts seconds: refresh them while the tab shows.
      ticker = setInterval(() => plugin.update(), 1000);
      ticker.unref?.();
      void results.check().then((changed) => changed && plugin.update());
      probeSoon();
    } else {
      marker.set(null);
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
    if (!Number.isInteger(index) || index < 0 || index >= PAGES.length) return;
    if (index === 1) unseen = 0;
    if (settings.page === index) return;
    settings.page = index;
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
  panel.set({ clipStart: form.start, clipEnd: form.end, template: settings.template });
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
      panel.set({ clipStart: form.start, clipEnd: form.end });
      plugin.update();
    },
    () => {},
  );

  const on = (name: string, run: (...args: never[]) => unknown) => panel.on(name, run as (...args: unknown[]) => unknown);
  on("setPage", (index: number) => setPage(Number(index)));
  // Clip
  on("setMethod", (index: number) => setMethod(METHODS[Number(index)]!));
  on("clipEdited", (start: string, end: string) => {
    Object.assign(form, { start: String(start), end: String(end) });
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
    if (!typedByUser()) {
      const { position, duration } = await player.refresh();
      setRange(defaultRange(position, duration), true);
    }
    await showTab("clip");
  }
  entry("clip.open", 470, openClip, { group: "clip-export" });
  /**
   * Export Clip Range (Ctrl+Shift+E, the Export button's key): exports the
   * tab's range into the clip folder; a failure is said on screen. With no
   * range yet it opens the Clip page instead.
   */
  entry("clip.export", 471, async () => {
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
