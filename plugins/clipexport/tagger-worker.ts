import { parentPort, workerData } from "node:worker_threads";
import { CLASS_COUNT, features, pieces, SAMPLE_RATE, soundsOf, BANDS } from "./sounds.ts";
import type { Tag } from "./sounds.ts";

/**
 * The sound model's thread (tagger.ts starts it): ONNX Runtime Web's
 * WebAssembly build, one thread, so the plugin's own thread stays free for
 * the page. Its JavaScript ships in vendor/onnxruntime-web/ (MIT); the
 * WebAssembly file and the model are the downloaded ones, checked against
 * their pinned SHA-256 by the plugin before they are handed over here as
 * bytes (nothing is read from disk or the network in this thread).
 *
 * Messages in: `{ type: "init", wasm, model }`, then `{ type: "tag", id,
 * samples, t }` (16 kHz mono floats; `t` the seconds where they start). Out:
 * `{ type: "ready" }` or `{ type: "error", message }`, and `{ type: "tags",
 * id, tags }` (one per 10 s) or `{ type: "error", id, message }`.
 */
type Message = { type: "init"; wasm: ArrayBuffer; model: ArrayBuffer } | { type: "tag"; id: number; samples: Float32Array; t: number };

type Ort = typeof import("./vendor/onnxruntime-web/ort.wasm.bundle.min.mjs");
type Session = Awaited<ReturnType<Ort["InferenceSession"]["create"]>>;

const port = parentPort;
if (port && (workerData as { role?: string } | null)?.role === "clipexport-tagger") {
  let ort: Ort | null = null;
  let session: Session | null = null;
  const fail = (error: unknown, id?: number) => port.postMessage({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
  port.on("message", async (message: Message) => {
    if (message.type === "init") {
      try {
        ort = await import("./vendor/onnxruntime-web/ort.wasm.bundle.min.mjs");
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.wasmBinary = message.wasm;
        session = await ort.InferenceSession.create(new Uint8Array(message.model), { graphOptimizationLevel: "all", executionMode: "sequential" });
        port.postMessage({ type: "ready" });
      } catch (error) {
        fail(error);
      }
      return;
    }
    if (!ort || !session) return fail(new Error("the sound model is not loaded"), message.id);
    try {
      const tags: Tag[] = [];
      for (const { offset, length } of pieces(message.samples.length)) {
        const { data, frames } = features(message.samples.subarray(offset, offset + length));
        const out = await session.run({ feats: new ort.Tensor("float32", data, [1, BANDS, frames]) });
        const prob = out.prob?.data as Float32Array | undefined;
        if (!prob || prob.length !== CLASS_COUNT) throw new Error("the sound model gave an unexpected answer");
        tags.push(soundsOf(prob, message.t + offset / SAMPLE_RATE));
      }
      port.postMessage({ type: "tags", id: message.id, tags });
    } catch (error) {
      fail(error, message.id);
    }
  });
}
