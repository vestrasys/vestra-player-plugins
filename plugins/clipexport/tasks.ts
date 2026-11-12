import type { ExportJob, ExportPart, JobState, Scope, Snapshot } from "@vestra-player/sdk";
import { Failure, jobProblem } from "./model.ts";
import type { JobReason, Problem, Spec } from "./model.ts";
import type { Encode } from "./clip.ts";
import { actualRange, clipExport, jobProgress, partsExport } from "./seams.ts";
import type { Progress } from "./seams.ts";

/** The plugin's step after the player's export: the work file, what it adds to the progress, the run itself and its cleanup. */
export interface Finish {
  merged: string;
  /** `merged`, once the work folder is there (`workReady`): the player's job writes it. */
  ready(): Promise<string>;
  /** Seconds of output the step writes (the progress adds them to the merge's). */
  length: number;
  plan: unknown;
  /** Writes the destination; resolves with the file written. Reports output seconds through `progress`. */
  run(state: JobState, signal: AbortSignal, progress: (seconds: number, transition: number, transitions: number) => void): Promise<string>;
  /** Removes the work files, whatever happened (called on every end). */
  cleanup(): Promise<void>;
}

/** An accepted export: one frozen snapshot (a clip) or the Collection's parts (a merged export), one export job. */
export interface Task {
  id: string;
  spec: Spec;
  sourceId: number;
  source: string;
  snapshot?: Snapshot;
  /** A merged export of the Collection: its parts as they were when it started (later edits apply to the next export). */
  parts?: ExportPart[];
  /**
   * A merged export with transitions: the player writes the plain merge to
   * `merged` (the plugin's work folder), then `run` writes the transitions into
   * the destination (the plugin's ffmpeg). `plan` is kept for a retry.
   */
  finish?: Finish;
  /** Stops the plugin's own step (the transitions). */
  abort?: AbortController;
  destination: string;
  status: string;
  /** Why it failed. */
  error?: Problem<JobReason>;
  cancel: boolean;
  jobs: ExportJob[];
  /** The file the host confirmed (a Fast cut may be MKV where MP4 was asked). */
  output?: string;
  active?: ExportJob;
  retainUntil?: number;
  retentionTimer?: ReturnType<typeof setTimeout>;
  /** When its job started running, and when it ended (ms since the epoch). */
  started?: number;
  ended?: number;
  /** The running job's progress in seconds of media (R4), and the part being written of a merged export; `null` while unknown. */
  progress: Progress | null;
  /** When the progress first moved, and how far it was then (the time-left estimate measures from here). */
  rateFrom?: { at: number; done: number };
  /** The finished clip's range as written (R2; the range asked for until then). */
  actual?: { start: number; end: number };
}

const TERMINAL = ["completed", "failed", "cancelled"];
const RETAIN_MS = 300_000;
/** At most one running and four queued tasks; twenty in the list. */
export const QUEUE_LIMIT = 5;
export const HISTORY_LIMIT = 20;
export const terminal = (task: Task) => TERMINAL.includes(task.status);

/**
 * A host job failure as one of the plugin's reasons; the code and message go
 * to the log. `unsupported` means what the clip asked for: a stream copy the
 * player cannot make (Fast), or a source bitrate it cannot tell ("Same as
 * source").
 */
export function jobError(error: { code: string; message: string }, spec?: Spec): JobReason {
  console.error(`[clipexport] export failed: ${error.code}: ${error.message}`);
  if (error.code === "unsupported" && spec) {
    if (spec.method === "fast") return "fastImpossible";
    if (spec.encode?.rate === "source") return "noSourceBitrate";
  }
  switch (error.code) {
    // A merged export: a part's file went or changed since it was added, or its token is gone.
    case "source-missing":
      return "partMissing";
    case "source-changed":
      return "partChanged";
    case "missing":
      return "partUnknown";
    case "space":
    case "no-space":
      return "space";
    case "exists":
      return "exists";
    case "permission":
      return "permission";
    case "encoder":
    case "unsupported":
      return "encoder";
    default:
      return "exportFailed";
  }
}

/**
 * Seconds left of a running export, from the rate measured since its progress
 * first moved; -1 (none shown) until there is a rate worth the name (1.5 s of
 * it and some progress), and at the end, while the player checks the file.
 */
export function timeLeft(task: { progress: { done: number; total: number } | null; rateFrom?: Task["rateFrom"] }, now = Date.now()): number {
  const progress = task.progress;
  const from = task.rateFrom;
  if (!progress || !from || progress.done >= progress.total) return -1;
  const seconds = (now - from.at) / 1000;
  const moved = progress.done - from.done;
  if (seconds < 1.5 || moved <= 0) return -1;
  return Math.max(1, Math.round((progress.total - progress.done) / (moved / seconds)));
}

/** One running and up to four queued tasks; history of twenty; failed input kept five minutes. */
export class Tasks {
  readonly list: Task[] = [];
  readonly #plugin: Scope;
  readonly #finished: (task: Task) => void;
  #sequence = 0;
  #running = false;
  #stopped = false;
  constructor(plugin: Scope, finished: (task: Task) => void) {
    this.#plugin = plugin;
    this.#finished = finished;
  }

  active = () => this.list.filter((task) => !terminal(task));
  full = () => this.active().length >= QUEUE_LIMIT;
  find = (id: string) => this.list.find((task) => task.id === id);
  retained = (task: Task) => !!task.snapshot && !!task.retainUntil && task.retainUntil > Date.now();
  /** The task running now, if any. */
  running = () => this.list.find((task) => !terminal(task) && task.status !== "queued");
  /** How many wait behind it. */
  queued = () => this.list.filter((task) => task.status === "queued").length;

  /** Accept a task whose snapshot is already frozen; it keeps that input while queued. */
  add(fields: Omit<Task, "id" | "status" | "cancel" | "jobs" | "progress">) {
    const task: Task = { ...fields, id: String(++this.#sequence), status: "queued", cancel: false, jobs: [], progress: null };
    this.list.push(task);
    // Accepted past the caller's awaits (the snapshot, a free name): the row is new outside SDK-invoked code.
    this.#plugin.update();
    void this.#trim();
    void this.#pump();
    return task;
  }

  /** Hand a retained snapshot to a retry; the old task no longer owns it. */
  take(task: Task): Snapshot {
    if (!this.retained(task)) throw new Failure("expired");
    const snapshot = task.snapshot!;
    clearTimeout(task.retentionTimer);
    task.snapshot = task.retainUntil = task.retentionTimer = undefined;
    return snapshot;
  }

  async release(task: Task) {
    clearTimeout(task.retentionTimer);
    const snapshot = task.snapshot;
    task.snapshot = task.retainUntil = task.retentionTimer = undefined;
    await snapshot?.dispose();
  }

  /** Take an ended task off the list (Remove from List, Clear Finished, a completed task once it is a result). */
  async forget(task: Task) {
    if (!terminal(task)) return;
    const index = this.list.indexOf(task);
    if (index >= 0) this.list.splice(index, 1);
    await this.release(task);
    for (const job of task.jobs) await job.dispose().catch(() => {});
  }

  #retain(task: Task) {
    if (!task.snapshot) return;
    task.retainUntil = Date.now() + RETAIN_MS;
    task.retentionTimer = setTimeout(() => void this.release(task).then(() => this.#plugin.update()), RETAIN_MS);
    task.retentionTimer.unref?.();
  }

  async #trim() {
    while (this.list.length > HISTORY_LIMIT) {
      const old = this.list.find(terminal);
      if (!old) break;
      await this.forget(old);
      // Past an await, outside SDK-invoked code: say so.
      this.#plugin.update();
    }
  }

  async #pump() {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      for (let task; !this.#stopped && (task = this.list.find((each) => each.status === "queued")); ) {
        task.status = "preparing";
        task.started = Date.now();
        this.#plugin.update();
        try {
          if (task.cancel) task.status = "cancelled";
          else {
            const { state } = await this.#run(task);
            if (state.status === "completed" && task.finish) {
              // The plain merge (or the clip) is written: the plugin's own step makes the transitions or the animated image.
              task.output = await this.#finish(task, task.finish, state);
              // A clip holds the range the player wrote; a merge its output's length from 0.
              task.actual = task.parts ? { start: 0, end: task.finish.length } : actualRange(state, { start: task.spec.start, end: task.spec.end });
              task.status = task.output ? "completed" : "cancelled";
              if (!task.output) task.cancel = true;
            } else if (state.status === "completed" && state.outcome && "destination" in state.outcome) {
              task.output = state.outcome.destination;
              // A merged file holds the parts' length from 0; a clip the range the player wrote.
              task.actual = task.parts ? { start: task.spec.start, end: task.spec.end } : actualRange(state, { start: task.spec.start, end: task.spec.end });
              task.status = "completed";
            } else if (state.status === "failed")
              throw new Failure(state.outcome && "error" in state.outcome ? jobError(state.outcome.error, task.spec) : jobError({ code: "unknown", message: "no error outcome" }));
            else if (state.status === "cancelled") {
              task.cancel = true;
              task.status = "cancelled";
            } else throw new Failure(jobError({ code: "unknown", message: "completed without a destination" }));
          }
        } catch (error) {
          task.status = "failed";
          task.error = error instanceof Error ? jobProblem(error) : { reason: "exportFailed", raw: "" };
        } finally {
          // Success, failure or cancel: the work files go.
          await task.finish?.cleanup().catch((error) => console.error(`[clipexport] cleanup: ${error}`));
          task.abort = undefined;
        }
        task.ended = Date.now();
        task.progress = null;
        if (task.status === "completed") await this.release(task);
        else this.#retain(task);
        this.#finished(task);
        this.#plugin.update();
      }
    } finally {
      this.#running = false;
    }
  }

  async #run(task: Task): Promise<{ job: ExportJob; state: JobState }> {
    const { spec } = task;
    let job: ExportJob;
    // With a step of the plugin's after it, the player writes into the work folder: made first (a fresh install has none).
    const destination = task.finish ? await task.finish.ready() : task.destination;
    if (task.parts) {
      job = await this.#plugin.media.export(partsExport(task.parts, destination, spec.method, task.finish ? (task.finish.plan as { merge: Encode }).merge : spec.encode)).catch((error: { code?: string; message?: string }) => {
        // Refused before it started (a token the player no longer has, a part the check did not see): one of the plugin's reasons.
        throw new Failure(jobError({ code: error.code ?? "unknown", message: error.message ?? String(error) }, spec));
      });
    } else {
      if (!task.snapshot) throw new Failure("released");
      // An animated image: the player writes the clip into the work folder first.
      job = await task.snapshot.export(clipExport(destination, spec.end, spec.method, task.finish ? (task.finish.plan as { merge: Encode }).merge : spec.encode));
    }
    task.active = job;
    task.jobs.push(job);
    if (task.cancel || this.#stopped) await job.cancel().catch(() => {});
    const show = (state: JobState) => {
      // A job the player has not started yet is still this task's preparation (the task left the plugin's queue).
      task.status = TERMINAL.includes(state.status) ? "running" : state.status === "queued" ? "preparing" : state.status;
      task.progress = jobProgress(state);
      // A merge with transitions: the plugin's step comes after it, its seconds count too.
      if (task.progress && task.finish) task.progress = { ...task.progress, total: task.progress.total + task.finish.length };
      // The rate is measured from the first progress that moved: not from the start, which includes
      // freezing the input, the seek and the encoder's start-up (a 4K Precise cut otherwise said
      // "about 391 s left" 14 s in and finished within a minute).
      if (task.progress && task.progress.done > 0 && !task.rateFrom) task.rateFrom = { at: Date.now(), done: task.progress.done };
    };
    show(job.state);
    // Past the export's await: the row's status changed outside SDK-invoked code.
    this.#plugin.update();
    const watching = job.onChange(show);
    try {
      return { job, state: await job.done };
    } finally {
      task.active = undefined;
      await watching.dispose();
    }
  }

  /** The plugin's step: cancellable (`abort`), with its progress after the merge's; "" when cancelled. */
  async #finish(task: Task, finish: Finish, state: JobState): Promise<string> {
    if (task.cancel || this.#stopped) return "";
    const abort = (task.abort = new AbortController());
    // The merge wrote the parts' length (the spec's range); the step adds the output's.
    const merged = Math.max(0, task.spec.end - task.spec.start);
    task.status = "running";
    task.progress = { done: merged, total: merged + finish.length, part: 0, parts: 0, transition: 0, transitions: 0 };
    this.#plugin.update();
    try {
      return await finish.run(state, abort.signal, (seconds, transition, transitions) => {
        task.progress = { done: merged + Math.min(seconds, finish.length), total: merged + finish.length, part: 0, parts: 0, transition, transitions };
        this.#plugin.update();
      });
    } catch (error) {
      if (abort.signal.aborted || (error as { code?: string }).code === "aborted") return "";
      throw error;
    }
  }

  async cancel(task: Task) {
    if (terminal(task)) return;
    task.cancel = true;
    if (task.abort) {
      // The plugin's own step: its ffmpeg ends, the work files go.
      task.status = "cancelling";
      task.abort.abort();
    } else if (task.active) {
      task.status = "cancelling";
      await task.active.cancel().catch((error) => console.error(`[clipexport] cancel: ${error}`));
    } else if (task.status === "queued") {
      task.status = "cancelled";
      task.ended = Date.now();
      this.#retain(task);
    }
  }

  /** Deactivation: the SDK cancels jobs and releases snapshots. */
  async stop() {
    this.#stopped = true;
    for (const task of this.list) {
      task.cancel = true;
      clearTimeout(task.retentionTimer);
    }
  }
}
