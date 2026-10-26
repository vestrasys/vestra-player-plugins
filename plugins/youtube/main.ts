import type { Plugin, PluginError, Text, TextError } from "@vestra-player/sdk";
import { normalizeYouTubeUrl, YouTubeService } from "./service.ts";

const hosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];
/** The original wait limit (400 polls × 300 ms). Timing out stops waiting; it does not close the source. */
const readyTimeoutMs = 120_000;

/** Status text is one line (UI-TOOL-05): collapse whitespace and cut long backend reasons. */
const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
};

/** Our own failures (`plugin.i18n.error`) carry their translatable text. */
const isTextError = (error: unknown): error is TextError => error instanceof Error && "text" in error;

/** VestraTube: a public YouTube URL resolver, plus one "Enter a link" window to play or download a single video. */
export default async function activate(plugin: Plugin, youtube = new YouTubeService(plugin.i18n)) {
  const { text, error: fail } = plugin.i18n;
  const prompt = () => text("Paste a YouTube video link to play or download it.");
  let status: Text | string = prompt();
  let busy = false;
  let progress = 0;
  let active: AbortController | undefined;
  let current: Promise<void> | undefined;

  /** Host refusals in the plugin's words; backend reasons (resolver, load failure) are kept as they are. */
  function refusal(error: PluginError) {
    switch (error.code) {
      case "backend":
      case "failed":
        return fail("Playback failed: {}", [oneLine(error.message)]);
      case "busy":
        return fail("The player is busy. Try again later.");
      case "unsupported":
      case "unavailable":
        return fail("The player can't open this link.");
      default:
        // Plain errors without a code are our own words already.
        return error.code ? fail("The playback request failed.") : error;
    }
  }

  plugin.resolvers.add({
    id: "youtube",
    schemes: ["https"],
    hosts,
    resolve: async (url, signal) => ({ kind: "media", ...(await youtube.extract(url, signal)), originalUrl: url }),
  });

  async function play(url: string, signal: AbortSignal) {
    status = text("Resolving and loading the video and audio…");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(fail("Timed out waiting for the video to be ready.")), readyTimeoutMs);
    });
    try {
      const opening = plugin.player.open(url, { signal }).catch((error: PluginError) => {
        throw error.code === "aborted" ? error : refusal(error);
      });
      const media = await Promise.race([opening, deadline]);
      await Promise.race([media.ready({ signal }), deadline]).catch((error: PluginError) => {
        if (error.code === "replaced") throw fail("Another source replaced the playback request.");
        if (error.code === "ended") throw fail("The playback request has ended.");
        if (error.code === "failed") {
          // The player's own reason is shown as it is.
          const reason = plugin.player.state.error;
          throw reason ? new Error(reason) : fail("The video failed to load.");
        }
        throw error;
      });
    } finally {
      clearTimeout(timer);
    }
    status = text("The video is ready.");
  }

  async function download(url: string, signal: AbortSignal) {
    // The file name is data: the default name of the saved YouTube video.
    const destination = await plugin.dialogs.saveFile({ title: "Save YouTube Video", fileName: "YouTube.mkv" });
    if (!destination) {
      status = text("No save location was chosen.");
      return;
    }
    if (signal.aborted) throw new Error("Cancelled");
    const file = await youtube.download(url, destination, signal, (value) => {
      progress = (value.percent ?? 0) / 100;
      status = value.message;
      plugin.update(); // progress arrives between awaits of one handler
    });
    progress = 1;
    status = text("Saved: {}", [file]);
  }

  async function run(kind: "play" | "download", input: string) {
    busy = true;
    progress = 0;
    active = new AbortController();
    try {
      const url = normalizeYouTubeUrl(input, fail);
      await (kind === "play" ? play(url, active.signal) : download(url, active.signal));
    } catch (error) {
      const cancelled = error instanceof Error && (error.message === "Cancelled" || error.name === "AbortError");
      status = cancelled
        ? text("Cancelled.")
        : isTextError(error)
          ? error.text
          : oneLine(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      active = undefined;
    }
  }

  const window = plugin.windows.create("youtube.slint");
  window.bind(() => ({ status, busy, progress }));
  window.on("play", (url: string) => (busy ? undefined : (current = run("play", url))));
  window.on("download", (url: string) => (busy ? undefined : (current = run("download", url))));
  // Cancel = dialog cancel: stop what is running (closing only our own media) and close the window.
  window.on("cancel", () => {
    active?.abort();
    return window.close();
  });

  plugin.commands.add({
    id: "youtube.open",
    path: ["@open", "VestraTube…"],
    order: 111,
    group: "open",
    run: () => {
      // A fresh window starts from the prompt; an open one (or a running download) keeps what it shows.
      if (!window.opened && !busy) [status, progress] = [prompt(), 0];
      return window.show();
    },
  });

  // Unloading stops a running yt-dlp download (its process group) and waits for staging cleanup.
  plugin.onDispose(async () => {
    active?.abort();
    await current;
  });
}
