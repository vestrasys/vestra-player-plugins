import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { Locale } from "@vestra-player/sdk";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import { AGAIN_MS, exportParts, lengthClock, listKey, moved, overlapping, partsOf, partStates, partTicks, rangeIn, retryDelay, sameRange } from "../collection.ts";
import type { Part } from "../collection.ts";
import { CUT } from "../transitions.ts";
import activate from "../main.ts";
import { clock, parseTime, REASON } from "../model.ts";
import { dateOf } from "../names.ts";
import { checkDestinations, eventually, words } from "./fakes.ts";

const ID = "zysilm.clipexport";
const directory = new URL("..", import.meta.url);
const start = (host = new TestHost(), locale: Locale = "en", dataDirectory?: string) => (checkDestinations(host), startPlugin(activate, { directory, host, locale, dataDirectory }));
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
/** The tab in front at the Clip page, which holds the Collection (Show Collection). */
async function showCollection(host: TestHost) {
  await host.command("clip.collection").run();
  await host.settle();
  await eventually(() => tab(host).page, 0);
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
    await eventually(() => tab(host)["collection-info"], { count: 2, total: lengthClock(5.5), checked: true, undo: false, transitions: 0, saved: "0.0", off: false, switched: false });
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
    await eventually(() => tab(host)["add-from"], { can: false, name: "", duration: "01:00.000", length: "", next: 1, full: false, added: 0, overlaps: 0 }, "no title for a stream in the public API: no name, only why");
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
    // An add selects its part (design clipexport-collection A): the one added last.
    await eventually(() => rows(host).filter((row) => row.selected).map((row) => row.id), [c], "the part added last is selected");
    await showCollection(host);
    host.mounted().emit("select-part", a);
    await eventually(() => rows(host).find((row) => row.id === a)?.selected, true);
    // Another page in front: the selection goes, Delete removes nothing it cannot see.
    host.mounted().emit("set-page", 1);
    await eventually(() => rows(host).find((row) => row.id === a)?.selected, false);
    assert.equal(host.command("clip.collectionRemove").state.enabled, false, "not on the Clip page");
    assert.equal(rows(host).length, 3);
    host.mounted().emit("set-page", 0);
    await eventually(() => host.command("clip.collectionRemove").state.enabled, false, "nothing selected");
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

test("refusals: when the player refuses media.sources nothing is remembered; when it refuses the open no preview", async () => {
  // A refusal by who is asking (`builtin-only`, SDK 1.11.0): the player sends it only for built-in-only requests, but the plugin handles it wherever it comes.
  const refused = {
    add: ["media.sources.remember", "media.sources.get", "media.sources.locate", "media.sources.forget", "media.sources.list"],
    preview: ["media.sources.open"],
  };
  for (const action of ["add", "preview"] as const) {
    const host = new TestHost();
    for (const method of refused[action])
      host.handle(method, () => {
        throw new HostError("builtin-only", `${method} is not available`);
      });
    play(host, "/media/one.mp4");
    const { stop } = await startPlugin(activate, { directory, host, id: ID, locale: "en" });
    try {
      if (action === "add") {
        host.mounted().emit("add-part", "1", "2");
        await said(host, REASON.notAllowed);
        assert.equal(rows(host).length, 0);
      } else {
        await add(host, "1", "2");
        host.mounted().emit("preview-part", rows(host)[0]!.id);
        await said(host, REASON.notAllowed);
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
    { id: "p1", token: "a", name: "x.mp4", start: 1, end: 2, thumb: "", transition: { kind: "cut", dir: "left", duration: 1 } },
    { id: "p4", token: "d", name: "", start: 0, end: 4, thumb: "p4-1.jpg", transition: { kind: "cut", dir: "left", duration: 1 } },
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
test("a part removed while Export As… waits for the save dialog keeps its file: the export holds its tokens before its first await", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  const folder = await mkdtemp(join(tmpdir(), "clipexport-as-"));
  const dialog = gate();
  let asked = false;
  try {
    await add(host, "1", "3");
    host.handle("dialogs.open", async () => {
      asked = true;
      await dialog.held;
      return { cancelled: false, paths: [join(folder, "joined")] };
    });
    host.mounted().emit("export-merged-as");
    await until(() => asked, "the save dialog");
    host.mounted().emit("remove-part", rows(host)[0]!.id);
    await eventually(() => rows(host).length, 0);
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(host.sent("media.sources.forget").length, 0, "not forgotten while the dialog is open");
    dialog.release();
    await until(() => partsExports(host).length === 1, "the merged export");
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export finished with its file");
    assert.equal(partsExports(host)[0]!.destination, join(folder, "joined.mp4"));
  } finally {
    dialog.release();
    await stop();
    await rm(folder, { recursive: true, force: true });
  }
});

test("Export As… cancelled after the part was removed: the hold ends and the unused file is forgotten", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  const dialog = gate();
  let asked = false;
  try {
    await add(host, "1", "3");
    host.handle("dialogs.open", async () => {
      asked = true;
      await dialog.held;
      return { cancelled: true, paths: [] };
    });
    host.mounted().emit("export-merged-as");
    await until(() => asked, "the save dialog");
    host.mounted().emit("remove-part", rows(host)[0]!.id);
    await eventually(() => rows(host).length, 0);
    dialog.release();
    await until(() => host.sent("media.sources.forget").length === 1, "forgotten once nothing holds it");
    assert.equal(partsExports(host).length, 0);
  } finally {
    dialog.release();
    await stop();
  }
});
test("Start and End belong to their file: another file starts with none (no range carried over); a preview marks its part", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await showCollection(host);
    // Export Clip… fills the position → +10 s of this file.
    await host.command("clip.open").run();
    await host.settle();
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"]], [clock(2), clock(12)]);
    await add(host, String(tab(host)["clip-start"]), String(tab(host)["clip-end"]));
    // The next file: the fields are empty (their placeholders show), not the last file's 0:02–0:12.
    play(host, "/media/two.mp4", 30);
    await host.settle();
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"]], ["", ""], "no stale range on the new file");
    // Add Range to Collection (the key) with no marks on this file adds nothing and says why.
    await host.command("clip.collectionAdd").run();
    await said(host, REASON.time);
    assert.equal(rows(host).length, 1);
    // Export Clip… on the new file fills its own position → +10 s.
    host.setSource({ position: 7 });
    await host.command("clip.open").run();
    await host.settle();
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"]], [clock(7), clock(17)]);
    // Set Clip Start on a third file keeps no End of the second.
    play(host, "/media/three.mp4", 30);
    host.setSource({ position: 4 });
    await host.command("clip.start").run();
    await host.settle();
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"]], [clock(4), ""]);
    // Double-click a part: its file opens and its marks are the part's (not cleared as another file's).
    host.mounted().emit("preview-part", rows(host)[0]!.id);
    await until(() => host.sourceOpens.length === 1, "the open");
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"]], [clock(2), clock(12)]);
    await host.settle();
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"]], [clock(2), clock(12)], "still the part's after the tab follows the new source");
  } finally {
    await stop();
  }
});

test("the time fields fit beside Start and End: not the std LineEdit's 160 px minimum (two of them pushed End out of the tab)", async () => {
  const slint = await readFile(new URL("../ui/tab.slint", import.meta.url), "utf8");
  const field = /component Field inherits LineEdit \{[^}]*?min-width: (\d+)px;/.exec(slint);
  assert.ok(field, "Field sets its own minimum width");
  // "00:02.000" (clock()'s shortest time) is 54.4 px in Consolas 11 px; the field pads 12 + 12 px.
  assert.ok(Number(field![1]) >= Math.ceil(54.4 + 24), "a time shows whole");
  // The Range card's rows (one Start / End editor for the clip and the Collection): label, field, Now.
  for (const label of ["Start", "End"])
    assert.match(slint, new RegExp(String.raw`Label \{ text: @tr\("${label}"\); \}\s*Field \{`), label);
  // At the 280 px minimum: the page's padding (10 + 4) and scroll bar (12), the card's (11 + 8), the 52 px label,
  // the field, the Now button (8 + 14 + 5 + about 22 + 8 px) and two 4 px gaps.
  assert.ok(10 + 4 + 12 + 11 + 8 + 52 + Number(field![1]) + 57 + 8 <= 280);
});

test("an unset Start or End shows no time: the fields' hint is no range that could be read as set (Add to Collection stays off until one is)", async () => {
  const slint = await readFile(new URL("../ui/tab.slint", import.meta.url), "utf8");
  // Every field bound to the range (the Range card's Start and End), with its hint.
  const hints = [...slint.matchAll(/placeholder-text: "([^"]*)";[^}]*?text <=> ClipBridge\.clip-(start|end);/g)].map((m) => [m[2], m[1]!] as const);
  assert.deepEqual(hints.map(([field]) => field), ["start", "end"]);
  for (const [field, hint] of hints) assert.equal(parseTime(hint), null, `the ${field} field's hint "${hint}" reads as a time`);
  // Empty fields are no range: nothing to add (+ Add stays off), and the Range shows no length.
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await showCollection(host);
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"], (tab(host)["add-from"] as { can: boolean; length: string }).length], ["", "", ""]);
  } finally {
    await stop();
  }
});

test("Export Clip with a range and an empty Collection: enabled and the highlighted button; it never waits on the Collection", async () => {
  const host = new TestHost();
  play(host, "/media/bbb.mp4", 90);
  const { stop } = await start(host);
  try {
    await showCollection(host);
    host.setSource({ position: 74.667 });
    host.mounted().emit("clip-now", "start");
    await host.settle();
    host.setSource({ position: 77.833 });
    host.mounted().emit("clip-now", "end");
    await host.settle();
    // What the button's `enabled` reads, in the state of the GUI check (Fast, 01:14.667–01:17.833, nothing added).
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"], tab(host)["method-index"], tab(host)["clip-busy"], tab(host)["queue-full"], tab(host)["field-error"], (tab(host)["collection-info"] as { count: number }).count],
      [clock(74.667), clock(77.833), 0, false, false, "", 0]);
    const slint = await readFile(new URL("../ui/tab.slint", import.meta.url), "utf8");
    const button = slint.slice(slint.indexOf('text: @tr("Export Clip");') - 400, slint.indexOf('text: @tr("Export Clip");') + 600);
    assert.match(button, /primary: ClipBridge\.collection-info\.count == 0;/, "the gradient while the Collection is empty");
    assert.match(button, /enabled: !ClipBridge\.clip-busy && !ClipBridge\.queue-full && ClipBridge\.field-error == "";/, "nothing of the Collection disables it");
    // The footer: the count in bold.
    assert.match(slint, /@tr\("\{\} parts", ClipBridge\.collection-info\.count\);[^}]*font-weight: 700;/);
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------- is this range in the Collection? (design clipexport-collection, option A)

type AddFrom = { can: boolean; name: string; length: string; next: number; full: boolean; added: number; overlaps: number };
const addFrom = (host: TestHost) => tab(host)["add-from"] as AddFrom;
/** + Add's state: the part the Range is (0 none) and the first part it overlaps (0 none). */
const where = (host: TestHost) => [addFrom(host)?.added, addFrom(host)?.overlaps];
const reveal = (host: TestHost) => tab(host).reveal as { serial: number; row: number };
const selectedIds = (host: TestHost) => rows(host).filter((row) => row.selected).map((row) => row.id);
/** Type a range into Start and End (the tab sends what it shows). */
const typeRange = (host: TestHost, from: string, to: string) => host.mounted().emit("clip-edited", from, to);
const ALREADY = (n: number) => `Already in the Collection as part ${n}`;
/** A message shown since the OSD held `from` messages (one said before does not count). */
const saidSince = (host: TestHost, from: number, text: string) => until(() => host.osd.slice(from).includes(text), `"${text}" on screen again`);

test("match helpers: the same range is the same file (its token, else its name) and the same times to the millisecond, the end clamped as an add clamps it; an overlap is more than 1 ms of the same file", () => {
  const part = (fields: Partial<Part> = {}): Part => ({ id: "p1", token: "t1", name: "a.mp4", start: 10, end: 20, thumb: "", transition: { ...CUT }, ...fields });
  const byToken = { token: "t1", name: "a.mp4" };
  assert.equal(sameRange(part(), byToken, 10, 20), true);
  assert.equal(sameRange(part(), byToken, 10.0004, 19.9996), true, "within the millisecond the fields show");
  assert.equal(sameRange(part(), byToken, 10.001, 20), false, "+1 ms");
  assert.equal(sameRange(part(), byToken, 10, 19.999), false, "−1 ms");
  assert.equal(sameRange(part(), byToken, 10, 20.0004, 20), true, "the end clamped to the file's duration");
  assert.equal(sameRange(part({ end: 19.5 }), byToken, 10, 20, 19.5), true, "an end past the file is its duration, as the add stores it");
  assert.equal(sameRange(part(), byToken, 10, 20, 0), true, "no duration: no clamp");
  assert.equal(sameRange(part(), { token: "t2", name: "a.mp4" }, 10, 20), false, "same name, another token: another file");
  assert.equal(sameRange(part(), { token: null, name: "a.mp4" }, 10, 20), true, "token unknown: by name");
  assert.equal(sameRange(part(), { token: null, name: "b.mp4" }, 10, 20), false, "another name");
  assert.equal(sameRange(part(), { token: null, name: "" }, 10, 20), false, "no file");
  // Overlap: the same file, more than 1 ms in common, not the same range.
  assert.equal(overlapping(part(), byToken, 12, 15), true, "contained in the part");
  assert.equal(overlapping(part(), byToken, 5, 25), true, "containing the part");
  assert.equal(overlapping(part(), byToken, 15, 25), true, "partly");
  assert.equal(overlapping(part(), byToken, 20, 30), false, "adjacent is no overlap");
  assert.equal(overlapping(part(), byToken, 19.999, 30), false, "1 ms is no overlap");
  assert.equal(overlapping(part(), byToken, 19.998, 30), true, "2 ms");
  assert.equal(overlapping(part(), byToken, 10, 20), false, "the same range is no overlap");
  assert.equal(overlapping(part(), { token: "t2", name: "a.mp4" }, 12, 15), false, "another file");
  assert.equal(overlapping(part(), { token: null, name: "a.mp4" }, 12, 15), true, "by name while the token is unknown");
  // The part numbers (from 1): the first match; an overlap only when the range is no part.
  const parts = [part(), part({ id: "p2", start: 15, end: 25 }), part({ id: "p3" }), part({ id: "p4", token: "t2", start: 0, end: 100 })];
  assert.deepEqual(rangeIn(parts, byToken, 10, 20), { added: 1, overlaps: 0 }, "the first of two");
  assert.deepEqual(rangeIn(parts, byToken, 12, 14), { added: 0, overlaps: 1 });
  assert.deepEqual(rangeIn(parts, byToken, 21, 24), { added: 0, overlaps: 2 });
  assert.deepEqual(rangeIn(parts, byToken, 30, 40), { added: 0, overlaps: 0 }, "part 4 is another file");
  assert.deepEqual(rangeIn([], byToken, 10, 20), { added: 0, overlaps: 0 });
  assert.equal(AGAIN_MS, 10_000, "Add Again is offered for 10 s");
});

test("Added: while the Range is a part + Add reads Added (worked out on every pass): a millisecond, another file, Remove, Clear and Undo, a reorder and a restart change it at once; an overlap is only said", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host, "en", data);
  try {
    await showCollection(host);
    typeRange(host, "1", "4");
    await eventually(() => where(host), [0, 0], "an empty Collection");
    await add(host, "1", "4");
    await eventually(() => where(host), [1, 0], "the Range is part 1");
    typeRange(host, "1.001", "4");
    await eventually(() => where(host), [0, 1], "a millisecond later: + Add, overlapping part 1");
    typeRange(host, "4", "6");
    await eventually(() => where(host), [0, 0], "adjacent: no overlap");
    await add(host, "4", "6");
    await eventually(() => where(host), [2, 0]);
    typeRange(host, "1", "4");
    await eventually(() => where(host), [1, 0]);
    // A reorder: the number follows the part.
    host.mounted().emit("move-part", rows(host)[0]!.id, 1);
    await eventually(() => where(host), [2, 0], "part 1 is now part 2");
    // Another file: its own marks (none); the same times there are another file's.
    play(host, "/media/two.mp4");
    await eventually(() => where(host), [0, 0]);
    typeRange(host, "1", "4");
    await host.settle();
    await eventually(() => where(host), [0, 0], "two.mp4 has no part");
    // Back to one.mp4 (a new source): its marks were cleared; typed again, it is part 2 (by name until its token is known).
    play(host, "/media/one.mp4");
    typeRange(host, "1", "4");
    await eventually(() => where(host), [2, 0]);
    // Remove: + Add at once.
    const id = rows(host)[1]!.id;
    host.mounted().emit("remove-part", id);
    await eventually(() => where(host), [0, 0], "removed");
    await add(host, "1", "4");
    await eventually(() => where(host), [2, 0]);
    // Clear, then Undo: Added, Add, Added.
    host.mounted().emit("clear-parts");
    await eventually(() => where(host), [0, 0], "cleared");
    await until(() => host.osd.at(-1) === "Collection cleared.", "the message");
    await host.pressOsdAction(0);
    await eventually(() => where(host), [2, 0], "Undo");
  } finally {
    await stop();
  }
  // A restart: the parts are kept, the token of the file playing is not known yet: by name.
  const again = new TestHost();
  play(again, "/media/one.mp4");
  const second = await start(again, "en", data);
  try {
    await showCollection(again);
    await eventually(() => rows(again).length, 2);
    typeRange(again, "1", "4");
    await eventually(() => where(again), [2, 0], "after a restart");
    assert.equal(again.sent("media.sources.remember").length, 0, "nothing remembered to draw the button");
  } finally {
    await second.stop();
    await rm(data, { recursive: true, force: true });
  }
});

test("an add from the tab selects the new part and brings it into view; a click on Added adds nothing, shows that part and offers Add Again, which adds the duplicate as the last part", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await showCollection(host);
    await add(host, "1", "4");
    await eventually(() => reveal(host), { serial: 1, row: 0 });
    await add(host, "5", "6");
    await eventually(() => selectedIds(host), [rows(host)[1]!.id], "the new part is selected");
    await eventually(() => reveal(host), { serial: 2, row: 1 }, "and scrolled into view");
    assert.equal(host.osd.some((line) => line.startsWith("Added")), false, "a button press needs no message: the row is there");
    // The Range is part 1 (Added): a click shows it.
    typeRange(host, "1", "4");
    await eventually(() => where(host), [1, 0]);
    host.mounted().emit("add-part", "1", "4");
    await said(host, ALREADY(1));
    assert.deepEqual(host.osdActions.at(-1), [{ title: "Add Again", command: "clip.collectionAddAgain" }]);
    assert.equal(rows(host).length, 2, "nothing added");
    await eventually(() => selectedIds(host), [rows(host)[0]!.id], "part 1 selected");
    await eventually(() => reveal(host), { serial: 3, row: 0 }, "and scrolled into view");
    assert.equal(host.command("clip.collectionAddAgain").state.enabled, true, "offered");
    assert.equal(host.sourceReferences.size, 1, "one file reference");
    // Add Again: the duplicate as the last part.
    await host.pressOsdAction(0);
    await eventually(() => rows(host).map((row) => row.range), [`${clock(1)} – ${clock(4)}`, `${clock(5)} – ${clock(6)}`, `${clock(1)} – ${clock(4)}`]);
    await until(() => host.osd.at(-1) === "Added as part 3", "said from the message");
    await eventually(() => selectedIds(host), [rows(host)[2]!.id]);
    assert.equal(host.command("clip.collectionAddAgain").state.enabled, false, "offered once");
    await eventually(() => where(host), [1, 0], "the first of the two");
    // Offered for the file it was refused on: another file playing by then adds nothing.
    const shownBefore = host.osd.length;
    host.mounted().emit("add-part", "1", "4");
    await saidSince(host, shownBefore, ALREADY(1));
    assert.equal(host.command("clip.collectionAddAgain").state.enabled, true);
    play(host, "/media/two.mp4");
    await host.settle();
    await host.command("clip.collectionAddAgain").run();
    await said(host, REASON.changed);
    assert.equal(rows(host).length, 3);
  } finally {
    await stop();
  }
});

test("Add Range to Collection (a key, the palette): a new range says Added as part N and selects it; the same range adds nothing and says so with Add Again (the palette runs it too)", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await showCollection(host);
    typeRange(host, "1", "4");
    await host.settle();
    await host.command("clip.collectionAdd").run();
    await said(host, "Added as part 1");
    await eventually(() => selectedIds(host), [rows(host)[0]!.id]);
    await eventually(() => reveal(host).row, 0);
    const serial = reveal(host).serial;
    await host.command("clip.collectionAdd").run();
    await said(host, ALREADY(1));
    assert.deepEqual(host.osdActions.at(-1), [{ title: "Add Again", command: "clip.collectionAddAgain" }]);
    assert.equal(rows(host).length, 1, "nothing added");
    await eventually(() => reveal(host), { serial: serial + 1, row: 0 }, "shown");
    await host.command("clip.collectionAddAgain").run();
    await eventually(() => rows(host).length, 2, "Add Again from the palette");
    await said(host, "Added as part 2");
    await assert.rejects(host.command("clip.collectionAddAgain").run(), "no longer offered");
  } finally {
    await stop();
  }
});

test("a file of the same name in another folder: + Add may read Added until the token is known; the click adds (no message), and from then on the state is exact", async () => {
  const host = new TestHost();
  play(host, "/media/a/clip.mp4");
  const { stop } = await start(host);
  try {
    await showCollection(host);
    await add(host, "1", "4");
    play(host, "/media/b/clip.mp4");
    typeRange(host, "1", "4");
    await eventually(() => where(host), [1, 0], "by name: it looks like part 1");
    const said = host.osd.length;
    await add(host, "1", "4");
    assert.equal(host.osd.slice(said).some((line) => line.startsWith("Already")), false, "another file: added, no message");
    await eventually(() => where(host), [2, 0], "exact now: this file's part is part 2");
    assert.equal(host.sourceReferences.size, 2);
    // A double-click on part 1 plays its file: its token is known, the Range is part 1.
    host.mounted().emit("preview-part", rows(host)[0]!.id);
    await until(() => host.sourceOpens.length === 1, "the open");
    await eventually(() => where(host), [1, 0]);
  } finally {
    await stop();
  }
});

test("a full Collection: the same range still reads Added and a click shows it; a new range is refused before anything is remembered; a same-name file's new reference is let go", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4", 300);
  const { stop } = await start(host);
  try {
    await showCollection(host);
    for (let i = 0; i < 100; i++) {
      host.mounted().emit("add-part", String(i), String(i + 1));
      await until(() => rows(host).length === i + 1, `part ${i + 1}`);
    }
    typeRange(host, "5", "6");
    await eventually(() => [addFrom(host).full, ...where(host)], [true, 6, 0], "full, and the Range is part 6");
    const remembered = host.sent("media.sources.remember").length;
    host.mounted().emit("add-part", "5", "6");
    await said(host, ALREADY(6));
    await eventually(() => reveal(host).row, 5, "part 6 shown");
    assert.equal(rows(host).length, 100);
    assert.equal(host.sourceReferences.size, 1);
    typeRange(host, "200", "201");
    await eventually(() => where(host), [0, 0]);
    const before = host.sent("media.sources.remember").length;
    host.mounted().emit("add-part", "200", "201");
    await said(host, REASON.collectionFull);
    assert.equal(host.sent("media.sources.remember").length, before, "refused before anything is remembered");
    assert.ok(before >= remembered);
    // Another folder, the same name: it looks like part 6; the click finds another file, which is not kept.
    play(host, "/media/other/one.mp4", 300);
    typeRange(host, "5", "6");
    await eventually(() => where(host), [6, 0]);
    const shownBefore = host.osd.length;
    host.mounted().emit("add-part", "5", "6");
    await saidSince(host, shownBefore, REASON.collectionFull);
    await until(() => host.sourceReferences.size === 1, "the other file's reference let go");
    assert.equal(rows(host).length, 100);
  } finally {
    await stop();
  }
});

/**
 * Slint 1.18.1's ListView layout (i-slint-core, model/repeater.rs `update_visible_instances`), as far as a scroll
 * position matters: rows not built are placed by one row height (the average of those built last), and a position
 * more than a screen away rebuilds the rows from the row it falls in, at the top of the view (the pixels into that
 * row are dropped). The test host lays nothing out; this stands in for the list when a part is revealed.
 */
function listView(count: number, view: number, heightOf: (row: number) => number) {
  const state = { offset: 0, built: 0, anchor: 0, cached: 0, previous: 0 };
  let contentY = 0;
  let top = 0; // where the first built row is drawn
  function layout() {
    const y0 = Math.min(contentY, 0);
    let each = state.cached;
    if (!(each > 0)) {
      if (!state.built) state.built = 1;
      each = Array.from({ length: state.built }, (_, i) => heightOf(state.offset + i)).reduce((a, b) => a + b, 0) / state.built;
    }
    let first: number, at: number;
    if (state.anchor > -y0 + view * 1.5 || state.anchor + each * state.built + each < -y0) {
      state.built = 0;
      first = state.offset = Math.min(Math.floor(-y0 / each), count - 1);
      at = 0;
    } else if (y0 < state.previous) {
      at = state.anchor + y0;
      first = state.offset;
      for (let i = 0; i < state.built; i++) {
        const h = heightOf(first);
        if (at + h > 0 || first + 1 >= count) break;
        at += h;
        first++;
      }
    } else {
      first = state.offset;
      at = state.anchor + y0;
    }
    while (first > 0 && at > 0) at -= heightOf(--first);
    let y = at, next = first;
    while (next < count && y < view) y += heightOf(next++);
    state.offset = first;
    state.built = next - first;
    state.cached = (y - at) / state.built;
    state.anchor = state.cached * first;
    state.previous = contentY = -state.anchor + at;
    top = at;
  }
  layout();
  return {
    get contentY() {
      return contentY;
    },
    /** A write of `content-y` (the tab's, or the user's scroll), then the next layout. */
    scroll(y: number) {
      contentY = y;
      layout();
    },
    /** Where row `row` is drawn (its top in the view), null when it is not built. */
    topOf(row: number) {
      if (row < state.offset || row >= state.offset + state.built) return null;
      let y = top;
      for (let i = state.offset; i < row; i++) y += heightOf(i);
      return y;
    },
  };
}

test("revealing a part: the list scrolls to the top of a row (rows of one height), so the part is whole in view from anywhere; the first version's position between rows left the last part below the view", async () => {
  const slint = await readFile(new URL("../ui/tab.slint", import.meta.url), "utf8");
  // What the tab does (ui/tab.slint `reveal-part`), mirrored below: a part above the view goes to the top, one below it becomes the last row whose part fits.
  const reveal = /function reveal-part\(\) \{([\s\S]*?)\n    \}/.exec(slint)?.[1] ?? "";
  assert.match(reveal, /if ClipBridge\.reveal\.row \* 63px < -parts-list\.content-y \{\s*parts-list\.content-y = -ClipBridge\.reveal\.row \* 63px;/);
  assert.match(reveal, /\} else if ClipBridge\.reveal\.row \* 63px \+ 46px > -parts-list\.content-y \+ parts-list\.visible-height \{\s*parts-list\.content-y = -max\(0, ClipBridge\.reveal\.row - floor\(max\(0px, parts-list\.visible-height - 46px\) \/ 63px\)\) \* 63px;/);
  assert.equal(slint.split("parts-list.content-y =").length - 1, 2, "nowhere else");
  assert.match(slint, /changed reveal-request => \{ root\.reveal-part\(\); \}/, "at once: no timer");
  assert.doesNotMatch(slint.slice(slint.indexOf("export component ClipExportTab")), /Timer \{/);
  // Every row of the list is 63 px, the last one too: only then is `content-y` a real position.
  const item = slint.slice(slint.indexOf("component PartItem inherits Rectangle")).split("\ncomponent ")[0]!;
  assert.match(item, /\n    height: 63px;/);
  assert.doesNotMatch(item, /\n    height: root\.entry\.join/);
  const ROW = 63, PART = 46;
  const target = (row: number, y: number, view: number) =>
    row * ROW < -y ? -row * ROW : row * ROW + PART > -y + view ? -Math.max(0, row - Math.floor(Math.max(0, view - PART) / ROW)) * ROW : y;
  const whole = (list: ReturnType<typeof listView>, row: number, view: number) => {
    const y = list.topOf(row);
    return y !== null && y >= -1e-6 && y + PART <= view + 1e-6;
  };
  // The defect seen on screen (0.7.1 as first built): 14 parts, the last row 46 px, the list at the top, a view of
  // 245 px; the write `visible-height − row × 63 − 46` shows parts 10–13 and leaves part 14 below the view.
  const old = listView(14, 245, (row) => (row < 13 ? ROW : PART));
  old.scroll(Math.min(0, 245 - 13 * ROW - PART));
  assert.deepEqual([old.topOf(9), old.topOf(13)], [0, null], "the model shows the defect: part 10 at the top, part 14 not in view");
  // Now: the same case, and every list length, view height, starting position and part.
  const now = listView(14, 245, () => ROW);
  now.scroll(target(13, now.contentY, 245));
  assert.deepEqual([now.topOf(10), now.topOf(13)], [0, 189], "parts 11–14, part 14 whole");
  for (const view of [191, 245, 300, 437, 800]) {
    for (const count of [1, 2, 3, 4, 5, 14, 15, 37, 100]) {
      const end = Math.max(0, count * ROW - view);
      for (const start of [0, 17, ROW, end / 2, end - 30, end]) {
        for (let row = 0; row < count; row++) {
          const list = listView(count, view, () => ROW);
          list.scroll(-Math.max(0, start));
          const before = list.contentY;
          const shown = whole(list, row, view);
          list.scroll(target(row, list.contentY, view));
          assert.ok(whole(list, row, view), `part ${row + 1} of ${count} whole in a ${view} px list scrolled to ${start}`);
          if (shown) assert.equal(list.contentY, before, `part ${row + 1} of ${count} was in view: the list does not move`);
        }
      }
    }
  }
});
