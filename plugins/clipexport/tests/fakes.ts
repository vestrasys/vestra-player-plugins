import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HostError } from "@vestra-player/sdk/testing";
import type { TestHost } from "@vestra-player/sdk/testing";
import { REASON } from "../model.ts";
import type { Reason } from "../model.ts";

export type Fakes = {
  /** Paths given to `system.openPath`, newest last. */
  opened: string[];
  failOpen: boolean;
};

export const newFakes = (): Fakes => ({ opened: [], failOpen: false });

/** The test host's `system.openPath`, observed (and failed on demand) through `fakes`. */
export function watchHost(host: TestHost, fakes: Fakes) {
  Object.assign(fakes, newFakes());
  host.handle("system.openPath", (p) => {
    if (fakes.failOpen) throw new HostError("failed", "open failed");
    fakes.opened.push(String(p.path));
  });
}

/**
 * The player's check of an export's destination folder, which the test host
 * does not make: the player accepts the job, then ends it `failed` when the
 * destination's folder is not there (src/host/src/playback/media_worker.rs for
 * a clip or a frame, media_join.rs for parts; Clip Export 0.6.0 on a fresh
 * install). Destinations are paths on this computer: give the plugin real
 * folders (a temporary data directory, a temporary clip folder).
 */
export function checkDestinations(host: TestHost) {
  type Request = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  const wire = host as unknown as { request: Request };
  const request = wire.request.bind(host);
  wire.request = async (method, params = {}) => {
    const reply = await request(method, params);
    if (method !== "jobs.start" || existsSync(dirname(String(params.destination)))) return reply;
    const job = host.jobs.get((reply as { jobId: number }).jobId);
    const what = params.parts === undefined ? "PNG destination" : "destination";
    if (job) Object.assign(job, { status: "failed", outcome: { error: { code: "export-failed", message: `${what} directory is unavailable: The system cannot find the file specified. (os error 2)` } } });
    return reply;
  };
}

type Status = { kind: string; reason: string; raw: string; name: string };
const STATES: Record<string, string> = {
  queued: "Queued",
  preparing: "Preparing",
  running: "Exporting",
  cancelling: "Cancelling",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const STATUS: Record<string, string> = {
  exported: "Exported {}",
  "clip-failed": "Export failed: {}",
  "no-destination": "No save location chosen.",
  "clip-started": "Export started. Follow it in Results.",
  restarted: "Restarted.",
};

/**
 * What the tab shows for the plugin's data, in the test host's language: a
 * mirror of `Words` in ui/parts.slint (the test host does not run Slint), with
 * the same English templates looked up in the plugin's catalog.
 */
export function words(host: TestHost) {
  const t = (text: string, args?: (string | number)[]) => host.translate(text, args);
  const reason = (code: string, raw: string) => (code ? t(REASON[code as Reason]) : raw);
  const state = (status: string) => (STATES[status] ? t(STATES[status]) : status);
  const status = (s: Status) => {
    if (s.kind === "error") return reason(s.reason, s.raw);
    const template = STATUS[s.kind];
    if (!template) return "";
    return t(template, s.kind === "exported" ? [s.name] : s.kind === "clip-failed" ? [reason(s.reason, s.raw)] : undefined);
  };
  return { reason, state, status, STATES, STATUS };
}

/**
 * Wait until `read()` gives `expected` (deep, strict equality), then pass; fail
 * after about 6 s with the last value and `message`. The tab's values arrive in
 * the plugin's own updates, after the condition a test waited for: assert on
 * the value itself, never right after waiting on another one. A value already
 * there passes at once; a read that throws (a row not there yet) is retried.
 */
export async function eventually(read: () => unknown, expected: unknown, message?: string) {
  let last: unknown;
  let failure: unknown;
  for (let i = 0; i < 1200; i++) {
    try {
      last = read();
      failure = undefined;
      if (isDeepStrictEqual(last, expected)) return;
    } catch (error) {
      failure = error;
    }
    await new Promise((done) => setTimeout(done, 5));
  }
  if (failure) throw failure;
  if (message === undefined) assert.deepStrictEqual(last, expected);
  else assert.deepStrictEqual(last, expected, message);
}
