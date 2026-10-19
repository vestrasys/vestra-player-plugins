import { spawn } from 'node:child_process';
import { isAbsolute, dirname, basename, join } from 'node:path';
import { mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';

export const YT_DLP_VERSION = '2026.08.19';
export type Stream = { url: string; headers: Record<string, string> };
export type MediaDescriptor = { originalUrl: string; title: string; primary: Stream; audio?: Stream };
export type Progress = { phase: 'extracting' | 'downloading' | 'merging'; percent: number | null; message: string };
export type Runner = (args: string[], options?: { signal?: AbortSignal; onLine?: (line: string) => void; timeoutMs?: number }) => Promise<string>;
const abort = () => new Error('Cancelled');
export function normalizeYouTubeUrl(input: string): string {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new Error('Paste a complete YouTube video URL.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('Use an HTTPS YouTube video URL.');
  const host = u.hostname.toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? null;
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else if (/^\/(shorts|live|embed)\//.test(u.pathname)) id = u.pathname.split('/')[2] ?? null;
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Choose a single YouTube video (watch, shorts, live, or youtu.be URL).');
  return `https://www.youtube.com/watch?v=${id}`;
}
export const canResolveYouTube = (input: string): boolean => { try { normalizeYouTubeUrl(input); return true; } catch { return false; } };

/** No shell, no user config, no cookies, no browser profile, and bounded output/time. */
export function createRunner(executable = process.env.VESTRA_YT_DLP || 'yt-dlp'): Runner {
  return (args, options = {}) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(abort()); return; }
    const child = spawn(executable, args, { shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', lineBuffer = '', failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
    const stop = (error: Error) => { failure ??= error; kill('SIGTERM'); force ??= setTimeout(() => kill('SIGKILL'), 1500); };
    const cancel = () => stop(abort());
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => stop(new Error('yt-dlp timed out. Try again later.')), options.timeoutMs ?? 90000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 24 * 1024 * 1024) { stop(new Error('yt-dlp output exceeded the limit.')); return; }
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop() ?? '';
      for (const line of lines) options.onLine?.(line);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-12000); });
    child.on('error', (error) => { failure = new Error(`Cannot run yt-dlp: ${error.message}. Install the documented pinned dependency.`); });
    child.on('close', (code) => {
      clearTimeout(timeout); if (force) clearTimeout(force);
      options.signal?.removeEventListener('abort', cancel);
      if (lineBuffer) options.onLine?.(lineBuffer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`yt-dlp failed (${code}): ${stderr.trim() || 'No diagnostic output.'}`));
      else resolve(stdout);
    });
  });
}
const baseArgs = ['--ignore-config', '--no-playlist', '--no-colors', '--socket-timeout', '20', '--retries', '1', '--no-warnings'];
type YtFormat = { url?: unknown; vcodec?: unknown; acodec?: unknown; http_headers?: unknown };
type YtInfo = YtFormat & { title?: unknown; requested_formats?: YtFormat[]; formats?: YtFormat[]; is_live?: boolean };
function stream(format: YtFormat, fallback: unknown): Stream {
  if (typeof format.url !== 'string') throw new Error('Extractor returned no media URL.');
  const url = new URL(format.url);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Extractor returned an unsupported media protocol.');
  const headers: Record<string, string> = {};
  for (const source of [fallback, format.http_headers]) if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      if (/^[A-Za-z0-9-]+$/.test(key) && typeof value === 'string' && !/[\r\n]/.test(value)) headers[key] = value;
    }
  }
  return { url: url.href, headers };
}
/** Retains separate audio: callers must use a generic multi-stream source descriptor. */
export function descriptorFromInfo(originalUrl: string, raw: unknown): MediaDescriptor {
  if (!raw || typeof raw !== 'object') throw new Error('Extractor returned invalid metadata.');
  const info = raw as YtInfo;
  const formats = info.requested_formats?.length ? info.requested_formats : [info];
  const video = formats.find(f => typeof f.vcodec === 'string' && f.vcodec !== 'none');
  const audio = formats.find(f => typeof f.acodec === 'string' && f.acodec !== 'none');
  if (!video || !audio) throw new Error('No complete video and audio stream was found.');
  const result: MediaDescriptor = { originalUrl, title: typeof info.title === 'string' ? info.title : 'YouTube', primary: stream(video, info.http_headers) };
  if (video !== audio) result.audio = stream(audio, info.http_headers);
  return result;
}
export class YouTubeService {
  private verified?: Promise<void>;
  private readonly run: Runner;
  constructor(run: Runner = createRunner()) { this.run = run; }
  verify(): Promise<void> {
    return this.verified ??= this.run(['--ignore-config', '--version'], { timeoutMs: 15000 }).then(text => {
      if (text.trim() !== YT_DLP_VERSION) throw new Error(`yt-dlp ${YT_DLP_VERSION} is required; found ${text.trim()}. See README.md.`);
    }).catch(error => { this.verified = undefined; throw error; });
  }
  async extract(input: string, signal?: AbortSignal): Promise<MediaDescriptor> {
    const url = normalizeYouTubeUrl(input); await this.verify();
    const text = await this.run([...baseArgs, '--skip-download', '--dump-single-json', '-f', 'bv*+ba/b', '--', url], { signal });
    let info: unknown;
    try { info = JSON.parse(text); } catch { throw new Error('yt-dlp returned malformed metadata.'); }
    return descriptorFromInfo(url, info);
  }
  async download(input: string, destination: string, signal?: AbortSignal, progress?: (value: Progress) => void): Promise<string> {
    const url = normalizeYouTubeUrl(input);
    if (!isAbsolute(destination) || !destination.toLowerCase().endsWith('.mkv')) throw new Error('Choose an absolute .mkv save path.');
    await this.verify(); if (signal?.aborted) throw abort();
    // A private sibling staging directory prevents ffmpeg/yt-dlp from modifying a pre-existing destination.
    const staging = await mkdtemp(join(dirname(destination), '.vestra-youtube-'));
    const output = join(staging, 'video.%(ext)s');
    try {
      progress?.({ phase: 'downloading', percent: null, message: 'Downloading video and audio…' });
      await this.run([...baseArgs, '--newline', '--progress', '--progress-template', 'download:VESTRA_PROGRESS:%(progress._percent_str)s', '--merge-output-format', 'mkv', '--remux-video', 'mkv', '-f', 'bv*+ba/b', '-o', output, '--', url], {
        signal, timeoutMs: 6 * 60 * 60 * 1000,
        onLine: line => {
          const match = /^VESTRA_PROGRESS:\s*([0-9.]+)%/.exec(line);
          if (match) progress?.({ phase: 'downloading', percent: Math.max(0, Math.min(100, Number(match[1]))), message: `Downloading ${match[1]}%` });
          else if (/\[(Merger|VideoRemuxer)\]/.test(line)) progress?.({ phase: 'merging', percent: null, message: 'Preparing video with audio…' });
        },
      });
      if (signal?.aborted) throw abort();
      const files = await readdir(staging);
      if (!files.includes('video.mkv')) throw new Error('Download ended without a complete MKV file.');
      const complete = join(staging, 'video.mkv');
      if ((await stat(complete)).size === 0) throw new Error('Downloaded file is empty.');
      // The native save dialog already confirms replacement; only commit a complete file.
      await rename(complete, destination);
      return basename(destination);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
