import type { ExportJob, JobState, Scope, Snapshot } from "@vestra-player/sdk";
import { Failure, jobProblem } from "./model.ts";
import type { JobReason, Problem, Spec } from "./model.ts";
import { actualRange, clipExport, jobProgress } from "./seams.ts";

/** An accepted export: one frozen snapshot, one export job. */
export interface Task {
  id: string;
  spec: Spec;
  sourceId: number;
  source: string;
  snapshot?: Snapshot;
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
  /** The running job's progress in seconds of media (R4); `null` while unknown. */
  progress: { done: number; total: number } | null;
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
    case "space":
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
export function timeLeft(task: Pick<Task, "progress" | "rateFrom">, now = Date.now()): number {
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
            if (state.status === "completed" && state.outcome && "destination" in state.outcome) {
              task.output = state.outcome.destination;
              task.actual = actualRange(state, { start: task.spec.start, end: task.spec.end });
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
    if (!task.snapshot) throw new Failure("released");
    const { spec } = task;
    const job = await task.snapshot.export(clipExport(task.destination, spec.end, spec.method, spec.encode));
    task.active = job;
    task.jobs.push(job);
    if (task.cancel || this.#stopped) await job.cancel().catch(() => {});
    const show = (state: JobState) => {
      // A job the player has not started yet is still this task's preparation (the task left the plugin's queue).
      task.status = TERMINAL.includes(state.status) ? "running" : state.status === "queued" ? "preparing" : state.status;
      task.progress = jobProgress(state);
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

  async cancel(task: Task) {
    if (terminal(task)) return;
    task.cancel = true;
    if (task.active) {
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
