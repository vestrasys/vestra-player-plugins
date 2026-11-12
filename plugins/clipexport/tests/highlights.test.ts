import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import {
  analyse, bandAt, bandsPath, CACHE_LIMIT, curvePath, emptyValues, HighlightStore, keptName, loudnessArgs, MAX_LENGTH, MIN_BAND, MIN_LENGTH, parseMomentary, pick, RATE, savedOf, scanLoudness, short, total, WINDOW,
} from "../highlights.ts";
import type { HighlightScan } from "../highlights.ts";
import activate from "../main.ts";
import { clock, parseTime, REASON } from "../model.ts";
import { eventually } from "./fakes.ts";

const ID = "zysilm.clipexport";
const directory = new URL("..", import.meta.url);
const tab = (host: TestHost) => host.mounted().props;
type Highlights = { state: string; name: string; percent: number; left: number; scanned: number; loudness: boolean; first: boolean; reason: string; raw: string; count: number; remaining: number; total: number; length: string };
type Row = { id: string; range: string; brief: string; badge: string; kind: string; lu: string; selected: boolean };
type Heat = { curve: string; bands: string; picked: string; seconds: number };
const page = (host: TestHost) => (tab(host).highlights ?? {}) as Highlights;
const rows = (host: TestHost) => (tab(host)["highlight-rows"] ?? []) as Row[];
const heat = (host: TestHost) => tab(host).heat as Heat;
const tick = () => new Promise((done) => setTimeout(done, 5));
async function until(predicate: () => boolean | Promise<boolean>, what = "condition") {
  for (let i = 0; i < 2000; i++) {
    if (await predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- a made-up sound

/**
 * A talk with a pause of 0.8 s every 6 s (−30 LUFS, the pauses silent) and
 * two reactions: 20 s of loud sound at 200 s (−12 LUFS) and 6 s at 420 s
 * (−20 LUFS).
 */
function talk(t: number) {
  if (t >= 200 && t < 220) return -12;
  if (t >= 420 && t < 426) return -20;
  return t % 6 < 0.8 ? -120.691 : -30;
}
/**
 * What ffmpeg prints for one window (`loudnessArgs`): a frame line and its momentary loudness per 100 ms, the
 * first one 5.33 ms in (AAC's 256 samples of priming at 48 kHz). As the real one, it leaves out a last frame
 * shorter than 100 ms.
 */
function momentaryOutput(args: string[], loud: (t: number) => number) {
  const at = Number(args[args.indexOf("-ss") + 1]);
  const length = Number(args[args.indexOf("-t") + 1]);
  let out = "";
  for (let k = 0; 0.00533 + (k + 1) * 0.1 <= length + 1e-6; k++) {
    const time = 0.00533 + k * 0.1;
    out += `frame:${k}    pts:${k * 4800}  pts_time:${time}\nlavfi.r128.M=${loud(at + time).toFixed(3)}\n`;
  }
  return out;
}
const isScan = (args: string[]) => args.some((arg) => arg.includes("ebur128"));
/** Pretend to be ffmpeg: the scan's windows from `loud`; other runs (thumbnails) give nothing. `gate` holds a window until it resolves. */
function fakeFfmpeg(host: TestHost, loud: (t: number) => number = talk, gate?: () => Promise<void>) {
  host.tools.handle("ffmpeg", async (args) => {
    if (!isScan(args)) return { stdout: "" };
    await gate?.();
    return { stdout: momentaryOutput(args, loud) };
  });
}
/** Values a second ×10 for a whole made-up video. */
function valuesOf(loud: (t: number) => number, duration: number) {
  const values = emptyValues(duration);
  for (let i = 0; i < values.length; i++) values[i] = Math.max(-70, loud(i / RATE));
  return values;
}

// ---------------------------------------------------------------- pure parts

test("ffmpeg's arguments: momentary loudness of one audio stream, a window at a time, nothing else decoded, on standard output", () => {
  const args = loudnessArgs("/media/a b.mkv", 300, 300, 2);
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 6), ["-ss", "299.500", "-t", "300.500", "-i", "/media/a b.mkv"], "a warm-up of 0.5 s before the window");
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 2), ["-map", "0:a:2"]);
  for (const flag of ["-vn", "-sn", "-dn", "-nostdin"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(args.indexOf("-threads"), args.indexOf("-threads") + 2), ["-threads", "1"]);
  assert.equal(args[args.indexOf("-af") + 1], "ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-");
  assert.deepEqual(args.slice(-3), ["-f", "null", "-"]);
  const first = loudnessArgs("/m.mp4", 0, 120, 0);
  assert.deepEqual(first.slice(first.indexOf("-ss"), first.indexOf("-ss") + 4), ["-ss", "0.000", "-t", "120.000"], "the first window starts at 0");
});

test("parsing: each value lands at its time; the warm-up before the window and silence below −70 LUFS are dropped", () => {
  const values = emptyValues(10);
  const text = "frame:0    pts:256     pts_time:0.00533333\nlavfi.r128.M=-120.691\nframe:1    pts:5056    pts_time:0.105333\nlavfi.r128.M=-40.5\nframe:6    pts:28856    pts_time:0.605333\nlavfi.r128.M=-21.25\n";
  assert.equal(parseMomentary(text, 4.5, 5, values), 1, "values before the window's start are the warm-up");
  assert.equal(values[51], -21.25);
  assert.equal(parseMomentary(text, 0, 0, values), 3);
  assert.deepEqual([values[0], values[1], values[6]], [-70, -40.5, -21.25]);
});

test("the analysis: a reaction becomes a range from the pause before it to the first pause after it; ranges are 6–90 s", () => {
  const values = valuesOf(talk, 600);
  const { average, curve, candidates } = analyse(values, 600);
  assert.equal(average, -30, "the median of the sound");
  assert.equal(curve.length, 600, "one value a second");
  assert.equal(candidates.length, 2);
  const [strong, weak] = candidates;
  // The loudest first; its range starts in the last pause at least 4 s before the reaction (192–192.8 s) and ends in the first one after it (222–222.8 s).
  assert.ok(strong!.start >= 192 && strong!.start <= 192.8, `start ${strong!.start}`);
  assert.ok(strong!.end >= 222 && strong!.end <= 222.8, `end ${strong!.end}`);
  assert.ok(strong!.peak >= 17 && strong!.peak <= 18.5, `+${strong!.peak} LU`);
  assert.ok(weak!.start < 416 && weak!.start >= 414 && weak!.end >= 426 && weak!.end <= 429, `${weak!.start}–${weak!.end}`);
  for (const c of candidates) assert.ok(c.end - c.start >= MIN_LENGTH && c.end - c.start <= MAX_LENGTH);
  assert.ok(candidates.every((c) => /^\d+$/.test(c.id)), "an id from the start");
});

test("the analysis: silence has no average and nothing; an even talk has nothing that stands out; a long loud part stays at 90 s; close ones merge", () => {
  assert.deepEqual(analyse(valuesOf(() => -120, 120), 120).candidates, []);
  assert.equal(analyse(valuesOf(() => -120, 120), 120).average, null);
  assert.deepEqual(analyse(valuesOf((t) => (t % 6 < 0.8 ? -90 : -30), 600), 600).candidates, [], "a lecture: nothing stood out");
  const long = analyse(valuesOf((t) => (t >= 100 && t < 300 ? -10 : t % 6 < 0.8 ? -90 : -30), 600), 600).candidates;
  assert.equal(long.length, 1);
  assert.ok(long[0]!.end - long[0]!.start <= MAX_LENGTH + 0.05, "at most 90 s");
  const close = analyse(valuesOf((t) => ((t >= 100 && t < 104) || (t >= 112 && t < 116) ? -12 : t % 6 < 0.8 ? -90 : -30), 600), 600).candidates;
  assert.equal(close.length, 1, "two reactions 8 s apart: one range");
  assert.ok(close[0]!.start < 100 && close[0]!.end > 116);
  const atStart = analyse(valuesOf((t) => (t < 3 ? -10 : t % 6 < 0.8 ? -90 : -30), 60), 60).candidates;
  assert.equal(atStart[0]!.start, 0, "a reaction at the very start starts at 0");
});

test("5 · 10 · 20: the strongest of all, in time order; added and dismissed ones leave the list but still count", () => {
  const candidates = [10, 50, 30, 70, 20, 60].map((start, i) => ({ id: String(start), start, end: start + 8, peak: [3, 9, 5, 8, 7, 6][i]! }));
  assert.deepEqual(pick(candidates, 3, {}).left.map((c) => c.id), ["20", "50", "70"], "peaks 9, 8 and 7, in time order");
  assert.deepEqual(pick(candidates, 3, { 20: "dismissed" }), { left: [candidates[1], candidates[3]], total: 3 });
  assert.deepEqual(pick(candidates, 20, { 50: "added" }).left.map((c) => c.id), ["10", "20", "30", "60", "70"]);
  assert.equal(pick(candidates, 20, {}).total, 6, "fewer candidates: fewer rows");
});

test("the strip: one path for the curve (only what was scanned), one for the bands, each band at least 13 of 1000 wide; a click hits a band as drawn", () => {
  const curve = Array.from({ length: 7200 }, (_, i) => (i > 3000 && i < 3030 ? -12 : -30));
  const path = curvePath(curve, -30, 7200);
  assert.match(path, /^M 0 100 L /);
  assert.match(path, / Z$/);
  assert.ok(path.split(" L ").length <= 2 * 240 + 2, "at most 240 columns, never a point per sample");
  assert.match(curvePath(curve, -30, 7200, 1800), / L 250 100 Z$/, "a quarter scanned: the curve stops there");
  assert.equal(curvePath(curve, null, 7200), "", "no sound: no curve");
  const bands = bandsPath([{ start: 3600, end: 3630 }], 7200);
  assert.equal(bands, `M 500 0 H ${500 + MIN_BAND} V 10 H 500 Z`, "a 30 s range of 2 h is 4 of 1000: drawn 13 wide");
  assert.equal(bandAt([{ start: 3600, end: 3630 }], 0.505, 7200)?.start, 3600, "the drawn band is what a click hits");
  assert.equal(bandAt([{ start: 3600, end: 3630 }], 0.52, 7200), null);
});

test("times: tenths in the rows, none in a narrow tab; the footer's total", () => {
  assert.deepEqual([short(252.4), short(3764.8), short(252.44, false), short(3764.8, false)], ["4:12.4", "1:02:44.8", "4:12", "1:02:44"]);
  assert.deepEqual([total(308), total(3725)], ["5:08", "1:02:05"]);
});

test("the scan runs ffmpeg window by window and stops when aborted between windows", async () => {
  const runs: string[][] = [];
  const run = async (args: string[]) => {
    runs.push(args);
    return { stdout: new TextEncoder().encode(momentaryOutput(args, talk)) };
  };
  const done: number[] = [];
  const values = await scanLoudness(run, "/m.mp4", 0, 700, { signal: new AbortController().signal, between: (seconds) => void done.push(seconds) });
  assert.equal(runs.length, Math.ceil(700 / WINDOW));
  assert.deepEqual(done, [300, 600, 700]);
  assert.equal(values[2000], -12, "200 s is loud");
  assert.equal(values[100], -30);
  const abort = new AbortController();
  await assert.rejects(scanLoudness(run, "/m.mp4", 0, 7200, { signal: abort.signal, between: () => abort.abort() }), (error: Error) => error.name === "AbortError");
});

test("window edges lose nothing: a scan in windows gives every value one run over the whole file gives, none twice", async () => {
  // A value that changes every 100 ms: a lost or shifted one shows.
  const run = async (args: string[]) => ({ stdout: new TextEncoder().encode(momentaryOutput(args, (t) => -30 + (Math.floor(t * 10 + 0.01) % 7))) });
  const signal = new AbortController().signal;
  const windowed = await scanLoudness(run, "/m.mp4", 0, 1000, { signal });
  const single = await scanLoudness(run, "/m.mp4", 0, 1000, { signal, window: 10_000 });
  assert.deepEqual([...windowed], [...single]);
  for (const edge of [2998, 2999, 3000, 5999, 6000, 8999, 9000]) assert.notEqual(windowed[edge], -70, `value ${edge} (${edge / 10} s) is there`);
});

test("kept scans: one file per video and track; a changed file says so and its result goes; damaged files are dropped; the 50 most recent stay", async () => {
  const folder = await mkdtemp(join(tmpdir(), "clipexport-hl-"));
  const media = join(folder, "talk.mp4");
  await writeFile(media, "media");
  try {
    const store = new HighlightStore(join(folder, "kept"));
    const stamp = (await store.stamp(media, 0))!;
    assert.equal(stamp.size, 5);
    const saved: HighlightScan = { version: 1, ...stamp, scanned: 1, mode: "loudness", duration: 600, average: -30, curve: [-30], candidates: [{ id: "1920", start: 192, end: 222, peak: 18 }], handled: { 1920: "dismissed" }, edits: {} };
    await store.save(saved);
    assert.deepEqual(await store.load(stamp), saved);
    assert.equal(await store.load({ ...stamp, stream: 1 }), null, "another track: another scan");
    await writeFile(media, "media, edited");
    assert.equal(await store.load((await store.stamp(media, 0))!), "changed");
    assert.equal(await store.load((await store.stamp(media, 0))!), null, "its result went");
    assert.equal(savedOf({ ...saved, version: 2 }), null);
    assert.equal(savedOf({ ...saved, curve: ["x"] }), null);
    assert.deepEqual(savedOf({ ...saved, handled: { a: "added", b: "maybe" }, edits: { a: { start: 5, end: 1 } } })?.handled, { a: "added" }, "unknown states and backwards edits go");
    // A file that is no JSON is no scan, and goes.
    await writeFile(join(folder, "kept", keptName(media, 3)), "not json {");
    assert.equal(await store.load({ ...stamp, stream: 3 }), null);
    assert.ok(!(await readdir(join(folder, "kept"))).includes(keptName(media, 3)), "the damaged file went");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("kept scans: the 50 most recently used stay (a load counts as a use); a temporary file a write left behind goes after a minute", async () => {
  const folder = await mkdtemp(join(tmpdir(), "clipexport-hl-"));
  const kept = join(folder, "kept");
  try {
    const store = new HighlightStore(kept);
    const stamp = { path: "", size: 5, mtimeMs: 1000, stream: 0 };
    const scanOf = (i: number): HighlightScan => ({ version: 1, ...stamp, path: join(folder, `v${i}.mp4`), scanned: 1, mode: "loudness", duration: 60, average: -30, curve: [], candidates: [], handled: {}, edits: {} });
    // v0 … v49, each a second younger than the one before (a day ago).
    const dayAgo = Date.now() / 1000 - 86_400;
    for (let i = 0; i < CACHE_LIMIT; i++) {
      await store.save(scanOf(i));
      await utimes(join(kept, keptName(scanOf(i).path, 0)), dayAgo + i, dayAgo + i);
    }
    // Opening v0 again makes it the most recent.
    assert.ok(await store.load({ ...stamp, path: scanOf(0).path }));
    // Leftovers of interrupted writes: one old, one being written now.
    await writeFile(join(kept, "old.json.1.tmp"), "x");
    await utimes(join(kept, "old.json.1.tmp"), dayAgo, dayAgo);
    await writeFile(join(kept, "new.json.2.tmp"), "x");
    await store.save(scanOf(50));
    await store.save(scanOf(51));
    const names = new Set(await readdir(kept));
    const has = (i: number) => names.has(keptName(scanOf(i).path, 0));
    assert.deepEqual([has(0), has(1), has(2), has(3), has(50), has(51)], [true, false, false, true, true, true], "v1 and v2, the oldest unused, went");
    assert.equal([...names].filter((name) => name.endsWith(".json")).length, CACHE_LIMIT);
    assert.deepEqual([names.has("old.json.1.tmp"), names.has("new.json.2.tmp")], [false, true]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the page

/** The file's one sound track, playing. */
const TRACK = [{ trackId: 1, selected: true, external: false, streamIndex: 1, codec: "aac", title: null, language: null }];

/** A local file of `duration` seconds playing (a real file: its size and time are the scan's stamp). */
async function withMedia(duration = 600) {
  const folder = await mkdtemp(join(tmpdir(), "clipexport-hl-media-"));
  const data = await mkdtemp(join(tmpdir(), "clipexport-hl-data-"));
  const media = join(folder, "standup.mp4");
  await writeFile(media, "media bytes");
  return {
    media, data, duration,
    play(host: TestHost, path = media, extra: Record<string, unknown> = {}) {
      host.openElsewhere(path);
      host.setSource({ position: 2, duration, audioTracks: TRACK, ...extra });
    },
    cleanup: () => Promise.all([rm(folder, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]),
  };
}
const startIn = (host: TestHost, data: string, locale: "en" | "zh-Hans" = "en") => startPlugin(activate, { directory, host, locale, dataDirectory: data });
/** The tab in front (Clip Export Settings… shows it), at the Highlights page. */
async function showHighlights(host: TestHost) {
  await host.command("clip.settings").run();
  await host.settle();
  host.mounted().emit("set-page", 1);
  await host.settle();
  await eventually(() => tab(host).page, 1);
}

test("the page: no local file (S6); a file not scanned (S1); Find Highlights scans in windows with progress, then lists the suggestions (R1); reopened, the kept result shows at once", async () => {
  const setup = await withMedia();
  const host = new TestHost();
  let release: () => void = () => {};
  let held = true;
  fakeFfmpeg(host, talk, () => (held ? new Promise((done) => (release = done)) : Promise.resolve()));
  const { stop } = await startIn(host, setup.data);
  try {
    await showHighlights(host);
    await eventually(() => page(host).state, "none", "nothing playing: open a local file (S6)");
    host.openElsewhere("https://example.com/v.mp4");
    host.setSource({ duration: 600 });
    await host.settle();
    await eventually(() => page(host).state, "none", "a network source (S6)");
    setup.play(host);
    await eventually(() => page(host).state, "ready", "S1: Find Highlights");
    assert.equal(page(host).name, "standup.mp4");
    assert.equal(host.tools.calls.length, 0, "a scan starts only on a click");
    host.mounted().emit("find-highlights");
    await until(() => host.tools.calls.filter((call) => isScan(call.args)).length === 1, "the first window");
    await eventually(() => page(host).state, "scanning");
    assert.deepEqual([page(host).percent, page(host).left], [0, -1], "no time left before a window is measured");
    held = false;
    release();
    await eventually(() => page(host).state, "done", "R1");
    assert.equal(host.tools.calls.filter((call) => isScan(call.args)).length, 2, "600 s: two windows of 300 s");
    await eventually(() => rows(host).map((row) => [row.kind, row.lu]), [["loud", "18"], ["loud", "10"]]);
    assert.match(rows(host)[0]!.range, /^3:1[12]\.\d – 3:4[23]\.\d$/);
    assert.deepEqual([page(host).remaining, page(host).total, page(host).count, page(host).scanned, page(host).loudness], [2, 2, 1, 0, true]);
    assert.match(heat(host).curve, /^M 0 100 L /);
    assert.equal(heat(host).seconds, 600);
    assert.equal(tab(host)["heat-head"], 2 / 600, "the playhead, a property of its own");
    assert.equal("head" in heat(host), false);
    assert.equal(heat(host).bands.split("Z").length - 1, 2, "a band per suggestion");
    const kept = await readdir(join(setup.data, "highlights"));
    assert.equal(kept.length, 1, "one small file for the video");
    await stop();

    // Reopened: the kept result at once, no scan.
    const again = new TestHost();
    fakeFfmpeg(again);
    setup.play(again);
    const second = await startIn(again, setup.data);
    try {
      await showHighlights(again);
      await eventually(() => page(again).state, "done", "R1 at once");
      await eventually(() => rows(again).length, 2);
      assert.equal(again.tools.calls.length, 0);
    } finally {
      await second.stop();
    }
  } finally {
    await stop().catch(() => {});
    await setup.cleanup();
  }
});

test("a row is the Range: a click selects it, seeks to its start and fills Start and End; Set Clip Start moves its edge; + adds it to the Collection, × dismisses it; Add All; 5 · 10 · 20", async () => {
  const setup = await withMedia();
  const host = new TestHost();
  fakeFfmpeg(host);
  setup.play(host);
  const { stop } = await startIn(host, setup.data);
  try {
    await showHighlights(host);
    await eventually(() => page(host).state, "ready");
    host.mounted().emit("find-highlights");
    await eventually(() => page(host).state, "done");
    await eventually(() => rows(host).length, 2);
    const [first, second] = rows(host);
    host.mounted().emit("select-highlight", first!.id);
    await until(() => rows(host)[0]?.selected === true, "selected");
    await until(() => host.seeks.length === 1);
    const startSeconds = host.seeks[0]!.seconds;
    assert.ok(startSeconds > 191 && startSeconds < 193);
    await eventually(() => tab(host)["clip-start"], clock(startSeconds), "the Range's Start");
    assert.equal(heat(host).picked.split("Z").length - 1, 1, "the selected band in the accent");
    assert.equal(heat(host).bands.split("Z").length - 1, 1, "the others dim");
    // The seek bar: the selection (the Range) and the other suggestion as a dim region band.
    await until(() => (host.timeline.rangeLayers.get(ID) ?? []).length === 2, "seek-bar ranges");
    assert.deepEqual(host.timeline.rangeLayers.get(ID)!.map((r) => `${r.style} ${r.title}`).sort(), ["region Highlights", "selection Clip"]);
    // Set Clip Start (the row's Start button): the selected suggestion's edge moves; the row says so.
    host.setSource({ position: 190 });
    await host.command("clip.start").run();
    await eventually(() => rows(host)[0]!.range.startsWith("3:10.0 – "), true, "the row shows the edited start");
    // + adds it to the Collection as the last part; it leaves the list.
    host.mounted().emit("add-highlight", first!.id);
    await until(() => host.osd.includes("Added as part 1"), "Added as part 1");
    await eventually(() => rows(host).map((row) => row.id), [second!.id]);
    const parts = tab(host).parts as { range: string }[];
    assert.equal(parts.length, 1);
    assert.match(parts[0]!.range, /^03:10\.000 – /, "the edited range");
    await eventually(() => [page(host).remaining, page(host).total], [1, 2], "1 of 2 left");
    // × dismisses: nothing left.
    host.mounted().emit("dismiss-highlight", second!.id);
    await eventually(() => rows(host).length, 0);
    await eventually(() => page(host).remaining, 0);
    // The kept file remembers what was done.
    await until(async () => {
      const [name] = await readdir(join(setup.data, "highlights"));
      const saved = JSON.parse(await readFile(join(setup.data, "highlights", name!), "utf8"));
      return saved.handled[first!.id] === "added" && saved.handled[second!.id] === "dismissed" && saved.edits[first!.id]?.start === 190;
    }, "kept");
    // 5 · 10 · 20 picks how many to show, at once: fewer candidates show fewer.
    host.mounted().emit("set-highlight-count", 0);
    await eventually(() => page(host).count, 0);
  } finally {
    await stop();
    await setup.cleanup();
  }
});

test("Add All adds every suggestion left, in time order, as one file; past 100 parts it adds what fits and says so", async () => {
  const setup = await withMedia(3000);
  // A reaction every 120 s: 24 of them.
  const many = (t: number) => (t % 120 >= 60 && t % 120 < 64 ? -12 + (Math.floor(t / 120) % 5) : t % 6 < 0.8 ? -120 : -30);
  const host = new TestHost();
  fakeFfmpeg(host, many);
  setup.play(host);
  const { stop } = await startIn(host, setup.data);
  try {
    await showHighlights(host);
    await eventually(() => page(host).state, "ready");
    host.mounted().emit("find-highlights");
    await eventually(() => page(host).state, "done");
    await eventually(() => rows(host).length, 10, "10 by default");
    host.mounted().emit("set-highlight-count", 2);
    await eventually(() => rows(host).length, 20);
    // 90 parts already: 10 more fit.
    host.openElsewhere(setup.media);
    host.setSource({ position: 2, duration: 3000 });
    for (let i = 0; i < 90; i++) {
      host.mounted().emit("add-part", String(i), String(i + 1));
      await until(() => (tab(host).parts as unknown[]).length === i + 1, `part ${i + 1}`);
    }
    const before = rows(host).map((row) => row.id);
    host.mounted().emit("add-all-highlights");
    await until(() => (tab(host).parts as unknown[]).length === 100, "the Collection full");
    await until(() => host.osd.includes(REASON.collectionFull), "the limit said");
    const starts = (tab(host).parts as { range: string }[]).slice(90).map((part) => parseTime(part.range.split(" – ")[0]!)!);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "in time order");
    await eventually(() => rows(host).map((row) => row.id), before.slice(10), "the ten that did not fit stay");
    assert.equal(new Set([...host.sourceReferences.values()].map((ref) => ref.path)).size, 1, "one file reference");
  } finally {
    await stop();
    await setup.cleanup();
  }
});

test("S3 no sound, S4 nothing found, S5 a changed file, FFmpeg missing, Cancel; another file opened during a scan stops it", async () => {
  const setup = await withMedia();
  const host = new TestHost();
  const { stop } = await startIn(host, setup.data, "zh-Hans");
  try {
    // FFmpeg missing: the page's red line, Find Highlights again.
    setup.play(host);
    await showHighlights(host);
    await eventually(() => page(host).state, "ready");
    host.mounted().emit("find-highlights");
    await eventually(() => [page(host).state, page(host).reason], ["error", "noScanFfmpeg"]);
    // No sound (S3): the player lists no track of the file's own.
    setup.play(host, setup.media, { audioTracks: [] });
    await eventually(() => page(host).state, "noSound");
    // Nothing found (S4), kept like any other result.
    fakeFfmpeg(host, (t) => (t % 6 < 0.8 ? -120 : -30));
    setup.play(host);
    await eventually(() => page(host).state, "ready");
    host.mounted().emit("find-highlights");
    await eventually(() => page(host).state, "nothing");
    await eventually(() => rows(host), []);
    // A changed file (S5): the old result goes; Find Highlights scans it again.
    await writeFile(setup.media, "other media bytes");
    setup.play(host);
    await eventually(() => page(host).state, "changed");
    // Cancel: back to what the page showed; the partial result is discarded.
    let release: () => void = () => {};
    fakeFfmpeg(host, talk, () => new Promise((done) => (release = done)));
    host.mounted().emit("find-highlights");
    await eventually(() => page(host).state, "scanning");
    host.mounted().emit("cancel-scan");
    await eventually(() => page(host).state, "changed");
    release();
    // Another file during a scan (D12): the scan stops.
    host.mounted().emit("find-highlights");
    await eventually(() => page(host).state, "scanning");
    const other = join(setup.data, "other.mp4");
    await writeFile(other, "x");
    setup.play(host, other);
    await eventually(() => page(host).state, "ready", "the new file, not scanned");
    release();
    await host.settle();
    assert.equal(page(host).state, "ready", "the old scan's end changes nothing");
  } finally {
    await stop();
    await setup.cleanup();
  }
});

test("Find Highlights (command palette): opens the Highlights page and scans a file not scanned; never again while it runs or once done; no menu item", async () => {
  const setup = await withMedia();
  const host = new TestHost();
  fakeFfmpeg(host);
  setup.play(host);
  const { stop } = await startIn(host, setup.data, "zh-Hans");
  try {
    const command = host.command("clip.highlights");
    assert.equal(command.declaration.path?.length ?? 0, 0, "not in a menu");
    assert.equal(command.display.title, "查找高光");
    await command.run();
    await host.settle();
    await eventually(() => tab(host).page, 1);
    await eventually(() => page(host).state, "done");
    const scans = host.tools.calls.length;
    await command.run();
    await host.settle();
    assert.equal(host.tools.calls.length, scans, "a scanned file is not scanned again");
    // Another page: the dim bands leave the seek bar, the Range stays.
    host.mounted().emit("select-highlight", rows(host)[1]!.id);
    await until(() => (host.timeline.rangeLayers.get(ID) ?? []).some((r) => r.style === "region"), "a region band");
    host.mounted().emit("set-page", 0);
    await host.settle();
    await until(() => (host.timeline.rangeLayers.get(ID) ?? []).every((r) => r.style === "selection"), "only the Range");
  } finally {
    await stop();
    await setup.cleanup();
  }
});

test("the sound track: the one playing among the file's own (0:a:N); an external one scans the file's first track and says so; a stream the file lacks is no sound (S3), with no ffmpeg run", async () => {
  const setup = await withMedia();
  const host = new TestHost();
  fakeFfmpeg(host);
  // ffprobe lists the file's audio streams; `streams` says how many.
  let streams = 2;
  host.tools.handle("ffprobe", (args) => ({ stdout: args.includes("stream=index") ? Array.from({ length: streams }, (_, i) => `${i + 1}\n`).join("") : "" }));
  const own = (id: number, selected: boolean) => ({ trackId: id, selected, external: false, streamIndex: id, codec: "aac", title: null, language: null });
  const external = { trackId: 9, selected: true, external: true, streamIndex: null, codec: "aac", title: null, language: null };
  const { stop } = await startIn(host, setup.data);
  const maps = () => host.tools.calls.filter((call) => isScan(call.args)).map((call) => call.args[call.args.indexOf("-map") + 1]);
  try {
    await showHighlights(host);
    // The second of the file's own tracks plays: its stream is 0:a:1.
    setup.play(host, setup.media, { audioTracks: [own(1, false), own(2, true)] });
    await eventually(() => page(host).state, "ready");
    host.mounted().emit("find-highlights");
    await eventually(() => page(host).state, "done");
    assert.deepEqual([...new Set(maps())], ["0:a:1"]);
    assert.equal(page(host).first, false);
    // An external track plays (another file): the file's first track, and the Scanned line says so.
    host.tools.calls.length = 0;
    setup.play(host, setup.media, { audioTracks: [own(1, false), external] });
    await eventually(() => page(host).state, "ready", "another track: another scan");
    host.mounted().emit("find-highlights");
    await eventually(() => page(host).state, "done");
    assert.deepEqual([...new Set(maps())], ["0:a:0"]);
    await eventually(() => page(host).first, true);
    // The player lists a track the file does not have (ffprobe finds no audio stream): no sound, no ffmpeg run.
    host.tools.calls.length = 0;
    streams = 0;
    const other = join(setup.data, "silent.mp4");
    await writeFile(other, "x");
    setup.play(host, other);
    await eventually(() => page(host).state, "ready");
    host.mounted().emit("find-highlights");
    await eventually(() => page(host).state, "noSound");
    assert.deepEqual(maps(), []);
  } finally {
    await stop();
    await setup.cleanup();
  }
});

// ---------------------------------------------------------------- with a real ffmpeg (skipped without one)

const FFMPEG = process.env.VESTRA_FFMPEG || "ffmpeg";
const haveFfmpeg = await promisify(execFile)(FFMPEG, ["-hide_banner", "-version"]).then(() => true, () => false);

test("with a real ffmpeg: a talk with pauses and one loud burst gives one range around the burst, its edges in pauses", { skip: !haveFfmpeg && "no ffmpeg (set VESTRA_FFMPEG)" }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "clipexport-hl-real-"));
  try {
    const file = join(folder, "talk.m4a");
    const volume = "0.08*gt(mod(t,6.3),0.9)+0.8*between(t,330,336)";
    await promisify(execFile)(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=color=pink:sample_rate=48000:amplitude=1:d=400", "-af", `volume=eval=frame:volume='${volume}'`, "-c:a", "aac", file]);
    const run = (args: string[], options: { timeoutMs: number; maxOutput?: number; signal?: AbortSignal }) =>
      promisify(execFile)(FFMPEG, args, { encoding: "buffer", maxBuffer: options.maxOutput, timeout: options.timeoutMs, signal: options.signal }).then(({ stdout }) => ({ stdout: stdout as Uint8Array }));
    const values = await scanLoudness(run, file, 0, 400, { signal: new AbortController().signal });
    const { candidates, average } = analyse(values, 400);
    assert.ok(average! < -25 && average! > -45, `average ${average}`);
    assert.equal(candidates.length, 1);
    const [range] = candidates;
    // The burst is in the second window (300–400 s).
    assert.ok(range!.start <= 326 && range!.start >= 270, `start ${range!.start}, before the burst at 330 s`);
    assert.ok(range!.end >= 336 && range!.end <= 357, `end ${range!.end}`);
    // Both edges in a pause of the talk (0.9 s every 6.3 s).
    for (const edge of [range!.start, range!.end]) assert.ok(edge % 6.3 < 1.3 || edge % 6.3 > 6.0, `${edge} in a pause`);
    // The windows' edges (300 s here, 100 s below) lose no value: the same as one run over the whole file.
    const single = await scanLoudness(run, file, 0, 400, { signal: new AbortController().signal, window: 10_000 });
    const fine = await scanLoudness(run, file, 0, 400, { signal: new AbortController().signal, window: 100 });
    for (const edge of [999, 1000, 1999, 2000, 2999, 3000]) assert.ok(values[edge]! > -60 && fine[edge]! > -60, `value ${edge} is there`);
    // A seek lands ffmpeg's 100 ms frames a millisecond or so from where one run has them: a frame on the edge of a
    // pause (the sound cut to nothing) may read differently; nothing else does. The last value (its 100 ms ends at the
    // file's end) is no run's: the comparison stops before it.
    let apart = 0;
    for (let i = 0; i < 3999; i++) if (Math.abs(values[i]! - single[i]!) > 1 || Math.abs(fine[i]! - single[i]!) > 1) apart++;
    assert.ok(apart <= 40, `${apart} of 3999 values differ by more than 1 LU from one run over the whole file`);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

