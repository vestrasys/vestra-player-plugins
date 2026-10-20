import type { Plugin, PluginError } from "../../sdk/plugin/index.ts";
import { normalizeYouTubeUrl, YouTubeService } from "./service.ts";

const hosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];
/** The original wait limit (400 polls × 300 ms). Timing out stops waiting; it does not close the source. */
const readyTimeoutMs = 120_000;
const timedOut = "播放操作仍未确认就绪；未重新提交，请检查主机状态。";

/** YouTube: a public URL resolver, plus one window to play or download a single video. */
export default async function activate(plugin: Plugin, youtube = new YouTubeService()) {
  let status = "粘贴 YouTube 视频链接以播放或下载。";
  let busy = false;
  let progress = 0;
  let active: AbortController | undefined;
  let current: Promise<void> | undefined;

  plugin.resolvers.add({
    id: "youtube",
    schemes: ["https"],
    hosts,
    resolve: async (url, signal) => ({ kind: "media", ...(await youtube.extract(url, signal)), originalUrl: url }),
  });

  async function play(url: string, signal: AbortSignal) {
    status = "正在解析并加载视频与音频…";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timedOut)), readyTimeoutMs);
    });
    try {
      const opening = plugin.player.open(url, { signal }).catch((error: PluginError) => {
        throw error.code === "aborted" ? error : new Error(`播放失败：${error.message}`);
      });
      const media = await Promise.race([opening, deadline]);
      await Promise.race([media.ready({ signal }), deadline]).catch((error: PluginError) => {
        if (error.code === "replaced") throw new Error("播放请求已被新的媒体源替换。");
        if (error.code === "ended") throw new Error("播放请求已结束。");
        if (error.code === "failed") throw new Error(plugin.player.state.error ?? "媒体后端播放失败。");
        throw error;
      });
    } finally {
      clearTimeout(timer);
    }
    status = "主机媒体源已就绪。";
  }

  async function download(url: string, signal: AbortSignal) {
    const destination = await plugin.dialogs.saveFile({ title: "保存 YouTube 视频", fileName: "YouTube.mkv" });
    if (!destination) {
      status = "已取消选择保存位置。";
      return;
    }
    if (signal.aborted) throw new Error("Cancelled");
    const file = await youtube.download(url, destination, signal, (value) => {
      progress = (value.percent ?? 0) / 100;
      status = value.message;
      plugin.update(); // progress arrives between awaits of one handler
    });
    progress = 1;
    status = `已保存：${file}`;
  }

  async function run(kind: "play" | "download", input: string) {
    busy = true;
    progress = 0;
    active = new AbortController();
    try {
      const url = normalizeYouTubeUrl(input);
      await (kind === "play" ? play(url, active.signal) : download(url, active.signal));
    } catch (error) {
      const cancelled = error instanceof Error && (error.message === "Cancelled" || error.name === "AbortError");
      status = cancelled ? "已取消。" : error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      active = undefined;
    }
  }

  const window = plugin.windows.create("youtube.slint");
  window.bind(() => ({ status, busy, progress }));
  window.on("play", (url: string) => (busy ? undefined : (current = run("play", url))));
  window.on("download", (url: string) => (busy ? undefined : (current = run("download", url))));
  window.on("cancel", () => active?.abort());

  plugin.commands.add({ id: "youtube.open", path: ["文件", "网络媒体", "YouTube 视频…"], order: 213, run: () => window.show() });

  // Unloading stops a running yt-dlp download (its process group) and waits for staging cleanup.
  plugin.onDispose(async () => {
    active?.abort();
    await current;
  });
}
