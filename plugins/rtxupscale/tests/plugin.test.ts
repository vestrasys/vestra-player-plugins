import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { hasVideo, OSD_BUDGET, targetSize, TITLE, WINDOW_TITLE } from "../main.ts";

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
    video: { codec: "H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10", decoder: "h264", width: 1920, height: 1080, fps: 24 },
  } as typeof host.stats;
}

async function start(host = windows(), locale: Locale = "en", dataDirectory?: string) {
  const started = await startPlugin(activate, { directory, host, locale, ...(dataDirectory ? { dataDirectory } : {}) });
  return { ...started, host, item: host.command("upscaling") };
}

/** A data directory where the user turned upscaling on in an earlier run. */
async function savedOn() {
  const data = await mkdtemp(join(tmpdir(), "rtxupscale-"));
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
    assert.match(host.osd.at(-1)!, /^AI Upscaling: On — also turn on Super Resolution in the NVIDIA app$/);
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

/** A long message of the player's: the OSD must not carry it (single line, short budget). */
const LONG = `the player says ${"a long explanation ".repeat(16)}end`;

interface Case {
  name: string;
  setup(host: TestHost): void;
  /** The menu item's reason (English). */
  menu: RegExp;
  /** The OSD after the refused pick (English): one short line. */
  osd: RegExp;
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
  { name: "no-gpu", setup: reason("no-gpu", "no NVIDIA GPU"), menu: /not available on this computer\. It needs an NVIDIA RTX GPU/, osd: /^AI upscaling needs an NVIDIA RTX GPU$/ },
  {
    name: "driver",
    setup: reason("driver", "the NVIDIA driver 512.15 on RTX 3060 is too old for RTX Video Super Resolution, which needs 530 or newer; update the driver"),
    menu: /update it to version 530 or newer\. \(.*530 or newer/,
    osd: /^AI upscaling needs NVIDIA driver 530 or newer$/,
    not: /531/,
  },
  {
    name: "gpu-unsupported",
    setup: reason("gpu-unsupported", "GTX 1060 does not offer it"),
    menu: /not available on this computer: GTX 1060 does not offer it/,
    osd: /^AI upscaling is not available on this computer$/,
  },
  {
    name: "gpu-unsupported, long message",
    setup: reason("gpu-unsupported", LONG),
    menu: /not available on this computer: the player says a long/,
    osd: /^AI upscaling is not available on this computer$/,
  },
  {
    name: "adapter",
    setup: reason("adapter", "GPU rendering runs on AMD Radeon 780M; RTX 4070 can upscale"),
    menu: /Windows Settings ▸ System ▸ Display ▸ Graphics.*780M/,
    osd: /^AI upscaling: choose the NVIDIA GPU in Windows graphics settings$/,
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
    osd: /^AI upscaling: turn on Video ▸ GPU Rendering, then restart$/,
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
    osd: /^AI upscaling needs GPU rendering, which is unavailable here$/,
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
    osd: /^Restart the player to use AI upscaling$/,
    not: /turn on Video ▸ GPU Rendering/,
  },
  {
    name: "rendering: fell back during this run",
    setup: (host) => {
      software(host);
      host.rendering.reason = { code: "window-fallback", message: "a window could not show GPU frames" };
    },
    menu: /^GPU rendering stopped during this run: restart the player to use AI upscaling\./,
    osd: /^Restart the player to use AI upscaling$/,
    not: /turn on Video ▸ GPU Rendering/,
  },
  {
    name: "a newer player's code",
    setup: reason("some-new-code", "a newer player's reason"),
    menu: /not available on this computer: a newer player's reason/,
    osd: /^AI upscaling is not available on this computer$/,
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
      assert.match(host.osd.at(-1)!, c.osd);
      if (c.not) {
        assert.doesNotMatch(item.display.reason ?? "", c.not);
        assert.doesNotMatch(host.osd.at(-1)!, c.not);
      }
    } finally {
      await stop();
    }
  });
}

test("every OSD text fits one line: at most 80 characters in English, 40 in Simplified Chinese", async () => {
  const extra: Case[] = [
    { name: "platform", setup: reason("platform", LONG), menu: /./, osd: /./ },
    { name: "decoding (older player, no cause)", setup: reason("decoding", LONG), menu: /./, osd: /./ },
    ...(["copy-back", "hwdec-off", "software", "other-hwdec", "some-new-cause"] as const).map((cause) => ({
      name: `decoding: ${cause}`,
      setup: (host: TestHost) => {
        host.upscalingDecoding(cause, [{ id: "vestra.video", name: `Picture Adjustments ${"long ".repeat(20)}` }]);
      },
      menu: /./,
      osd: /./,
    })),
    {
      name: "rendering: starting",
      setup: (host) => {
        software(host, LONG);
        host.rendering.reason = { code: "pending", message: "GPU rendering is starting" };
        host.upscaling.renderingStarting = true;
      },
      menu: /./,
      osd: /./,
    },
    {
      name: "rendering: denylist, long",
      setup: (host) => {
        software(host, LONG);
        host.rendering.startedWith = "software";
        host.rendering.gpu = { available: false, reason: { code: "denylist", message: LONG } };
      },
      menu: /./,
      osd: /./,
    },
    { name: "works", setup: () => {}, menu: /./, osd: /./ },
  ];
  for (const locale of LOCALES) {
    for (const c of [...CASES, ...extra]) {
      const host = windows();
      c.setup(host);
      const { item, stop } = await start(host, locale);
      try {
        await item.run();
        await host.settle();
        assert.equal(host.osd.length, 1, `${locale} ${c.name}: one OSD message`);
        if (item.state.checked) {
          await item.run(); // the "off" message too
          await host.settle();
          await item.run(); // and the plain "on" (the note was shown already)
          await host.settle();
          assert.equal(host.osd.length, 3, `${locale} ${c.name}: off, on`);
        }
        const budget = locale === "en" ? OSD_BUDGET.en : OSD_BUDGET.zh;
        for (const shown of host.osd)
          assert.ok([...shown].length <= budget, `${locale} ${c.name}: ${[...shown].length}: ${shown}`);
      } finally {
        await stop();
      }
    }
  }
});

test("decoding: the request is kept and the item stays usable", async () => {
  const host = windows();
  host.upscalingDecoding("copy-back", [{ id: "vestra.video", name: "Picture Adjustments" }]);
  const { item, stop } = await start(host);
  try {
    await item.run();
    await host.settle();
    assert.deepEqual(sets(host), [true]);
    assert.equal(host.upscaling.enabled, true);
    assert.equal(item.state.enabled, true);
    assert.equal(item.state.checked, true);
    assert.match(host.osd.at(-1)!, /^AI Upscaling: On, waits until other video filters are off$/);
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
    assert.match(host.osd.at(-1)!, /^AI Upscaling: On, starts when GPU rendering is ready$/);
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
  const data = await mkdtemp(join(tmpdir(), "rtxupscale-"));
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
    // PNG cover art is not a video either (as the host reports it: mpv's long codec text, short decoder).
    host.stats = {
      ...host.stats,
      video: { codec: "PNG (Portable Network Graphics) image", decoder: "png", width: 600, height: 600, fps: null },
    } as typeof host.stats;
    host.openElsewhere("/media/song-with-cover.m4a");
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

test("hasVideo: the short decoder name decides, mpv's long codec text is the fallback", () => {
  assert.equal(hasVideo(null), false);
  type Video = Parameters<typeof hasVideo>[0];
  const v = (codec: string, decoder: string | null, fps: number | null = 24) =>
    ({ codec, decoder, width: 1920, height: 1080, fps }) as Video;
  // Moving video, as mpv describes it.
  assert.equal(hasVideo(v("H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10", "h264")), true);
  assert.equal(hasVideo(v("H.265 / HEVC (High Efficiency Video Coding)", "hevc")), true);
  assert.equal(hasVideo(v("Alliance for Open Media AV1", "libdav1d")), true);
  // JPEG: the same decoder plays Motion JPEG video and JPEG cover art; without a cover-art flag it counts.
  assert.equal(hasVideo(v("Motion JPEG", "mjpeg", null)), true);
  // Still pictures by decoder, whatever the codec text says.
  assert.equal(hasVideo(v("PNG (Portable Network Graphics) image", "png", null)), false);
  assert.equal(hasVideo(v("BMP (Windows and OS/2 bitmap)", "bmp", null)), false);
  assert.equal(hasVideo(v("WebP", "WEBP", null)), false);
  // No decoder name: the long codec text, case-insensitive.
  assert.equal(hasVideo(v("PNG (Portable Network Graphics) image", null, null)), false);
  assert.equal(hasVideo(v("GIF (Graphics Interchange Format)", null, null)), false);
  assert.equal(hasVideo(v("H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10", null)), true);
  // A track without a size is not shown.
  assert.equal(hasVideo({ ...v("H.264", "h264"), width: null } as Video), false);
});

test("GPU rendering that finished starting between the two reads does not grey the item", async () => {
  const host = windows();
  // The upscaling answer still says `rendering`, but the rendering state already draws on the GPU.
  host.upscaling.reason = { code: "rendering", message: "upscaling needs GPU rendering, which is starting" };
  host.videoRender.gpu = true;
  host.rendering.reason = { code: "default", message: "nothing rules GPU rendering out" };
  const { item, stop } = await start(host);
  try {
    await item.run();
    await host.settle();
    assert.equal(item.state.enabled, true);
    assert.equal(item.display.reason, null);
  } finally {
    await stop();
  }
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
    assert.match(host.osd.at(-1)!, /^AI upscaling: turn on Video ▸ GPU Rendering, then restart$/);
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
  const data = await mkdtemp(join(tmpdir(), "rtxupscale-"));
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
  await stop(); // ends the 1.5 s wait at once (the timer is cleared)
  const looks = host.sent("playback.stats").length;
  withVideo(host);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.deepEqual(sets(host), []);
  assert.equal(host.sent("playback.stats").length, looks); // no second look after the stop
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
    // The OSD names the same Windows settings page as the menu reason.
    assert.deepEqual(host.osd, ["AI 超分辨率：请在 Windows“显示卡”设置中选择 NVIDIA 显卡"]);
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

// ------------------------------------------------------------------ the AI Upscaling window

const CHANGED = "video.upscaling.changed";
const PICTURE = { id: "vestra.video", name: "Picture Adjustments" };

/** Start the plugin and open the window from its menu item. */
async function opened(host = windows(), locale: Locale = "en") {
  const started = await start(host, locale);
  await host.command("upscaling.window").run();
  await host.settle();
  return { ...started, window: host.window("upscale") };
}

test("window: Video ▸ AI Upscaling… opens it; the change event is listened to only while it is open", async () => {
  const host = windows();
  const { stop } = await start(host);
  try {
    const open = host.command("upscaling.window");
    assert.deepEqual(open.declaration.path, ["@video", WINDOW_TITLE]);
    assert.equal(open.declaration.order, 462);
    assert.equal(open.declaration.group, "video-rendering");
    assert.equal(host.listening.has(CHANGED), false); // not while closed: it would keep the plugin running
    await open.run();
    await host.settle();
    const window = host.window("upscale");
    assert.equal(window.visible, true);
    assert.equal(host.listening.has(CHANGED), true);
    assert.equal(states(host), 1); // read once when it opens
    // The user closes it with the title-bar button: the listener goes.
    window.userClose();
    await host.settle();
    assert.equal(host.listening.has(CHANGED), false);
    // Opened again and closed with its own Close button: the same.
    await open.run();
    await host.settle();
    assert.equal(host.listening.has(CHANGED), true);
    host.window("upscale").emit("closeWindow"); // a fresh record for the reopened window
    await host.settle();
    assert.equal(host.windows.has("upscale"), false); // closed
    assert.equal(host.listening.has(CHANGED), false);
    assert.equal(host.keepsRunning.some((why) => /upscaling/.test(why)), false);
  } finally {
    await stop();
  }
});

test("window: one click turns it on and off; sizes, factor, GPU, decoding and the chain follow the player live", async () => {
  const { host, window, item, stop } = await opened();
  try {
    assert.equal(window.props.on, false);
    assert.equal(window.props.status, "Off");
    assert.equal(window.props.tone, 0);
    assert.equal(window.props["can-toggle"], true);
    assert.equal(window.props.source, "1920×1080");
    assert.equal(window.props.target, "—"); // nothing requested while off
    assert.equal(window.props.factor, "—");
    assert.equal(window.props.area, "3840×2160");
    assert.equal(window.props.gpu, "NVIDIA GeForce RTX 4070 Laptop GPU");
    assert.equal(window.props.decoding, "d3d11va");
    assert.equal(window.props.chain, "No");
    assert.equal(window.props.reported, true);
    window.emit("toggle");
    await host.settle();
    assert.deepEqual(sets(host), [true]);
    assert.equal(item.state.checked, true); // the menu item follows
    assert.equal(window.props.on, true);
    assert.equal(window.props.status, "On: upscaling requested");
    assert.equal(window.props.tone, 1);
    assert.equal(window.props.target, "3840×2160");
    assert.equal(window.props.factor, "×2.00");
    assert.equal(window.props.chain, "Yes");
    // The main window got smaller: the player sends the change.
    host.upscaling.area = { width: 2560, height: 1440 };
    host.upscaling.factor = 1.33;
    host.upscalingChanged();
    await host.settle();
    assert.equal(window.props.factor, "×1.33");
    assert.equal(window.props.target, "2560×1440");
    assert.equal(window.props.area, "2560×1440");
    // Shown at its own size: no longer upscaled, and the window says why.
    host.upscaling.factor = 1;
    host.upscalingChanged();
    await host.settle();
    assert.equal(window.props.status, "On: not needed for this video");
    assert.equal(window.props.chain, "No");
    assert.match(String(window.props.detail), /shown at its own size or smaller/);
    window.emit("toggle");
    await host.settle();
    assert.deepEqual(sets(host), [true, false]);
    assert.equal(window.props.on, false);
    assert.equal(window.props.status, "Off");
  } finally {
    await stop();
  }
});

test("window: the target keeps the aspect ratio (letterboxed, pillarboxed)", () => {
  assert.equal(targetSize({ displayWidth: 1920, displayHeight: 800 }, { width: 3840, height: 2160 }), "3840×1600");
  assert.equal(targetSize({ displayWidth: 1440, displayHeight: 1080 }, { width: 3840, height: 2160 }), "2880×2160");
});

test("window: copy-back names the plugins whose filters block it, with the Q hint only for Picture Adjustments", async () => {
  const host = windows();
  host.upscalingDecoding("copy-back", [PICTURE, { id: "zysilm.colors", name: "Colors" }]);
  const { window, stop } = await opened(host);
  try {
    window.emit("toggle");
    await host.settle();
    assert.equal(host.upscaling.enabled, true); // kept: it waits
    assert.equal(window.props.status, "On, waiting");
    assert.equal(window.props.tone, 2);
    // One summary in the text; the box below names the plugins (not both).
    assert.equal(
      window.props.detail,
      "AI upscaling waits: other plugins' video filters need the frames in memory, so the video is not decoded on the GPU. Turn those filters off or reset them there; upscaling then starts by itself.",
    );
    assert.doesNotMatch(String(window.props.detail), /Picture Adjustments|Colors/);
    assert.equal(window.props.blocker, "Upscaling waits for the video filters of: Picture Adjustments, Colors");
    assert.deepEqual(String(window.props.advice).split("\n"), [
      "Picture Adjustments: press Q (Video ▸ Reset) to reset the picture, and turn off its other video effects.",
      "Colors: turn off or reset its video filters there.",
    ]);
    assert.equal(window.props.decoding, "d3d11va-copy");
    assert.match(host.osd.at(-1)!, /^AI Upscaling: On, waits until other video filters are off/);
    // The user reset the filters: the player sends the change and the window clears.
    host.upscaling.reason = null;
    host.upscaling.hwdecCurrent = "d3d11va";
    host.upscalingChanged();
    await host.settle();
    assert.equal(window.props.blocker, "");
    assert.equal(window.props.advice, "");
    assert.equal(window.props.status, "On: upscaling requested");
    // Nothing of another plugin was changed: the plugin ran no command.
    assert.equal(host.sent("commands.run").length, 0);
  } finally {
    await stop();
  }
});

test("window: the Q hint follows the plugin id; the name is the one the player reports", async () => {
  {
    const host = windows();
    host.upscalingDecoding("copy-back", [{ id: "vestra.video", name: "Bildanpassungen" }]);
    const { window, stop } = await opened(host);
    assert.match(String(window.props.advice), /^Bildanpassungen: press Q \(Video ▸ Reset\)/);
    await stop();
  }
  {
    const host = windows();
    host.upscalingDecoding("copy-back", [{ id: "someone.pictures", name: "Picture Adjustments" }]);
    const { window, stop } = await opened(host);
    assert.equal(window.props.advice, "Picture Adjustments: turn off or reset its video filters there.");
    assert.doesNotMatch(String(window.props.advice), /\bQ\b/);
    await stop();
  }
});

interface CauseCase {
  cause: string;
  plugins?: { id: string; name: string }[];
  detail: RegExp;
  osd: RegExp;
  decoding: string;
}

const CAUSE_CASES: CauseCase[] = [
  {
    // Copy-back that no plugin asked for (the user's own hwdec setting).
    cause: "copy-back",
    plugins: [],
    detail: /^AI upscaling waits: hardware decoding copies the frames back to memory \(copy-back\), as the player's hardware decoding setting asks/,
    osd: /^AI Upscaling: On, waits: hardware decoding copies frames back$/, // no filter is on
    decoding: "d3d11va-copy",
  },
  {
    cause: "hwdec-off",
    detail: /^AI upscaling waits: hardware decoding is off\. /,
    osd: /^AI Upscaling: On, waits until hardware decoding is on$/,
    decoding: "Software (no)",
  },
  {
    cause: "software",
    detail: /^AI upscaling waits: this video is decoded in software, for example a cover picture or a format the GPU cannot decode/,
    osd: /^AI Upscaling: On, waits: this video is decoded in software$/,
    decoding: "Software (no)",
  },
  {
    cause: "other-hwdec",
    detail: /^AI upscaling waits: this video is decoded with another hardware decoder than the one upscaling needs\.$/,
    osd: /^AI Upscaling: On, waits: the video uses another hardware decoder$/,
    decoding: "nvdec",
  },
  {
    // A newer player's cause: the player's own message.
    cause: "some-new-cause",
    detail: /^AI upscaling waits: this video is decoded with nvdec; upscaling needs it decoded/,
    osd: /^AI Upscaling: On, waits until the video is decoded on the GPU$/,
    decoding: "nvdec",
  },
];

for (const c of CAUSE_CASES) {
  test(`window and OSD: decoding cause ${c.cause} has its own words`, async () => {
    const host = windows();
    host.upscalingDecoding(c.cause, c.plugins);
    const { window, item, stop } = await opened(host);
    try {
      // Off: what would happen, and that the window is not live (the player sends nothing while off).
      const would = new RegExp(c.detail.source.replace("^AI upscaling waits: ", "^When turned on, AI upscaling will wait: "));
      assert.match(String(window.props.detail), would);
      assert.equal(window.props.live, false);
      assert.equal(window.props.blocker, "");
      assert.equal(window.props.decoding, c.decoding);
      await item.run(); // the menu item: kept, with a short OSD line
      await host.settle();
      assert.equal(item.state.checked, true);
      assert.equal(item.state.enabled, true);
      assert.match(host.osd.at(-1)!, c.osd);
      assert.match(String(window.props.detail), c.detail);
      assert.equal(window.props.live, true);
      for (const shown of [String(window.props.detail), host.osd.at(-1)!])
        assert.doesNotMatch(shown, /another video filter is (on|active)/); // the old wording, wrong for most causes
    } finally {
      await stop();
    }
  });
}

test("window: an older player (no cause, no monitoring fields) shows its message and dashes", async () => {
  const host = windows();
  const message = "the video is decoded with copy-back, for example because a video filter needs the frames in memory";
  // What players before 0.6.0 answer (the SDK docs say 0.5.25, a version that was never released):
  // no `cause`, no `plugins`, none of the monitoring fields.
  const old = () => ({
    available: false,
    reason: { code: "decoding", message },
    enabled: host.upscaling.enabled,
    requested: false,
    factor: null,
  });
  host.handle("video.upscaling.state", old);
  host.handle("video.upscaling.set", (params) => {
    host.upscaling.enabled = params.enabled === true;
    return old();
  });
  const { window, item, stop } = await opened(host);
  try {
    assert.equal(window.props.detail, `When turned on, AI upscaling will wait: ${message}`);
    assert.equal(window.props.blocker, "");
    assert.equal(window.props.reported, false);
    for (const field of ["source", "target", "factor", "area", "gpu", "decoding", "chain"])
      assert.equal(window.props[field], "—", field);
    await item.run();
    await host.settle();
    assert.equal(host.osd.at(-1), "AI Upscaling: On, waits until the video is decoded on the GPU");
    assert.equal(window.props.status, "On, waiting");
  } finally {
    await stop();
  }
});

test("window: a reason that rules it out greys the button and says why", async () => {
  const host = windows();
  host.upscaling.reason = { code: "no-gpu", message: "no NVIDIA GPU" };
  host.upscaling.gpu = null;
  const { window, stop } = await opened(host);
  try {
    assert.equal(window.props.status, "Not available");
    assert.equal(window.props.tone, 3);
    assert.equal(window.props["can-toggle"], false);
    assert.match(String(window.props.detail), /It needs an NVIDIA RTX GPU/);
    assert.equal(window.props.gpu, "Unknown");
  } finally {
    await stop();
  }
});

test("window: stopping the plugin ends the listener", async () => {
  const host = windows();
  const { stop } = await opened(host);
  assert.equal(host.listening.has(CHANGED), true);
  await stop();
  assert.equal(host.listening.has(CHANGED), false);
});

test("window, Simplified Chinese: translated; plugin names as the player reports them", async () => {
  const host = windows();
  host.upscalingDecoding("copy-back", [PICTURE]);
  const { window, stop } = await opened(host, "zh-Hans");
  try {
    assert.deepEqual(host.command("upscaling.window").display.path, ["视频", "AI 超分辨率…"]);
    assert.equal(window.props.status, "关");
    assert.equal(window.props.blocker, "超分辨率正在等待这些插件的视频滤镜：Picture Adjustments");
    assert.equal(window.props.advice, "Picture Adjustments：按 Q（视频 ▸ 复位）复位画面，并关闭其中的其他视频效果。");
    assert.match(String(window.props.detail), /^开启后，AI 超分辨率将等待：其他插件的视频滤镜/);
    window.emit("toggle");
    await host.settle();
    assert.equal(window.props.status, "开，等待中");
    assert.equal(host.osd.at(-1), "AI 超分辨率：开，其他视频滤镜关闭后生效");
  } finally {
    await stop();
  }
});

test("window: a window that cannot open leaves no listener behind", async () => {
  const host = windows();
  host.handle("ui.open", () => {
    throw new HostError("unavailable", "no user interface");
  });
  const { stop } = await start(host);
  try {
    await host.command("upscaling.window").run().catch(() => {}); // the player reports the failure
    await host.settle();
    assert.ok(host.sent("events.subscribe").some((params) => params.event === CHANGED)); // it did listen
    assert.equal(host.listening.has(CHANGED), false); // and stopped when the window failed
  } finally {
    await stop();
  }
});

test("window: Close right after a title-bar close does not fail", async () => {
  const host = windows();
  const { window, stop } = await opened(host);
  try {
    window.userClose();
    window.emit("closeWindow"); // the click raced the title-bar close
    await host.settle();
    assert.equal(host.windows.has("upscale"), false);
    assert.equal(host.listening.has(CHANGED), false);
  } finally {
    await stop();
  }
});

test("store listing: the name, the id of the directory, a 256×256 icon", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
  assert.equal(manifest.id, "zysilm.rtxupscale"); // <owner>.<directory>, as the repository requires
  assert.equal(manifest.name, "RTX Upscale for Vestra Player");
  assert.equal(manifest.icon, "assets/icon.png");
  const png = await readFile(new URL(manifest.icon, directory));
  assert.equal(png.toString("latin1", 1, 4), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256]);
});
