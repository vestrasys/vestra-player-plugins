import assert from "node:assert/strict";
import test from "node:test";
import type { TextError } from "@vestra-player/sdk";
import { startPlugin } from "@vestra-player/sdk/testing";
import {
  decodeMetadata,
  explain,
  extractBilibili,
  matchesUrl,
  reason,
  validateUrl,
} from "../extractor.ts";

/** `plugin.i18n` with this package's Simplified Chinese catalog (no host calls). */
const zh = await (async () => {
  const { plugin, stop } = await startPlugin(() => {}, {
    directory: new URL("..", import.meta.url),
    locale: "zh-Hans",
  });
  await stop();
  return plugin.i18n;
})();
/** What a Simplified Chinese user reads for an error the extractor threw. */
const shown = (error: unknown) => zh.resolve((error as TextError).text);

test("strict site URLs and no lookalike or credential bypass", () => {
  for (const url of [
    "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
    "https://b23.tv/Abc123",
  ])
    assert.equal(matchesUrl(url, zh.error), true);
  for (const url of [
    "file:///tmp/x",
    "https://bilibili.com.evil/video/BV1",
    "https://evil@www.bilibili.com/video/BV1",
    "https://www.bilibili.com/live/1",
    "https://www.bilibili.com/video/BV1:80",
  ])
    assert.equal(matchesUrl(url, zh.error), false);
  assert.equal(
    validateUrl("https://www.bilibili.com/video/BV1#part", zh.error),
    "https://www.bilibili.com/video/BV1",
  );
  assert.throws(
    () => validateUrl("not a link", zh.error),
    (error) =>
      (error as Error).message === "Enter a valid Bilibili video URL." &&
      shown(error) === "请输入有效的 Bilibili 视频网址。",
  );
});

test("split audio and request headers survive decoding", () => {
  const result = decodeMetadata(
    "https://b23.tv/x",
    {
      title: "test",
      http_headers: { Referer: "https://www.bilibili.com/" },
      requested_formats: [
        { url: "https://cdn.example/video", vcodec: "avc1", acodec: "none" },
        {
          url: "https://cdn.example/audio",
          vcodec: "none",
          acodec: "mp4a",
          http_headers: { "User-Agent": "test" },
        },
      ],
    },
    zh.error,
  );
  assert.equal(result.originalUrl, "https://b23.tv/x");
  assert.equal(result.audio!.url, "https://cdn.example/audio");
  assert.equal(result.audio!.headers.Referer, "https://www.bilibili.com/");
  assert.equal(result.audio!.headers["User-Agent"], "test");
});

test("never accepts silent/incomplete extraction or header injection", () => {
  assert.throws(
    () =>
      decodeMetadata(
        "x",
        {
          requested_formats: [
            { url: "https://cdn.example/video", vcodec: "avc1", acodec: "none" },
          ],
        },
        zh.error,
      ),
    (error) =>
      /separate audio track/.test((error as Error).message) &&
      shown(error) === "提取结果缺少独立音轨，无法完整播放。",
  );
  assert.throws(
    () =>
      decodeMetadata(
        "x",
        {
          url: "https://cdn.example/a",
          vcodec: "avc1",
          acodec: "aac",
          http_headers: { Referer: "x\r\ny" },
        },
        zh.error,
      ),
    (error) => shown(error) === "提取结果包含无效请求头。",
  );
});

test("pre-aborted resolution never starts process", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    extractBilibili("https://b23.tv/test", zh.error, controller.signal),
  );
});

test("yt-dlp failures are reduced to one line of its own reason", () => {
  assert.equal(reason("WARNING: a\nERROR: [BiliBili] BV1xx411c7mD: HTTP Error 412: Precondition Failed\n"), "HTTP Error 412: Precondition Failed");
  assert.equal(reason(""), "");
  assert.equal(reason("y".repeat(500)).length, 160);
});

test("known yt-dlp reasons get our own sentence; the raw reason is kept", () => {
  const geo = "This video may be deleted or geo-restricted. You might want to try a VPN or a proxy server (with --proxy)";
  const cases: [string, string][] = [
    [geo, "Bilibili 在你所在的地区拒绝提供此视频，或视频已被删除。"],
    ["HTTP Error 412: Precondition Failed", "Bilibili 当前限制了请求，请稍后重试。"],
    ["This video is only available for registered users. Use --cookies to sign in", "此视频需要登录或会员，VestraBili 不支持。"],
    ["Something new", "Bilibili 解析失败：Something new"],
  ];
  for (const [why, expected] of cases) {
    const error = explain(why, zh.error);
    assert.equal(shown(error), expected);
    assert.equal(error.reason, why);
  }
});
