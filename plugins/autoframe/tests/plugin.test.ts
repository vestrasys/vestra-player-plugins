import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import { displaySize, type Rect } from "../detect.ts";
import activate, { fileKey, localPath, MENU, parseProbe } from "../main.ts";
import { hostChain, makeFrame, type Rgb } from "./frames.ts";

const directory = new URL("..", import.meta.url);

const GREY: Rgb = [128, 128, 128];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** A fake video file: what ffprobe says and what ffmpeg decodes at each sampled time. */
interface Video {
  width: number;
  height: number;
  duration: number;
  sar?: string;
  rotation?: number;
  background: Rgb;
  /** The content box of the frame at `index` (0–7 in time order), `null` for a blank frame. */
  content: (index: number) => Rect | null;
  /** Every time decodes the same keyframe (a file with one keyframe). */
  still?: boolean;
}

type Node = { kind: string; aspect: number; x: number; y: number };

/** The plugin's chain as the host holds it (`[]` when none). */
function chain(host: TestHost): Node[] {
  const video = [...host.processing.resources.values()].filter((r) => r.stage === "video");
  return video.flatMap((r) => r.nodes as unknown as Node[]);
}

/** A host that plays fake videos: ffprobe and ffmpeg answer from `videos` by path, `player.stats()` reports the shown size after the chain. */
function makeHost(videos: Map<string, Video>, options: {
    geometry?: (size: { width: number; height: number }) => { width: number; height: number };
    beforeStats?: () => Promise<void>;
  } = {}) {
  const host = new TestHost();
  const playing = () => videos.get(host.source.source ?? "");
  host.tools.handle("ffprobe", (args) => {
    const video = videos.get(args.at(-1)!);
    if (!video) throw new HostError("failed", "No such file or directory");
    return {
      stdout: JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: video.width,
            height: video.height,
            sample_aspect_ratio: video.sar ?? "1:1",
            ...(video.rotation ? { side_data_list: [{ side_data_type: "Display Matrix", rotation: video.rotation }] } : {}),
          },
        ],
        format: { duration: String(video.duration) },
      }),
    };
  });
  host.tools.handle("ffmpeg", (args) => {
    const video = videos.get(args[args.indexOf("-i") + 1]!);
    if (!video) throw new HostError("failed", "No such file or directory");
    const time = Number(args[args.indexOf("-ss") + 1]);
    const index = Math.round(((time / video.duration - 0.05) / 0.9) * 7);
    const [w, h] = Math.abs(video.rotation ?? 0) === 90 ? [video.height, video.width] : [video.width, video.height];
    return { stdout: makeFrame(w, h, video.background, video.content(index), video.still ? 0 : index) };
  });
  host.handle("playback.stats", async () => {
    await options.beforeStats?.();
    const video = playing();
    if (!video || host.source.phase !== "ready") return { ...host.stats, video: null };
    const [w, h] = Math.abs(video.rotation ?? 0) === 90 ? [video.height, video.width] : [video.width, video.height];
    const [num, den] = (video.sar ?? "1:1").split(":").map(Number) as [number, number];
    const shown = hostChain(w, h, num / den, chain(host));
    let size = displaySize(shown.width, shown.height, num, den);
    if (options.geometry) size = options.geometry(size);
    return {
      ...host.stats,
      video: { codec: "h264", width: w, height: h, fps: 24, displayWidth: size.width, displayHeight: size.height },
    };
  });
  return host;
}

/** Real files (the plugin reads their size and time) for the fake videos. */
async function files(names: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "autoframe-"));
  const paths: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    await writeFile(path, name);
    paths.push(path);
  }
  return { dir, paths, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function until(host: TestHost, condition: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await host.settle(10);
  }
}

const ffmpegRuns = (host: TestHost) => host.tools.calls.filter((c) => c.tool === "ffmpeg").length;

/** The rect the plugin's chain cuts out of a `w × h` frame, through the host's own crop expressions. */
const cut = (host: TestHost, w: number, h: number) => hostChain(w, h, 1, chain(host));

const always = (rect: Rect | null) => () => rect;

test("menu: Video ▸ Auto Frame with three items that fit the player's rules", async () => {
  const host = makeHost(new Map());
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    for (const [id, title] of [
      ["auto", "Auto-Frame Videos"],
      ["detect", "Detect Again"],
      ["full", "Show Full Picture for This File"],
    ] as const) {
      const path = host.command(id).declaration.path as string[];
      assert.deepEqual(path, [...MENU, title]);
      for (const segment of path) {
        assert.ok(Buffer.byteLength(segment) <= 80);
        assert.equal(segment, segment.trim());
        assert.ok(!/[\u0000-\u001f\u007f]/.test(segment));
      }
    }
    assert.equal(host.command("auto").state.checked, true); // on by default
    assert.equal(host.command("detect").state.enabled, false);
    assert.match(host.command("detect").display.reason ?? "", /Play a video file on this computer/);
    assert.equal(host.command("full").state.enabled, false);
    // No chain is sent while nothing plays.
    assert.equal(host.sent("processing.replace").length, 0);
  } finally {
    await stop();
  }
});

test("a 2560×1440 picture top-left of a 4K grey frame is cropped exactly, once per file (cache)", async () => {
  const { paths, cleanup } = await files(["a.mp4", "b.mp4"]);
  const [a, b] = paths as [string, string];
  const video: Video = {
    width: 3840,
    height: 2160,
    duration: 600,
    background: GREY,
    content: always({ x: 0, y: 0, width: 2560, height: 1440 }),
  };
  const host = makeHost(new Map([[a, video], [b, { ...video, background: WHITE, content: always(null), duration: 60 }]]));
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(a);
    await until(host, () => host.osd.includes("Auto-framed to 2560×1440"), "the OSD");
    assert.equal(ffmpegRuns(host), 8);
    assert.deepEqual(host.tools.calls[0]?.args.slice(0, 4), ["-v", "error", "-select_streams", "V:0"]);
    const frameArgs = host.tools.calls[1]!.args;
    for (const arg of ["-nostdin", "-skip_frame", "nokey", "-noaccurate_seek", "rgb24", "rawvideo"]) assert.ok(frameArgs.includes(arg));
    const nodes = chain(host);
    assert.equal(nodes.length, 2);
    assert.ok(nodes.every((n) => n.kind === "reframe"));
    assert.deepEqual(cut(host, 3840, 2160), { x: 0, y: 0, width: 2560, height: 1440 });
    assert.equal(host.command("detect").state.enabled, true);

    // Another file with no picture inside: nothing cropped, zero-copy again.
    host.openElsewhere(b);
    await until(host, () => ffmpegRuns(host) === 16, "the second detection");
    await until(host, () => chain(host).length === 0, "an empty chain");

    // The first file again: from the cache, no ffmpeg.
    const runs = host.tools.calls.length;
    const shown = host.osd.length;
    host.openElsewhere(a);
    await until(host, () => host.osd.length > shown, "the OSD");
    assert.equal(host.osd.at(-1), "Auto-framed to 2560×1440");
    assert.equal(host.tools.calls.length, runs);
    assert.deepEqual(cut(host, 3840, 2160), { x: 0, y: 0, width: 2560, height: 1440 });
  } finally {
    await stop();
    await cleanup();
  }
});

test("the cache survives a restart and is keyed by the file's path, size and time", async () => {
  const { paths, cleanup } = await files(["a.mp4"]);
  const a = paths[0]!;
  const video: Video = {
    width: 1920,
    height: 1080,
    duration: 100,
    background: WHITE,
    content: always({ x: 320, y: 180, width: 1280, height: 720 }),
  };
  const data = await mkdtemp(join(tmpdir(), "autoframe-data-"));
  try {
    let host = makeHost(new Map([[a, video]]));
    let started = await startPlugin(activate, { directory, host, dataDirectory: data });
    host.openElsewhere(a);
    await until(host, () => host.osd.includes("Auto-framed to 1280×720"), "the OSD");
    assert.deepEqual(cut(host, 1920, 1080), { x: 320, y: 180, width: 1280, height: 720 });
    await started.stop();
    const saved = JSON.parse(await readFile(join(data, "cache.json"), "utf8"));
    assert.deepEqual(saved.files[await fileKey(a)].detected.rect, { x: 320, y: 180, width: 1280, height: 720 });

    host = makeHost(new Map([[a, video]]));
    started = await startPlugin(activate, { directory, host, dataDirectory: data });
    host.openElsewhere(a);
    await until(host, () => host.osd.includes("Auto-framed to 1280×720"), "the OSD");
    assert.equal(ffmpegRuns(host), 0);
    await started.stop();

    // The file changed: detected again.
    await writeFile(a, "a longer file now");
    host = makeHost(new Map([[a, video]]));
    started = await startPlugin(activate, { directory, host, dataDirectory: data });
    host.openElsewhere(a);
    await until(host, () => host.osd.includes("Auto-framed to 1280×720"), "the OSD");
    assert.equal(ffmpegRuns(host), 8);
    await started.stop();
  } finally {
    await rm(data, { recursive: true, force: true });
    await cleanup();
  }
});

test("centred box on black: cropped; fade-in frames are skipped", async () => {
  const { paths, cleanup } = await files(["a.mp4"]);
  const a = paths[0]!;
  const picture = { x: 320, y: 180, width: 1280, height: 720 };
  const host = makeHost(
    new Map([[a, { width: 1920, height: 1080, duration: 80, background: BLACK, content: (i: number) => (i < 3 ? null : picture) }]]),
  );
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(a);
    await until(host, () => host.osd.includes("Auto-framed to 1280×720"), "the OSD");
    assert.equal(chain(host).length, 2);
    assert.deepEqual(cut(host, 1920, 1080), picture);
  } finally {
    await stop();
    await cleanup();
  }
});

test("letterboxed and pillarboxed films stay untouched; Detect Again says why", async () => {
  const { paths, cleanup } = await files(["scope.mp4", "academy.mp4"]);
  const [scope, academy] = paths as [string, string];
  const host = makeHost(
    new Map([
      [scope, { width: 1920, height: 1080, duration: 80, background: BLACK, content: always({ x: 0, y: 132, width: 1920, height: 816 }) }],
      [academy, { width: 1920, height: 1080, duration: 80, background: BLACK, content: always({ x: 240, y: 0, width: 1440, height: 1080 }) }],
    ]),
  );
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    for (const [file, runs] of [[scope, 8], [academy, 16]] as const) {
      host.openElsewhere(file);
      await until(host, () => ffmpegRuns(host) === runs, "the detection");
      await host.settle(50);
      assert.deepEqual(chain(host), []);
      assert.deepEqual(host.osd, []); // automatic: no message
    }
    assert.equal(host.sent("processing.replace").length, 0);
    await host.command("detect").run();
    await until(host, () => host.osd.length > 0, "the OSD");
    assert.deepEqual(host.osd, ["Auto Frame: bars only above and below or only at the sides are kept"]);
    assert.deepEqual(chain(host), []);
  } finally {
    await stop();
    await cleanup();
  }
});

test("no crop: content fills the frame, too few frames with a picture, a stream or a URL", async () => {
  const { paths, cleanup } = await files(["full.mp4", "dark.mp4"]);
  const [full, dark] = paths as [string, string];
  const host = makeHost(
    new Map([
      [full, { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 1920, height: 1080 }) }],
      [dark, { width: 1920, height: 1080, duration: 80, background: BLACK, content: (i: number) => (i < 6 ? null : { x: 0, y: 0, width: 1280, height: 720 }) }],
    ]),
  );
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(full);
    await until(host, () => ffmpegRuns(host) === 8, "the detection");
    await host.settle(50);
    host.openElsewhere(dark);
    await until(host, () => ffmpegRuns(host) === 16, "the detection");
    await host.settle(50);
    assert.equal(host.sent("processing.replace").length, 0); // never a chain
    assert.deepEqual(host.osd, []); // not asked: no message
    // Detect Again says why.
    await host.command("detect").run();
    assert.equal(host.osd.at(-1), "Auto Frame: too few frames show a picture to decide");

    const calls = host.tools.calls.length;
    host.openElsewhere("https://example.com/video.mp4");
    await host.settle(50);
    host.openElsewhere(full, "loading");
    host.setSource({ kind: "producer", source: "producer://7", phase: "ready" });
    await host.settle(50);
    assert.equal(host.tools.calls.length, calls);
    assert.equal(host.command("detect").state.enabled, false);
  } finally {
    await stop();
    await cleanup();
  }
});

test("a picture too narrow for the player's crop is not cropped, with a reason", async () => {
  const { paths, cleanup } = await files(["a.mp4"]);
  const host = makeHost(
    new Map([[paths[0]!, { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 400, width: 1800, height: 420 }) }]]),
  );
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(paths[0]!);
    await until(host, () => host.osd.length > 0, "the OSD");
    assert.deepEqual(host.osd, ["Auto Frame: the picture is too narrow or too wide to frame"]);
    assert.deepEqual(chain(host), []);
  } finally {
    await stop();
    await cleanup();
  }
});

test("Auto-Frame Videos: off withdraws the crop and is remembered; on frames the file again", async () => {
  const { paths, cleanup } = await files(["a.mp4", "b.mp4"]);
  const [a, b] = paths as [string, string];
  const video: Video = { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 1280, height: 720 }) };
  const data = await mkdtemp(join(tmpdir(), "autoframe-data-"));
  const host = makeHost(new Map([[a, video], [b, video]]));
  let started = await startPlugin(activate, { directory, host, dataDirectory: data });
  try {
    host.openElsewhere(a);
    await until(host, () => chain(host).length === 2, "the crop");
    await host.command("auto").run();
    assert.equal(host.command("auto").state.checked, false);
    assert.deepEqual(chain(host), []);
    assert.equal(host.osd.at(-1), "Auto Frame: Off");
    assert.equal(host.command("detect").state.enabled, false);
    assert.equal(host.command("full").state.enabled, false);
    // A new file is not read while off.
    const runs = ffmpegRuns(host);
    host.openElsewhere(b);
    await host.settle(100);
    assert.equal(ffmpegRuns(host), runs);
    assert.deepEqual(chain(host), []);
    await started.stop();
    assert.deepEqual(JSON.parse(await readFile(join(data, "settings.json"), "utf8")), { enabled: false });

    started = await startPlugin(activate, { directory, host: makeHost(new Map([[a, video]])), dataDirectory: data });
    const again = started.host;
    assert.equal(again.command("auto").state.checked, false);
    again.openElsewhere(a);
    await again.settle(100);
    assert.deepEqual(chain(again), []);
    await again.command("auto").run();
    await until(again, () => again.osd.at(-1) === "Auto-framed to 1280×720", "the OSD");
    assert.equal(again.osd[0], "Auto Frame: On");
    assert.equal(chain(again).length, 2);
  } finally {
    await started.stop();
    await rm(data, { recursive: true, force: true });
    await cleanup();
  }
});

test("Show Full Picture for This File: remembered for that file only", async () => {
  const { paths, cleanup } = await files(["a.mp4", "b.mp4"]);
  const [a, b] = paths as [string, string];
  const video: Video = { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 1280, height: 720 }) };
  const host = makeHost(new Map([[a, video], [b, video]]));
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(a);
    await until(host, () => chain(host).length === 2, "the crop");
    await host.command("full").run();
    assert.equal(host.command("full").state.checked, true);
    assert.deepEqual(chain(host), []);
    assert.equal(host.osd.at(-1), "Showing the full picture of this file");
    assert.equal(host.command("detect").state.enabled, false);

    host.openElsewhere(b);
    await until(host, () => chain(host).length === 2, "the crop of b");
    assert.equal(host.command("full").state.checked, false);

    const shown = host.osd.length;
    host.openElsewhere(a);
    await host.settle(100);
    assert.deepEqual(chain(host), []);
    assert.equal(host.command("full").state.checked, true);
    assert.equal(host.osd.length, shown);

    await host.command("full").run();
    await until(host, () => host.osd.at(-1) === "Auto-framed to 1280×720", "the OSD");
    assert.equal(chain(host).length, 2);
    assert.equal(host.command("full").state.checked, false);
  } finally {
    await stop();
    await cleanup();
  }
});

test("Detect Again reads the file again and replaces the cached answer", async () => {
  const { paths, cleanup } = await files(["a.mp4"]);
  const a = paths[0]!;
  let content: Rect = { x: 0, y: 0, width: 1280, height: 720 };
  const host = makeHost(new Map([[a, { width: 1920, height: 1080, duration: 80, background: GREY, content: () => content }]]));
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(a);
    await until(host, () => chain(host).length === 2, "the crop");
    content = { x: 0, y: 0, width: 1600, height: 900 };
    await host.command("detect").run();
    await until(host, () => host.osd.at(-1) === "Auto-framed to 1600×900", "the OSD");
    assert.equal(ffmpegRuns(host), 16);
    assert.deepEqual(cut(host, 1920, 1080), { x: 0, y: 0, width: 1600, height: 900 });
  } finally {
    await stop();
    await cleanup();
  }
});

test("a source change aborts the detection: the old file's answer is neither applied nor cached", async () => {
  const { paths, cleanup } = await files(["slow.mp4", "next.mp4"]);
  const [slow, next] = paths as [string, string];
  const video: Video = { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 1280, height: 720 }) };
  const host = makeHost(new Map([[slow, video], [next, { ...video, content: always(null) }]]));
  const answer = host.tools.handlers.get("ffmpeg")!;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  host.tools.handle("ffmpeg", async (args) => {
    if (args.includes(slow)) await gate;
    return answer(args);
  });
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(slow);
    await until(host, () => ffmpegRuns(host) === 1, "the first frame");
    host.openElsewhere(next);
    await until(host, () => ffmpegRuns(host) === 9, "the next file's detection");
    release();
    await host.settle(200);
    // The slow file's runs stopped at the one in flight.
    assert.equal(host.tools.calls.filter((c) => c.args.includes(slow)).length, 2);
    assert.deepEqual(chain(host), []);
    assert.deepEqual(host.osd, []);
    // Opening the slow file again reads it (nothing was cached for it).
    host.openElsewhere(slow);
    await until(host, () => chain(host).length === 2, "the crop");
    assert.equal(host.tools.calls.filter((c) => c.args.includes(slow)).length, 11);
  } finally {
    release();
    await stop();
    await cleanup();
  }
});

test("another plugin's geometry (Crop/Stretch, rotation): paused before, undone after", async () => {
  const { paths, cleanup } = await files(["a.mp4", "b.mp4"]);
  const [a, b] = paths as [string, string];
  const video: Video = { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 1280, height: 720 }) };
  // The built-in Crop to 4:3 is on before the plugin applies anything.
  let host = makeHost(new Map([[a, video]]), { geometry: ({ height }) => ({ width: (height * 4) / 3, height }) });
  let started = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(a);
    await until(host, () => host.osd.length > 0, "the OSD");
    assert.deepEqual(host.osd, ["Auto Frame paused: Crop/Stretch or rotation changes the picture"]);
    assert.deepEqual(chain(host), []);
    await started.stop();

    // A rotation that only shows once the crop is on: the crop is withdrawn.
    let crop = false;
    host = makeHost(new Map([[b, video]]), {
      geometry: (size) => {
        if (size.width !== 1920) crop = true;
        return crop ? { width: size.height, height: size.width } : size;
      },
    });
    started = await startPlugin(activate, { directory, host });
    host.openElsewhere(b);
    await until(host, () => host.osd.length > 0, "the OSD");
    assert.deepEqual(host.osd, ["Auto Frame undone: Crop/Stretch or rotation changes the picture"]);
    assert.deepEqual(chain(host), []);
  } finally {
    await started.stop();
    await cleanup();
  }
});

test("a rotated file is framed in the picture as the player shows it", async () => {
  const { paths, cleanup } = await files(["portrait.mp4"]);
  const a = paths[0]!;
  // Stored 1920×1080, shown 1080×1920 (rotation −90): the picture is 720×1280 at the top left.
  const host = makeHost(
    new Map([[a, { width: 1920, height: 1080, rotation: -90, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 720, height: 1280 }) }]]),
  );
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(a);
    await until(host, () => host.osd.length > 0, "the OSD");
    assert.equal(host.osd.at(-1), "Auto-framed to 720×1280");
    assert.deepEqual(cut(host, 1080, 1920), { x: 0, y: 0, width: 720, height: 1280 });
  } finally {
    await stop();
    await cleanup();
  }
});

test("ffmpeg missing: said once, nothing cropped", async () => {
  const { paths, cleanup } = await files(["a.mp4", "b.mp4"]);
  const host = new TestHost();
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(paths[0]!);
    await until(host, () => host.osd.length > 0, "the OSD");
    host.openElsewhere(paths[1]!);
    await host.settle(100);
    assert.deepEqual(host.osd, ["Auto Frame needs ffmpeg, which was not found"]);
    assert.deepEqual(chain(host), []);
  } finally {
    await stop();
    await cleanup();
  }
});

test("Simplified Chinese", async () => {
  const { paths, cleanup } = await files(["a.mp4"]);
  const host = makeHost(
    new Map([[paths[0]!, { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 1280, height: 720 }) }]]),
  );
  const { stop } = await startPlugin(activate, { directory, host, locale: "zh-Hans" });
  try {
    assert.deepEqual(host.command("auto").display.path, ["视频", "自动取景", "自动取景视频"]);
    host.openElsewhere(paths[0]!);
    await until(host, () => host.osd.length > 0, "the OSD");
    assert.deepEqual(host.osd, ["已自动取景为 1280×720"]);
  } finally {
    await stop();
    await cleanup();
  }
});

test("helpers: local paths and ffprobe's answer", () => {
  assert.equal(localPath(null), null);
  assert.equal(localPath("https://example.com/a.mp4"), null);
  assert.equal(localPath("producer://3"), null);
  assert.equal(localPath("relative.mp4"), null);
  const absolute = join(tmpdir(), "a.mp4");
  assert.equal(localPath(absolute), absolute);
  assert.deepEqual(
    parseProbe({ streams: [{ width: 1440, height: 1080, sample_aspect_ratio: "4:3" }], format: { duration: "12.5" } }),
    { width: 1440, height: 1080, sar: [4, 3], duration: 12.5 },
  );
  // No duration in the container: the stream's.
  assert.equal(parseProbe({ streams: [{ width: 640, height: 480, duration: "30.0" }], format: {} })?.duration, 30);
  assert.deepEqual(parseProbe({ streams: [{ width: 1920, height: 1080, sample_aspect_ratio: "0:1", tags: { rotate: "90" } }], format: {} }), {
    width: 1080,
    height: 1920,
    sar: [1, 1],
    duration: 0,
  });
  assert.equal(parseProbe({ streams: [{ width: 600, height: 600, disposition: { attached_pic: 1 } }] }), null);
  assert.equal(parseProbe({ streams: [] }), null);
});

test("a crop already on is withdrawn when another plugin changes the picture later", async () => {
  const { paths, cleanup } = await files(["a.mp4"]);
  let rotated = false;
  const host = makeHost(
    new Map([[paths[0]!, { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 1280, height: 720 }) }]]),
    { geometry: (size) => (rotated ? { width: size.height, height: size.width } : size) },
  );
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(paths[0]!);
    await until(host, () => host.osd.includes("Auto-framed to 1280×720"), "the OSD");
    await host.settle(1500);
    assert.equal(chain(host).length, 2); // the same size: kept
    rotated = true; // the user rotates the video with the built-in item
    await until(host, () => chain(host).length === 0, "the crop withdrawn");
    assert.equal(host.osd.at(-1), "Auto Frame undone: Crop/Stretch or rotation changes the picture");
  } finally {
    await stop();
    await cleanup();
  }
});

test("turning Auto Frame off while a crop is being applied wins", async () => {
  const { paths, cleanup } = await files(["a.mp4"]);
  let open: () => void = () => {};
  let gate: Promise<void> | null = null;
  const host = makeHost(
    new Map([[paths[0]!, { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 1280, height: 720 }) }]]),
    { beforeStats: () => gate ?? Promise.resolve() },
  );
  gate = new Promise<void>((resolve) => (open = resolve));
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(paths[0]!);
    // The plugin reads the shown size before it crops; the answer is held back.
    // (Polled with timers: host.settle() would wait for the held request.)
    const end = Date.now() + 10_000;
    while (!host.calls.some((c) => c.method === "playback.stats")) {
      if (Date.now() > end) throw new Error("timed out waiting for the size check");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const off = host.command("auto").run();
    // Not host.settle(): the held size request stays in flight.
    await new Promise((resolve) => setTimeout(resolve, 50));
    open();
    await off;
    await host.settle(200);
    assert.deepEqual(chain(host), []);
    assert.equal(host.sent("processing.replace").length, 0);
    assert.ok(!host.osd.some((m) => m.startsWith("Auto-framed")));
  } finally {
    open();
    await stop();
    await cleanup();
  }
});

test("the previous file's crop is withdrawn as soon as another file loads, before it is read", async () => {
  const { paths, cleanup } = await files(["a.mp4", "b.mp4"]);
  const [a, b] = paths as [string, string];
  const video: Video = { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 1280, height: 720 }) };
  const host = makeHost(new Map([[a, video], [b, video]]));
  const probe = host.tools.handlers.get("ffprobe")!;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  host.tools.handle("ffprobe", async (args) => {
    if (args.includes(b)) await held; // file b is never read during the test
    return probe(args);
  });
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(a);
    await until(host, () => chain(host).length === 2, "the crop");
    // The empty chain is set at the first change to b (loading); the player
    // takes chains for ready media, so it applies once b is ready, still
    // before b is read.
    host.openElsewhere(b, "loading");
    await host.settle(20);
    host.setSource({ phase: "ready" });
    await until(host, () => chain(host).length === 0, "the empty chain");
    assert.deepEqual(host.sent("processing.replace").at(-1)?.nodes, []);
    assert.equal(host.tools.calls.filter((c) => c.args.includes(b)).length, 1); // ffprobe started, held
  } finally {
    release();
    await stop();
    await cleanup();
  }
});

test("a frame that cannot be read: the answer is used but not cached; the same keyframe counts once", async () => {
  const { paths, cleanup } = await files(["a.mp4", "still.mp4"]);
  const [a, still] = paths as [string, string];
  const video: Video = { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 1280, height: 720 }) };
  const host = makeHost(new Map([[a, video], [still, { ...video, still: true }]]));
  const answer = host.tools.handlers.get("ffmpeg")!;
  let slow = true;
  host.tools.handle("ffmpeg", (args) => {
    if (slow && args.includes(a) && args[args.indexOf("-ss") + 1] === "4.000") throw new HostError("timeout", "timed out");
    return answer(args);
  });
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(a);
    await until(host, () => host.osd.includes("Auto-framed to 1280×720"), "the OSD");
    slow = false;
    host.openElsewhere(still);
    await until(host, () => ffmpegRuns(host) === 16, "the still file");
    await host.settle(50);
    // Eight times, one keyframe: one frame with a picture, too few to decide.
    assert.deepEqual(chain(host), []);
    await host.command("detect").run();
    await until(host, () => host.osd.at(-1) === "Auto Frame: too few frames show a picture to decide", "the reason");
    // The first file again: read again, since one frame timed out the first time.
    const runs = ffmpegRuns(host);
    host.openElsewhere(a);
    await until(host, () => ffmpegRuns(host) === runs + 8, "the second reading");
  } finally {
    await stop();
    await cleanup();
  }
});

test("slides on a white background (boxes that move) are not cropped", async () => {
  const { paths, cleanup } = await files(["slides.mp4"]);
  const boxes = [
    { x: 160, y: 100, width: 1500, height: 700 },
    { x: 200, y: 140, width: 1400, height: 820 },
    { x: 180, y: 120, width: 1560, height: 600 },
    { x: 240, y: 200, width: 1300, height: 760 },
    { x: 150, y: 110, width: 1600, height: 840 },
    { x: 300, y: 300, width: 1200, height: 500 },
    { x: 170, y: 130, width: 1520, height: 780 },
    { x: 220, y: 160, width: 1450, height: 800 },
  ];
  const host = makeHost(new Map([[paths[0]!, { width: 1920, height: 1080, duration: 80, background: WHITE, content: (i: number) => boxes[i] ?? null }]]));
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(paths[0]!);
    await until(host, () => ffmpegRuns(host) === 8, "the detection");
    await host.settle(50);
    assert.deepEqual(chain(host), []);
    assert.deepEqual(host.osd, []);
    await host.command("detect").run();
    await until(host, () => host.osd.length > 0, "the reason");
    assert.deepEqual(host.osd, ["Auto Frame: the picture moves on a plain background, not cropped"]);
  } finally {
    await stop();
    await cleanup();
  }
});

test("a crop that takes effect after more than 3 s (slow decoder, paused) is kept", async () => {
  const { paths, cleanup } = await files(["a.mp4"]);
  let since: number | null = null;
  const host = makeHost(
    new Map([[paths[0]!, { width: 1920, height: 1080, duration: 80, background: GREY, content: always({ x: 0, y: 0, width: 1280, height: 720 }) }]]),
    {
      // The player still shows the full picture for 6.5 s after the crop is applied.
      geometry: (size) => {
        if (size.width === 1920) return size;
        since ??= Date.now();
        return Date.now() - since < 6500 ? { width: 1920, height: 1080 } : size;
      },
    },
  );
  const { stop } = await startPlugin(activate, { directory, host });
  try {
    host.openElsewhere(paths[0]!);
    await until(host, () => host.osd.includes("Auto-framed to 1280×720"), "the OSD");
    await host.settle(5000); // past the 6.5 s, with watch checks before and after
    assert.equal(chain(host).length, 2);
    assert.deepEqual(host.osd, ["Auto-framed to 1280×720"]);
  } finally {
    await stop();
    await cleanup();
  }
});
