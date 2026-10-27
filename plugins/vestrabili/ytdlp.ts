import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, constants, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { setGlobalProxyFromEnv } from 'node:http';
import { join, posix, win32 } from 'node:path';
import type { I18n, TextError } from '@vestra-player/sdk';
import { verifyDetached, ytDlpKey, type RsaKey } from './openpgp.ts';

/**
 * yt-dlp for VestraBili: the user's own copy (`VESTRA_YTDLP`, else the
 * managed copy, else `yt-dlp` on the PATH), or, with the user's consent, the
 * standalone build from yt-dlp's official GitHub release, downloaded into
 * the plugin's data directory. A download is used only after its release's
 * `SHA2-256SUMS` verified against yt-dlp's signing key and the file against
 * that checksum. The managed copy is updated through the same path.
 */

export const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases';
/** The managed copy is checked for a newer release at most this often. */
export const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;
/** A failed extraction forces an update check at most this often. */
export const FORCED_INTERVAL = 60 * 60 * 1000;
const MAX_ASSET = 256 * 1024 * 1024;
const MAX_TEXT = 64 * 1024;
/** No answer or no bytes for this long ends a download. */
const STALL = 30_000;
/** yt-dlp's release tags: dates, with a number for a second release on one day. */
const TAG = /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/;
/** The oldest release VestraBili installs: "latest" pointing further back is refused (a rollback). */
export const MIN_TAG = '2026.10.26';
/** Hosts a release download may be redirected to. */
const HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

/** Compare two release tags as numbers: negative, zero or positive. */
export function compareTags(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export type Fail = I18n['error'];
export interface Asset { name: string; megabytes: number }
export interface Installed { tag: string; asset: string; sha256: string }
export interface State { consent: 'granted' | 'declined' | null; installed: Installed | null; checkedAt: number }
export interface Store { readonly value: State; save(next: State): void }
export interface Progress { received: number; total: number | null }

export const DEFAULT_STATE: State = { consent: null, installed: null, checkedAt: 0 };
export function isState(value: unknown): value is State {
  if (!value || typeof value !== 'object') return false;
  const v = value as State;
  const installed = v.installed;
  return [null, 'granted', 'declined'].includes(v.consent) && typeof v.checkedAt === 'number'
    && (installed === null || (!!installed && typeof installed === 'object' && typeof installed.tag === 'string'
      && typeof installed.asset === 'string' && /^[0-9a-f]{64}$/.test(installed.sha256)));
}

/** yt-dlp's standalone build for this system (the size is for the consent dialog), if there is one. */
export function assetFor(platform: string, arch: string): Asset | undefined {
  if (platform === 'win32') {
    if (arch === 'x64') return { name: 'yt-dlp.exe', megabytes: 24 };
    if (arch === 'arm64') return { name: 'yt-dlp_arm64.exe', megabytes: 23 };
    if (arch === 'ia32') return { name: 'yt-dlp_x86.exe', megabytes: 19 };
  }
  if (platform === 'darwin') return { name: 'yt-dlp_macos', megabytes: 38 }; // universal (x64 and arm64)
  if (platform === 'linux') {
    if (arch === 'x64') return { name: 'yt-dlp_linux', megabytes: 42 };
    if (arch === 'arm64') return { name: 'yt-dlp_linux_aarch64', megabytes: 41 };
  }
  return undefined;
}

/** The checksum `SHA2-256SUMS` lists for `name`. */
export function checksumOf(sums: string, name: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1]!.toLowerCase();
  }
  return undefined;
}

/** yt-dlp failures a newer yt-dlp may fix (site changes), worth one update check and one retry. */
export const looksOutdated = (reason: string) =>
  /unsupported url|unable to (extract|download (json|webpage))|latest version|report this issue|outdated|no longer supported|HTTP Error 412/i.test(reason);

export interface Options {
  /** The plugin's data directory; the managed copy lives in `<directory>/bin`. */
  directory: string;
  store: Store;
  /** `plugin.i18n.error`. */
  error: Fail;
  /** Ask the user to download yt-dlp; resolves to the answer. May reject with a {@link TextError}. */
  ask: (asset: Asset) => Promise<boolean>;
  /** Progress of a download the user waits for, `null` when it ends (background updates are quiet). */
  progress?: (progress: Progress | null) => void;
  /** A download was installed; `first`: there was no managed copy before. */
  installed?: (first: boolean) => void;
  fetch?: typeof fetch;
  /** The key the release checksums must be signed with (default: yt-dlp's). */
  key?: RsaKey;
  /** Run a program and give its stdout (the `--version` check after a download). */
  run?: (program: string, args: string[], signal: AbortSignal) => Promise<string>;
  platform?: string;
  arch?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** How long a request may go without an answer or bytes (tests shorten it). */
  stall?: number;
}

const runFile = (program: string, args: string[], signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    execFile(program, args, { signal, timeout: 60_000, encoding: 'utf8', windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

let proxied = false;
/** Node's fetch ignores HTTPS_PROXY unless asked; yt-dlp itself honours it. */
function proxyFetch(...args: Parameters<typeof fetch>) {
  if (!proxied) {
    proxied = true;
    try { setGlobalProxyFromEnv(); } catch { /* an invalid proxy setting: connect directly */ }
  }
  return fetch(...args);
}

const errorCode = (error: unknown): unknown => (error as { code?: unknown })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code;
const isTextError = (error: unknown): error is TextError => error instanceof Error && 'text' in error;

export class YtDlp {
  readonly #o: Required<Omit<Options, 'progress' | 'installed'>> & Pick<Options, 'progress' | 'installed'>;
  readonly asset: Asset | undefined;
  #download: { promise: Promise<string>; controller: AbortController; quiet: boolean } | undefined;
  #asking: Promise<boolean> | undefined;
  #verified: string | undefined;
  #forcedAt = -Infinity;
  /** Resolutions in progress: the daily check waits for them. */
  resolving = 0;

  constructor(options: Options) {
    this.#o = {
      fetch: proxyFetch, run: runFile, key: ytDlpKey(), stall: STALL, platform: process.platform, arch: process.arch, env: process.env, now: Date.now,
      ...options,
    };
    this.asset = assetFor(this.#o.platform, this.#o.arch);
  }

  get #bin() { return join(this.#o.directory, 'bin'); }
  get #state() { return this.#o.store.value; }
  #save(change: Partial<State>) { this.#o.store.save({ ...this.#state, ...change }); }
  /** Whether a download is running. */
  get downloading() { return !!this.#download; }

  /**
   * The program to run: the user's own copy or the managed one, else a new
   * download. `interactive` (the plugin's window) asks unless the user
   * already agreed; otherwise only a user who was never asked is asked.
   * `signal` ends the wait, not a download another caller shares.
   */
  async program({ interactive, signal }: { interactive: boolean; signal?: AbortSignal }): Promise<string> {
    const own = this.#o.env.VESTRA_YTDLP;
    if (own) {
      if (await isFile(own)) return own;
      throw this.#o.error('VESTRA_YTDLP names a file that does not exist: {}', [own]);
    }
    const managed = await this.managed();
    if (managed) return managed;
    const found = await this.onPath();
    if (found) return found;
    if (!this.asset) throw this.#o.error("yt-dlp has no ready-made build for this system ({}). Install yt-dlp and put it on the PATH.", [`${this.#o.platform}-${this.#o.arch}`]);
    if (this.#state.consent !== 'granted' && !this.#download) {
      if (!interactive && this.#state.consent === 'declined')
        throw this.#o.error('VestraBili needs yt-dlp to play Bilibili links. Open → VestraBili… downloads it.');
      const asset = this.asset;
      this.#asking ??= this.#o.ask(asset).finally(() => (this.#asking = undefined));
      const agreed = await wait(this.#asking, signal);
      if (!agreed) {
        this.#save({ consent: 'declined' });
        throw interactive
          ? this.#o.error('VestraBili needs yt-dlp to play Bilibili links. Press Play to download it.')
          : this.#o.error('VestraBili needs yt-dlp to play Bilibili links. Open → VestraBili… downloads it.');
      }
      this.#save({ consent: 'granted' });
    }
    return wait(this.#install().promise, signal);
  }

  /** End the running download (the window's Cancel). */
  cancel() { this.#download?.controller.abort(); }

  /** The managed copy, if it is there and still has the checksum it was installed with. */
  async managed(): Promise<string | undefined> {
    const installed = this.#state.installed;
    if (!this.asset || installed?.asset !== this.asset.name) return undefined;
    const path = join(this.#bin, this.asset.name);
    let info;
    try { info = await stat(path); } catch { return undefined; } // removed (by the user or antivirus software)
    const stamp = `${installed.sha256}:${info.size}:${info.mtimeMs}`;
    if (this.#verified === stamp) return path;
    let hash: string;
    try { hash = await hashFile(path); } catch { return undefined; } // busy or unreadable now: keep it for later
    if (hash !== installed.sha256) {
      await rm(path, { force: true }).catch(() => {});
      this.#save({ installed: null });
      return undefined;
    }
    this.#verified = stamp;
    return path;
  }

  /** `yt-dlp` on the PATH (Windows: `yt-dlp.exe`), without a shell. */
  async onPath(): Promise<string | undefined> {
    const windows = this.#o.platform === 'win32';
    const name = windows ? 'yt-dlp.exe' : 'yt-dlp';
    const directories = (this.#o.env.PATH ?? this.#o.env.Path ?? '').split(windows ? ';' : ':');
    for (const entry of directories) {
      // Windows entries may be quoted; a relative entry would search the current directory.
      const directory = windows ? entry.replace(/^"(.*)"$/, '$1') : entry;
      if (!directory || !(windows ? win32 : posix).isAbsolute(directory)) continue;
      const path = join(directory, name);
      if (await isFile(path) && (windows || await access(path, constants.X_OK).then(() => true, () => false))) return path;
    }
    return undefined;
  }

  /**
   * Check for a newer release of the managed copy and install it. Without
   * `force`: at most once per {@link UPDATE_INTERVAL} and never while a link
   * is being resolved; with `force` (a failed extraction), at most once per
   * {@link FORCED_INTERVAL}. Resolves to whether a new yt-dlp was installed;
   * failures reject.
   */
  async update({ force = false, signal }: { force?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
    const now = this.#o.now();
    const installed = this.#state.installed;
    if (this.#o.env.VESTRA_YTDLP || !installed || !this.asset || this.#download) return false;
    if (force ? now - this.#forcedAt < FORCED_INTERVAL : now - this.#state.checkedAt < UPDATE_INTERVAL || this.resolving > 0) return false;
    if (force) this.#forcedAt = now;
    this.#save({ checkedAt: now });
    const tag = await this.#latestTag(AbortSignal.any([AbortSignal.timeout(this.#o.stall), ...(signal ? [signal] : [])]));
    if (compareTags(tag, installed.tag) <= 0) return false; // the same release, or "latest" pointing back
    await wait(this.#install(tag, !force).promise, signal);
    return true;
  }

  /** One download at a time; callers share it. A caller that waits makes a quiet download show its progress. */
  #install(tag?: string, quiet = false) {
    if (this.#download) {
      this.#download.quiet &&= quiet;
      return this.#download;
    }
    const controller = new AbortController();
    const first = !this.#state.installed;
    const download = { controller, quiet, promise: Promise.resolve('') };
    download.promise = this.#fetchVerified(controller.signal, tag, progress => { if (!download.quiet) this.#o.progress?.(progress); }).then(
      path => { this.#o.installed?.(first); return path; },
    ).finally(() => {
      this.#download = undefined;
      if (!download.quiet) this.#o.progress?.(null);
    });
    download.promise.catch(() => {}); // a caller that stopped waiting must not leave an unhandled rejection
    this.#download = download;
    return download;
  }

  async #latestTag(signal: AbortSignal): Promise<string> {
    const response = await this.#get(`${RELEASES}/latest`, signal, 'manual');
    await response.body?.cancel().catch(() => {});
    const match = /\/releases\/tag\/([0-9A-Za-z._-]{1,64})$/.exec(response.headers.get('location') ?? '');
    if (response.status < 300 || response.status >= 400 || !match || !TAG.test(match[1]!)) throw this.#o.error("Can't download yt-dlp: GitHub gave an unexpected answer.");
    return match[1]!;
  }

  async #get(url: string, signal: AbortSignal, redirect: RequestRedirect = 'follow'): Promise<Response> {
    let response: Response;
    try {
      response = await this.#o.fetch(url, { signal, redirect, headers: { 'user-agent': 'VestraBili' } });
    } catch (error) {
      throw this.#networkError(error, signal);
    }
    if (response.status === 403 || response.status === 429) throw this.#o.error("Can't download yt-dlp: GitHub is limiting downloads right now. Try again later.");
    if (redirect === 'follow') {
      // Where the redirects ended: GitHub's release storage only, over HTTPS.
      let end: URL | undefined;
      try { end = new URL(response.url); } catch { /* no address */ }
      if (end?.protocol !== 'https:' || !HOSTS.has(end.hostname)) {
        await response.body?.cancel().catch(() => {});
        throw this.#o.error("Can't download yt-dlp: the download was redirected somewhere other than GitHub.");
      }
    }
    const redirected = redirect === 'manual' && response.status >= 300 && response.status < 400;
    if (!response.ok && !redirected) throw this.#o.error("Can't download yt-dlp: GitHub answered HTTP {}.", [response.status]);
    return response;
  }

  #networkError(error: unknown, signal: AbortSignal): TextError {
    if (isTextError(error)) return error;
    if (signal.aborted) {
      return (signal.reason as Error)?.name === 'TimeoutError'
        ? this.#o.error("Can't download yt-dlp: the connection stalled. Try again later.")
        : this.#o.error('The yt-dlp download was cancelled.');
    }
    return this.#o.error("Can't download yt-dlp: GitHub can't be reached. Check the internet connection or proxy.");
  }

  /** Stream at most `limit` bytes of a response; `onChunk` sees each piece; a stall of {@link STALL} ends it. */
  async #read(response: Response, limit: number, stall: AbortController, onChunk: (chunk: Uint8Array) => Promise<void> | void) {
    let received = 0;
    let timer = setTimeout(() => stall.abort(new DOMException('stalled', 'TimeoutError')), this.#o.stall);
    try {
      if (!response.body) return;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > limit) throw this.#o.error("Can't download yt-dlp: the file is larger than expected.");
        clearTimeout(timer);
        timer = setTimeout(() => stall.abort(new DOMException('stalled', 'TimeoutError')), this.#o.stall);
        await onChunk(chunk);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** `#get` with the stall timer running while the answer is awaited. */
  async #answer(url: string, signal: AbortSignal, stall: AbortController): Promise<Response> {
    const timer = setTimeout(() => stall.abort(new DOMException('stalled', 'TimeoutError')), this.#o.stall);
    try { return await this.#get(url, signal); } finally { clearTimeout(timer); }
  }

  async #text(url: string, signal: AbortSignal): Promise<Buffer> {
    const stall = new AbortController();
    const both = AbortSignal.any([signal, stall.signal]);
    const response = await this.#answer(url, both, stall);
    const parts: Uint8Array[] = [];
    try {
      await this.#read(response, MAX_TEXT, stall, chunk => { parts.push(chunk); });
    } catch (error) {
      throw this.#networkError(error, both);
    }
    return Buffer.concat(parts);
  }

  /** Download, verify, test and install the release `tag` (default: the latest); resolves to the installed path. */
  async #fetchVerified(signal: AbortSignal, knownTag: string | undefined, progress: (progress: Progress) => void): Promise<string> {
    const asset = this.asset!;
    const tag = knownTag ?? await this.#latestTag(AbortSignal.any([signal, AbortSignal.timeout(this.#o.stall)]));
    const installed = this.#state.installed;
    if (!TAG.test(tag) || compareTags(tag, MIN_TAG) < 0 || (installed && compareTags(tag, installed.tag) < 0))
      throw this.#o.error("yt-dlp's latest release ({}) is older than the one VestraBili expects, so it wasn't downloaded. Try again later.", [tag]);
    const base = `${RELEASES}/download/${tag}`;
    const [sums, signature] = await Promise.all([this.#text(`${base}/SHA2-256SUMS`, signal), this.#text(`${base}/SHA2-256SUMS.sig`, signal)]);
    if (!verifyDetached(sums, signature, this.#o.key)) throw this.#o.error("yt-dlp's release isn't signed by the yt-dlp project's key, so it wasn't downloaded. Update VestraBili or try again later.");
    const expected = checksumOf(sums.toString('utf8'), asset.name);
    if (!expected) throw this.#o.error("Can't download yt-dlp: this release doesn't list {}.", [asset.name]);

    await mkdir(this.#bin, { recursive: true }).catch(error => { throw this.#diskError(error); });
    await this.#removeLeftovers();
    // A temporary name in the same directory: only a complete, verified file is renamed into place.
    const temporary = join(this.#bin, `.download-${randomBytes(6).toString('hex')}-${asset.name}`);
    try {
      const stall = new AbortController();
      const both = AbortSignal.any([signal, stall.signal]);
      const response = await this.#answer(`${base}/${asset.name}`, both, stall);
      const length = Number(response.headers.get('content-length'));
      const total = Number.isFinite(length) && length > 0 ? length : null;
      const hash = createHash('sha256');
      let file;
      try { file = await open(temporary, 'wx', 0o600); } catch (error) { throw this.#diskError(error); }
      try {
        let received = 0;
        let shown = 0;
        progress({ received, total });
        await this.#read(response, MAX_ASSET, stall, async chunk => {
          hash.update(chunk);
          try { await file.write(chunk); } catch (error) { throw this.#diskError(error); }
          received += chunk.length;
          if (received - shown >= 256 * 1024) { shown = received; progress({ received, total }); }
        }).catch(error => { throw isTextError(error) ? error : this.#networkError(error, both); });
        await file.sync().catch(error => { throw this.#diskError(error); });
      } finally {
        await file.close().catch(() => {});
      }
      const sha256 = hash.digest('hex');
      if (sha256 !== expected) throw this.#o.error('The downloaded yt-dlp did not match its published checksum and was discarded. Try again.');
      if (this.#o.platform !== 'win32') await chmod(temporary, 0o755).catch(error => { throw this.#diskError(error); });
      // The verified file runs once before it is installed, so a build the system blocks is never put in place.
      let version: string;
      try {
        version = (await this.#o.run(temporary, ['--ignore-config', '--version'], AbortSignal.any([signal, AbortSignal.timeout(60_000)]))).trim();
      } catch (error) {
        if (signal.aborted) throw this.#o.error('The yt-dlp download was cancelled.');
        throw this.#o.error("yt-dlp was downloaded but couldn't run. Security software may have blocked or removed it.");
      }
      // The file must be the release it was published as (not an older genuine build under a newer name).
      if (version !== tag) throw this.#o.error('The downloaded yt-dlp reports version {} instead of {}, so it was discarded.', [version.slice(0, 40), tag]);
      signal.throwIfAborted();
      const path = join(this.#bin, asset.name);
      await renameRetrying(temporary, path).catch(error => { throw this.#diskError(error); });
      this.#verified = undefined;
      this.#save({ installed: { tag, asset: asset.name, sha256 }, checkedAt: this.#o.now() });
      return path;
    } catch (error) {
      throw isTextError(error) ? error : this.#networkError(error, signal);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  #diskError(error: unknown): TextError {
    if (isTextError(error)) return error;
    const code = errorCode(error);
    if (code === 'ENOSPC') return this.#o.error("Can't save yt-dlp: the disk is full.");
    return this.#o.error("Can't save yt-dlp: {}.", [typeof code === 'string' ? code : String((error as Error)?.message ?? error)]);
  }

  /** Temporary files a stopped download left behind. */
  async #removeLeftovers() {
    const names = await readdir(this.#bin).catch(() => [] as string[]);
    await Promise.all(names.filter(name => name.startsWith('.download-')).map(name => rm(join(this.#bin, name), { force: true }).catch(() => {})));
  }
}

async function isFile(path: string) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Windows: security software may hold a new file open for a moment, and a running yt-dlp can't be replaced. */
async function renameRetrying(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); } catch (error) {
      if (attempt >= 8 || !['EBUSY', 'EPERM', 'EACCES'].includes(errorCode(error) as string)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

/** `promise`, or a rejection when `signal` aborts first (the promise itself goes on). */
function wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
