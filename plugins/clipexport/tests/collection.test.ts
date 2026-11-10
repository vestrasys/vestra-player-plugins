import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { Locale } from "@vestra-player/sdk";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import { exportParts, lengthClock, listKey, moved, partsOf, partStates, partTicks, retryDelay } from "../collection.ts";
import activate from "../main.ts";
import { clock, REASON } from "../model.ts";
import { dateOf } from "../names.ts";
import { eventually, words } from "./fakes.ts";

const ID = "zysilm.clipexport";
const directory = new URL("..", import.meta.url);
const start = (host = new TestHost(), locale: Locale = "en", dataDirectory?: string) => startPlugin(activate, { directory, host, locale, dataDirectory });
const tab = (host: TestHost) => host.mounted().props;
type Row = { id: string; number: number; name: string; range: string; badge: string; current: boolean; state: string; selected: boolean; thumb: unknown };
const rows = (host: TestHost) => (tab(host).parts ?? []) as Row[];
const names = (host: TestHost) => rows(host).map((row) => row.name);
/** The Collection page has no status line: a problem of an action is said on screen (the OSD). */
const said = (host: TestHost, text: string) => until(() => host.osd.includes(text), `"${text}" on screen`);
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
    assert.equal(host.osd.some((line) => line.startsWith("Added")), false, "a button press needs no message: the row is there");
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
  // The capture is a full frame; ffmpeg scales it to twice the row's size (max side 256).
  host.tools.handle("ffmpeg", () => ({ stdout: Buffer.from("small jpeg") }));
  const { stop } = await start(host, "en", data);
  try {
    await add(host, "5", "8");
    await until(() => host.exports.some((e) => e.kind === "rawJpeg"), "the thumbnail export");
    const jpeg = host.exports.find((e) => e.kind === "rawJpeg")!;
    assert.ok(String(jpeg.destination).startsWith(join(data, "parts")), "in the plugin's data directory");
    await until(() => rows(host)[0]?.thumb !== null && rows(host)[0]?.thumb !== undefined, "the row's picture");
    const snapshot = [...host.sent("snapshot.capture")].at(-1)!;
    assert.equal(snapshot.time, 5, "at the part's start");
    const scale = host.tools.calls.find((call) => call.tool === "ffmpeg")!;
    assert.ok(scale.args.some((arg) => arg.startsWith("scale=256:144:")), "max side 256");
    assert.ok(scale.args.includes("-i"), "from the captured frame");
    const files = await readdir(join(data, "parts"));
    assert.deepEqual(files.length, 1, "the full frame is deleted, the small one kept");
    assert.equal(await readFile(join(data, "parts", files[0]!), "utf8"), "small jpeg");
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
    await said(host, REASON.addLocal);
    host.openElsewhere("https://example.com/live.m3u8");
    host.setSource({ duration: 60 });
    host.mounted().emit("add-part", "1", "2");
    await said(host, REASON.addLocal);
    await host.command("clip.collection").run();
    await host.settle();
    await eventually(() => tab(host)["add-from"], { can: false, name: "live.m3u8", duration: "01:00.000", length: "", next: 1, full: false }, "the stream's name, greyed, and why");
    play(host, "/media/one.mp4", 30);
    host.mounted().emit("add-part", "5", "1");
    await said(host, REASON.endBeforeStart);
    host.mounted().emit("add-part", "20", "40");
    await said(host, REASON.outOfRange);
    assert.equal(host.sent("media.sources.remember").length, 0, "nothing remembered for a refused range");
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
    await said(again, REASON.collectionFull);
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
    await showCollection(host);
    host.mounted().emit("select-part", a);
    await eventually(() => rows(host).find((row) => row.id === a)?.selected, true);
    // Another page in front: the selection goes, Delete removes nothing it cannot see.
    host.mounted().emit("set-page", 0);
    await eventually(() => rows(host).find((row) => row.id === a)?.selected, false);
    assert.equal(host.command("clip.collectionRemove").state.enabled, false, "not on the Collection page");
    assert.equal(rows(host).length, 3);
    host.mounted().emit("set-page", 1);
    host.mounted().emit("select-part", a);
    await until(() => host.command("clip.collectionRemove").state.enabled, "Delete enabled with a selection on the page");
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
    await eventually(() => tab(host).blocking, { shown: true, part: "1", problem: "changed" });
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
    await eventually(() => tab(host).blocking, { shown: true, part: "2", problem: "range" });
    await eventually(() => rows(host).map((row) => row.state), ["ok", "range"]);
    // A file without video (sound only) cannot be a part of a video.
    host.mounted().emit("remove-part", rows(host)[1]!.id);
    await eventually(() => rows(host).length, 1);
    host.mediaFiles.set("/media/sound.m4a", { duration: 60, video: null });
    play(host, "/media/sound.m4a");
    await add(host, "1", "2");
    host.mounted().emit("export-merged");
    await eventually(() => tab(host).blocking, { shown: true, part: "2", problem: "noVideo" });
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
    await said(host, REASON.partMissing);
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
        await said(host, REASON.noCapability);
        assert.equal(rows(host).length, 0);
      } else {
        await add(host, "1", "2");
        host.mounted().emit("preview-part", rows(host)[0]!.id);
        await said(host, REASON.noCapability);
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
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the finished message");
    // The file goes after the check: the job ends source-missing, said as the plugin's reason.
    host.exportFailure = { code: "source-missing", message: "gone" };
    host.mounted().emit("export-merged");
    await said(host, `Export failed: ${REASON.partMissing}`);
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

/** A held answer: `release()` lets it through. */
function gate() {
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  return { held, release };
}
const describeToken = (token: string) => ({ token, name: "x.mp4", duration: 60, status: "ok", video: null, audio: null });

test("token queue: a file added while the session's tidy runs keeps its token (remember gives the same token for the same file)", async () => {
  const host = new TestHost();
  // Left by an earlier session: no part names it, so the tidy forgets it.
  host.sourceReferences.set("left-over", { path: "/media/one.mp4", version: 0 });
  const list = gate();
  let asked = false;
  host.handle("media.sources.list", async () => {
    asked = true;
    await list.held;
    return [...host.sourceReferences.keys()].map(describeToken);
  });
  // The playlist's tab in front first: the tidy (and its held list) starts only when the user shows this tab.
  host.mountOther("sidebar", "vestra.playlist", { title: "Playlist" });
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    // Not showCollection (its host.settle() would wait for the held list).
    host.selectTab(ID);
    await until(() => asked, "the tidy's list");
    // Without the queue, remember would answer "left-over" now and the tidy would forget it under the new part.
    host.mounted().emit("add-part", "1", "2");
    // Not host.settle(): it would wait for the held answer.
    await new Promise((done) => setTimeout(done, 100));
    list.release();
    await until(() => rows(host).length === 1, "the part");
    await eventually(() => rows(host)[0]!.state, "ok", "the part's file is still known to the player");
    assert.deepEqual([...host.sourceReferences.values()].map((ref) => ref.path), ["/media/one.mp4"], "one reference: the part's");
  } finally {
    list.release();
    await stop();
  }
});

test("token queue: the same file added while Undo's expiry forgets the cleared parts' files keeps its token", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  let forget: ReturnType<typeof gate> | undefined;
  try {
    await add(host, "1", "2");
    host.mounted().emit("clear-parts");
    await eventually(() => rows(host).length, 0);
    forget = gate();
    host.handle("media.sources.forget", async (p) => {
      await forget!.held;
      host.sourceReferences.delete(String(p.token));
    });
    play(host, "/media/two.mp4");
    await add(host, "3", "4");
    // A second Clear ends the first one's Undo: one.mp4's token is being forgotten (held)…
    host.mounted().emit("clear-parts");
    await until(() => host.sent("media.sources.forget").length === 1, "the expiry's forget");
    // …while the user adds one.mp4 again.
    play(host, "/media/one.mp4");
    host.mounted().emit("add-part", "5", "6");
    await new Promise((done) => setTimeout(done, 100));
    forget.release();
    await until(() => rows(host).length === 1, "the new part");
    await eventually(() => rows(host)[0]!.state, "ok", "its file is known: the forget came first, remember made a new token");
    assert.ok([...host.sourceReferences.values()].some((ref) => ref.path === "/media/one.mp4"));
  } finally {
    forget?.release();
    await stop();
  }
});

test("a merged export keeps its parts' files: removing the part while the job runs forgets nothing", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  const { cleanup } = await withFolder(host);
  try {
    await add(host, "1", "3");
    host.mounted().emit("export-merged");
    await until(() => partsExports(host).length === 1, "the merged export");
    host.mounted().emit("remove-part", rows(host)[0]!.id);
    await eventually(() => rows(host).length, 0);
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export finished with its file");
    await host.settle();
    assert.equal(host.sent("media.sources.forget").length, 0, "the job's token was never forgotten");
  } finally {
    await stop();
    await cleanup();
  }
});

test("Undo Clear never drops parts: with no room it is refused with the reason and stays offered", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const full = { parts: Array.from({ length: 100 }, (_, i) => ({ id: `p${i + 1}`, token: "t", name: "a.mp4", start: i, end: i + 1, thumb: "" })) };
  await writeFile(join(data, "collection.json"), JSON.stringify(full));
  const host = new TestHost();
  play(host, "/media/one.mp4", 300);
  const { stop } = await start(host, "en", data);
  try {
    await eventually(() => rows(host).length, 100);
    host.mounted().emit("clear-parts");
    await eventually(() => rows(host).length, 0);
    await add(host, "1", "2");
    await host.command("clip.collectionUndo").run();
    await said(host, REASON.undoFull);
    assert.equal(rows(host).length, 1, "the new part stays");
    assert.equal(host.command("clip.collectionUndo").state.enabled, true, "Undo is still offered");
    host.mounted().emit("remove-part", rows(host)[0]!.id);
    await eventually(() => rows(host).length, 0);
    await host.command("clip.collectionUndo").run();
    await eventually(() => rows(host).length, 100, "all hundred back");
  } finally {
    await stop();
    await rm(data, { recursive: true, force: true });
  }
});

test("Export As: the extension follows the format: Precise writes .mp4 even when .mkv was typed", async () => {
  const host = new TestHost();
  host.mediaFiles.set("/media/wide.mp4", { duration: 60, video: { codec: "h264", width: 1920, height: 818, fps: 24, pixelFormat: "yuv420p" } });
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  const folder = await mkdtemp(join(tmpdir(), "clipexport-as-"));
  try {
    await add(host, "1", "2");
    play(host, "/media/wide.mp4");
    await add(host, "3", "4");
    await eventually(() => tab(host)["collection-method-index"], 1, "Precise");
    host.dialogAnswers.push([join(folder, "joined.mkv")]);
    host.mounted().emit("export-merged-as");
    await until(() => partsExports(host).length === 1, "the merged export");
    assert.equal(partsExports(host)[0]!.destination, join(folder, "joined.mp4"));
    // The Clip page's Export As follows the same rule.
    host.mounted().emit("set-method", 1);
    host.dialogAnswers.push([join(folder, "clip.mkv")]);
    host.mounted().emit("export-as", "1", "4");
    await until(() => host.sent("jobs.start").some((s) => s.kind === "rawMp4" && s.snapshotId !== undefined), "the clip export");
    assert.equal(host.sent("jobs.start").find((s) => s.kind === "rawMp4" && s.snapshotId !== undefined)!.destination, join(folder, "clip.mp4"));
  } finally {
    await stop();
    await rm(folder, { recursive: true, force: true });
  }
});

test("a check the player answers busy is retried with a growing wait, five times at most: no request loop", async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(retryDelay), [300, 600, 1200, 2400, 4800, null, null]);
  const host = new TestHost();
  host.handle("jobs.check", () => {
    throw new HostError("busy", "four requests running");
  });
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await add(host, "1", "2");
    await new Promise((done) => setTimeout(done, 1200));
    const checks = host.sent("jobs.check").length;
    assert.ok(checks >= 2 && checks <= 3, `${checks} checks in 1.2 s (first, then after 0.3 and 0.9 s)`);
    // An export asks once more itself and says why it could not start.
    host.mounted().emit("export-merged");
    await said(host, `Export failed: ${REASON.busy}`);
    assert.equal(partsExports(host).length, 0);
  } finally {
    await stop();
  }
});