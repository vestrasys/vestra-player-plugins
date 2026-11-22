import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { DEFAULT_SETTINGS, isSettings, MODES, WINDOW_TITLE } from "../main.ts";

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

test("settings: only the three modes", () => {
  assert.equal(isSettings(DEFAULT_SETTINGS), true);
  assert.equal(isSettings({ mode: "double" }), true);
  assert.equal(isSettings({ mode: "triple" }), false);
  assert.equal(isSettings(null), false);
});
