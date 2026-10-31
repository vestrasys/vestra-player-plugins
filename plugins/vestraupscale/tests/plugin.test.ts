import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { TITLE } from "../main.ts";

const directory = new URL("..", import.meta.url);
type Locale = "en" | "zh-Hans";

async function start(host = new TestHost(), locale: Locale = "en", dataDirectory?: string) {
  const started = await startPlugin(activate, { directory, host, locale, ...(dataDirectory ? { dataDirectory } : {}) });
  return { ...started, host, item: host.command("upscaling") };
}

const sets = (host: TestHost) => host.sent("video.upscaling.set").map((call) => call.enabled);
const states = (host: TestHost) => host.sent("video.upscaling.state").length;

test("activation asks nothing: no GPU check, the item is enabled and unchecked in the Video menu", async () => {
  const { host, item, stop } = await start();
  try {
    assert.equal(host.upscaling.checked, false);
    assert.equal(states(host), 0);
    assert.deepEqual(sets(host), []);
    assert.deepEqual(item.declaration.path, ["@video", TITLE]);
    assert.equal(item.declaration.order, 461);
    assert.equal(item.declaration.group, "video-rendering");
    assert.equal(item.state.enabled, true);
    assert.equal(item.state.checked, false);
    // A video plays: still no check while the user never turned it on.
    host.openElsewhere("/media/clip.mp4");
    await host.settle();
    assert.equal(host.upscaling.checked, false);
  } finally {
    await stop();
  }
});

test("toggle on and off: set(true) on the first pick, the NVIDIA note once, set(false) after", async () => {
  const { host, item, stop } = await start();
  try {
    await item.run();
    await host.settle();
    assert.deepEqual(sets(host), [true]);
    assert.equal(host.upscaling.enabled, true);
    assert.equal(item.state.checked, true);
    assert.match(host.osd.at(-1)!, /Super Resolution in the NVIDIA app/);
    await item.run();
    await host.settle();
    assert.deepEqual(sets(host), [true, false]);
    assert.equal(host.upscaling.enabled, false);
    assert.equal(item.state.checked, false);
    assert.equal(host.osd.at(-1), "AI upscaling off");
    // Second time on: the short notice, the note is not repeated.
    await item.run();
    await host.settle();
    assert.equal(host.osd.at(-1), "AI upscaling on");
    assert.equal(host.osd.filter((t) => /NVIDIA app/.test(t)).length, 1);
  } finally {
    await stop();
  }
});

const blocked: { code: string; message: string; expect: RegExp; osd?: RegExp }[] = [
  { code: "platform", message: "no video upscaler on this system", expect: /not available here\. It needs Windows and an NVIDIA RTX GPU/ },
  { code: "no-gpu", message: "no NVIDIA GPU", expect: /not available here\. It needs Windows and an NVIDIA RTX GPU/ },
  { code: "driver", message: "NVIDIA driver 512.0 is older than 531.18", expect: /driver is too old.*531\.18/ },
  { code: "gpu-unsupported", message: "GTX 1060 does not offer it", expect: /not available here: GTX 1060 does not offer it/ },
  {
    code: "rendering",
    message: "the player renders in software; turn on Video ▸ GPU Rendering (Experimental) and restart the player",
    expect: /^Needs GPU rendering: turn on Video ▸ GPU Rendering \(Experimental\), then restart the player\./,
  },
  {
    code: "adapter",
    message: "GPU rendering runs on AMD Radeon 780M; RTX 4070 can upscale",
    expect: /Windows Settings ▸ System ▸ Display ▸ Graphics.*780M/,
    osd: /^The player runs on a GPU that cannot upscale: in Windows Settings ▸ System ▸ Display ▸ Graphics.*restart it.$/,
  },
  { code: "some-new-code", message: "a newer player's reason", expect: /not available here: a newer player's reason/ },
];

for (const { code, message, expect, osd } of blocked) {
  test(`unavailable (${code}): set(true) is refused, the item greys out with the reason`, async () => {
    const host = new TestHost();
    host.upscaling.reason = { code, message };
    const { item, stop } = await start(host);
    try {
      assert.equal(item.state.enabled, true); // unknown until first picked
      await item.run();
      await host.settle();
      assert.deepEqual(sets(host), [true]); // refused with `unsupported`
      assert.equal(host.upscaling.enabled, false);
      assert.equal(item.state.enabled, false);
      assert.equal(item.state.checked, false);
      assert.match(item.display.reason ?? "", expect);
      assert.match(host.osd.at(-1)!, osd ?? expect);
    } finally {
      await stop();
    }
  });
}

test("decoding: the request is kept and the item stays usable", async () => {
  const host = new TestHost();
  host.upscaling.reason = { code: "decoding", message: "hwdec is copy-back (d3d11va-copy)" };
  const { item, stop } = await start(host);
  try {
    await item.run();
    await host.settle();
    assert.deepEqual(sets(host), [true]);
    assert.equal(host.upscaling.enabled, true);
    assert.equal(item.state.enabled, true);
    assert.equal(item.state.checked, true);
    assert.match(host.osd.at(-1)!, /starts when no other video filter/);
    // The filter is gone: the next video reads the state again (cached check) and nothing is greyed.
    host.upscaling.reason = null;
    host.openElsewhere("/media/next.mp4");
    await host.settle();
    assert.equal(item.state.enabled, true);
    assert.equal(item.state.checked, true);
  } finally {
    await stop();
  }
});

test("rendering while GPU rendering starts: accepted and kept", async () => {
  const host = new TestHost();
  host.upscaling.reason = { code: "rendering", message: "GPU rendering is starting" };
  host.upscaling.renderingStarting = true;
  const { item, stop } = await start(host);
  try {
    await item.run();
    await host.settle();
    assert.equal(host.upscaling.enabled, true);
    assert.equal(item.state.checked, true);
    assert.match(host.osd.at(-1)!, /starts when GPU rendering is ready/);
  } finally {
    await stop();
  }
});

test("the choice persists: re-applied on the first playback after a restart, not at activation", async () => {
  const data = await mkdtemp(join(tmpdir(), "vestraupscale-"));
  {
    const { host, item, stop } = await start(new TestHost(), "en", data);
    await item.run();
    await host.settle();
    await stop();
    const saved = JSON.parse(await readFile(join(data, "upscaling.json"), "utf8"));
    assert.deepEqual(saved, { on: true, noted: true });
  }
  const host = new TestHost();
  const { item, stop } = await start(host, "en", data);
  try {
    assert.equal(item.state.checked, true); // the saved choice
    assert.equal(host.upscaling.checked, false); // nothing asked at activation
    assert.deepEqual(sets(host), []);
    host.openElsewhere("/media/clip.mp4");
    await host.settle();
    assert.deepEqual(sets(host), [true]);
    assert.equal(host.upscaling.enabled, true);
    assert.equal(host.osd.length, 0); // quiet: the note was shown in the earlier run
    // A second video does not apply it again.
    host.openElsewhere("/media/other.mp4");
    await host.settle();
    assert.deepEqual(sets(host), [true]);
  } finally {
    await stop();
  }
});

test("a saved choice applies at once when the plugin starts while a video already plays", async () => {
  const data = await mkdtemp(join(tmpdir(), "vestraupscale-"));
  {
    const { host, item, stop } = await start(new TestHost(), "en", data);
    await item.run();
    await host.settle();
    await stop();
  }
  const host = new TestHost();
  host.setSource({ phase: "ready", source: "/media/playing.mp4" });
  const { stop } = await start(host, "en", data);
  try {
    await host.settle();
    assert.deepEqual(sets(host), [true]);
    assert.equal(host.upscaling.enabled, true);
  } finally {
    await stop();
  }
});

test("a saved choice refused after a restart: kept, told once, and the item can still turn it off", async () => {
  const data = await mkdtemp(join(tmpdir(), "vestraupscale-"));
  {
    const { host, item, stop } = await start(new TestHost(), "en", data);
    await item.run();
    await host.settle();
    await stop();
  }
  const host = new TestHost();
  host.upscaling.reason = {
    code: "rendering",
    message: "the player renders in software; turn on Video ▸ GPU Rendering (Experimental) and restart the player",
  };
  const { item, stop } = await start(host, "en", data);
  try {
    host.openElsewhere("/media/clip.mp4");
    await host.settle();
    assert.deepEqual(sets(host), [true]);
    assert.equal(host.upscaling.enabled, false);
    assert.match(host.osd.at(-1)!, /^Needs GPU rendering/);
    assert.equal(item.state.checked, true);
    assert.equal(item.state.enabled, true);
    await item.run(); // turn it off for good
    await host.settle();
    assert.deepEqual(sets(host), [true, false]);
    assert.equal(item.state.checked, false);
    assert.equal(item.state.enabled, false); // now greyed with the reason
    assert.match(item.display.reason ?? "", /^Needs GPU rendering/);
    await stop();
    const saved = JSON.parse(await readFile(join(data, "upscaling.json"), "utf8"));
    assert.equal(saved.on, false);
  } finally {
    await stop();
  }
});

test("turning off before any check never starts it", async () => {
  const data = await mkdtemp(join(tmpdir(), "vestraupscale-"));
  {
    const { host, item, stop } = await start(new TestHost(), "en", data);
    await item.run();
    await host.settle();
    await stop();
  }
  const host = new TestHost();
  const { item, stop } = await start(host, "en", data);
  try {
    await item.run(); // the saved "on" is turned off before any video played
    await host.settle();
    assert.deepEqual(sets(host), [false]);
    assert.equal(host.upscaling.checked, false);
    assert.equal(item.state.checked, false);
    assert.equal(item.state.enabled, true); // `unchecked` greys nothing
    host.openElsewhere("/media/clip.mp4");
    await host.settle();
    assert.deepEqual(sets(host), [false]); // nothing re-applied
  } finally {
    await stop();
  }
});

test("Simplified Chinese: menu title and reasons are translated", async () => {
  const host = new TestHost();
  host.upscaling.reason = { code: "adapter", message: "runs on AMD Radeon 780M" };
  const { item, stop } = await start(host, "zh-Hans");
  try {
    assert.deepEqual(item.display.path, ["视频", "AI 超分辨率（RTX 视频超分辨率）"]);
    await item.run();
    await host.settle();
    assert.match(item.display.reason ?? "", /Windows 设置 ▸ 系统 ▸ 屏幕 ▸ 显示卡.*780M/);
  } finally {
    await stop();
  }
});
