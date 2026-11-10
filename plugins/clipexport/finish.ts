import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { JobState, Scope } from "@vestra-player/sdk";
import { Failure, uniqueFile } from "./model.ts";
import type { Finish } from "./tasks.ts";
import { mergedLengths, progressTime, timeoutFor, timing, transitionArgs, transitionAt } from "./transitions.ts";
import type { Plan } from "./transitions.ts";

/** The progress file is read this often while the transitions are written. */
const POLL_MS = 500;
let serial = 0;

/** The file ffmpeg writes before it becomes the destination: hidden beside it, so a failure leaves no half video under the user's name. */
export const partialOf = (destination: string) => join(dirname(destination), `.${basename(destination)}.partial`);

/** ffprobe's bit rate of the merged file's video (the "Same as source" final encode aims at it); null when it does not say. */
async function videoBitrate(plugin: Scope, file: string, signal: AbortSignal) {
  try {
    const { stdout } = await plugin.tools.run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=bit_rate:format=bit_rate", "-of", "default=nw=1", file], { timeoutMs: 15_000, maxOutput: 4096, signal });
    const text = new TextDecoder().decode(stdout);
    const values = [...text.matchAll(/bit_rate=(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0);
    return values[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The plugin's step of a merged export with transitions (design ruling: no
 * host change). The player writes the plain merge into `<dataDirectory>/work`;
 * this runs the player's ffmpeg over it (`plugin.tools.run`) with the
 * junctions' `xfade` / `acrossfade` and the Precise settings, into a hidden
 * file beside the destination that becomes the destination when it is
 * complete. Progress comes from ffmpeg's `-progress` file; the signal ends it.
 * Every work file goes on every end (`cleanup`).
 */
export function finisher(plugin: Scope, workFolder: string) {
  return (plan: unknown, destination: string): Finish => {
    const p = plan as Plan;
    const merged = join(workFolder, `merge-${Date.now()}-${++serial}.mp4`);
    const progress = `${merged}.progress`;
    const partial = partialOf(destination);
    const planned = timing(p.lengths, p.transitions, p.fps);
    let written = "";
    return {
      merged,
      length: planned.written / p.fps,
      plan: p,
      async run(state: JobState, signal: AbortSignal, report) {
        await mkdir(workFolder, { recursive: true });
        // The player's own file name for the merge, if it changed it.
        const input = state.outcome && "destination" in state.outcome ? state.outcome.destination : merged;
        const lengths = mergedLengths(state as never, p.lengths);
        const bitrate = p.encode.rate === "source" ? await videoBitrate(plugin, input, signal) : null;
        const { args, length } = transitionArgs({ input, output: partial, progress, lengths, transitions: p.transitions, fps: p.fps, audio: p.audio, encode: p.encode, bitrate });
        const t = timing(lengths, p.transitions, p.fps);
        const count = t.overlaps.filter((o) => o > 0).length;
        const poll = setInterval(() => {
          void readFile(progress, "utf8").then(
            (text) => {
              const at = progressTime(text);
              if (at !== null) report(at, transitionAt(t.offsets, t.overlaps, p.fps, at), count);
            },
            () => {},
          );
        }, POLL_MS);
        poll.unref?.();
        report(0, count ? 1 : 0, count);
        try {
          await plugin.tools.run("ffmpeg", args, { timeoutMs: timeoutFor(length), maxOutput: 1 << 20, signal });
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "aborted" || signal.aborted) throw error;
          console.error(`[clipexport] transitions: ${code}: ${(error as Error).message}`);
          throw new Failure(code === "unavailable" ? "noFfmpeg" : "transitionFailed");
        } finally {
          clearInterval(poll);
        }
        // Cancelled as ffmpeg ended: nothing becomes the destination.
        if (signal.aborted) throw Object.assign(new Error("cancelled"), { code: "aborted" });
        // The name may have been taken while it ran: never over an existing file.
        written = await uniqueFile(destination);
        await rename(partial, written);
        return written;
      },
      async cleanup() {
        await Promise.all([merged, progress, partial].map((file) => rm(file, { force: true }).catch(() => {})));
      },
    };
  };
}
