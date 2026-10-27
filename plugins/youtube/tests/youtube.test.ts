import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import type { TextError } from "@vestra-player/sdk";
import activate, { fileNameFor } from "../main.ts";
import { CHUNK_BYTES, downloadMedia } from "../download.ts";
import { evaluate } from "../evaluator.ts";
import { MAX_ROWS, PLACEHOLDER, THUMB_SIDE } from "../panel.ts";
import type { Fetcher, TubeFactory, TubeFormat, TubeInfo, TubeSearch } from "../youtube.ts";
import {
  formatDuration,
  normalizeYouTubeUrl,
  pickFormats,
  thumbnailUrl,
  toVideo,
  videoIdOf,
  watchUrl,
  YouTube,
  youtubeLanguage,
} from "../youtube.ts";

const directory = new URL("..", import.meta.url);
type Locale = "en" | "zh-Hans";
/** `plugin.i18n` with this package's Simplified Chinese catalog (no host calls). */
const zh = await (async () => {
  const { plugin, stop } = await startPlugin(() => {}, { directory, locale: "zh-Hans" });
  await stop();
  return plugin.i18n;
})();
const shown = (error: unknown) => zh.resolve((error as TextError).text);

// ---------------------------------------------------------------- a fake youtubei.js and a fake network

/** An 11-character video id. */
const vid = (n: number) => `vid${String(n).padStart(8, "0")}`;
const node = (n: number, extra: Record<string, unknown> = {}) => ({
  type: "Video",
  video_id: vid(n),
  title: { toString: () => `Video ${n}` },
  author: { name: `Channel ${n}` },
  duration: { seconds: 60 * n + 5, text: "" },
  is_live: false,
  ...extra,
});
const format = (fields: Partial<TubeFormat> & { deciphered?: string }): TubeFormat & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    itag: 0,
    mime_type: "",
    has_video: false,
    has_audio: false,
    bitrate: 1,
    calls,
    ...fields,
    async decipher(player?: unknown) {
      calls.push(player);
      if (fields.url) return fields.url;
      return player ? (fields.deciphered ?? "") : "";
    },
  };
};
/** What VISIONOS answers today: video-only and audio-only formats with direct URLs. */
function visionos(id: string, title = `Title ${id}`): TubeInfo {
  const cdn = `https://cdn.test/${id}`;
  return {
    playability_status: { status: "OK" },
    basic_info: { title, is_live: false },
    streaming_data: {
      formats: [],
      adaptive_formats: [
        format({
          itag: 315,
          url: `${cdn}/315`,
          mime_type: 'video/webm; codecs="vp9"',
          has_video: true,
          height: 2160,
          fps: 60,
          bitrate: 26e6,
        }),
        format({
          itag: 303,
          url: `${cdn}/303`,
          mime_type: 'video/webm; codecs="vp9"',
          has_video: true,
          height: 1080,
          fps: 60,
          bitrate: 4e6,
        }),
        format({
          itag: 299,
          url: `${cdn}/299`,
          mime_type: 'video/mp4; codecs="avc1.64002A"',
          has_video: true,
          height: 1080,
          fps: 60,
          bitrate: 6e6,
          quality_label: "1080p60",
          content_length: 1000,
        }),
        format({
          itag: 140,
          url: `${cdn}/140`,
          mime_type: 'audio/mp4; codecs="mp4a.40.2"',
          has_audio: true,
          bitrate: 130e3,
          content_length: 500,
        }),
        format({
          itag: 251,
          url: `${cdn}/251-drc`,
          mime_type: 'audio/webm; codecs="opus"',
          has_audio: true,
          bitrate: 150e3,
          is_drc: true,
        }),
        format({
          itag: 251,
          url: `${cdn}/251`,
          mime_type: 'audio/webm; codecs="opus"',
          has_audio: true,
          bitrate: 143e3,
          content_length: 600,
        }),
      ],
    },
  };
}
const PLAYER_SCRIPT = { player: "script" };

type FakeTube = {
  factory: TubeFactory;
  /** Sessions made, `true` for one with the player script. */
  sessions: boolean[];
  /** getBasicInfo calls: "<client> <id>". */
  infos: string[];
  searches: string[];
  /** The answer per client (a function of the id), or an error to throw. */
  clients: Map<string, ((id: string) => TubeInfo) | Error>;
  results: (query: string) => TubeSearch | Promise<TubeSearch>;
};
function page(numbers: number[], next?: () => TubeSearch | Promise<TubeSearch>): TubeSearch {
  return {
    videos: numbers.map((n) => node(n)),
    has_continuation: !!next,
    getContinuation: async () => {
      if (!next) throw new Error("no continuation");
      return next();
    },
  };
}
function fakeTube(): FakeTube {
  const tube: FakeTube = {
    sessions: [],
    infos: [],
    searches: [],
    clients: new Map([["VISIONOS", (id: string) => visionos(id)]]),
    results: () => page([1, 2, 3]),
    factory: async ({ player }) => {
      tube.sessions.push(player);
      return {
        session: { player: player ? PLAYER_SCRIPT : undefined },
        search: async (query) => {
          tube.searches.push(query);
          return tube.results(query);
        },
        getBasicInfo: async (id, { client }) => {
          tube.infos.push(`${client} ${id}`);
          const answer = tube.clients.get(client);
          if (answer instanceof Error) throw answer;
          return answer
            ? answer(id)
            : {
                playability_status: { status: "OK" },
                basic_info: {},
                streaming_data: { formats: [], adaptive_formats: [] },
              };
        },
      };
    },
  };
  return tube;
}

type FakeNet = {
  fetch: Fetcher;
  /** URL → body, or an HTTP status to answer with. */
  files: Map<string, Uint8Array | number>;
  requests: { url: string; range: string | null }[];
  /** When set, every request fails as offline. */
  offline: boolean;
  /** URLs whose requests wait until they are aborted. */
  hang: Set<string>;
};
const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);
function fakeNet(): FakeNet {
  const net: FakeNet = {
    files: new Map(),
    requests: [],
    offline: false,
    hang: new Set(),
    fetch: async (input, init) => {
      const url = String(input);
      const range = new Headers(init?.headers).get("range");
      net.requests.push({ url, range });
      if (net.offline)
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
        });
      if (net.hang.has(url) && range !== "bytes=0-")
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          ),
        );
      const body = net.files.get(url);
      if (body === undefined) return new Response(null, { status: 404 });
      if (typeof body === "number") return new Response(null, { status: body });
      const [, from, to] = /^bytes=(\d+)-(\d*)$/.exec(range ?? "") ?? [];
      if (from === undefined) return new Response(new Uint8Array(body), { status: 200 });
      const start = Number(from);
      const end = to ? Math.min(Number(to), body.length - 1) : body.length - 1;
      return new Response(new Uint8Array(body.slice(start, end + 1)), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${body.length}` },
      });
    },
  };
  return net;
}
/** The streams VISIONOS gives for `id` are on the fake CDN. */
function serve(net: FakeNet, id: string) {
  net.files.set(`https://cdn.test/${id}/299`, bytes(1000, 1));
  net.files.set(`https://cdn.test/${id}/251`, bytes(600, 2));
}

const THUMB = PLACEHOLDER; // any PNG the fake host can serve for a thumbnail

async function start(
  options: { tube?: FakeTube; net?: FakeNet; locale?: Locale; host?: TestHost; thumbs?: number[] } = {},
) {
  const tube = options.tube ?? fakeTube();
  const net = options.net ?? fakeNet();
  const host = options.host ?? new TestHost();
  for (const n of options.thumbs ?? [1, 2, 3]) host.remoteImages.set(thumbnailUrl(vid(n)), THUMB);
  const started = await startPlugin(
    (plugin) => activate(plugin, new YouTube(plugin.i18n, { factory: tube.factory, fetcher: net.fetch })),
    { directory, host, locale: options.locale ?? "en" },
  );
  return { ...started, tube, net };
}
/** Retry `assertion` until it passes: `settle()` does not wait for the plugin's own fetches and files. */
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
type Row = {
  key: string;
  title: string;
  channel: string;
  duration: string;
  live: boolean;
  thumb: unknown;
  selected: boolean;
  playing: boolean;
  failed: boolean;
};
/** What the panel sends as `rows`: plain values only (no image, no selection), always MAX_ROWS of them. */
type RowValue = Omit<Row, "thumb" | "selected" | "playing">;
const allRowValues = (host: TestHost) => host.mounted().props.rows as unknown as RowValue[];
/** The results among them (the first `count`). */
const rowValues = (host: TestHost) => allRowValues(host).slice(0, host.mounted().props.count as number);
/** A row as drawn: its values plus its thumbnail (`thumbs`), selection and playing mark (by key). */
const rows = (host: TestHost): Row[] => {
  const props = host.mounted().props;
  const thumbs = props.thumbs as unknown[];
  return rowValues(host).map((row, index) => ({
    ...row,
    thumb: thumbs[index],
    selected: index === props["selected-index"],
    playing: row.key === props["playing-key"],
  }));
};
const opens = (host: TestHost) =>
  host.sent("source.submit").filter((call) => (call.intent as { kind: string }).kind === "open");
async function searchFor(host: TestHost, query = "big buck bunny") {
  host.mounted().emit("search", query);
  await eventually(host, () => assert.ok(rows(host).length > 0 || host.mounted().props.message !== "Searching…"));
}
let requestId = 100;
/** Ask the plugin's resolver as the player does for an open of `url`; the answer as sent. */
async function resolveVia(host: TestHost, url: string) {
  const id = ++requestId;
  host.emit("source.resolveRequest", { requestId: id, resolverId: "youtube", url });
  let reply: Record<string, unknown> | undefined;
  await eventually(host, () => {
    reply = host.sent("sourceResolvers.respond").find((call) => call.requestId === id);
    assert.ok(reply);
  });
  return reply as { result?: Record<string, unknown>; error?: unknown };
}

// ---------------------------------------------------------------- links, results, formats (no host)

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
  assert.throws(
    () => normalizeYouTubeUrl("not a link", zh.error),
    (error) => shown(error) === "请输入完整的 YouTube 视频链接。",
  );
  assert.equal(videoIdOf(watchUrl("BaW_jenozKc")), "BaW_jenozKc");
  assert.equal(videoIdOf(null), null);
  assert.equal(videoIdOf("/local/file.mp4"), null);
});

test("search result nodes become rows; shelves, channels and broken nodes are skipped", () => {
  assert.deepEqual(toVideo(node(2)), { id: vid(2), title: "Video 2", channel: "Channel 2", seconds: 125, live: false });
  assert.deepEqual(toVideo(node(3, { is_live: true })), {
    id: vid(3),
    title: "Video 3",
    channel: "Channel 3",
    seconds: null,
    live: true,
  });
  assert.equal(toVideo(node(4, { badges: [{ label: "LIVE" }] }))!.live, true);
  assert.equal(toVideo(node(5, { duration: { seconds: 0 } }))!.seconds, null, "upcoming: no duration");
  assert.equal(toVideo({ ...node(1), type: "ShortsLockupView" }), null);
  assert.equal(toVideo({ ...node(1), video_id: "short" }), null);
  assert.equal(toVideo({ ...node(1), title: { toString: () => "  " } }), null);
  assert.equal(toVideo(null), null);
  assert.equal(formatDuration(75), "1:15");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(null), "");
  assert.equal(youtubeLanguage("zh-Hans"), "zh-CN");
  assert.equal(youtubeLanguage("en"), "en");
});

test("the best H.264 video up to 1080p and the best non-DRC audio of the default track are chosen", () => {
  const picked = pickFormats(visionos("BaW_jenozKc"))!;
  assert.equal(picked.video.itag, 299, "1080p H.264 before 1080p VP9; 2160p is over the cap");
  assert.equal(picked.audio!.url, "https://cdn.test/BaW_jenozKc/251", "Opus 143k, not the DRC copy");
  const dubbed: TubeInfo = {
    basic_info: {},
    streaming_data: {
      formats: [],
      adaptive_formats: [
        format({ url: "v", mime_type: 'video/mp4; codecs="avc1"', has_video: true, height: 720, bitrate: 1 }),
        format({
          url: "dub",
          mime_type: "audio/mp4",
          has_audio: true,
          bitrate: 200,
          audio_track: { audio_is_default: false },
        }),
        format({
          url: "orig",
          mime_type: "audio/mp4",
          has_audio: true,
          bitrate: 100,
          audio_track: { audio_is_default: true },
        }),
      ],
    },
  };
  assert.equal(pickFormats(dubbed)!.audio!.url, "orig", "the original language, not a dub");
  const muxedOnly: TubeInfo = {
    basic_info: {},
    streaming_data: {
      formats: [format({ itag: 18, url: "m", mime_type: "video/mp4", has_video: true, has_audio: true, height: 360 })],
      adaptive_formats: [],
    },
  };
  assert.deepEqual(Object.keys(pickFormats(muxedOnly)!), ["video"]);
  assert.equal(pickFormats({ basic_info: {} }), null);
  assert.equal(fileNameFor('a/b:c*?"<>| d.'), "a b c d.mkv");
  assert.equal(fileNameFor(null), "YouTube.mkv");
});

test("the player script runs in a worker with a time limit", async () => {
  assert.deepEqual(await evaluate('return { n: "abc".split("").reverse().join("") }'), { n: "cba" });
  await assert.rejects(evaluate("throw new Error('boom')"), /boom/);
  await assert.rejects(evaluate("for (;;) {}", 200), /longer than 200 ms/);
  await assert.rejects(evaluate("return typeof plugin === 'undefined' ? process.exit(3) : 1"), /exit 3/);
});

// ---------------------------------------------------------------- activation

test("activation: the panel in the sidebar, the resolver, the menu entries and the panel's commands", async () => {
  const { host, stop } = await start({ locale: "zh-Hans" });
  try {
    const declaration = host.resolvers.get("youtube") as { schemes: string[]; hosts: string[] };
    assert.deepEqual(declaration.schemes, ["https"]);
    assert.ok(declaration.hosts.includes("youtu.be") && declaration.hosts.includes("www.youtube.com"));
    const panel = host.mounted();
    assert.equal(panel.slot, "sidebar");
    assert.equal(panel.component, "TubeSidebar");
    assert.equal(panel.props.message, "请搜索并按回车键");
    assert.deepEqual(rowValues(host), []);
    assert.deepEqual([...host.commands.keys()].sort(), [
      "youtube.cancel-download",
      "youtube.download-selected",
      "youtube.open",
      "youtube.panel",
      "youtube.play-selected",
    ]);
    assert.deepEqual(host.command("youtube.panel").display.path, ["打开", "VestraTube"]);
    assert.deepEqual(host.command("youtube.open").display.path, ["打开", "YouTube 链接…"]);
    const play = host.command("youtube.play-selected").declaration as {
      bindings: string[];
      focus: string;
      path?: unknown;
    };
    assert.deepEqual([play.bindings, play.focus], [["Enter"], "panel"]);
    assert.equal(host.command("youtube.play-selected").state.enabled, false, "nothing selected yet");
    await host.command("youtube.panel").run();
    assert.equal(host.layout.sidebar?.preferred, true);
    await host.command("youtube.open").run();
    assert.equal(host.window("youtube").props.status, "粘贴 YouTube 视频链接以播放或下载。");
  } finally {
    await stop();
  }
});

test("the manifest's display texts are English with a Simplified Chinese translation", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
  assert.equal(manifest.id, "zysilm.youtube", "the id stays: the store and existing installs know the plugin by it");
  assert.equal(manifest.name, "VestraTube");
  assert.equal(manifest.version, "0.4.1");
  assert.equal(manifest.minPlayerVersion, "0.5.1", "images in rows");
  assert.ok(manifest.capabilities.includes("ui.mount"));
  for (const value of [manifest.name, manifest.punchline, manifest.description, ...manifest.tags])
    assert.doesNotMatch(value, /[　-鿿＀-￯]/, "English source text");
  assert.doesNotMatch(manifest.description, /yt-dlp/);
  const { host, stop } = await start({ locale: "zh-Hans" });
  assert.equal(host.translate(manifest.punchline), "在侧栏搜索 YouTube，即点即播");
  assert.match(host.translate(manifest.description), /youtubei\.js/);
  assert.deepEqual(
    manifest.tags.map((tag: string) => host.translate(tag)),
    ["网络视频", "YouTube", "下载"],
  );
  await stop();
});

// ---------------------------------------------------------------- the panel: search → rows

test("a search fills the rows with titles, channels, durations and thumbnails", async () => {
  const { host, tube, stop } = await start();
  try {
    const panel = host.mounted();
    panel.emit("search", "  big buck bunny ");
    await eventually(host, () => assert.equal(rows(host).length, 3));
    assert.deepEqual(tube.searches, ["big buck bunny"]);
    assert.deepEqual(tube.sessions, [false], "search needs no player script");
    const [first] = rows(host);
    assert.deepEqual(
      { ...first, thumb: undefined },
      {
        key: vid(1),
        title: "Video 1",
        channel: "Channel 1",
        duration: "1:05",
        live: false,
        thumb: undefined,
        selected: false,
        playing: false,
        failed: false,
      },
    );
    // A remote image is served from the plugin's image cache, not from the placeholder.
    await eventually(host, () =>
      assert.ok(rows(host).every((row) => host.imagePath(row.thumb as never) !== PLACEHOLDER)),
    );
    const thumbs = new Set(
      host.images.filter((image) => image.maxSide === THUMB_SIDE).map((image) => image.ref),
    );
    assert.equal(thumbs.size, 3, "one 192 px image per row");
    assert.equal(panel.props.message, "");
    assert.equal(panel.props["can-more"], false);
    assert.equal(panel.props["can-download"], false, "nothing selected");
  } finally {
    await stop();
  }
});

test("before a search: one hint line and no request to YouTube (works offline)", async () => {
  for (const [locale, hint] of [
    ["en", "Search and press Enter"],
    ["zh-Hans", "请搜索并按回车键"],
  ] as const) {
    const { host, tube, net, stop } = await start({ locale });
    try {
      await host.settle();
      const panel = host.mounted();
      assert.equal(panel.props.message, hint);
      assert.deepEqual(rowValues(host), []);
      assert.equal(panel.props["can-retry"], false);
      assert.deepEqual([tube.sessions, tube.searches], [[], []], "no feed, no session before a search");
      assert.equal(net.requests.length, 0);
    } finally {
      await stop();
    }
  }
});

test("selecting, playing and thumbnails leave the row values alone (rows are updated in place)", async () => {
  const { host, stop } = await start();
  try {
    await searchFor(host);
    await eventually(host, () =>
      assert.ok(rows(host).every((row) => host.imagePath(row.thumb as never) !== PLACEHOLDER)),
    );
    assert.equal(allRowValues(host).length, MAX_ROWS, "a fixed length: the player never replaces the model");
    const before = structuredClone(rowValues(host));
    for (const row of before) {
      assert.deepEqual(Object.keys(row).sort(), ["channel", "duration", "failed", "key", "live", "title"]);
    }
    const panel = host.mounted();
    panel.emit("select", vid(2));
    await host.settle();
    assert.equal(panel.props["selected-index"], 1);
    panel.emit("select-step", -1);
    await host.settle();
    assert.equal(panel.props["selected-index"], 0);
    panel.emit("play", vid(1));
    await eventually(host, () => assert.equal(panel.props["playing-key"], vid(1)));
    assert.deepEqual(rowValues(host), before, "no row changed, so the player keeps every row element");
    assert.equal((panel.props.thumbs as unknown[]).length, before.length, "one thumbnail per row");
  } finally {
    await stop();
  }
});

test("rows show a placeholder until (or when never) the thumbnail arrives", async () => {
  const { host, stop } = await start({ thumbs: [1] });
  try {
    await searchFor(host);
    await eventually(host, () => assert.notEqual(host.imagePath(rows(host)[0]!.thumb as never), PLACEHOLDER));
    assert.equal(host.imagePath(rows(host)[1]!.thumb as never), PLACEHOLDER);
    assert.equal(host.imagePath(rows(host)[2]!.thumb as never), PLACEHOLDER);
  } finally {
    await stop();
  }
});

test("searching, empty, and clearing the box back to the start", async () => {
  const { host, tube, stop } = await start({ locale: "zh-Hans" });
  try {
    let release!: () => void;
    tube.results = () => new Promise((resolve) => (release = () => resolve(page([]))));
    const panel = host.mounted();
    panel.emit("search", "nothing");
    await eventually(host, () => assert.equal(panel.props.message, "正在搜索…"));
    release();
    await eventually(host, () => assert.equal(panel.props.message, "没有找到视频。"));
    assert.equal(panel.props["can-retry"], false);
    panel.emit("query-changed", "");
    await eventually(host, () => assert.equal(panel.props.message, "请搜索并按回车键"));
  } finally {
    await stop();
  }
});

test("a newer search wins over an older answer", async () => {
  const { host, tube, stop } = await start();
  try {
    const answers = new Map<string, (value: TubeSearch) => void>();
    tube.results = (query) => new Promise((resolve) => answers.set(query, resolve));
    const panel = host.mounted();
    panel.emit("search", "old");
    panel.emit("search", "new");
    await eventually(host, () => assert.equal(answers.size, 2));
    answers.get("new")!(page([2]));
    await eventually(host, () =>
      assert.deepEqual(
        rows(host).map((row) => row.key),
        [vid(2)],
      ),
    );
    answers.get("old")!(page([1, 3]));
    await host.settle();
    assert.deepEqual(
      rows(host).map((row) => row.key),
      [vid(2)],
    );
  } finally {
    await stop();
  }
});

test("the next page is appended without duplicates, up to the row cap", async () => {
  const { host, tube, stop } = await start({ thumbs: [] });
  try {
    tube.results = () => page([1, 2], () => page([2, 3, 4]));
    await searchFor(host);
    const panel = host.mounted();
    assert.equal(panel.props["can-more"], true);
    panel.emit("more", 2);
    await eventually(host, () =>
      assert.deepEqual(
        rows(host).map((row) => row.key),
        [1, 2, 3, 4].map(vid),
      ),
    );
    assert.equal(panel.props["can-more"], false, "the last page");
    assert.equal(panel.props["loading-more"], false);
    // A search of many pages stops at MAX_ROWS.
    let n = 0;
    const endless = (): TubeSearch =>
      page(
        Array.from({ length: 20 }, () => ++n),
        endless,
      );
    tube.results = endless;
    panel.emit("search", "many");
    await eventually(host, () => assert.equal(rows(host).length, 20));
    for (let i = 0; i < MAX_ROWS / 20 - 1; i++) {
      panel.emit("more", rows(host).length);
      await eventually(host, () => assert.equal(rows(host).length, 20 * (i + 2)));
    }
    assert.equal(panel.props["can-more"], false);
  } finally {
    await stop();
  }
});

test("infinite scroll: one load per page, rows above stay as they are, ↓ on the last row loads too", async () => {
  const { host, tube, stop } = await start({ thumbs: [] });
  try {
    let calls = 0;
    let release!: () => void;
    tube.results = () =>
      page([1, 2, 3], () => {
        calls++;
        return new Promise((resolve) => (release = () => resolve(page([4, 5], () => page([6])))));
      });
    await searchFor(host);
    const panel = host.mounted();
    const before = structuredClone(allRowValues(host));
    // Scrolling sends one request per step while the page loads; a stale count is ignored.
    panel.emit("more", 3);
    panel.emit("more", 3);
    await eventually(host, () => assert.equal(panel.props["loading-more"], true));
    panel.emit("more", 3);
    assert.equal(panel.props["can-more"], false, "not while loading");
    release();
    await eventually(host, () => assert.equal(rows(host).length, 5));
    assert.equal(calls, 1, "the continuation ran once");
    panel.emit("more", 3);
    await host.settle();
    assert.equal(rows(host).length, 5, "a request for a page already added is ignored");
    const after = allRowValues(host);
    assert.deepEqual(after.slice(0, 3), before.slice(0, 3), "rows above are unchanged");
    assert.equal(after.length, MAX_ROWS);
    // ↓ onto the last row loads the next (last) page.
    panel.emit("select", vid(4));
    panel.emit("select-step", 1);
    await eventually(host, () => assert.equal(rows(host).length, 6));
    assert.equal(panel.props["can-more"], false, "no more results");
  } finally {
    await stop();
  }
});

test("a page that fails to load: the reason and Retry at the end, no automatic retries", async () => {
  const { host, tube, stop } = await start({ thumbs: [], locale: "zh-Hans" });
  try {
    let fail = true;
    tube.results = () =>
      page([1, 2], async () => {
        if (fail) throw new TypeError("fetch failed");
        return page([3]);
      });
    await searchFor(host);
    const panel = host.mounted();
    panel.emit("more", 2);
    await eventually(host, () => assert.equal(panel.props["more-error"], "无网络连接。"));
    assert.equal(panel.props["loading-more"], false);
    assert.equal(panel.props["can-more"], false, "scrolling does not retry on its own");
    assert.equal(rows(host).length, 2, "the rows stay");
    fail = false;
    panel.emit("retry-more");
    await eventually(host, () => assert.equal(rows(host).length, 3));
    assert.equal(panel.props["more-error"], "");
  } finally {
    await stop();
  }
});

test("offline: the list says so with Retry, and Retry searches again", async () => {
  const { host, tube, stop } = await start({ locale: "zh-Hans" });
  try {
    tube.results = () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    };
    await searchFor(host, "cats");
    const panel = host.mounted();
    await eventually(host, () => assert.equal(panel.props.message, "无网络连接。"));
    assert.equal(panel.props["can-retry"], true);
    tube.results = () => page([1]);
    panel.emit("retry");
    await eventually(host, () => assert.equal(rows(host).length, 1));
    assert.deepEqual(tube.searches, ["cats", "cats"]);
    assert.equal(panel.props["can-retry"], false);
  } finally {
    await stop();
  }
});

test("a library error is shown with its reason, and a failed session is made again", async () => {
  const tube = fakeTube();
  const factory = tube.factory;
  let broken = true;
  tube.factory = async (options) => {
    if (broken) throw new Error("Could not extract API key");
    return factory(options);
  };
  const { host, stop } = await start({ tube, locale: "zh-Hans" });
  try {
    await searchFor(host);
    await eventually(host, () =>
      assert.equal(host.mounted().props.message, "YouTube 搜索失败：Could not extract API key"),
    );
    broken = false;
    host.mounted().emit("retry");
    await eventually(host, () => assert.equal(rows(host).length, 3));
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------- the panel: selection, play, menu

test("double-click plays the row through the player; the playing row is marked", async () => {
  const { host, stop } = await start();
  try {
    await searchFor(host);
    host.mounted().emit("play", vid(2));
    await eventually(host, () => assert.equal(opens(host).length, 1));
    assert.equal((opens(host)[0]!.intent as { source: string }).source, watchUrl(vid(2)));
    host.setSource({ phase: "ready" });
    await eventually(host, () => assert.equal(rows(host)[1]!.playing, true));
    assert.equal(rows(host)[1]!.selected, true);
    assert.equal(rows(host)[0]!.playing, false);
  } finally {
    await stop();
  }
});

test("a video that fails to play gets the failed mark and an OSD message", async () => {
  const { host, stop } = await start();
  try {
    await searchFor(host);
    host.mounted().emit("play", vid(1));
    await eventually(host, () => assert.equal(opens(host).length, 1));
    host.setSource({ phase: "error", terminalReason: { failed: "YouTube: Video unavailable" } });
    await eventually(host, () => assert.equal(rows(host)[0]!.failed, true));
    assert.equal(host.osd.at(-1), "YouTube: Video unavailable");
    // Playing it again clears the mark.
    host.mounted().emit("play", vid(1));
    await eventually(host, () => assert.equal(rows(host)[0]!.failed, false));
  } finally {
    await stop();
  }
});

test("keys and the right-click menu act on the selected row", async () => {
  const { host, stop } = await start();
  try {
    await searchFor(host);
    const panel = host.mounted();
    panel.emit("select-step", 1);
    await host.settle();
    assert.equal(rows(host)[0]!.selected, true, "↓ from nothing selects the first row");
    panel.emit("select-step", 5);
    await host.settle();
    assert.equal(rows(host)[2]!.selected, true, "clamped at the last row");
    assert.equal(panel.props["can-download"], true);
    panel.emit("context-menu", vid(2), 40, 120);
    await host.settle();
    assert.equal(rows(host)[1]!.selected, true);
    assert.deepEqual(host.menus.at(-1), {
      items: ["youtube.play-selected", "youtube.download-selected"],
      x: 40,
      y: 120,
    });
    assert.equal(await host.press("Enter", { panel: true }), "ran");
    await eventually(host, () => assert.equal(opens(host).length, 1));
    assert.equal((opens(host)[0]!.intent as { source: string }).source, watchUrl(vid(2)));
    panel.emit("focus-changed", true);
    await host.settle();
    assert.equal((panel.locks as { focused: boolean }).focused, true);
    panel.emit("open-url");
    await host.settle();
    assert.equal(host.window("youtube").props.busy, false);
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------- the resolver

test("the resolver hands the player VISIONOS's 1080p video and separate audio, probed first", async () => {
  const { host, net, tube, stop } = await start();
  serve(net, "BaW_jenozKc");
  try {
    const reply = await resolveVia(host, "https://youtu.be/BaW_jenozKc?t=3");
    assert.deepEqual(reply.result, {
      kind: "media",
      originalUrl: "https://youtu.be/BaW_jenozKc?t=3",
      title: "Title BaW_jenozKc",
      primary: { url: "https://cdn.test/BaW_jenozKc/299", headers: {} },
      audio: { url: "https://cdn.test/BaW_jenozKc/251", headers: {} },
    });
    assert.deepEqual(tube.infos, ["VISIONOS BaW_jenozKc"]);
    assert.deepEqual(tube.sessions, [false], "no player script for VISIONOS");
    assert.deepEqual(net.requests, [{ url: "https://cdn.test/BaW_jenozKc/299", range: "bytes=0-" }]);
  } finally {
    await stop();
  }
});

test("fallback clients: no VISIONOS formats → deciphered TV_SIMPLY; a refused URL → the next client", async () => {
  const { host, net, tube, stop } = await start();
  const id = "BaW_jenozKc";
  tube.clients.set("VISIONOS", () => ({
    playability_status: { status: "OK" },
    basic_info: { title: "Kids" },
    streaming_data: { formats: [], adaptive_formats: [] },
  }));
  const tv = format({
    signature_cipher: "s=abc&url=x",
    deciphered: "https://cdn.test/tv/video",
    mime_type: 'video/mp4; codecs="avc1"',
    has_video: true,
    height: 720,
    bitrate: 1,
  });
  const tvAudio = format({
    signature_cipher: "s=def&url=y",
    deciphered: "https://cdn.test/tv/audio",
    mime_type: "audio/mp4",
    has_audio: true,
    bitrate: 1,
  });
  tube.clients.set("TV_SIMPLY", () => ({
    basic_info: { title: "Kids" },
    streaming_data: { formats: [], adaptive_formats: [tv, tvAudio] },
  }));
  net.files.set("https://cdn.test/tv/video", 403);
  tube.clients.set("WEB_EMBEDDED", () => ({
    basic_info: { title: "Kids" },
    streaming_data: {
      formats: [
        format({
          url: "https://cdn.test/muxed",
          mime_type: "video/mp4",
          has_video: true,
          has_audio: true,
          height: 360,
        }),
      ],
      adaptive_formats: [],
    },
  }));
  net.files.set("https://cdn.test/muxed", bytes(10, 0));
  try {
    const reply = await resolveVia(host, watchUrl(id));
    assert.deepEqual(reply.result, {
      kind: "media",
      originalUrl: watchUrl(id),
      title: "Kids",
      primary: { url: "https://cdn.test/muxed", headers: {} },
    });
    assert.deepEqual(tube.infos, [`VISIONOS ${id}`, `TV_SIMPLY ${id}`, `WEB_EMBEDDED ${id}`]);
    assert.deepEqual(tube.sessions, [false, true], "one session with the player script, for the fallbacks");
    assert.deepEqual(tv.calls, [PLAYER_SCRIPT], "TV_SIMPLY's cipher goes through the player script");
  } finally {
    await stop();
  }
});

test("YouTube's own refusals are final and worded for the user", async () => {
  const cases: [TubeInfo, string][] = [
    [
      {
        playability_status: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you’re not a bot" },
        basic_info: {},
      },
      "YouTube 要求确认你不是机器人。当前网络被标记，请换一个网络。",
    ],
    [
      { playability_status: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" }, basic_info: {} },
      "YouTube：Sign in to confirm your age",
    ],
    [{ playability_status: { status: "ERROR" }, basic_info: {} }, "YouTube 无法播放这个视频（ERROR）。"],
  ];
  for (const [info, expected] of cases) {
    const { host, tube, stop } = await start({ locale: "zh-Hans" });
    tube.clients.set("VISIONOS", () => info);
    try {
      const reply = await resolveVia(host, watchUrl("BaW_jenozKc"));
      assert.equal(
        host.translate((reply.error as { $vestraText: string }).$vestraText, (reply.error as { args?: never }).args),
        expected,
      );
      assert.equal(tube.infos.length, 1, "no fallback for the video's own refusal");
    } finally {
      await stop();
    }
  }
});

test("resolver failures: offline, every stream refused, the library failing, no formats", async () => {
  const id = "BaW_jenozKc";
  const run = async (setup: (tube: FakeTube, net: FakeNet) => void, expected: string) => {
    const { host, tube, net, stop } = await start({ locale: "zh-Hans" });
    setup(tube, net);
    try {
      const reply = await resolveVia(host, watchUrl(id));
      const error = reply.error as { $vestraText: string; args?: never };
      assert.equal(host.translate(error.$vestraText, error.args), expected);
    } finally {
      await stop();
    }
  };
  await run((_, net) => (net.offline = true), "无网络连接。");
  await run(
    (tube) => tube.clients.set("VISIONOS", new TypeError("fetch failed", { cause: { code: "EAI_AGAIN" } })),
    "无网络连接。",
  );
  await run((_, net) => net.files.set(`https://cdn.test/${id}/299`, 403), "YouTube 拒绝提供这个视频的流，请稍后再试。");
  await run(
    (tube) => tube.clients.set("VISIONOS", new Error("Type mismatch, got PlayerErrorCommand")),
    "VestraTube 无法读取这个视频：Type mismatch, got PlayerErrorCommand。插件的新版本可能会修复。",
  );
  await run(
    (tube) =>
      tube.clients.set("VISIONOS", () => ({
        playability_status: { status: "OK" },
        basic_info: {},
        streaming_data: { formats: [], adaptive_formats: [] },
      })),
    "这个视频没有播放器能播放的流。",
  );
});

test("a live video plays its HLS manifest", async () => {
  const { host, net, tube, stop } = await start();
  tube.clients.set("VISIONOS", () => ({
    playability_status: { status: "OK" },
    basic_info: { title: "Live", is_live: true },
    streaming_data: { formats: [], adaptive_formats: [], hls_manifest_url: "https://cdn.test/live.m3u8" },
  }));
  net.files.set("https://cdn.test/live.m3u8", new TextEncoder().encode("#EXTM3U"));
  try {
    const reply = await resolveVia(host, watchUrl("BaW_jenozKc"));
    assert.deepEqual(reply.result!.primary, { url: "https://cdn.test/live.m3u8", headers: {} });
    assert.equal(reply.result!.audio, undefined);
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------- downloads

/** ffmpeg as the test host's tool: checks the inputs and writes the MKV it was asked for. */
function fakeFfmpeg(host: TestHost, seen: { args: string[]; inputs: number[] }[] = []) {
  host.tools.handle("ffmpeg", (args) => {
    const inputs = args.flatMap((arg, i) => (args[i - 1] === "-i" ? [readFileSync(arg).length] : []));
    seen.push({ args, inputs });
    writeFileSync(args.at(-1)!, "mkv");
    return {};
  });
  return seen;
}

test("Download… on a row: save dialog, ranges into staging, ffmpeg mux, rename, OSD", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vestra-yt-test-"));
  const { host, net, tube, stop } = await start({ locale: "zh-Hans" });
  const id = vid(2);
  serve(net, id);
  tube.results = () => page([1, 2]);
  const runs = fakeFfmpeg(host);
  try {
    await searchFor(host);
    const panel = host.mounted();
    panel.emit("select", id);
    host.dialogAnswers.push([join(dir, "Video 2.mkv")]);
    panel.emit("download");
    await eventually(host, () => assert.equal(host.osd.at(-1), "已保存：Video 2.mkv"));
    assert.deepEqual(host.fileDialogs.at(-1), {
      kind: "saveFile",
      title: "保存 YouTube 视频",
      fileName: "Video 2.mkv",
    });
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0]!.inputs, [1000, 600], "both streams complete");
    const args = runs[0]!.args;
    assert.deepEqual(args.slice(args.indexOf("-map")), ["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", args.at(-1)]);
    assert.match(args.at(-1)!, /\.vestra-youtube-.*video\.mkv$/, "muxed inside the staging directory");
    assert.equal(await readFile(join(dir, "Video 2.mkv"), "utf8"), "mkv");
    assert.deepEqual(await readdir(dir), ["Video 2.mkv"], "staging removed");
    const ranges = net.requests.filter((r) => r.url.startsWith(`https://cdn.test/${id}/`) && r.range !== "bytes=0-");
    assert.deepEqual(
      ranges.map((r) => r.range),
      ["bytes=0-999", "bytes=0-599"],
    );
    assert.equal(panel.props.downloading, false);
    assert.equal(opens(host).length, 0, "downloading never changes the source");
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a download in progress shows in the bottom bar and can be cancelled; nothing is left behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vestra-yt-test-"));
  const { host, net, stop } = await start();
  const id = vid(1);
  serve(net, id);
  net.hang.add(`https://cdn.test/${id}/251`);
  fakeFfmpeg(host);
  try {
    await searchFor(host);
    const panel = host.mounted();
    panel.emit("select", id);
    host.dialogAnswers.push([join(dir, "a.mkv")]);
    panel.emit("download");
    await eventually(host, () => assert.equal(panel.props.progress, 1000 / 1600));
    assert.equal(panel.props.downloading, true);
    assert.equal(panel.props["can-download"], false);
    assert.equal(panel.props["progress-text"], "Downloading 62%");
    assert.equal(host.command("youtube.cancel-download").state.enabled, true);
    panel.emit("context-menu", id, 1, 1);
    await host.settle();
    assert.deepEqual(host.menus.at(-1)!.items, ["youtube.play-selected", "youtube.cancel-download"]);
    panel.emit("cancel-download");
    await eventually(host, () => assert.equal(host.osd.at(-1), "Download cancelled."));
    assert.equal(panel.props.downloading, false);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unloading during a download stops it and removes the staging directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vestra-yt-test-"));
  await writeFile(join(dir, "keep.mkv"), "original");
  const { host, net, stop } = await start();
  const id = vid(1);
  serve(net, id);
  net.hang.add(`https://cdn.test/${id}/299`);
  try {
    await searchFor(host);
    host.mounted().emit("select", id);
    host.dialogAnswers.push([join(dir, "keep.mkv")]);
    host.mounted().emit("download");
    await eventually(host, () => assert.ok(net.requests.some((r) => r.range === "bytes=0-999")));
    await stop();
    assert.deepEqual(await readdir(dir), ["keep.mkv"]);
    assert.equal(
      await readFile(join(dir, "keep.mkv"), "utf8"),
      "original",
      "an existing file is only replaced by a finished one",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a large stream is fetched in 10 MB ranges; a range that fails on the network is fetched again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vestra-yt-test-"));
  const net = fakeNet();
  const size = 2 * CHUNK_BYTES + 1234;
  net.files.set("https://cdn.test/big", bytes(size, 7));
  let failures = 1;
  const flaky: Fetcher = async (input, init) => {
    const range = new Headers(init?.headers).get("range");
    if (range === `bytes=${CHUNK_BYTES}-${2 * CHUNK_BYTES - 1}` && failures-- > 0) {
      net.requests.push({ url: String(input), range });
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }
    return net.fetch(input, init);
  };
  const fractions: (number | null)[] = [];
  try {
    const name = await downloadMedia({
      media: {
        id: "x",
        title: "Big",
        live: false,
        client: "VISIONOS",
        quality: "",
        primary: { url: "https://cdn.test/big", headers: {} },
      },
      destination: join(dir, "big.mkv"),
      words: zh,
      fetcher: flaky,
      tools: {
        run: async (_tool, args) => {
          assert.equal(readFileSync(args[args.indexOf("-i") + 1]!).length, size, "the whole stream, once");
          writeFileSync(args.at(-1)!, "mkv");
          return { stdout: new Uint8Array(), stderr: "" };
        },
      },
      signal: new AbortController().signal,
      progress: (value) => fractions.push(value.fraction),
    });
    assert.equal(name, "big.mkv");
    assert.deepEqual(
      net.requests.map((r) => r.range),
      [
        `bytes=0-${CHUNK_BYTES - 1}`,
        `bytes=${CHUNK_BYTES}-${2 * CHUNK_BYTES - 1}`,
        `bytes=${CHUNK_BYTES}-${2 * CHUNK_BYTES - 1}`,
        `bytes=${2 * CHUNK_BYTES}-${size - 1}`,
      ],
    );
    assert.equal(fractions.at(-1), null, "no size known before the first range: MB, not a percentage");
    await assert.rejects(
      downloadMedia({
        media: {
          id: "x",
          title: "",
          live: false,
          client: "",
          quality: "",
          primary: { url: "https://cdn.test/big", headers: {} },
        },
        destination: "relative.mkv",
        words: zh,
        fetcher: net.fetch,
        tools: { run: async () => ({ stdout: new Uint8Array(), stderr: "" }) },
        signal: new AbortController().signal,
      }),
      (error) => shown(error) === "请选择 .mkv 保存位置。",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download failures: no ffmpeg, a refused range, a live video", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vestra-yt-test-"));
  const id = vid(1);
  const attempt = async (setup: (host: TestHost, net: FakeNet, tube: FakeTube) => void, expected: string) => {
    const { host, net, tube, stop } = await start();
    serve(net, id);
    setup(host, net, tube);
    try {
      await searchFor(host);
      host.mounted().emit("select", id);
      host.dialogAnswers.push([join(dir, "x.mkv")]);
      host.mounted().emit("download");
      await eventually(host, () => assert.equal(host.osd.at(-1), expected));
      assert.deepEqual(await readdir(dir), []);
    } finally {
      await stop();
    }
  };
  try {
    await attempt(() => {}, "ffmpeg was not found. Downloads use the ffmpeg that comes with Vestra Player.");
    await attempt((host, net) => {
      fakeFfmpeg(host);
      // The probe (of the video) passes; the audio's range is refused.
      net.files.set(`https://cdn.test/${id}/251`, 403);
    }, "YouTube refused the download (HTTP 403).");
    await attempt((host, net, tube) => {
      fakeFfmpeg(host);
      tube.clients.set("VISIONOS", () => ({
        playability_status: { status: "OK" },
        basic_info: { title: "Live", is_live: true },
        streaming_data: { formats: [], adaptive_formats: [], hls_manifest_url: "https://cdn.test/live.m3u8" },
      }));
      net.files.set("https://cdn.test/live.m3u8", bytes(3, 0));
    }, "Live videos can't be downloaded.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the "Enter a link" window (0.3's flows, no yt-dlp)

test("link window: Play submits the normalized URL and reports ready from the source state", async () => {
  const { host, stop } = await start({ locale: "zh-Hans" });
  try {
    await host.command("youtube.open").run();
    const window = host.window("youtube");
    assert.deepEqual(window.callbacks.sort(), ["cancel", "download", "play"]);
    window.emit("play", "https://youtu.be/jNQXAC9IVRw?t=2");
    await host.settle();
    assert.equal((opens(host)[0]!.intent as { source: string }).source, watchUrl("jNQXAC9IVRw"));
    assert.equal(window.props.status, "正在解析并加载视频与音频…");
    assert.equal(window.props.busy, true);
    host.setSource({ phase: "ready" });
    await host.settle();
    assert.equal(window.props.status, "视频已就绪。");
    assert.equal(window.props.busy, false);
    window.emit("play", "https://youtube.com/playlist?list=abc");
    await host.settle();
    assert.match(String(window.props.status), /单个 YouTube 视频/);
    assert.equal(opens(host).length, 1);
  } finally {
    await stop();
  }
});

test("link window: English source texts; cancelling the save dialog; a full download", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vestra-yt-test-"));
  const { host, net, stop } = await start();
  serve(net, "jNQXAC9IVRw");
  fakeFfmpeg(host);
  try {
    assert.deepEqual(host.command("youtube.open").display.path, ["Open", "YouTube Link…"]);
    await host.command("youtube.open").run();
    const window = host.window("youtube");
    assert.equal(window.props.status, "Paste a YouTube video link to play or download it.");
    host.dialogAnswers.push(null);
    window.emit("download", "https://youtu.be/jNQXAC9IVRw");
    await host.settle();
    assert.equal(window.props.status, "No save location was chosen.");
    assert.deepEqual(host.fileDialogs.at(-1), {
      kind: "saveFile",
      title: "Save YouTube Video",
      fileName: "YouTube.mkv",
    });
    host.dialogAnswers.push([join(dir, "saved.mkv")]);
    window.emit("download", "https://youtu.be/jNQXAC9IVRw");
    await eventually(host, () => assert.equal(window.props.status, "Saved: saved.mkv"));
    assert.equal(window.props.progress, 1);
    assert.equal(window.props.busy, false);
    assert.deepEqual(await readdir(dir), ["saved.mkv"]);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("link window: Cancel stops the running download and closes the window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vestra-yt-test-"));
  const { host, net, stop } = await start({ locale: "zh-Hans" });
  serve(net, "jNQXAC9IVRw");
  net.hang.add("https://cdn.test/jNQXAC9IVRw/299");
  try {
    await host.command("youtube.open").run();
    const window = host.window("youtube");
    host.dialogAnswers.push([join(dir, "a.mkv")]);
    window.emit("download", "https://youtu.be/jNQXAC9IVRw");
    await eventually(host, () => assert.ok(net.requests.some((r) => r.range === "bytes=0-999")));
    assert.equal(host.mounted().props.downloading, true, "the panel shows the window's download too");
    window.emit("cancel");
    await eventually(host, () => assert.equal(host.mounted().props.downloading, false));
    assert.equal(host.sent("ui.close").length, 1);
    await host.command("youtube.open").run();
    assert.equal(host.window("youtube").props.status, "粘贴 YouTube 视频链接以播放或下载。");
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
