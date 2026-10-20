import { execFile } from 'node:child_process';

export interface Resource { url: string; headers: Record<string, string> }
export interface ResolvedBilibili { originalUrl: string; title?: string; media: Resource; audio?: Resource }
type Format = { url?: unknown; vcodec?: unknown; acodec?: unknown; http_headers?: unknown };
type Metadata = Format & { title?: unknown; requested_formats?: Format[]; requested_downloads?: Format[] };

export function validateUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('请输入有效的 Bilibili 视频网址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443' && url.port !== '80')) throw new Error('仅支持 Bilibili HTTP(S) 视频链接。');
  const host = url.hostname.toLowerCase();
  const long = ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host) && /^\/video\/(?:BV[0-9A-Za-z]+|av[0-9]+)\/?$/.test(url.pathname);
  const short = host === 'b23.tv' && /^\/[0-9A-Za-z]+\/?$/.test(url.pathname);
  if (!long && !short) throw new Error('请输入 bilibili.com/video/… 或 b23.tv/… 视频链接。');
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
export function matchesUrl(input: string): boolean { try { validateUrl(input); return true; } catch { return false; } }
function resource(format: Format, fallback: unknown): Resource {
  if (typeof format.url !== 'string') throw new Error('提取结果没有媒体地址。');
  const url = new URL(format.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('提取结果包含无效媒体地址。');
  const headers: Record<string,string> = {};
  for (const source of [fallback, format.http_headers]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n\0]/.test(value)) throw new Error('提取结果包含无效请求头。');
      headers[key] = value;
    }
  }
  return { url: url.href, headers };
}
export function decodeMetadata(originalUrl: string, info: Metadata): ResolvedBilibili {
  const parts = info.requested_formats ?? info.requested_downloads;
  let media: Resource;
  let audio: Resource | undefined;
  if (parts?.length) {
    const video = parts.find(f => typeof f.vcodec === 'string' && f.vcodec !== 'none');
    if (!video) throw new Error('提取结果没有视频轨道。');
    media = resource(video, info.http_headers);
    if (video.acodec === 'none') {
      const sound = parts.find(f => f.vcodec === 'none' && typeof f.acodec === 'string' && f.acodec !== 'none');
      if (!sound) throw new Error('提取结果缺少独立音轨，无法完整播放。');
      audio = resource(sound, info.http_headers);
    } else if (typeof video.acodec !== 'string') throw new Error('无法确认视频是否包含音频。');
  } else {
    if (typeof info.vcodec !== 'string' || info.vcodec === 'none' || typeof info.acodec !== 'string' || info.acodec === 'none') throw new Error('提取结果没有包含音频的完整视频。');
    media = resource(info, info.http_headers);
  }
  return { originalUrl, ...(typeof info.title === 'string' ? { title: info.title } : {}), media, ...(audio ? { audio } : {}) };
}
export async function extractBilibili(input: string, signal?: AbortSignal): Promise<ResolvedBilibili> {
  const originalUrl = validateUrl(input);
  signal?.throwIfAborted();
  const output = await new Promise<string>((resolve, reject) => {
    execFile('yt-dlp', ['--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings', '--socket-timeout', '12', '--retries', '0', '--extractor-retries', '0', '--format', 'bestvideo+bestaudio/best', '--', originalUrl], { signal, timeout: 45000, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) { reject(signal?.aborted ? new Error('已取消解析。') : new Error(`Bilibili 解析失败：${reason(stderr) || (error.killed ? '超时。' : (error as { code?: unknown }).code === 'ENOENT' ? '找不到 yt-dlp。' : 'yt-dlp 出错。')}`)); return; }
      resolve(stdout);
    });
  });
  signal?.throwIfAborted();
  let info: Metadata;
  try { info = JSON.parse(output) as Metadata; } catch { throw new Error('yt-dlp 返回了无效的 JSON。'); }
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('yt-dlp 返回了无效的视频信息。');
  return decodeMetadata(originalUrl, info);
}
