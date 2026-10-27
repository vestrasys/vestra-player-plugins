import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TextError } from "@vestra-player/sdk";
import { startPlugin } from "@vestra-player/sdk/testing";
import { verifyDetached, YT_DLP_FINGERPRINT, ytDlpKey } from "../openpgp.ts";
import {
  assetFor,
  checksumOf,
  compareTags,
  DEFAULT_STATE,
  FORCED_INTERVAL,
  looksOutdated,
  MIN_TAG,
  UPDATE_INTERVAL,
  YtDlp,
  type Options,
  type Progress,
  type State,
} from "../ytdlp.ts";
import { github, KEY, sha256, signature } from "./github.ts";
import { SIGNATURE, SUMS } from "./release.ts";

/** `plugin.i18n` with this package's Simplified Chinese catalog (no host calls). */
const zh = await (async () => {
  const { plugin, stop } = await startPlugin(() => {}, {
    directory: new URL("..", import.meta.url),
    locale: "zh-Hans",
  });
  await stop();
  return plugin.i18n;
})();
const english = (error: unknown) => (error as Error).message;
const shown = (error: unknown) => zh.resolve((error as TextError).text);

const ASSET = "yt-dlp_linux";
const BINARY = Buffer.from("#!/bin/sh\necho 2026.10.26\n".repeat(20_000)); // ~0.5 MB: several progress steps

interface Setup {
  directory: string;
  state: State;
  asks: number;
  answer: boolean;
  runs: string[][];
  progress: (Progress | null)[];
  installed: boolean[];
  now: number;
  fake: ReturnType<typeof github>;
  ytdlp: YtDlp;
}

/** A YtDlp on a Linux x64 machine without yt-dlp on the PATH, against a fake GitHub. */
async function setup(options: Partial<Options> = {}, state: Partial<State> = {}): Promise<Setup> {
  const directory = await mkdtemp(join(tmpdir(), "vestrabili-"));
  const fake = github(ASSET, { tag: "2026.10.26", content: BINARY });
  const s = {
    directory,
    state: { ...DEFAULT_STATE, ...state },
    asks: 0,
    answer: true,
    runs: [],
    progress: [],
    installed: [],
    now: 1_800_000_000_000,
    fake,
  } as unknown as Setup;
  s.ytdlp = new YtDlp({
    directory,
    store: {
      get value() {
        return s.state;
      },
      save(next) {
        s.state = next;
      },
    },
    error: zh.error,
    ask: async () => {
      s.asks++;
      return s.answer;
    },
    progress: (p) => s.progress.push(p),
    installed: (first) => s.installed.push(first),
    fetch: (input, init) => s.fake.fetch(input, init),
    run: async (program, args) => {
      s.runs.push([program, ...args]);
      // A program that runs is complete: the file must already hold every byte.
      assert.deepEqual(await readFile(program), s.fake.release.content);
      return `${s.fake.release.reports ?? s.fake.release.tag}\n`;
    },
    key: KEY,
    platform: "linux",
    arch: "x64",
    env: { PATH: "" },
    now: () => s.now,
    ...options,
  });
  return s;
}
const bin = (s: Setup) => join(s.directory, "bin");
const files = async (s: Setup) => (await readdir(bin(s)).catch(() => [])).sort();

test("the pinned key is yt-dlp's, and it verifies yt-dlp's real release signature", () => {
  assert.equal(ytDlpKey().fingerprint, YT_DLP_FINGERPRINT);
  assert.equal(verifyDetached(SUMS, SIGNATURE), true);
  assert.equal(checksumOf(SUMS.toString(), "yt-dlp.exe"), "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d");
  const changed = Buffer.from(SUMS);
  changed[3] ^= 1;
  assert.equal(verifyDetached(changed, SIGNATURE), false);
  const broken = Buffer.from(SIGNATURE);
  broken[broken.length - 5] ^= 1;
  assert.equal(verifyDetached(SUMS, broken), false);
  assert.equal(verifyDetached(SUMS, Buffer.from("not a signature")), false);
  assert.equal(verifyDetached(SUMS, Buffer.alloc(0)), false);
  // Signed by another key: refused even though the signature itself is sound.
  assert.equal(verifyDetached(SUMS, signature(SUMS)), false);
  assert.equal(verifyDetached(SUMS, signature(SUMS), KEY), true);
});

test("one standalone build per system, from the release's checksum list", () => {
  assert.equal(assetFor("win32", "x64")?.name, "yt-dlp.exe");
  assert.equal(assetFor("win32", "arm64")?.name, "yt-dlp_arm64.exe");
  assert.equal(assetFor("win32", "ia32")?.name, "yt-dlp_x86.exe");
  assert.equal(assetFor("darwin", "arm64")?.name, "yt-dlp_macos");
  assert.equal(assetFor("darwin", "x64")?.name, "yt-dlp_macos");
  assert.equal(assetFor("linux", "arm64")?.name, "yt-dlp_linux_aarch64");
  assert.equal(assetFor("freebsd", "x64"), undefined);
  for (const platform of ["win32", "darwin", "linux"])
    assert.ok(checksumOf(SUMS.toString(), assetFor(platform, platform === "darwin" ? "arm64" : "x64")!.name));
  assert.equal(checksumOf(SUMS.toString(), "yt-dlp"), "e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3");
  assert.equal(checksumOf(SUMS.toString(), "yt-dlp.ex"), undefined);
  assert.equal(looksOutdated("HTTP Error 412: Precondition Failed"), true);
  assert.equal(looksOutdated("Unable to extract initial state; please report this issue"), true);
  assert.equal(looksOutdated("This video is private"), false);
});

test("consent: nothing is downloaded before the user agrees; a refusal is remembered", async () => {
  const s = await setup();
  s.answer = false;
  await assert.rejects(s.ytdlp.program({ interactive: false }), (error) =>
    english(error) === "VestraBili needs yt-dlp to play Bilibili links. Open → VestraBili… downloads it." &&
    shown(error) === "VestraBili 需要 yt-dlp 才能播放 Bilibili 链接。可在“打开 → VestraBili…”中下载。");
  assert.equal(s.asks, 1);
  assert.equal(s.state.consent, "declined");
  // A playlist link does not ask again…
  await assert.rejects(s.ytdlp.program({ interactive: false }));
  assert.equal(s.asks, 1);
  // …the window's Play does.
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
    english(error) === "VestraBili needs yt-dlp to play Bilibili links. Press Play to download it.");
  assert.equal(s.asks, 2);
  assert.deepEqual(s.fake.urls, []);
  s.answer = true;
  const path = await s.ytdlp.program({ interactive: true });
  assert.equal(s.asks, 3);
  assert.equal(s.state.consent, "granted");
  assert.equal(path, join(bin(s), ASSET));
  await rm(s.directory, { recursive: true });
});

test("a verified download is tested, then installed atomically and reused without the network", async () => {
  const s = await setup();
  const [a, b] = await Promise.all([s.ytdlp.program({ interactive: false }), s.ytdlp.program({ interactive: true })]);
  assert.equal(a, b);
  assert.equal(s.asks, 1, "two callers share one question");
  assert.deepEqual(s.fake.urls, [
    "https://github.com/yt-dlp/yt-dlp/releases/latest",
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/SHA2-256SUMS",
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/SHA2-256SUMS.sig",
    `https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/${ASSET}`,
  ]);
  // `--version` ran on the complete temporary file, before it was renamed into place.
  assert.equal(s.runs.length, 1);
  assert.match(s.runs[0]![0]!, /[\\/]\.download-[0-9a-f]{12}-yt-dlp_linux$/);
  assert.deepEqual(s.runs[0]!.slice(1), ["--ignore-config", "--version"]);
  assert.deepEqual(await files(s), [ASSET]);
  assert.deepEqual(await readFile(a), BINARY);
  assert.deepEqual(s.state.installed, { tag: "2026.10.26", asset: ASSET, sha256: sha256(BINARY) });
  assert.deepEqual(s.installed, [true]);
  assert.ok(s.progress.length > 2 && s.progress.at(-1) === null);
  assert.deepEqual(s.progress.at(-2), { received: BINARY.length, total: BINARY.length });
  // Next time: no question, no request.
  const urls = s.fake.urls.length;
  assert.equal(await s.ytdlp.program({ interactive: false }), a);
  assert.equal(s.fake.urls.length, urls);
  assert.equal(s.asks, 1);
  await rm(s.directory, { recursive: true });
});

test("a checksum mismatch or a forged signature is refused and nothing runs", async () => {
  const s = await setup();
  s.fake.release.listed = sha256(Buffer.from("something else"));
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
    english(error) === "The downloaded yt-dlp did not match its published checksum and was discarded. Try again." &&
    shown(error) === "下载的 yt-dlp 与公布的校验和不符，已丢弃。请重试。");
  assert.deepEqual(s.runs, []);
  assert.deepEqual(await files(s), []);
  assert.equal(s.state.installed, null);

  s.fake.release = { tag: "2026.10.26", content: BINARY, forged: true };
  const before = s.fake.urls.length;
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
    /isn't signed by the yt-dlp project's key/.test(english(error)));
  assert.equal(s.fake.urls.slice(before).some((url) => url.endsWith(ASSET)), false, "the asset is not even fetched");
  assert.deepEqual(s.runs, []);
  assert.deepEqual(await files(s), []);
  await rm(s.directory, { recursive: true });
});

test("a partial download is never executed or installed; leftovers and a changed copy are discarded", async () => {
  const s = await setup();
  s.fake.release.truncated = true;
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
    english(error) === "Can't download yt-dlp: GitHub can't be reached. Check the internet connection or proxy.");
  assert.deepEqual(s.runs, []);
  assert.deepEqual(await files(s), [], "the temporary file is removed");

  // A crash in the middle of an earlier download left a temporary file: it is removed, never used.
  await mkdir(bin(s), { recursive: true });
  await writeFile(join(bin(s), `.download-000000000000-${ASSET}`), "partial");
  s.fake.release.truncated = false;
  const path = await s.ytdlp.program({ interactive: true });
  assert.deepEqual(await files(s), [ASSET]);

  // The installed copy changed on disk (corrupted, replaced): deleted and downloaded again.
  await writeFile(path, "corrupted");
  assert.equal(await s.ytdlp.managed(), undefined);
  assert.deepEqual(await files(s), []);
  assert.equal(s.state.installed, null);
  // With consent given, the next link downloads it again without asking.
  assert.equal(await s.ytdlp.program({ interactive: false }), path);
  assert.equal(s.asks, 1);
  await rm(s.directory, { recursive: true });
});
test("rate limits, an offline network, cancelling and an unknown system each say what happened", async () => {
  const s = await setup();
  for (const status of [403, 429]) {
    s.fake.status = status;
    await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
      english(error) === "Can't download yt-dlp: GitHub is limiting downloads right now. Try again later." &&
      shown(error) === "无法下载 yt-dlp：GitHub 当前限制了下载，请稍后重试。");
  }
  s.fake.status = 500;
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) => english(error) === "Can't download yt-dlp: GitHub answered HTTP 500.");
  s.fake.status = undefined;
  s.fake.offline = true;
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
    shown(error) === "无法下载 yt-dlp：无法连接 GitHub。请检查网络连接或代理。");
  s.fake.offline = false;
  s.fake.midway = () => s.ytdlp.cancel();
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) => english(error) === "The yt-dlp download was cancelled.");
  assert.deepEqual(s.runs, []);
  assert.deepEqual(await files(s), []);
  await rm(s.directory, { recursive: true });

  const odd = await setup({ platform: "freebsd" });
  await assert.rejects(odd.ytdlp.program({ interactive: true }), (error) =>
    english(error) === "yt-dlp has no ready-made build for this system (freebsd-x64). Install yt-dlp and put it on the PATH.");
  assert.equal(odd.asks, 0);
  await rm(odd.directory, { recursive: true });
});

test("a build the system won't run is not installed", async () => {
  const s = await setup({ run: async () => { throw Object.assign(new Error("blocked"), { code: "EPERM" }); } });
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
    english(error) === "yt-dlp was downloaded but couldn't run. Security software may have blocked or removed it.");
  assert.deepEqual(await files(s), []);
  assert.equal(s.state.installed, null);
  await rm(s.directory, { recursive: true });
});

test("yt-dlp on the PATH or named by VESTRA_YTDLP is used as it is", async () => {
  const s = await setup();
  const own = join(s.directory, "own");
  await mkdir(own);
  await writeFile(join(own, "yt-dlp"), "#!/bin/sh\n", { mode: 0o755 });
  if (process.platform !== "win32") {
    const posix = await setup({ env: { PATH: `/nothing:${own}` } });
    assert.equal(await posix.ytdlp.program({ interactive: false }), join(own, "yt-dlp"));
    await rm(posix.directory, { recursive: true });
  }
  const windows = await setup({ platform: "win32", env: { PATH: `C:\\nothing;${own}` } });
  await writeFile(join(own, "yt-dlp.exe"), "MZ");
  assert.equal(await windows.ytdlp.program({ interactive: false }), join(own, "yt-dlp.exe"));
  assert.equal(windows.asks, 0);
  const named = await setup({ env: { PATH: "", VESTRA_YTDLP: join(own, "yt-dlp") } });
  assert.equal(await named.ytdlp.program({ interactive: false }), join(own, "yt-dlp"));
  assert.equal(await named.ytdlp.update({ force: true }), false, "a copy the user manages is never updated");
  const missing = await setup({ env: { VESTRA_YTDLP: join(own, "nope") } });
  await assert.rejects(missing.ytdlp.program({ interactive: false }), (error) =>
    /^VESTRA_YTDLP names a file that does not exist: /.test(english(error)));
  for (const each of [named, missing, windows]) assert.deepEqual(each.fake.urls, []);
  for (const each of [s, windows, named, missing]) await rm(each.directory, { recursive: true });
});

test("updates: at most daily, never while resolving, quietly, and forced at most hourly", async () => {
  const s = await setup();
  await s.ytdlp.program({ interactive: true });
  const installedAt = s.now;
  const count = () => s.fake.urls.length;
  let urls = count();
  // Within a day of the install: no request.
  s.now += UPDATE_INTERVAL - 1;
  assert.equal(await s.ytdlp.update(), false);
  assert.equal(count(), urls);
  // A day later, but a link is being resolved: wait.
  s.now = installedAt + UPDATE_INTERVAL;
  s.ytdlp.resolving = 1;
  assert.equal(await s.ytdlp.update(), false);
  assert.equal(count(), urls);
  s.ytdlp.resolving = 0;
  // Same release: one request, nothing downloaded.
  assert.equal(await s.ytdlp.update(), false);
  assert.deepEqual(s.fake.urls.slice(urls), ["https://github.com/yt-dlp/yt-dlp/releases/latest"]);
  assert.equal(s.state.checkedAt, s.now);
  urls = count();
  assert.equal(await s.ytdlp.update(), false);
  assert.equal(count(), urls, "checked: not again the same day");
  // A new release a day later: downloaded through the same verified path, without progress on screen.
  s.now += UPDATE_INTERVAL;
  const content = Buffer.concat([BINARY, Buffer.from("new")]);
  s.fake.release = { tag: "2026.11.01", content };
  const shownProgress = s.progress.length;
  assert.equal(await s.ytdlp.update(), true);
  assert.equal(s.progress.length, shownProgress);
  assert.equal(s.state.installed?.tag, "2026.11.01");
  assert.deepEqual(await readFile(join(bin(s), ASSET)), content);
  assert.deepEqual(s.installed, [true, false]);
  // A failed extraction forces a check, at most once an hour.
  s.fake.release = { tag: "2026.11.02", content: Buffer.concat([content, Buffer.from("!")]) };
  assert.equal(await s.ytdlp.update({ force: true }), true);
  s.fake.release = { tag: "2026.11.03", content };
  urls = count();
  s.now += FORCED_INTERVAL - 1;
  assert.equal(await s.ytdlp.update({ force: true }), false);
  assert.equal(count(), urls);
  s.now += 1;
  assert.equal(await s.ytdlp.update({ force: true }), true);
  // A failing check rejects (the caller logs it) and leaves the copy in place.
  s.now += UPDATE_INTERVAL;
  s.fake.status = 429;
  await assert.rejects(s.ytdlp.update(), /limiting downloads/);
  assert.equal(s.state.installed?.tag, "2026.11.03");
  assert.deepEqual(await files(s), [ASSET]);
  await rm(s.directory, { recursive: true });
});

test("no rollback: an older or malformed tag, or a build that reports another version, is refused", async () => {
  assert.ok(compareTags("2026.10.26.1", "2026.10.26") > 0);
  assert.ok(compareTags("2026.9.30", "2026.10.01") < 0);
  assert.equal(compareTags(MIN_TAG, "2026.10.26"), 0);
  // "latest" points below the oldest accepted release: nothing is fetched beyond the lookup.
  const s = await setup();
  s.fake.release = { tag: "2025.12.31", content: BINARY };
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
    english(error) === "yt-dlp's latest release (2025.12.31) is older than the one VestraBili expects, so it wasn't downloaded. Try again later.");
  assert.deepEqual(s.fake.urls, ["https://github.com/yt-dlp/yt-dlp/releases/latest"]);
  // Not a release tag at all.
  s.fake.release = { tag: "nightly", content: BINARY };
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
    english(error) === "Can't download yt-dlp: GitHub gave an unexpected answer.");
  // An older genuine build (its real checksum, a valid signature) served under a newer tag.
  s.fake.release = { tag: "2026.11.05", content: BINARY, reports: "2026.10.26" };
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
    english(error) === "The downloaded yt-dlp reports version 2026.10.26 instead of 2026.11.05, so it was discarded.");
  assert.deepEqual(await files(s), []);
  assert.equal(s.state.installed, null);
  // Installed 2026.11.05; "latest" then points back to 2026.10.26: no update, no download.
  s.fake.release = { tag: "2026.11.05", content: BINARY };
  await s.ytdlp.program({ interactive: true });
  s.fake.release = { tag: "2026.10.26", content: Buffer.from("older") };
  s.now += UPDATE_INTERVAL;
  const before = s.fake.urls.length;
  assert.equal(await s.ytdlp.update(), false);
  assert.equal(await s.ytdlp.update({ force: true }), false);
  assert.deepEqual(s.fake.urls.slice(before), [
    "https://github.com/yt-dlp/yt-dlp/releases/latest",
    "https://github.com/yt-dlp/yt-dlp/releases/latest",
  ], "two lookups, no download");
  const state: State = s.state; // (not narrowed by the earlier null check)
  assert.equal(state.installed?.tag, "2026.11.05");
  await rm(s.directory, { recursive: true });
});

test("redirects must end at GitHub over HTTPS; a silent server times out; a missing build is named", async () => {
  const s = await setup({ stall: 50 });
  s.fake.redirectTo = "https://evil.example/yt-dlp";
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
    english(error) === "Can't download yt-dlp: the download was redirected somewhere other than GitHub.");
  s.fake.redirectTo = "http://objects.githubusercontent.com/x";
  await assert.rejects(s.ytdlp.program({ interactive: true }), /redirected somewhere other than GitHub/);
  s.fake.redirectTo = undefined;
  s.fake.hang = true;
  await assert.rejects(s.ytdlp.program({ interactive: true }), (error) =>
    english(error) === "Can't download yt-dlp: the connection stalled. Try again later.");
  s.fake.hang = false;
  await rm(s.directory, { recursive: true });
  const arm = await setup({ arch: "arm" }, {});
  // linux-arm has no asset: the system check speaks first; a release without our asset is named.
  await assert.rejects(arm.ytdlp.program({ interactive: true }), /no ready-made build for this system \(linux-arm\)/);
  await rm(arm.directory, { recursive: true });
  const other = await setup();
  const unlisted = github("yt-dlp_other", { tag: "2026.10.26", content: BINARY });
  other.fake = unlisted;
  await assert.rejects(other.ytdlp.program({ interactive: true }), (error) =>
    english(error) === "Can't download yt-dlp: this release doesn't list yt-dlp_linux.");
  assert.deepEqual(other.runs, []);
  await rm(other.directory, { recursive: true });
});

test("the PATH search skips relative entries and unquotes Windows ones; an unreadable copy is kept", async () => {
  const s = await setup();
  const own = join(s.directory, "own");
  await mkdir(own);
  await writeFile(join(own, "yt-dlp.exe"), "MZ");
  const quoted = await setup({ platform: "win32", env: { PATH: `.;own;"${own}"` } });
  assert.equal(await quoted.ytdlp.onPath(), join(own, "yt-dlp.exe"));
  const relative = await setup({ platform: "win32", env: { PATH: `.;${join("relative", "dir")}` } });
  assert.equal(await relative.ytdlp.onPath(), undefined);
  // The managed copy can't be read right now (here: a directory in its place): nothing is deleted.
  const path = await s.ytdlp.program({ interactive: true });
  const installed = s.state.installed;
  await rm(path);
  await mkdir(path);
  assert.equal(await s.ytdlp.managed(), undefined);
  assert.deepEqual(s.state.installed, installed);
  assert.deepEqual(await files(s), [ASSET]);
  for (const each of [s, quoted, relative]) await rm(each.directory, { recursive: true });
});

test("the verifier refuses what gpg refuses (mutations of yt-dlp's real signature)", () => {
  const body = SIGNATURE.subarray(3);
  const flip = (index: number, bits: number) => {
    const copy = Buffer.from(SIGNATURE);
    copy[index]! ^= bits;
    return copy;
  };
  const hashedLength = SIGNATURE.readUInt16BE(3 + 4);
  const unhashedAt = 3 + 6 + hashedLength;
  const unhashedLength = SIGNATURE.readUInt16BE(unhashedAt);
  const withUnhashed = (extra: Buffer) => {
    const packet = Buffer.concat([
      SIGNATURE.subarray(3, unhashedAt),
      Buffer.from([0, unhashedLength + extra.length]),
      SIGNATURE.subarray(unhashedAt + 2, unhashedAt + 2 + unhashedLength),
      extra,
      SIGNATURE.subarray(unhashedAt + 2 + unhashedLength),
    ]);
    return Buffer.concat([Buffer.from([0x89, packet.length >> 8, packet.length & 0xff]), packet]);
  };
  const sha1 = Buffer.from(SIGNATURE);
  sha1[6] = 2;
  for (const [name, mutated] of [
    ["version 3", flip(3, 7)],
    ["type 0x01 (text)", flip(4, 1)],
    ["hash SHA-1", sha1],
    ["hashed creation time changed", flip(3 + 6 + 2 + 23 + 2 + 3, 1)],
    ["hashed issuer changed", flip(3 + 6 + 5, 1)],
    ["truncated by one byte", SIGNATURE.subarray(0, SIGNATURE.length - 1)],
    ["header only", SIGNATURE.subarray(0, 10)],
    ["foreign issuer in the unhashed area", withUnhashed(Buffer.from([9, 16, 1, 2, 3, 4, 5, 6, 7, 8]))],
  ] as const)
    assert.equal(verifyDetached(SUMS, mutated), false, name);
  assert.equal(verifyDetached(Buffer.from(SUMS.toString().replace(/\n/g, "\r\n")), SIGNATURE), false, "CRLF data");
  // Other valid encodings of the same packet are accepted, as gpg accepts them.
  const oldFormat = Buffer.concat([Buffer.from([0x8a, 0, 0, body.length >> 8, body.length & 0xff]), body]);
  const newFormat = Buffer.concat([Buffer.from([0xc2, 0xff, 0, 0, body.length >> 8, body.length & 0xff]), body]);
  assert.equal(verifyDetached(SUMS, oldFormat), true, "old format, 4-byte length");
  assert.equal(verifyDetached(SUMS, newFormat), true, "new format, 5-byte length");
});
