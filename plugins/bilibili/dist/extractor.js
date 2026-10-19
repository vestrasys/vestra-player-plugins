import { execFile } from 'node:child_process';
export function validateUrl(input) {
    let url;
    try {
        url = new URL(input.trim());
    }
    catch {
        throw new Error('请输入有效的 Bilibili 视频网址。');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443' && url.port !== '80'))
        throw new Error('仅支持 Bilibili HTTP(S) 视频链接。');
    const host = url.hostname.toLowerCase();
    const long = ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host) && /^\/video\/(?:BV[0-9A-Za-z]+|av[0-9]+)\/?$/.test(url.pathname);
    const short = host === 'b23.tv' && /^\/[0-9A-Za-z]+\/?$/.test(url.pathname);
    if (!long && !short)
        throw new Error('请输入 bilibili.com/video/… 或 b23.tv/… 视频链接。');
    url.hash = '';
    return url.href;
}
export function matchesUrl(input) { try {
    validateUrl(input);
    return true;
}
catch {
    return false;
} }
function resource(format, fallback) {
    if (typeof format.url !== 'string')
        throw new Error('提取结果没有媒体地址。');
    const url = new URL(format.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error('提取结果包含无效媒体地址。');
    const headers = {};
    for (const source of [fallback, format.http_headers]) {
        if (!source || typeof source !== 'object' || Array.isArray(source))
            continue;
        for (const [key, value] of Object.entries(source)) {
            if (typeof value !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n\0]/.test(value))
                throw new Error('提取结果包含无效请求头。');
            headers[key] = value;
        }
    }
    return { url: url.href, headers };
}
export function decodeMetadata(originalUrl, info) {
    const parts = info.requested_formats ?? info.requested_downloads;
    let media;
    let audio;
    if (parts?.length) {
        const video = parts.find(f => typeof f.vcodec === 'string' && f.vcodec !== 'none');
        if (!video)
            throw new Error('提取结果没有视频轨道。');
        media = resource(video, info.http_headers);
        if (video.acodec === 'none') {
            const sound = parts.find(f => f.vcodec === 'none' && typeof f.acodec === 'string' && f.acodec !== 'none');
            if (!sound)
                throw new Error('提取结果缺少独立音轨，无法完整播放。');
            audio = resource(sound, info.http_headers);
        }
        else if (typeof video.acodec !== 'string')
            throw new Error('无法确认视频是否包含音频。');
    }
    else {
        if (typeof info.vcodec !== 'string' || info.vcodec === 'none' || typeof info.acodec !== 'string' || info.acodec === 'none')
            throw new Error('提取结果没有包含音频的完整视频。');
        media = resource(info, info.http_headers);
    }
    return { originalUrl, ...(typeof info.title === 'string' ? { title: info.title } : {}), media, ...(audio ? { audio } : {}) };
}
export async function extractBilibili(input, signal) {
    const originalUrl = validateUrl(input);
    signal?.throwIfAborted();
    const output = await new Promise((resolve, reject) => {
        execFile('yt-dlp', ['--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings', '--socket-timeout', '12', '--retries', '0', '--extractor-retries', '0', '--format', 'bestvideo+bestaudio/best', '--', originalUrl], { signal, timeout: 45000, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) {
                reject(signal?.aborted ? new Error('已取消解析。') : new Error(`Bilibili 解析失败：${(stderr || error.message).trim().slice(0, 1800)}`));
                return;
            }
            resolve(stdout);
        });
    });
    signal?.throwIfAborted();
    let info;
    try {
        info = JSON.parse(output);
    }
    catch {
        throw new Error('yt-dlp 返回了无效的 JSON。');
    }
    if (!info || typeof info !== 'object' || Array.isArray(info))
        throw new Error('yt-dlp 返回了无效的视频信息。');
    return decodeMetadata(originalUrl, info);
}
