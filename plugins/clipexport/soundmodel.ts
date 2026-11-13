import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { setGlobalProxyFromEnv } from "node:http";
import { join } from "node:path";

/**
 * The sound model's files (design clipexport-highlights §4.1, step 3): two
 * files, downloaded together after the user's click on Download and Scan
 * (that click is the consent), each checked against the SHA-256 pinned here
 * before it is kept, and again (its bytes, on every load) before it is
 * used. They live in `<data>/sound-model/`; Remove (Settings) deletes them.
 *
 * - The model: CED-mini (Apache-2.0, by mispeech: github.com/RicherMans/CED),
 *   converted to ONNX and quantised to int8 by k2-fsa (sherpa-onnx), from
 *   Hugging Face at a pinned commit.
 * - The runtime: ONNX Runtime Web 1.31.1's WebAssembly build (MIT, Microsoft),
 *   from jsDelivr's copy of the npm package. Its JavaScript ships with the
 *   plugin (vendor/onnxruntime-web/) and must be the same version.
 */
export interface ModelFile {
  name: string;
  url: string;
  size: number;
  sha256: string;
}

export const MODEL_FILES: readonly ModelFile[] = [
  {
    name: "ced-mini.int8.onnx",
    url: "https://huggingface.co/k2-fsa/sherpa-onnx-ced-mini-audio-tagging-2024-04-19/resolve/4da6df50dc47b25f91074b5ef7df4c1cc0dd7d4d/model.int8.onnx",
    size: 10_451_715,
    sha256: "ff29f39f9fbe637f72535160e9d006d61d872fdab0fce838672265b9b38cf946",
  },
  {
    name: "ort-wasm-simd-threaded.wasm",
    url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.wasm",
    size: 14_848_852,
    sha256: "4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d",
  },
];
/** The download's size as the page says it: "25 MB". */
export const MODEL_MB = Math.round(MODEL_FILES.reduce((sum, file) => sum + file.size, 0) / 1e6);
/** Where a download may end after its redirects: Hugging Face (and its file CDN), jsDelivr. HTTPS only. */
const HOSTS = [/^huggingface\.co$/, /^([a-z0-9-]+\.)*hf\.co$/, /^cdn-lfs[a-z0-9.-]*\.huggingface\.co$/, /^cdn\.jsdelivr\.net$/];
export const allowedHost = (url: string) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && HOSTS.some((host) => host.test(hostname));
  } catch {
    return false;
  }
};
/** No answer or no bytes for this long ends a download. */
const STALL = 30_000;

/** Why a download ended: the page's F3 (failed, with the reason), F4 (checksum) or F5 (offline). */
export class DownloadError extends Error {
  readonly kind: "failed" | "checksum" | "offline" | "cancelled";
  constructor(kind: DownloadError["kind"], message: string = kind) {
    super(message);
    this.kind = kind;
  }
}

/** Network failures that mean "not connected" (F5) rather than a failed download (F3). */
const OFFLINE = new Set(["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "ECONNREFUSED"]);
const errorCode = (error: unknown): unknown => (error as { code?: unknown })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code;

export interface Progress {
  received: number;
  total: number;
}

export interface ModelOptions {
  /** `<data>/sound-model`; `null` without a data directory (no download is possible). */
  folder: string | null;
  fetch?: typeof fetch;
  files?: readonly ModelFile[];
  stall?: number;
}

let proxied = false;
/** Node's fetch ignores HTTPS_PROXY unless asked to follow it. */
function proxyFetch(...args: Parameters<typeof fetch>) {
  if (!proxied) {
    proxied = true;
    try {
      setGlobalProxyFromEnv();
    } catch {
      // an invalid proxy setting: connect directly
    }
  }
  return fetch(...args);
}

/** The model's files on disk: whether they are there, the download, their bytes for a scan, Remove. */
export class SoundModel {
  readonly folder: string | null;
  readonly files: readonly ModelFile[];
  readonly #fetch: typeof fetch;
  readonly #stall: number;
  #download: { controller: AbortController; promise: Promise<void> } | null = null;

  constructor(options: ModelOptions) {
    this.folder = options.folder;
    this.files = options.files ?? MODEL_FILES;
    this.#fetch = options.fetch ?? proxyFetch;
    this.#stall = options.stall ?? STALL;
  }

  get downloading() {
    return !!this.#download;
  }

  /** Every file is there with its pinned size (the bytes are checked when a scan reads them). */
  async installed() {
    if (!this.folder) return false;
    for (const file of this.files) {
      const info = await stat(join(this.folder, file.name)).catch(() => null);
      if (!info?.isFile() || info.size !== file.size) return false;
    }
    return true;
  }

  /**
   * The files' bytes for a scan. Everything is decided from the bytes read,
   * never from an earlier look at the file: their length and their SHA-256
   * must be the pinned ones, on every load (about 25 MB, tens of ms per
   * scan). A file that is not the pinned one is deleted and the result is
   * `null` (the page asks for the download again); a missing one is `null`.
   */
  async load(): Promise<{ model: Uint8Array; wasm: Uint8Array } | null> {
    if (!this.folder) return null;
    const out: Uint8Array[] = [];
    for (const file of this.files) {
      const path = join(this.folder, file.name);
      const bytes = await readFile(path).catch(() => null);
      if (!bytes) return null;
      if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        await rm(path, { force: true }).catch(() => {});
        return null;
      }
      out.push(bytes);
    }
    return { model: out[0]!, wasm: out[1]! };
  }

  /** Remove (Settings): the files go; the page offers the download again. */
  async remove() {
    this.cancel();
    if (this.folder) await rm(this.folder, { recursive: true, force: true }).catch(() => {});
  }

  /** Cancel the download (the card's ×): the partial files go. */
  cancel() {
    this.#download?.controller.abort();
  }

  /** Download the files that are missing (one download at a time; a second call shares it). */
  download(progress: (progress: Progress) => void): Promise<void> {
    if (this.#download) return this.#download.promise;
    const controller = new AbortController();
    const promise = this.#fetchAll(controller.signal, progress).finally(() => {
      this.#download = null;
    });
    this.#download = { controller, promise };
    return promise;
  }

  async #fetchAll(signal: AbortSignal, progress: (progress: Progress) => void) {
    const folder = this.folder;
    if (!folder) throw new DownloadError("failed", "no data folder");
    try {
      await mkdir(folder, { recursive: true });
    } catch (error) {
      throw new DownloadError("failed", (error as Error).message);
    }
    // Leftovers of a download a crash cut short.
    for (const name of await readdir(folder).catch(() => [] as string[])) if (name.startsWith(".download-")) await rm(join(folder, name), { force: true }).catch(() => {});
    const total = this.files.reduce((sum, file) => sum + file.size, 0);
    let done = 0;
    progress({ received: 0, total });
    for (const file of this.files) {
      const info = await stat(join(folder, file.name)).catch(() => null);
      if (info?.isFile() && info.size === file.size) {
        done += file.size;
        progress({ received: done, total });
        continue;
      }
      await this.#fetchOne(file, folder, signal, (received) => progress({ received: done + received, total }));
      done += file.size;
    }
  }

  async #fetchOne(file: ModelFile, folder: string, signal: AbortSignal, progress: (received: number) => void) {
    const stall = new AbortController();
    const both = AbortSignal.any([signal, stall.signal]);
    let timer = setTimeout(() => stall.abort(), this.#stall);
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), this.#stall);
    };
    const failure = (error: unknown) => {
      if (error instanceof DownloadError) return error;
      if (signal.aborted) return new DownloadError("cancelled");
      if (stall.signal.aborted) return new DownloadError("failed", "the connection stalled");
      const code = errorCode(error);
      if (typeof code === "string" && OFFLINE.has(code)) return new DownloadError("offline", code);
      return new DownloadError("failed", typeof code === "string" ? code : (error as Error)?.message ?? String(error));
    };
    const temporary = join(folder, `.download-${randomBytes(6).toString("hex")}-${file.name}`);
    try {
      let response: Response;
      try {
        response = await this.#fetch(file.url, { signal: both, redirect: "follow", headers: { "user-agent": "VestraPlayer-ClipExport" } });
      } catch (error) {
        throw failure(error);
      }
      if (!allowedHost(response.url || file.url)) {
        await response.body?.cancel().catch(() => {});
        throw new DownloadError("failed", "the download was redirected to an unexpected host");
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new DownloadError("failed", `HTTP ${response.status}`);
      }
      const hash = createHash("sha256");
      const handle = await open(temporary, "wx", 0o600).catch((error: Error) => {
        throw new DownloadError("failed", error.message);
      });
      let received = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          restart();
          received += chunk.length;
          if (received > file.size) throw new DownloadError("checksum");
          hash.update(chunk);
          await handle.write(chunk).catch((error: Error) => {
            throw new DownloadError("failed", error.message);
          });
          progress(received);
        }
        await handle.sync().catch(() => {});
      } catch (error) {
        throw failure(error);
      } finally {
        await handle.close().catch(() => {});
      }
      // Never kept (nor ever loaded) unless it is the pinned file.
      if (received !== file.size || hash.digest("hex") !== file.sha256) throw new DownloadError("checksum");
      await rename(temporary, join(folder, file.name)).catch((error: Error) => {
        throw new DownloadError("failed", error.message);
      });
    } finally {
      clearTimeout(timer);
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
