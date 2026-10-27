import { execFile } from 'node:child_process';
import type { I18n } from '@vestra-player/sdk';

export interface Resource { url: string; headers: Record<string, string> }
export interface ResolvedBilibili { originalUrl: string; title?: string; media: Resource; audio?: Resource }
type Format = { url?: unknown; vcodec?: unknown; acodec?: unknown; http_headers?: unknown };
type Metadata = Format & { title?: unknown; requested_formats?: Format[]; requested_downloads?: Format[] };
/** `plugin.i18n.error`: the player shows these failures translated (the window's status, the open's failure). */
export type Fail = I18n['error'];

export function validateUrl(input: string, error: Fail): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw error('Enter a valid Bilibili video URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443' && url.port !== '80')) throw error('Only Bilibili HTTP(S) video links are supported.');
  const host = url.hostname.toLowerCase();
  const long = ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host) && /^\/video\/(?:BV[0-9A-Za-z]+|av[0-9]+)\/?$/.test(url.pathname);
  const short = host === 'b23.tv' && /^\/[0-9A-Za-z]+\/?$/.test(url.pathname);
  if (!long && !short) throw error('Enter a bilibili.com/video/… or b23.tv/… video link.');
  url.hash = '';
  return url.href;
}
/** yt-dlp's own reason in one line: the last ERROR line (or last line) of stderr, without the prefix. */
export function reason(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const line = [...lines].reverse().find(l => l.startsWith('ERROR:')) ?? lines.at(-1) ?? '';
  const text = line.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '');
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}
export function matchesUrl(input: string, error: Fail): boolean { try { validateUrl(input, error); return true; } catch { return false; } }
function resource(format: Format, fallback: unknown, error: Fail): Resource {
  if (typeof format.url !== 'string') throw error('The extracted result has no media address.');
  const url = new URL(format.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw error('The extracted result contains an invalid media address.');
  const headers: Record<string,string> = {};
  for (const source of [fallback, format.http_headers]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n\0]/.test(value)) throw error('The extracted result contains invalid request headers.');
      headers[key] = value;
    }
  }
  return { url: url.href, headers };
}
export function decodeMetadata(originalUrl: string, info: Metadata, error: Fail): ResolvedBilibili {
  const parts = info.requested_formats ?? info.requested_downloads;
  let media: Resource;
  let audio: Resource | undefined;
  if (parts?.length) {
    const video = parts.find(f => typeof f.vcodec === 'string' && f.vcodec !== 'none');
    if (!video) throw error('The extracted result has no video track.');
    media = resource(video, info.http_headers, error);
    if (video.acodec === 'none') {
      const sound = parts.find(f => f.vcodec === 'none' && typeof f.acodec === 'string' && f.acodec !== 'none');
      if (!sound) throw error("The extracted result lacks the separate audio track, so it can't play completely.");
      audio = resource(sound, info.http_headers, error);
    } else if (typeof video.acodec !== 'string') throw error("Can't tell whether the video contains audio.");
  } else {
    if (typeof info.vcodec !== 'string' || info.vcodec === 'none' || typeof info.acodec !== 'string' || info.acodec === 'none') throw error('The extracted result has no complete video with audio.');
    media = resource(info, info.http_headers, error);
  }
  return { originalUrl, ...(typeof info.title === 'string' ? { title: info.title } : {}), media, ...(audio ? { audio } : {}) };
}
export async function extractBilibili(input: string, error: Fail, signal?: AbortSignal): Promise<ResolvedBilibili> {
  const originalUrl = validateUrl(input, error);
  signal?.throwIfAborted();
  const output = await new Promise<string>((resolve, reject) => {
    execFile('yt-dlp', ['--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings', '--socket-timeout', '12', '--retries', '0', '--extractor-retries', '0', '--format', 'bestvideo+bestaudio/best', '--', originalUrl], { signal, timeout: 45000, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8' }, (failure, stdout, stderr) => {
      if (failure) {
        // One whole sentence per reason; yt-dlp's own reason is data.
        const why = reason(stderr);
        reject(signal?.aborted ? error('Resolution cancelled.')
          : why ? error('Bilibili resolution failed: {}', [why])
          : failure.killed ? error('Bilibili resolution failed: timed out.')
          : (failure as { code?: unknown }).code === 'ENOENT' ? error('Bilibili resolution failed: yt-dlp was not found.')
          : error('Bilibili resolution failed: yt-dlp failed.'));
        return;
      }
      resolve(stdout);
    });
  });
  signal?.throwIfAborted();
  let info: Metadata;
  try { info = JSON.parse(output) as Metadata; } catch { throw error('yt-dlp returned invalid JSON.'); }
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw error('yt-dlp returned invalid video information.');
  return decodeMetadata(originalUrl, info, error);
}
