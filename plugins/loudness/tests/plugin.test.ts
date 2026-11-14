import assert from "node:assert/strict";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { WINDOW_TITLE } from "../main.ts";
import { FILTER, METADATA } from "../meter.ts";

const directory = new URL("..", import.meta.url);
const ITEM = "loudness.window";
const HANDLE = "meter";
const ADD = ["af", "add", FILTER];
const REMOVE = ["af", "remove", "@loudness"];

/** What `ebur128=metadata=1:peak=true` tags 100 ms of stereo sound with (FFmpeg 9: strings; loudness in LUFS, peaks linear). */
const linear = (db: number) => (10 ** (db / 20)).toFixed(6);
const tags = (m: number, s: number, i: number, lra: number, peaks: [number, number]) => ({
  "lavfi.r128.M": m.toFixed(3),
  "lavfi.r128.S": s.toFixed(3),
  "lavfi.r128.I": i.toFixed(3),
  "lavfi.r128.LRA": lra.toFixed(3),
  "lavfi.r128.LRA.low": "-30.000",
  "lavfi.r128.LRA.high": "-20.000",
  "lavfi.r128.true_peaks_ch0": linear(peaks[0]),
  "lavfi.r128.true_peaks_ch1": linear(peaks[1]),
  "lavfi.r128.true_peak": linear(Math.max(...peaks)),
});

async function start(host = new TestHost()) {
  return startPlugin(activate, { directory, host });
}
const props = (host: TestHost) => host.window(HANDLE).props as Record<string, unknown>;

test("one Tools menu item; nothing goes to mpv and nothing keeps the plugin running until the window opens", async () => {
  const host = new TestHost();
  const { stop } = await start(host);
  try {
    assert.deepEqual(host.command(ITEM).declaration.path, ["@tools", WINDOW_TITLE]);
    assert.deepEqual(host.mpv.commands, []);
    assert.deepEqual([...host.mpv.observed], []);
    assert.deepEqual(host.keepsRunning, []);
  } finally {
    await stop();
  }
});

test("opening the window appends the measuring filter and observes its metadata; closing takes both away", async () => {
  const host = new TestHost();
  host.openElsewhere("/movie.mkv");
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    await host.settle();
    assert.equal(host.window(HANDLE).visible, true);
    assert.deepEqual(host.mpv.commands, [ADD]);
    assert.equal(host.mpv.labels.get("af/loudness"), "zysilm.loudness");
    assert.deepEqual([...host.mpv.observed], [METADATA]);
    assert.equal(props(host).status, "Waiting for sound…");
    assert.equal(props(host).momentary, "—");
    assert.equal(props(host)["can-restart"], true);

    host.window(HANDLE).userClose();
    await host.settle();
    assert.deepEqual(host.mpv.commands, [ADD, REMOVE]);
    assert.equal(host.mpv.labels.has("af/loudness"), false);
    assert.deepEqual([...host.mpv.observed], []);
    assert.deepEqual(host.keepsRunning, [], "a closed meter holds nothing");
  } finally {
    await stop();
  }
});

test("the filter's values show as the meter: rounded, with the highest true peak and a warning above −1 dBTP", async () => {
  const host = new TestHost();
  host.openElsewhere("/movie.mkv");
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    await host.settle();
    host.setMpvProperty(METADATA, tags(-18.234, -19.96, -70, 0, [-3.2, -2.04]));
    await host.settle();
    assert.equal(props(host).momentary, "−18.2");
    assert.equal(props(host)["short-term"], "−20.0");
    assert.equal(props(host).integrated, "—", "not gated yet: −70 LUFS");
    assert.equal(props(host).range, "0.0");
    assert.equal(props(host)["true-peak"], "−2.0");
    assert.equal(props(host)["peak-over"], false);
    assert.equal(props(host)["momentary-level"], 0.755); // (−18.234 + 59) / 54, to half a percent
    assert.equal(props(host).status, "Measuring");
    assert.equal(props(host).tone, 1);

    host.setMpvProperty(METADATA, tags(-12, -15, -21.46, 6.3, [-0.4, -5]));
    await host.settle();
    assert.equal(props(host).integrated, "−21.5");
    assert.equal(props(host).range, "6.3");
    assert.equal(props(host)["true-peak"], "−0.4");
    assert.equal(props(host)["peak-over"], true);

    // A quieter moment: ebur128 keeps its highest peak; the chain being rebuilt (no value) keeps the readings.
    host.setMpvProperty(METADATA, tags(-40, -30, -22, 6.5, [-0.4, -9]));
    host.setMpvProperty(METADATA, null);
    await host.settle();
    assert.equal(props(host).momentary, "−40.0");
    assert.equal(props(host)["true-peak"], "−0.4");

    // A seek: mpv starts a new ebur128, whose integrated value, range and peak start over; the meter shows
    // all three from the new filter, so the peak never describes sound the integrated value no longer covers.
    host.setMpvProperty(METADATA, tags(-30, -31, -70, 0, [-12, -14]));
    await host.settle();
    assert.equal(props(host).integrated, "—");
    assert.equal(props(host).range, "0.0");
    assert.equal(props(host)["true-peak"], "−12.0");
    assert.equal(props(host)["peak-over"], false);
    assert.deepEqual(host.mpv.commands, [ADD], "mpv's rebuild needs nothing from the plugin");

    host.setSource({ paused: true });
    await host.settle();
    assert.equal(props(host).status, "Paused: the values hold");
  } finally {
    await stop();
  }
});

test("Restart and another file start the measurement over with a fresh filter", async () => {
  const host = new TestHost();
  host.openElsewhere("/a.mkv");
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    await host.settle();
    host.setMpvProperty(METADATA, tags(-20, -20, -20, 3, [-1.5, -2]));
    await host.settle();
    assert.equal(props(host).integrated, "−20.0");

    // mpv drops `af-metadata/loudness` with the filter; the test host keeps the last value, so drop it here.
    host.mpv.properties.delete(METADATA);
    host.window(HANDLE).emit("restart");
    await host.settle();
    assert.deepEqual(host.mpv.commands, [ADD, REMOVE, ADD]);
    assert.equal(props(host).integrated, "—");
    assert.equal(props(host)["true-peak"], "—");
    assert.deepEqual([...host.mpv.observed], [METADATA]);

    host.setMpvProperty(METADATA, tags(-25, -25, -25, 2, [-6, -6]));
    await host.settle();
    host.mpv.properties.delete(METADATA);
    host.openElsewhere("/b.mkv");
    await host.settle();
    assert.deepEqual(host.mpv.commands, [ADD, REMOVE, ADD, REMOVE, ADD]);
    assert.equal(props(host).momentary, "—");
  } finally {
    await stop();
  }
});

test("nothing playing, no sound, and a filter the player refuses are said in the status line", async () => {
  const host = new TestHost();
  const { stop } = await start(host);
  try {
    await host.command(ITEM).run();
    await host.settle();
    assert.equal(props(host).status, "Nothing is playing");

    host.openElsewhere("/silent.mp4");
    host.setSource({ audioTracks: [] });
    await host.settle();
    assert.equal(props(host).status, "This media has no sound");
    host.window(HANDLE).userClose();
    await host.settle();
    const sent = host.mpv.commands.length;

    // Another plugin owns the label: `conflict`, shown, and nothing to restart.
    host.mpv.labels.set("af/loudness", "someone.else");
    await host.command(ITEM).run();
    await host.settle();
    assert.match(String(props(host).status), /^The meter could not start: /);
    assert.equal(props(host).tone, 3);
    assert.equal(props(host)["can-restart"], false);
    assert.deepEqual([...host.mpv.observed], [], "no observer without the filter");
    host.window(HANDLE).userClose();
    await host.settle();
    assert.deepEqual(host.mpv.commands.slice(sent), [], "a filter it could not add is not removed");
  } finally {
    await stop();
  }
});
