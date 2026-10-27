/**
 * Against the real YouTube, through the bundled youtubei.js: skipped unless
 * VESTRA_LIVE=1 (unit tests never reach the network). With VESTRA_FFPROBE set
 * (the player's ffprobe), the resolved URLs are also opened with it.
 *
 *   VESTRA_LIVE=1 VESTRA_FFPROBE=/path/to/ffprobe npm run plugin -- test youtube
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { startPlugin } from "@vestra-player/sdk/testing";
import activate from "../main.ts";
import { thumbnailUrl, watchUrl, YouTube } from "../youtube.ts";

const directory = new URL("..", import.meta.url);
const live = process.env.VESTRA_LIVE === "1";
/** Big Buck Bunny 60fps 4K, the Blender Foundation's own upload (public, CC BY 3.0). */
const KNOWN = "aqz-KE-bpKQ";

function probe(url: string) {
  const ffprobe = process.env.VESTRA_FFPROBE;
  if (!ffprobe) return null;
  return execFileSync(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,width,height,r_frame_rate,sample_rate:format=duration",
      "-of",
      "compact",
      url,
    ],
    { encoding: "utf8", timeout: 60_000 },
  ).trim();
}

test(
  "live: search YouTube and resolve a public video to playable streams",
  { skip: !live && "set VESTRA_LIVE=1", timeout: 180_000 },
  async () => {
    const { plugin, host, stop } = await startPlugin(activate, { directory, locale: "en" });
    try {
      const youtube = new YouTube(plugin.i18n);
      const page = await youtube.search("Big Buck Bunny 60fps 4K Blender Foundation");
      assert.ok(page.videos.length > 0, "search results");
      const video = page.videos.find((item) => item.id === KNOWN) ?? page.videos[0]!;
      console.log(
        `search: ${page.videos.length} videos, more: ${page.more !== null}; using ${video.id} "${video.title}" by ${video.channel}, ${video.seconds}s`,
      );
      assert.ok(video.title && video.channel && video.seconds);
      const thumb = await fetch(thumbnailUrl(video.id));
      assert.equal(thumb.headers.get("content-type"), "image/jpeg");
      await thumb.body?.cancel();

      const started = Date.now();
      const media = await youtube.resolve(watchUrl(video.id));
      console.log(
        `resolve: ${Date.now() - started} ms, client ${media.client}, ${media.quality}, audio separate: ${!!media.audio}, expires ${new URL(media.primary.url).searchParams.get("expire")}`,
      );
      assert.ok(media.primary.url.startsWith("https://"));
      for (const [label, stream] of [
        ["video", media.primary],
        ["audio", media.audio],
      ] as const) {
        if (!stream) continue;
        const result = probe(stream.url);
        if (result) console.log(`ffprobe ${label}: ${result.replace(/\s+/g, " ")}`);
      }

      // The same through the plugin's resolver, as the player asks it.
      host.emit("source.resolveRequest", { requestId: 1, resolverId: "youtube", url: `https://youtu.be/${video.id}` });
      const deadline = Date.now() + 60_000;
      let reply: Record<string, unknown> | undefined;
      while (!reply && Date.now() < deadline) {
        await host.settle(50);
        reply = host.sent("sourceResolvers.respond").find((call) => call.requestId === 1);
      }
      assert.ok(reply, "the resolver answered");
      const result = reply.result as { kind: string; primary: { url: string }; audio?: { url: string } } | undefined;
      assert.equal(result?.kind, "media", JSON.stringify(reply.error ?? null));
      assert.ok(result.audio, "separate audio");
    } finally {
      await stop();
    }
  },
);
