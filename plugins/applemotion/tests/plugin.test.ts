import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { CATEGORY, DEFAULT_SETTINGS, DROP_CHECK_MS, dropping, isSettings, MODES, modeCommandId, SETTLE_MS, WINDOW_ID, WINDOW_TITLE } from "../main.ts";

const directory = new URL("..", import.meta.url);
const ITEM = "applemotion.window";
const HANDLE = "motion";

async function start(host = new TestHost(), dataDirectory?: string) {
  return startPlugin(activate, { directory, host, ...(dataDirectory ? { dataDirectory } : {}) });
}
const props = (host: TestHost) => host.window(HANDLE).props as Record<string, unknown>;

test("one Video menu item, beside AMD's and NVIDIA's, opens the window; off by default and nothing asked at start", async () => {
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
      [{ engine: "apple" }, { engine: "apple" }],
      "read at start (for the mode commands) and when the window opens",
    );
  } finally {
    await stop();
  }
});

test("where the player has no Apple engine the window says so and the mode stays off", async () => {
  const host = new TestHost();
  const reason = { code: "engine", message: "this player has no Apple frame interpolation" };
  host.appleMotion.double = reason;
  host.appleMotion.display = reason;
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    await host.settle();
    assert.equal(props(host).status, "Not available on this computer");
    assert.equal(props(host).tone, 3);
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(props(host)["mode-index"], 0, "the choice goes back to Off");
    assert.match(String(host.osd.at(-1)), /^Apple motion smoothing unavailable: /);
    assert.equal(host.appleMotion.mode, "off");
    assert.equal(host.motion.mode, "off", "AMD's engine was not asked");
    assert.equal(host.nvidiaMotion.mode, "off", "NVIDIA's engine was not asked");
  } finally {
    await stop();
  }
});

test("a mode is chosen in the window, runs, is saved and asked for again at the next start", async () => {
  const data = await mkdtemp(join(tmpdir(), "applemotion-"));
  const host = new TestHost();
  const first = await start(host, data);
  try {
    await host.command(ITEM).run();
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(host.appleMotion.mode, "double");
    assert.equal(host.motion.mode, "off", "AMD's engine is another one");
    assert.equal(host.nvidiaMotion.mode, "off", "NVIDIA's engine is another one");
    assert.match(String(props(host).status), /^On: 24 → 48 fps on Apple M2$/);
    assert.equal(props(host).tone, 1);
    assert.equal(host.osd.at(-1), "Apple motion smoothing: double frame rate");
    assert.equal(props(host).detail, "", "nothing more to say while it runs");
  } finally {
    await first.stop();
  }
  assert.deepEqual(JSON.parse(await readFile(join(data, "settings.json"), "utf8")), { mode: "double" });
  const again = new TestHost();
  const second = await start(again, data);
  try {
    assert.equal(again.appleMotion.mode, "double", "asked for again at start");
  } finally {
    await second.stop();
  }
});

test("on a Mac without Apple silicon the window says so and the mode stays off", async () => {
  const host = new TestHost();
  const reason = { code: "no-gpu", message: "Apple motion smoothing needs a Mac with Apple silicon" };
  host.appleMotion.double = reason;
  host.appleMotion.display = reason;
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    await host.settle();
    assert.equal(props(host).status, "Not available on this computer");
    assert.equal(props(host).detail, reason.message);
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(host.appleMotion.mode, "off");
    assert.match(String(host.osd.at(-1)), /^Apple motion smoothing unavailable: Apple motion smoothing needs a Mac with Apple silicon/);
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

test("while the window is open and it converts, steady dropped frames show a hint; it clears when they stop and nothing is read once closed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const host = new TestHost();
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(host.appleMotion.mode, "double");
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
    assert.equal(host.appleMotion.mode, "display");
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

/** The mode commands' state as the player shows it: `[enabled, checked, reason]` per mode, in MODES order. */
const modeStates = (host: TestHost) =>
  MODES.map((m) => {
    const { enabled, checked, reason } = host.command(modeCommandId(m.mode)).state;
    return [enabled, checked, reason];
  });

test("three mode commands for the palette and Ask Vestra: outside the menus, named for what people ask, checked on the saved mode", async () => {
  const host = new TestHost();
  const { stop } = await start(host);
  try {
    await host.settle();
    for (const m of MODES) {
      const { declaration } = host.command(modeCommandId(m.mode));
      assert.deepEqual(declaration.path ?? [], [], "not in the menus: the window's menu item stays the only one");
      assert.equal(declaration.title, m.command);
      assert.equal(declaration.category, CATEGORY);
      assert.equal(declaration.home, WINDOW_ID);
      assert.equal(declaration.radio, true);
    }
    assert.equal(CATEGORY, "Apple Motion Smoothing");
    // The words people ask with, in the palette row `Category: Title`.
    const rows = MODES.map((m) => `${CATEGORY}: ${m.command}`).join(" ");
    for (const word of ["Motion Smoothing", "Smoother Video", "Smoothest Motion", "Frame Rate", "Apple"])
      assert.ok(rows.includes(word), word);
    assert.deepEqual(modeStates(host), [
      [true, true, null],
      [true, false, null],
      [true, false, null],
    ]);
    assert.deepEqual(host.keepsRunning, [], "off: nothing keeps the plugin running");
  } finally {
    await stop();
  }
});

test("running a mode command sets the mode, saves it and moves the check mark; the window's choice moves it too", async () => {
  const data = await mkdtemp(join(tmpdir(), "applemotion-cmd-"));
  const host = new TestHost();
  const first = await start(host, data);
  try {
    await host.command(modeCommandId("double")).run();
    await host.settle();
    assert.equal(host.appleMotion.mode, "double");
    assert.equal(host.motion.mode, "off", "the other engines are not asked");
    assert.equal(host.nvidiaMotion.mode, "off");
    assert.equal(host.osd.at(-1), "Apple motion smoothing: double frame rate");
    assert.deepEqual(
      modeStates(host).map(([, checked]) => checked),
      [false, true, false],
    );
    await host.command(WINDOW_ID).run();
    host.window(HANDLE).emit("pickMode", 2);
    await host.settle();
    assert.equal(host.appleMotion.mode, "display");
    assert.deepEqual(
      modeStates(host).map(([, checked]) => checked),
      [false, false, true],
    );
    await host.command(modeCommandId("off")).run();
    await host.settle();
    assert.equal(host.appleMotion.mode, "off");
    assert.equal(props(host)["mode-index"], 0, "the open window follows");
    await host.command(modeCommandId("double")).run();
    await host.settle();
  } finally {
    await first.stop();
  }
  assert.deepEqual(JSON.parse(await readFile(join(data, "settings.json"), "utf8")), { mode: "double" });
  const again = new TestHost();
  const second = await start(again, data);
  try {
    await again.settle();
    assert.deepEqual(
      modeStates(again).map(([, checked]) => checked),
      [false, true, false],
      "the saved mode is checked at the next start",
    );
  } finally {
    await second.stop();
  }
});

test("on a Mac without Apple silicon both modes are greyed out with the player's reason; Off stays", async () => {
  const host = new TestHost();
  const reason = { code: "no-gpu", message: "Apple motion smoothing needs a Mac with Apple silicon" };
  host.appleMotion.double = reason;
  host.appleMotion.display = reason;
  const { stop } = await start(host);
  try {
    await host.settle();
    assert.deepEqual(modeStates(host), [
      [true, true, null],
      [false, false, { $vestraText: "Not available: {}", args: [reason.message] }],
      [false, false, { $vestraText: "Not available: {}", args: [reason.message] }],
    ]);
    assert.deepEqual(host.keepsRunning, []);
  } finally {
    await stop();
  }
});

test("Match Display is greyed out with software rendering, not while GPU rendering starts; a reason that can pass greys nothing", async () => {
  const rendering = { code: "rendering", message: "Match Display needs GPU rendering" };
  const software = new TestHost();
  software.appleMotion.display = rendering;
  software.appleMotion.double = { code: "doubling", message: "a frame-doubling filter is on" };
  const first = await start(software);
  try {
    await software.settle();
    assert.deepEqual(modeStates(software), [
      [true, true, null],
      [true, false, null],
      [false, false, { $vestraText: "Not available: {}", args: [rendering.message] }],
    ]);
  } finally {
    await first.stop();
  }
  const starting = new TestHost();
  starting.appleMotion.display = rendering;
  starting.appleMotion.renderingStarting = true;
  starting.rendering.reason = { code: "pending", message: "GPU rendering is starting" };
  const second = await start(starting);
  try {
    await starting.settle();
    assert.equal(starting.command(modeCommandId("display")).state.enabled, true, "set keeps the request while GPU rendering starts");
    await starting.command(modeCommandId("display")).run();
    await starting.settle();
    assert.equal(starting.appleMotion.mode, "display");
  } finally {
    await second.stop();
  }
});

test("while the window is open the mode commands follow the player's state", async () => {
  const host = new TestHost();
  const { stop } = await start(host);
  try {
    await host.command(WINDOW_ID).run();
    await host.settle();
    const reason = { code: "runtime", message: "the converter cannot start on this system" };
    host.appleMotion.double = reason;
    host.appleMotion.display = reason;
    host.motionChanged();
    await host.settle();
    assert.equal(host.command(modeCommandId("double")).state.enabled, false);
    assert.deepEqual(host.command(modeCommandId("double")).state.reason, { $vestraText: "Not available: {}", args: [reason.message] });
  } finally {
    await stop();
  }
});

/** Apple's run-long reasons (SDK 1.11.5's reason table): the window says it is not available here, with the player's message. */
const RUN_LONG = [
  { code: "platform", message: "Apple motion smoothing needs macOS: Apple's frame interpolation does not exist on this system" },
  { code: "no-gpu", message: "Apple motion smoothing needs a Mac with Apple silicon" },
  { code: "runtime", message: "Apple motion smoothing needs macOS 15.4 or newer" },
  { code: "filter", message: "this player was built without Apple's frame interpolation" },
];

for (const reason of RUN_LONG)
  test(`${reason.code}: the window says it is not available, the modes are greyed out and a choice is refused`, async () => {
    const host = new TestHost();
    host.appleMotion.double = reason;
    host.appleMotion.display = reason;
    const { stop } = await start(host);
    try {
      await host.command(ITEM).run();
      await host.settle();
      assert.equal(props(host).status, "Not available on this computer");
      assert.equal(props(host).tone, 3);
      assert.equal(props(host).detail, reason.message);
      assert.deepEqual(modeStates(host).slice(1), [
        [false, false, { $vestraText: "Not available: {}", args: [reason.message] }],
        [false, false, { $vestraText: "Not available: {}", args: [reason.message] }],
      ]);
      host.window(HANDLE).emit("pickMode", 1);
      await host.settle();
      assert.equal(host.appleMotion.mode, "off");
      assert.equal(props(host)["mode-index"], 0);
      assert.equal(host.osd.at(-1), `Apple motion smoothing unavailable: ${reason.message}`);
    } finally {
      await stop();
    }
  });

test("HDR (`format`, Apple: HDR only) waits with the player's reason; the mode is kept and not greyed out", async () => {
  const host = new TestHost();
  const hdr = { code: "format", message: "HDR video is not smoothed" };
  host.appleMotion.double = hdr;
  host.appleMotion.display = hdr;
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(host.appleMotion.mode, "double", "kept: the next video may play");
    assert.equal(props(host).status, "Waiting");
    assert.equal(props(host).tone, 2);
    assert.equal(props(host).detail, hdr.message);
    assert.equal(host.osd.at(-1), `Apple motion smoothing: double frame rate (waiting: ${hdr.message})`);
    assert.equal(host.command(modeCommandId("double")).state.enabled, true);
  } finally {
    await stop();
  }
});

test("falling behind: `overload` straight away (no faster setting), then `size` for that size learned for the run; both wait and grey nothing", async () => {
  const host = new TestHost();
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(props(host).tone, 1, "running");
    // The Mac fell behind on this video: no faster step, straight to `overload`.
    const overload = { code: "overload", message: "the Mac's frame interpolation could not keep up with this video" };
    host.appleMotion.double = overload;
    host.motionChanged();
    await host.settle();
    assert.equal(props(host).status, "Waiting");
    assert.equal(props(host).detail, overload.message);
    // The next video of that size or larger: `size`, learned for this run.
    const size = { code: "size", message: "this video is too large for this Mac: 3840x2160 fell behind before" };
    host.appleMotion.double = size;
    host.motionChanged();
    await host.settle();
    assert.equal(props(host).status, "Waiting");
    assert.equal(props(host).detail, size.message);
    assert.equal(host.appleMotion.mode, "double", "the request stays: a smaller video is smoothed");
    assert.equal(host.command(modeCommandId("double")).state.enabled, true, "per-video reasons grey nothing");
    // A smaller video fits again.
    host.appleMotion.double = null;
    host.motionChanged();
    await host.settle();
    assert.equal(props(host).tone, 1);
    assert.equal(props(host).detail, "");
  } finally {
    await stop();
  }
});

test("`other-engine` while AMD's converter is on for another plugin: the chosen mode waits with the player's reason and is not greyed out", async () => {
  const host = new TestHost();
  host.motion.mode = "double"; // another plugin turned AMD's on: it holds the converter
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(host.appleMotion.mode, "double", "kept: it applies once AMD's is off");
    assert.equal(props(host).status, "Waiting");
    assert.equal(props(host).tone, 2);
    assert.match(String(props(host).detail), /AMD/i, "the message names the holder");
    assert.deepEqual(
      modeStates(host).map(([enabled]) => enabled),
      [true, true, true],
      "a reason that can pass greys nothing",
    );
    assert.match(String(host.osd.at(-1)), /^Apple motion smoothing: double frame rate \(waiting: /);
  } finally {
    await stop();
  }
});
