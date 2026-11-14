import assert from "node:assert/strict";
import test from "node:test";
import {
  audioStream,
  clock,
  longest,
  mergeSpans,
  nextWindow,
  PAD,
  parseSilences,
  silenceArgs,
  skippable,
  stretchAt,
  windowCount,
} from "../silence.ts";

test("ffmpeg reads one window of one audio stream and prints silencedetect's metadata", () => {
  const args = silenceArgs("/v/talk.mkv", 120, 60, 1, -42);
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 6), ["-ss", "120.000", "-t", "60.000", "-i", "/v/talk.mkv"]);
  assert.equal(args[args.indexOf("-map") + 1], "0:a:1?");
  assert.match(args[args.indexOf("-af") + 1]!, /^silencedetect=noise=-42dB:duration=0\.5,ametadata=mode=print:file=-$/);
  assert.ok(args.includes("-vn"));
});

test("silences are shifted by the window start; one still open runs to the window end", () => {
  const text = [
    "frame:0    pts:0       pts_time:0",
    "lavfi.silence_start=1.5",
    "frame:9    pts:432000  pts_time:9",
    "lavfi.silence_end=9.25",
    "lavfi.silence_duration=7.75",
    "frame:50   pts:0       pts_time:50",
    "lavfi.silence_start=50\r",
  ].join("\n");
  assert.deepEqual(parseSilences(text, 120, 180), [
    { start: 121.5, end: 129.25 },
    { start: 170, end: 180 },
  ]);
  assert.deepEqual(parseSilences("", 0, 120), []);
});

test("silences across a window seam become one", () => {
  const merged = mergeSpans([
    { start: 125, end: 130 },
    { start: 118, end: 120 },
    { start: 120, end: 123 },
    { start: 10, end: 12 },
  ]);
  assert.deepEqual(merged, [
    { start: 10, end: 12 },
    { start: 118, end: 123 },
    { start: 125, end: 130 },
  ]);
});

test("only silences of the minimum length are skipped, less a margin, never into the end", () => {
  const silences = [
    { start: 10, end: 10.8 },
    { start: 20, end: 23 },
    { start: 98, end: 100 },
  ];
  assert.deepEqual(skippable(silences, 1, 100), [{ start: 20 + PAD, end: 23 - PAD }]);
  assert.equal(skippable(silences, 0.5, 100).length, 2);
  assert.equal(skippable(silences, 0.5, null).length, 3);
});

test("the stretch at the playhead, with something left to skip", () => {
  const spans = [
    { start: 5, end: 8 },
    { start: 20, end: 30 },
  ];
  assert.equal(stretchAt(spans, 4.9), null);
  assert.deepEqual(stretchAt(spans, 5), spans[0]);
  assert.equal(stretchAt(spans, 7.95), null);
  assert.deepEqual(stretchAt(spans, 25), spans[1]);
  assert.equal(stretchAt(spans, 31), null);
});

test("the scan starts at the playhead's window and wraps to the start", () => {
  assert.equal(windowCount(300), 3);
  assert.equal(windowCount(0.5), 1);
  const done = new Set<number>();
  assert.equal(nextWindow(done, 3, 130), 1);
  done.add(1);
  assert.equal(nextWindow(done, 3, 130), 2);
  done.add(2);
  assert.equal(nextWindow(done, 3, 130), 0);
  done.add(0);
  assert.equal(nextWindow(done, 3, 130), null);
  assert.equal(nextWindow(new Set(), 3, 9999), 2);
});

test("the seek bar keeps the longest stretches, in time order", () => {
  const spans = [
    { start: 0, end: 1 },
    { start: 2, end: 5 },
    { start: 6, end: 8 },
  ];
  assert.deepEqual(longest(spans, 2), [spans[1], spans[2]]);
  assert.equal(longest(spans, 5), spans);
});

test("the selected track maps to ffmpeg's audio stream number", () => {
  assert.equal(audioStream(null), 0);
  const tracks = [
    { id: 2, selected: true, external: false },
    { id: 1, selected: false, external: false },
    { id: 3, selected: false, external: true },
  ];
  assert.equal(audioStream(tracks), 1);
  assert.equal(audioStream(tracks.map((t) => ({ ...t, selected: t.external }))), 0);
});

test("time saved reads as a clock", () => {
  assert.equal(clock(4.6), "0:05");
  assert.equal(clock(75), "1:15");
  assert.equal(clock(3725), "1:02:05");
});
