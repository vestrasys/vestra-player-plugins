import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate from "../main.ts";
import { eventually } from "./fakes.ts";

/**
 * Video effects and burned-in subtitles reach the player through the
 * snapshot (`media.capture({ processed, subtitles })`, on the wire
 * `snapshot.capture` `mode` / `includeSubtitles`); the export request only
 * follows it (`jobs.start` `kind`: `processedMp4` from a processed snapshot).
 * Precise carries them when the Advanced switches are on; Fast and the
 * Collection's merged export never do.
 */
const directory = new URL("..", import.meta.url);
const start = (host: TestHost) => startPlugin(activate, { directory, host, locale: "en" });
const tab = (host: TestHost) => host.mounted().props;
const tick = () => new Promise((done) => setTimeout(done, 5));
async function until(predicate: () => boolean, what = "condition") {
  for (let i = 0; i < 1200; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}
async function withFolder(host: TestHost) {
  const folder = await mkdtemp(join(tmpdir(), "clipexport-precise-"));
  host.dialogAnswers.push([folder]);
  await host.command("clip.folder").run();
  await until(() => host.osd.at(-1) === host.translate("Clip folder: {}", [folder]), "the clip folder");
  return { folder, cleanup: () => rm(folder, { recursive: true, force: true }) };
}
/** Set the Advanced switches, export 0:01–0:03 from the Clip page, and give the capture and the export request it sent. */
async function exportWith(host: TestHost, method: 0 | 1, processed: boolean, burn: boolean) {
  const panel = host.mounted();
  const count = host.sent("jobs.start").length;
  panel.emit("set-method", method);
  panel.emit("set-processed", processed);
  panel.emit("set-burn", burn);
  await host.settle();
  await eventually(() => [tab(host)["method-index"], tab(host).processed, tab(host).burn], [method, processed, burn]);
  panel.emit("export-clip", "0:01", "0:03");
  await until(() => host.sent("jobs.start").length === count + 1, `export ${count + 1}`);
  return { capture: host.sent("snapshot.capture").at(-1)!, job: host.sent("jobs.start").at(-1)! };
}
/** What of the capture says effects and subtitles; `includeSubtitles` is absent from a raw capture. */
const effectsOf = (capture: Record<string, unknown>) => [capture.mode, capture.includeSubtitles];

test("Precise clip: effects and subtitles go with the snapshot exactly when their switches are on", async () => {
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 30 });
  const { stop } = await start(host);
  const { cleanup } = await withFolder(host);
  try {
    // Off: the raw input, a plain re-encode.
    let sent = await exportWith(host, 1, false, false);
    assert.deepEqual(effectsOf(sent.capture), ["raw", undefined]);
    assert.equal(sent.job.kind, "rawMp4");
    // Subtitles on alone burn nothing: they need the effects (the switch is under them).
    sent = await exportWith(host, 1, false, true);
    assert.deepEqual(effectsOf(sent.capture), ["raw", undefined], "subtitles without effects are not sent");
    assert.equal(sent.job.kind, "rawMp4");
    // Effects on, subtitles off.
    sent = await exportWith(host, 1, true, false);
    assert.deepEqual(effectsOf(sent.capture), ["processed", false]);
    assert.equal(sent.job.kind, "processedMp4");
    // Effects and subtitles on.
    sent = await exportWith(host, 1, true, true);
    assert.deepEqual(effectsOf(sent.capture), ["processed", true]);
    assert.equal(sent.job.kind, "processedMp4");
    for (const job of host.sent("jobs.start")) {
      assert.ok(job.encoding, "every Precise clip has the tab's encoder settings");
      assert.ok(!("processed" in job) && !("subtitles" in job), "the export request itself has no effects fields");
    }
  } finally {
    await stop();
    await cleanup();
  }
});

test("Fast clip: a stream copy of the raw input, whatever the effects and subtitles switches say", async () => {
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 30 });
  const { stop } = await start(host);
  const { cleanup } = await withFolder(host);
  try {
    for (const [processed, burn] of [[false, false], [true, false], [true, true]] as const) {
      const { capture, job } = await exportWith(host, 0, processed, burn);
      assert.deepEqual(effectsOf(capture), ["raw", undefined], `effects ${processed}, subtitles ${burn}`);
      assert.equal(job.kind, "rawCopy");
      assert.equal(job.encoding, undefined);
    }
  } finally {
    await stop();
    await cleanup();
  }
});

test("Precise merged export of the Collection: no effects or subtitles, even with their switches on", async () => {
  const host = new TestHost();
  // Two sizes: the merge must re-encode (Precise).
  host.mediaFiles.set("/media/wide.mp4", { duration: 60, video: { codec: "h264", width: 1920, height: 818, fps: 24, pixelFormat: "yuv420p" } });
  host.mediaFiles.set("/media/uhd.mp4", { duration: 60, video: { codec: "h264", width: 3840, height: 1714, fps: 24, pixelFormat: "yuv420p" } });
  host.openElsewhere("/media/uhd.mp4");
  host.setSource({ position: 2, duration: 60 });
  const { stop } = await start(host);
  const { cleanup } = await withFolder(host);
  try {
    const panel = host.mounted();
    panel.emit("set-method", 1);
    panel.emit("set-processed", true);
    panel.emit("set-burn", true);
    await host.settle();
    await eventually(() => [tab(host).processed, tab(host).burn], [true, true]);
    const parts = () => (tab(host).parts ?? []) as unknown[];
    panel.emit("add-part", "1", "3");
    await until(() => parts().length === 1, "part 1");
    host.openElsewhere("/media/wide.mp4");
    host.setSource({ position: 2, duration: 60 });
    await host.settle();
    panel.emit("add-part", "4", "6");
    await until(() => parts().length === 2, "part 2");
    await eventually(() => tab(host)["collection-method-index"], 1, "Precise");
    const captures = host.sent("snapshot.capture").length;
    panel.emit("export-merged");
    const merged = () => host.exports.filter((e) => Array.isArray(e.parts));
    await until(() => merged().length === 1, "the merged export");
    const job = merged()[0]!;
    assert.equal(job.kind, "rawMp4", "a re-encode of the plain parts");
    assert.ok(job.encoding, "with the tab's encoder settings");
    assert.ok(!("processed" in job) && !("subtitles" in job) && !("includeSubtitles" in job));
    assert.equal(job.snapshotId, undefined, "the parts are read from their files, not from a snapshot");
    assert.ok(host.sent("snapshot.capture").slice(captures).every((capture) => capture.mode === "raw"), "no processed snapshot for the merge");
  } finally {
    await stop();
    await cleanup();
  }
});
