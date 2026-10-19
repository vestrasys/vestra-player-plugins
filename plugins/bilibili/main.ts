import type { Host } from '../../sdk/index.ts';
import { extractBilibili, validateUrl } from './extractor.js';
import { openBilibili } from './playback.js';

export async function activate(host: Host): Promise<() => Promise<void>> {
  const id = 'bilibili.open';
  const view = 'bilibili-url';
  let disposed = false;
  let controller: AbortController | undefined;
  let revision = 1;
  let nextOperation = 0;
  const resolver = await host.sourceResolvers.register({ id: 'bilibili', schemes: ['http', 'https'], hosts: ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'] }, async ({url, signal}) => {
    const result = await extractBilibili(url, signal);
    return {kind: 'media', originalUrl: result.originalUrl, title: result.title, primary: result.media, ...(result.audio ? {audio: result.audio} : {})};
  });
  const state = { enabled: true, checked: null, busy: false, reason: null };
  const set = (property: string, value: string | boolean) => host.ui.set(view, property, value);
  const offCallback = host.ui.onCallback(event => {
    if (disposed || event.view !== view) return;
    if (event.callback === 'cancel') {
      controller?.abort();
      controller = undefined;
      void host.ui.close(view).catch(() => {});
    } else if (event.callback === 'play') {
      if (controller) return;
      const run = new AbortController();
      controller = run;
      void (async () => {
        try {
          const url = validateUrl(String(event.args[0] ?? ''));
          await set('busy', true);
          await openBilibili(host, url, (nextOperation += 2), run.signal, text => set('status', text));
        } catch (error) {
          if (!disposed && !run.signal.aborted && controller === run) await set('status', error instanceof Error ? error.message : String(error));
        } finally {
          if (controller === run) {
            controller = undefined;
            if (!disposed && !run.signal.aborted) await set('busy', false);
          }
        }
      })().catch(() => {});
    }
  });
  const offCommand = host.commands.onExecute(event => {
    if (disposed || event.id !== id) return;
    void host.ui.open(view, 'dialog.slint', { url: '', status: '输入 Bilibili 视频链接。', busy: false }, ['play', 'cancel']).catch(() => {});
  });
  try {
    await host.commands.register(id, revision, { title: 'Bilibili 视频…', path: ['文件', '网络媒体', 'Bilibili 视频…'], shortcut: null }, state);
  } catch (error) { offCallback(); offCommand(); await resolver.dispose(); throw error; }
  return async () => {
    disposed = true;
    controller?.abort();
    offCallback(); offCommand();
    await resolver.dispose();
    await host.commands.update(id, ++revision, { ...state, enabled: false, reason: '插件已停用' }).catch(() => {});
    await host.ui.close(view).catch(() => {});
  };
}
