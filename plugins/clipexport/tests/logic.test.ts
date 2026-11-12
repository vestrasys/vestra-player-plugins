import assert from "node:assert/strict";
import test from "node:test";
import type { PlayerState } from "@vestra-player/sdk";
import {
  abRange, defaultRange, effectiveMethod, encodeOf, estimate, exportEncoding, fastContainer, keyframeArgs, lastRange, lastSeconds, parseCodec, parseKeyframes, PRESET_ENCODE, presetOf,
  snapStart, timeline, timelineWindow,
} from "../clip.ts";
import { clippable, Failure, notClippable, parseRange, parseTime, tabMode } from "../model.ts";
import { DEFAULT_TEMPLATE, insertVariable, NAME_LIMIT, normalTemplate, renderName, safeName, TEMPLATE_LIMIT } from "../names.ts";
import { RESULT_LIMIT, savedOf } from "../results.ts";
import { timeLeft } from "../tasks.ts";
import { actualRange, clipExport, hostSupport, jobProgress } from "../seams.ts";
import { settingsOf } from "../settings.ts";

const reason = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Failure ? error.code : String(error);
  }
  return "";
};

test("time fields: 1:02:03.450, 02:03.450 and seconds; anything else is no time", () => {
  assert.equal(parseTime("1:02:03.450"), 3723.45);
  assert.equal(parseTime("02:03.450"), 123.45);
  assert.equal(parseTime(" 62.5 "), 62.5);
  assert.equal(parseTime("90:00"), 5400, "minutes before the first colon may pass 59");
  assert.equal(parseTime("0"), 0);
  assert.equal(parseTime(".5"), 0.5);
  assert.equal(parseTime("5."), 5);
  assert.equal(parseTime("1:02:.25"), 3720.25);
  for (const bad of ["", " ", "-1", "1:60", "1:02:60.5", "1.5:00", "1:2:3:4", "abc", "1e3", "NaN", "Infinity", "1:", ":5", ".", "5..1", "1.:00"]) assert.equal(parseTime(bad), null, bad);
});

test("range parsing: field reasons, the end after the start", () => {
  assert.deepEqual(parseRange("0.1", "2.5"), { start: 0.1, end: 2.5 });
  assert.deepEqual(parseRange("4:02.300", "4:19"), { start: 242.3, end: 259 });
  for (const [a, b] of [["", 1], [-1, 1], ["NaN", 1], [0, "Infinity"], ["x", "1"], ["7", undefined]]) assert.equal(reason(() => parseRange(a, b)), "time", `${a}–${b}`);
  for (const [a, b] of [[1, 1], [2, 1], ["4:19", "4:02.3"]]) assert.equal(reason(() => parseRange(a, b)), "endBeforeStart", `${a}–${b}`);
});

test("A-B use: a one-time copy of the player's loop; none without a valid loop", () => {
  assert.deepEqual(abRange({ loop: { a: 242.3, b: 259, count: null } }), { start: 242.3, end: 259 });
  assert.equal(abRange({ loop: null }), null);
  assert.equal(abRange({}), null, "older states without the field");
  assert.equal(abRange({ loop: { a: 5, b: 5, count: 1 } }), null);
  assert.equal(abRange({ loop: { a: Number.NaN, b: 5, count: 1 } }), null);
});

test("Last N s: from N seconds before the position (not before 0); lengths 10/30/60/120, 30 by default", () => {
  assert.deepEqual(lastRange(100, 30), { start: 70, end: 100 });
  assert.deepEqual(lastRange(12, 30), { start: 0, end: 12 }, "clamped at the start of the media");
  assert.deepEqual(lastRange(500, 120), { start: 380, end: 500 });
  assert.equal(reason(() => lastRange(0, 30)), "tooEarly");
  assert.equal(reason(() => lastRange(0.05, 30)), "tooEarly");
  assert.equal(reason(() => lastRange(null, 30)), "tooEarly");
  assert.deepEqual([10, 30, 60, 120, 45, "x", undefined].map(lastSeconds), [10, 30, 60, 120, 30, 30, 30]);
});

test("Export Clip… starts at the position for 10 s; near the end it takes the last 10 s", () => {
  assert.deepEqual(defaultRange(2, 30), { start: 2, end: 12 });
  assert.deepEqual(defaultRange(25, 30), { start: 20, end: 30 }, "near the end: the last 10 s, never past the duration");
  assert.deepEqual(defaultRange(20, 30), { start: 20, end: 30 });
  assert.deepEqual(defaultRange(3, 6), { start: 0, end: 6 }, "a short file: all of it");
  assert.deepEqual(defaultRange(null, null), { start: 0, end: 10 });
});

test("Fast: keyframes from ffprobe's packet flags, the cut starts on the last at or before the start", () => {
  const stdout = "238.000000,K__\n239.001000,___\n240.000000,K_\n242.002000,__\n244.000000,K__\r\n\nbad,K\n240.000000,K__\n";
  const keys = parseKeyframes(stdout);
  assert.deepEqual(keys, [238, 240, 244]);
  assert.equal(snapStart(keys, 242.3), 240);
  assert.equal(snapStart(keys, 240), 240, "a start on a keyframe stays");
  assert.equal(snapStart(keys, 237), null, "none known before it");
  const args = keyframeArgs("/m/a.mkv", 228.3, 264);
  assert.deepEqual(args.slice(args.indexOf("-read_intervals"), args.indexOf("-read_intervals") + 2), ["-read_intervals", "228.300%264.000"]);
  assert.ok(args.includes("packet=pts_time,flags") && args.at(-1) === "/m/a.mkv");
  assert.ok(!args.includes("-show_frames"), "packets only: nothing is decoded");
  // A file whose timestamps start later (MPEG-TS, an edited MP4): keyframes on the player's clock.
  assert.deepEqual(parseCodec("codec_name=h264\nstart_time=1.400000\n"), { video: "h264", offset: 1.4 });
  assert.deepEqual(parseCodec("codec_name=hevc\r\nstart_time=N/A\r\n"), { video: "hevc", offset: 0 });
  assert.deepEqual(parseCodec(""), { video: null, offset: 0 });
  assert.deepEqual(parseKeyframes("11.400000,K__\n13.400000,K__\n", 1.4), [10, 12]);
});

test("Fast container: MP4 when the streams fit, MKV otherwise, unknown without the video codec", () => {
  assert.equal(fastContainer("h264", "aac"), "mp4");
  assert.equal(fastContainer("HEVC", null), "mp4");
  assert.equal(fastContainer("vc1", "aac"), "mkv");
  assert.equal(fastContainer("h264", "dts"), "mkv");
  assert.equal(fastContainer(null, "aac"), "");
});

test("the method: Fast only while the player can copy streams (R1); Precise otherwise", () => {
  assert.equal(effectiveMethod("fast", false), "precise");
  assert.equal(effectiveMethod("fast", true), "fast");
  assert.equal(effectiveMethod("precise", true), "precise");
  const support = hostSupport({} as never);
  assert.deepEqual(Object.values(support), [true, true, true, true, true, true], "player 0.7.6 (minPlayerVersion) has R1–R6");
  assert.equal(hostSupport({} as never, { fastCut: false }).fastCut, false);
  // R1: Fast is a stream copy, the player picks the container.
  assert.deepEqual(clipExport("/o/a.mp4", 9, "fast", PRESET_ENCODE.small), { format: "copy", destination: "/o/a.mp4", end: 9, container: "auto" });
  // R6: Precise with the tab's settings; without them, the player's default encoding.
  assert.deepEqual(clipExport("/o/a.mp4", 9, "precise", PRESET_ENCODE.small), {
    format: "mp4", destination: "/o/a.mp4", end: 9, encoding: { crf: 26, speed: "balanced", maxHeight: 1080, audioBitrate: 128, threads: "auto" },
  });
  assert.deepEqual(clipExport("/o/a.mp4", 9, "precise", undefined), { format: "mp4", destination: "/o/a.mp4", end: 9 });
});

test("R6 encoder settings: a closed set; Same as source is the source bitrate; the cores the player can spare (threads auto)", () => {
  assert.deepEqual(exportEncoding(PRESET_ENCODE.high), { crf: 18, speed: "faster", audioBitrate: 192, threads: "auto" }, "the quality clips always had, on more cores");
  assert.deepEqual(exportEncoding(PRESET_ENCODE.source), { videoBitrate: "source", speed: "balanced", audioBitrate: 256, threads: "auto" }, "no CRF with a source bitrate");
  assert.deepEqual(exportEncoding({ ...PRESET_ENCODE.high, height: 720, fps: 30 }).maxHeight, 720);
  assert.deepEqual(exportEncoding({ ...PRESET_ENCODE.high, height: 720, fps: 30 }).fps, 30);
});

test("R2 and R4: the range the file holds and the progress, from the job's state", () => {
  const done = (outcome: unknown) => ({ status: "completed", outcome }) as never;
  assert.deepEqual(actualRange(done({ destination: "/a.mp4", start: 240, end: 259.02 }), { start: 242.3, end: 259 }), { start: 240, end: 259.02 });
  assert.deepEqual(actualRange(done({ destination: "/a.mp4" }), { start: 242.3, end: 259 }), { start: 242.3, end: 259 }, "none reported: the range asked for");
  assert.deepEqual(actualRange(done({ destination: "/a.mp4", start: 5, end: 5 }), { start: 1, end: 2 }), { start: 1, end: 2 });
  assert.deepEqual(jobProgress({ progress: { done: 3, total: 12 } } as never), { done: 3, total: 12, part: 0, parts: 0, transition: 0, transitions: 0 });
  assert.deepEqual(jobProgress({ progress: { done: 13, total: 12 } } as never), { done: 12, total: 12, part: 0, parts: 0, transition: 0, transitions: 0 });
  assert.deepEqual(jobProgress({ progress: { done: 6, total: 12, part: 2, parts: 3 } } as never), { done: 6, total: 12, part: 2, parts: 3, transition: 0, transitions: 0 }, "a merged export: the part being written");
  assert.deepEqual(jobProgress({ progress: { done: 6, total: 12, part: 9, parts: 3 } } as never), { done: 6, total: 12, part: 3, parts: 3, transition: 0, transitions: 0 });
  assert.equal(jobProgress({ progress: null } as never), null);
  assert.equal(jobProgress({} as never), null);
  assert.equal(jobProgress({ progress: { done: 0, total: 0 } } as never), null);
});

test("the small timeline: about 30 s around the clip, ratios of what was typed and what is written", () => {
  assert.deepEqual(timelineWindow(100, 110, 1000), { from: 90, to: 120 });
  assert.deepEqual(timelineWindow(2, 12, 30), { from: 0, to: 22 });
  assert.deepEqual(timelineWindow(0, 100, 100), { from: 0, to: 100 }, "a long clip: a little room, inside the media");
  const line = timeline({ start: 242.3, end: 259 }, { start: 240, end: 259 }, [236, 238, 240, 244, 300], 250, 1000, 240);
  assert.equal(line.shown, true);
  assert.ok(line.gota < line.wanta && line.wantb === line.gotb, "the written range starts earlier");
  assert.equal(line.key, line.gota);
  assert.ok(line.head > line.wanta && line.head < line.wantb);
  assert.equal(line.ticks.split("M").length - 1, 4, "the keyframe outside the window is left out");
  assert.equal(timeline({ start: 1, end: 2 }, { start: 1, end: 2 }, [], 500, 1000, null).head, -1, "a playhead outside the window");
});

test("Precise presets: High quality is the encoding clips always had; any change is Custom; stored options fall back field by field", () => {
  assert.deepEqual(PRESET_ENCODE.high, { format: "mp4", rate: "crf", crf: 18, speed: "faster", height: 0, fps: 0, audio: 192 });
  assert.equal(presetOf(PRESET_ENCODE.small), "small");
  assert.equal(presetOf(PRESET_ENCODE.source), "source");
  assert.equal(presetOf({ ...PRESET_ENCODE.source, crf: 25 }), "source", "the CRF does not count with a source bitrate");
  assert.equal(presetOf({ ...PRESET_ENCODE.high, crf: 19 }), "custom");
  assert.deepEqual(encodeOf({ rate: "vbr", crf: 99, speed: "warp", height: 720, fps: 30, audio: 1 }), { format: "mp4", rate: "crf", crf: 30, speed: "faster", height: 720, fps: 30, audio: 192 });
  assert.equal(encodeOf({ rate: "source" }).rate, "source");
  assert.deepEqual(encodeOf(null), PRESET_ENCODE.high);
});

test("estimates: Fast is the source's share of its file; Precise a range, a measured speed narrows the time", () => {
  const fast = estimate({ method: "fast", length: 19, fileBytes: 1_000_000_000, duration: 400, encode: PRESET_ENCODE.high, secondsPerSecond: null, height: null });
  assert.deepEqual([fast.sizelow, fast.sizehigh, fast.timelow], [47.5, 47.5, 1]);
  const precise = estimate({ method: "precise", length: 19, fileBytes: 1_000_000_000, duration: 400, encode: PRESET_ENCODE.high, secondsPerSecond: null, height: null });
  assert.ok(precise.sizelow < 47.5 && precise.sizehigh > 47.5);
  assert.ok(precise.timehigh > precise.timelow);
  const smaller = estimate({ method: "precise", length: 19, fileBytes: 1_000_000_000, duration: 400, encode: { ...PRESET_ENCODE.high, crf: 24 }, secondsPerSecond: null, height: null });
  assert.ok(Math.abs(smaller.sizehigh * 2 - precise.sizehigh) < 0.2, "6 more on the quality number about halves the size");
  const measured = estimate({ method: "precise", length: 10, fileBytes: null, duration: null, encode: PRESET_ENCODE.high, secondsPerSecond: 2, height: null });
  assert.deepEqual([measured.sizehigh, measured.timelow, measured.timehigh], [0, 16, 25]);
});

test("the file-name template: the default states the range; variables, illegal characters, empty and long templates", () => {
  const now = new Date(2026, 10, 7, 16, 21, 5);
  const values = { source: "/movies/bbb_sunflower.mp4", start: 242.3, end: 259, now };
  assert.equal(renderName(DEFAULT_TEMPLATE, values), "bbb_sunflower_04.02.300-04.19.000");
  assert.equal(renderName("{n} {date}_{time} {start} {end}", { ...values, n: 7 }), "007 2026-11-07_16.21.05 04.02.300 04.19.000");
  assert.equal(renderName("{name}:{nope}/x", values), "bbb_sunflower_{nope}_x", "an unknown variable stays; illegal characters become _");
  assert.equal(renderName("  ", values), "bbb_sunflower_04.02.300-04.19.000", "a blank template uses the default");
  assert.equal(renderName("...", values), "bbb_sunflower_04.02.300-04.19.000", "a name that comes out empty uses the default");
  assert.equal(renderName("{name}", { ...values, source: null }), "clip");
  assert.equal(renderName("{name}", { ...values, source: "https://x.test/v/movie.m3u8?token=1" }), "movie");
  assert.equal(safeName("a\u0001b. "), "a_b");
  // Windows device names, whatever follows the first dot and in any case.
  const devices = [["CON", "CON_"], ["nul", "nul_"], ["Aux.mp4", "Aux_.mp4"], ["com1.tar.gz", "com1_.tar.gz"], ["LPT9", "LPT9_"], ["COM¹", "COM¹_"], ["conin$", "conin$_"], ["CONOUT$.txt", "CONOUT$_.txt"], ["console", "console"], ["com10", "com10"], ["prn_1", "prn_1"]];
  for (const [name, safe] of devices) assert.equal(safeName(name!), safe, name);
  assert.equal(renderName("{name}", { ...values, source: "/m/aux.mp4" }), "aux_", "a device name from the source");
  assert.equal(renderName("NUL", values), "NUL_");
  // Long names: the source's name gives way, the times stay; never over the limit.
  const long = renderName(DEFAULT_TEMPLATE, { ...values, source: `/m/${"x".repeat(400)}.mp4`, start: 1, end: 2 });
  assert.equal(long.length, NAME_LIMIT);
  assert.match(long, /^x+_00\.01\.000-00\.02\.000$/);
  assert.ok(renderName("{date}".repeat(40), values).length <= NAME_LIMIT, "no {name} to shorten: cut at the limit");
  assert.ok(NAME_LIMIT + ".mp4".length + " (999)".length <= 180);
  assert.equal(normalTemplate(""), DEFAULT_TEMPLATE);
  assert.equal(normalTemplate(5), DEFAULT_TEMPLATE);
  assert.equal(normalTemplate("x".repeat(500)).length, TEMPLATE_LIMIT);
  assert.equal(insertVariable("{name}_", "{start}"), "{name}_{start}");
  assert.equal(insertVariable("{name}", "{evil}"), "{name}", "only the listed variables");
  assert.equal(insertVariable("{name}", "{pos}"), "{name}", "{pos} is a snapshot variable");
});

test("tab modes: local everything, network and a plugin's stream nothing, none without a frame", () => {
  const state = (patch: Partial<PlayerState>) => ({ kind: "media", phase: "ready", source: "/m/a.mp4", duration: 30, position: 2, can: { snapshot: true }, ...patch }) as PlayerState;
  assert.equal(tabMode(state({})), "local");
  assert.equal(clippable(state({})), true);
  assert.equal(tabMode(state({ source: "https://x.test/a.m3u8" })), "network");
  assert.equal(clippable(state({ source: "https://x.test/a.m3u8" })), false);
  assert.equal(notClippable(state({ source: "https://x.test/a.m3u8" })), "needLocal");
  assert.equal(tabMode(state({ kind: "stream", source: "producer://1" })), "stream");
  assert.equal(notClippable(state({ kind: "stream", source: "producer://1" })), "unexportable");
  assert.equal(tabMode(state({ phase: "loading" })), "none");
  assert.equal(tabMode(state({ can: { snapshot: false } as PlayerState["can"] })), "none");
  assert.equal(clippable(state({ duration: null })), false, "a clip needs a known duration");
  assert.equal(notClippable(state({ duration: null })), "needDuration");
  assert.equal(tabMode(state({ phase: "ended" })), "local", "a finished file keeps its last frame");
});

test("settings fall back field by field; new fields have their defaults", () => {
  const s = settingsOf({ method: "turbo", encode: { crf: 20 }, template: 3, lastSeconds: 45, preciseSpeed: -1, page: 7 }, "/videos");
  assert.equal(s.method, "fast", "Fast is the default");
  assert.deepEqual(s.encode, { ...PRESET_ENCODE.high, crf: 20 });
  assert.equal(s.template, DEFAULT_TEMPLATE);
  assert.equal(s.lastSeconds, 30);
  assert.equal(s.preciseSpeed, null);
  assert.equal(s.folder, "/videos");
  assert.deepEqual([s.besideMedia, s.advancedOpen, s.page], [false, false, "clip"]);
  assert.equal(s.collectionTemplate, "{name}_collection_{date}");
  // 0.1.x kept the page as its index among Clip, Results, Settings.
  assert.deepEqual([0, 1, 2].map((page) => settingsOf({ page }, "/videos").page), ["clip", "results", "settings"]);
  // 0.2.x and 0.3.x had a Collection page: it is a section of the Clip page now.
  assert.deepEqual(["collection", "results", "settings", "nope"].map((page) => settingsOf({ page }, "/videos").page), ["clip", "results", "settings", "clip"]);
  assert.equal(settingsOf({ template: "{n}" }, "/videos").template, "{n}");
});

test("stored results: valid ones only, newest first, at most twenty", () => {
  const item = (i: number) => ({ id: `r${i}`, path: `/o/${i}.mp4`, finished: i, method: "fast", bytes: 5, start: 1, end: 2, thumb: "../../evil.jpg" });
  const list = savedOf({ list: [...Array.from({ length: 25 }, (_, i) => item(i)), { id: "x", path: "", finished: 1 }, null, 7] });
  assert.equal(list.length, RESULT_LIMIT);
  assert.equal(list[0]!.id, "r24");
  assert.equal(list[0]!.thumb, "evil.jpg", "a thumbnail is a file name inside the data directory");
  assert.deepEqual(savedOf(null), []);
  assert.equal(savedOf({ list: [{ ...item(1), method: "lossy" }] })[0]!.method, "precise");
});

test("time left: from the rate measured since the progress first moved, nothing before 1.5 s of it, nothing while the file is checked", () => {
  const at = 1_000_000;
  // Ten seconds of 4K encoding start-up behind it: not counted.
  const task = { progress: { done: 0.4, total: 9.8 }, rateFrom: { at, done: 0.4 } };
  assert.equal(timeLeft(task, at + 1000), -1, "under 1.5 s of measuring");
  assert.equal(timeLeft({ ...task, progress: { done: 1.4, total: 9.8 } }, at + 2000), 17, "0.5 s of media per second: 8.4 s left take 17 s");
  assert.equal(timeLeft({ ...task, progress: { done: 0.4, total: 9.8 } }, at + 5000), -1, "no progress since: no rate");
  assert.equal(timeLeft({ progress: { done: 9.8, total: 9.8 }, rateFrom: { at, done: 1 } }, at + 9000), -1, "done: the player checks the file");
  assert.equal(timeLeft({ progress: null, rateFrom: undefined }, at), -1, "unknown progress (preroll, seek)");
});
