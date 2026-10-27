import { basename, dirname, isAbsolute, join } from "node:path";
import { mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import type { Text, Tools } from "@vestra-player/sdk";
import type { Fetcher, MediaDescriptor, Stream, Words } from "./youtube.ts";
import { isNetworkError } from "./youtube.ts";

export type Progress = { fraction: number | null; message: Text };
/** 10 MB ranges, as YouTube downloaders use: one long request may be throttled or cut off. */
export const CHUNK_BYTES = 10 * 1024 * 1024;
const RETRIES = 2;
const MUX_TIMEOUT_MS = 60 * 60 * 1000;

const cancelled = () => Object.assign(new Error("Cancelled"), { name: "AbortError" });

/**
 * Downloads the resolved streams into a private staging directory next to
 * `destination`, muxes them with the player's ffmpeg into MKV, and only then
 * renames the finished file onto `destination` (the save dialog already
 * asked about replacing it). The staging directory is always removed.
 */
export async function downloadMedia(options: {
  media: MediaDescriptor;
  destination: string;
  words: Words;
  fetcher: Fetcher;
  tools: Pick<Tools, "run">;
  signal: AbortSignal;
  progress?: (value: Progress) => void;
}): Promise<string> {
  const { media, destination, words, fetcher, tools, signal, progress } = options;
  const { text, error } = words;
  if (!isAbsolute(destination) || !destination.toLowerCase().endsWith(".mkv"))
    throw error("Choose a .mkv file to save to.");
  if (media.live) throw error("Live videos can't be downloaded.");
  if (signal.aborted) throw cancelled();
  const staging = await mkdtemp(join(dirname(destination), ".vestra-youtube-"));
  try {
    const streams: Stream[] = media.audio ? [media.primary, media.audio] : [media.primary];
    const total = streams.every((s) => s.bytes) ? streams.reduce((sum, s) => sum + s.bytes!, 0) : null;
    let done = 0;
    const report = (bytes: number) => {
      done += bytes;
      const fraction = total ? Math.min(1, done / total) : null;
      progress?.({
        fraction,
        message:
          fraction === null
            ? text("Downloading {} MB…", [String(Math.round(done / 1e6))])
            : text("Downloading {}%", [String(Math.floor(fraction * 100))]),
      });
    };
    progress?.({ fraction: total ? 0 : null, message: text("Downloading the video and audio…") });
    const files: string[] = [];
    for (const [index, stream] of streams.entries()) {
      const file = join(staging, index === 0 ? "video" : "audio");
      await fetchTo(stream, file, { fetcher, signal, report, words });
      files.push(file);
    }
    progress?.({ fraction: total ? 1 : null, message: text("Merging the video and audio…") });
    const output = join(staging, "video.mkv");
    const inputs = files.flatMap((file) => ["-i", file]);
    const maps = media.audio ? ["-map", "0:v:0", "-map", "1:a:0"] : ["-map", "0"];
    try {
      await tools.run(
        "ffmpeg",
        ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...inputs, ...maps, "-c", "copy", output],
        { timeoutMs: MUX_TIMEOUT_MS, signal, maxOutput: 1024 * 1024 },
      );
    } catch (caught) {
      if (signal.aborted) throw cancelled();
      const code = (caught as { code?: string }).code;
      if (code === "unavailable")
        throw error("ffmpeg was not found. Downloads use the ffmpeg that comes with Vestra Player.");
      throw error("ffmpeg could not merge the video and audio: {}", [
        caught instanceof Error ? caught.message.slice(0, 160) : String(caught),
      ]);
    }
    if (signal.aborted) throw cancelled();
    const size = await stat(output).then(
      (info) => info.size,
      () => 0,
    );
    if (!size) throw error("The download finished without a complete MKV file.");
    await rename(output, destination);
    return basename(destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** One stream into `file`, in ranges, each retried on a network failure. */
async function fetchTo(
  stream: Stream,
  file: string,
  context: { fetcher: Fetcher; signal: AbortSignal; report: (bytes: number) => void; words: Words },
) {
  const { fetcher, signal, report, words } = context;
  const out = await open(file, "w");
  try {
    let offset = 0;
    let size = stream.bytes ?? null;
    for (;;) {
      const end = size === null ? offset + CHUNK_BYTES - 1 : Math.min(size, offset + CHUNK_BYTES) - 1;
      let written = 0;
      let whole = false;
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw cancelled();
        let received = 0;
        try {
          const response = await fetcher(stream.url, {
            headers: { ...stream.headers, Range: `bytes=${offset}-${end}` },
            signal,
          });
          if (response.status !== 206 && response.status !== 200) {
            await response.body?.cancel().catch(() => {});
            throw words.error("YouTube refused the download (HTTP {}).", [String(response.status)]);
          }
          // 200: the server sent the whole file (it ignored the range).
          whole = response.status === 200;
          size ??= totalOf(response.headers.get("content-range"));
          const chunks: Uint8Array[] = [];
          for await (const chunk of response.body ?? []) {
            const bytes = chunk as Uint8Array;
            chunks.push(bytes);
            received += bytes.length;
            report(bytes.length);
          }
          await out.write(Buffer.concat(chunks), 0, received, whole ? 0 : offset);
          written = received;
          break;
        } catch (caught) {
          if (signal.aborted) throw cancelled();
          if (attempt >= RETRIES || !isNetworkError(caught)) throw caught;
          // Take back what this attempt reported; the range is fetched again.
          report(-received);
        }
      }
      if (whole) return;
      offset += written;
      if (written === 0 || (size !== null && offset >= size)) return;
    }
  } finally {
    await out.close();
  }
}

/** "bytes 0-99/1234" → 1234. */
function totalOf(range: string | null): number | null {
  const total = range ? /\/(\d+)\s*$/.exec(range)?.[1] : undefined;
  return total ? Number(total) : null;
}
