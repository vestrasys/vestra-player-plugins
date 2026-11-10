import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { Locale } from "@vestra-player/sdk";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import { exportParts, lengthClock, listKey, moved, partsOf, partStates, partTicks } from "../collection.ts";
import activate from "../main.ts";
import { clock } from "../model.ts";
import { dateOf } from "../names.ts";
import { eventually, words } from "./fakes.ts";

const ID = "zysilm.clipexport";
const directory = new URL("..", import.meta.url);
const start = (host = new TestHost(), locale: Locale = "en", dataDirectory?: string) => startPlugin(activate, { directory, host, locale, dataDirectory });
const tab = (host: TestHost) => host.mounted().props;
type Row = { id: string; number: number; name: string; range: string; badge: string; current: boolean; state: string; selected: boolean; thumb: unknown };
const rows = (host: TestHost) => (tab(host).parts ?? []) as Row[];
const names = (host: TestHost) => rows(host).map((row) => row.name);
const statusOf = (host: TestHost) => tab(host)["collection-status"] as { kind: string; reason: string; raw: string; name: string };
const tick = () => new Promise((done) => setTimeout(done, 5));
async function until(predicate: () => boolean | Promise<boolean>, what = "condition") {
  for (let i = 0; i < 1200; i++) {
    if (await predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}
/** A local file playing, ready, at 2 s. */
function play(host: TestHost, path: string, duration = 60) {
  host.openElsewhere(path);
  host.setSource({ position: 2, duration });
}
/** Mark Start and End (the Clip page's fields) and press Add to Collection; wait for the row. */
async function add(host: TestHost, from: string, to: string) {
  const count = rows(host).length;
  host.mounted().emit("add-part", from, to);
  await until(() => rows(host).length === count + 1, `part ${count + 1}`);
}
/** The tab in front, at the Collection page. */
async function showCollection(host: TestHost) {
  await host.command("clip.collection").run();
  await host.settle();
  await eventually(() => tab(host).page, 1);
}
/** A temporary clip folder chosen through Clip Folder…. */
async function withFolder(host: TestHost) {
  const folder = await mkdtemp(join(tmpdir(), "clipexport-collection-"));
  host.dialogAnswers.push([folder]);
  await host.command("clip.folder").run();
  await until(() => host.osd.at(-1) === host.translate("Clip folder: {}", [folder]), "the clip folder");
  return { folder, cleanup: () => rm(folder, { recursive: true, force: true }) };
}
const partsExports = (host: TestHost) => host.exports.filter((e) => Array.isArray(e.parts));
const tokenOf = (host: TestHost, path: string) => [...host.sourceReferences].find(([, ref]) => ref.path === path)?.[0];

test("vertical slice: the marked range of two files becomes two parts; Export Merged writes one file of both, in order", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  const { folder, cleanup } = await withFolder(host);
  try {
    await showCollection(host);
    await eventually(() => (tab(host)["add-from"] as { name: string }).name, "one.mp4", "Add from names the file playing");
    await add(host, "1", "4");
    await eventually(() => statusOf(host).kind, "added");
    play(host, "/media/two.mp4", 30);
    await add(host, "10", "12.5");
    assert.deepEqual(names(host), ["one.mp4", "two.mp4"]);
    assert.deepEqual(rows(host).map((row) => [row.number, row.range, row.badge]), [
      [1, `${clock(1)} – ${clock(4)}`, "3.0"],
      [2, `${clock(10)} – ${clock(12.5)}`, "2.5"],
    ]);
    await eventually(() => rows(host).map((row) => row.current), [false, true], "the file playing in the playing colour");
    await eventually(() => tab(host)["collection-info"], { count: 2, total: lengthClock(5.5), checked: true, undo: false });
    await eventually(() => (tab(host).copy as { ok: boolean }).ok, true, "two files a copy can join");
    assert.equal(tab(host)["collection-method-index"], 0, "Fast");
    host.mounted().emit("export-merged");
    await until(() => partsExports(host).length === 1, "the merged export");
    const job = partsExports(host)[0]!;
    assert.equal(job.kind, "rawCopy");
    assert.deepEqual(job.parts, [
      { source: tokenOf(host, "/media/one.mp4"), start: 1, end: 4 },
      { source: tokenOf(host, "/media/two.mp4"), start: 10, end: 12.5 },
    ]);
    assert.equal(basename(String(job.destination)), `one_collection_${dateOf(new Date())}.mp4`, "{name}_collection_{date}: the first part's file");
    assert.ok(String(job.destination).startsWith(folder), "into the clip folder");
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the finished message");
    await eventually(() => statusOf(host).kind, "exported");
    await eventually(() => (tab(host).results as { state: string }[]).map((row) => row.state), ["completed"]);
    await eventually(() => (tab(host).results as { badge: string; method: string }[]).map((row) => [row.badge, row.method]), [["5.5", "fast"]], "the result holds both parts");
    assert.deepEqual(names(host), ["one.mp4", "two.mp4"], "the Collection is kept after the export");
  } finally {
    await stop();
    await cleanup();
  }
});

test("thumbnails: the part's first frame, captured while its file plays, into the data directory", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const { stop } = await start(host, "en", data);
  try {
    await add(host, "5", "8");
    await until(() => host.exports.some((e) => e.kind === "rawJpeg"), "the thumbnail export");
    const jpeg = host.exports.find((e) => e.kind === "rawJpeg")!;
    assert.ok(String(jpeg.destination).startsWith(join(data, "parts")), "in the plugin's data directory");
    await until(() => rows(host)[0]?.thumb !== null && rows(host)[0]?.thumb !== undefined, "the row's picture");
    const snapshot = [...host.sent("snapshot.capture")].at(-1)!;
    assert.equal(snapshot.time, 5, "at the part's start");
    assert.equal(partsExports(host).length, 0, "no export of parts");
  } finally {
    await stop();
    await rm(data, { recursive: true, force: true });
  }
});

test("add: only a local file with a valid range; the 101st part is refused", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  const { stop } = await start(host, "en", data);
  try {
    host.mounted().emit("add-part", "1", "2");
    await eventually(() => statusOf(host).reason, "addLocal", "nothing playing");
    host.openElsewhere("https://example.com/live.m3u8");
    host.setSource({ duration: 60 });
    host.mounted().emit("add-part", "1", "2");
    await eventually(() => statusOf(host).reason, "addLocal", "a stream");
    play(host, "/media/one.mp4", 30);
    host.mounted().emit("add-part", "5", "1");
    await eventually(() => statusOf(host).reason, "endBeforeStart");
    host.mounted().emit("add-part", "20", "40");
    await eventually(() => statusOf(host).reason, "outOfRange");
    assert.equal(host.sent("media.sources.remember").length, 0, "nothing remembered for a refused range");
    await host.command("clip.collection").run();
    await host.settle();
    // English source texts for what the tab shows (Words in ui/parts.slint).
    assert.equal(words(host).reason("addLocal", ""), "Only local files can be added to the Collection.");
  } finally {
    await stop();
  }
  // A Collection of 100 parts (stored): Add is refused before anything is remembered.
  const full = { parts: Array.from({ length: 100 }, (_, i) => ({ id: `p${i + 1}`, token: "t", name: "a.mp4", start: i, end: i + 1, thumb: "" })) };
  await writeFile(join(data, "collection.json"), JSON.stringify(full));
  const again = new TestHost();
  play(again, "/media/one.mp4", 300);
  const second = await start(again, "en", data);
  try {
    await eventually(() => rows(again).length, 100);
    again.mounted().emit("add-part", "1", "2");
    await eventually(() => statusOf(again).reason, "collectionFull");
    assert.equal(again.sent("media.sources.remember").length, 0);
  } finally {
    await second.stop();
    await rm(data, { recursive: true, force: true });
  }
});

test("reorder, select and Delete, remove: the list is renumbered, kept on disk, and unused files are forgotten", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host, "en", data);
  try {
    await add(host, "1", "2");
    await add(host, "3", "4");
    play(host, "/media/two.mp4");
    await add(host, "5", "6");
    const [a, b, c] = rows(host).map((row) => row.id);
    host.mounted().emit("move-part", c, 0);
    await eventually(() => rows(host).map((row) => [row.id, row.number]), [[c, 1], [a, 2], [b, 3]]);
    const stored = async () => JSON.parse(await readFile(join(data, "collection.json"), "utf8")).parts.map((p: { id: string }) => p.id);
    await until(async () => JSON.stringify(await stored().catch(() => [])) === JSON.stringify([c, a, b]), "the order on disk");
    // Delete removes the selected part while the list has the focus (a panel key).
    assert.deepEqual(host.command("clip.collectionRemove").declaration.bindings, ["Delete"]);
    assert.equal(host.command("clip.collectionRemove").declaration.focus, "panel");
    assert.equal(host.command("clip.collectionRemove").state.enabled, false, "nothing selected");
    host.mounted().emit("select-part", a);
    await eventually(() => rows(host).find((row) => row.id === a)?.selected, true);
    await host.command("clip.collectionRemove").run();
    await eventually(() => rows(host).map((row) => row.id), [c, b]);
    assert.equal(host.sent("media.sources.forget").length, 0, "one.mp4 is still used by another part");
    host.mounted().emit("remove-part", b);
    await eventually(() => rows(host).map((row) => row.id), [c]);
    await until(() => host.sent("media.sources.forget").length === 1, "the unused file forgotten");
    assert.equal(host.sourceReferences.has(String(host.sent("media.sources.forget")[0]!.token)), false);
    assert.deepEqual([...host.sourceReferences.values()].map((ref) => ref.path), ["/media/two.mp4"]);
    await until(async () => JSON.stringify(await stored().catch(() => [])) === JSON.stringify([c]), "kept on disk");
  } finally {
    await stop();
    await rm(data, { recursive: true, force: true });
  }
});

test("Clear empties the list at once and offers Undo on the message; Undo brings the parts back", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await add(host, "1", "2");
    await add(host, "3", "4");
    const ids = rows(host).map((row) => row.id);
    host.mounted().emit("clear-parts");
    await eventually(() => rows(host).length, 0);
    await until(() => host.osd.at(-1) === "Collection cleared.", "the message");
    assert.equal(host.command("clip.collectionUndo").state.enabled, true);
    await host.pressOsdAction(0);
    await eventually(() => rows(host).map((row) => row.id), ids, "Undo");
    assert.equal(host.sent("media.sources.forget").length, 0, "nothing forgotten while Undo was offered");
    assert.equal(host.command("clip.collectionUndo").state.enabled, false);
  } finally {
    await stop();
  }
});

test("missing and changed files: the row says so with Locate…, the footer says why Export is greyed, Locate… rebinds the file", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await showCollection(host);
    await add(host, "1", "2");
    play(host, "/media/two.mp4");
    await add(host, "3", "4");
    await eventually(() => tab(host).blocking, { shown: false, part: "", problem: "" });
    // two.mp4 is moved away: an export is refused with the reason, and the row shows File missing.
    host.mediaFiles.set("/media/two.mp4", { status: "missing" });
    host.mounted().emit("export-merged");
    await eventually(() => statusOf(host), { kind: "blocked", reason: "missing", raw: "", name: "2" });
    await eventually(() => tab(host).blocking, { shown: true, part: "2", problem: "missing" }, "Export stays greyed while it stands");
    await eventually(() => rows(host).map((row) => row.state), ["ok", "missing"]);
    assert.equal(partsExports(host).length, 0, "nothing started");
    assert.equal(host.translate("Part {} is missing: locate it or remove it", [2]), "Part 2 is missing: locate it or remove it");
    // Locate…: the player's own dialog; the file picked stands for the part from then on.
    host.dialogAnswers.push(["/media/moved/two-renamed.mp4"]);
    host.mounted().emit("locate-part", rows(host)[1]!.id);
    await eventually(() => names(host), ["one.mp4", "two-renamed.mp4"]);
    await eventually(() => rows(host).map((row) => row.state), ["ok", "ok"]);
    await eventually(() => (tab(host).blocking as { shown: boolean }).shown, false);
    // one.mp4 is rewritten: changed.
    host.mediaFiles.set("/media/one.mp4", { version: 1 });
    host.mounted().emit("export-merged");
    await eventually(() => statusOf(host), { kind: "blocked", reason: "changed", raw: "", name: "1" });
    await eventually(() => rows(host).map((row) => row.state), ["changed", "ok"]);
    // The Locate dialog cancelled: nothing changes.
    host.dialogAnswers.push(null);
    host.mounted().emit("locate-part", rows(host)[0]!.id);
    await host.settle();
    await eventually(() => rows(host).map((row) => row.state), ["changed", "ok"]);
  } finally {
    await stop();
  }
});

test("export check: a part outside its file or without video blocks; different sizes mean Precise, with the reason line", async () => {
  const host = new TestHost();
  host.mediaFiles.set("/media/wide.mp4", { duration: 60, video: { codec: "h264", width: 1920, height: 818, fps: 24, pixelFormat: "yuv420p" } });
  host.mediaFiles.set("/media/uhd.mp4", { duration: 60, video: { codec: "h264", width: 3840, height: 1714, fps: 24, pixelFormat: "yuv420p" } });
  play(host, "/media/uhd.mp4");
  const { stop } = await start(host);
  const { folder, cleanup } = await withFolder(host);
  try {
    await showCollection(host);
    await add(host, "1", "3");
    play(host, "/media/wide.mp4");
    await add(host, "4", "6");
    await eventually(() => tab(host).copy, { checked: true, ok: false, part: "2", field: "size", value: "1920×818", expected: "3840×1714", container: "" });
    await eventually(() => tab(host)["collection-method-index"], 1, "Precise while Fast cannot join them");
    await eventually(() => (tab(host).target as { size: string }).size, "3840×1714", "the first part's size");
    host.mounted().emit("export-merged");
    await until(() => partsExports(host).length === 1, "the merged export");
    const job = partsExports(host)[0]!;
    assert.equal(job.kind, "rawMp4");
    assert.ok(job.encoding, "the Clip page's encoder settings");
    assert.ok(String(job.destination).startsWith(folder));
    // The file got shorter: the part is outside it.
    host.mediaFiles.set("/media/wide.mp4", { duration: 5, video: { codec: "h264", width: 1920, height: 818, fps: 24, pixelFormat: "yuv420p" } });
    host.mounted().emit("export-merged");
    await eventually(() => statusOf(host), { kind: "blocked", reason: "range", raw: "", name: "2" });
    await eventually(() => rows(host).map((row) => row.state), ["ok", "range"]);
    // A file without video (sound only) cannot be a part of a video.
    host.mounted().emit("remove-part", rows(host)[1]!.id);
    await eventually(() => rows(host).length, 1);
    host.mediaFiles.set("/media/sound.m4a", { duration: 60, video: null });
    play(host, "/media/sound.m4a");
    await add(host, "1", "2");
    host.mounted().emit("export-merged");
    await eventually(() => statusOf(host), { kind: "blocked", reason: "noVideo", raw: "", name: "2" });
    await eventually(() => rows(host).map((row) => row.state), ["ok", "noVideo"]);
    assert.equal(partsExports(host).length, 1, "only the first export started");
  } finally {
    await stop();
    await cleanup();
  }
});

test("double-click previews a part: its file opens at the part's start and Start / End become the part; a missing file says so", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await add(host, "7.25", "9");
    play(host, "/media/two.mp4");
    const [part] = rows(host);
    host.mounted().emit("preview-part", part!.id);
    await until(() => host.sourceOpens.length === 1, "the open");
    assert.deepEqual(host.sourceOpens[0], { token: tokenOf(host, "/media/one.mp4"), start: 7.25 });
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"]], [clock(7.25), clock(9)]);
    await eventually(() => rows(host)[0]!.selected, true);
    host.mediaFiles.set("/media/one.mp4", { status: "missing" });
    host.mounted().emit("preview-part", part!.id);
    await eventually(() => statusOf(host).reason, "partMissing");
    assert.equal(host.sourceOpens.length, 1, "nothing opened");
  } finally {
    await stop();
  }
});

test("capability errors: without media.sources nothing is remembered; without playback.control no preview", async () => {
  const all = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8")).capabilities as string[];
  for (const [missing, action] of [["media.sources", "add"], ["playback.control", "preview"]] as const) {
    const host = new TestHost();
    play(host, "/media/one.mp4");
    const { stop } = await startPlugin(activate, { directory, host, id: ID, capabilities: all.filter((c) => c !== missing), locale: "en" });
    try {
      if (action === "add") {
        host.mounted().emit("add-part", "1", "2");
        await eventually(() => statusOf(host).reason, "noCapability");
        assert.equal(rows(host).length, 0);
      } else {
        await add(host, "1", "2");
        host.mounted().emit("preview-part", rows(host)[0]!.id);
        await eventually(() => statusOf(host).reason, "noCapability");
        assert.equal(host.sourceOpens.length, 0);
      }
    } finally {
      await stop();
    }
  }
});

test("a merged export runs in the queue: the progress card says which part, ticks at the joins; a part gone meanwhile fails with the reason", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  const { cleanup } = await withFolder(host);
  try {
    await add(host, "0", "4");
    await add(host, "10", "12");
    await add(host, "20", "22");
    host.mounted().emit("export-merged");
    await eventually(() => {
      const card = tab(host).card as { shown: boolean; parts: number; part: number; ticks: string };
      return card.shown && card.parts === 3 && card.part > 0 ? card.ticks : null;
    }, partTicks([4, 2, 2]), "part 2 of 3, ticks at 50 % and 75 %");
    assert.equal(partTicks([4, 2, 2]), "M 500 0 V 10 M 750 0 V 10");
    await eventually(() => statusOf(host).kind, "exported");
    // The file goes after the check: the job ends source-missing, said as the plugin's reason.
    host.exportFailure = { code: "source-missing", message: "gone" };
    host.mounted().emit("export-merged");
    await eventually(() => statusOf(host), { kind: "clip-failed", reason: "partMissing", raw: "", name: "" });
  } finally {
    await stop();
    await cleanup();
  }
});

test("the Collection is kept across restarts; a token the player no longer knows reads as such", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const first = await start(host, "en", data);
  try {
    await add(host, "1", "2");
    await add(host, "3", "5");
  } finally {
    await first.stop();
  }
  // Another player profile (a new test host): the parts come back, their tokens are unknown to it.
  const again = new TestHost();
  play(again, "/media/other.mp4");
  const second = await start(again, "en", data);
  try {
    await eventually(() => names(again), ["one.mp4", "one.mp4"]);
    await showCollection(again);
    await eventually(() => rows(again).map((row) => row.state), ["unknown", "unknown"]);
    await eventually(() => tab(again).blocking, { shown: true, part: "1", problem: "unknown" });
  } finally {
    await second.stop();
    await rm(data, { recursive: true, force: true });
  }
});

test("Collection logic: stored parts, moves, the check's states, ticks and lengths", () => {
  const stored = { parts: [{ id: "p1", token: "a", name: "x.mp4", start: 1, end: 2, thumb: "../evil.jpg" }, { id: "p1", token: "b", start: 0, end: 1 }, { id: "p2", token: "", start: 0, end: 1 }, { id: "p3", token: "c", start: 3, end: 2 }, { id: "p4", token: "d", start: 0, end: 4, thumb: "p4-1.jpg" }] };
  assert.deepEqual(partsOf(stored), [
    { id: "p1", token: "a", name: "x.mp4", start: 1, end: 2, thumb: "" },
    { id: "p4", token: "d", name: "", start: 0, end: 4, thumb: "p4-1.jpg" },
  ]);
  assert.deepEqual(partsOf(null), []);
  assert.deepEqual(moved([1, 2, 3, 4], 3, 0), [4, 1, 2, 3]);
  assert.deepEqual(moved([1, 2, 3, 4], 0, 9), [2, 3, 4, 1]);
  assert.deepEqual(exportParts(partsOf(stored)), [{ source: "a", start: 1, end: 2 }, { source: "d", start: 0, end: 4 }]);
  assert.notEqual(listKey([{ source: "a", start: 1, end: 2 }]), listKey([{ source: "a", start: 1, end: 3 }]));
  const check = { blocking: [{ part: 1, problem: "missing" }, { part: 1, problem: "range" }, { part: 0, problem: "changed" }], copy: { ok: true, container: "mp4" }, encode: null, duration: 1 } as never;
  assert.deepEqual(partStates(check, 3), ["changed", "missing", "ok"]);
  assert.deepEqual(partStates(null, 2), ["ok", "ok"]);
  assert.equal(partTicks([5]), "");
  assert.equal(lengthClock(62.24), "1:02.2");
  assert.equal(lengthClock(3725), "1:02:05.0");
});

test("Settings: the Collection's file-name template; chips and Default name work on it", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await showCollection(host);
    await eventually(() => tab(host)["collection-template"], "{name}_collection_{date}");
    host.mounted().emit("collection-template-edited", "{name}-joined");
    await eventually(() => tab(host)["collection-preview"], "one-joined.mp4");
    host.mounted().emit("insert-collection-variable", "{n}");
    await eventually(() => tab(host)["collection-template"], "{name}-joined{n}");
    host.mounted().emit("reset-collection-template");
    await eventually(() => tab(host)["collection-template"], "{name}_collection_{date}");
    assert.equal(tab(host).template, "{name}_{start}-{end}", "the clip template is its own");
  } finally {
    await stop();
  }
});
