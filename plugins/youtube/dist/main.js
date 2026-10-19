import { YouTubeService, normalizeYouTubeUrl } from './service.js';
import { YouTubePlayback } from './playback.js';
const view = 'youtube';
const command = 'youtube.open';
const service = new YouTubeService();
export async function activate(host) {
    let busy = false, opened = false, disposed = false;
    let active;
    let current;
    const revision = 1;
    const playback = new YouTubePlayback(host.source);
    const resolver = await host.sourceResolvers.register({ id: 'youtube', schemes: ['https'], hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'] }, async ({ url, signal }) => {
        const media = await service.extract(url, signal);
        return { kind: 'media', ...media, originalUrl: url };
    });
    const state = () => ({ enabled: !disposed, checked: null, busy: false, reason: null });
    const set = async (property, value) => { if (!disposed && opened)
        await host.ui.set(view, property, value); };
    const status = async (message) => set('status', message);
    async function show() {
        if (disposed)
            return;
        if (!opened) {
            await host.ui.open(view, 'youtube.slint', {}, ['play', 'download', 'cancel']);
            opened = true;
        }
        else
            await host.ui.show(view, true);
    }
    async function operation(kind, input) {
        if (busy || disposed)
            return;
        busy = true;
        active = new AbortController();
        const signal = active.signal;
        try {
            await set('busy', true);
            await set('progress', 0);
            const url = normalizeYouTubeUrl(input);
            if (kind === 'download') {
                const selected = await host.dialogs.open({ kind: 'saveFile', title: '保存 YouTube 视频', fileName: 'YouTube.mkv' });
                if (selected.cancelled || !selected.paths[0]) {
                    await status('已取消选择保存位置。');
                    return;
                }
                if (signal.aborted)
                    throw new Error('Cancelled');
                const file = await service.download(url, selected.paths[0], signal, value => {
                    void set('progress', (value.percent ?? 0) / 100).catch(() => { });
                    void status(value.message).catch(() => { });
                });
                await set('progress', 1);
                await status(`已保存：${file}`);
            }
            else {
                await playback.open(url, signal, status);
            }
        }
        catch (error) {
            await status(error instanceof Error && error.message === 'Cancelled' ? '已取消。' : (error instanceof Error ? error.message : String(error)));
        }
        finally {
            busy = false;
            active = undefined;
            await set('busy', false);
        }
    }
    try {
        await host.commands.register(command, revision, { title: 'YouTube 视频…', path: ['文件', '网络媒体', 'YouTube 视频…'], shortcut: null }, state());
    }
    catch (error) {
        await resolver.dispose();
        throw error;
    }
    const offCommand = host.commands.onExecute(event => { if (event.id === command)
        void show().catch(error => console.error('[youtube]', error)); });
    const offUi = host.ui.onCallback(event => {
        if (event.view !== view || disposed)
            return;
        if (event.callback === 'cancel') {
            active?.abort();
            return;
        }
        if (!busy && (event.callback === 'play' || event.callback === 'download') && typeof event.args[0] === 'string') {
            current = operation(event.callback, event.args[0]);
            void current.catch(error => console.error('[youtube]', error));
        }
    });
    return async () => {
        disposed = true;
        active?.abort();
        offCommand();
        offUi();
        await resolver.dispose();
        await current;
        if (opened)
            await host.ui.close(view);
    };
}
