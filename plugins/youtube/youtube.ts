import { Innertube, Log, Platform } from "youtubei.js";
import type { I18n, TextError } from "@vestra-player/sdk";
import { evaluate } from "./evaluator.ts";

/** `plugin.i18n.error`: failures the player shows translated. */
export type Fail = I18n["error"];
/** `plugin.i18n`'s `text` and `error`: this plugin's words, translated by the player. */
export type Words = Pick<I18n, "text" | "error">;
export type Fetcher = typeof fetch;

/** One stream URL for the player (or the downloader). `bytes` is YouTube's `clen`, when known. */
export type Stream = { url: string; headers: Record<string, string>; bytes?: number };
export type MediaDescriptor = {
  id: string;
  title: string;
  primary: Stream;
  audio?: Stream;
  live: boolean;
  /** The InnerTube client that gave the streams, and what was chosen ("1080p60 avc1 + mp4a"). */
  client: string;
  quality: string;
};
/** A search result. `seconds` is null for live and upcoming videos. */
export type Video = { id: string; title: string; channel: string; seconds: number | null; live: boolean };
export type Page = { videos: Video[]; more: (() => Promise<Page>) | null };

// ---------------------------------------------------------------- the part of youtubei.js we use
// Structural types, so tests can stand in for the library without the network.

export type TubeFormat = {
  itag: number;
  url?: string;
  signature_cipher?: string;
  cipher?: string;
  mime_type: string;
  has_video: boolean;
  has_audio: boolean;
  height?: number;
  fps?: number;
  bitrate: number;
  quality_label?: string;
  is_drc?: boolean;
  content_length?: number;
  audio_track?: { audio_is_default: boolean };
  decipher(player?: unknown): Promise<string>;
};
export type TubeInfo = {
  playability_status?: { status: string; reason?: string };
  basic_info: { title?: string; is_live?: boolean };
  streaming_data?: { formats: TubeFormat[]; adaptive_formats: TubeFormat[]; hls_manifest_url?: string | null };
};
export type TubeSearch = {
  videos: readonly unknown[];
  has_continuation: boolean;
  getContinuation(): Promise<TubeSearch>;
};
export type Tube = {
  session: { player?: unknown };
  search(query: string, filters: { type: "video" }): Promise<TubeSearch>;
  getBasicInfo(id: string, options: { client: string }): Promise<TubeInfo>;
};
/** Makes a session: `player` loads YouTube's player script (needed only to decipher fallback clients). */
export type TubeFactory = (options: { player: boolean; lang: string }) => Promise<Tube>;

Log.setLevel(Log.Level.NONE); // parser notes go to the library's issue tracker, not our log
// youtubei.js leaves running YouTube's player script to us (evaluator.ts).
Platform.shim.eval = (data: { output: string }) => evaluate(data.output) as never;

/** The real library. A session fetched from YouTube (not generated locally): VISIONOS needs its visitor data. */
export const innertube: TubeFactory = async ({ player, lang }) =>
  (await Innertube.create({ retrieve_player: player, lang, generate_session_locally: false })) as unknown as Tube;

// ---------------------------------------------------------------- links

const HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"];
export const resolverHosts = [...HOSTS, "youtu.be"];
export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
export const thumbnailUrl = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);

/** The video id of a single-video link, or null. */
export function videoIdOf(input: string | null | undefined): string | null {
  if (!input) return null;
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.split("/")[1] ?? null;
  else if (HOSTS.includes(host)) {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else if (/^\/(shorts|live|embed)\//.test(u.pathname)) id = u.pathname.split("/")[2] ?? null;
  }
  return validId(id) ? id : null;
}

export function normalizeYouTubeUrl(input: string, error: Fail): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw error("Enter the full link of a YouTube video.");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port)
    throw error("Only HTTPS YouTube video links are supported.");
  const id = videoIdOf(input);
  if (!id) throw error("Enter the link of a single YouTube video (watch, shorts, live or youtu.be).");
  return watchUrl(id);
}

// ---------------------------------------------------------------- errors

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** A failed fetch: no network, DNS, refused or reset connection. */
export function isNetworkError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    if (e instanceof TypeError && /fetch failed|network/i.test(e.message)) return true;
  }
  return false;
}

/** Our own failures carry their translatable text. */
export const isTextError = (error: unknown): error is TextError => error instanceof Error && "text" in error;
/** Marks the "No network connection." failure, so the panel can offer Retry. */
export const isOffline = (error: unknown) => isTextError(error) && (error as { offline?: boolean }).offline === true;

export const oneLine = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const messageOf = (error: unknown) => oneLine(error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------- choosing streams

/** H.264 plays (and decodes in hardware) almost everywhere; then VP9, then AV1. */
function codecRank(mime: string): number {
  if (/avc1/.test(mime)) return 0;
  if (/vp0?9/.test(mime)) return 1;
  if (/av01/.test(mime)) return 2;
  return 9;
}
const codecName = (mime: string) => /codecs="([^".]+)/.exec(mime)?.[1] ?? mime.split(";")[0] ?? "";
const usable = (f: TubeFormat) => !!(f.url || f.signature_cipher || f.cipher);
export const MAX_HEIGHT = 1080;

/** The best video up to 1080p plus the best audio of the default track; a muxed format as the last resort. */
export function pickFormats(info: TubeInfo): { video: TubeFormat; audio?: TubeFormat } | null {
  const data = info.streaming_data;
  if (!data) return null;
  const all = [...(data.formats ?? []), ...(data.adaptive_formats ?? [])].filter(usable);
  const video = all
    .filter((f) => f.has_video && !f.has_audio && (f.height ?? 0) <= MAX_HEIGHT && codecRank(f.mime_type) < 9)
    .sort(
      (a, b) =>
        (b.height ?? 0) - (a.height ?? 0) ||
        codecRank(a.mime_type) - codecRank(b.mime_type) ||
        (b.fps ?? 0) - (a.fps ?? 0) ||
        b.bitrate - a.bitrate,
    )[0];
  const audios = all.filter((f) => f.has_audio && !f.has_video && !f.is_drc);
  const original = audios.filter((f) => !f.audio_track || f.audio_track.audio_is_default);
  const audio = (original.length ? original : audios).sort((a, b) => b.bitrate - a.bitrate)[0];
  if (video && audio) return { video, audio };
  const muxed = all
    .filter((f) => f.has_video && f.has_audio)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bitrate - a.bitrate)[0];
  return muxed ? { video: muxed } : null;
}

// ---------------------------------------------------------------- the service

/**
 * The clients to ask, in order. VISIONOS gives direct URLs without a player
 * script or PO token (measured 2026-10-26: 1080p60 H.264 + AAC/Opus). The
 * others are fallbacks for videos VISIONOS has no formats for; their URLs
 * are probed before use, since without PO tokens YouTube often refuses them.
 */
export const CLIENTS: readonly { client: string; player: boolean }[] = [
  { client: "VISIONOS", player: false },
  { client: "TV_SIMPLY", player: true },
  { client: "WEB_EMBEDDED", player: true },
  { client: "IOS", player: false },
  { client: "ANDROID_VR", player: false },
];
/** A session is renewed after this long (its visitor data ages). */
const SESSION_MS = 30 * 60 * 1000;
const PROBE_MS = 10_000;

type Options = { factory?: TubeFactory; fetcher?: Fetcher; lang?: string };

export class YouTube {
  readonly fetch: Fetcher;
  readonly #words: Words;
  readonly #factory: TubeFactory;
  readonly #lang: string;
  readonly #sessions = new Map<boolean, { tube: Promise<Tube>; at: number }>();

  constructor(words: Words, options: Options = {}) {
    this.#words = words;
    this.#factory = options.factory ?? innertube;
    this.fetch = options.fetcher ?? ((...args) => fetch(...args));
    this.#lang = options.lang ?? "en";
  }

  /** A shared session; a failed one is forgotten so the next call tries again. */
  #session(player: boolean): Promise<Tube> {
    const cached = this.#sessions.get(player);
    if (cached && Date.now() - cached.at < SESSION_MS) return cached.tube;
    const tube = this.#factory({ player, lang: this.#lang });
    this.#sessions.set(player, { tube, at: Date.now() });
    tube.catch(() => {
      if (this.#sessions.get(player)?.tube === tube) this.#sessions.delete(player);
    });
    return tube;
  }

  #offline(): TextError {
    return Object.assign(this.#words.error("No network connection."), { offline: true });
  }

  /** Our own errors pass; a network failure is "offline"; anything else is the library's, with its message. */
  #explain(error: unknown, explained: (reason: string) => TextError): Error {
    if (isTextError(error)) return error;
    if (isNetworkError(error)) return this.#offline();
    return explained(messageOf(error));
  }

  async search(query: string): Promise<Page> {
    try {
      const tube = await this.#session(false);
      return this.#page(await tube.search(query, { type: "video" }));
    } catch (error) {
      throw this.#explain(error, (reason) => this.#words.error("YouTube search failed: {}", [reason]));
    }
  }

  #page(result: TubeSearch): Page {
    const videos = result.videos.map(toVideo).filter((video): video is Video => video !== null);
    const more = result.has_continuation
      ? async () => {
          try {
            return this.#page(await result.getContinuation());
          } catch (error) {
            throw this.#explain(error, (reason) => this.#words.error("YouTube search failed: {}", [reason]));
          }
        }
      : null;
    return { videos, more };
  }

  /** Stream URLs for one video: VISIONOS first, then the fallbacks; every URL is probed once. */
  async resolve(input: string, signal?: AbortSignal): Promise<MediaDescriptor> {
    const { error } = this.#words;
    const id = videoIdOf(normalizeYouTubeUrl(input, error))!;
    let refused = false;
    let failure: unknown;
    for (const { client, player } of CLIENTS) {
      signal?.throwIfAborted();
      let tube: Tube;
      let info: TubeInfo;
      try {
        tube = await this.#session(player);
        info = await tube.getBasicInfo(id, { client });
      } catch (caught) {
        if (isNetworkError(caught)) throw this.#offline();
        failure ??= caught;
        continue;
      }
      signal?.throwIfAborted();
      const status = info.playability_status?.status ?? "OK";
      // YouTube's answer about the video itself (removed, private, age, region, bot check) is final.
      if (status !== "OK") throw this.#refusal(status, info.playability_status?.reason);
      const live = info.basic_info.is_live === true;
      const title = info.basic_info.title || "YouTube";
      try {
        let media: MediaDescriptor | null = null;
        const hls = info.streaming_data?.hls_manifest_url;
        if (live && hls) media = { id, title, live, client, quality: "HLS", primary: { url: hls, headers: {} } };
        else {
          const picked = pickFormats(info);
          if (!picked) continue;
          const decipherWith = player ? tube.session.player : undefined;
          const stream = async (format: TubeFormat): Promise<Stream> => ({
            url: await format.decipher(decipherWith),
            headers: {},
            ...(format.content_length ? { bytes: format.content_length } : {}),
          });
          const primary = await stream(picked.video);
          const audio = picked.audio ? await stream(picked.audio) : undefined;
          if (!primary.url || (audio && !audio.url)) continue;
          const label = picked.video.quality_label ?? `${picked.video.height ?? "?"}p`;
          const quality = picked.audio
            ? `${label} ${codecName(picked.video.mime_type)} + ${codecName(picked.audio.mime_type)}`
            : `${label} ${codecName(picked.video.mime_type)}`;
          media = { id, title, live, client, quality, primary, ...(audio ? { audio } : {}) };
        }
        if (await this.#reachable(media.primary, signal)) return media;
        refused = true;
      } catch (caught) {
        if (signal?.aborted) throw caught;
        if (isNetworkError(caught)) throw this.#offline();
        failure ??= caught;
      }
    }
    if (refused) throw error("YouTube refused this video's streams. Try again later.");
    if (failure !== undefined)
      throw this.#explain(failure, (reason) =>
        this.#words.error("VestraTube could not read this video: {}. A newer version of the plugin may fix it.", [
          reason,
        ]),
      );
    throw error("This video has no stream the player can play.");
  }

  #refusal(status: string, reason: string | undefined): TextError {
    const { error } = this.#words;
    if (status === "LOGIN_REQUIRED" && /bot/i.test(reason ?? ""))
      return error("YouTube asked to confirm you're not a bot. This network is flagged; try another network.");
    return reason ? error("YouTube: {}", [oneLine(reason)]) : error("YouTube can't play this video ({}).", [status]);
  }

  /** One open-ended range request, as mpv makes: YouTube answers 403 for URLs it will not serve. */
  async #reachable(stream: Stream, signal?: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(PROBE_MS);
    const response = await this.fetch(stream.url, {
      headers: { ...stream.headers, Range: "bytes=0-" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  }
}

type VideoNode = {
  type?: string;
  video_id?: unknown;
  id?: unknown;
  title?: unknown;
  author?: { name?: unknown };
  duration?: { seconds?: unknown };
  is_live?: unknown;
  badges?: readonly { label?: unknown }[];
};

/** A search result node, or null for anything that is not a playable video (shorts shelves, channels, ads). */
export function toVideo(node: unknown): Video | null {
  const v = node as VideoNode | null;
  if (!v || v.type !== "Video") return null;
  const id = validId(v.video_id) ? v.video_id : validId(v.id) ? v.id : null;
  if (!id) return null;
  const title = oneLine(String(v.title ?? ""), 300);
  if (!title) return null;
  const live = v.is_live === true || (v.badges ?? []).some((badge) => /^live$/i.test(String(badge.label ?? "")));
  const seconds = typeof v.duration?.seconds === "number" && v.duration.seconds > 0 ? v.duration.seconds : null;
  const channel = typeof v.author?.name === "string" ? oneLine(v.author.name, 120) : "";
  return { id, title, channel, seconds: live ? null : seconds, live };
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The YouTube interface language closest to the player's (titles and ranking follow it). */
export function youtubeLanguage(locale: string): string {
  return (
    ({ "zh-Hans": "zh-CN", ja: "ja", ko: "ko", de: "de", fr: "fr", es: "es" } as Record<string, string>)[locale] ?? "en"
  );
}
