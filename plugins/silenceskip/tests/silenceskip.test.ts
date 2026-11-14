import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { localPath, SHOWN_RANGES } from "../main.ts";
import { PAD } from "../silence.ts";

const directory = new URL("..", import.meta.url);

/** The silences of the fake 300-second file, in seconds. */
const SILENCES = [
  { start: 10, end: 12.5 }, // skipped
  { start: 118, end: 125 }, // across the seam of windows 0 and 1
  { start: 200, end: 200.8 }, // shorter than the default minimum (1 s)
  { start: 298.8, end: 300 }, // runs into the end: kept
];

/**
 * A fake ffmpeg that answers like `silencedetect` + `ametadata` for one
 * window (`-ss`, `-t`): times relative to the window, a silence still open
 * at the window's end has no `silence_end`.
 */
function fakeFfmpeg(silences: { start: number; end: number }[]) {
  return (args: string[]) => {
    const from = Number(args[args.indexOf("-ss") + 1]);
    const to = from + Number(args[args.indexOf("-t") + 1]);
    const lines: string[] = [];
    for (const s of silences) {
      const start = Math.max(s.start, from);
      const end = Math.min(s.end, to);
      if (end - start < 0.5) continue;
      lines.push(`frame:1    pts:0       pts_time:${start - from}`, `lavfi.silence_start=${start - from}`);
      if (s.end < to) lines.push(`frame:2    pts:0       pts_time:${end - from}`, `lavfi.silence_end=${end - from}`, `lavfi.silence_duration=${end - start}`);
    }
    return { stdout: lines.join("\n") + "\n" };
  };
}

async function withFile(run: (path: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "silenceskip-"));
  const path = join(folder, "lecture.mp4");
  await writeFile(path, "not really a video");
  try {
    await run(path);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Polls until `check` holds: the scan runs ffmpeg in the plugin's process, which `settle` does not wait for. */
async function until(host: TestHost, check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await host.settle(10);
  assert.ok(check(), "condition not reached");
}

const ranges = (host: TestHost) => host.timeline.rangeLayers.get("zysilm.silenceskip") ?? [];

async function playing(path: string, options: { enabled?: boolean; locale?: "zh-Hans" } = {}) {
  const host = new TestHost();
  host.tools.handle("ffmpeg", fakeFfmpeg(SILENCES));
  host.openElsewhere(path);
  host.setSource({ duration: 300, position: 0, paused: false });
  const started = await startPlugin(activate, { directory, host, ...(options.locale ? { locale: options.locale } : {}) });
  if (options.enabled) {
    await host.command("toggle").run();
    await until(host, () => ranges(host).length === 2);
  }
  return started;
}

test("off by default: nothing is scanned and nothing keeps the plugin running", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path);
    await host.settle(50);
    assert.equal(host.command("toggle").state.checked, false);
    assert.deepEqual(host.tools.calls, []);
    assert.deepEqual(host.keepsRunning, []);
    assert.deepEqual(ranges(host), []);
    await stop();
  });
});

test("turning it on scans from the playhead and shows the silences on the seek bar", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    assert.equal(host.command("toggle").state.checked, true);
    assert.equal(host.osd[0], "Skip Silence: On");
    assert.equal(host.tools.calls.length, 3);
    assert.equal(host.tools.calls[0]!.args[host.tools.calls[0]!.args.indexOf("-ss") + 1], "0.000");
    assert.deepEqual(
      ranges(host).map((r) => [r.start, r.end, r.style, r.title]),
      [
        [10 + PAD, 12.5 - PAD, "region", "Silence"],
        [118 + PAD, 125 - PAD, "region", "Silence"],
      ],
    );
    assert.notDeepEqual(host.keepsRunning, []);
    await stop();
  });
});

test("playing into a silence jumps to its end and says how much was saved", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    host.setSource({ position: 10.3 });
    await until(host, () => host.seeks.length === 1);
    assert.equal(host.seeks[0]!.seconds, 12.5 - PAD);
    await until(host, () => host.osd.length === 2);
    assert.equal(host.osd[1], "Silence skipped · 0:02 saved");

    // Across the seam: one jump over 118–125.
    host.setSource({ position: 118.2 });
    await until(host, () => host.seeks.length === 2);
    assert.equal(host.seeks[1]!.seconds, 125 - PAD);
    await until(host, () => host.osd.length === 3);
    assert.equal(host.osd[2], "Silence skipped · 0:09 saved");
    await stop();
  });
});

test("the time saved counts one playthrough: a replay starts from 0:00", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    host.setSource({ position: 10.3 });
    await until(host, () => host.osd.length === 2);
    assert.equal(host.osd[1], "Silence skipped · 0:02 saved");

    host.setSource({ phase: "ended", position: 300, terminalReason: "natural" });
    await host.settle();
    host.setSource({ phase: "ready", position: 0, paused: false });
    await host.settle();
    host.setSource({ position: 10.3 });
    await until(host, () => host.osd.length === 3);
    assert.equal(host.seeks.length, 2);
    assert.equal(host.osd[2], "Silence skipped · 0:02 saved");
    await stop();
  });
});

test("no jump while paused, nor twice over the same silence until the user goes back", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    host.setSource({ position: 10.5, paused: true });
    await host.settle(50);
    assert.equal(host.seeks.length, 0);

    host.setSource({ paused: false });
    await until(host, () => host.seeks.length === 1);
    // A keyframe landing back inside the silence is not skipped again.
    host.setSource({ position: 11 });
    await host.settle(50);
    assert.equal(host.seeks.length, 1);
    // The user goes back before it: it is skipped again.
    host.setSource({ position: 2 });
    await host.settle();
    host.setSource({ position: 10.4 });
    await until(host, () => host.seeks.length === 2);
    await stop();
  });
});

test("a pause shorter than the minimum, or at the very end, is played", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    host.setSource({ position: 200.2 });
    await host.settle(50);
    host.setSource({ position: 299 });
    await host.settle(50);
    assert.equal(host.seeks.length, 0);

    // A shorter minimum takes the 0.8 s pause too, without a new scan.
    const calls = host.tools.calls.length;
    host.settingsPage("silenceskip").emit("minLengthChanged", 0.5);
    await until(host, () => ranges(host).length === 3);
    assert.equal(host.tools.calls.length, calls);
    host.setSource({ position: 200.2 });
    await until(host, () => host.seeks.length === 1);
    await stop();
  });
});

test("a new threshold scans the file again with it", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    const page = host.settingsPage("silenceskip");
    assert.equal(page.category, "playback");
    page.emit("thresholdChanged", -50.4);
    await host.settle();
    assert.equal(page.props["threshold"], -50);
    await until(host, () => host.tools.calls.length === 6 && ranges(host).length === 2);
    assert.match(host.tools.calls.at(-1)!.args.join(" "), /silencedetect=noise=-50dB/);

    page.emit("thresholdDefault");
    await host.settle();
    assert.equal(page.props["threshold"], -35);
    await stop();
  });
});

test("turning it off removes the marks and stops listening", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    await host.command("toggle").run();
    await host.settle();
    assert.deepEqual(ranges(host), []);
    assert.deepEqual(host.keepsRunning, []);
    assert.equal(host.osd.at(-1), "Skip Silence: Off");
    host.setSource({ position: 10.5 });
    await host.settle(50);
    assert.equal(host.seeks.length, 0);
    await stop();
  });
});

test("the setting is remembered: on at the next start", async () => {
  await withFile(async (path) => {
    const first = await playing(path, { enabled: true });
    const data = first.host.dataDirectory;
    await first.host.settle(400);
    const host = new TestHost();
    host.tools.handle("ffmpeg", fakeFfmpeg(SILENCES));
    host.openElsewhere(path);
    host.setSource({ duration: 300, position: 0 });
    const copy = await mkdtemp(join(tmpdir(), "silenceskip-data-"));
    const { cp } = await import("node:fs/promises");
    await cp(data, copy, { recursive: true });
    await first.stop();
    const second = await startPlugin(activate, { directory, host, dataDirectory: copy });
    assert.equal(host.command("toggle").state.checked, true);
    await until(host, () => ranges(host).length === 2);
    await second.stop();
    await rm(copy, { recursive: true, force: true });
  });
});

test("without ffmpeg it says so once", async () => {
  await withFile(async (path) => {
    const host = new TestHost();
    host.openElsewhere(path);
    host.setSource({ duration: 300, position: 0 });
    const { stop } = await startPlugin(activate, { directory, host });
    await host.command("toggle").run();
    await until(host, () => host.osd.length === 2);
    assert.equal(host.osd[1], "Silence Skipper needs ffmpeg, which was not found");
    host.openElsewhere(path);
    host.setSource({ duration: 300, position: 0 });
    await host.settle(50);
    assert.equal(host.osd.length, 2);
    await stop();
  });
});

test("a file ffmpeg cannot read is left alone with a note", async () => {
  await withFile(async (path) => {
    const host = new TestHost();
    host.tools.handle("ffmpeg", () => {
      throw new HostError("failed", "Output file does not contain any stream");
    });
    host.openElsewhere(path);
    host.setSource({ duration: 300, position: 0 });
    const { stop } = await startPlugin(activate, { directory, host });
    await host.command("toggle").run();
    await until(host, () => host.osd.length === 2);
    assert.equal(host.osd[1], "Silence Skipper cannot read the sound of this file");
    assert.equal(host.tools.calls.length, 1);
    await stop();
  });
});

test("streams and addresses are not scanned", async () => {
  const host = new TestHost();
  host.tools.handle("ffmpeg", fakeFfmpeg(SILENCES));
  host.openElsewhere("https://example.com/talk.m3u8");
  host.setSource({ duration: 300, position: 0 });
  const { stop } = await startPlugin(activate, { directory, host });
  await host.command("toggle").run();
  await host.settle(50);
  assert.deepEqual(host.tools.calls, []);
  assert.equal(localPath("https://example.com/a.mp4"), null);
  assert.equal(localPath("relative/a.mp4"), null);
  await stop();
});

test("another file mid-scan: the old scan's results never reach it", async () => {
  await withFile(async (path) => {
    const host = new TestHost();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const answer = fakeFfmpeg(SILENCES);
    host.tools.handle("ffmpeg", async (args) => {
      await gate;
      return answer(args);
    });
    host.openElsewhere(path);
    host.setSource({ duration: 300, position: 0 });
    const { stop } = await startPlugin(activate, { directory, host });
    await host.command("toggle").run();
    await host.settle(20);
    host.openElsewhere("https://example.com/other.mp4");
    host.setSource({ duration: 300, position: 0 });
    await host.settle();
    release();
    await host.settle(100);
    assert.deepEqual(ranges(host), []);
    await stop();
  });
});

test("the seek bar shows at most the limit of ranges", async () => {
  await withFile(async (path) => {
    const many = Array.from({ length: 150 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.2 + (i % 7) * 0.05 }));
    const host = new TestHost();
    host.tools.handle("ffmpeg", fakeFfmpeg(many));
    host.openElsewhere(path);
    host.setSource({ duration: 300, position: 0 });
    const { stop } = await startPlugin(activate, { directory, host });
    await host.command("toggle").run();
    await until(host, () => host.tools.calls.length === 3 && ranges(host).length === SHOWN_RANGES);
    await stop();
  });
});

test("speaks Chinese", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true, locale: "zh-Hans" });
    assert.equal(host.osd[0], "跳过静音：开");
    await stop();
  });
});
