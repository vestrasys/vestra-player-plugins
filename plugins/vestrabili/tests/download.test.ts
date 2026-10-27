import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import { explain, type extractBilibili } from "../extractor.ts";
import { vestrabili } from "../main.ts";
import { github, KEY } from "./github.ts";

const directory = new URL("..", import.meta.url);
const link = "https://www.bilibili.com/video/BV1xx411c7mD";
const ASSET = "yt-dlp_linux";
const BINARY = Buffer.from("yt-dlp build ".repeat(80_000));

/** Poll: the plugin's own work (files, the fake network) is not covered by `settle`. */
async function until(host: TestHost, check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await host.settle(10);
  }
  assert.fail("timed out waiting");
}

/** VestraBili on a Linux x64 machine without yt-dlp, against a fake GitHub release. */
async function start(extract?: typeof extractBilibili, locale: "en" | "zh-Hans" = "zh-Hans") {
  const host = new TestHost();
  const fake = github(ASSET, { tag: "2026.10.26", content: BINARY });
  const runs: string[] = [];
  const { stop } = await startPlugin(
    vestrabili({
      ytdlp: {
        fetch: (input, init) => fake.fetch(input, init),
        run: async (program) => {
          runs.push(program);
          return fake.release.reports ?? fake.release.tag;
        },
        key: KEY,
        platform: "linux",
        arch: "x64",
        env: { PATH: "" },
      },
      ...(extract ? { extract } : {}),
    }),
    { directory, host, locale },
  );
  return { host, fake, runs, stop, installed: join(host.dataDirectory, "bin", ASSET) };
}
const opens = (host: TestHost) =>
  host.sent("source.submit").filter((c) => (c.intent as { kind: string }).kind === "open");
const resolve = (host: TestHost, requestId: number) =>
  host.emit("source.resolveRequest", { requestId, resolverId: "bilibili", url: link });
const reply = (host: TestHost, requestId: number) =>
  host.sent("sourceResolvers.respond").find((r) => r.requestId === requestId);
const media = { originalUrl: link, title: "t", media: { url: "https://cdn.example/v", headers: {} } };

test("the window asks before downloading yt-dlp; a refusal says how to get it later", async () => {
  const { host, fake, stop } = await start(undefined, "en");
  host.dialogAnswers.push({ confirmed: false, checked: false });
  await host.command("bilibili.open").run();
  const window = host.window("dialog");
  window.emit("play", link);
  await until(host, () => /needs yt-dlp/.test(String(window.props.status)));
  assert.equal(window.props.busy, false);
  assert.deepEqual(host.confirmTexts, [
    {
      message: "Download yt-dlp to play Bilibili links?",
      detail:
        "VestraBili plays Bilibili links with yt-dlp, a free open-source tool. It downloads it once (about 42 MB) from the yt-dlp project's official GitHub releases, checks it against the project's signed checksums, and keeps it up to date. yt-dlp is in the public domain (Unlicense) and is not part of VestraBili.",
      confirm: "Download",
      cancel: "Cancel",
    },
  ]);
  assert.equal(window.props.status, "VestraBili needs yt-dlp to play Bilibili links. Press Play to download it.");
  assert.equal(opens(host).length, 0);
  assert.deepEqual(fake.urls, []);
  await stop();
});

test("after consent the window shows the download, then plays", async () => {
  const { host, fake, runs, stop, installed } = await start();
  host.dialogAnswers.push({ confirmed: true, checked: false });
  await host.command("bilibili.open").run();
  const window = host.window("dialog");
  // Hold the download halfway: the window must show its progress meanwhile.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let halfway = false;
  fake.midway = () => {
    halfway = true;
    return held;
  };
  window.emit("play", link);
  await until(host, () => halfway && /^正在下载 yt-dlp… \d+%$/.test(String(window.props.status)));
  assert.equal(opens(host).length, 0, "nothing opens before yt-dlp is installed");
  release();
  await until(host, () => opens(host).length === 1);
  assert.equal(host.confirmTexts[0]!.message, "下载 yt-dlp 以播放 Bilibili 链接？");
  assert.match(host.confirmTexts[0]!.detail!, /约 42 MB/);
  assert.equal(window.props.status, "正在解析视频和音频…");
  assert.deepEqual(await readFile(installed), BINARY);
  assert.equal(runs.length, 1);
  assert.deepEqual(host.osd, [], "the window shows the progress, not the video");
  await stop();
});

test("a playlist link asks too, shows the download on the video and plays with the new yt-dlp", async () => {
  const programs: string[] = [];
  const { host, stop, installed } = await start(async (_url, _error, _signal, program) => {
    programs.push(program!);
    return media;
  });
  host.dialogAnswers.push({ confirmed: true, checked: false });
  resolve(host, 1);
  await until(host, () => !!reply(host, 1));
  assert.equal(host.confirmTexts.length, 1);
  assert.deepEqual(reply(host, 1)!.error, undefined);
  assert.deepEqual(programs, [installed]);
  assert.equal(reply(host, 1)!.error, undefined);
  assert.ok(host.osd.some((text) => /^正在下载 yt-dlp… \d+%$/.test(text)), host.osd.join(" | "));
  assert.equal(host.osd.at(-1), "yt-dlp 已就绪。");
  // The next link: no question, no download.
  resolve(host, 2);
  await until(host, () => !!reply(host, 2));
  assert.equal(host.confirmTexts.length, 1);
  assert.deepEqual(programs, [installed, installed]);
  await stop();
});

test("a refusal from a playlist link is remembered: later links fail without asking", async () => {
  const { host, fake, stop } = await start();
  host.dialogAnswers.push({ confirmed: false, checked: false });
  resolve(host, 1);
  await until(host, () => !!reply(host, 1));
  resolve(host, 2);
  await until(host, () => !!reply(host, 2));
  assert.equal(host.confirmTexts.length, 1);
  const error = reply(host, 2)!.error as { $vestraText: string };
  assert.equal(error.$vestraText, "VestraBili needs yt-dlp to play Bilibili links. Open → VestraBili… downloads it.");
  assert.equal(host.translate(error.$vestraText), "VestraBili 需要 yt-dlp 才能播放 Bilibili 链接。可在“打开 → VestraBili…”中下载。");
  assert.deepEqual(fake.urls, []);
  await stop();
});

test("an extraction failure a newer yt-dlp may fix updates yt-dlp and retries once", async () => {
  let calls = 0;
  let failures = 0;
  let failure = "HTTP Error 412: Precondition Failed";
  const { host, fake, stop, installed } = await start(async () => {
    calls++;
    if (failures > 0) {
      failures--;
      throw Object.assign(new Error(`Bilibili resolution failed: ${failure}`), { reason: failure });
    }
    return media;
  });
  host.dialogAnswers.push({ confirmed: true, checked: false });
  resolve(host, 1); // the first install
  await until(host, () => !!reply(host, 1));
  const downloads = () => fake.urls.filter((url) => url.endsWith(ASSET)).length;
  assert.equal(downloads(), 1);
  // A newer release appears, and the site change breaks the installed yt-dlp.
  const newer = Buffer.from("newer yt-dlp");
  fake.release = { tag: "2026.11.01", content: newer };
  [calls, failures] = [0, 1];
  resolve(host, 2);
  await until(host, () => !!reply(host, 2));
  assert.equal(calls, 2, "failed, updated, retried once");
  assert.equal(reply(host, 2)!.error, undefined);
  assert.equal(downloads(), 2);
  assert.deepEqual(await readFile(installed), newer);
  // Within the hour another such failure does not check again.
  fake.release = { tag: "2026.11.02", content: Buffer.from("newest") };
  [calls, failures] = [0, 2];
  resolve(host, 3);
  await until(host, () => !!reply(host, 3));
  assert.equal(calls, 1);
  assert.ok(reply(host, 3)!.error);
  assert.equal(downloads(), 2);
  // A failure that is not about yt-dlp being old is reported as it is.
  failure = "This video is private";
  [calls, failures] = [0, 2];
  resolve(host, 4);
  await until(host, () => !!reply(host, 4));
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(installed), newer);
  await stop();
});

test("a refused video shows our sentence in the window, with yt-dlp's words in the tooltip", async () => {
  const raw = "[BiliBili] BV1xx411c7mD: This video may be deleted or geo-restricted. You might want to try a VPN or a proxy server (with --proxy)";
  const { host, stop } = await start(async (_url, error) => {
    throw explain(raw, error); // what the extractor throws for this reason
  });
  // yt-dlp is already there for this test: a granted download.
  host.dialogAnswers.push({ confirmed: true, checked: false });
  // The player asks the resolver, then reports the failure to the window as a backend error.
  host.handle("source.submit", async () => {
    resolve(host, 5);
    for (let i = 0; i < 500 && !reply(host, 5); i++) await new Promise((r) => setTimeout(r, 10));
    return { status: "failed", error: { backend: `Bilibili resolution failed: ${raw}` } };
  });
  await host.command("bilibili.open").run();
  const window = host.window("dialog");
  window.emit("play", link);
  await until(host, () => window.props.busy === false && /地区/.test(String(window.props.status)));
  assert.equal(window.props.status, "Bilibili 在你所在的地区拒绝提供此视频，或视频已被删除。");
  assert.equal(window.props.detail, raw);
  // A new attempt starts without the old details.
  host.reset("source.submit");
  window.emit("play", link);
  await until(host, () => window.props.detail === "");
  await stop();
});
