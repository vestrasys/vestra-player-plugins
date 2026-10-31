import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { hasVideo, TITLE } from "../main.ts";

const directory = new URL("..", import.meta.url);
type Locale = "en" | "zh-Hans";
const LOCALES: Locale[] = ["en", "zh-Hans"];

/** A host on Windows (the TestHost plays macOS by default) with a 1080p video playing once opened. */
function windows() {
  const host = new TestHost();
  host.systemInfo = { ...host.systemInfo, os: "windows", name: "Windows" };
  withVideo(host);
  return host;
}

function withVideo(host: TestHost) {
  host.stats = {
    ...host.stats,
    video: { codec: "h264", width: 1920, height: 1080, fps: 24 },
  } as typeof host.stats;
}

async function start(host = windows(), locale: Locale = "en", dataDirectory?: string) {
  const started = await startPlugin(activate, { directory, host, locale, ...(dataDirectory ? { dataDirectory } : {}) });
  return { ...started, host, item: host.command("upscaling") };
}

/** A data directory where the user turned upscaling on in an earlier run. */
async function savedOn() {
  const data = await mkdtemp(join(tmpdir(), "vestraupscale-"));
  const { host, item, stop } = await start(windows(), "en", data);
  await item.run();
  await host.settle();
  await stop();
  return data;
}

const sets = (host: TestHost) => host.sent("video.upscaling.set").map((call) => call.enabled);
const states = (host: TestHost) => host.sent("video.upscaling.state").length;
const saved = async (data: string) => JSON.parse(await readFile(join(data, "upscaling.json"), "utf8"));

test("Windows: activation asks nothing, no GPU check; the item sits next to GPU Rendering", async () => {
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
    assert.equal(states(host), 0);
  } finally {
    await stop();
  }
});

for (const os of ["macos", "linux"] as const) {
  test(`${os}: greyed out from the start with the platform reason, without a click`, async () => {
    const host = new TestHost();
    host.systemInfo = { ...host.systemInfo, os };
    host.upscaling.reason = { code: "platform", message: "the player has no video upscaler on this system" };
    const { item, stop } = await start(host);
    try {
      await host.settle();
      assert.equal(states(host), 1); // the player answers `platform` without touching a GPU
      assert.deepEqual(sets(host), []);
      assert.equal(item.state.enabled, false);
      assert.equal(item.state.checked, false);
      assert.match(item.display.reason ?? "", /not available on this system\. It needs Windows and an NVIDIA RTX GPU/);
    } finally {
      await stop();
    }
  });
}

test("macOS with a saved 'on' (copied settings): still greyed, nothing re-applied", async () => {
  const data = await savedOn();
  const host = new TestHost();
  host.upscaling.reason = { code: "platform", message: "no upscaler here" };
  withVideo(host);
  const { item, stop } = await start(host, "en", data);
  try {
    host.openElsewhere("/media/clip.mp4");
    await host.settle();
    assert.deepEqual(sets(host), []);
    assert.equal(item.state.enabled, false);
    assert.equal(item.state.checked, false);
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
    assert.equal(states(host), 0); // set(true) does the check itself
    assert.equal(host.upscaling.enabled, true);
    assert.equal(item.state.checked, true);
    assert.match(host.osd.at(-1)!, /^AI Upscaling: On\. Also turn on Super Resolution in the NVIDIA app/);
    await item.run();
    await host.settle();
    assert.deepEqual(sets(host), [true, false]);
    assert.equal(host.upscaling.enabled, false);
    assert.equal(item.state.checked, false);
    assert.equal(host.osd.at(-1), "AI Upscaling: Off");
    // Second time on: the short notice, the note is not repeated.
    await item.run();
    await host.settle();
    assert.equal(host.osd.at(-1), "AI Upscaling: On");
    assert.equal(host.osd.filter((t) => /NVIDIA app/.test(t)).length, 1);
  } finally {
    await stop();
  }
});

/** A long message of the player's, to test the OSD's 200-character limit. */
const LONG = `the player says ${"a long explanation ".repeat(16)}end`;

interface Case {
  name: string;
  setup(host: TestHost): void;
  /** The menu item's reason (English). */
  menu: RegExp;
  /** The OSD after the refused pick (English); defaults to `menu`. */
  osd?: RegExp;
  /** Text that must not appear (wrong advice). */
  not?: RegExp;
}

const reason = (code: string, message: string) => (host: TestHost) => {
  host.upscaling.reason = { code, message };
};

/** Software rendering now, with `rendering` as the upscaling reason. */
const software = (host: TestHost, message = "upscaling needs GPU rendering, and the player renders in software") => {
  host.videoRender.gpu = false;
  host.upscaling.reason = { code: "rendering", message };
};

const CASES: Case[] = [
  { name: "no-gpu", setup: reason("no-gpu", "no NVIDIA GPU"), menu: /not available on this computer\. It needs an NVIDIA RTX GPU/ },
  {
    name: "driver",
    setup: reason("driver", "the NVIDIA driver 512.15 on RTX 3060 is too old for RTX Video Super Resolution, which needs 530 or newer; update the driver"),
    menu: /update it to version 530 or newer\. \(.*530 or newer/,
    osd: /^The NVIDIA driver is too old for AI upscaling: update it to version 530 or newer\.$/,
    not: /531/,
  },
  {
    name: "gpu-unsupported",
    setup: reason("gpu-unsupported", "GTX 1060 does not offer it"),
    menu: /not available on this computer: GTX 1060 does not offer it/,
  },
  {
    name: "gpu-unsupported, long message",
    setup: reason("gpu-unsupported", LONG),
    menu: /not available on this computer: the player says a long/,
    osd: /not available on this computer: the player says a long.*…$/,
  },
  {
    name: "adapter",
    setup: reason("adapter", "GPU rendering runs on AMD Radeon 780M; RTX 4070 can upscale"),
    menu: /Windows Settings ▸ System ▸ Display ▸ Graphics.*780M/,
    osd: /^The player runs on a GPU that cannot upscale: in Windows Settings ▸ System ▸ Display ▸ Graphics.*restart it\.$/,
  },
  {
    name: "rendering: software chosen",
    setup: (host) => {
      software(host);
      host.rendering.preference = "software";
      host.rendering.startedWith = "software";
      host.rendering.reason = { code: "preference", message: "chosen in the player's settings" };
    },
    menu: /^AI upscaling needs GPU rendering: turn on Video ▸ GPU Rendering \(Experimental\), then restart the player\./,
  },
  {
    name: "rendering: GPU not allowed here (denylist)",
    setup: (host) => {
      software(host);
      host.rendering.startedWith = "software";
      host.rendering.reason = { code: "denylist", message: "the driver is on the denylist" };
      host.rendering.gpu = { available: false, reason: { code: "denylist", message: "the driver 31.0.14005 is on the denylist" } };
    },
    menu: /cannot be turned on here: the driver 31\.0\.14005 is on the denylist/,
    not: /turn on Video ▸ GPU Rendering/,
  },
  {
    name: "rendering: GPU chosen, restart pending",
    setup: (host) => {
      software(host);
      host.rendering.preference = "gpu";
      host.rendering.startedWith = "software";
      host.rendering.reason = { code: "preference", message: "chosen in the player's settings" };
    },
    menu: /^GPU rendering is on from the next start: restart the player to use AI upscaling\./,
    not: /turn on Video ▸ GPU Rendering/,
  },
  {
    name: "rendering: fell back during this run",
    setup: (host) => {
      software(host);
      host.rendering.reason = { code: "window-fallback", message: "a window could not show GPU frames" };
    },
    menu: /^GPU rendering stopped during this run: restart the player to use AI upscaling\./,
    not: /turn on Video ▸ GPU Rendering/,
  },
  {
    name: "a newer player's code",
    setup: reason("some-new-code", "a newer player's reason"),
    menu: /not available on this computer: a newer player's reason/,
  },
];

for (const c of CASES) {
  test(`unavailable (${c.name}): set(true) is refused, the item greys out with the reason`, async () => {
    const host = windows();
    c.setup(host);
    const { item, stop } = await start(host);
    try {
      assert.equal(item.state.enabled, true); // unknown until first picked
      await item.run();
      await host.settle();
      assert.deepEqual(sets(host), [true]); // refused with `unsupported`
      assert.equal(host.upscaling.enabled, false);
      assert.equal(item.state.enabled, false);
      assert.equal(item.state.checked, false);
      assert.match(item.display.reason ?? "", c.menu);
      assert.match(host.osd.at(-1)!, c.osd ?? c.menu);
      if (c.not) {
        assert.doesNotMatch(item.display.reason ?? "", c.not);
        assert.doesNotMatch(host.osd.at(-1)!, c.not);
      }
    } finally {
      await stop();
    }
  });
}

test("every OSD text fits the player's 200 characters, in English and Simplified Chinese", async () => {
  const extra: Case[] = [
    { name: "platform", setup: reason("platform", LONG), menu: /./ },
    { name: "decoding", setup: reason("decoding", LONG), menu: /./ },
    {
      name: "rendering: starting",
      setup: (host) => {
        software(host, LONG);
        host.rendering.reason = { code: "pending", message: "GPU rendering is starting" };
        host.upscaling.renderingStarting = true;
      },
      menu: /./,
    },
    {
      name: "rendering: denylist, long",
      setup: (host) => {
        software(host, LONG);
        host.rendering.startedWith = "software";
        host.rendering.gpu = { available: false, reason: { code: "denylist", message: LONG } };
      },
      menu: /./,
    },
    { name: "works", setup: () => {}, menu: /./ },
  ];
  for (const locale of LOCALES) {
    for (const c of [...CASES, ...extra]) {
      const host = windows();
      c.setup(host);
      const { item, stop } = await start(host, locale);
      try {
        await item.run();
        await host.settle();
        // A text over the limit is refused by the player and missing here.
        assert.equal(host.osd.length, 1, `${locale} ${c.name}: one OSD message`);
        assert.ok([...host.osd[0]!].length <= 200, `${locale} ${c.name}: ${host.osd[0]}`);
        if (item.state.checked) {
          await item.run(); // the "off" message too
          await host.settle();
          assert.equal(host.osd.length, 2, `${locale} ${c.name}: off`);
        }
      } finally {
        await stop();
      }
    }
  }
});

test("decoding: the request is kept and the item stays usable", async () => {
  const host = windows();
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
    assert.equal(states(host), 1);
    assert.equal(item.state.enabled, true);
    assert.equal(item.state.checked, true);
  } finally {
    await stop();
  }
});

test("GPU rendering still starting: accepted, kept, and the item is never greyed for it", async () => {
  const host = windows();
  software(host, "upscaling needs GPU rendering, which is starting");
  host.rendering.reason = { code: "pending", message: "GPU rendering is starting" };
  host.upscaling.renderingStarting = true;
  const { item, stop } = await start(host);
  try {
    await item.run();
    await host.settle();
    assert.equal(host.upscaling.enabled, true);
    assert.equal(item.state.checked, true);
    assert.match(host.osd.at(-1)!, /^AI Upscaling: On\. It starts when GPU rendering is ready\.$/);
    await item.run(); // off again
    await host.settle();
    host.openElsewhere("/media/next.mp4"); // re-reads the state: still `rendering` while starting
    await host.settle();
    assert.equal(item.state.checked, false);
    assert.equal(item.state.enabled, true);
    assert.equal(item.display.reason, null);
  } finally {
    await stop();
  }
});

test("refresh follows the source id: the same file opened again is a new source", async () => {
  const host = windows();
  host.upscaling.reason = { code: "decoding", message: "copy-back" };
  const { item, stop } = await start(host);
  try {
    await item.run();
    await host.settle();
    host.openElsewhere("/media/same.mp4");
    await host.settle();
    host.openElsewhere("/media/same.mp4");
    await host.settle();
    assert.equal(states(host), 2);
  } finally {
    await stop();
  }
});

test("the choice persists: re-applied on the first video after a restart, not at activation", async () => {
  const data = await savedOn();
  assert.deepEqual(await saved(data), { on: true, noted: true, refused: null });
  const host = windows();
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

test("settings of 0.1.0 (without `refused`) are read, not discarded", async () => {
  const data = await mkdtemp(join(tmpdir(), "vestraupscale-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(data, "upscaling.json"), JSON.stringify({ on: true, noted: true }));
  const { item, stop } = await start(windows(), "en", data);
  try {
    assert.equal(item.state.checked, true);
  } finally {
    await stop();
  }
});

test("audio only: the saved choice waits for a video and does not wake the GPU", async () => {
  const data = await savedOn();
  const host = windows();
  host.stats = { ...host.stats, video: null };
  const { stop } = await start(host, "en", data);
  try {
    host.openElsewhere("/media/song.flac");
    await host.settle(1700); // the second look after 1.5 s
    assert.deepEqual(sets(host), []);
    assert.equal(host.upscaling.checked, false);
    // Cover art is not a video either.
    host.stats = { ...host.stats, video: { codec: "mjpeg", width: 600, height: 600, fps: null } } as typeof host.stats;
    host.openElsewhere("/media/song-with-cover.mp3");
    await host.settle(1700);
    assert.deepEqual(sets(host), []);
    withVideo(host);
    host.openElsewhere("/media/clip.mp4");
    await host.settle();
    assert.deepEqual(sets(host), [true]);
  } finally {
    await stop();
  }
});

test("hasVideo tells moving video from audio and cover art", () => {
  assert.equal(hasVideo(null), false);
  const v = (codec: string, fps: number | null) => ({ codec, width: 1920, height: 1080, fps }) as Parameters<typeof hasVideo>[0];
  assert.equal(hasVideo(v("h264", 24)), true);
  assert.equal(hasVideo(v("mjpeg", 30)), true);
  assert.equal(hasVideo(v("mjpeg", null)), false);
  assert.equal(hasVideo(v("png", null)), false);
});

test("the choice is applied at once when the plugin starts while a video already plays", async () => {
  const data = await savedOn();
  const host = windows();
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

test("a saved choice refused at a start: kept, told once per reason, and the item can still turn it off", async () => {
  const data = await savedOn();
  const blockedHost = () => {
    const host = windows();
    software(host);
    host.rendering.preference = "software";
    host.rendering.startedWith = "software";
    host.rendering.reason = { code: "preference", message: "chosen in the player's settings" };
    return host;
  };
  {
    const host = blockedHost();
    const { item, stop } = await start(host, "en", data);
    host.openElsewhere("/media/clip.mp4");
    await host.settle();
    assert.deepEqual(sets(host), [true]);
    assert.equal(host.upscaling.enabled, false);
    assert.match(host.osd.at(-1)!, /^AI upscaling needs GPU rendering: turn on/);
    assert.equal(item.state.checked, true);
    assert.equal(item.state.enabled, true);
    await stop();
    assert.equal((await saved(data)).refused, "rendering");
  }
  {
    // The next start, same reason: not told again.
    const host = blockedHost();
    const { item, stop } = await start(host, "en", data);
    host.openElsewhere("/media/clip.mp4");
    await host.settle();
    assert.deepEqual(sets(host), [true]);
    assert.equal(host.osd.length, 0);
    await item.run(); // turn it off for good
    await host.settle();
    assert.deepEqual(sets(host), [true, false]);
    assert.equal(item.state.checked, false);
    assert.equal(item.state.enabled, false); // now greyed with the reason
    assert.match(item.display.reason ?? "", /^AI upscaling needs GPU rendering/);
    await stop();
    assert.deepEqual(await saved(data), { on: false, noted: true, refused: null });
  }
});

test("turning off before any check never starts it", async () => {
  const data = await savedOn();
  const host = windows();
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

test("stop: the item goes, the choice is flushed, and nothing runs afterwards", async () => {
  const data = await mkdtemp(join(tmpdir(), "vestraupscale-"));
  {
    const { host, item, stop } = await start(windows(), "en", data);
    await item.run();
    await stop(); // a pending save is written by the stop
    assert.equal(host.commands.has("upscaling"), false);
    assert.equal((await saved(data)).on, true);
  }
  // Stopped while waiting for the video track of an audio file: no late set(true).
  const host = windows();
  host.stats = { ...host.stats, video: null };
  const { stop } = await start(host, "en", data);
  host.openElsewhere("/media/song.flac");
  await host.settle();
  await stop();
  withVideo(host);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.deepEqual(sets(host), []);
});

test("Simplified Chinese: menu title and reasons are translated", async () => {
  const host = windows();
  host.upscaling.reason = { code: "adapter", message: "runs on AMD Radeon 780M" };
  const { item, stop } = await start(host, "zh-Hans");
  try {
    assert.deepEqual(item.display.path, ["视频", "AI 超分辨率（RTX 视频超分辨率）"]);
    await item.run();
    await host.settle();
    assert.match(item.display.reason ?? "", /Windows 设置 ▸ 系统 ▸ 屏幕 ▸ 显示卡.*780M/);
    host.upscaling.reason = { code: "no-gpu", message: "no NVIDIA GPU" };
  } finally {
    await stop();
  }
  const other = new TestHost();
  other.upscaling.reason = { code: "platform", message: "no upscaler" };
  const started = await start(other, "zh-Hans");
  try {
    assert.match(started.item.display.reason ?? "", /^本机无法使用 AI 超分辨率/);
  } finally {
    await started.stop();
  }
});
