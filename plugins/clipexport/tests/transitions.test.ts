import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Locale } from "@vestra-player/sdk";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate from "../main.ts";
import { REASON } from "../model.ts";
import {
  applied, capOf, CUT, junctionTicks, mergedLengths, mergeEncode, normalize, progressTime, soundOf, timing, transitionArgs, transitionAt, transitionGraph,
  transitionOf, typedDuration, xfadeName,
} from "../transitions.ts";
import type { Transition } from "../transitions.ts";
import { partialOf } from "../finish.ts";
import { eventually } from "./fakes.ts";

const directory = new URL("..", import.meta.url);
const start = (host = new TestHost(), locale: Locale = "en", dataDirectory?: string) => startPlugin(activate, { directory, host, locale, dataDirectory });
const tab = (host: TestHost) => host.mounted().props;
type Row = { id: string; number: number; name: string; join: boolean; kind: string; dir: string; duration: string; off: boolean };
const rows = (host: TestHost) => (tab(host).parts ?? []) as Row[];
const tick = () => new Promise((done) => setTimeout(done, 5));
async function until(predicate: () => boolean | Promise<boolean>, what = "condition") {
  for (let i = 0; i < 1600; i++) {
    if (await predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}
function play(host: TestHost, path: string, duration = 60) {
  host.openElsewhere(path);
  host.setSource({ position: 2, duration });
}
async function add(host: TestHost, from: string, to: string) {
  const count = rows(host).length;
  host.mounted().emit("add-part", from, to);
  await until(() => rows(host).length === count + 1, `part ${count + 1}`);
}
async function withFolder(host: TestHost) {
  const folder = await mkdtemp(join(tmpdir(), "clipexport-tr-"));
  host.dialogAnswers.push([folder]);
  await host.command("clip.folder").run();
  await until(() => host.osd.at(-1) === host.translate("Clip folder: {}", [folder]), "the clip folder");
  return { folder, cleanup: () => rm(folder, { recursive: true, force: true }) };
}
const WIDE = { duration: 60, video: { codec: "h264", width: 1920, height: 818, fps: 30, pixelFormat: "yuv420p" } };
const partsExports = (host: TestHost) => host.exports.filter((e) => Array.isArray(e.parts));
const tr = (kind: Transition["kind"], duration = 1, dir: Transition["dir"] = "left"): Transition => ({ kind, dir, duration });

// ---------------------------------------------------------------- the model and the arguments

test("the cap: half of the shorter neighbour, 0.1 s steps down, at most 10 s; typed values are set to it", () => {
  assert.equal(capOf({ start: 0, end: 16.5 }, { start: 0, end: 24.5 }), 8.2);
  assert.equal(capOf({ start: 0, end: 1 }, { start: 0, end: 30 }), 0.5);
  assert.equal(capOf({ start: 0, end: 60 }, { start: 0, end: 60 }), 10);
  assert.equal(typedDuration("3", 0.5), 0.5, "a larger value is set to the limit");
  assert.equal(typedDuration("0.84 s", 8.2), 0.8);
  assert.equal(typedDuration("0,05", 8.2), 0.1, "at least 0.1 s");
  assert.equal(typedDuration("x", 8.2), null);
});

test("normalize: the last part has none, durations fit their neighbours, a junction too short for 0.1 s is a Cut; 0.2.x parts are Cuts", () => {
  const parts = [
    { start: 0, end: 4, transition: tr("crossfade", 3) },
    { start: 0, end: 1, transition: tr("slide", 1, "up") },
    { start: 0, end: 0.15, transition: tr("wipe", 1) },
    { start: 0, end: 9, transition: tr("fadeBlack", 2) },
  ];
  normalize(parts);
  assert.deepEqual(parts.map((p) => [p.transition.kind, p.transition.duration]), [["crossfade", 0.5], ["cut", 1], ["cut", 1], ["cut", 2]]);
  assert.deepEqual(transitionOf(undefined), { kind: "cut", dir: "left", duration: 1 }, "a 0.2.x part: Cut");
  assert.deepEqual(transitionOf({ kind: "zoom", dir: "sideways", duration: -1 }), { kind: "cut", dir: "left", duration: 1 });
  assert.deepEqual(transitionOf({ kind: "wipe", dir: "down", duration: 0.84 }), { kind: "wipe", dir: "down", duration: 0.8 });
});

test("xfade names (the direction is the way the new picture moves) and the sound of each kind", () => {
  assert.deepEqual(["crossfade", "fadeBlack", "fadeWhite"].map((k) => xfadeName(tr(k as never))), ["fade", "fadeblack", "fadewhite"]);
  for (const dir of ["left", "right", "up", "down"] as const) {
    assert.equal(xfadeName(tr("wipe", 1, dir)), `wipe${dir}`);
    assert.equal(xfadeName(tr("slide", 1, dir)), `slide${dir}`);
  }
  assert.deepEqual(["cut", "crossfade", "fadeBlack", "fadeWhite", "wipe", "slide"].map((k) => soundOf(k as never)), ["cut", "crossfade", "dip", "dip", "crossfade", "crossfade"]);
  assert.deepEqual(applied([tr("crossfade"), CUT], true), [CUT, CUT], "Fast joins with cuts");
});

test("junction offsets on whole frames: each blend starts at the length so far less the overlaps; the output is Σ L − Σ d", () => {
  // 12.0, 9.5, 14.3 s at 25 fps; Crossfade 1.0 s, then Slide 0.5 s.
  const t = timing([12, 9.5, 14.3], [tr("crossfade", 1), tr("slide", 0.5), CUT], 25);
  assert.deepEqual(t.frames, [300, 238, 358]);
  assert.deepEqual(t.overlaps, [25, 13]);
  assert.deepEqual(t.offsets, [275, 275 + 238 - 13]);
  assert.equal(t.written, 300 + 238 + 358 - 25 - 13);
  assert.equal(t.written / 25, 34.32, "0:34.3 as the footer says");
  // A cut keeps its place, and a transition is at least one frame.
  const cut = timing([2, 2, 2], [CUT, tr("crossfade", 0.001), CUT], 30);
  assert.deepEqual([cut.overlaps, cut.offsets, cut.written], [[0, 1], [60, 119], 179]);
  assert.equal(junctionTicks({ lengths: [2, 2], transitions: [tr("crossfade", 1), CUT], fps: 10 }), "M 500 0 V 10");
});

test("the filter graph: trim each part out of the merge, xfade + acrossfade (qsin), a dip for the fades through black/white, concat for a cut", () => {
  const { graph, length } = transitionGraph([4, 4, 4], [tr("crossfade", 1), tr("fadeBlack", 1), CUT], 10, true);
  assert.equal(length, 10);
  assert.match(graph, /\[0:v\]trim=start_frame=0:end_frame=40,setpts=PTS-STARTPTS\[v0\]/);
  assert.match(graph, /\[0:v\]trim=start_frame=40:end_frame=80,setpts=PTS-STARTPTS\[v1\]/);
  assert.match(graph, /\[0:a\]atrim=start=4:end=8,asetpts=PTS-STARTPTS\[a1\]/);
  assert.match(graph, /\[v0\]\[v1\]xfade=transition=fade:duration=1:offset=3\[vj1\]/);
  assert.match(graph, /\[a0\]\[a1\]acrossfade=d=1:c1=qsin:c2=qsin\[aj1\]/);
  assert.match(graph, /\[vj1\]\[v2\]xfade=transition=fadeblack:duration=1:offset=6\[vout\]/);
  assert.match(graph, /\[aj1\]afade=t=out:st=6:d=0\.5\[ad2\];\[a2\]afade=t=in:st=0\.5:d=0\.5\[ai2\];\[ad2\]\[ai2\]acrossfade=d=1:c1=nofade:c2=nofade\[aout\]/);
  const cuts = transitionGraph([4, 4], [CUT, CUT], 10, false).graph;
  assert.equal(cuts, "[0:v]trim=start_frame=0:end_frame=40,setpts=PTS-STARTPTS[v0];[0:v]trim=start_frame=40:end_frame=80,setpts=PTS-STARTPTS[v1];[v0][v1]concat=n=2:v=1:a=0[vout]");
  assert.doesNotMatch(graph, /[;'"`$]{2}|\.\.\//, "only numbers and the plugin's own names");
});

test("ffmpeg's arguments: the Precise settings (CRF, x264 preset, yuv420p, AAC 48 kHz stereo at the tab's rate), -progress into a file, MP4", () => {
  const encode = { rate: "crf", crf: 20, speed: "balanced", height: 720, fps: 30, audio: 128 } as const;
  const { args, length } = transitionArgs({ input: "/w/merge.mp4", output: "/out/.x.mp4.partial", progress: "/w/merge.mp4.progress", lengths: [4, 4], transitions: [tr("wipe", 1, "up"), CUT], fps: 30, audio: true, encode, threads: 3 });
  assert.equal(length, 7);
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.deepEqual([at("-i"), at("-crf"), at("-preset"), at("-pix_fmt"), at("-c:a"), at("-ar"), at("-ac"), at("-b:a"), at("-progress"), at("-f"), args.at(-1)],
    ["/w/merge.mp4", "20", "medium", "yuv420p", "aac", "48000", "2", "128k", "/w/merge.mp4.progress", "mp4", "/out/.x.mp4.partial"]);
  assert.ok(args.includes("+faststart"));
  assert.match(at("-filter_complex")!, /xfade=transition=wipeup:duration=1:offset=3/);
  // "Same as source": the merged file's own bit rate, peaks up to 1.5 times it (as the player's Precise).
  const source = transitionArgs({ input: "i", output: "o", progress: "p", lengths: [4, 4], transitions: [tr("crossfade"), CUT], fps: 30, audio: false, encode: { ...encode, rate: "source" }, bitrate: 4e6, threads: 1 }).args;
  assert.deepEqual([source[source.indexOf("-b:v") + 1], source[source.indexOf("-maxrate") + 1], source.includes("-crf"), source.includes("-an")], ["4000000", "6000000", false, true]);
  // The merge: the best quality the player offers, the tab's size and rate ceilings.
  assert.deepEqual(mergeEncode(encode), { ...encode, crf: 14, speed: "faster", audio: 256 });
  assert.deepEqual(mergedLengths({ facts: { join: { parts: [{ start: 1, end: 3.5 }, { start: 0, end: 2 }] } } }, [2, 2]), [2.5, 2]);
  assert.deepEqual(mergedLengths({ facts: null }, [2, 2]), [2, 2]);
  assert.equal(progressTime("frame=1\nout_time_us=1500000\nprogress=continue\nout_time_us=2250000\nprogress=end\n"), 2.25);
  assert.equal(progressTime("frame=1\n"), null);
  // The first until the second's blend begins (6 s).
  assert.deepEqual([0, 3.2, 5.9, 6].map((s) => transitionAt([90, 180], [30, 30], 30, s)), [1, 1, 1, 2]);
});

// ---------------------------------------------------------------- the frames, with a real ffmpeg (skipped without one)

const FFMPEG = process.env.VESTRA_FFMPEG || "ffmpeg";
const haveFfmpeg = spawnSync(FFMPEG, ["-version"], { stdio: "ignore" }).status === 0;
const ffprobe = process.env.VESTRA_FFPROBE || "ffprobe";

test("every Wipe and Slide direction, checked on the frames: the new picture moves the way it is named; the fades dip; the length is Σ L − Σ d", { skip: !haveFfmpeg && "no ffmpeg (set VESTRA_FFMPEG)" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "clipexport-frames-"));
  try {
    // Part 1: red on the left half, green on the right (so a Slide, which pushes it, is told from a Wipe); part 2: blue.
    const merged = join(dir, "merged.mkv");
    const make = spawnSync(FFMPEG, ["-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=32x16:r=10:d=2", "-f", "lavfi", "-i", "color=c=lime:s=32x16:r=10:d=2", "-f", "lavfi", "-i", "color=c=blue:s=64x16:r=10:d=2",
      "-f", "lavfi", "-i", "sine=f=440:d=4:r=48000",
      "-filter_complex", "[0:v][1:v]hstack[a];[a][2:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
      "-c:v", "ffv1", "-c:a", "pcm_s16le", "-ac", "2", merged]);
    assert.equal(make.status, 0, String(make.stderr));
    const encode = { rate: "crf", crf: 14, speed: "faster", height: 0, fps: 0, audio: 192 } as const;
    // The frame half-way through the blend (1.0–2.0 s): which colour each quarter shows, left to right, then top and bottom.
    const look = (file: string) => {
      const raw = spawnSync(FFMPEG, ["-v", "error", "-ss", "1.5", "-i", file, "-frames:v", "1", "-vf", "scale=4:2:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer;
      const name = (i: number) => {
        const [r, g, b] = [raw[i * 3]!, raw[i * 3 + 1]!, raw[i * 3 + 2]!];
        return r > 160 && g > 160 && b > 160 ? "W" : r < 60 && g < 60 && b < 60 ? "K" : r > g && r > b ? "R" : g > r && g > b ? "G" : b > r && b > g ? "B" : "?";
      };
      return [0, 1, 2, 3, 4, 5, 6, 7].map(name).join("");
    };
    const expected: Record<string, string> = {
      // Wipe: the old picture stays where it was, the new one is revealed from the side opposite the name.
      "wipe left": "RRBBRRBB", "wipe right": "BBGGBBGG", "wipe up": "RRGGBBBB", "wipe down": "BBBBRRGG",
      // Slide: the old picture is pushed: Slide left shows its right (green) half on the left.
      "slide left": "GGBBGGBB", "slide right": "BBRRBBRR", "slide up": "RRGGBBBB", "slide down": "BBBBRRGG",
    };
    for (const [name, pixels] of Object.entries(expected)) {
      const [kind, way] = name.split(" ") as [Transition["kind"], Transition["dir"]];
      const out = join(dir, `${kind}-${way}.mp4`);
      const { args, length } = transitionArgs({ input: merged, output: out, progress: join(dir, "p.txt"), lengths: [2, 2], transitions: [tr(kind, 1, way), CUT], fps: 10, audio: true, encode, threads: 2 });
      const run = spawnSync(FFMPEG, args);
      assert.equal(run.status, 0, `${name}: ${String(run.stderr)}`);
      assert.equal(length, 3);
      assert.equal(look(out), pixels, name);
      if (spawnSync(ffprobe, ["-version"], { stdio: "ignore" }).status === 0) {
        const probed = Number(String(spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).stdout).trim());
        assert.ok(Math.abs(probed - 3) < 0.1, `${name}: ${probed} s`);
      }
    }
    // The fades through black and white: half-way, the picture is far darker (lighter) than either part.
    const channels = (file: string) => [...(spawnSync(FFMPEG, ["-v", "error", "-ss", "1.5", "-i", file, "-frames:v", "1", "-vf", "scale=4:2:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer)];
    for (const kind of ["fadeBlack", "fadeWhite"] as const) {
      const out = join(dir, `${kind}.mp4`);
      const run = spawnSync(FFMPEG, transitionArgs({ input: merged, output: out, progress: join(dir, "p.txt"), lengths: [2, 2], transitions: [tr(kind, 1), CUT], fps: 10, audio: true, encode, threads: 2 }).args);
      assert.equal(run.status, 0, String(run.stderr));
      const values = channels(out);
      if (kind === "fadeBlack") assert.ok(Math.max(...values) < 110, `through black: ${values}`);
      else assert.ok(Math.min(...values) > 140, `through white: ${values}`);
    }
    // The side-by-side pattern cannot tell Slide up from Wipe up: a top/bottom one (red over green) shows the push.
    const tb = join(dir, "tb.mkv");
    spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x8:r=10:d=2", "-f", "lavfi", "-i", "color=c=lime:s=64x8:r=10:d=2", "-f", "lavfi", "-i", "color=c=blue:s=64x16:r=10:d=2",
      "-filter_complex", "[0:v][1:v]vstack[a];[a][2:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "ffv1", tb]);
    for (const [way, pixels] of [["up", "GGGGBBBB"], ["down", "BBBBRRRR"]] as const) {
      const out = join(dir, `slide-tb-${way}.mp4`);
      spawnSync(FFMPEG, transitionArgs({ input: tb, output: out, progress: join(dir, "p.txt"), lengths: [2, 2], transitions: [tr("slide", 1, way), CUT], fps: 10, audio: false, encode, threads: 2 }).args);
      assert.equal(look(out), pixels, `slide ${way}: the old picture is pushed out`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the tab and the export

test("the junction rows: Cut by default (0.2.x output unchanged), a first pick gets 1 s, the cap is kept, the last part has none", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await add(host, "0", "1");
    await add(host, "10", "30");
    await add(host, "40", "50");
    assert.deepEqual(rows(host).map((r) => [r.join, r.kind]), [[true, "cut"], [true, "cut"], [false, "cut"]], "no transitions until the user picks");
    host.mounted().emit("set-method", 1);
    const [a, b, c] = rows(host).map((r) => r.id);
    host.mounted().emit("open-join", a);
    await eventually(() => {
      const p = tab(host).picker as { shown: boolean; from: number; to: number; cap: string; kind: string; joins: number };
      return [p.shown, p.from, p.to, p.cap, p.kind, p.joins];
    }, [true, 1, 2, "0.5", "cut", 2], "the picker of 1 → 2: its limit, Cut, two joins");
    host.mounted().emit("set-transition", a, "crossfade", "left", "1.0");
    await eventually(() => [rows(host)[0]!.kind, rows(host)[0]!.duration], ["crossfade", "0.5"], "1 s, held to the 0.5 s limit of the 1 s part");
    host.mounted().emit("set-transition", b, "slide", "up", "");
    await eventually(() => [rows(host)[1]!.kind, rows(host)[1]!.dir, rows(host)[1]!.duration], ["slide", "up", "1.0"], "a first pick: 1 s");
    host.mounted().emit("set-transition", b, "slide", "up", "30");
    await eventually(() => rows(host)[1]!.duration, "5.0", "a typed value over the limit is the limit (half of 10 s)");
    host.mounted().emit("set-transition", b, "wipe", "up", "1.5");
    await eventually(() => [rows(host)[1]!.kind, rows(host)[1]!.duration], ["wipe", "1.5"], "changing the kind keeps the length");
    await eventually(() => tab(host)["collection-info"], { count: 3, total: "0:29.0", checked: true, undo: false, transitions: 2, saved: "2.0", off: false });
    // A reorder carries a part's outgoing transition; moved to the last place it loses it.
    host.mounted().emit("move-part", b, 2);
    await eventually(() => rows(host).map((r) => [r.id, r.kind]), [[a, "crossfade"], [c, "cut"], [b, "cut"]]);
  } finally {
    await stop();
  }
});

test("Fast with matching files: the transitions are kept but greyed, the export joins with cuts and no ffmpeg runs; the picker does not open", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  const { cleanup } = await withFolder(host);
  try {
    await add(host, "0", "4");
    play(host, "/media/two.mp4");
    await add(host, "0", "4");
    const [a] = rows(host).map((r) => r.id);
    // Precise first: set it, then pick Fast.
    host.mounted().emit("set-method", 1);
    host.mounted().emit("open-join", a);
    host.mounted().emit("set-transition", a, "crossfade", "left", "1");
    await eventually(() => rows(host)[0]!.kind, "crossfade");
    host.mounted().emit("set-method", 0);
    await eventually(() => [rows(host)[0]!.off, (tab(host)["collection-info"] as { off: boolean; total: string }).off, (tab(host)["collection-info"] as { total: string }).total], [true, true, "0:08.0"]);
    host.mounted().emit("close-join");
    host.mounted().emit("open-join", a);
    await host.settle();
    assert.equal((tab(host).picker as { shown: boolean }).shown, false, "a chip does not open the picker in Fast");
    const runs = fakeFfmpeg(host);
    host.mounted().emit("export-merged");
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export");
    assert.equal(partsExports(host)[0]!.kind, "rawCopy");
    assert.equal(runs.length, 0, "no transitions run");
    // Precise again: they apply exactly as they were.
    host.mounted().emit("set-method", 1);
    await eventually(() => [rows(host)[0]!.off, rows(host)[0]!.kind, rows(host)[0]!.duration], [false, "crossfade", "1.0"]);
  } finally {
    await stop();
    await cleanup();
  }
});

/** Pretend to be ffmpeg for the transitions run: write the progress and the output; other runs (thumbnails) get nothing. */
function fakeFfmpeg(host: TestHost, behave: (args: string[]) => unknown = () => undefined) {
  const calls: string[][] = [];
  host.tools.handle("ffmpeg", (args) => {
    if (!args.includes("-filter_complex")) return { stdout: new Uint8Array() };
    calls.push(args);
    const outcome = behave(args);
    if (outcome instanceof Promise) {
      return outcome.then(() => {
        writeFileSync(args.at(-1)!, "the final file");
        return { stdout: new Uint8Array() };
      }) as never;
    }
    writeFileSync(args[args.indexOf("-progress") + 1]!, "out_time_us=2000000\nprogress=continue\n");
    writeFileSync(args.at(-1)!, "the final file");
    return { stdout: new Uint8Array() };
  });
  return calls;
}
/** Two parts of different sizes (Precise), a Crossfade between them. */
async function twoWithCrossfade(host: TestHost) {
  host.mediaFiles.set("/media/wide.mp4", WIDE);
  play(host, "/media/one.mp4");
  await add(host, "0", "4");
  play(host, "/media/wide.mp4");
  await add(host, "0", "4");
  const id = rows(host)[0]!.id;
  host.mounted().emit("open-join", id);
  host.mounted().emit("set-transition", id, "crossfade", "left", "1");
  await eventually(() => rows(host)[0]!.kind, "crossfade");
  await eventually(() => tab(host)["collection-method-index"], 1, "Precise");
}
const leftovers = (data: string, folder: string) => [
  ...(existsSync(join(data, "work")) ? readdirSync(join(data, "work")) : []),
  ...readdirSync(folder).filter((name) => name.endsWith(".partial")),
];

test("Precise with a transition: the player merges into the work folder, the plugin's ffmpeg writes the file; the work files go", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  const { stop } = await start(host, "en", data);
  const { folder, cleanup } = await withFolder(host);
  try {
    await twoWithCrossfade(host);
    const calls = fakeFfmpeg(host);
    host.mounted().emit("export-merged");
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export");
    const job = partsExports(host)[0]!;
    assert.equal(job.kind, "rawMp4");
    assert.ok(String(job.destination).startsWith(join(data, "work")), "the merge goes into the plugin's work folder");
    assert.equal((job.encoding as { crf: number }).crf, 14, "the merge at the best quality");
    assert.equal(calls.length, 1);
    const at = (flag: string) => calls[0]![calls[0]!.indexOf(flag) + 1];
    assert.equal(at("-i"), String(job.destination));
    assert.match(at("-filter_complex")!, /xfade=transition=fade:duration=1:offset=3/);
    assert.equal(at("-crf"), "18", "the tab's Precise quality (High quality)");
    const finals = (await readdir(folder)).filter((name) => name.endsWith(".mp4"));
    assert.equal(finals.length, 1);
    assert.equal(await readFile(join(folder, finals[0]!), "utf8"), "the final file");
    assert.equal(calls[0]!.at(-1), partialOf(join(folder, finals[0]!)), "written beside it under a hidden name first");
    await until(() => leftovers(data, folder).length === 0, "no work files left");
    await eventually(() => (tab(host).results as { badge: string; state: string }[]).map((r) => [r.badge, r.state]), [["7.0", "completed"]], "the result is 4 + 4 − 1 s");
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("the transitions fail: the reason is said, the task can be retried, and nothing is left: no work file, no half file", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  const { stop } = await start(host, "en", data);
  const { folder, cleanup } = await withFolder(host);
  try {
    await twoWithCrossfade(host);
    let fail = true;
    fakeFfmpeg(host, (args) => {
      if (fail) {
        writeFileSync(args.at(-1)!, "half");
        throw new HostError("failed", "Conversion failed!");
      }
    });
    host.mounted().emit("export-merged");
    await until(() => host.osd.includes(`Export failed: ${REASON.transitionFailed}`), "the failure");
    await until(() => leftovers(data, folder).length === 0, "no work files left");
    assert.deepEqual((await readdir(folder)).filter((n) => n.endsWith(".mp4")), []);
    // Retry: the same parts and transitions again.
    fail = false;
    const failed = (tab(host).results as { id: string; state: string }[]).find((r) => r.state === "failed")!;
    host.mounted().emit("retry-task", failed.id);
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the retried export");
    assert.equal(partsExports(host).length, 2);
    await until(() => leftovers(data, folder).length === 0, "no work files left");
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("cancel while the transitions are written: ffmpeg is stopped, the task is cancelled, the work files and the half file go", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  const { stop } = await start(host, "en", data);
  const { folder, cleanup } = await withFolder(host);
  let release!: () => void;
  try {
    await twoWithCrossfade(host);
    let running = false;
    fakeFfmpeg(host, (args) => {
      running = true;
      writeFileSync(args.at(-1)!, "half");
      writeFileSync(args[args.indexOf("-progress") + 1]!, "out_time_us=1500000\nprogress=continue\n");
      return new Promise<void>((done) => (release = done));
    });
    host.mounted().emit("export-merged");
    await until(() => running, "the transitions run");
    await eventually(() => {
      const card = tab(host).card as { transition: number; transitions: number };
      return [card.transition, card.transitions];
    }, [1, 1], "the card says transition 1 / 1");
    const row = (tab(host).results as { id: string; cancellable: boolean }[]).find((r) => r.cancellable)!;
    host.mounted().emit("cancel-task", row.id);
    release();
    await eventually(() => (tab(host).results as { state: string }[]).map((r) => r.state), ["cancelled"]);
    await until(() => leftovers(data, folder).length === 0, "no work files left");
    assert.deepEqual((await readdir(folder)).filter((n) => !n.startsWith(".")), [], "no file under the user's name");
  } finally {
    release?.();
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("the merge itself fails or is cancelled: no ffmpeg run, no work file left", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  const { stop } = await start(host, "en", data);
  const { folder, cleanup } = await withFolder(host);
  try {
    await twoWithCrossfade(host);
    const calls = fakeFfmpeg(host);
    host.exportFailure = { code: "export-failed", message: "disk" };
    host.mounted().emit("export-merged");
    await until(() => host.osd.some((line) => line.startsWith("Export failed")), "the failure");
    assert.equal(calls.length, 0);
    await until(() => leftovers(data, folder).length === 0, "no work files left");
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("Apply to All puts one transition on every junction (each held to its limit) and on new parts; Undo brings the old ones back", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await add(host, "0", "10");
    await add(host, "10", "14");
    await add(host, "20", "22");
    const [a] = rows(host).map((r) => r.id);
    host.mounted().emit("set-method", 1);
    host.mounted().emit("open-join", a);
    host.mounted().emit("set-transition", a, "fadeBlack", "left", "1");
    host.mounted().emit("set-transition", a, "fadeBlack", "left", "1.5");
    await eventually(() => rows(host)[0]!.duration, "1.5");
    host.mounted().emit("apply-all", a);
    await eventually(() => rows(host).map((r) => [r.kind, r.duration]), [["fadeBlack", "1.5"], ["fadeBlack", "1.0"], ["cut", "1.0"]], "each held to its own limit (half of the 2 s part)");
    await until(() => host.osd.at(-1) === "Transition applied to every join.", "the message with Undo");
    // A new part joins the last one with the default.
    await add(host, "40", "50");
    await eventually(() => rows(host).map((r) => r.kind), ["fadeBlack", "fadeBlack", "fadeBlack", "cut"]);
    await host.pressOsdAction(0);
    await eventually(() => rows(host).map((r) => r.kind), ["fadeBlack", "cut", "cut", "cut"], "every junction as it was before Apply to All");
    await add(host, "50", "55");
    await eventually(() => rows(host).map((r) => r.kind), ["fadeBlack", "cut", "cut", "cut", "cut"], "and the default is Cut again");
  } finally {
    await stop();
  }
});

test("transitions are kept with the parts across restarts; a 0.2.x list loads with Cuts", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  try {
    await writeFile(join(data, "collection.json"), JSON.stringify({ parts: [
      { id: "p1", token: "t1", name: "a.mp4", start: 0, end: 10, thumb: "" },
      { id: "p2", token: "t2", name: "b.mp4", start: 0, end: 10, thumb: "" },
    ] }));
    const host = new TestHost();
    play(host, "/media/one.mp4");
    const first = await start(host, "en", data);
    await eventually(() => rows(host).map((r) => r.kind), ["cut", "cut"], "0.2.x: Cuts");
    host.mounted().emit("open-join", "p1");
    host.mounted().emit("set-transition", "p1", "slide", "down", "");
    await eventually(() => rows(host)[0]!.kind, "slide");
    await first.stop();
    const stored = JSON.parse(await readFile(join(data, "collection.json"), "utf8"));
    assert.deepEqual(stored.parts[0].transition, { kind: "slide", dir: "down", duration: 1 });
    const again = new TestHost();
    play(again, "/media/one.mp4");
    const second = await start(again, "en", data);
    await eventually(() => rows(again).map((r) => [r.kind, r.dir, r.duration]), [["slide", "down", "1.0"], ["cut", "left", "1.0"]]);
    await second.stop();
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
