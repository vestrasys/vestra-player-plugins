import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { LEAD, localPath, SHOWN_RANGES } from "../main.ts";
import { PAD } from "../silence.ts";

const directory = new URL("..", import.meta.url);

/** The silences of the fake 300-second file, in seconds. */
const SILENCES = [
  { start: 10, end: 12.5 }, // skipped
  { start: 118, end: 125 }, // across the seam of windows 0 and 1
  { start: 200, end: 200.8 }, // shorter than the default minimum (1 s)
  { start: 298.8, end: 300 }, // runs into the end: kept
];
/** The two stretches skipped of {@link SILENCES}. */
const FIRST = { start: 10 + PAD, end: 12.5 - PAD };
const SECOND = { start: 118 + PAD, end: 125 - PAD };

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

/** Open `path` as the player does: loading, then ready (`source.ready`) with a duration. */
function open(host: TestHost, path: string, state: { position?: number; paused?: boolean } = {}) {
  host.openElsewhere(path, "loading");
  host.setSource({ phase: "ready", duration: 300, position: 0, paused: false, ...state });
}

/** The plugin waits for a silence's start with a real timer of its own (up to {@link LEAD} seconds). */
async function waited(host: TestHost, check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await host.settle(10);
  assert.ok(check(), "condition not reached");
}

async function playing(path: string, options: { enabled?: boolean; locale?: "zh-Hans" } = {}) {
  const host = new TestHost();
  host.tools.handle("ffmpeg", fakeFfmpeg(SILENCES));
  open(host, path);
  const started = await startPlugin(activate, { directory, host, ...(options.locale ? { locale: options.locale } : {}) });
  if (options.enabled) {
    await host.command("toggle").run();
    await until(host, () => ranges(host).length === 2 && host.tools.calls.length === 3);
  }
  return started;
}

/** The position list the plugin's trigger waits on, as `[start, end]` pairs. */
function armed(host: TestHost): number[][] | null {
  const [kept] = host.triggers;
  if (!kept) return null;
  const parts = (kept.when as { all: Record<string, unknown>[] }).all;
  const position = parts.find((p) => "position" in p)?.position as { ranges: number[][]; lead: number };
  assert.equal(position.lead, LEAD);
  return position.ranges;
}

test("off by default: nothing is scanned, nothing is armed and nothing keeps the plugin running", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path);
    await host.settle(50);
    assert.equal(host.command("toggle").state.checked, false);
    assert.deepEqual(host.tools.calls, []);
    assert.deepEqual(host.keepsRunning, []);
    assert.deepEqual(host.triggers, []);
    assert.equal(host.subscriptions.has("source.ready"), false);
    assert.deepEqual(ranges(host), []);
    await stop();
  });
});

test("turning it on scans from the playhead, draws the silences and arms one trigger with them", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    assert.equal(host.command("toggle").state.checked, true);
    assert.equal(host.osd[0], "Skip Silence: On");
    assert.equal(host.tools.calls[0]!.args[host.tools.calls[0]!.args.indexOf("-ss") + 1], "0.000");
    assert.deepEqual(
      ranges(host).map((r) => [r.start, r.end, r.style, r.title]),
      [
        [FIRST.start, FIRST.end, "region", "Silence"],
        [SECOND.start, SECOND.end, "region", "Silence"],
      ],
    );
    assert.equal(host.triggers.length, 1);
    assert.deepEqual(armed(host), [
      [FIRST.start, FIRST.end],
      [SECOND.start, SECOND.end],
    ]);
    // Nothing keeps it running: the player may stop it between silences.
    assert.deepEqual(host.keepsRunning, []);
    // Only a new file wakes it; the end of one does not.
    assert.deepEqual([...host.subscriptions].filter((e) => e.startsWith("source.")), ["source.ready"]);
    await stop();
  });
});

test("woken before a silence, it waits for its start and jumps to its end", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    await host.park();
    assert.equal(host.parked, true);
    // Playback reaches the silence's start less the lead: the player starts the plugin.
    await host.advance((FIRST.start - LEAD) * 1000);
    await until(host, () => !host.parked);
    assert.equal(host.source.position, FIRST.start - LEAD);
    assert.equal(host.seeks.length, 0);
    // Its own timer runs out at the start (2 s later at 1×): one seek to the end.
    const entered = Date.now();
    await waited(host, () => host.seeks.length === 1);
    assert.ok(Date.now() - entered > 1500, "it waited for the start");
    assert.equal(host.seeks[0]!.seconds, FIRST.end);
    await until(host, () => host.osd.at(-1) === "Silence skipped · 0:02 saved");

    // Parked again; the next silence (across the scan's seam) wakes it again, and the time adds up.
    await host.park();
    await host.advance((SECOND.start - LEAD - FIRST.end) * 1000);
    await until(host, () => !host.parked);
    await waited(host, () => host.seeks.length === 2);
    assert.equal(host.seeks[1]!.seconds, SECOND.end);
    await until(host, () => host.osd.at(-1) === "Silence skipped · 0:09 saved");
    // A wake does not read the file again.
    assert.equal(host.tools.calls.length, 3);
    await stop();
  });
});

test("a wait at twice the speed is half as long", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    host.setSource({ rate: 2 });
    await host.advance(((FIRST.start - LEAD) / 2) * 1000);
    const entered = Date.now();
    await waited(host, () => host.seeks.length === 1);
    // 2 media seconds at twice the speed: about one second.
    const took = Date.now() - entered;
    assert.ok(took > 700 && took < 1700, `waited ${took} ms`);
    assert.equal(host.seeks[0]!.seconds, FIRST.end);
    await stop();
  });
});

test("a new file wakes it: the file is scanned and the old silences are gone", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    await host.park();
    // The same file again: its kept scan is used, the file is not read again.
    open(host, path);
    await until(host, () => !host.parked && ranges(host).length === 2);
    await host.settle(50);
    assert.equal(host.tools.calls.length, 3);
    // Another file: scanned, and only its silences are armed.
    await host.park();
    host.tools.handle("ffmpeg", fakeFfmpeg([{ start: 50, end: 53 }]));
    const other = path.replace("lecture", "other");
    await writeFile(other, "another fake video");
    open(host, other);
    await until(host, () => !host.parked && host.tools.calls.length === 6 && ranges(host).length === 1);
    assert.deepEqual(armed(host), [[50 + PAD, 53 - PAD]]);
    await stop();
  });
});

test("a seek into a silence jumps at once; one that lands inside it is not repeated", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    host.setSource({ position: 10.3 });
    await until(host, () => host.seeks.length === 1);
    assert.equal(host.seeks[0]!.seconds, FIRST.end);
    await until(host, () => host.osd.at(-1) === "Silence skipped · 0:02 saved");
    // The player's seek lands a frame short of the end, inside the silence: the same range, no new jump.
    host.setSource({ position: FIRST.end - 0.01 });
    await host.settle(50);
    assert.equal(host.seeks.length, 1);
    // The user goes back before it: it is skipped again, and the count starts again.
    host.setSource({ position: 2 });
    await host.settle();
    host.setSource({ position: 10.4 });
    await until(host, () => host.seeks.length === 2);
    await until(host, () => host.osd.length === 3);
    assert.equal(host.osd.at(-1), "Silence skipped · 0:02 saved");
    await stop();
  });
});

test("the time saved counts one playthrough: a replay starts from 0:00", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    host.setSource({ position: 10.3 });
    await until(host, () => host.osd.at(-1) === "Silence skipped · 0:02 saved");

    host.setSource({ phase: "ended", position: 300, terminalReason: "natural" });
    await host.settle();
    host.setSource({ phase: "ready", position: 0, paused: false });
    await host.settle();
    host.setSource({ position: 10.3 });
    await until(host, () => host.seeks.length === 2);
    await until(host, () => host.osd.at(-1) === "Silence skipped · 0:02 saved");
    await stop();
  });
});

test("no jump while paused; the resume inside the silence jumps", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    host.setSource({ position: 10.5, paused: true });
    await host.settle(50);
    assert.equal(host.seeks.length, 0);
    host.setSource({ paused: false });
    await until(host, () => host.seeks.length === 1);
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

    // A shorter minimum takes the 0.8 s pause too, without reading the file again.
    const calls = host.tools.calls.length;
    host.settingsPage("silenceskip").emit("minLengthChanged", 0.5);
    await until(host, () => ranges(host).length === 3 && armed(host)?.length === 3);
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

test("turning it off removes the marks, the trigger and the listener", async () => {
  await withFile(async (path) => {
    const { host, stop } = await playing(path, { enabled: true });
    await host.command("toggle").run();
    await host.settle();
    assert.deepEqual(ranges(host), []);
    assert.deepEqual(host.triggers, []);
    assert.equal(host.subscriptions.has("source.ready"), false);
    assert.deepEqual(host.keepsRunning, []);
    assert.equal(host.osd.at(-1), "Skip Silence: Off");
    host.setSource({ position: 10.5 });
    await host.settle(50);
    assert.equal(host.seeks.length, 0);
    await stop();
  });
});

test("the setting is remembered: on at the next start, with the file already open", async () => {
  await withFile(async (path) => {
    const first = await playing(path, { enabled: true });
    const data = first.host.dataDirectory;
    await first.host.settle(400);
    const host = new TestHost();
    host.tools.handle("ffmpeg", fakeFfmpeg(SILENCES));
    open(host, path);
    const copy = await mkdtemp(join(tmpdir(), "silenceskip-data-"));
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
    open(host, path);
    const { stop } = await startPlugin(activate, { directory, host });
    await host.command("toggle").run();
    await until(host, () => host.osd.length === 2);
    assert.equal(host.osd[1], "Silence Skipper needs ffmpeg, which was not found");
    // Also not after a standby.
    await host.park();
    open(host, path);
    await until(host, () => !host.parked);
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
    open(host, path);
    const { stop } = await startPlugin(activate, { directory, host });
    await host.command("toggle").run();
    await until(host, () => host.osd.length === 2);
    assert.equal(host.osd[1], "Silence Skipper cannot read the sound of this file");
    assert.equal(host.tools.calls.length, 1);
    assert.deepEqual(host.triggers, []);
    await stop();
  });
});

test("streams and addresses are not scanned", async () => {
  const host = new TestHost();
  host.tools.handle("ffmpeg", fakeFfmpeg(SILENCES));
  open(host, "https://example.com/talk.m3u8");
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
    open(host, path);
    const { stop } = await startPlugin(activate, { directory, host });
    await host.command("toggle").run();
    await host.settle(20);
    open(host, "https://example.com/other.mp4");
    await host.settle();
    release();
    await host.settle(100);
    assert.deepEqual(ranges(host), []);
    assert.equal(host.triggers.some((t) => t.entered), false);
    host.setSource({ position: 10.3 });
    await host.settle(50);
    assert.equal(host.seeks.length, 0);
    await stop();
  });
});

test("the seek bar and the trigger take at most the limit of ranges, the longest", async () => {
  await withFile(async (path) => {
    // 1100 pauses of 1.2–1.5 s in 55 minutes.
    const long = Array.from({ length: 1100 }, (_, i) => ({ start: i * 3, end: i * 3 + 1.2 + (i % 7) * 0.05 }));
    const host = new TestHost();
    host.tools.handle("ffmpeg", fakeFfmpeg(long));
    host.openElsewhere(path, "loading");
    host.setSource({ phase: "ready", duration: 3300, position: 0, paused: false });
    const { stop } = await startPlugin(activate, { directory, host });
    await host.command("toggle").run();
    await until(host, () => host.tools.calls.length === 28);
    await until(host, () => ranges(host).length === SHOWN_RANGES);
    assert.equal(armed(host)!.length, SHOWN_RANGES);
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
