import type { Plugin, PluginError } from "../../sdk/plugin/index.ts";
import { extractBilibili, validateUrl } from "./extractor.ts";

const prompt = "输入 Bilibili 视频链接。";

/** Bilibili: a public resolver for site URLs plus one URL window that opens them. */
export default async function activate(plugin: Plugin) {
  // Any caller (this window, a playlist link, a generic open) gets the same routing.
  plugin.resolvers.add({
    id: "bilibili",
    schemes: ["http", "https"],
    hosts: ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"],
    resolve: async (url, signal) => {
      const result = await extractBilibili(url, signal);
      return {
        kind: "media",
        originalUrl: result.originalUrl,
        title: result.title,
        primary: result.media,
        ...(result.audio ? { audio: result.audio } : {}),
      };
    },
  });

  let url = "";
  let status = prompt;
  let busy = false;
  let running: AbortController | undefined;
  const window = plugin.windows.create("dialog.slint");
  window.bind(() => ({ url, status, busy }));

  window.on("play", async (input: string) => {
    if (running) return;
    const run = (running = new AbortController());
    url = input;
    // The loading timeout covers resolution and backend readiness; only Cancel aborts `run`.
    const signal = AbortSignal.any([run.signal, AbortSignal.timeout(60_000)]);
    try {
      const source = validateUrl(input);
      busy = true;
      status = "正在解析视频和音频…"; // shown when the handler first awaits
      const media = await plugin.player.open(source, { signal }); // resolved by the resolver above
      await media.ready({ signal }); // on abort the SDK closes this media if it is still current
      status = "视频已就绪。";
    } catch (error) {
      // A cancelled request leaves the (closed) window alone.
      if (!run.signal.aborted && running === run)
        status = describe(error as PluginError, signal);
    } finally {
      if (running === run) {
        running = undefined;
        if (!run.signal.aborted) busy = false;
      }
    }
  });
  window.on("cancel", () => {
    running?.abort();
    running = undefined;
    return window.close();
  });

  plugin.commands.add({
    id: "bilibili.open",
    path: ["文件", "网络媒体", "Bilibili 视频…"],
    run: () => {
      // A fresh window starts empty; an open one keeps what it shows.
      if (!window.opened) [url, status, busy] = ["", prompt, false];
      return window.show();
    },
  });
}

function describe(error: PluginError, signal: AbortSignal) {
  if (signal.aborted) return "媒体加载超时，请重试。";
  switch (error.code) {
    case "replaced":
      return "播放请求已被其他来源替换。";
    case "ended":
      return "播放请求已结束。";
    case "failed":
    case "backend":
      return error.message;
    default:
      // Plain errors (URL validation) carry no code; host refusals keep the old prefix.
      return error.code ? `播放请求失败：${error.code}` : error.message;
  }
}
