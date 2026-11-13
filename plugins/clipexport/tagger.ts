import { Worker } from "node:worker_threads";
import type { Tag } from "./sounds.ts";

/**
 * The sound model on its own thread (tagger-worker.ts): started for a scan
 * and ended with it, so its memory (about 100 MB) is held only while a scan
 * runs. One request at a time.
 */
export interface Tagger {
  /** Tags of `samples` (16 kHz mono) that start `t` seconds into the video, one per 10 s. */
  tag(samples: Float32Array, t: number): Promise<Tag[]>;
  close(): Promise<void>;
}

/** A failure of the model itself (it would not start on this computer, or gave no answer): the page offers Loudness Only. */
export class ModelError extends Error {}

/** The worker's file: the transpiled `.js` in a package, the `.ts` itself when run from source (tests). */
const workerUrl = () => new URL(import.meta.url.endsWith(".ts") ? "./tagger-worker.ts" : "./tagger-worker.js", import.meta.url);

/** Start the model with the runtime's and the model's bytes (both checked by the caller). */
export function startTagger(wasm: Uint8Array, model: Uint8Array, signal: AbortSignal): Promise<Tagger> {
  return new Promise((resolve, reject) => {
    // The model and its runtime take about 100 MB; the limit stops a runaway well before the player feels it.
    const worker = new Worker(workerUrl(), { workerData: { role: "clipexport-tagger" }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let ready = false;
    let waiting: { id: number; resolve: (tags: Tag[]) => void; reject: (error: Error) => void } | null = null;
    let next = 0;
    let ended: Error | null = null;
    const end = (error: Error) => {
      if (ended) return;
      ended = error;
      signal.removeEventListener("abort", aborted);
      void worker.terminate();
      if (!ready) reject(error);
      waiting?.reject(error);
      waiting = null;
    };
    const aborted = () => end(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    worker.on("message", (message: { type: string; id?: number; tags?: Tag[]; message?: string }) => {
      if (message.type === "ready" && !ready) {
        ready = true;
        resolve({
          tag(samples, t) {
            if (ended) return Promise.reject(ended);
            if (waiting) return Promise.reject(new Error("one request at a time"));
            const id = ++next;
            // Its own buffer, handed over whole (a view into a larger one would move the rest too).
            if (samples.byteOffset !== 0 || samples.byteLength !== samples.buffer.byteLength) samples = samples.slice();
            return new Promise<Tag[]>((done, failed) => {
              waiting = { id, resolve: done, reject: failed };
              worker.postMessage({ type: "tag", id, samples, t }, [samples.buffer as ArrayBuffer]);
            });
          },
          async close() {
            end(new Error("closed"));
          },
        });
      } else if (message.type === "tags" && waiting && waiting.id === message.id) {
        const done = waiting.resolve;
        waiting = null;
        done(message.tags ?? []);
      } else if (message.type === "error") {
        if (!ready || message.id === undefined) end(new ModelError(message.message ?? "the sound model failed"));
        else if (waiting?.id === message.id) {
          const { reject: failed } = waiting;
          waiting = null;
          failed(new ModelError(message.message ?? "the sound model failed"));
        }
      }
    });
    worker.on("error", (error: Error) => end(new ModelError(error.message)));
    worker.on("exit", (code) => end(new ModelError(`the sound model stopped (exit ${code})`)));
    // Copies: the caller keeps its buffers (they are checked again on the next scan only by their stamp).
    const wasmCopy = wasm.slice().buffer;
    const modelCopy = model.slice().buffer;
    worker.postMessage({ type: "init", wasm: wasmCopy, model: modelCopy }, [wasmCopy, modelCopy]);
  });
}
