import { resolve } from "node:path";
import type { ExportPart, PlayerState, Scope, Snapshot } from "@vestra-player/sdk";
import { chooseAudio, Failure, uniqueFile, validate } from "./model.ts";
import type { Spec } from "./model.ts";
import type { Finish, Task, Tasks } from "./tasks.ts";

/** A host refusal of the snapshot as one of the plugin's reasons. */
export function captureError(error: unknown) {
  switch ((error as { code?: string }).code) {
    case undefined:
      return error;
    case "stale":
      return new Failure("changed");
    case "busy":
      return new Failure("busy");
    case "unavailable":
    case "unsupported":
      return new Failure("unavailable");
    default:
      console.error(`[clipexport] snapshot: ${(error as Error).message}`);
      return new Failure("captureFailed");
  }
}

/**
 * Freeze the input and queue the export. The snapshot is conditional on the
 * state the user acted on (`seen`), so a source change while a save panel was
 * open exports nothing. A retry reuses a retained snapshot when it has one.
 */
/** Builds the plugin's step of a merged export with transitions, for its final destination. */
export type Finisher = (plan: unknown, destination: string) => Finish;

export function capturer(plugin: Scope, tasks: Tasks, finisher?: Finisher) {
  const { player } = plugin;
  let stopped = false;

  /** `destination`: the clip's file, made unique (`name (1).mp4` when it exists). */
  async function start(spec: Spec, seen: PlayerState | null, destination: string, reuse?: Snapshot): Promise<Task> {
    if (tasks.full()) throw new Failure("queueFull");
    let snapshot = reuse;
    try {
      if (seen) {
        validate(spec, seen);
        const audio = chooseAudio(spec, seen);
        await player.refresh();
        if (!player.isCurrent(seen)) throw new Failure("changed");
        // A Fast cut copies the source's streams: it needs the raw input (`processed: false`).
        snapshot = await plugin.media
          .capture({ ifCurrent: seen, processed: spec.processed, subtitles: spec.processed && spec.subtitles, audio, at: spec.start })
          .catch((error) => {
            throw captureError(error);
          });
      }
      if (!snapshot) throw new Failure("expired");
      if (stopped) throw new Failure("cancelled");
      const target = await uniqueFile(destination, new Set(tasks.list.map((task) => resolve(task.destination))));
      const task = tasks.add({ spec: { ...spec, start: snapshot.time }, sourceId: seen?.sourceId ?? 0, source: snapshot.source, snapshot, destination: target });
      snapshot = undefined;
      return task;
    } finally {
      await snapshot?.dispose();
    }
  }

  /**
   * Queue a merged export of the Collection: the parts as they are now (a
   * snapshot of the list), into `destination` made unique. Nothing is frozen:
   * the player reads the remembered files when the job runs.
   */
  async function startParts(spec: Spec, parts: ExportPart[], destination: string, plan?: unknown): Promise<Task> {
    if (tasks.full()) throw new Failure("queueFull");
    if (stopped) throw new Failure("cancelled");
    const target = await uniqueFile(destination, new Set(tasks.list.map((task) => resolve(task.destination))));
    // With transitions, the player writes the plain merge into the work folder and the plugin's step writes `target`.
    const finish = plan && finisher ? finisher(plan, target) : undefined;
    return tasks.add({ spec, sourceId: 0, source: "", parts: parts.map((part) => ({ ...part })), destination: target, ...(finish ? { finish } : {}) });
  }

  /** Retry a failed or cancelled task: its retained input if still kept, otherwise the current source; a merged export its parts. */
  async function retry(task: Task) {
    if (task.parts) return startParts({ ...task.spec }, task.parts, task.destination, task.finish?.plan);
    if (tasks.retained(task)) {
      const snapshot = tasks.take(task);
      return start({ ...task.spec }, null, task.destination, snapshot).then((next) => {
        next.sourceId = task.sourceId;
        return next;
      });
    }
    return start({ ...task.spec }, await player.refresh(), task.destination);
  }

  return {
    start,
    startParts,
    retry,
    stop() {
      stopped = true;
    },
  };
}
