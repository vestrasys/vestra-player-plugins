import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import { analyse, emptyValues, pick, RATE, savedOf, scanSounds } from "../highlights.ts";
import type { Candidate } from "../highlights.ts";
import activate from "../main.ts";
import { allowedHost, CHECK_FAILED, checkFailed, DownloadError, MODEL_FILES, MODEL_MB, SoundModel } from "../soundmodel.ts";
import type { ModelFile, Progress } from "../soundmodel.ts";
import {
  baselines, BANDS, CLASS_COUNT, CLASSES, features, loudStrength, pieces, rankOf, ranked, risesOf, SAMPLE_RATE, samplesArgs, samplesOf, soundsOf, SOUNDS, strengthOf, TAG_SECONDS,
} from "../sounds.ts";
import type { Tag } from "../sounds.ts";
import { ModelError, startTagger } from "../tagger.ts";
import type { Tagger } from "../tagger.ts";
import { eventually } from "./fakes.ts";

const directory = new URL("..", import.meta.url);
const tick = () => new Promise((done) => setTimeout(done, 5));
async function until(predicate: () => boolean | Promise<boolean>, what = "condition") {
  for (let i = 0; i < 2000; i++) {
    if (await predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- the model's classes and input

test("the model's classes: laughter (5 AudioSet classes), applause (2), cheering, crowd; a piece's probability is its most likely class", () => {
  assert.deepEqual(CLASSES, { laughter: [16, 18, 19, 20, 21], applause: [67, 63], cheering: [66], crowd: [69] });
  const prob = new Float32Array(CLASS_COUNT);
  prob[19] = 0.4; // Snicker
  prob[16] = 0.2; // Laughter
  prob[63] = 0.7; // Clapping
  prob[69] = 0.12345;
  assert.deepEqual(soundsOf(prob, 30), { t: 30, laughter: 0.4, applause: 0.7, cheering: 0, crowd: 0.123 });
});

test("ffmpeg gives the sound as the model reads it: one stream, mono, 16 kHz, 16-bit; pieces of 10 s, a last one of at least 1 s", () => {
  const args = samplesArgs("/v/a.mkv", 300, 300, 2);
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 6), ["-ss", "300.000", "-t", "300.000", "-i", "/v/a.mkv"]);
  assert.equal(args[args.indexOf("-map") + 1], "0:a:2");
  assert.deepEqual(args.slice(-7), ["-ac", "1", "-ar", "16000", "-f", "s16le", "-"]);
  assert.ok(args.includes("-vn") && args.includes("-sn") && args.includes("-dn"));
  const bytes = new Uint8Array([0, 0x80, 0xff, 0x7f, 0, 0x40]);
  assert.deepEqual([...samplesOf(bytes)], [-1, 32767 / 32768, 0.5]);
  assert.deepEqual(pieces(SAMPLE_RATE * 25.5), [
    { offset: 0, length: SAMPLE_RATE * 10 }, { offset: SAMPLE_RATE * 10, length: SAMPLE_RATE * 10 }, { offset: SAMPLE_RATE * 20, length: SAMPLE_RATE * 5.5 },
  ]);
  assert.equal(pieces(SAMPLE_RATE * 20.5).length, 2, "half a second is not tagged");
});

test("the filterbank: 64 bands × one frame per 10 ms, band-major; a tone lights the band of its pitch", () => {
  const x = new Float32Array(SAMPLE_RATE * TAG_SECONDS);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE);
  const { data, frames } = features(x);
  assert.equal(frames, 1000);
  assert.equal(data.length, BANDS * frames);
  assert.ok(data.every(Number.isFinite));
  // Band energies of the middle frame: the loudest band holds 1 kHz (mel ≈ 1000 → band ~ 22 of 64 up to 8 kHz).
  const middle = Array.from({ length: BANDS }, (_, b) => data[b * frames + 500]!);
  const top = middle.indexOf(Math.max(...middle));
  assert.ok(top >= 18 && top <= 26, `band ${top}`);
  // Silence is the floor (−100 dB).
  assert.equal(features(new Float32Array(1600)).data[0], -100);
});

test("what stands out: a sound above its usual level in the video (stand-up has laughter all the time); strength in three steps; order by sounds, then loudness", () => {
  const tags: Tag[] = Array.from({ length: 20 }, (_, i) => ({ t: i * 10, laughter: 0.38, applause: 0.02, cheering: 0, crowd: 0.01 }));
  tags[5] = { ...tags[5]!, laughter: 0.7 };
  tags[6] = { ...tags[6]!, laughter: 0.45, applause: 0.6 };
  const base = baselines(tags);
  assert.deepEqual(base, { laughter: 0.38, applause: 0.02, cheering: 0, crowd: 0.01 });
  assert.deepEqual(risesOf(tags[0]!, base), {}, "the usual laughter of a stand-up show does not count");
  assert.deepEqual(risesOf(tags[5]!, base), { laughter: 0.52 });
  assert.deepEqual(risesOf(tags[6]!, base), { applause: 0.59 }, "laughter only a little above its usual level does not count");
  assert.deepEqual(risesOf({ t: 0, laughter: 0.1, applause: 0.19, cheering: 0, crowd: 0 }, { laughter: 0, applause: 0, cheering: 0, crowd: 0 }), {}, "under 0.2 nothing counts");
  assert.deepEqual([0.15, 0.3, 0.6].map(strengthOf), [1, 2, 3]);
  assert.deepEqual([5, 8, 12].map(loudStrength), [1, 2, 3]);
  assert.deepEqual(ranked({ crowd: 0.2, laughter: 0.5, applause: 0.2 }), ["laughter", "applause", "crowd"]);
  assert.deepEqual(ranked(undefined), []);
  const loud = { peak: 18 };
  const laugh = { peak: 2, sounds: { laughter: 0.3 } };
  assert.ok(rankOf(laugh) > rankOf(loud), "a sound before a loud moment alone");
  assert.ok(rankOf({ peak: 8, sounds: { laughter: 0.3 } }) > rankOf(laugh), "between equal sounds, the louder");
});

/** Talk at −30 LUFS with a short pause every 6 s; a loud reaction (−12) at 200–220 s; the rest as talk. */
const talk = (t: number) => (t >= 200 && t < 220 ? -12 : t % 6 < 0.8 ? -120 : -30);
function valuesOf(loud: (t: number) => number, duration: number) {
  const values = emptyValues(duration);
  for (let i = 0; i < values.length; i++) values[i] = Math.max(-70, loud(i / RATE));
  return values;
}
/** One tag per 10 s: applause on the loud reaction (200 s), laughter at 300–310 s that is no louder than the talk. */
const tagsOf = (duration: number): Tag[] =>
  Array.from({ length: Math.ceil(duration / 10) }, (_, i) => ({
    t: i * 10, laughter: i === 30 ? 0.8 : 0.05, applause: i === 20 || i === 21 ? 0.6 : 0.01, cheering: 0, crowd: i === 21 ? 0.3 : 0.02,
  }));

test("analyse with the model: a laugh no louder than the talk is a suggestion too, around its piece; the loud reaction gets the sounds it overlaps; sounds and loudness order them", () => {
  const duration = 600;
  const values = valuesOf(talk, duration);
  const plain = analyse(values, duration);
  assert.equal(plain.candidates.length, 1, "loudness alone finds the reaction only");
  assert.equal(plain.candidates[0]!.sounds, undefined);
  const result = analyse(values, duration, tagsOf(duration));
  assert.equal(result.candidates.length, 2);
  const [first, second] = result.candidates as [Candidate, Candidate];
  // The loud applause first (its sounds and its loudness), then the quiet laugh.
  assert.ok(first.start < 200 && first.end > 210, `${first.start}–${first.end}`);
  assert.deepEqual(first.sounds, { applause: 0.6, crowd: 0.29 });
  assert.deepEqual(second.sounds, { laughter: 0.79 });
  assert.ok(second.start < 300 && second.end > 300 && second.end <= 320, `${second.start}–${second.end}`);
  assert.ok(second.start >= 300 - 60, "it starts at the pause before it, at most 60 s before");
  assert.deepEqual(pick(result.candidates, 1, {}).left.map((c) => c.id), [first.id]);
  // Silence: nothing, whatever the tags say.
  assert.deepEqual(analyse(valuesOf(() => -120, 60), 60, tagsOf(60)).candidates, []);
});

test("a kept scan with the model: mode sounds, each suggestion's sounds kept (bad ones dropped); one from 0.6.3 (loudness) still reads", () => {
  const base = { version: 1, path: "/v.mp4", size: 1, mtimeMs: 1, stream: 0, scanned: 1, duration: 60, average: -30, curve: [], handled: {}, edits: {} };
  const read = savedOf({ ...base, mode: "sounds", candidates: [{ id: "1", start: 1, end: 9, peak: 3, sounds: { laughter: 0.5, applause: "x", cheering: -1, crowd: 7 } }, { id: "2", start: 10, end: 20, peak: 4 }] });
  assert.equal(read?.mode, "sounds");
  assert.deepEqual(read?.candidates, [{ id: "1", start: 1, end: 9, peak: 3, sounds: { laughter: 0.5, crowd: 1 } }, { id: "2", start: 10, end: 20, peak: 4 }]);
  assert.equal(savedOf({ ...base, mode: "loudness", candidates: [] })?.mode, "loudness");
  assert.equal(savedOf({ ...base, mode: "video", candidates: [] }), null);
});

test("the scan with the model: per window ffmpeg's loudness, then the samples; the model tags a window while ffmpeg reads the next; progress after each", async () => {
  const order: string[] = [];
  let tagging = 0;
  let overlapped = false;
  const run = async (args: string[]) => {
    const from = Number(args[args.indexOf("-ss") + 1]);
    const length = Number(args[args.indexOf("-t") + 1]);
    if (args.includes("s16le")) {
      order.push(`pcm ${Math.round(from)}`);
      if (tagging) overlapped = true;
      return { stdout: new Uint8Array(Math.round(length * SAMPLE_RATE) * 2) };
    }
    order.push(`loud ${Math.round(from)}`);
    return { stdout: new Uint8Array() };
  };
  const tag = async (samples: Float32Array, t: number) => {
    tagging++;
    await tick();
    tagging--;
    order.push(`tag ${t}`);
    return pieces(samples.length).map(({ offset }) => ({ t: t + offset / SAMPLE_RATE, laughter: 0, applause: 0, cheering: 0, crowd: 0 }));
  };
  const progress: number[] = [];
  const { tags } = await scanSounds(run, tag, "/v.mp4", 0, 250, { signal: new AbortController().signal, window: 100, between: (done) => void progress.push(done) });
  assert.deepEqual(tags.map((t) => t.t), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240]);
  assert.deepEqual(progress, [100, 200, 250]);
  assert.deepEqual(order.slice(0, 3), ["loud 0", "pcm 0", "loud 100"]);
  assert.ok(overlapped || order.indexOf("tag 0") > order.indexOf("loud 100"), "the next window is read while the model tags");
  // A cancel stops it between runs.
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(scanSounds(run, tag, "/v.mp4", 0, 250, { signal: abort.signal }));
});

// ---------------------------------------------------------------- the model's files

const fileOf = (name: string, bytes: Uint8Array): ModelFile => ({ name, url: `https://huggingface.co/x/${name}`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
/** A fetch that answers each URL with its bytes (in two chunks), optionally from another host. */
function fetchOf(bodies: Record<string, Uint8Array>, options: { url?: (url: string) => string; status?: number } = {}) {
  const calls: string[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    const bytes = bodies[String(url)] ?? new Uint8Array();
    const half = bytes.length >> 1;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await tick();
        if (init?.signal?.aborted) return controller.error(init.signal.reason);
        if (!controller.desiredSize) return;
        controller.enqueue(bytes.slice(0, half));
        controller.enqueue(bytes.slice(half));
        controller.close();
      },
    });
    const response = new Response(body, { status: options.status ?? 200 });
    Object.defineProperty(response, "url", { value: options.url ? options.url(String(url)) : String(url) });
    return response;
  }) as typeof fetch;
  return { fetch: fake, calls };
}

test("the model's files: the pinned two (model 10.4 MB from Hugging Face at a commit, runtime 14.8 MB from jsDelivr), 25 MB; downloads end on those hosts only, over HTTPS", () => {
  assert.equal(MODEL_MB, 25);
  assert.deepEqual(MODEL_FILES.map((file) => [file.name, file.size, file.sha256.length]), [["ced-mini.int8.onnx", 10_451_715, 64], ["ort-wasm-simd-threaded.wasm", 14_848_852, 64]]);
  assert.match(MODEL_FILES[0]!.url, /^https:\/\/huggingface\.co\/k2-fsa\/sherpa-onnx-ced-mini-audio-tagging-2024-04-19\/resolve\/[0-9a-f]{40}\/model\.int8\.onnx$/);
  assert.equal(MODEL_FILES[1]!.url, "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.wasm");
  assert.deepEqual(
    ["https://huggingface.co/a", "https://us.aws.cdn.hf.co/x", "https://cdn-lfs-us-1.huggingface.co/x", "https://cdn.jsdelivr.net/npm/x", "http://huggingface.co/a", "https://example.com/x", "https://hf.co.example.com/x", "nonsense"].map(allowedHost),
    [true, true, true, true, false, false, false, false],
  );
});

test("download: both files with progress, kept only when they match their SHA-256; then loaded, its bytes checked on every load (a file swapped with the same size and time, or cut short, is deleted); Remove deletes them", async () => {
  const folder = join(await mkdtemp(join(tmpdir(), "clipexport-model-")), "sound-model");
  try {
    const a = new Uint8Array(1000).fill(7);
    const b = new Uint8Array(3000).fill(9);
    const files = [fileOf("m.onnx", a), fileOf("r.wasm", b)];
    const { fetch, calls } = fetchOf({ [files[0]!.url]: a, [files[1]!.url]: b });
    const model = new SoundModel({ folder, fetch, files });
    assert.equal(await model.installed(), false);
    assert.equal(await model.load(), null);
    const seen: Progress[] = [];
    const first = model.download((p) => seen.push(p));
    assert.equal(model.download(() => {}), first, "one download at a time");
    await first;
    assert.equal(calls.length, 2);
    assert.deepEqual(seen.at(-1), { received: 4000, total: 4000 });
    assert.ok(seen.some((p) => p.received > 0 && p.received < 4000));
    assert.equal(await model.installed(), true);
    assert.deepEqual((await readdir(folder)).sort(), ["m.onnx", "r.wasm"], "no temporary file left");
    const loaded = await model.load();
    assert.deepEqual([loaded?.model.length, loaded?.wasm.length], [1000, 3000]);
    // A file swapped on disk with the same size and the same modification time: its bytes decide, on every load.
    // Not loaded, deleted, so the page asks for the download again.
    const before = await stat(join(folder, "m.onnx"));
    await writeFile(join(folder, "m.onnx"), new Uint8Array(1000).fill(8));
    await utimes(join(folder, "m.onnx"), before.atime, before.mtime);
    assert.equal(await model.load(), null);
    assert.equal(existsSync(join(folder, "m.onnx")), false);
    // A second download fetches only what is missing.
    await model.download(() => {});
    assert.equal(calls.length, 3);
    assert.ok(await model.load());
    // A file of another length (cut short): deleted too.
    await writeFile(join(folder, "r.wasm"), b.subarray(0, 2000));
    assert.equal(await model.load(), null);
    assert.equal(existsSync(join(folder, "r.wasm")), false);
    assert.equal(await model.installed(), false);
    await model.download(() => {});
    assert.equal(calls.length, 4);
    await model.remove();
    assert.equal(existsSync(folder), false);
    assert.equal(await model.installed(), false);
  } finally {
    await rm(join(folder, ".."), { recursive: true, force: true });
  }
});

test("download failures: checksum (nothing kept), offline, an HTTP error, a redirect to another host, Cancel (the partial file goes), no data folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "clipexport-model-"));
  const folder = join(root, "sound-model");
  const kind = async (promise: Promise<void>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      assert.ok(error instanceof DownloadError, String(error));
      return error.kind;
    }
  };
  try {
    const good = new Uint8Array(500).fill(1);
    const files = [fileOf("m.onnx", good)];
    const url = files[0]!.url;
    assert.equal(await kind(new SoundModel({ folder, files, fetch: fetchOf({ [url]: new Uint8Array(500).fill(2) }).fetch }).download(() => {})), "checksum");
    assert.equal(await kind(new SoundModel({ folder, files, fetch: fetchOf({ [url]: new Uint8Array(900) }).fetch }).download(() => {})), "checksum", "larger than pinned");
    assert.deepEqual(await readdir(folder), [], "nothing kept");
    const offline = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }) as unknown as typeof fetch;
    assert.equal(await kind(new SoundModel({ folder, files, fetch: offline }).download(() => {})), "offline");
    const failed = new SoundModel({ folder, files, fetch: fetchOf({ [url]: good }, { status: 503 }).fetch });
    await assert.rejects(failed.download(() => {}), (error: DownloadError) => error.kind === "failed" && error.message === "HTTP 503");
    const moved = new SoundModel({ folder, files, fetch: fetchOf({ [url]: good }, { url: () => "https://example.com/m.onnx" }).fetch });
    await assert.rejects(moved.download(() => {}), (error: DownloadError) => error.kind === "failed" && /unexpected host/.test(error.message));
    // Cancel while the body arrives.
    const slow = (async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(good.slice(0, 100));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
        },
      });
      const response = new Response(body);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }) as unknown as typeof fetch;
    const cancelled = new SoundModel({ folder, files, fetch: slow });
    const running = kind(cancelled.download(() => {}));
    await until(async () => (await readdir(folder)).length > 0, "the partial file");
    assert.equal(cancelled.downloading, true);
    cancelled.cancel();
    assert.equal(await running, "cancelled");
    assert.deepEqual(await readdir(folder), [], "the partial file is gone");
    // A stall ends it too.
    assert.equal(await kind(new SoundModel({ folder, files, fetch: slow, stall: 30 }).download(() => {})), "failed");
    assert.equal(await kind(new SoundModel({ folder: null, files }).download(() => {})), "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the page

const TRACK = [{ trackId: 1, selected: true, external: false, streamIndex: 1, codec: "aac", title: null, language: null }];
type Page = Record<string, unknown> & { state: string; model: string; reason: string; loudness: boolean };
type Row = { id: string; kind: string; kind2: string; level: number; level1: number; level2: number; restore: number };
const tab = (host: TestHost) => host.mounted().props;
const page = (host: TestHost) => (tab(host).highlights ?? {}) as Page;
const rows = (host: TestHost) => ((tab(host)["highlight-rows"] ?? []) as Row[]).filter((row) => row.restore === 0);

/** ffmpeg as the scan runs it: the loudness of `talk` per 100 ms, and silent samples of the window's length. */
function fakeFfmpeg(host: TestHost, loud: (t: number) => number = talk) {
  host.tools.handle("ffmpeg", (args) => {
    const at = Number(args[args.indexOf("-ss") + 1]);
    const length = Number(args[args.indexOf("-t") + 1]);
    if (args.includes("s16le")) return { stdout: new Uint8Array(Math.round(length * SAMPLE_RATE) * 2) };
    if (!args.some((arg) => arg.includes("ebur128"))) return { stdout: "" };
    let out = "";
    for (let k = 0; 0.00533 + (k + 1) * 0.1 <= length + 1e-6; k++) {
      const time = 0.00533 + k * 0.1;
      out += `frame:${k} pts:${k * 4800} pts_time:${time}\nlavfi.r128.M=${loud(at + time).toFixed(3)}\n`;
    }
    return { stdout: out };
  });
}
const pcmRuns = (host: TestHost) => host.tools.calls.filter((call) => call.tool === "ffmpeg" && call.args.includes("s16le")).length;
const loudRuns = (host: TestHost) => host.tools.calls.filter((call) => call.tool === "ffmpeg" && call.args.some((arg) => arg.includes("ebur128"))).length;

/** The model's files as the plugin sees them, without a network or disk: `outcome` decides how a download ends. */
class FakeModel {
  folder = "/fake/sound-model";
  present: boolean;
  downloads = 0;
  removed = 0;
  outcome: "ok" | DownloadError = "ok";
  #cancel: (() => void) | null = null;
  #gate: Promise<void> | null = null;
  #open: (() => void) | null = null;
  constructor(present = false) {
    this.present = present;
  }
  get downloading() {
    return !!this.#cancel;
  }
  /** Hold the next download half-way until `release()`. */
  hold() {
    this.#gate = new Promise((done) => (this.#open = done));
  }
  release() {
    this.#open?.();
    this.#gate = null;
  }
  async installed() {
    return this.present;
  }
  async load() {
    return this.present ? { model: new Uint8Array([1]), wasm: new Uint8Array([2]) } : null;
  }
  async download(progress: (p: Progress) => void) {
    this.downloads++;
    const total = MODEL_MB * 1e6;
    progress({ received: 0, total });
    await new Promise<void>((done, fail) => {
      this.#cancel = () => fail(new DownloadError("cancelled"));
      const gate = this.#gate ?? Promise.resolve();
      progress({ received: total / 2, total });
      void gate.then(() => done());
    }).finally(() => (this.#cancel = null));
    if (this.outcome !== "ok") throw this.outcome;
    progress({ received: total, total });
    this.present = true;
  }
  cancel() {
    this.#cancel?.();
  }
  async remove() {
    this.present = false;
    this.removed++;
  }
}

/** The model's answers: the sounds of `tagsOf` for the pieces asked; `fail` makes it not start. */
function fakeTagger(state: { started: number; closed: number; fail?: boolean } = { started: 0, closed: 0 }) {
  const start = async (): Promise<Tagger> => {
    state.started++;
    if (state.fail) throw new ModelError("WebAssembly.instantiate(): out of memory");
    return {
      async tag(samples: Float32Array, t: number) {
        const all = tagsOf(10_000);
        return pieces(samples.length).map(({ offset }) => all[Math.round((t + offset / SAMPLE_RATE) / 10)]!);
      },
      async close() {
        state.closed++;
      },
    };
  };
  return { start, state };
}

async function withMedia() {
  const folder = await mkdtemp(join(tmpdir(), "clipexport-snd-media-"));
  const data = await mkdtemp(join(tmpdir(), "clipexport-snd-data-"));
  const media = join(folder, "standup.mp4");
  await writeFile(media, "media bytes");
  return {
    media, data,
    play(host: TestHost, path = media) {
      host.openElsewhere(path);
      host.setSource({ position: 2, duration: 600, audioTracks: TRACK });
    },
    cleanup: () => Promise.all([rm(folder, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]),
  };
}
async function start(host: TestHost, data: string, model: FakeModel, tagger = fakeTagger(), locale: "en" | "zh-Hans" = "en") {
  const options = { soundModel: model as unknown as SoundModel, tagger: tagger.start };
  const started = await startPlugin((plugin) => activate(plugin, options), { directory, host, locale, dataDirectory: data });
  await host.command("clip.settings").run();
  await host.settle();
  host.mounted().emit("set-page", 1);
  await host.settle();
  await eventually(() => tab(host).page, 1);
  return started;
}

test("F1: a file not scanned without the model offers Download and Scan (its 25 MB) and Loudness Only; nothing is fetched before the click; the command never downloads", async () => {
  const setup = await withMedia();
  const host = new TestHost();
  fakeFfmpeg(host);
  setup.play(host);
  const model = new FakeModel();
  const { stop } = await start(host, setup.data, model);
  try {
    await eventually(() => page(host).state, "ready");
    assert.equal(page(host).model, "none");
    assert.equal(page(host)["model-mb"], 25);
    await host.command("clip.highlights").run();
    await host.settle();
    assert.equal(model.downloads, 0, "the command never downloads");
    assert.equal(loudRuns(host), 0, "nor scans without the model or a Loudness Only choice");
    // Loudness Only: a scan without the model, remembered (the command then scans that way too).
    host.mounted().emit("loudness-only");
    await eventually(() => page(host).state, "done");
    assert.equal(page(host).loudness, true);
    assert.equal(pcmRuns(host), 0);
    await eventually(() => rows(host).map((row) => [row.kind, row.kind2, row.level]), [["loud", "", 3]], "+18 LU is strong");
    await until(async () => JSON.parse(await readFile(join(setup.data, "settings.json"), "utf8").catch(() => "{}")).highlightLoudness === true, "Loudness Only kept");
    assert.equal(model.downloads, 0);
  } finally {
    await stop();
    await setup.cleanup();
  }
});

test("Download and Scan: F2 shows the download (MB, Cancel); when it finishes the file is scanned with the model: kinds, strength, the strongest sound first; Settings ▸ Remove offers it again", async () => {
  const setup = await withMedia();
  const host = new TestHost();
  fakeFfmpeg(host);
  setup.play(host);
  const model = new FakeModel();
  const tagger = fakeTagger();
  const { stop } = await start(host, setup.data, model, tagger);
  try {
    await eventually(() => page(host).state, "ready");
    model.hold();
    host.mounted().emit("download-model");
    await eventually(() => page(host).model, "downloading");
    await eventually(() => page(host)["dl-done"], 12);
    assert.equal(page(host)["dl-total"], 25);
    assert.equal(loudRuns(host), 0, "the scan waits for the download");
    model.release();
    await eventually(() => page(host).state, "done", "the scan starts when it finishes");
    assert.equal(page(host).model, "installed");
    assert.equal(page(host).loudness, false);
    assert.equal(page(host)["only-loud"], false);
    assert.equal(pcmRuns(host), 2, "two windows of samples for 600 s");
    assert.deepEqual(tagger.state, { started: 1, closed: 1 }, "the model's thread ends with the scan");
    await eventually(() => rows(host).map((row) => [row.kind, row.kind2, row.level, row.level1, row.level2]), [
      ["applause", "crowd", 3, 3, 2],
      ["laughter", "", 3, 3, 0],
    ], "in time order; both sounds of the loud reaction");
    // Settings ▸ Remove: the files go, the page offers the download again above a file not scanned.
    host.mounted().emit("remove-model");
    await eventually(() => page(host).model, "none");
    assert.equal(model.removed, 1);
    assert.equal(page(host).state, "done", "the kept result stays");
  } finally {
    await stop();
    await setup.cleanup();
  }
});

test("F2 Cancel goes back to F1; F3 failed (with its reason), F4 checksum, F5 offline offer Retry or Download Again and Loudness Only; the model not starting says so (Loudness Only still works)", async () => {
  const setup = await withMedia();
  const host = new TestHost();
  fakeFfmpeg(host);
  setup.play(host);
  const model = new FakeModel();
  const tagger = fakeTagger({ started: 0, closed: 0, fail: true });
  const { stop } = await start(host, setup.data, model, tagger, "zh-Hans");
  try {
    await eventually(() => page(host).state, "ready");
    model.hold();
    host.mounted().emit("download-model");
    await eventually(() => page(host).model, "downloading");
    host.mounted().emit("cancel-download");
    await eventually(() => page(host).model, "none");
    model.release();
    for (const [error, shown] of [[new DownloadError("failed", "HTTP 503"), "failed"], [new DownloadError("checksum"), "checksum"], [new DownloadError("offline", "ENOTFOUND"), "offline"]] as const) {
      model.outcome = error;
      host.mounted().emit("download-model");
      await eventually(() => page(host).model, shown);
      assert.equal(page(host)["dl-reason"], shown === "failed" ? "HTTP 503" : "");
      assert.equal(page(host).state, "ready");
    }
    assert.equal(loudRuns(host), 0);
    // Downloaded, but the model will not start on this computer: the page's red line, no result.
    model.outcome = "ok";
    host.mounted().emit("download-model");
    await eventually(() => page(host).reason, "modelFailed");
    assert.equal(page(host).state, "error");
    assert.equal(page(host).model, "installed");
    host.mounted().emit("loudness-only");
    await eventually(() => page(host).state, "done");
    assert.equal(page(host).loudness, true);
  } finally {
    await stop();
    await setup.cleanup();
  }
});

test("R4: a scan with the model that finds only loud moments says so; the command scans with the model once it is there", async () => {
  const setup = await withMedia();
  const host = new TestHost();
  fakeFfmpeg(host);
  setup.play(host);
  const model = new FakeModel(true);
  const quiet = {
    started: 0, closed: 0,
    start: async (): Promise<Tagger> => ({
      async tag(samples: Float32Array, t: number) {
        return pieces(samples.length).map(({ offset }) => ({ t: t + offset / SAMPLE_RATE, laughter: 0.01, applause: 0.01, cheering: 0, crowd: 0.01 }));
      },
      async close() {},
    }),
  };
  const { stop } = await start(host, setup.data, model, { start: quiet.start, state: quiet });
  try {
    await eventually(() => page(host).model, "installed");
    await host.command("clip.highlights").run();
    await eventually(() => page(host).state, "done");
    assert.equal(page(host).loudness, false);
    assert.equal(page(host)["only-loud"], true);
    await eventually(() => rows(host).map((row) => row.kind), ["loud"]);
  } finally {
    await stop();
    await setup.cleanup();
  }
});

// ---------------------------------------------------------------- the real model (needs its files)

/**
 * With the real files (VESTRA_SOUND_MODEL_DIR: a folder with ced-mini.int8.onnx and
 * ort-wasm-simd-threaded.wasm, as the plugin downloads them): the model's thread starts, tags a tone, laughs at
 * nothing, and ends.
 */
const realDir = process.env.VESTRA_SOUND_MODEL_DIR;
test("the model's thread with the real files: starts, tags 25 s in three pieces, ends", { skip: !realDir && "no model files (set VESTRA_SOUND_MODEL_DIR)" }, async () => {
  const model = new SoundModel({ folder: realDir! });
  const files = await model.load();
  assert.ok(files, "the files match their pinned SHA-256");
  const tagger = await startTagger(files.wasm, files.model, new AbortController().signal);
  try {
    const x = new Float32Array(SAMPLE_RATE * 25);
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
    const tags = await tagger.tag(x, 100);
    assert.deepEqual(tags.map((tag) => tag.t), [100, 110, 120]);
    for (const tag of tags) for (const sound of SOUNDS) assert.ok(tag[sound] >= 0 && tag[sound] < 0.2, `${sound} ${tag[sound]}`);
  } finally {
    await tagger.close();
  }
  await assert.rejects(startTagger(new Uint8Array([0, 1, 2]), new Uint8Array([3]), new AbortController().signal), ModelError, "a broken runtime is the model failing");
});

// ---------------------------------------------------------------- 0.6.5: a failed re-check, the plugin stopping during a download

/** The plugin with a real `SoundModel` (files in the test's data folder, a fake fetch), at the Highlights page. */
async function startWith(host: TestHost, data: string, soundModel: SoundModel, tagger = fakeTagger()) {
  const started = await startPlugin((plugin) => activate(plugin, { soundModel, tagger: tagger.start }), { directory, host, dataDirectory: data });
  await host.command("clip.settings").run();
  await host.settle();
  host.mounted().emit("set-page", 1);
  await host.settle();
  await eventually(() => tab(host).page, 1);
  return started;
}

/** A fetch whose body sends 100 bytes and then waits until the download is aborted; `signal` is the last one it got. */
function hangingFetch(file: ModelFile, bytes: Uint8Array) {
  const seen: { signal?: AbortSignal } = {};
  const fetch = (async (_url: string, init?: RequestInit) => {
    seen.signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 100));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
      },
    });
    const response = new Response(body);
    Object.defineProperty(response, "url", { value: file.url });
    return response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}
const partial = async (folder: string) => (await readdir(folder).catch(() => [] as string[])).some((name) => name.startsWith(".download-"));

test("a file that fails its check on a load is deleted and leaves a mark until the next download; Cancel settles once the partial file is gone", async () => {
  const folder = join(await mkdtemp(join(tmpdir(), "clipexport-model-")), "sound-model");
  try {
    const a = new Uint8Array(1000).fill(7);
    const files = [fileOf("m.onnx", a)];
    const model = new SoundModel({ folder, files, fetch: fetchOf({ [files[0]!.url]: a }).fetch });
    await model.download(() => {});
    assert.equal(await checkFailed(folder), false);
    await writeFile(join(folder, "m.onnx"), new Uint8Array(1000).fill(8));
    assert.equal(await model.load(), null);
    assert.deepEqual(await readdir(folder), [CHECK_FAILED], "the file went, the mark stays");
    assert.equal(await checkFailed(folder), true);
    assert.equal(await checkFailed(null), false);
    await model.download(() => {});
    assert.deepEqual(await readdir(folder), ["m.onnx"], "a download ends the mark");
    assert.ok(await model.load());
    // Cancel (and so the plugin stopping) waits for the partial file to go.
    await rm(join(folder, "m.onnx"));
    const { fetch, seen } = hangingFetch(files[0]!, a);
    const cancelled = new SoundModel({ folder, files, fetch });
    const running = cancelled.download(() => {}).then(
      () => "ok",
      (error: DownloadError) => error.kind,
    );
    await until(() => partial(folder), "the partial file");
    await cancelled.cancel();
    assert.equal(seen.signal?.aborted, true);
    assert.deepEqual(await readdir(folder), [], "gone when Cancel settles");
    assert.equal(await running, "cancelled");
    assert.equal(cancelled.downloading, false);
    await cancelled.cancel();
  } finally {
    await rm(join(folder, ".."), { recursive: true, force: true });
  }
});

test("F4 after a failed re-check: Scan Again with a file that fails its check shows the checksum state and Download Again, never a scan by loudness alone; it stays after a restart; Download Again scans with the model", async () => {
  const setup = await withMedia();
  const folder = join(setup.data, "sound-model");
  const a = new Uint8Array(1000).fill(7);
  const b = new Uint8Array(3000).fill(9);
  const files = [fileOf("m.onnx", a), fileOf("r.wasm", b)];
  const { fetch, calls } = fetchOf({ [files[0]!.url]: a, [files[1]!.url]: b });
  await new SoundModel({ folder, files, fetch }).download(() => {});
  const host = new TestHost();
  fakeFfmpeg(host);
  setup.play(host);
  const tagger = fakeTagger();
  const first = await startWith(host, setup.data, new SoundModel({ folder, files, fetch }), tagger);
  try {
    await eventually(() => page(host).model, "installed");
    await eventually(() => page(host).state, "ready");
    host.mounted().emit("find-highlights");
    await eventually(() => page(host).state, "done");
    assert.equal(page(host).loudness, false, "scanned with the model");
    const runs = loudRuns(host);
    // The model's file changes on disk (same size): Scan Again finds it failing its check.
    await writeFile(join(folder, "m.onnx"), new Uint8Array(1000).fill(8));
    host.mounted().emit("find-highlights");
    await eventually(() => page(host).model, "checksum", "F4");
    await eventually(() => page(host).state, "ready", "the offer above the file: Download Again and Loudness Only");
    assert.equal(loudRuns(host), runs, "no scan by loudness alone");
    assert.equal(existsSync(join(folder, "m.onnx")), false, "the file that failed was deleted");
    // Asked again (Scan Again, the command): the offer again, still no scan.
    host.mounted().emit("find-highlights");
    await host.command("clip.highlights").run();
    await host.settle();
    assert.deepEqual([page(host).model, page(host).state, loudRuns(host)], ["checksum", "ready", runs]);
    await first.stop();

    // A restart (the plugin stopped while idle, the player restarted): F4 still, never F1 or a silent scan.
    const again = new TestHost();
    fakeFfmpeg(again);
    setup.play(again);
    const second = await startWith(again, setup.data, new SoundModel({ folder, files, fetch }), tagger);
    try {
      await eventually(() => page(again).model, "checksum");
      await eventually(() => page(again).state, "done", "the kept result of the file");
      again.mounted().emit("find-highlights");
      await eventually(() => page(again).state, "ready", "Scan Again: the offer");
      assert.equal(loudRuns(again), 0);
      // Download Again: only the deleted file is fetched; the scan then runs with the model.
      const before = calls.length;
      again.mounted().emit("download-model");
      await eventually(() => page(again).model, "installed");
      await eventually(() => page(again).state, "done");
      assert.equal(page(again).loudness, false, "with the model");
      assert.deepEqual(calls.slice(before), [files[0]!.url]);
      assert.equal(await checkFailed(folder), false);
    } finally {
      await second.stop();
    }
  } finally {
    await first.stop().catch(() => {});
    await setup.cleanup();
  }
});

test("F4: Loudness Only stays the user's choice (the button, then its saved setting); F5 and F3 through a fake fetch: no connection, an HTTP error", async () => {
  const setup = await withMedia();
  const folder = join(setup.data, "sound-model");
  const a = new Uint8Array(1000).fill(7);
  const files = [fileOf("m.onnx", a)];
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, CHECK_FAILED), "");
  let mode: "offline" | "503" = "offline";
  const failing = fetchOf({ [files[0]!.url]: a }, { status: 503 });
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (mode === "offline") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    return failing.fetch(url, init);
  }) as typeof globalThis.fetch;
  const host = new TestHost();
  fakeFfmpeg(host);
  setup.play(host);
  const { stop } = await startWith(host, setup.data, new SoundModel({ folder, files, fetch }));
  try {
    await eventually(() => page(host).model, "checksum", "F4 from the mark a load left");
    await eventually(() => page(host).state, "ready");
    // Loudness Only, chosen in F4: a scan without the model; Scan Again then measures loudness too (the saved choice).
    host.mounted().emit("loudness-only");
    await eventually(() => page(host).state, "done");
    assert.equal(page(host).loudness, true);
    const runs = loudRuns(host);
    host.mounted().emit("find-highlights");
    await until(() => loudRuns(host) > runs, "Scan Again by loudness, as chosen");
    await eventually(() => page(host).state, "done");
    assert.equal(page(host).model, "checksum");
    // Another file, not scanned: Download Again without a connection (F5), then an HTTP error (F3).
    const other = join(dirname(setup.media), "other.mp4");
    await writeFile(other, "other bytes");
    setup.play(host, other);
    await eventually(() => page(host).state, "ready");
    host.mounted().emit("download-model");
    await eventually(() => page(host).model, "offline", "F5");
    mode = "503";
    host.mounted().emit("download-model");
    await eventually(() => page(host).model, "failed", "F3");
    assert.equal(page(host)["dl-reason"], "HTTP 503");
    assert.equal(page(host).state, "ready");
    assert.equal(existsSync(join(folder, "m.onnx")), false);
  } finally {
    await stop();
    await setup.cleanup();
  }
});

test("the plugin stopping during the model's download aborts it and deletes the partial file", async () => {
  const setup = await withMedia();
  const folder = join(setup.data, "sound-model");
  const a = new Uint8Array(1000).fill(7);
  const files = [fileOf("m.onnx", a)];
  const { fetch, seen } = hangingFetch(files[0]!, a);
  const host = new TestHost();
  fakeFfmpeg(host);
  setup.play(host);
  const soundModel = new SoundModel({ folder, files, fetch });
  const { stop } = await startWith(host, setup.data, soundModel);
  try {
    await eventually(() => page(host).state, "ready");
    host.mounted().emit("download-model");
    await eventually(() => page(host).model, "downloading");
    await until(() => partial(folder), "the partial file");
    await stop();
    assert.equal(seen.signal?.aborted, true, "the download was aborted");
    assert.equal(soundModel.downloading, false);
    assert.deepEqual(await readdir(folder), [], "no partial file left");
    assert.equal(loudRuns(host), 0);
  } finally {
    await stop().catch(() => {});
    await setup.cleanup();
  }
});
