import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { JobState, Scope } from "@vestra-player/sdk";
import { Failure, uniqueFile } from "./model.ts";
import type { Finish } from "./tasks.ts";
import { animatedArgs, lastFrameTime } from "./animated.ts";
import type { AnimatedPass } from "./animated.ts";
import { anyTransition, estimated, layoutOf, parsePts, progressTime, ptsArgs, spaceNeeded, timeoutFor, timing, transitionArgs, transitionAt } from "./transitions.ts";
import type { Layout, Plan } from "./transitions.ts";

/** The progress file is read this often while the transitions are written. */
const POLL_MS = 500;
let serial = 0;

/** The file ffmpeg writes before it becomes the destination: hidden beside it, so a failure leaves no half video under the user's name. */
export const partialOf = (destination: string) => join(dirname(destination), `.${basename(destination)}.partial`);

/** What the step needs from the plugin besides ffmpeg: the free space beside a file (a seam for tests), the record of files being written. */
export interface FinishEnv {
  freeSpace?: (folder: string) => Promise<number>;
  inflight?: Inflight;
}

/**
 * The half files being written beside the user's videos, kept in the data
 * directory while ffmpeg runs: a crash or a kill leaves their names behind,
 * and the next start deletes them ({@link sweepWork}).
 */
export interface Inflight {
  add(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(): string[];
}
export function inflightStore(plugin: Scope): Inflight {
  type Store = { value: { partials: unknown[] }; save(next: { partials: string[] }): void; flush(): Promise<void> };
  let store: Store | null = null;
  try {
    store = plugin.storage.json<{ partials: unknown[] }>("inflight", { defaults: { partials: [] }, validate: (v): v is { partials: unknown[] } => Array.isArray((v as { partials?: unknown })?.partials) }) as unknown as Store;
  } catch {
    // no data directory: nothing to remember
  }
  // Only the hidden names this plugin writes are ever deleted from the record.
  const ours = (path: unknown): path is string => typeof path === "string" && /^\..+\.partial$/.test(basename(path));
  let partials = (store?.value.partials ?? []).filter(ours);
  const save = async () => {
    store?.save({ partials: [...partials] });
    await store?.flush().catch(() => {});
  };
  return {
    async add(path) {
      partials = [...partials.filter((p) => p !== path), path];
      await save();
    },
    async remove(path) {
      partials = partials.filter((p) => p !== path);
      await save();
    },
    list: () => [...partials],
  };
}

/**
 * The work folder, made when it is missing, before anything writes into it: a
 * fresh install has none, and the player refuses a destination whose folder
 * is not there ("destination directory is unavailable"). Every write into it,
 * the player's clip or merge as well as the plugin's palette, graph and
 * progress files, waits for this; it costs one call when the folder is there.
 */
export const workReady = (folder: string) => mkdir(folder, { recursive: true }).then(() => folder);

/**
 * At activation, before any task runs: what a crash or a kill left. The work
 * folder holds only the plugin's own files (merges, the player's temporary
 * files of them, progress and graph files), so it is emptied; the half files
 * recorded beside the user's videos are deleted.
 */
export async function sweepWork(workFolder: string, inflight: Inflight) {
  for (const name of await readdir(workFolder).catch(() => [] as string[])) await rm(join(workFolder, name), { recursive: true, force: true }).catch(() => {});
  for (const partial of inflight.list()) {
    await rm(partial, { force: true }).catch(() => {});
    await inflight.remove(partial);
  }
}

/** ffprobe's bit rate of the merged file's video timestamps; null when it cannot tell. */
async function measure(plugin: Scope, file: string, lengths: readonly number[], signal: AbortSignal): Promise<Layout | null> {
  try {
    const { stdout } = await plugin.tools.run("ffprobe", ptsArgs(file), { timeoutMs: 120_000, maxOutput: 64 << 20, signal });
    const layout = layoutOf(parsePts(new TextDecoder().decode(stdout)), lengths);
    // ffmpeg reads the file from its start time (the earliest stream's): the sound is cut on that clock.
    const begin = await plugin.tools.run("ffprobe", ["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", file], { timeoutMs: 15_000, maxOutput: 4096, signal }).then(
      ({ stdout: out }) => Number(new TextDecoder().decode(out).trim()),
      () => 0,
    );
    return layout && Number.isFinite(begin) && begin !== 0 ? { frames: layout.frames, times: layout.times.map((t) => Math.max(0, t - begin)) } : layout;
  } catch (error) {
    if (signal.aborted) throw error;
    console.error(`[clipexport] probe of the merge: ${(error as Error).message}`);
    return null;
  }
}

const defaultFree = async (folder: string) => {
  const s = await statfs(folder);
  return Number(s.bavail) * Number(s.bsize);
};

/**
 * The plugin's step of a merged export with transitions (design ruling: no
 * host change), and of an animated GIF or WebP of a clip or a merge (0.5.0,
 * animated.ts). The player writes the plain merge (or the clip) into `<dataDirectory>/work`;
 * this measures where each part is in it (ffprobe of the frame timestamps),
 * writes the filter graph into a file there, checks the free space beside
 * the destination and runs the player's ffmpeg (`plugin.tools.run`) into a
 * hidden file beside the destination, which becomes the destination when it
 * is complete. Progress comes from ffmpeg's `-progress` file; the signal ends
 * it. Every work file goes on every end (`cleanup`).
 */
export function finisher(plugin: Scope, workFolder: string, env: FinishEnv = {}) {
  const freeSpace = env.freeSpace ?? defaultFree;
  return (plan: unknown, destination: string): Finish => {
    const p = plan as Plan;
    const merged = join(workFolder, `merge-${Date.now()}-${++serial}.mp4`);
    const progress = `${merged}.progress`;
    const script = `${merged}.graph`;
    const partial = partialOf(destination);
    // A GIF's palette (its first run) and that run's graph, progress and frame-times files.
    const palette = `${merged}.palette.png`;
    const planned = timing(p.lengths, p.transitions, p.fps);
    return {
      merged,
      ready: () => workReady(workFolder).then(() => merged),
      length: planned.written / p.fps,
      plan: p,
      async run(state: JobState, signal: AbortSignal, report) {
        await workReady(workFolder);
        // The player's own file name for the merge, if it changed it.
        const input = state.outcome && "destination" in state.outcome ? state.outcome.destination : merged;
        // The merge (Precise) writes each part for its length as asked (-t), whatever its frames: the windows to measure.
        const asked = p.lengths;
        // An animated image of a clip or a merge without transitions takes the whole file: nothing to measure.
        const blends = anyTransition(p.transitions);
        const layout = (blends || !p.output ? await measure(plugin, input, asked, signal) : null) ?? estimated(asked, p.fps);
        // The runs in order: one for the transitions and for WebP, two for a GIF (the palette first).
        const { passes, length }: { passes: AnimatedPass[]; length: number } = p.output
          ? animatedArgs({
            input, output: partial, progress, script, palette, format: p.output, ...(p.encoder ? { encoder: p.encoder } : {}),
            transitions: blends ? { lengths: layout, transitions: p.transitions, fps: p.fps } : null, length: planned.written / p.fps,
          })
          : (() => {
            const built = transitionArgs({ input, output: partial, progress, script, lengths: layout, transitions: p.transitions, fps: p.fps, audio: p.audio, encode: p.encode, bitrate: p.bitrate });
            return { passes: [{ args: built.args, graph: built.graph, script, progress }], length: built.length };
          })();
        if (!p.output && p.encode.rate === "source" && !(p.bitrate && p.bitrate > 0)) throw new Failure("noSourceBitrate");
        // Room for the final file beside the destination: about the merge's size.
        const mergeBytes = (await stat(input).catch(() => null))?.size ?? 0;
        const free = await freeSpace(dirname(destination)).catch(() => Infinity);
        if (free < spaceNeeded(mergeBytes)) throw new Failure("space");
        const t = timing(layout, p.transitions, p.fps);
        const count = t.overlaps.filter((o) => o > 0).length;
        // The progress of run `index` of n: each run is an equal share of the output's seconds.
        let index = 0;
        const poll = setInterval(() => {
          const pass = passes[index];
          if (!pass) return;
          const done = index;
          // The GIF palette run: the time of the last frame it read (its one picture is written at the end).
          void readFile(pass.times ?? pass.progress, "utf8").then(
            (text) => {
              const at = pass.times ? lastFrameTime(text) : progressTime(text);
              if (at !== null && done === index) report((done * length + Math.min(at, length)) / passes.length, transitionAt(t.offsets, t.overlaps, p.fps, at), count);
            },
            () => {},
          );
        }, POLL_MS);
        poll.unref?.();
        report(0, count ? 1 : 0, count);
        await env.inflight?.add(partial);
        try {
          for (; index < passes.length; index++) {
            const pass = passes[index]!;
            await writeFile(pass.script, pass.graph);
            await plugin.tools.run("ffmpeg", pass.args, { timeoutMs: timeoutFor(length), maxOutput: 1 << 20, signal });
            if (signal.aborted) break;
          }
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "aborted" || signal.aborted) throw error;
          console.error(`[clipexport] ${p.output ?? "transitions"}: ${code}: ${(error as Error).message}`);
          if (p.output) throw new Failure(code === "unavailable" ? "noAnimatedFfmpeg" : "animatedFailed");
          throw new Failure(code === "unavailable" ? "noFfmpeg" : "transitionFailed");
        } finally {
          clearInterval(poll);
        }
        // Cancelled as ffmpeg ended: nothing becomes the destination.
        if (signal.aborted) throw Object.assign(new Error("cancelled"), { code: "aborted" });
        // The name may have been taken while it ran: never over an existing file.
        const written = await uniqueFile(destination);
        await rename(partial, written);
        return written;
      },
      async cleanup() {
        await Promise.all([merged, progress, script, partial, palette, `${palette}.graph`, `${palette}.progress`, `${palette}.times`].map((file) => rm(file, { force: true }).catch(() => {})));
        await env.inflight?.remove(partial).catch(() => {});
      },
    };
  };
}
