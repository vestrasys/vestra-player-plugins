import type { Plugin, PluginError, Text, TextValue } from "@vestra-player/sdk";
import { downloadMedia } from "./download.ts";
import { mountPanel } from "./panel.ts";
import type { Video } from "./youtube.ts";
import {
  isTextError,
  normalizeYouTubeUrl,
  oneLine,
  resolverHosts,
  watchUrl,
  YouTube,
  youtubeLanguage,
} from "./youtube.ts";

/** The original wait limit (400 polls × 300 ms). Timing out stops waiting; it does not close the source. */
const readyTimeoutMs = 120_000;

const isCancel = (error: unknown) =>
  error instanceof Error &&
  (error.message === "Cancelled" || error.name === "AbortError" || (error as PluginError).code === "aborted");

/** A file name from a video title: no path or reserved characters, at most 120 characters. */
export function fileNameFor(title: string | null): string {
  const clean = (title ?? "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120)
    .trim();
  return `${clean || "YouTube"}.mkv`;
}

/**
 * VestraTube: a YouTube sidebar (search, play, download), the "Enter a link"
 * window, and a resolver for YouTube links opened anywhere. youtubei.js does
 * the YouTube part (bundled); the player's ffmpeg muxes downloads.
 */
export default async function activate(
  plugin: Plugin,
  youtube = new YouTube(plugin.i18n, { lang: youtubeLanguage(plugin.i18n.locale) }),
) {
  const { text, error: fail } = plugin.i18n;

  // ------------------------------------------------------------ resolver: any open of a YouTube video link
  plugin.resolvers.add({
    id: "youtube",
    schemes: ["https"],
    hosts: resolverHosts,
    resolve: async (url, signal) => {
      const media = await youtube.resolve(url, signal);
      return {
        kind: "media",
        originalUrl: url,
        title: media.title,
        primary: { url: media.primary.url, headers: media.primary.headers },
        ...(media.audio ? { audio: { url: media.audio.url, headers: media.audio.headers } } : {}),
      };
    },
  });

  // ------------------------------------------------------------ opening a video and waiting for it

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

  /** Opens `url` and waits until it plays; throws why it did not (in the user's language). */
  async function openAndWait(url: string, signal: AbortSignal) {
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
          // The player's own reason (for a YouTube link, the resolver's words) is shown as it is.
          const reason = plugin.player.state.error;
          throw reason ? new Error(reason) : fail("The video failed to load.");
        }
        throw error;
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------ the one download (panel or link window)

  const downloading: { running: boolean; fraction: number | null; message: TextValue } = {
    running: false,
    fraction: null,
    message: "",
  };
  let downloadControl: AbortController | undefined;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  };

  /**
   * Save dialog, resolve, download, mux. Resolves with the saved file's name,
   * or `null` when no location was chosen; `report` sees every step.
   */
  async function download(
    url: string,
    title: string | null,
    signal: AbortSignal,
    report: (fraction: number | null, message: TextValue) => void,
  ): Promise<string | null> {
    // The file name is data: the default name of the saved video.
    const destination = await plugin.dialogs.saveFile({ title: "Save YouTube Video", fileName: fileNameFor(title) });
    if (!destination) return null;
    if (signal.aborted) throw new Error("Cancelled");
    downloading.running = true;
    downloading.fraction = null;
    downloadControl = new AbortController();
    const both = AbortSignal.any([signal, downloadControl.signal]);
    const update = (fraction: number | null, message: TextValue) => {
      downloading.fraction = fraction;
      downloading.message = message;
      report(fraction, message);
      plugin.update(); // progress arrives between awaits of one handler
    };
    try {
      update(null, text("Resolving the video…"));
      const media = await youtube.resolve(url, both);
      return await downloadMedia({
        media,
        destination,
        words: plugin.i18n,
        fetcher: youtube.fetch,
        tools: plugin.tools,
        signal: both,
        progress: (value) => update(value.fraction, value.message),
      });
    } finally {
      downloading.running = false;
      downloadControl = undefined;
      plugin.update(); // a panel download ends outside any handler
    }
  }

  // ------------------------------------------------------------ the "Enter a link" window (0.3's flows)

  const prompt = () => text("Paste a YouTube video link to play or download it.");
  let status: TextValue = prompt();
  let busy = false;
  let progress = 0;
  let active: AbortController | undefined;

  async function run(kind: "play" | "download", input: string) {
    busy = true;
    progress = 0;
    active = new AbortController();
    try {
      const url = normalizeYouTubeUrl(input, fail);
      if (kind === "play") {
        status = text("Resolving and loading the video and audio…");
        await openAndWait(url, active.signal);
        status = text("The video is ready.");
      } else {
        if (downloading.running) throw fail("A download is already running.");
        const name = await download(url, null, active.signal, (fraction, message) => {
          progress = fraction ?? 0;
          status = message;
        });
        if (name === null) status = text("No save location was chosen.");
        else {
          progress = 1;
          status = text("Saved: {}", [name]);
        }
      }
    } catch (error) {
      status = isCancel(error)
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
  window.on("play", (url: string) => (busy ? undefined : track(run("play", url))));
  window.on("download", (url: string) => (busy ? undefined : track(run("download", url))));
  // Cancel = dialog cancel: stop what is running (closing only our own media) and close the window.
  window.on("cancel", () => {
    active?.abort();
    return window.close();
  });
  const openLink = () => {
    // A fresh window starts from the prompt; an open one (or a running download) keeps what it shows.
    if (!window.opened && !busy) [status, progress] = [prompt(), 0];
    return window.show();
  };

  // ------------------------------------------------------------ the sidebar panel

  const panel = mountPanel(plugin, youtube, {
    play: (video: Video, signal: AbortSignal) => openAndWait(watchUrl(video.id), signal),
    download: (video: Video) => {
      if (downloading.running) return;
      const controller = new AbortController();
      track(
        download(watchUrl(video.id), video.title, controller.signal, () => {}).then(
          (name) => {
            if (name !== null) void plugin.osd.show(text("Saved: {}", [name])).catch(() => {});
          },
          (error: unknown) => {
            const message = isCancel(error)
              ? text("Download cancelled.")
              : isTextError(error)
                ? error.text
                : oneLine(error instanceof Error ? error.message : String(error));
            // i18n-ignore: already a translated Text (or the library's own message)
            void plugin.osd.show(message).catch(() => {});
          },
        ),
      );
    },
    cancelDownload: () => downloadControl?.abort(),
    openLink: () => void openLink(),
    downloading,
  });

  plugin.commands.add({
    id: "youtube.panel",
    path: ["@open", "VestraTube"],
    order: 111,
    group: "open",
    run: () => panel.show(),
  });
  plugin.commands.add({
    id: "youtube.open",
    path: ["@open", "YouTube Link…"],
    order: 112,
    group: "open",
    run: openLink,
  });

  // Unloading stops a running download (and its ffmpeg) and waits for the staging cleanup.
  plugin.onDispose(async () => {
    active?.abort();
    downloadControl?.abort();
    await Promise.allSettled([...pending]);
  });
}
