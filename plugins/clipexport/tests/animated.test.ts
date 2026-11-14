import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate from "../main.ts";
import { ANIMATED, animatedArgs, animatedChain, encoderFor, encodersOf, extensionOf, frameTimes, graphValue, lastFrameTime, MAX_ANIMATED_SECONDS, scaleFilter } from "../animated.ts";
import type { AnimatedPass } from "../animated.ts";
import { animatedOf, animatedOutput, encodeOf, estimate, exportEncoding, methodOf, OUTPUTS, PRESET_ENCODE, presetOf, PRESETS } from "../clip.ts";
import { outputOf, settingsOf } from "../settings.ts";
import { REASON, withExtension } from "../model.ts";
import { CUT } from "../transitions.ts";
import type { Transition } from "../transitions.ts";
import { checkDestinations, eventually } from "./fakes.ts";

/**
 * Animated GIF and WebP (0.5.0; two Output segments beside Fast and Precise
 * since 0.7.0, written the Precise way). The player writes the clip (or the
 * merge) into the work folder; the
 * plugin's ffmpeg writes the image beside the destination, as for the
 * transitions.
 */
const directory = new URL("..", import.meta.url);
const start = (host = new TestHost(), dataDirectory?: string) => (checkDestinations(host), startPlugin(activate, { directory, host, locale: "en", dataDirectory }));
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
/** The Output segment `index` (2 GIF, 3 WebP); the Quality chooser keeps Precise's MP4 setting (High quality). */
async function choose(host: TestHost, index: number) {
  host.mounted().emit("set-method", index);
  await host.settle();
  await eventually(() => [tab(host)["method-index"], tab(host)["preset-index"]], [index, 1]);
}

// ---------------------------------------------------------------- the presets and the arguments

test("the Outputs: Fast, Precise, GIF, WebP; the Quality chooser holds the three MP4 presets only; the image's intermediate MP4 is fixed; stored settings are an MP4", () => {
  assert.deepEqual(OUTPUTS, ["fast", "precise", "gif", "webp"]);
  assert.deepEqual(OUTPUTS.map(methodOf), ["fast", "precise", "precise", "precise"], "GIF and WebP are written the Precise way");
  assert.deepEqual(OUTPUTS.map(animatedOutput), [null, null, "gif", "webp"]);
  assert.deepEqual(PRESETS, ["source", "high", "small"]);
  assert.equal(presetOf(PRESET_ENCODE.gif), "custom", "not a Quality any more");
  assert.equal(presetOf({ ...PRESET_ENCODE.high, format: "mp4" }), "high");
  // A stored Animated GIF or WebP quality (0.5.0–0.6.x) is the GIF or WebP Output now; the MP4 quality is High quality's.
  assert.deepEqual(encodeOf({ format: "gif", crf: 30, height: 0 }), PRESET_ENCODE.high);
  assert.deepEqual(encodeOf({ format: "webp" }), PRESET_ENCODE.high);
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
  // The palette run prints each frame's time into its own file (its progress: ffmpeg's -progress waits for the palette).
  assert.equal(first.times, "C:/work/pal.png.times");
  assert.equal(first.graph, `${picture};[gifv]${frameTimes("C:/work/pal.png.times")},palettegen=max_colors=256[out]`);
  assert.equal(second.times, undefined);
  assert.equal(second.graph, `${picture};[gifv][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[out]`);
  assert.ok(!first.graph.includes("split") && !second.graph.includes("split"), "no frame is kept for a later palette");
  // A path in the graph: escaped for the option, then for the graph.
  assert.equal(graphValue(String.raw`C:\w\it's [a],b;c.times`), String.raw`C\\:\\\\w\\\\it\\\'s \[a\]\,b\;c.times`);
  assert.equal(lastFrameTime(""), null);
  assert.equal(lastFrameTime("frame:0    pts:0       pts_time:0\nclipexport=1\nframe:44   pts:44      pts_time:2.933333\nclipexport=1\n"), 2.933333);
  assert.equal(lastFrameTime("frame:44   pts:44      pts_time:2.9"), 2.9, "a line still being written");
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
  assert.ok(passes[0]!.graph.endsWith(",palettegen=max_colors=256[out]") && passes[0]!.graph.includes(";[gifv]metadata="));
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
    await choose(host, 2);
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

test("Animated GIF: the palette run shows its progress (the frame times it prints), then the image run continues from half", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 120 });
  const { stop } = await start(host, data);
  const { folder, cleanup } = await withFolder(host);
  let release!: () => void;
  try {
    let palette: string[] | null = null;
    host.tools.handle("ffmpeg", (args) => {
      if (args.includes("-encoders")) return { stdout: ENCODERS };
      if (!args.includes("-/filter_complex")) return { stdout: new Uint8Array() };
      writeFileSync(args.at(-1)!, "GIF89a the image");
      if (palette) {
        writeFileSync(args[args.indexOf("-progress") + 1]!, "out_time_us=1000000\nprogress=continue\n");
        return { stdout: new Uint8Array() };
      }
      palette = [...args];
      // ffmpeg's own progress says nothing until the palette is written at the end; the frame times say 2 s of 4.
      writeFileSync(args[args.indexOf("-progress") + 1]!, "");
      const graph = readFileSync(args[args.indexOf("-/filter_complex") + 1]!, "utf8");
      const times = `${args.at(-1)!}.times`;
      assert.ok(graph.includes(graphValue(times)), "the frame times go beside the palette");
      writeFileSync(times, "frame:29   pts:29      pts_time:1.933333\nclipexport=1\nframe:30   pts:30      pts_time:2\nclipexport=1\n");
      return new Promise((done) => (release = () => done({ stdout: new Uint8Array() }))) as never;
    });
    await choose(host, 2);
    host.mounted().emit("export-clip", "0:01", "0:05");
    await until(() => palette !== null, "the palette run");
    // The player's 4 s, then the palette run's 2 s of 4 (half of the step's first run): (4 + 1) / 8.
    await until(() => (tab(host).card as { percent: number }).percent === 63, "the palette run's progress");
    release();
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export");
    await until(() => leftovers(data, folder).length === 0, "no work files left (the frame times too)");
  } finally {
    release?.();
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
    await choose(host, 3);
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
    await choose(host, 2);
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
    await choose(host, 2);
    host.mounted().emit("export-clip", "0:01", "0:03");
    await eventually(() => [statusOf(host).kind, statusOf(host).reason], ["error", "noAnimatedFfmpeg"]);
    assert.equal(host.sent("snapshot.capture").length, 0);
    // An ffmpeg without libwebp.
    fakeFfmpeg(host, NO_WEBP);
    await choose(host, 3);
    host.mounted().emit("export-clip", "0:01", "0:03");
    await eventually(() => [statusOf(host).kind, statusOf(host).reason], ["error", "noAnimatedEncoder"]);
    assert.equal(host.sent("snapshot.capture").length, 0);
    await choose(host, 2);
    host.mounted().emit("export-clip", "0:01", "0:03");
    await until(() => host.sent("jobs.start").length === 1, "the GIF export");
    // Fast after GIF: a stream copy into an MP4 or MKV.
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
    await choose(host, 2);
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
    await choose(host, 2);
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
    // Merges only: the new part's thumbnail is a frame export of its own, which may land at any time after the row shows.
    const merges = () => host.exports.filter((e) => Array.isArray(e.parts)).length;
    const before = merges();
    host.mounted().emit("export-merged");
    await until(() => host.osd.includes(`Export failed: ${REASON.animatedTooLong}`), "the refusal");
    assert.equal(merges(), before, "no merge started");
    assert.equal(runs.length, 4, "no image run either");
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("a fresh install (an empty data directory): the work folder is made before the player writes into it; GIF and WebP of a clip, the merged Collection as a GIF and as an MP4 with a crossfade", async () => {
  /** One export on a data directory that has nothing in it yet (`start` adds the player's check of the destination folder). */
  async function fresh(what: string, run: (host: TestHost, folder: string) => Promise<void>) {
    const data = await mkdtemp(join(tmpdir(), "clipexport-fresh-"));
    const host = new TestHost();
    host.openElsewhere("/media/one.mp4");
    host.setSource({ position: 2, duration: 120 });
    const { stop } = await start(host, data);
    const { folder, cleanup } = await withFolder(host);
    try {
      assert.ok(!existsSync(join(data, "work")), `${what}: no work folder yet`);
      await run(host, folder);
      await until(() => host.osd.some((line) => line.startsWith("Clip exported as") || line.startsWith("Export failed")), `${what}: the export`);
      assert.deepEqual(host.osd.filter((line) => line.startsWith("Export failed")), [], what);
      const job = host.sent("jobs.start").find((sent) => String(sent.destination).startsWith(join(data, "work")));
      assert.ok(job, `${what}: the player wrote into the work folder`);
      await until(() => leftovers(data, folder).length === 0, `${what}: no work files left`);
    } finally {
      await stop();
      await cleanup();
      await rm(data, { recursive: true, force: true });
    }
  }
  const parts = (host: TestHost) => (tab(host).parts ?? []) as { id: string; kind: string }[];
  const add = async (host: TestHost, path: string) => {
    host.openElsewhere(path);
    host.setSource({ position: 2, duration: 120 });
    const count = parts(host).length;
    host.mounted().emit("add-part", "0", "4");
    await until(() => parts(host).length === count + 1, `part ${count + 1}`);
  };
  for (const [what, index] of [["GIF", 2], ["WebP", 3]] as const) {
    await fresh(`${what} of a clip`, async (host) => {
      fakeFfmpeg(host);
      await choose(host, index);
      host.mounted().emit("export-clip", "0:01", "0:03");
    });
  }
  await fresh("the merged Collection as a GIF", async (host) => {
    fakeFfmpeg(host);
    await choose(host, 2);
    await add(host, "/media/one.mp4");
    await add(host, "/media/two.mp4");
    host.mounted().emit("export-merged");
  });
  await fresh("the merged Collection as an MP4 with a crossfade", async (host) => {
    fakeFfmpeg(host);
    await add(host, "/media/one.mp4");
    await add(host, "/media/two.mp4");
    const id = parts(host)[0]!.id;
    host.mounted().emit("open-join", id);
    host.mounted().emit("set-transition", id, "crossfade", "left", "1");
    await eventually(() => parts(host)[0]!.kind, "crossfade");
    await eventually(() => tab(host)["collection-method-index"], 1, "Precise");
    host.mounted().emit("export-merged");
  });
});

test("the player's check of the destination folder (the fake above): a job whose folder is missing fails as on a fresh install of 0.6.0", async () => {
  const host = new TestHost();
  checkDestinations(host);
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 120 });
  // What the manifest's events and playback.read did before SDK 1.9.0.
  const { plugin, stop } = await startPlugin(
    async (plugin) => {
      plugin.player.subscribe();
      await plugin.player.read();
    },
    { directory, host, locale: "en" },
  );
  try {
    const missing = join(tmpdir(), `clipexport-missing-${process.pid}-${Date.now()}`, "work", "merge.mp4");
    const snapshot = await plugin.media.capture();
    const job = await snapshot.export({ format: "mp4", destination: missing, end: 3 });
    const end = await job.done;
    assert.equal(end.status, "failed");
    assert.match(String((end.outcome as { error: { message: string } }).error.message), /destination directory is unavailable/);
  } finally {
    await stop();
  }
});

test("Fast after GIF and parts Fast cannot join: the fallback is an MP4 at the Quality chooser's setting (no image, no minute limit)", async () => {
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
    // Precise's Quality: Small file, kept while GIF is the Output.
    host.mounted().emit("set-method", 1);
    host.mounted().emit("set-preset", 2);
    await host.settle();
    await eventually(() => tab(host)["preset-index"], 2);
    host.mounted().emit("set-method", 2);
    await host.settle();
    await eventually(() => [tab(host)["method-index"], tab(host)["preset-index"]], [2, 2], "GIF chosen, Small file kept for Precise");
    host.mounted().emit("set-method", 0);
    await host.settle();
    await eventually(() => tab(host)["method-index"], 0, "Fast chosen: one Output at a time");
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
    assert.deepEqual(merge.encoding, { crf: 26, speed: "balanced", maxHeight: 1080, audioBitrate: 128, threads: "auto" }, "Small file, not the image's intermediate");
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

test("the tab: Output is Fast | Precise | GIF | WebP in one switch; the Quality chooser holds the MP4 presets and Custom; for GIF and WebP Advanced hides Audio, Quality and the H.264 rows and keeps the effects and subtitles", async () => {
  const slint = await readFile(new URL("../ui/tab.slint", import.meta.url), "utf8");
  const parts = await readFile(new URL("../ui/parts.slint", import.meta.url), "utf8");
  // The four segments, in this order, each picking its index; GIF and WebP are the formats' own names.
  const halves = [...slint.matchAll(/MethodHalf \{ (?:glyph: Glyphs\.\w+; )?title: (@tr\("\w+"\)|"\w+"); selected: root\.index == (\d);[^\n]*picked\((\d)\)/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(halves, [['@tr("Fast")', "0", "0"], ['@tr("Precise")', "1", "1"], ['"GIF"', "2", "2"], ['"WebP"', "3", "3"]]);
  // One switch for the clip and the merged Collection: always shown (Fast greys without the player's stream copy, GIF and WebP without its encoder settings).
  assert.match(slint, /MethodSwitch \{\s*horizontal-stretch: 1;\s*index: ClipBridge\.method-index;\s*fast-enabled: ClipBridge\.support\.fast;\s*image-enabled: ClipBridge\.support\.encode;/);
  // The Quality chooser: MP4 only.
  assert.match(slint, /model: ClipBridge\.preset-index == 3\s*\? \[@tr\("Same as source"\), @tr\("High quality"\), @tr\("Small file"\), @tr\("Custom"\)\]\s*: \[@tr\("Same as source"\), @tr\("High quality"\), @tr\("Small file"\)\];/);
  for (const text of [slint, parts]) assert.doesNotMatch(text, /@tr\("Animated (GIF|WebP)"\)/, "no Animated GIF or WebP quality left");
  assert.match(slint, /private property <bool> animated: ClipBridge\.support\.encode && \(ClipBridge\.method-index == 2 \|\| ClipBridge\.method-index == 3\);/);
  // Advanced for GIF and WebP: no Audio row, no Quality row, no H.264 rows; the effects and subtitles stay (enabled as in Precise).
  assert.match(slint, /if !root\.animated: HorizontalLayout \{\s*spacing: 4px;\s*Label \{ width: 64px; text: @tr\("Audio"\); \}/);
  assert.match(slint, /if !root\.animated: HorizontalLayout \{\s*spacing: 4px;\s*Label \{ width: 64px; text: @tr\("Quality"\); \}/);
  assert.match(slint, /if !root\.fast && ClipBridge\.support\.encode && !root\.animated: VerticalLayout/);
  assert.match(slint, /text: @tr\("Include video effects"\);\s*checked <=> ClipBridge\.processed;\s*enabled: !root\.fast;/);
  // The closed Advanced sums up nothing for them (no sound, a fixed picture: the line under the Output says what it is).
  assert.match(slint, /summary: root\.animated \? ""/);
  // The footer of the Collection names GIF or WebP, Words.method knows them.
  assert.match(slint, /text: Words\.method\(ClipBridge\.method-index == 2 && ClipBridge\.support\.encode \? "gif" : ClipBridge\.method-index == 3 && ClipBridge\.support\.encode \? "webp" : ClipBridge\.collection-method-index == 0 \? "fast" : "precise"\)/);
  assert.match(parts, /if \(m == "gif"\) \{ return "GIF"; \}\s*if \(m == "webp"\) \{ return "WebP"; \}/);
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 120 });
  const { stop } = await start(host);
  try {
    await choose(host, 3);
    // A stale H.264 field event changes nothing while GIF or WebP is chosen.
    host.mounted().emit("set-encode", "crf", 25);
    await host.settle();
    await eventually(() => [tab(host)["method-index"], tab(host)["preset-index"], tab(host)["enc-crf"]], [3, 1, 18]);
    // A custom MP4 shows Custom at index 3.
    host.mounted().emit("set-method", 1);
    host.mounted().emit("set-encode", "crf", 25);
    await eventually(() => tab(host)["preset-index"], 3, "Custom");
  } finally {
    await stop();
  }
});

test("the Output segments: GIF and WebP name the file .gif and .webp (clip and Collection), Precise and Fast go back to MP4 with the Quality kept; the progress card names GIF", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  host.openElsewhere("/media/one.mp4");
  host.setSource({ position: 2, duration: 120 });
  const { stop } = await start(host, data);
  const { cleanup } = await withFolder(host);
  try {
    const panel = host.mounted();
    panel.emit("set-method", 1);
    panel.emit("set-preset", 0);
    panel.emit("clip-edited", "0:01", "0:05");
    await host.settle();
    const ending = (key: string) => String(tab(host)[key]).replace(/^.*(\.\w+)$/, "$1");
    for (const [index, extension] of [[2, ".gif"], [3, ".webp"], [1, ".mp4"], [0, ".mp4"], [2, ".gif"]] as const) {
      panel.emit("set-method", index);
      await host.settle();
      await eventually(() => [tab(host)["method-index"], ending("clip-name"), ending("preview"), ending("collection-preview"), tab(host)["preset-index"]], [index, extension, extension, extension, 0], `segment ${index}`);
      await eventually(() => (tab(host).note as { method: string }).method, index === 0 ? "fast" : "precise", "GIF and WebP cut the Precise way");
    }
    // Kept in settings.json under its old name.
    await until(async () => JSON.parse(await readFile(join(data, "settings.json"), "utf8").catch(() => "{}")).method === "gif", "the Output stored");
    // The running export's card says GIF, not Precise with a quality.
    let release: (() => void) | undefined;
    host.tools.handle("ffmpeg", (args) => {
      if (args.includes("-encoders")) return { stdout: ENCODERS };
      if (!args.includes("-/filter_complex")) return { stdout: new Uint8Array() };
      writeFileSync(args[args.indexOf("-progress") + 1]!, "out_time_us=1000000\nprogress=continue\n");
      writeFileSync(args.at(-1)!, "GIF89a");
      // The first run (the palette) waits while the card is read.
      if (release) return { stdout: new Uint8Array() };
      return new Promise((done) => (release = () => done({ stdout: new Uint8Array() }))) as never;
    });
    panel.emit("export-clip", "0:01", "0:05");
    await eventually(() => {
      const card = tab(host).card as { shown: boolean; method: string; preset: string };
      return [card.shown, card.method, card.preset];
    }, [true, "gif", ""]);
    await until(() => !!release, "the image run");
    release!();
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export");
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("settings of 0.5.0–0.6.x: Precise with the Animated GIF or WebP quality is the GIF or WebP Output (Quality: High quality); Fast stays Fast; others as stored", async () => {
  const gif = { format: "gif", rate: "crf", crf: 14, speed: "faster", height: 720, fps: 30, audio: 128 };
  const webp = { ...gif, format: "webp" };
  const small = { format: "mp4", rate: "crf", crf: 26, speed: "balanced", height: 1080, fps: 0, audio: 128 };
  assert.deepEqual(
    [
      outputOf("precise", gif), outputOf("precise", webp), outputOf("fast", gif), outputOf("fast", webp),
      outputOf("precise", small), outputOf("fast", small), outputOf("gif", small), outputOf("webp", undefined), outputOf(undefined, gif), outputOf("turbo", null),
    ],
    ["gif", "webp", "fast", "fast", "precise", "fast", "gif", "webp", "fast", "fast"],
  );
  const migrated = settingsOf({ method: "precise", encode: gif }, "/videos");
  assert.deepEqual([migrated.method, migrated.encode], ["gif", PRESET_ENCODE.high]);
  assert.deepEqual(settingsOf({ method: "fast", encode: webp }, "/videos").encode, PRESET_ENCODE.high, "the MP4 quality before the image was not kept");
  assert.deepEqual(settingsOf({ method: "precise", encode: small }, "/videos").encode, PRESET_ENCODE.small);
  // The tab after an update: a settings.json of 0.6.x with Precise and Animated WebP opens on WebP, the Quality on High quality.
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  try {
    await writeFile(join(data, "settings.json"), JSON.stringify({ method: "precise", encode: webp, advancedOpen: true }));
    const host = new TestHost();
    host.openElsewhere("/media/one.mp4");
    host.setSource({ position: 2, duration: 120 });
    const { stop } = await start(host, data);
    try {
      host.mounted().emit("clip-edited", "0:01", "0:05");
      await host.settle();
      await eventually(() => [tab(host)["method-index"], tab(host)["preset-index"], String(tab(host)["clip-name"]).endsWith(".webp"), tab(host)["advanced-open"]], [3, 1, true, true]);
      // Precise from there: High quality, an MP4.
      host.mounted().emit("set-method", 1);
      await host.settle();
      await eventually(() => [tab(host)["method-index"], tab(host)["preset-index"], String(tab(host)["clip-name"]).endsWith(".mp4")], [1, 1, true]);
    } finally {
      await stop();
    }
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("the merged Collection as WebP from the Output: the merge is Precise, named .webp, the image run is libwebp's; Fast-joinable parts do not make it a copy", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  const { stop } = await start(host, data);
  const { folder, cleanup } = await withFolder(host);
  const rows = () => (tab(host).parts ?? []) as { id: string }[];
  const add = async (path: string) => {
    host.openElsewhere(path);
    host.setSource({ position: 2, duration: 120 });
    const count = rows().length;
    host.mounted().emit("add-part", "0", "4");
    await until(() => rows().length === count + 1, `part ${count + 1}`);
  };
  try {
    const runs = fakeFfmpeg(host);
    await add("/media/one.mp4");
    await add("/media/two.mp4");
    await eventually(() => tab(host)["collection-method-index"], 0, "Fast can join these parts");
    await choose(host, 3);
    await eventually(() => [tab(host)["collection-method-index"], String(tab(host)["collection-preview"]).endsWith(".webp")], [1, true], "WebP merges the Precise way");
    // The check asks with the image's intermediate encoding.
    await until(() => JSON.stringify(host.sent("jobs.check").at(-1)?.encoding) === JSON.stringify(exportEncoding(PRESET_ENCODE.webp)), "the check with the intermediate");
    host.mounted().emit("export-merged");
    await until(() => host.osd.some((line) => line.startsWith("Clip exported as")), "the export");
    const merge = host.exports.filter((e) => Array.isArray(e.parts))[0]!;
    assert.equal(merge.kind, "rawMp4", "re-encoded, not copied");
    assert.ok(String(merge.destination).startsWith(join(data, "work")), "into the work folder first");
    assert.deepEqual(merge.encoding, exportEncoding(PRESET_ENCODE.webp));
    assert.equal(runs.length, 1, "one image run");
    assert.equal(runs[0]!.args[runs[0]!.args.indexOf("-c:v") + 1], "libwebp_anim");
    assert.equal((await readdir(folder)).filter((name) => name.endsWith(".webp")).length, 1);
    await until(() => leftovers(data, folder).length === 0, "no work files left");
  } finally {
    await stop();
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("the tab: a muted line under the Output says what GIF or WebP writes, from the encoder's constants, in every language", async () => {
  const slint = await readFile(new URL("../ui/tab.slint", import.meta.url), "utf8");
  // Shown only while GIF or WebP is chosen, right after the Output row and before Advanced, small and dim.
  const line = /\n(\s*)\/\/ What GIF or WebP writes, right under the Output[^\n]*\n[^\n]*\n\s*if root\.animated: Text \{([\s\S]*?)\n\1\}/.exec(slint);
  assert.ok(line, "the line");
  const body = line[2]!;
  assert.match(body, /color: Theme\.text-dim;/);
  assert.match(body, /font-size: Theme\.font-xs;/);
  assert.match(body, /overflow: elide;/);
  const at = slint.indexOf("What GIF or WebP writes, right under the Output");
  assert.ok(at > slint.indexOf("image-enabled: ClipBridge.support.encode;"), "below the Output switch");
  assert.ok(at < slint.indexOf('title: @tr("Advanced");'), "above Advanced, shown whether it is open or not");
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
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const file of locales) {
    const po = await readFile(new URL(`../locales/${file}`, import.meta.url), "utf8");
    const translated = new RegExp(String.raw`msgid "${literal(template)}"\r?\nmsgstr "([^"]+)"`).exec(po);
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

test("with a real ffmpeg: the GIF palette run writes its frame times as it goes (its progress), into a folder whose name needs escaping; the palette is the same as without them", { skip: !haveFfmpeg && "no ffmpeg (set VESTRA_FFMPEG)" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "clipexport-anim-real-"));
  try {
    const work = join(dir, "it's [a],b;c");
    await mkdir(work);
    const clip = join(work, "clip.mp4");
    run(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    const palette = join(work, "pal.png");
    const { passes } = encode({ input: clip, output: join(work, "out.gif"), progress: join(work, "p"), script: join(work, "g"), palette, format: "gif", length: 3, threads: 1 });
    const times = readFileSync(passes[0]!.times!, "utf8");
    assert.equal(times.split("pts_time:").length - 1, 45, "one line per frame read (15 fps for 3 s)");
    assert.ok(Math.abs(lastFrameTime(times)! - 44 / 15) < 0.01, "the last frame's time");
    // The same palette without the frame times: printing them changes no pixel.
    const plain = join(dir, "plain.png");
    run(FFMPEG, ["-v", "error", "-y", "-threads", "1", "-i", clip, "-filter_complex", `${animatedChain("gif", "0:v", "gifv")};[gifv]palettegen=max_colors=256[out]`, "-map", "[out]", "-frames:v", "1", "-update", "1", "-f", "image2", plain]);
    assert.deepEqual(readFileSync(palette), readFileSync(plain));
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
