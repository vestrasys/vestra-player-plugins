import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { DEFAULT_SETTINGS, DROP_CHECK_MS, dropping, isSettings, MODES, SETTLE_MS, WINDOW_TITLE } from "../main.ts";

const directory = new URL("..", import.meta.url);
const ITEM = "nvidiamotion.window";
const HANDLE = "motion";

async function start(host = new TestHost(), dataDirectory?: string) {
  return startPlugin(activate, { directory, host, ...(dataDirectory ? { dataDirectory } : {}) });
}
const props = (host: TestHost) => host.window(HANDLE).props as Record<string, unknown>;

/**
 * The SDK's TestHost models NVIDIA's engine from the SDK's T8 change on
 * (`host.nvidiaMotion`, the same shape as `host.motion`); before it,
 * `nvidia` is the reserved engine and every mode answers `engine`.
 */
type Model = { mode: string; double: unknown; display: unknown; performance: boolean };
const nvidia = (host: TestHost) => (host as unknown as { nvidiaMotion?: Model }).nvidiaMotion;
const modelled = nvidia(new TestHost()) !== undefined;

test("one Video menu item, beside AMD's, opens the window; off by default and nothing asked at start", async () => {
  const host = new TestHost();
  const { stop } = await start(host);
  try {
    const item = host.command(ITEM);
    assert.deepEqual(item.declaration.path, ["@video", WINDOW_TITLE]);
    assert.ok(!host.calls.some((c) => c.method === "video.motion.set"), "nothing asked while off");
    await item.run();
    await host.settle();
    assert.equal(host.window(HANDLE).visible, true);
    assert.deepEqual(props(host).modes, MODES.map((m) => m.title));
    assert.equal(props(host)["mode-index"], 0);
    assert.ok(host.listening.has("video.motion.changed"), "followed while open");
    assert.deepEqual(
      host.calls.filter((c) => c.method === "video.motion.state").map((c) => c.params),
      [{ engine: "nvidia" }],
    );
  } finally {
    await stop();
  }
});

test("where the player has no NVIDIA engine the window says so and the mode stays off", { skip: modelled }, async () => {
  const host = new TestHost();
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    await host.settle();
    assert.equal(props(host).status, "Not available on this computer");
    assert.equal(props(host).tone, 3);
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(props(host)["mode-index"], 0, "the choice goes back to Off");
    assert.match(String(host.osd.at(-1)), /^NVIDIA motion smoothing unavailable: /);
    assert.equal(host.motion.mode, "off", "AMD's engine was not asked");
  } finally {
    await stop();
  }
});

test("a mode is chosen in the window, runs, is saved and asked for again at the next start", { skip: !modelled }, async () => {
  const data = await mkdtemp(join(tmpdir(), "nvidiamotion-"));
  const host = new TestHost();
  const first = await start(host, data);
  try {
    await host.command(ITEM).run();
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(nvidia(host)!.mode, "double");
    assert.equal(host.motion.mode, "off", "AMD's engine is another one");
    assert.match(String(props(host).status), /^On: 24 → 48 fps on NVIDIA/);
    assert.equal(props(host).tone, 1);
    assert.equal(host.osd.at(-1), "NVIDIA motion smoothing: double frame rate");
    nvidia(host)!.performance = true;
    host.motionChanged();
    await host.settle();
    assert.match(String(props(host).detail), /faster optical flow/);
  } finally {
    await first.stop();
  }
  assert.deepEqual(JSON.parse(await readFile(join(data, "settings.json"), "utf8")), { mode: "double" });
  const again = new TestHost();
  const second = await start(again, data);
  try {
    assert.equal(nvidia(again)!.mode, "double", "asked for again at start");
  } finally {
    await second.stop();
  }
});

test("without an RTX 30 or newer GPU the window says so and the mode stays off", { skip: !modelled }, async () => {
  const host = new TestHost();
  const reason = { code: "no-gpu", message: "no NVIDIA GPU: NVIDIA motion smoothing needs an NVIDIA GeForce RTX 30 series or newer GPU" };
  nvidia(host)!.double = reason;
  nvidia(host)!.display = reason;
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    await host.settle();
    assert.equal(props(host).status, "Not available on this computer");
    assert.equal(props(host).detail, reason.message);
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(nvidia(host)!.mode, "off");
    assert.match(String(host.osd.at(-1)), /^NVIDIA motion smoothing unavailable: no NVIDIA GPU/);
  } finally {
    await stop();
  }
});

test("dropping(): steady drops over the span, not a single burst or a reset", () => {
  const at = (s: number, dropped: number) => ({ at: s * 1000, dropped });
  assert.equal(dropping([]), false);
  assert.equal(dropping([at(0, 0), at(2, 9)]), false, "not a full span yet");
  assert.equal(dropping([at(0, 0), at(2, 2), at(4, 4), at(6, 6)]), true, "1 a second");
  assert.equal(dropping([at(0, 0), at(2, 1), at(4, 2), at(6, 3)]), false, "0.5 a second");
  assert.equal(dropping([at(0, 40), at(2, 0), at(4, 1), at(6, 2)]), false, "the count fell (a seek, a new video)");
  // One burst (a seek, the decoder reopening, a resize, the converter starting) is not steady.
  assert.equal(dropping([at(0, 0), at(2, 30), at(4, 30), at(6, 30)]), false, "a burst in the first reading");
  assert.equal(dropping([at(0, 0), at(2, 0), at(4, 0), at(6, 30)]), false, "a burst in the last reading");
  assert.equal(dropping([at(0, 0), at(2, 0), at(4, 15), at(6, 15)]), false, "a burst in the middle");
  assert.equal(dropping([at(0, 0), at(2, 15), at(4, 15), at(6, 30)]), false, "two bursts, not in a row");
  assert.equal(dropping([at(0, 0), at(2, 0), at(4, 3), at(6, 6)]), true, "two readings in a row at 1.5 a second");
  assert.equal(dropping([at(0, 0), at(2, 9), at(4, 9), at(6, 30), at(8, 33)]), true, "the newest span: drops in its last two readings");
});

test("while the window is open and it converts, steady dropped frames show a hint; it clears when they stop and nothing is read once closed", { skip: !modelled }, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const host = new TestHost();
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(nvidia(host)!.mode, "double");
    const tick = async (dropped: number) => {
      host.stats = { ...host.stats, framesDropped: dropped };
      t.mock.timers.tick(DROP_CHECK_MS);
      await host.settle();
    };
    const ticks = async (...counts: number[]) => {
      for (const dropped of counts) await tick(dropped);
    };
    // A (re)start leaves three readings unjudged: the one that sees it and those within SETTLE_MS.
    assert.equal(SETTLE_MS / DROP_CHECK_MS, 3);
    // The converter's start-up burst spans two readings, then nothing: no hint
    // (two rising readings alone would have shown one).
    assert.equal(dropping([0, 20, 42, 42].map((d, i) => ({ at: i * DROP_CHECK_MS, dropped: d }))), true);
    await ticks(0, 20, 42);
    await ticks(42, 42, 42, 42);
    assert.equal(props(host).hint, "", "the start-up burst is not judged");
    // A single burst later: no hint.
    await ticks(72, 72, 72, 72);
    assert.equal(props(host).hint, "", "a burst is not steady");
    // Steady drops: GPU rendering's advice, for the mode: already Double Frame Rate.
    await ticks(76, 80, 84, 88);
    assert.equal(props(host).hint, "Frames are being dropped: a lower resolution helps.");
    host.window(HANDLE).emit("pickMode", 2);
    await host.settle();
    assert.equal(nvidia(host)!.mode, "display");
    assert.equal(
      props(host).hint,
      "Frames are being dropped: a lower resolution or Double Frame Rate instead of Match Display helps.",
      "with Match Display, Double Frame Rate helps too",
    );
    // Back to Double: a restart; its burst is not judged, and a span without drops clears the hint.
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    await ticks(88, 110, 130);
    await ticks(130, 130, 130, 130);
    assert.equal(props(host).hint, "", "cleared after a span without drops");
    // The fallback step (the faster search) restarts the converter: its burst is not judged either.
    nvidia(host)!.performance = true;
    host.motionChanged();
    await host.settle();
    await ticks(150, 170, 190);
    await ticks(190, 190, 190, 190);
    assert.equal(props(host).hint, "", "the fallback step's burst is not judged");
    // A new video or a seek (mpv's count falls): its burst is not judged.
    await ticks(0, 25, 50);
    await ticks(50, 50, 50, 50);
    assert.equal(props(host).hint, "", "a new video's burst is not judged");
    // With software rendering the advice names the CPU.
    host.videoRender.gpu = false;
    await ticks(60, 70, 80, 90);
    assert.equal(
      props(host).hint,
      "Frames are being dropped: rendering on the CPU cannot keep up; GPU Rendering (Picture ▸ Rendering) or a lower resolution helps.",
      "software rendering: the CPU is what cannot keep up",
    );
    // Closed: no more reads.
    host.window(HANDLE).emit("closeWindow");
    await host.settle();
    const reads = host.calls.filter((c) => c.method === "player.stats").length;
    for (let i = 0; i < 3; i++) await tick(60);
    assert.equal(host.calls.filter((c) => c.method === "player.stats").length, reads);
  } finally {
    await stop();
  }
});

test("settings: only the three modes", () => {
  assert.equal(isSettings(DEFAULT_SETTINGS), true);
  assert.equal(isSettings({ mode: "double" }), true);
  assert.equal(isSettings({ mode: "triple" }), false);
  assert.equal(isSettings(null), false);
});
