import { Worker } from "node:worker_threads";

/**
 * Runs a script from YouTube's player (the signature and `n` transforms that
 * youtubei.js extracts) and returns what it returns. youtubei.js does not run
 * the player's code itself (`Platform.shim.eval`); we run it in a worker
 * thread, so it never sees this plugin's state, cannot block the plugin, and
 * is stopped after `timeoutMs`. A worker is not a security boundary (the code
 * still runs in this Node process); the point is isolation from our state
 * and a hard time and memory limit. The worker is written inline because the
 * package bundles everything into one entry file.
 */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
let result;
try {
  result = { ok: true, value: new Function(workerData)() };
} catch (error) {
  result = { ok: false, message: error instanceof Error ? error.message : String(error) };
}
try {
  parentPort.postMessage(result);
} catch {
  parentPort.postMessage({ ok: false, message: "the player script returned a value that cannot be copied" });
}
`;

export function evaluate(code: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: code,
      resourceLimits: { maxOldGenerationSizeMb: 128 },
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`the player script took longer than ${timeoutMs} ms`))),
      timeoutMs,
    );
    worker.once("message", (message: { ok: boolean; value?: unknown; message?: string }) =>
      finish(() =>
        message.ok ? resolve(message.value) : reject(new Error(`the player script failed: ${message.message}`)),
      ),
    );
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => finish(() => reject(new Error(`the player script stopped (exit ${code})`))));
  });
}
