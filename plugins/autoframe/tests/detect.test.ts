import assert from "node:assert/strict";
import test from "node:test";
import {
  analyseFrame,
  borderColour,
  cropNodes,
  decide,
  displaySize,
  type FrameResult,
  type Rect,
  sampleTimes,
  simulateChain,
  snapStandard,
} from "../detect.ts";
import { evaluate, hostChain, makeFrame, rustNumber, type Rgb } from "./frames.ts";

const GREY: Rgb = [128, 128, 128];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

const frame = (width: number, height: number, background: Rgb, content: Rect | null, seed = 0) => ({
  width,
  height,
  data: makeFrame(width, height, background, content, seed),
});

/** `count` frames of the same layout, each with another pattern. */
const frames = (width: number, height: number, background: Rgb, content: Rect | null, count = 8): FrameResult[] =>
  Array.from({ length: count }, (_, i) => analyseFrame(frame(width, height, background, content, i)));

test("the host's crop expression: Rust number format and the evaluator", () => {
  assert.equal(rustNumber(2.35), "2.35");
  assert.equal(rustNumber(-1), "-1");
  assert.equal(rustNumber(2.220446049250313e-16), "0.0000000000000002220446049250313");
  assert.equal(Number(rustNumber(1.5e-7)), 1.5e-7);
  assert.equal(evaluate("2*trunc(min(iw,ih*2.35/sar)/2)", { iw: 1920, ih: 1080, sar: 1 }), 1920);
  assert.equal(evaluate("2*trunc(min(ih,iw*sar/2.35)/2)", { iw: 1920, ih: 1080, sar: 1 }), 816);
  assert.equal(evaluate("(ih-oh)*(1+(-1))/2", { ih: 1080, oh: 816 }), 0);
  // The player's own test (effects.rs): Crop to 2.35:1 at the top.
  assert.deepEqual(hostChain(1920, 1080, 1, [{ aspect: 2.35, x: 0, y: -1 }]), { x: 0, y: 0, width: 1920, height: 816 });
});

test("border colour: the mode of the outer ring when one whole edge has it", () => {
  assert.deepEqual(borderColour(frame(320, 180, GREY, { x: 0, y: 0, width: 200, height: 100 })), GREY);
  assert.deepEqual(borderColour(frame(320, 180, [12, 200, 40], { x: 60, y: 40, width: 200, height: 100 })), [12, 200, 40]);
  // Content to every edge: no border.
  assert.equal(borderColour(frame(320, 180, GREY, { x: 0, y: 0, width: 320, height: 180 })), null);
  // Compression noise of ±3 stays one colour.
  const noisy = frame(320, 180, GREY, { x: 0, y: 0, width: 200, height: 100 });
  for (let i = 0; i < noisy.data.length; i += 3) {
    const y = Math.floor(i / 3 / 320);
    const x = (i / 3) % 320;
    if (x >= 200 || y >= 100) noisy.data[i] = 128 + ((i / 3) % 7) - 3;
  }
  const colour = borderColour(noisy);
  assert.ok(colour && Math.abs(colour[0] - 128) <= 3 && colour[1] === 128);
});

test("one frame: content box, blank frame, full frame", () => {
  assert.deepEqual(analyseFrame(frame(320, 180, GREY, { x: 10, y: 20, width: 200, height: 100 })), {
    kind: "border",
    colour: GREY,
    box: { x: 10, y: 20, width: 200, height: 100 },
  });
  assert.deepEqual(analyseFrame(frame(320, 180, BLACK, null)), { kind: "blank", colour: BLACK });
  assert.deepEqual(analyseFrame(frame(320, 180, GREY, { x: 0, y: 0, width: 320, height: 180 })), { kind: "full" });
});

test("decide: a 2560×1440 picture top-left in 3840×2160 grey (4K frames)", () => {
  const results = frames(3840, 2160, GREY, { x: 0, y: 0, width: 2560, height: 1440 }, 3);
  assert.deepEqual(decide(results, 3840, 2160), { rect: { x: 0, y: 0, width: 2560, height: 1440 } });
});

test("decide: centred on white, any corner, any colour", () => {
  assert.deepEqual(decide(frames(1920, 1080, WHITE, { x: 320, y: 180, width: 1280, height: 720 }), 1920, 1080), {
    rect: { x: 320, y: 180, width: 1280, height: 720 },
  });
  assert.deepEqual(decide(frames(1920, 1080, [30, 60, 200], { x: 640, y: 360, width: 1280, height: 720 }), 1920, 1080), {
    rect: { x: 640, y: 360, width: 1280, height: 720 },
  });
});

test("decide: a box blurred by a pixel or two snaps to the standard size, keeping the touching edge", () => {
  // 1283×722 at the top-left (ringing past the right and bottom edges).
  const results = frames(1920, 1080, GREY, { x: 0, y: 0, width: 1283, height: 722 });
  assert.deepEqual(decide(results, 1920, 1080), { rect: { x: 0, y: 0, width: 1280, height: 720 } });
  // Touching the bottom-right corner.
  const corner = frames(1920, 1080, GREY, { x: 639, y: 359, width: 1281, height: 721 });
  assert.deepEqual(decide(corner, 1920, 1080), { rect: { x: 640, y: 360, width: 1280, height: 720 } });
  // Not near a standard size: kept, widened to even edges.
  const odd = frames(1920, 1080, GREY, { x: 101, y: 51, width: 1001, height: 601 });
  assert.deepEqual(decide(odd, 1920, 1080), { rect: { x: 100, y: 50, width: 1002, height: 602 } });
});

test("decide: fades are skipped; too few frames with a picture is no crop", () => {
  const content = { x: 0, y: 0, width: 1280, height: 720 };
  const fade = [...frames(1920, 1080, BLACK, null, 5), ...frames(1920, 1080, BLACK, content, 3)];
  assert.deepEqual(decide(fade, 1920, 1080), { rect: content });
  const dark = [...frames(1920, 1080, BLACK, null, 6), ...frames(1920, 1080, BLACK, content, 2)];
  assert.deepEqual(decide(dark, 1920, 1080), { reason: "few-frames" });
});

test("decide: the union of frames, and a frame without border or with another border colour fills the frame", () => {
  const a = frames(1920, 1080, GREY, { x: 0, y: 0, width: 1000, height: 600 }, 4);
  const b = frames(1920, 1080, GREY, { x: 200, y: 100, width: 1080, height: 620 }, 4);
  assert.deepEqual(decide([...a, ...b], 1920, 1080), { rect: { x: 0, y: 0, width: 1280, height: 720 } });
  const full = frames(1920, 1080, GREY, { x: 0, y: 0, width: 1920, height: 1080 }, 1);
  assert.deepEqual(decide([...a, ...full], 1920, 1080), { reason: "no-border" });
  const other = frames(1920, 1080, WHITE, { x: 0, y: 0, width: 1000, height: 600 }, 1);
  assert.deepEqual(decide([...a, ...b, ...other], 1920, 1080), { reason: "no-border" });
});

test("decide: a border on one axis only is not cropped (ruling: both axes)", () => {
  // 2.35:1 letterbox: 1920×816 between black bars above and below.
  assert.deepEqual(decide(frames(1920, 1080, BLACK, { x: 0, y: 132, width: 1920, height: 816 }), 1920, 1080), {
    reason: "one-axis",
  });
  // 4:3 pillarbox: 1440×1080 between bars at the sides.
  assert.deepEqual(decide(frames(1920, 1080, BLACK, { x: 240, y: 0, width: 1440, height: 1080 }), 1920, 1080), {
    reason: "one-axis",
  });
  // The threshold: 95 % in one direction is "full"; just under it in both is cropped.
  assert.deepEqual(decide(frames(1920, 1080, GREY, { x: 0, y: 0, width: 1824, height: 720 }), 1920, 1080), {
    reason: "one-axis",
  });
  assert.deepEqual(decide(frames(1920, 1080, GREY, { x: 0, y: 0, width: 1822, height: 1024 }), 1920, 1080), {
    rect: { x: 0, y: 0, width: 1822, height: 1024 },
  });
  // A 2K picture top-left of 4K, and a centred box: both axes, cropped.
  assert.deepEqual(decide(frames(3840, 2160, GREY, { x: 0, y: 0, width: 1920, height: 1080 }, 3), 3840, 2160), {
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
  });
  assert.deepEqual(decide(frames(3840, 2160, BLACK, { x: 960, y: 540, width: 1920, height: 1080 }, 3), 3840, 2160), {
    rect: { x: 960, y: 540, width: 1920, height: 1080 },
  });
});

test("decide: no crop for nearly full, too small, or too narrow content", () => {
  assert.deepEqual(decide(frames(1920, 1080, BLACK, { x: 20, y: 20, width: 1880, height: 1040 }), 1920, 1080), {
    reason: "no-border",
  });
  assert.deepEqual(decide(frames(1920, 1080, GREY, { x: 0, y: 0, width: 400, height: 300 }), 1920, 1080), {
    reason: "small",
  });
  assert.deepEqual(decide(frames(1920, 1080, GREY, { x: 0, y: 0, width: 150, height: 800 }), 1920, 1080), {
    reason: "small",
  });
  // 1800×420 is over 10 % of the area but wider than 4:1.
  assert.deepEqual(decide(frames(1920, 1080, GREY, { x: 0, y: 400, width: 1800, height: 420 }), 1920, 1080), {
    reason: "aspect",
  });
});

test("snapStandard: within 1 % of a standard size only", () => {
  assert.deepEqual(snapStandard({ x: 0, y: 0, width: 2568, height: 1446 }, 3840, 2160), {
    x: 0,
    y: 0,
    width: 2560,
    height: 1440,
  });
  const far = { x: 0, y: 0, width: 2600, height: 1440 };
  assert.deepEqual(snapStandard(far, 3840, 2160), far);
});

/** Every even rect in a frame, sampled, gives crop nodes that the host's own expressions turn into exactly that rect. */
function checkCrops(width: number, height: number, sar: [number, number], step: number) {
  let checked = 0;
  for (let w = 160; w <= width; w += step) {
    for (let h = 160; h <= height; h += step) {
      const ew = w & ~1;
      const eh = h & ~1;
      for (const [x, y] of [
        [0, 0],
        [width - ew, height - eh],
        [((width - ew) / 2) & ~1, ((height - eh) / 2) & ~1],
        [((width - ew) / 3) & ~1, ((height - eh) / 5) & ~1],
      ] as const) {
        const rect = { x: x & ~1, y: y & ~1, width: ew, height: eh };
        const aspect = (ew * sar[0]) / sar[1] / eh;
        if (aspect < 0.25 || aspect > 4) continue;
        const nodes = cropNodes(rect, width, height, sar[0] / sar[1]);
        if (nodes === null) {
          // Only for boxes under the 10 % `decide` asks for, where neither order's first node fits 0.25–4.
          assert.ok(ew * eh < 0.1 * width * height, `${width}×${height} ${JSON.stringify(rect)}`);
          continue;
        }
        if (nodes.length === 0) {
          // The whole even part of the frame: nothing to crop.
          assert.deepEqual([ew, eh], [width & ~1, height & ~1]);
          continue;
        }
        assert.ok(nodes.length <= 2);
        for (const node of nodes) {
          assert.equal(node.kind, "reframe");
          assert.equal(node.mode, "crop");
          assert.ok(node.aspect >= 0.25 && node.aspect <= 4, `aspect ${node.aspect}`);
          assert.ok(Math.abs(node.x) <= 1 && Math.abs(node.y) <= 1);
        }
        const got = hostChain(width, height, sar[0] / sar[1], nodes);
        assert.deepEqual(got, rect, `${width}×${height} ${JSON.stringify(rect)} ${JSON.stringify(nodes)}`);
        assert.deepEqual(simulateChain(width, height, sar[0] / sar[1], nodes), rect);
        checked++;
      }
    }
  }
  return checked;
}

test("crop nodes reproduce the exact rect through the player's FFmpeg expressions", () => {
  assert.ok(checkCrops(3840, 2160, [1, 1], 98) > 1000);
  assert.ok(checkCrops(1920, 1080, [1, 1], 46) > 1000);
  assert.ok(checkCrops(1440, 1080, [4, 3], 38) > 500); // anamorphic HDV
  assert.ok(checkCrops(1080, 1920, [1, 1], 62) > 500); // portrait
  assert.ok(checkCrops(1921, 1081, [1, 1], 120) > 100); // odd sizes
});

test("crop nodes: one node per cropped side, none when nothing is cropped", () => {
  assert.deepEqual(cropNodes({ x: 0, y: 0, width: 1920, height: 1080 }, 1920, 1080), []);
  const wide = cropNodes({ x: 240, y: 0, width: 1440, height: 1080 }, 1920, 1080);
  assert.equal(wide?.length, 1);
  assert.equal(wide?.[0]?.y, 0);
  const both = cropNodes({ x: 0, y: 0, width: 2560, height: 1440 }, 3840, 2160);
  assert.equal(both?.length, 2);
  assert.deepEqual(hostChain(3840, 2160, 1, both!), { x: 0, y: 0, width: 2560, height: 1440 });
});

test("display size as mpv reports it; sample times", () => {
  assert.deepEqual(displaySize(1440, 1080, 4, 3), { width: 1920, height: 1080 });
  assert.deepEqual(displaySize(720, 480, 8, 9), { width: 720, height: 540 });
  assert.deepEqual(displaySize(2560, 1440), { width: 2560, height: 1440 });
  const times = sampleTimes(100);
  assert.equal(times.length, 8);
  assert.equal(times[0], 5);
  assert.ok(Math.abs(times[7]! - 95) < 1e-9);
  assert.deepEqual(sampleTimes(0), [0]);
});
