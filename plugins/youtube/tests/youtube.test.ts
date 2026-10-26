import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate from "../main.ts";
import { descriptorFromInfo, normalizeYouTubeUrl, reason, YouTubeService } from "../service.ts";
import type { Progress, Runner } from "../service.ts";
import type { TextError } from "@vestra-player/sdk";

const directory = new URL("..", import.meta.url);
type Locale = "en" | "zh-Hans";
/** `plugin.i18n` with this package's Simplified Chinese catalog, for the service tests (no host calls). */
const zh = await (async () => {
  const { plugin, stop } = await startPlugin(() => {}, { directory, locale: "zh-Hans" });
  await stop();
  return plugin.i18n;
})();
/** What a Simplified Chinese user reads for an error the service threw. */
const shown = (error: unknown) => zh.resolve((error as TextError).text);
const watch = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
/** A runner that never reaches the network: version check passes, anything else is refused. */
const offline: Runner = async (args) => {
  if (args.includes("--version")) return "2026.08.19";
  throw new Error("offline test runner");
};
/** The window tests play a Simplified Chinese user: the texts are the ones the plugin showed before English source text. */
const start = (runner: Runner = offline, host = new TestHost(), locale: Locale = "zh-Hans") =>
  startPlugin((plugin) => activate(plugin, new YouTubeService(plugin.i18n, runner)), { directory, host, locale });
async function openWindow(host: TestHost) {
  await host.command("youtube.open").run();
  return host.window("youtube");
}
const opens = (host: TestHost) =>
  host.sent("source.submit").filter((call) => (call.intent as { kind: string }).kind === "open");
/**
 * Retry `assertion` until it passes (or rethrow its last failure after `ms`).
 * `host.settle()` only waits for host calls; a download also does file-system work in the
 * plugin (staging directory, readdir/stat/rename, cleanup), which it cannot see.
 */
async function eventually(host: TestHost, assertion: () => void, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    await host.settle();
    try {
      return assertion();
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------- service (no host involved)

test("normalizes video forms and rejects lookalike domains, credentials, playlists and shell text", () => {
  for (const value of [
    "https://youtu.be/BaW_jenozKc?t=2",
    "https://www.youtube.com/shorts/BaW_jenozKc",
    "https://music.youtube.com/watch?v=BaW_jenozKc&list=abc",
  ])
    assert.equal(normalizeYouTubeUrl(value, zh.error), "https://www.youtube.com/watch?v=BaW_jenozKc");
  for (const value of [
    "https://youtube.com.evil/watch?v=BaW_jenozKc",
    "https://u:p@youtube.com/watch?v=BaW_jenozKc",
    "https://youtube.com/playlist?list=abc",
    "$(touch /tmp/oops)",
    "http://youtu.be/BaW_jenozKc",
  ])
    assert.throws(() => normalizeYouTubeUrl(value, zh.error));
  assert.throws(() => normalizeYouTubeUrl("not a link", zh.error), (error) => shown(error) === "请输入完整的 YouTube 视频链接。");
});

test("split tracks and per-stream headers survive; silent video is rejected", () => {
  const video = { url: "https://cdn.test/video", vcodec: "vp9", acodec: "none" };
  const raw = {
    title: "Test",
    http_headers: { Referer: "https://youtube.com/", Bad: "a\nb" },
    requested_formats: [video, { url: "https://cdn.test/audio", vcodec: "none", acodec: "opus", http_headers: { "User-Agent": "test" } }],
  };
  const media = descriptorFromInfo("https://youtu.be/BaW_jenozKc", raw, zh.error);
  assert.equal(media.primary.url, "https://cdn.test/video");
  assert.equal(media.audio!.url, "https://cdn.test/audio");
  assert.equal(media.audio!.headers["User-Agent"], "test");
  assert.equal(media.primary.headers.Bad, undefined);
  assert.throws(
    () => descriptorFromInfo("original", { requested_formats: [video] }, zh.error),
    (error) => (error as Error).message === "No complete video and audio streams were found." && shown(error) === "没有找到完整的视频和音频流。",
  );
});

test("yt-dlp failures are reduced to one line of its own reason", () => {
  const stderr = "WARNING: x\nERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot\n  more detail\n";
  assert.equal(reason(stderr), "Sign in to confirm you're not a bot");
  assert.equal(reason("just one line"), "just one line");
  assert.equal(reason(""), "");
  assert.equal(reason("x".repeat(400)).length, 160);
});

test("failed download cleans staging and preserves existing destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vestra-yt-test-"));
  const path = join(dir, "saved.mkv");
  await writeFile(path, "original");
  const service = new YouTubeService(zh, async (args) => {
    if (args.includes("--version")) return "2026.08.19";
    throw new Error("network failed");
  });
  try {
    await assert.rejects(service.download("https://youtu.be/BaW_jenozKc", path), /network failed/);
    assert.equal(await readFile(path, "utf8"), "original");
    assert.deepEqual(await readdir(dir), ["saved.mkv"]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("success commits complete output and progress is parsed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vestra-yt-test-"));
  const path = join(dir, "saved.mkv");
  const progress: Progress[] = [];
  const service = new YouTubeService(zh, async (args, options) => {
    if (args.includes("--version")) return "2026.08.19";
    const template = args[args.indexOf("-o") + 1]!;
    await writeFile(template.replace("%(ext)s", "mkv"), "complete");
    options?.onLine?.("VESTRA_PROGRESS: 50.0%");
    return "";
  });
  try {
    await service.download("https://youtu.be/BaW_jenozKc", path, undefined, (value) => progress.push(value));
    assert.equal(await readFile(path, "utf8"), "complete");
    assert.equal(progress.at(-1)!.percent, 50);
    assert.equal(zh.resolve(progress.at(-1)!.message), "正在下载 50.0%");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("pre-aborted download never invokes download runner", async () => {
  let calls = 0;
  const service = new YouTubeService(zh, async () => {
    calls++;
    return "2026.08.19";
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.download("https://youtu.be/BaW_jenozKc", "/tmp/no-write.mkv", controller.signal), /Cancelled/);
  assert.equal(calls, 1);
});

test("a wrong yt-dlp version is explained in the user's language", async () => {
  for (const [found, expected] of [
    ["2025.01.01", "需要 yt-dlp 2026.08.19，当前为 2025.01.01。"],
    ["", "需要 yt-dlp 2026.08.19，当前为未知版本。"],
  ]) {
    const service = new YouTubeService(zh, async () => found);
    await assert.rejects(service.extract(watch), (error) => shown(error) === expected);
  }
});

// ---------------------------------------------------------------- plugin against the test host

test("activation registers only the public resolver and one menu entrance", async () => {
  const { host, stop } = await start();
  const declaration = host.resolvers.get("youtube") as { schemes: string[]; hosts: string[] };
  assert.deepEqual(declaration.schemes, ["https"]);
  assert.ok(declaration.hosts.includes("youtu.be"));
  assert.ok(declaration.hosts.includes("www.youtube.com"));
  assert.deepEqual([...host.commands.keys()], ["youtube.open"]);
  assert.deepEqual(host.command("youtube.open").declaration, {
    title: "VestraTube…",
    path: ["@open", "VestraTube…"],
    order: 111,
    group: "open",
    radio: false,
    bindings: [],
    focus: null,
    repeat: false,
  });
  const window = await openWindow(host);
  assert.deepEqual(window.callbacks.sort(), ["cancel", "download", "play"]);
  assert.deepEqual(host.command("youtube.open").display.path, ["打开", "VestraTube…"]);
  assert.equal(window.props.status, "粘贴 YouTube 视频链接以播放或下载。");
  await stop();
});

test("English is the source: menu, window status and file dialog", async () => {
  const { host, stop } = await start(offline, new TestHost(), "en");
  try {
    assert.deepEqual(host.command("youtube.open").display.path, ["Open", "VestraTube…"]);
    const window = await openWindow(host);
    assert.equal(window.props.status, "Paste a YouTube video link to play or download it.");
    window.emit("play", "https://youtube.com/playlist?list=abc");
    await host.settle();
    assert.equal(window.props.status, "Enter the link of a single YouTube video (watch, shorts, live or youtu.be).");
    host.dialogAnswers.push(null);
    window.emit("download", watch);
    await host.settle();
    assert.equal(window.props.status, "No save location was chosen.");
    assert.deepEqual(host.fileDialogs.at(-1), { kind: "saveFile", title: "Save YouTube Video", fileName: "YouTube.mkv" });
  } finally {
    await stop();
  }
});

test("the manifest's display texts are English with a Simplified Chinese translation", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
  assert.equal(manifest.id, "zysilm.youtube", "the id stays: the store and existing installs know the plugin by it");
  assert.equal(manifest.name, "VestraTube");
  for (const value of [manifest.name, manifest.punchline, manifest.description, ...manifest.tags])
    assert.doesNotMatch(value, /[\u3000-\u9fff\uff00-\uffef]/, "English source text");
  const { host, stop } = await start(offline, new TestHost(), "zh-Hans");
  assert.equal(host.translate(manifest.name), "VestraTube");
  assert.equal(host.translate(manifest.punchline), "粘贴链接播放或下载单个公开 YouTube 视频");
  assert.equal(
    host.translate(manifest.description),
    "打开 YouTube 视频链接（watch、shorts、live、embed、youtu.be）直接播放，或下载为 MKV 文件。需要本机安装 yt-dlp，下载另需 ffmpeg。",
  );
  assert.deepEqual(manifest.tags.map((tag: string) => host.translate(tag)), ["网络视频", "YouTube", "下载"]);
  await stop();
});

test("play submits the normalized URL once and reports ready only from the public source state", async () => {
  const { host, stop } = await start();
  const window = await openWindow(host);
  window.emit("play", "https://youtu.be/jNQXAC9IVRw?t=2");
  await host.settle();
  assert.equal(opens(host).length, 1);
  assert.equal((opens(host)[0]!.intent as { source: string }).source, watch);
  assert.equal(window.props.status, "正在解析并加载视频与音频…");
  assert.equal(window.props.busy, true);
  host.setSource({ phase: "ready" });
  await host.settle();
  assert.equal(window.props.status, "视频已就绪。");
  assert.equal(window.props.busy, false);
  await stop();
});

test("a lost submit reply is resolved by the same operation without opening again", async () => {
  const { host, stop } = await start();
  const window = await openWindow(host);
  host.handle("source.submit", async (params) => {
    host.reset("source.submit");
    await host.request("source.submit", params);
    throw new Error("reply lost");
  });
  window.emit("play", watch);
  await host.settle();
  host.setSource({ phase: "ready" });
  await host.settle();
  const ids = new Set(opens(host).map((call) => call.operationId));
  assert.equal(ids.size, 1);
  assert.deepEqual(host.sent("source.operation").map((call) => call.operationId), [...ids]);
  assert.equal(window.props.status, "视频已就绪。");
  await stop();
});

test("cancel while loading closes only its own media", async () => {
  const { host, stop } = await start();
  const window = await openWindow(host);
  window.emit("play", watch);
  await host.settle();
  window.emit("cancel");
  await host.settle();
  const close = host.sent("source.submit").at(-1)!.intent as { kind: string; expected?: unknown };
  assert.equal(close.kind, "close");
  assert.ok(close.expected, "close is conditional on the source stamp");
  assert.equal(host.source.phase, "empty");
  assert.equal(host.sent("ui.close").length, 1, "Cancel also closes the window");
  // Reopening starts from the prompt again.
  await host.command("youtube.open").run();
  assert.equal(host.window("youtube").props.status, "粘贴 YouTube 视频链接以播放或下载。");
  assert.equal(host.window("youtube").props.busy, false);
  await stop();
});

test("backend failure, replacement and refusal are never reported as ready", async () => {
  const cases: [(host: TestHost) => void, string][] = [
    [(host) => host.setSource({ phase: "error", terminalReason: { failed: "bot sign-in required" } }), "bot sign-in required"],
    [(host) => host.openElsewhere("/other.mp4"), "播放请求已被其他来源替换。"],
  ];
  for (const [act, expected] of cases) {
    const { host, stop } = await start();
    const window = await openWindow(host);
    window.emit("play", watch);
    await host.settle();
    act(host);
    await host.settle();
    assert.equal(window.props.status, expected);
    assert.equal(window.props.busy, false);
    await stop();
  }
  const { host, stop } = await start();
  const window = await openWindow(host);
  host.handle("source.submit", () => {
    throw new HostError("unsupported", "no resolver");
  });
  window.emit("play", watch);
  await host.settle();
  assert.equal(window.props.status, "播放器无法打开这个链接。");
  await stop();
});

test("an unsupported URL is explained without touching the source", async () => {
  const { host, stop } = await start();
  const window = await openWindow(host);
  window.emit("play", "https://youtube.com/playlist?list=abc");
  await host.settle();
  assert.equal(opens(host).length, 0);
  assert.match(String(window.props.status), /单个 YouTube 视频/);
  assert.equal(window.props.busy, false);
  await stop();
});

test("download shows progress while running and the saved file when done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vestra-yt-test-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const runner: Runner = async (args, options) => {
    if (args.includes("--version")) return "2026.08.19";
    options?.onLine?.("VESTRA_PROGRESS: 50.0%");
    await gate;
    await writeFile(args[args.indexOf("-o") + 1]!.replace("%(ext)s", "mkv"), "complete");
    return "";
  };
  const { host, stop } = await start(runner);
  try {
    const window = await openWindow(host);
    host.dialogAnswers.push([join(dir, "saved.mkv")]);
    window.emit("download", watch);
    await eventually(host, () => assert.equal(window.props.status, "正在下载 50.0%"));
    assert.equal(window.props.busy, true);
    assert.equal(window.props.progress, 0.5);
    release();
    await eventually(host, () => assert.equal(window.props.status, "已保存：saved.mkv"));
    assert.equal(window.props.progress, 1);
    assert.equal(window.props.busy, false);
    assert.equal(await readFile(join(dir, "saved.mkv"), "utf8"), "complete");
    assert.equal(opens(host).length, 0, "downloading never changes the source");
    await stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelling the save dialog, cancelling a download, and unloading during one", async () => {
  let started = 0;
  let aborted = 0;
  const runner: Runner = (args, options) => {
    if (args.includes("--version")) return Promise.resolve("2026.08.19");
    started++;
    return new Promise((_, reject) =>
      options?.signal?.addEventListener("abort", () => {
        aborted++;
        reject(new Error("Cancelled"));
      }),
    );
  };
  const dir = await mkdtemp(join(tmpdir(), "vestra-yt-test-"));
  const { host, stop } = await start(runner);
  try {
    const window = await openWindow(host);
    host.dialogAnswers.push(null);
    window.emit("download", watch);
    await host.settle();
    assert.equal(window.props.status, "已取消选择保存位置。");
    host.dialogAnswers.push([join(dir, "a.mkv")]);
    window.emit("download", watch);
    await eventually(host, () => assert.equal(started, 1)); // past staging: yt-dlp is running
    window.emit("cancel");
    await eventually(host, () => assert.equal(aborted, 1));
    assert.equal(host.sent("ui.close").length, 1);
    const reopened = await openWindow(host);
    assert.equal(reopened.props.busy, false);
    host.dialogAnswers.push([join(dir, "b.mkv")]);
    reopened.emit("download", watch);
    await eventually(host, () => assert.equal(started, 2));
    await stop();
    assert.equal(aborted, 2, "unloading stops the running download");
    assert.deepEqual(await readdir(dir), [], "staging is cleaned");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
