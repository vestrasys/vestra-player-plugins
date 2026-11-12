import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Locale } from "@vestra-player/sdk";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate from "../main.ts";
import { REASON } from "../model.ts";
import {
  applied, capOf, CUT, estimated, junctionTicks, layoutOf, parsePts, ptsArgs, sourceBitrate, mergedLengths, mergeEncode, normalize, progressTime, soundOf, timing, transitionArgs, transitionAt, transitionGraph,
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
  assert.match(graph, /\[0:v\]trim=start_frame=0:end_frame=40,settb=AVTB,setpts=N\/\(\d+\*TB\)\[v0\]/);
  assert.match(graph, /\[0:v\]trim=start_frame=40:end_frame=80,settb=AVTB,setpts=N\/\(\d+\*TB\)\[v1\]/);
  assert.match(graph, /\[0:a\]atrim=start=4:end=8,asettb=1\/48000,asetpts=N\/SR\/TB,apad=whole_len=192000,atrim=end_sample=192000,asetpts=N\/SR\/TB\[a1\]/);
  // The offset half a frame before the blend's first frame: xfade starts at the first frame at or after it, whatever the rounding.
  assert.match(graph, /\[v0\]\[v1\]xfade=transition=fade:duration=1:offset=2\.95\[vj1\]/);
  assert.match(graph, /\[a0\]\[a1\]acrossfade=ns=48000:c1=qsin:c2=qsin\[aj1\]/);
  assert.match(graph, /\[vj1\]\[v2\]xfade=transition=fadeblack:duration=1:offset=5\.95\[vout\]/);
  assert.match(graph, /\[aj1\]afade=t=out:st=6:d=0\.5\[ad2\];\[a2\]afade=t=in:st=0\.5:d=0\.5\[ai2\];\[ad2\]\[ai2\]acrossfade=ns=48000:c1=nofade:c2=nofade\[sound\]/);
  const cuts = transitionGraph([4, 4], [CUT, CUT], 10, false).graph;
  assert.equal(cuts, "[0:v]trim=start_frame=0:end_frame=40,settb=AVTB,setpts=N/(10*TB)[v0];[0:v]trim=start_frame=40:end_frame=80,settb=AVTB,setpts=N/(10*TB)[v1];[v0][v1]concat=n=2:v=1:a=0,settb=AVTB[vout]");
  // One timebase on every branch: concat writes 1/1000000, a trimmed part keeps its file's, and xfade takes only equal ones.
  assert.equal(graph.split(";").filter((step) => step.startsWith("[0:v]") && !step.includes("settb=AVTB")).length, 0);
  assert.doesNotMatch(graph, /[;'"`$]{2}|\.\.\//, "only numbers and the plugin's own names");
});

test("ffmpeg's arguments: the Precise settings (CRF, x264 preset, yuv420p, AAC 48 kHz stereo at the tab's rate), -progress into a file, MP4", () => {
  const encode = { format: "mp4", rate: "crf", crf: 20, speed: "balanced", height: 720, fps: 30, audio: 128 } as const;
  const { args, graph, length } = transitionArgs({ input: "/w/merge.mp4", output: "/out/.x.mp4.partial", progress: "/w/merge.mp4.progress", script: "/w/merge.mp4.graph", lengths: [4, 4], transitions: [tr("wipe", 1, "up"), CUT], fps: 30, audio: true, encode, threads: 3 });
  assert.equal(length, 7);
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.deepEqual([at("-i"), at("-crf"), at("-preset"), at("-pix_fmt"), at("-c:a"), at("-ar"), at("-ac"), at("-b:a"), at("-progress"), at("-f"), args.at(-1)],
    ["/w/merge.mp4", "20", "medium", "yuv420p", "aac", "48000", "2", "128k", "/w/merge.mp4.progress", "mp4", "/out/.x.mp4.partial"]);
  assert.ok(args.includes("+faststart"));
  assert.equal(at("-/filter_complex"), "/w/merge.mp4.graph", "the graph is read from a file (Windows' command line is 32 767 characters)");
  assert.ok(!args.includes("-filter_complex"));
  assert.match(graph, /xfade=transition=wipeup:duration=1:offset=2\.983333/);
  // "Same as source": the merged file's own bit rate, peaks up to 1.5 times it (as the player's Precise).
  const source = transitionArgs({ input: "i", output: "o", progress: "p", script: "g", lengths: [4, 4], transitions: [tr("crossfade"), CUT], fps: 30, audio: false, encode: { ...encode, rate: "source" }, bitrate: 4e6, threads: 1 }).args;
  assert.deepEqual([source[source.indexOf("-b:v") + 1], source[source.indexOf("-maxrate") + 1], source.includes("-crf"), source.includes("-an")], ["4000000", "6000000", false, true]);
  // The merge: the best quality the player offers, the tab's size and rate ceilings; "Same as source" too (its bit rate is for the final only).
  assert.deepEqual(mergeEncode(encode), { ...encode, crf: 14, speed: "faster", audio: 256 });
  assert.deepEqual(mergeEncode({ ...encode, rate: "source" }), { ...encode, rate: "crf", crf: 14, speed: "faster", audio: 256 });
  assert.equal(sourceBitrate([{ start: 0, end: 1, bitrate: 3e6 }, { start: 0, end: 3, bitrate: 7e6 }, { start: 0, end: 5 }]), 6e6, "weighted by length; parts without one left out");
  assert.equal(sourceBitrate([{ start: 0, end: 1 }]), null);
  assert.deepEqual(mergedLengths({ facts: { join: { parts: [{ start: 1, end: 3.5 }, { start: 0, end: 2 }] } } }, [2, 2]), [2.5, 2]);
  assert.deepEqual(mergedLengths({ facts: null }, [2, 2]), [2, 2]);
  assert.equal(progressTime("frame=1\nout_time_us=1500000\nprogress=continue\nout_time_us=2250000\nprogress=end\n"), 2.25);
  assert.equal(progressTime("frame=1\n"), null);
  // The first until the second's blend begins (6 s).
  assert.deepEqual([0, 3.2, 5.9, 6].map((s) => transitionAt([90, 180], [30, 30], 30, s)), [1, 1, 1, 2]);
});

// ---------------------------------------------------------------- the frames, with a real ffmpeg (skipped without one)

const FFMPEG = process.env.VESTRA_FFMPEG || "ffmpeg";
/** The arguments, with the graph written to its file as the plugin does. */
function encodeWith(o: Parameters<typeof transitionArgs>[0]) {
  const built = transitionArgs(o);
  writeFileSync(o.script, built.graph);
  return built;
}
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
    const encode = { format: "mp4", rate: "crf", crf: 14, speed: "faster", height: 0, fps: 0, audio: 192 } as const;
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
      const { args, length } = encodeWith({ input: merged, output: out, progress: join(dir, "p.txt"), script: join(dir, "g.txt"), lengths: [2, 2], transitions: [tr(kind, 1, way), CUT], fps: 10, audio: true, encode, threads: 2 });
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
      const run = spawnSync(FFMPEG, encodeWith({ input: merged, output: out, progress: join(dir, "p.txt"), script: join(dir, "g.txt"), lengths: [2, 2], transitions: [tr(kind, 1), CUT], fps: 10, audio: true, encode, threads: 2 }).args);
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
      spawnSync(FFMPEG, encodeWith({ input: tb, output: out, progress: join(dir, "p.txt"), script: join(dir, "g.txt"), lengths: [2, 2], transitions: [tr("slide", 1, way), CUT], fps: 10, audio: false, encode, threads: 2 }).args);
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
    await eventually(() => tab(host)["collection-info"], { count: 3, total: "0:29.0", checked: true, undo: false, transitions: 2, saved: "2.0", off: false, switched: false });
    // A reorder carries a part's outgoing transition; moved to the last place it loses it.
    host.mounted().emit("move-part", b, 2);
    await eventually(() => rows(host).map((r) => [r.id, r.kind]), [[a, "crossfade"], [c, "cut"], [b, "cut"]]);
  } finally {
    await stop();
  }
});

test("Fast with matching files: transitions are kept but greyed, the export joins with cuts and no ffmpeg runs; Precise applies them again", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  const { cleanup } = await withFolder(host);
  try {
    await add(host, "0", "4");
    play(host, "/media/two.mp4");
    await add(host, "0", "4");
    const [a] = rows(host).map((r) => r.id);
    // Precise first: set it, then pick Fast (the user's choice: the transition stays, greyed).
    host.mounted().emit("set-method", 1);
    host.mounted().emit("open-join", a);
    host.mounted().emit("set-transition", a, "crossfade", "left", "1");
    await eventually(() => rows(host)[0]!.kind, "crossfade");
    host.mounted().emit("set-method", 0);
    await eventually(() => [rows(host)[0]!.off, (tab(host)["collection-info"] as { off: boolean; total: string }).off, (tab(host)["collection-info"] as { total: string }).total], [true, true, "0:08.0"]);
    host.mounted().emit("close-join");
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

test("a transition picked in Fast switches the method to Precise and says so; a Cut keeps Fast; parts Fast cannot join change nothing", async () => {
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await add(host, "0", "4");
    await add(host, "10", "14");
    await add(host, "20", "24");
    const [a, b] = rows(host).map((r) => r.id);
    const method = () => tab(host)["method-index"];
    const info = () => tab(host)["collection-info"] as { off: boolean; switched: boolean };
    const picker = () => tab(host).picker as { shown: boolean; kind: string };
    await eventually(() => [method(), tab(host)["collection-method-index"]], [0, 0], "Fast, and Fast can join these parts");
    // The chip opens the picker in Fast too.
    host.mounted().emit("open-join", a);
    await eventually(() => [picker().shown, picker().kind], [true, "cut"]);
    // A Cut keeps Fast.
    host.mounted().emit("set-transition", a, "cut", "left", "");
    await host.settle();
    assert.deepEqual([method(), info().switched], [0, false], "a Cut keeps Fast");
    // A transition: Precise, one line says so, the picker stays open on it.
    host.mounted().emit("set-transition", a, "crossfade", "left", "");
    await eventually(() => [rows(host)[0]!.kind, method(), tab(host)["collection-method-index"], info().switched, info().off], ["crossfade", 1, 1, true, false]);
    assert.deepEqual([picker().shown, picker().kind], [true, "crossfade"]);
    // Back to Cut: nothing needs Precise any more, so the line goes (the method stays as it is); it does not come back
    // by itself when a transition is picked again in Precise (nothing is switched then).
    host.mounted().emit("set-transition", a, "cut", "left", "");
    await eventually(() => [rows(host)[0]!.kind, method(), info().switched], ["cut", 1, false]);
    host.mounted().emit("set-transition", a, "crossfade", "left", "");
    await eventually(() => rows(host)[0]!.kind, "crossfade");
    await host.settle();
    assert.equal(info().switched, false, "picked in Precise: no switch to speak of");
    // In Fast again, a transition switches and says so once more.
    host.mounted().emit("set-method", 0);
    host.mounted().emit("set-transition", a, "wipe", "left", "");
    await eventually(() => [rows(host)[0]!.kind, method(), info().switched], ["wipe", 1, true]);
    // The user's own pick of a method takes the line away (and Fast greys the transition again).
    host.mounted().emit("set-method", 0);
    await eventually(() => [method(), info().switched, info().off, rows(host)[0]!.off], [0, false, true, true]);
    // Apply to All of a transition in Fast: Precise as well.
    host.mounted().emit("open-join", a);
    host.mounted().emit("apply-all", a);
    await eventually(() => [method(), info().switched, rows(host)[0]!.kind, rows(host)[1]!.kind], [1, true, "wipe", "wipe"]);
    // Undo of Apply to All, then the last transition back to Cut: the line goes with it.
    await host.command("clip.collectionUndoApply").run();
    await eventually(() => [rows(host)[0]!.kind, rows(host)[1]!.kind, info().switched], ["wipe", "cut", true], "one transition left: still Precise because of it");
    host.mounted().emit("set-transition", a, "cut", "left", "");
    await eventually(() => [rows(host)[0]!.kind, info().switched], ["cut", false]);
    // Clear takes the line away with the parts.
    host.mounted().emit("set-method", 0);
    host.mounted().emit("set-transition", a, "slide", "left", "");
    await eventually(() => info().switched, true);
    host.mounted().emit("clear-parts");
    await eventually(() => [(tab(host)["collection-info"] as { count: number }).count, info().switched], [0, false]);
    void b;
  } finally {
    await stop();
  }
});

test("parts Fast cannot join: Precise already, a transition picked there switches nothing", async () => {
  const host = new TestHost();
  host.mediaFiles.set("/media/wide.mp4", WIDE);
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await add(host, "0", "4");
    play(host, "/media/wide.mp4");
    await add(host, "0", "4");
    const [a] = rows(host).map((r) => r.id);
    await eventually(() => [tab(host)["method-index"], tab(host)["collection-method-index"]], [0, 1], "Fast chosen, the merge is Precise");
    host.mounted().emit("open-join", a);
    host.mounted().emit("set-transition", a, "slide", "up", "");
    await eventually(() => rows(host)[0]!.kind, "slide");
    await host.settle();
    assert.deepEqual([tab(host)["method-index"], (tab(host)["collection-info"] as { switched: boolean }).switched], [0, false], "the clip's Fast stays; nothing to say");
  } finally {
    await stop();
  }
});

test("the picker never shows empty: it opens only on a junction (a serial per open), and closes when its junction goes", async () => {
  // 0.3.0 showed "Transition 0 → 0" with nothing to pick when the tab showed the popup before the plugin had opened it.
  const host = new TestHost();
  play(host, "/media/one.mp4");
  const { stop } = await start(host);
  try {
    await add(host, "0", "4");
    await add(host, "10", "14");
    await add(host, "20", "24");
    const [a, b, c] = rows(host).map((r) => r.id);
    const picker = () => tab(host).picker as { shown: boolean; serial: number; id: string; from: number; to: number };
    // Shown always comes with a real junction: from n into n + 1.
    const valid = () => !picker().shown || (picker().from >= 1 && picker().to === picker().from + 1 && picker().id !== "");
    let serial = picker().serial;
    assert.equal(picker().shown, false);
    // Every junction opens, in Fast and in Precise, each open a new serial (the tab shows the popup on it).
    for (const methodIndex of [0, 1]) {
      host.mounted().emit("set-method", methodIndex);
      for (const [index, row] of rows(host).entries()) {
        if (!row.join) continue;
        host.mounted().emit("open-join", row.id);
        await eventually(() => [picker().shown, picker().serial, picker().from, picker().to], [true, serial + 1, index + 1, index + 2]);
        serial++;
        assert.ok(valid());
      }
    }
    // The last part has no junction, an unknown part none either: refused, no new serial (no popup).
    host.mounted().emit("close-join");
    await eventually(() => picker().shown, false);
    for (const id of [c, "nope"]) {
      host.mounted().emit("open-join", id);
      await host.settle();
      assert.deepEqual([picker().shown, picker().serial], [false, serial], `open-join ${id}`);
    }
    // Open on a junction, then it goes: moved last, or its part removed. The picker closes (the tab closes the popup).
    host.mounted().emit("open-join", b);
    await eventually(() => [picker().shown, picker().id], [true, b]);
    host.mounted().emit("move-part", b, 2);
    await eventually(() => picker().shown, false, "its part moved last: no junction below it");
    assert.ok(valid());
    host.mounted().emit("open-join", a);
    await eventually(() => [picker().shown, picker().id], [true, a]);
    host.mounted().emit("remove-part", a);
    await eventually(() => picker().shown, false, "its part removed");
    // Leaving the page closes it too.
    const [first] = rows(host).map((r) => r.id);
    host.mounted().emit("open-join", first);
    await eventually(() => picker().shown, true);
    host.mounted().emit("set-page", 1);
    await eventually(() => picker().shown, false, "another page in front");
    // The tab's side: the popup shows only on a new serial with the picker shown, and closes when it is not.
    const slint = await readFile(new URL("../ui/tab.slint", import.meta.url), "utf8");
    assert.equal(slint.split("picker-popup.show()").length - 1, 1, "one place shows the popup");
    assert.match(slint, /changed picker-serial => \{\s*if ClipBridge\.picker\.shown \{ picker-popup\.show\(\); \}/);
    assert.match(slint, /changed picker-shown => \{\s*if !self\.picker-shown \{ picker-popup\.close\(\); \}/);
  } finally {
    await stop();
  }
});

/** Pretend to be ffmpeg for the transitions run: write the progress and the output; other runs (thumbnails) get nothing. */
function fakeFfmpeg(host: TestHost, behave: (args: string[]) => unknown = () => undefined) {
  const calls: string[][] = [];
  host.tools.handle("ffmpeg", (args) => {
    if (!args.includes("-/filter_complex")) return { stdout: new Uint8Array() };
    // The graph file exists while ffmpeg runs: keep its text with the call.
    calls.push([...args, `graph:${readFileSync(args[args.indexOf("-/filter_complex") + 1]!, "utf8")}`]);
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
    assert.match(calls[0]!.at(-1)!, /xfade=transition=fade:duration=1:offset=2\.983333/);
    assert.equal(at("-crf"), "18", "the tab's Precise quality (High quality)");
    const finals = (await readdir(folder)).filter((name) => name.endsWith(".mp4"));
    assert.equal(finals.length, 1);
    assert.equal(await readFile(join(folder, finals[0]!), "utf8"), "the final file");
    assert.equal(calls[0]!.at(-2), partialOf(join(folder, finals[0]!)), "written beside it under a hidden name first");
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

// ---------------------------------------------------------------- review fixes: the real layout, long graphs, leftovers

test("the layout is measured: each part starts at its first frame at or after the one before plus its length (the merge's padding included)", () => {
  // The reviewer's merge: 2.514, 1.789, 0.9 and 1.768 s at 30 fps came out as 75, 53, 27 and 53 frames, each part
  // starting after its sound's AAC padding (the 0.9 s part's start falls on the frame grid, no gap shows).
  const grid = (start: number, frames: number) => Array.from({ length: frames }, (_, k) => start + k / 30);
  const pts = [...grid(0, 75), ...grid(2.535352, 53), ...grid(4.324349, 27), ...grid(5.224349, 53)].reverse();
  const layout = layoutOf(pts, [2.514, 1.789, 0.9, 1.768])!;
  assert.deepEqual(layout.frames, [75, 53, 27, 53]);
  assert.deepEqual(layout.times.map((s) => Math.round(s * 1e6) / 1e6), [0, 2.535352, 4.324349, 5.224349]);
  assert.deepEqual(estimated([2.514, 1.789, 0.9, 1.768], 30).frames, [75, 54, 27, 53], "what rounding guessed (one frame off)");
  assert.equal(layoutOf([], [1]), null);
  assert.equal(layoutOf([0, 0.1], [0.05, 0.05, 0.05]), null, "a part with no frame");
  // The graph cuts the sound at each part's own start, for its frames' length.
  const { graph } = transitionGraph(layout, [tr("crossfade", 0.5), CUT, CUT, CUT], 30, true);
  assert.match(graph, /\[0:a\]atrim=start=2\.535352:end=4\.302019,asettb=1\/48000,asetpts=N\/SR\/TB,apad=whole_len=84800,atrim=end_sample=84800,asetpts=N\/SR\/TB\[a1\]/);
  assert.match(graph, /\[0:v\]trim=start_frame=75:end_frame=128,settb=AVTB,setpts=N\/\(\d+\*TB\)\[v1\]/);
});

test("100 parts with fades through black: the graph is a file (it is longer than Windows' 32 767-character command line)", () => {
  // Long parts at 60 fps: frame numbers of six digits, as an hour-long Collection has.
  const lengths = Array.from({ length: 100 }, () => 61.234);
  const transitions = lengths.map((_, i) => (i < 99 ? tr("fadeBlack", 0.5) : CUT));
  const { args, graph } = transitionArgs({ input: "C:\\work\\merge-1.mp4", output: "C:\\videos\\.a.mp4.partial", progress: "p", script: "C:\\work\\merge-1.mp4.graph", lengths, transitions, fps: 60, audio: true, encode: { format: "mp4", rate: "crf", crf: 18, speed: "faster", height: 0, fps: 0, audio: 192 }, threads: 4 });
  assert.ok(graph.length > 32_767, `${graph.length} characters of graph`);
  assert.ok(args.join(" ").length < 2_000, "the command line stays short");
});

test("with a real ffmpeg: parts merged the player's way (fractional lengths at 60 fps) are found where they are; 100 parts run from a graph file", { skip: !haveFfmpeg && "no ffmpeg (set VESTRA_FFMPEG)" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "clipexport-merge-"));
  const probe = (args: string[]) => String(spawnSync(ffprobe, args).stdout);
  try {
    // Four sources at 25 fps in four colours, cut and re-encoded as the player's Precise merge does it (-ss, -t, fps, AAC),
    // then joined with the concat demuxer (no durations in the list).
    const colours = ["red", "lime", "blue", "yellow"];
    const lengths = [1.789, 0.95, 1.2345, 0.9];
    const list: string[] = ["ffconcat version 1.0"];
    for (const [i, colour] of colours.entries()) {
      const source = join(dir, `src-${i}.mp4`);
      spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=32x16:r=25:d=5`, "-f", "lavfi", "-i", "sine=f=440:d=5:r=44100", "-c:v", "libx264", "-c:a", "aac", "-shortest", source]);
      const part = join(dir, `part-${i}.mp4`);
      const made = spawnSync(FFMPEG, ["-v", "error", "-y", "-ss", "0.37", "-t", String(lengths[i]), "-i", source, "-vf", "fps=60", "-af", "aresample=48000", "-t", String(lengths[i]), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", part]);
      assert.equal(made.status, 0, String(made.stderr));
      list.push(`file '${part.replace(/\\/g, "/")}'`);
    }
    writeFileSync(join(dir, "list.txt"), `${list.join("\n")}\n`);
    const merged = join(dir, "merged.mp4");
    assert.equal(spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-c", "copy", merged]).status, 0);
    // What each part really is: its frames and its file's duration (where the concat demuxer puts the next one).
    const truth = colours.map((_, i) => {
      const file = join(dir, `part-${i}.mp4`);
      return {
        frames: Number(probe(["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file]).trim()),
        duration: Number(probe(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim()),
      };
    });
    const layout = layoutOf(parsePts(probe(ptsArgs(merged))), lengths)!;
    assert.deepEqual(layout.frames, truth.map((t) => t.frames), "each part's frames as the merge has them");
    // Each part starts after the one before plus its length, by at most its sound's padding (a 1024-sample AAC frame) and a frame.
    truth.forEach((_, i) => {
      if (!i) return assert.ok(layout.times[0]! >= 0 && layout.times[0]! < 0.1, `the first frame at ${layout.times[0]} s`);
      const after = layout.times[i - 1]! + lengths[i - 1]!;
      assert.ok(layout.times[i]! >= after - 1e-3 && layout.times[i]! <= after + 1024 / 48000 + 1 / 60 + 1e-3, `part ${i + 1} starts at ${layout.times[i]} (after ${after})`);
    });
    assert.ok(layout.frames.some((f, i) => f !== Math.round(lengths[i]! * 60)) || layout.times.some((s, i) => Math.abs(s - lengths.slice(0, i).reduce((a, b) => a + b, 0)) > 0.005),
      "the merge differs from the plain sums (the case this measures)");
    // The transitions on the measured layout: every part's own colour in the middle of its stretch; picture and sound as long.
    const transitions = [tr("crossfade", 0.3), tr("wipe", 0.3, "left"), tr("fadeBlack", 0.3), CUT];
    const out = join(dir, "out.mp4");
    const built = encodeWith({ input: merged, output: out, progress: join(dir, "p.txt"), script: join(dir, "g.txt"), lengths: layout, transitions, fps: 60, audio: true, encode: { format: "mp4", rate: "crf", crf: 18, speed: "faster", height: 0, fps: 0, audio: 192 }, threads: 2 });
    const run = spawnSync(FFMPEG, built.args);
    assert.equal(run.status, 0, String(run.stderr));
    const t = timing(layout, transitions, 60);
    const written = Number(probe(["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", out]).trim());
    assert.equal(written, t.written, "the frames written: the parts' frames less the overlaps");
    const streams = probe(["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "csv=p=0", out]).trim().split(/\r?\n/).map((l) => l.split(","));
    const video = Number(streams.find((s) => s[0] === "video")![1]);
    const sound = Number(streams.find((s) => s[0] === "audio")![1]);
    // The sound ends with the picture, give or take the AAC encoder's own padding (up to two 1024-sample frames).
    assert.ok(Math.abs(video - sound) < 2 * 1024 / 48000 + 0.005, `picture ${video} s, sound ${sound} s`);
    const colourAt = (frame: number) => {
      const raw = spawnSync(FFMPEG, ["-v", "error", "-i", out, "-vf", `select=eq(n\\,${frame}),scale=1:1`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer;
      const [r, g, b] = [raw[0]!, raw[1]!, raw[2]!];
      return r > 150 && g > 150 && b < 100 ? "yellow" : r > 150 && g < 100 ? "red" : g > 150 && r < 100 ? "lime" : b > 150 ? "blue" : `?${r},${g},${b}`;
    };
    // Part i's own stretch in the output: after the blend into it, before the blend out of it.
    let begin = 0;
    t.frames.forEach((frames, i) => {
      const into = i ? t.overlaps[i - 1]! : 0;
      const out2 = t.overlaps[i] ?? 0;
      const middle = Math.floor(begin + into + (frames - into - out2) / 2);
      assert.equal(colourAt(middle), colours[i], `part ${i + 1} in the middle of its own frames`);
      begin += frames - out2;
    });
    // 100 parts of 0.5 s at 10 fps, each joined to the next through black for 0.2 s: ffmpeg reads the long graph from its file.
    const many = join(dir, "many.mkv");
    spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=32x16:r=10:d=50", "-f", "lavfi", "-i", "sine=d=50:r=48000", "-c:v", "ffv1", "-c:a", "pcm_s16le", "-ac", "2", many]);
    const lengths100 = Array.from({ length: 100 }, () => 0.5);
    const long = encodeWith({ input: many, output: join(dir, "many-out.mp4"), progress: join(dir, "p2.txt"), script: join(dir, "g2.txt"), lengths: lengths100, transitions: lengths100.map((_, i) => (i < 99 ? tr("fadeBlack", 0.2) : CUT)), fps: 10, audio: true, encode: { format: "mp4", rate: "crf", crf: 30, speed: "faster", height: 0, fps: 0, audio: 128 }, threads: 2 });
    const ran = spawnSync(FFMPEG, long.args);
    assert.equal(ran.status, 0, String(ran.stderr));
    const length = Number(probe(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(dir, "many-out.mp4")]).trim());
    assert.ok(Math.abs(length - (50 - 99 * 0.2)) < 0.15, `${length} s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("on activation, what a crash left goes: the work folder is emptied, recorded half files beside the videos are deleted", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const videos = await mkdtemp(join(tmpdir(), "clipexport-videos-"));
  try {
    await mkdir(join(data, "work"), { recursive: true });
    for (const name of ["merge-1.mp4", ".vestra-export-12.tmp", "merge-1.mp4.progress", "merge-1.mp4.graph"]) await writeFile(join(data, "work", name), "left");
    const half = join(videos, ".clip_collection.mp4.partial");
    await writeFile(half, "half");
    await writeFile(join(videos, "mine.mp4"), "the user's");
    await writeFile(join(data, "inflight.json"), JSON.stringify({ partials: [half, join(videos, "mine.mp4")] }));
    const host = new TestHost();
    const { stop } = await start(host, "en", data);
    try {
      await until(() => readdirSync(join(data, "work")).length === 0 && !existsSync(half), "the leftovers gone");
      assert.ok(existsSync(join(videos, "mine.mp4")), "only the plugin's own hidden .partial names are ever deleted");
      await until(async () => JSON.parse(await readFile(join(data, "inflight.json"), "utf8")).partials.length === 0, "the record emptied");
    } finally {
      await stop();
    }
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(videos, { recursive: true, force: true });
  }
});

test("too little room beside the destination: the export fails with Not enough disk space before ffmpeg runs; nothing is left", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  const { stop } = await startPlugin((plugin) => activate(plugin, { freeSpace: async () => 1000 }), { directory, host, locale: "en", dataDirectory: data });
  const { folder, cleanup } = await withFolder(host);
  try {
    await twoWithCrossfade(host);
    const calls = fakeFfmpeg(host);
    host.mounted().emit("export-merged");
    await until(() => host.osd.includes(`Export failed: ${REASON.space}`), "the reason");
    assert.equal(calls.length, 0);
    await until(() => leftovers(data, folder).length === 0, "no work files left");
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("Same as source with transitions: the merge stays at the best quality, the final aims at the parts' own bit rate (read when each was added)", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  // ffprobe: the source's video bit rate at Add.
  host.tools.handle("ffprobe", () => ({ stdout: "bit_rate=5000000\n" }));
  const { stop } = await start(host, "en", data);
  const { cleanup } = await withFolder(host);
  try {
    host.mounted().emit("set-preset", 0);
    await twoWithCrossfade(host);
    await until(async () => JSON.parse(await readFile(join(data, "collection.json"), "utf8").catch(() => "{}")).parts?.every((p: { bitrate?: number }) => p.bitrate === 5e6), "the bit rates kept with the parts");
    const calls = fakeFfmpeg(host);
    host.mounted().emit("export-merged");
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export");
    const merge = partsExports(host)[0]!.encoding as { crf?: number; videoBitrate?: string };
    assert.deepEqual([merge.crf, merge.videoBitrate], [14, undefined], "the merge is not encoded at the source bit rate");
    const args = calls[0]!;
    assert.equal(args[args.indexOf("-b:v") + 1], "5000000");
    assert.ok(!args.includes("-crf"));
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("Same as source with transitions and no known bit rate: it asks for another quality, nothing starts", async () => {
  const host = new TestHost();
  const { stop } = await start(host);
  try {
    host.mounted().emit("set-preset", 0);
    await twoWithCrossfade(host);
    host.mounted().emit("export-merged");
    await until(() => host.osd.includes(`Export failed: ${REASON.noSourceBitrate}`), "the reason");
    assert.equal(partsExports(host).length, 0);
  } finally {
    await stop();
  }
});

test("the export measures the merge (ffprobe of its frame times) and cuts there; the half file is on record while ffmpeg runs", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  const { stop } = await start(host, "en", data);
  const { cleanup } = await withFolder(host);
  try {
    await twoWithCrossfade(host);
    // The merge as the player wrote it: 120 frames, then the second part 21 ms later (its first part's sound padding), 119 frames.
    const pts = [...Array.from({ length: 120 }, (_, k) => k / 30), ...Array.from({ length: 119 }, (_, k) => 4.021333 + k / 30)];
    host.tools.handle("ffprobe", (args) => ({ stdout: args.includes("packet=pts_time") ? `${pts.map((s) => s.toFixed(6)).join("\n")}\n` : "" }));
    let recorded: string[] = [];
    const calls = fakeFfmpeg(host, () => {
      recorded = JSON.parse(readFileSync(join(data, "inflight.json"), "utf8")).partials;
    });
    host.mounted().emit("export-merged");
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export");
    const graph = calls[0]!.at(-1)!;
    assert.match(graph, /\[0:v\]trim=start_frame=120:end_frame=239,settb=AVTB,setpts=N\/\(\d+\*TB\)\[v1\]/, "the second part's 119 frames, where they are");
    assert.match(graph, /\[0:a\]atrim=start=4\.021333:end=7\.988,asettb=1\/48000,asetpts=N\/SR\/TB,apad=whole_len=190400,atrim=end_sample=190400,asetpts=N\/SR\/TB\[a1\]/, "its sound from its own start");
    assert.deepEqual(recorded, [calls[0]!.at(-2)], "the half file was on record while it was written");
    await until(async () => JSON.parse(await readFile(join(data, "inflight.json"), "utf8")).partials.length === 0, "and is off it after");
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

for (const fps of [30, 60]) test(`with a real ffmpeg at ${fps} fps: every ordered pair of junction kinds (Cut and each transition, before and after one another) on five parts merged the player's way`, { skip: !haveFfmpeg && "no ffmpeg (set VESTRA_FFMPEG)" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "clipexport-pairs-"));
  const probe = (args: string[]) => String(spawnSync(ffprobe, args).stdout);
  try {
    // Five parts of fractional lengths at 60 fps, cut and re-encoded as the player's merge does (its own timebase per file), joined by the concat demuxer.
    const lengths = [1.789, 1.2345, 1.51, 0.977, 1.333];
    const source = join(dir, "src.mp4");
    spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=32x16:r=25:d=12", "-f", "lavfi", "-i", "sine=f=440:d=12:r=44100", "-c:v", "libx264", "-c:a", "aac", "-shortest", source]);
    const list = ["ffconcat version 1.0"];
    lengths.forEach((length, i) => {
      const part = join(dir, `part-${i}.mp4`);
      const made = spawnSync(FFMPEG, ["-v", "error", "-y", "-ss", String(0.37 + i * 2), "-t", String(length), "-i", source, "-vf", `fps=${fps}`, "-af", "aresample=48000", "-t", String(length), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", part]);
      assert.equal(made.status, 0, String(made.stderr));
      list.push(`file '${part.replace(/\\/g, "/")}'`);
    });
    writeFileSync(join(dir, "list.txt"), `${list.join("\n")}\n`);
    const merged = join(dir, "merged.mp4");
    assert.equal(spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-c", "copy", merged]).status, 0);
    const layout = layoutOf(parsePts(probe(ptsArgs(merged))), lengths)!;
    assert.ok(layout, "measured");
    const kinds: Transition[] = [CUT, tr("crossfade", 0.3), tr("fadeBlack", 0.3), tr("fadeWhite", 0.3), tr("wipe", 0.3, "up"), tr("slide", 0.3, "right")];
    const failures: string[] = [];
    for (const a of kinds) {
      for (const b of kinds) {
        // a → b at junctions 1–2, b → a at 3–4: every ordered pair, at the start and in the middle of the chain.
        const transitions = [a, b, a, b, CUT];
        const out = join(dir, `${a.kind}-${b.kind}.mp4`);
        const built = encodeWith({ input: merged, output: out, progress: join(dir, "p.txt"), script: join(dir, "g.txt"), lengths: layout, transitions, fps, audio: true, encode: { format: "mp4", rate: "crf", crf: 30, speed: "faster", height: 0, fps: 0, audio: 128 }, threads: 2 });
        const run = spawnSync(FFMPEG, built.args);
        if (run.status !== 0) {
          failures.push(`${a.kind} → ${b.kind}: ${String(run.stderr).trim().split(/\r?\n/).at(-1)}`);
          continue;
        }
        const frames = Number(probe(["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", out]).trim());
        const expected = timing(layout, transitions, fps).written;
        if (frames !== expected) failures.push(`${a.kind} → ${b.kind}: ${frames} frames, ${expected} expected`);
      }
    }
    assert.deepEqual(failures, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("with a real ffmpeg: the sound stays with the picture over many transitions (overlaps in whole samples, each part's sound where its picture is)", { skip: !haveFfmpeg && "no ffmpeg (set VESTRA_FFMPEG)" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "clipexport-av-"));
  const probe = (args: string[]) => String(spawnSync(ffprobe, args).stdout).trim();
  try {
    // Ten parts merged the player's way at 30 fps; each source is silent but for a click 0.1 s after the part's start (the first samples of an AAC cut are its priming).
    const lengths = [1.2, 1.3, 1.2, 1.2667, 1.15, 1.31, 1.22, 1.19, 1.27, 1.2];
    const list = ["ffconcat version 1.0"];
    for (const [i, length] of lengths.entries()) {
      const source = join(dir, `src-${i}.mp4`);
      const at = 0.37 + i * 0.05;
      spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=32x16:r=30:d=4", "-f", "lavfi", "-i", `aevalsrc=if(between(t\\,${at + 0.1}\\,${at + 0.102})\\,0.9\\,0):s=48000:d=4`, "-c:v", "libx264", "-c:a", "aac", "-b:a", "256k", "-shortest", source]);
      const part = join(dir, `part-${i}.mp4`);
      const made = spawnSync(FFMPEG, ["-v", "error", "-y", "-ss", String(at), "-t", String(length), "-i", source, "-vf", "fps=30", "-af", "aresample=48000", "-t", String(length), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-ac", "2", part]);
      assert.equal(made.status, 0, String(made.stderr));
      list.push(`file '${part.replace(/\\/g, "/")}'`);
    }
    writeFileSync(join(dir, "list.txt"), `${list.join("\n")}\n`);
    const merged = join(dir, "merged.mp4");
    assert.equal(spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-c", "copy", merged]).status, 0);
    const begin = Number(probe(["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", merged]));
    const measured = layoutOf(parsePts(probe(ptsArgs(merged))), lengths)!;
    const layout = { frames: measured.frames, times: measured.times.map((t) => Math.max(0, t - begin)) };
    // Where each click is in the merge, from its part's first frame: the merge's own picture-to-sound relation, which the output must keep.
    // The clicks by their timestamps (silencedetect's ends of silence), as a player plays them: the merge's sound has the
    // joins' timestamp gaps, so a count of decoded samples would place them wrongly.
    const clicksOf = (file: string) => {
      const pcm = spawnSync(FFMPEG, ["-v", "error", "-i", file, "-map", "0:a", "-ac", "1", "-f", "s16le", "-acodec", "pcm_s16le", "-"], { maxBuffer: 1 << 28 }).stdout as Buffer;
      const log = String(spawnSync(FFMPEG, ["-hide_banner", "-i", file, "-map", "0:a", "-af", "silencedetect=n=-30dB:d=0.02", "-f", "null", "-"]).stderr);
      const found = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]) * 48000);
      return { pcm, found };
    };
    const inMerge = clicksOf(merged).found;
    const offsets = layout.times.map((start) => {
      const click = inMerge.find((s) => s / 48000 >= start && s / 48000 < start + 0.5);
      assert.ok(click !== undefined, `a click in the merge after ${start} s`);
      return click / 48000 - start;
    });
    for (const [name, transitions] of [
      ["nine crossfades", lengths.map((_, i) => (i < 9 ? tr("crossfade", 0.3) : CUT))],
      ["transitions between cuts", [tr("crossfade", 0.3), CUT, tr("slide", 0.3), CUT, tr("fadeBlack", 0.3), CUT, tr("wipe", 0.3), CUT, tr("fadeWhite", 0.3), CUT]],
    ] as const) {
      const out = join(dir, "out.mp4");
      const built = encodeWith({ input: merged, output: out, progress: join(dir, "p.txt"), script: join(dir, "g.txt"), lengths: layout, transitions: [...transitions], fps: 30, audio: true, encode: { format: "mp4", rate: "crf", crf: 30, speed: "faster", height: 0, fps: 0, audio: 256 }, threads: 2 });
      const run = spawnSync(FFMPEG, built.args);
      assert.equal(run.status, 0, `${name}: ${String(run.stderr)}`);
      const t = timing(layout, [...transitions], 30);
      // Picture and sound end together, within one AAC frame (1024 samples).
      const frames = Number(probe(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", out]));
      assert.equal(frames, t.written, name);
      const { pcm, found: clicks } = clicksOf(out);
      const samples = pcm.length / 2;
      assert.ok(Math.abs(samples - (frames / 30) * 48000) <= 1024, `${name}: ${samples} samples of sound, ${(frames / 30) * 48000} of picture`);
      // Each part after a cut (and the first) has its click as far from its first frame as in the merge, within a frame.
      let start = 0;
      const pictureStarts = t.frames.map((f, i) => {
        const here = start;
        start += f - (t.overlaps[i] ?? 0);
        return here;
      });
      pictureStarts.forEach((frame, i) => {
        if (i && t.overlaps[i - 1]! > 0) return; // faded in: its click is under the blend
        const expected = (frame / 30 + offsets[i]!) * 48000;
        const near = clicks.find((s) => Math.abs(s - expected) <= 48000 / 30);
        assert.ok(near !== undefined, `${name}: part ${i + 1}'s sound at ${expected / 48000} s (clicks at ${clicks.map((s) => (s / 48000).toFixed(3)).join(", ")}; picture starts ${pictureStarts.map((p) => (p / 30).toFixed(3)).join(", ")}; offsets ${offsets.map((o) => o.toFixed(3)).join(", ")}; frames ${t.frames.join(",")}; overlaps ${t.overlaps.join(",")})`);
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
