import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { DEFAULT_SETTINGS, isSettings, MODES, WINDOW_TITLE } from "../main.ts";

const directory = new URL("..", import.meta.url);
const ITEM = "amdmotion.window";
const HANDLE = "motion";

async function start(host = new TestHost(), dataDirectory?: string) {
  return startPlugin(activate, { directory, host, ...(dataDirectory ? { dataDirectory } : {}) });
}
const props = (host: TestHost) => host.window(HANDLE).props as Record<string, unknown>;

test("one Video menu item opens the window; off by default and nothing asked at start", async () => {
  const host = new TestHost();
  const { stop } = await start(host);
  try {
    const item = host.command(ITEM);
    assert.deepEqual(item.declaration.path, ["@video", WINDOW_TITLE]);
    assert.equal(host.motion.mode, "off");
    assert.ok(!host.calls.some((c) => c.method === "video.motion.set"), "nothing asked while off");
    await item.run();
    await host.settle();
    assert.equal(host.window(HANDLE).visible, true);
    assert.deepEqual(props(host).modes, MODES.map((m) => m.title));
    assert.equal(props(host)["mode-index"], 0);
    assert.equal(props(host).status, "Off");
    assert.ok(host.listening.has("video.motion.changed"), "followed while open");
    assert.deepEqual(
      host.calls.filter((c) => c.method === "video.motion.state").map((c) => c.params),
      [{ engine: "amd" }],
    );
  } finally {
    await stop();
  }
});

test("a mode is chosen in the window, runs, is saved and asked for again at the next start", async () => {
  const data = await mkdtemp(join(tmpdir(), "amdmotion-"));
  const host = new TestHost();
  const first = await start(host, data);
  try {
    await host.command(ITEM).run();
    host.window(HANDLE).emit("pickMode", 2);
    await host.settle();
    assert.equal(host.motion.mode, "display");
    assert.equal(props(host).status, "On: 24 → 48 fps on AMD Radeon 780M Graphics");
    assert.equal(props(host).tone, 1);
    assert.equal(host.osd.at(-1), "AMD motion smoothing: match display");
  } finally {
    await first.stop();
  }
  assert.deepEqual(JSON.parse(await readFile(join(data, "settings.json"), "utf8")), { mode: "display" });
  const again = new TestHost();
  const second = await start(again, data);
  try {
    assert.equal(again.motion.mode, "display", "asked for again at start");
    assert.ok(!again.listening.has("video.motion.changed"), "no listener while the window is closed");
  } finally {
    await second.stop();
  }
});

test("without an AMD GPU the window says so and the mode stays off", async () => {
  const host = new TestHost();
  const reason = { code: "no-gpu", message: "no AMD GPU: motion smoothing uses AMD's frame-rate converter (AMF), which needs an AMD Radeon GPU" };
  host.motion.double = reason;
  host.motion.display = reason;
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    await host.settle();
    assert.equal(props(host).status, "Not available on this computer");
    assert.equal(props(host).detail, reason.message);
    assert.equal(props(host).tone, 3);
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(host.motion.mode, "off");
    assert.equal(props(host)["mode-index"], 0, "the choice goes back to Off");
    assert.match(String(host.osd.at(-1)), /^AMD motion smoothing unavailable: no AMD GPU/);
  } finally {
    await stop();
  }
});

test("a reason that can pass keeps the mode and shows it; the player's changes follow while open", async () => {
  const host = new TestHost();
  host.motion.double = { code: "size", message: "this video is too large for motion smoothing with GPU rendering: 3840×2160 at 30 fps, and it keeps up to 4K at 24 fps" };
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    host.window(HANDLE).emit("pickMode", 1);
    await host.settle();
    assert.equal(host.motion.mode, "double");
    assert.equal(props(host).status, "Waiting");
    assert.match(String(props(host).detail), /too large/);
    // The next video fits: the player says so.
    host.motion.double = null;
    host.motionChanged();
    await host.settle();
    assert.equal(props(host).tone, 1);
    // The GPU fell behind: the faster search, then off for this video.
    host.motion.performance = true;
    host.motionChanged();
    await host.settle();
    assert.match(String(props(host).detail), /faster motion search/);
    // Closed: no listener any more.
    host.window(HANDLE).emit("closeWindow");
    await host.settle();
    assert.ok(!host.listening.has("video.motion.changed"));
  } finally {
    await stop();
  }
});

test("settings: only the three modes", () => {
  assert.equal(isSettings(DEFAULT_SETTINGS), true);
  assert.equal(isSettings({ mode: "display" }), true);
  assert.equal(isSettings({ mode: "triple" }), false);
  assert.equal(isSettings(null), false);
});
