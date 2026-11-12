import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate from "../main.ts";
import { ANIMATED, animatedArgs, animatedChain, encoderFor, encodersOf, extensionOf, MAX_ANIMATED_SECONDS, scaleFilter } from "../animated.ts";
import type { AnimatedPass } from "../animated.ts";
import { animatedOf, encodeOf, estimate, exportEncoding, PRESET_ENCODE, presetOf, PRESETS } from "../clip.ts";
import { REASON, withExtension } from "../model.ts";
import { CUT } from "../transitions.ts";
import type { Transition } from "../transitions.ts";
import { eventually } from "./fakes.ts";

/**
 * Animated GIF and WebP (0.5.0): the Quality chooser's two presets, Precise
 * only. The player writes the clip (or the merge) into the work folder; the
 * plugin's ffmpeg writes the image beside the destination, as for the
 * transitions.
 */
const directory = new URL("..", import.meta.url);
const start = (host = new TestHost(), dataDirectory?: string) => startPlugin(activate, { directory, host, locale: "en", dataDirectory });
const tab = (host: TestHost) => host.mounted().props;
const tick = () => new Promise((done) => setTimeout(done, 5));
async function until(predicate: () => boolean | Promise<boolean>, what = "condition") {
  for (let i = 0; i < 1600; i++) {
    if (await predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}
async function withFolder(host: TestHost) {
  const folder = await mkdtemp(join(tmpdir(), "clipexport-anim-"));
  host.dialogAnswers.push([folder]);
  await host.command("clip.folder").run();
  await until(() => host.osd.at(-1) === host.translate("Clip folder: {}", [folder]), "the clip folder");
  return { folder, cleanup: () => rm(folder, { recursive: true, force: true }) };
}
const tr = (kind: Transition["kind"], duration = 1, dir: Transition["dir"] = "left"): Transition => ({ kind, dir, duration });
/** `ffmpeg -encoders` as the player's build prints it (the legend, then one line per encoder). */
const ENCODERS = [
  "Encoders:",
  " V..... = Video",
  " ------",
  " V....D apng                 APNG (Animated Portable Network Graphics) image",
  " V....D gif                  GIF (Graphics Interchange Format)",
  " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
  " V....D libwebp_anim         libwebp WebP image (codec webp)",
  " V....D libwebp              libwebp WebP image (codec webp)",
  " A....D aac                  AAC (Advanced Audio Coding)",
].join("\n");
const NO_WEBP = ENCODERS.split("\n").filter((line) => !line.includes("libwebp")).join("\n");

/** Pretend to be the player's ffmpeg: `-encoders` lists `encoders`; the image run writes its progress and output (or `behave` decides). */
function fakeFfmpeg(host: TestHost, encoders = ENCODERS, behave: (args: string[]) => void = () => {}) {
  const runs: { args: string[]; graph: string }[] = [];
  host.tools.handle("ffmpeg", (args) => {
    if (args.includes("-encoders")) return { stdout: encoders };
    if (!args.includes("-/filter_complex")) return { stdout: new Uint8Array() };
    runs.push({ args: [...args], graph: readFileSync(args[args.indexOf("-/filter_complex") + 1]!, "utf8") });
    behave(args);
    writeFileSync(args[args.indexOf("-progress") + 1]!, "out_time_us=1000000\nprogress=continue\n");
    writeFileSync(args.at(-1)!, "GIF89a the image");
    return { stdout: new Uint8Array() };
  });
  return runs;
}
const leftovers = (data: string, folder: string) => [
  ...(existsSync(join(data, "work")) ? readdirSync(join(data, "work")) : []),
  ...readdirSync(folder).filter((name) => name.endsWith(".partial")),
];
const statusOf = (host: TestHost) => tab(host)["clip-status"] as { kind: string; reason: string; name: string };
/** Precise with the Quality chooser's `index` (3 Animated GIF, 4 Animated WebP). */
async function choose(host: TestHost, index: number) {
  const panel = host.mounted();
  panel.emit("set-method", 1);
  panel.emit("set-preset", index);
  await host.settle();
  await eventually(() => [tab(host)["method-index"], tab(host)["preset-index"]], [1, index]);
}

// ---------------------------------------------------------------- the presets and the arguments

test("the presets: Animated GIF and WebP after the three MP4 ones, Custom after them; their intermediate MP4 is fixed; 0.4.x settings stay MP4", () => {
  assert.deepEqual(PRESETS, ["source", "high", "small", "gif", "webp"]);
  assert.equal(presetOf(PRESET_ENCODE.gif), "gif");
  assert.equal(presetOf(PRESET_ENCODE.webp), "webp");
  assert.equal(presetOf({ ...PRESET_ENCODE.high, format: "mp4" }), "high");
  // A stored animated preset with other fields gets the preset's own; anything without a format is an MP4.
  assert.deepEqual(encodeOf({ format: "gif", crf: 30, height: 0 }), PRESET_ENCODE.gif);
  assert.deepEqual(encodeOf({ format: "webp" }), PRESET_ENCODE.webp);
  assert.equal(encodeOf({ format: "apng", crf: 20 }).format, "mp4");
  assert.equal(encodeOf({ rate: "crf", crf: 20, speed: "faster", height: 0, fps: 0, audio: 192 }).format, "mp4", "0.4.x settings");
  assert.deepEqual([animatedOf(PRESET_ENCODE.gif), animatedOf(PRESET_ENCODE.webp), animatedOf(PRESET_ENCODE.high), animatedOf(undefined)], ["gif", "webp", null, null]);
  // The intermediate MP4: the best quality, at most 720p and 30 fps.
  assert.deepEqual(exportEncoding(PRESET_ENCODE.gif), { crf: 14, speed: "faster", maxHeight: 720, fps: 30, audioBitrate: 128, threads: "auto" });
  // The extension follows the format, also over a name typed in the save dialog.
  assert.deepEqual([extensionOf("gif"), extensionOf("webp"), extensionOf(null)], [".gif", ".webp", ".mp4"]);
  assert.equal(withExtension("C:\\v\\a.mp4", ".gif"), "C:\\v\\a.gif");
  assert.equal(withExtension("C:\\v\\a.webp", ".gif"), "C:\\v\\a.gif");
  assert.equal(withExtension("C:\\v\\a.gif", ".mp4"), "C:\\v\\a.mp4");
  // The estimate: a range per second of the image, whatever the source's size.
  const guess = (encode = PRESET_ENCODE.gif) => estimate({ method: "precise", length: 10, fileBytes: 500e6, duration: 100, encode, secondsPerSecond: null, height: 2160 });
  assert.deepEqual([guess().sizelow, guess().sizehigh], [1, 5]);
  assert.deepEqual([guess(PRESET_ENCODE.webp).sizelow, guess(PRESET_ENCODE.webp).sizehigh], [0.4, 2]);
});

test("GIF in two runs (bounded memory): the palette of the whole clip into a PNG, then the image with it; 15 fps, at most 480 px (never enlarged), Bayer dithering, changed rectangles; loops; no sound", () => {
  assert.deepEqual(ANIMATED, { gif: { box: 480, fps: 15 }, webp: { box: 640, fps: 20 } });
  assert.equal(MAX_ANIMATED_SECONDS, 60);
  assert.equal(scaleFilter(480), "scale='if(gte(iw,ih),min(480,iw),-2)':'if(gte(iw,ih),-2,min(480,ih))':flags=lanczos,setsar=1");
  const { passes, length } = animatedArgs({ input: "C:/work/merge-1.mp4", output: "C:/v/.a.gif.partial", progress: "p", script: "g", palette: "C:/work/pal.png", format: "gif", length: 4, threads: 2 });
  assert.equal(length, 4);
  assert.equal(passes.length, 2);
  const [first, second] = passes as [AnimatedPass, AnimatedPass];
  const picture = "[0:v]fps=15,scale='if(gte(iw,ih),min(480,iw),-2)':'if(gte(iw,ih),-2,min(480,ih))':flags=lanczos,setsar=1[gifv]";
  assert.equal(first.graph, `${picture};[gifv]palettegen=max_colors=256[out]`);
  assert.equal(second.graph, `${picture};[gifv][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[out]`);
  assert.ok(!first.graph.includes("split") && !second.graph.includes("split"), "no frame is kept for a later palette");
  const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  // The palette: one PNG in the work folder, its own graph and progress files beside it.
  assert.deepEqual([first.script, first.progress, at(first.args, "-/filter_complex"), at(first.args, "-progress"), at(first.args, "-frames:v"), at(first.args, "-f"), first.args.at(-1)], ["C:/work/pal.png.graph", "C:/work/pal.png.progress", "C:/work/pal.png.graph", "C:/work/pal.png.progress", "1", "image2", "C:/work/pal.png"]);
  // The image: the merge and the palette in, the GIF out.
  const inputs = second.args.flatMap((arg, i) => (arg === "-i" ? [second.args[i + 1]] : []));
  assert.deepEqual(inputs, ["C:/work/merge-1.mp4", "C:/work/pal.png"]);
  assert.deepEqual([second.script, at(second.args, "-/filter_complex"), at(second.args, "-map"), at(second.args, "-c:v"), at(second.args, "-loop"), at(second.args, "-f"), at(second.args, "-progress"), second.args.at(-1)], ["g", "g", "[out]", "gif", "0", "gif", "p", "C:/v/.a.gif.partial"]);
  for (const pass of passes) {
    assert.ok(pass.args.includes("-an") && pass.args.includes("-nostdin"));
    assert.ok(!pass.args.includes("-filter_complex"), "the graph is a file");
  }
});

test("WebP's arguments: one run, libwebp's animated encoder at its default quality and effort, 20 fps, at most 640 px, loops; the still encoder when it is the only one", () => {
  const { passes } = animatedArgs({ input: "i", output: "o", progress: "p", script: "g", format: "webp", encoder: "libwebp_anim", length: 4, threads: 1 });
  assert.equal(passes.length, 1);
  const { args, graph } = passes[0]!;
  assert.equal(graph, `[0:v]fps=20,${scaleFilter(640)}[out]`);
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.deepEqual([at("-c:v"), at("-lossless"), at("-q:v"), at("-compression_level"), at("-loop"), at("-f")], ["libwebp_anim", "0", "75", "4", "0", "webp"]);
  const still = animatedArgs({ input: "i", output: "o", progress: "p", script: "g", format: "webp", encoder: "libwebp", length: 4, threads: 1 }).passes[0]!.args;
  assert.equal(still[still.indexOf("-c:v") + 1], "libwebp");
});

test("a merged image with transitions: the parts are blended first (the picture only), then the image chain, in both GIF runs; its length is Σ L − Σ d", () => {
  const { passes, length } = animatedArgs({
    input: "i", output: "o", progress: "p", script: "g", format: "gif", length: 8, threads: 1,
    transitions: { lengths: [4, 4], transitions: [tr("crossfade"), CUT], fps: 30 },
  });
  assert.equal(length, 7);
  for (const { graph } of passes) {
    assert.ok(graph.startsWith("[0:v]trim=start_frame=0:end_frame=120,"));
    assert.ok(graph.includes("xfade=transition=fade:duration=1:offset=2.983333[vout];[vout]fps=15,"));
    assert.ok(!graph.includes("[0:a]") && !graph.includes("acrossfade"), "no sound");
  }
  assert.ok(passes[0]!.graph.endsWith("[gifv]palettegen=max_colors=256[out]"));
  assert.ok(passes[1]!.graph.endsWith("[gifv][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[out]"));
  assert.equal(animatedChain("webp", "vout", "out"), `[vout]fps=20,${scaleFilter(640)}[out]`);
});

test("the encoders: read from ffmpeg -encoders; WebP takes libwebp_anim, else libwebp; none without either", () => {
  const all = encodersOf(ENCODERS);
  assert.deepEqual([...all].sort(), ["aac", "apng", "gif", "libwebp", "libwebp_anim", "libx264"]);
  assert.ok(!all.has("=") && !all.has("------"), "the legend is no encoder");
  assert.equal(encoderFor("gif", all), "gif");
  assert.equal(encoderFor("webp", all), "libwebp_anim");
  assert.equal(encoderFor("webp", new Set(["libwebp"])), "libwebp");
  assert.equal(encoderFor("webp", encodersOf(NO_WEBP)), null);
  assert.equal(encoderFor("gif", new Set(["libx264"])), null);
});

// ---------------------------------------------------------------- the tab and the export

test("Animated GIF of a clip: the player writes the clip without sound into the work folder, the plugin's ffmpeg writes the .gif beside it; nothing is left", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 120 });
  const { stop } = await start(host, data);
  const { folder, cleanup } = await withFolder(host);
  try {
    const runs = fakeFfmpeg(host);
    await choose(host, 3);
    const panel = host.mounted();
    panel.emit("set-processed", true);
    panel.emit("clip-edited", "0:01", "0:05");
    await host.settle();
    await eventually(() => tab(host)["clip-name"], "one_00.01.000-00.05.000.gif", "the name ends in .gif");
    await eventually(() => (tab(host).estimate as { size: string }).size, "0–2", "a GIF's size range");
    panel.emit("export-clip", "0:01", "0:05");
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export");
    const capture = host.sent("snapshot.capture")[0]!;
    assert.deepEqual([capture.mode, capture.audio], ["processed", { kind: "none" }], "the effects go with it; no sound is read");
    const job = host.sent("jobs.start")[0]!;
    assert.ok(String(job.destination).startsWith(join(data, "work")), "the clip goes into the work folder");
    assert.deepEqual(job.encoding, { crf: 14, speed: "faster", maxHeight: 720, fps: 30, audioBitrate: 128, threads: "auto" });
    // Two runs: the palette into the work folder, then the image with it.
    assert.equal(runs.length, 2);
    const [palette, image] = runs as [{ args: string[]; graph: string }, { args: string[]; graph: string }];
    assert.ok(palette.graph.endsWith("palettegen=max_colors=256[out]"));
    assert.ok(palette.args.at(-1)!.startsWith(join(data, "work")), "the palette is a work file");
    // The input is the file the player reports it wrote (the test host reports its own name for a clip); the palette is the second.
    const inputs = image.args.flatMap((arg, i) => (arg === "-i" ? [image.args[i + 1]] : []));
    assert.deepEqual(inputs, [palette.args[palette.args.indexOf("-i") + 1], palette.args.at(-1)]);
    assert.ok(image.graph.includes("paletteuse="));
    const final = join(folder, "one_00.01.000-00.05.000.gif");
    assert.equal(await readFile(final, "utf8"), "GIF89a the image");
    await until(() => leftovers(data, folder).length === 0, "no work files left");
    await eventually(() => (tab(host).results as { name: string; state: string; badge: string }[]).map((r) => [r.name, r.state, r.badge]), [["one_00.01.000-00.05.000.gif", "completed", "4.0"]]);
    await eventually(() => statusOf(host).kind, "exported");
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("Animated WebP: Export As… renames a typed .mp4 to .webp; libwebp_anim is used", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 120 });
  const { stop } = await start(host, data);
  const { folder, cleanup } = await withFolder(host);
  try {
    const runs = fakeFfmpeg(host);
    await choose(host, 4);
    host.dialogAnswers.push([join(folder, "mine.mp4")]);
    host.mounted().emit("export-as", "0:01", "0:03");
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export");
    const { args } = runs[0]!;
    assert.equal(args[args.indexOf("-c:v") + 1], "libwebp_anim");
    assert.ok((await stat(join(folder, "mine.webp"))).isFile());
    await until(() => leftovers(data, folder).length === 0, "no work files left");
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("longer than a minute: refused before anything starts (no save dialog, no snapshot), with the reason on the Clip page", async () => {
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 600 });
  const { stop } = await start(host);
  const { cleanup } = await withFolder(host);
  try {
    fakeFfmpeg(host);
    await choose(host, 3);
    const dialogs = host.sent("dialogs.open").length;
    host.mounted().emit("export-as", "0:00", "1:00.5");
    await eventually(() => [statusOf(host).kind, statusOf(host).reason], ["error", "animatedTooLong"]);
    assert.equal(host.sent("dialogs.open").length, dialogs);
    assert.equal(host.sent("snapshot.capture").length, 0);
    // Exactly a minute is fine.
    host.mounted().emit("export-clip", "0:00", "1:00");
    await until(() => host.sent("jobs.start").length === 1, "the export");
    assert.equal(REASON.animatedTooLong, "Animated GIF and WebP are at most 60 seconds long. Choose a shorter range.");
  } finally {
    await stop();
    await cleanup();
  }
});

test("an ffmpeg without libwebp: WebP is refused with its reason, GIF still works; without ffmpeg both say FFmpeg is missing; Fast is not affected", async () => {
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 120 });
  const { stop } = await start(host);
  const { cleanup } = await withFolder(host);
  try {
    // No ffmpeg at all.
    await choose(host, 3);
    host.mounted().emit("export-clip", "0:01", "0:03");
    await eventually(() => [statusOf(host).kind, statusOf(host).reason], ["error", "noAnimatedFfmpeg"]);
    assert.equal(host.sent("snapshot.capture").length, 0);
    // An ffmpeg without libwebp.
    fakeFfmpeg(host, NO_WEBP);
    await choose(host, 4);
    host.mounted().emit("export-clip", "0:01", "0:03");
    await eventually(() => [statusOf(host).kind, statusOf(host).reason], ["error", "noAnimatedEncoder"]);
    assert.equal(host.sent("snapshot.capture").length, 0);
    await choose(host, 3);
    host.mounted().emit("export-clip", "0:01", "0:03");
    await until(() => host.sent("jobs.start").length === 1, "the GIF export");
    // Fast ignores the chooser: a stream copy into an MP4 or MKV.
    host.mounted().emit("set-method", 0);
    await host.settle();
    await eventually(() => tab(host)["method-index"], 0);
    host.mounted().emit("export-clip", "0:05", "0:07");
    await until(() => host.sent("jobs.start").length === 2, "the Fast export");
    const fast = host.sent("jobs.start")[1]!;
    assert.equal(fast.kind, "rawCopy");
    assert.match(String(fast.destination), /\.mp4$/);
  } finally {
    await stop();
    await cleanup();
  }
});

test("the image fails: the reason is said, retry runs it again, nothing is left", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 120 });
  const { stop } = await start(host, data);
  const { folder, cleanup } = await withFolder(host);
  try {
    let fail = true;
    fakeFfmpeg(host, ENCODERS, (args) => {
      if (!fail) return;
      writeFileSync(args.at(-1)!, "half");
      throw new HostError("failed", "Conversion failed!");
    });
    await choose(host, 3);
    host.mounted().emit("export-clip", "0:01", "0:03");
    await until(() => host.osd.includes(`Export failed: ${REASON.animatedFailed}`), "the failure");
    await until(() => leftovers(data, folder).length === 0, "no work files left");
    fail = false;
    // The failed row arrives with the plugin's next update, after the message.
    const failedRow = () => (tab(host).results as { id: string; state: string }[]).find((r) => r.state === "failed");
    await until(() => !!failedRow(), "the failed row");
    const failed = failedRow()!;
    host.mounted().emit("retry-task", failed.id);
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the retried export");
    assert.equal(host.sent("jobs.start").length, 2);
    assert.equal((await readdir(folder)).filter((name) => name.endsWith(".gif")).length, 1, "one image");
    await until(() => leftovers(data, folder).length === 0, "no work files left");
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("the merged Collection as a GIF: with a crossfade the parts blend first, then the image; without transitions one plain run; the written length is checked", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  const { stop } = await start(host, data);
  const { folder, cleanup } = await withFolder(host);
  const rows = () => (tab(host).parts ?? []) as { id: string; kind: string }[];
  const add = async (path: string, from: string, to: string) => {
    host.openElsewhere(path);
    host.setSource({ position: 2, duration: 120 });
    const count = rows().length;
    host.mounted().emit("add-part", from, to);
    await until(() => rows().length === count + 1, `part ${count + 1}`);
  };
  try {
    const runs = fakeFfmpeg(host);
    await choose(host, 3);
    await add("/media/one.mp4", "0", "4");
    await add("/media/two.mp4", "0", "4");
    await eventually(() => tab(host)["collection-preview"], `${tab(host)["collection-preview"]}`.replace(/\.\w+$/, ".gif"));
    // Without transitions: the plain merge, one image run on the whole file.
    host.mounted().emit("export-merged");
    await until(() => host.osd.filter((line) => line.startsWith("Clip exported as")).length === 1, "the first export");
    const merge = host.exports.filter((e) => Array.isArray(e.parts))[0]!;
    assert.ok(String(merge.destination).startsWith(join(data, "work")));
    assert.equal(runs.length, 2, "the palette, then the image");
    assert.ok(runs.every((run) => run.graph.startsWith("[0:v]fps=15,")));
    // A crossfade: blended first, no sound.
    const id = rows()[0]!.id;
    host.mounted().emit("open-join", id);
    host.mounted().emit("set-transition", id, "crossfade", "left", "1");
    await eventually(() => rows()[0]!.kind, "crossfade");
    host.mounted().emit("export-merged");
    await until(() => host.osd.filter((line) => line.startsWith("Clip exported as")).length === 2, "the second export");
    assert.equal(runs.length, 4);
    for (const run of runs.slice(2)) {
      assert.match(run.graph, /xfade=transition=fade.*\[vout\];\[vout\]fps=15,/);
      assert.ok(!run.graph.includes("acrossfade"));
    }
    assert.equal((await readdir(folder)).filter((name) => name.endsWith(".gif")).length, 2);
    await eventually(() => (tab(host).results as { badge: string }[]).map((r) => r.badge), ["7.0", "8.0"], "4 + 4 − 1 s, then 4 + 4 s");
    await until(() => leftovers(data, folder).length === 0, "no work files left");
    // Over a minute written: refused before anything starts.
    await add("/media/three.mp4", "0", "58");
    const before = host.exports.length;
    host.mounted().emit("export-merged");
    await until(() => host.osd.includes(`Export failed: ${REASON.animatedTooLong}`), "the refusal");
    assert.equal(host.exports.length, before);
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("Fast with a saved Animated GIF and parts Fast cannot join: the fallback is a High quality MP4 (no image, no minute limit); Precise writes the GIF again", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  const { stop } = await start(host, data);
  const { folder, cleanup } = await withFolder(host);
  const rows = () => (tab(host).parts ?? []) as { id: string }[];
  const add = async (path: string, from: string, to: string) => {
    host.openElsewhere(path);
    host.setSource({ position: 2, duration: 120 });
    const count = rows().length;
    host.mounted().emit("add-part", from, to);
    await until(() => rows().length === count + 1, `part ${count + 1}`);
  };
  try {
    const runs = fakeFfmpeg(host);
    await choose(host, 3);
    host.mounted().emit("set-method", 0);
    await host.settle();
    await eventually(() => tab(host)["method-index"], 0, "Fast chosen, Animated GIF kept");
    // Two files of different sizes, together over a minute.
    host.mediaFiles.set("/media/wide.mp4", { duration: 120, video: { codec: "h264", width: 1920, height: 818, fps: 30, pixelFormat: "yuv420p" } });
    await add("/media/one.mp4", "0", "40");
    await add("/media/wide.mp4", "0", "40");
    await eventually(() => tab(host)["collection-preview"], `${tab(host)["collection-preview"]}`.replace(/\.\w+$/, ".mp4"), "the name says MP4");
    host.mounted().emit("export-merged");
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export");
    const merge = host.exports.filter((e) => Array.isArray(e.parts))[0]!;
    assert.equal(merge.kind, "rawMp4", "Precise: Fast cannot join these parts");
    assert.ok(String(merge.destination).startsWith(folder) && String(merge.destination).endsWith(".mp4"), "an MP4 straight into the folder");
    assert.deepEqual(merge.encoding, { crf: 18, speed: "faster", audioBitrate: 192, threads: "auto" }, "High quality, not the image's intermediate");
    assert.equal(runs.length, 0, "no image run");
    assert.ok(!host.osd.some((line) => line.includes(REASON.animatedTooLong)));
    // The check of the parts asked with the same encoding.
    assert.deepEqual(host.sent("jobs.check").at(-1)!.encoding, merge.encoding);
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("the tab: Animated GIF and WebP in the Quality chooser, Custom after them; the H.264 rows hide and the audio choice greys for them; the ⓘ says what they write", async () => {
  const slint = await readFile(new URL("../ui/tab.slint", import.meta.url), "utf8");
  assert.match(slint, /model: ClipBridge\.preset-index == 5\s*\? \[@tr\("Same as source"\), @tr\("High quality"\), @tr\("Small file"\), @tr\("Animated GIF"\), @tr\("Animated WebP"\), @tr\("Custom"\)\]/);
  assert.match(slint, /private property <bool> animated: !root\.fast && ClipBridge\.support\.encode && \(ClipBridge\.preset-index == 3 \|\| ClipBridge\.preset-index == 4\);/);
  assert.match(slint, /if !root\.fast && ClipBridge\.support\.encode && !root\.animated: VerticalLayout/);
  assert.match(slint, /enabled: !root\.animated;\s*current-index <=> ClipBridge\.audio-index;/);
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 120 });
  const { stop } = await start(host);
  try {
    await choose(host, 4);
    // A stale H.264 field event changes nothing while an animated preset is chosen.
    host.mounted().emit("set-encode", "crf", 25);
    await host.settle();
    await eventually(() => tab(host)["preset-index"], 4);
    // A custom MP4 shows Custom at index 5.
    host.mounted().emit("set-preset", 1);
    host.mounted().emit("set-encode", "crf", 25);
    await eventually(() => tab(host)["preset-index"], 5, "Custom");
  } finally {
    await stop();
  }
});

test("the tab: a muted line under Quality says what GIF or WebP writes, from the encoder's constants, in every language", async () => {
  const slint = await readFile(new URL("../ui/tab.slint", import.meta.url), "utf8");
  // Shown only while an animated quality is chosen, right after the Quality row, aligned with its chooser, small and dim.
  const line = /\n(\s*)\/\/ An animated quality's fixed picture[^\n]*\n\s*if root\.animated: HorizontalLayout \{\s*padding-left: 68px;\s*Text \{([\s\S]*?)\n\1\}/.exec(slint);
  assert.ok(line, "the line's row");
  const body = line[2]!;
  assert.match(body, /color: Theme\.text-dim;/);
  assert.match(body, /font-size: Theme\.font-xs;/);
  assert.ok(slint.indexOf("An animated quality's fixed picture") > slint.indexOf('Label { width: 64px; text: @tr("Quality"); }'), "below the Quality row");
  assert.ok(slint.indexOf("An animated quality's fixed picture") < slint.indexOf("if !root.fast && ClipBridge.support.encode && !root.animated: VerticalLayout"), "where the H.264 rows would be");
  // One template, its numbers from the bridge (no literal number in the line).
  const template = "{0} · {1} px long edge · {2} fps · up to {3} s";
  for (const format of ["gif", "webp"]) {
    const name = format === "gif" ? "GIF" : "WebP";
    assert.ok(body.includes(`@tr("${template}", "${name}", ClipBridge.${format}-spec.box, ClipBridge.${format}-spec.fps, ClipBridge.${format}-spec.seconds)`), format);
  }
  assert.doesNotMatch(body, /\b(480|640|15|20|60)\b/, "no number written in the Slint");
  // The bridge carries animated.ts's numbers.
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 120 });
  const { stop } = await start(host);
  try {
    await eventually(() => tab(host)["gif-spec"], { box: ANIMATED.gif.box, fps: ANIMATED.gif.fps, seconds: MAX_ANIMATED_SECONDS });
    await eventually(() => tab(host)["webp-spec"], { box: ANIMATED.webp.box, fps: ANIMATED.webp.fps, seconds: MAX_ANIMATED_SECONDS });
  } finally {
    await stop();
  }
  // Translated in every language the plugin ships, with the same four placeholders.
  const locales = (await readdir(new URL("../locales/", import.meta.url))).filter((file) => file.endsWith(".po"));
  assert.ok(locales.length >= 6, "the shipped languages");
  for (const file of locales) {
    const po = await readFile(new URL(`../locales/${file}`, import.meta.url), "utf8");
    const translated = new RegExp(String.raw`msgid "${template.replace(/[{}]/g, "\\$&")}"\r?\nmsgstr "([^"]+)"`).exec(po);
    assert.ok(translated, `${file}: translated`);
    assert.deepEqual(translated[1]!.match(/\{\d\}/g)!.sort(), ["{0}", "{1}", "{2}", "{3}"], `${file}: placeholders`);
  }
});

// ---------------------------------------------------------------- with a real ffmpeg (skipped without one)

const FFMPEG = process.env.VESTRA_FFMPEG || "ffmpeg";
const FFPROBE = process.env.VESTRA_FFPROBE || FFMPEG.replace(/ffmpeg(\.exe)?$/i, (_, exe) => `ffprobe${exe ?? ""}`);
const haveFfmpeg = spawnSync(FFMPEG, ["-version"], { stdio: "ignore" }).status === 0 && spawnSync(FFPROBE, ["-version"], { stdio: "ignore" }).status === 0;
const run = (bin: string, args: string[]) => {
  const result = spawnSync(bin, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${bin} ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
};
/** Width, height, codec and frame count of the first video stream. */
function probe(file: string) {
  const out = run(FFPROBE, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "default=noprint_wrappers=1", file]);
  const value = (key: string) => out.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  return { codec: value("codec_name"), width: Number(value("width")), height: Number(value("height")), frames: Number(value("nb_read_frames")) };
}
/** Encode with the plugin's arguments, the graph written to its file. */
function encode(o: Parameters<typeof animatedArgs>[0]) {
  const built = animatedArgs(o);
  for (const pass of built.passes) {
    writeFileSync(pass.script, pass.graph);
    run(FFMPEG, pass.args);
  }
  return built;
}

test("with a real ffmpeg: GIF and WebP of a 1280×720 clip are 480×270 at 15 fps and 640×360 at 20 fps, loop forever, no sound; a small portrait clip is not enlarged; the encoders are found", { skip: !haveFfmpeg && "no ffmpeg (set VESTRA_FFMPEG)" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "clipexport-anim-real-"));
  try {
    const encoders = encodersOf(run(FFMPEG, ["-hide_banner", "-v", "error", "-encoders"]));
    assert.equal(encoderFor("gif", encoders), "gif");
    const webp = encoderFor("webp", encoders);
    const wide = join(dir, "wide.mp4");
    run(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=2", "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", wide]);
    const gif = join(dir, "wide.gif");
    encode({ input: wide, output: gif, progress: join(dir, "p1"), script: join(dir, "g1"), format: "gif", length: 2, threads: 2 });
    const g = probe(gif);
    assert.deepEqual([g.codec, g.width, g.height, g.frames], ["gif", 480, 270, 30]);
    // NETSCAPE2.0 with a loop count of 0: forever.
    const bytes = readFileSync(gif);
    const netscape = bytes.indexOf("NETSCAPE2.0");
    assert.ok(netscape > 0, "a loop block");
    assert.equal(bytes.readUInt16LE(netscape + 13), 0, "loops forever");
    assert.ok(readFileSync(join(dir, "p1"), "utf8").includes("progress=end"));
    if (webp) {
      const out = join(dir, "wide.webp");
      encode({ input: wide, output: out, progress: join(dir, "p2"), script: join(dir, "g2"), format: "webp", encoder: webp, length: 2, threads: 2 });
      const w = readFileSync(out);
      assert.equal(w.subarray(0, 4).toString(), "RIFF");
      assert.equal(w.subarray(8, 12).toString(), "WEBP");
      const anim = w.indexOf("ANIM");
      assert.ok(anim > 0, "an animated WebP");
      assert.equal(w.readUInt16LE(anim + 8 + 4), 0, "loops forever");
      const frames = w.toString("latin1").split("ANMF").length - 1;
      assert.equal(frames, 40, "20 fps for 2 s");
      // VP8X canvas size: 24-bit width − 1 and height − 1.
      const vp8x = w.indexOf("VP8X");
      assert.deepEqual([w.readUIntLE(vp8x + 12, 3) + 1, w.readUIntLE(vp8x + 15, 3) + 1], [640, 360]);
    }
    const tall = join(dir, "tall.mp4");
    run(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=200x360:rate=24:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", tall]);
    const small = join(dir, "tall.gif");
    encode({ input: tall, output: small, progress: join(dir, "p3"), script: join(dir, "g3"), format: "gif", length: 1, threads: 1 });
    assert.deepEqual([probe(small).width, probe(small).height], [200, 360], "not enlarged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("with a real ffmpeg: a merged GIF with a crossfade is Σ L − Σ d long at 15 fps", { skip: !haveFfmpeg && "no ffmpeg (set VESTRA_FFMPEG)" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "clipexport-anim-real-"));
  try {
    const merged = join(dir, "merged.mp4");
    run(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", merged]);
    const out = join(dir, "merged.gif");
    const { length } = encode({ input: merged, output: out, progress: join(dir, "p"), script: join(dir, "g"), format: "gif", length: 4, threads: 2, transitions: { lengths: [2, 2], transitions: [tr("crossfade", 0.5), CUT], fps: 30 } });
    assert.equal(length, 3.5);
    const g = probe(out);
    assert.deepEqual([g.codec, g.width, g.frames], ["gif", 480, Math.round(3.5 * 15)]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
