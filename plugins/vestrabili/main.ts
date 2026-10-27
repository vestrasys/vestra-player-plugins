import type { Plugin, PluginError, Text, TextError } from "@vestra-player/sdk";
import { extractBilibili, validateUrl, type ResolvedBilibili } from "./extractor.ts";
import {
  DEFAULT_STATE,
  isState,
  looksOutdated,
  YtDlp,
  type Options,
  type Progress,
  type State,
} from "./ytdlp.ts";

/** Status text is one line (UI-TOOL-05): collapse whitespace and cut long backend reasons. */
const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
};

/** Our own failures (`plugin.i18n.error`) carry their translatable text. */
const isTextError = (error: unknown): error is TextError => error instanceof Error && "text" in error;

/** How long a resolve (a playlist link, a generic open) waits for yt-dlp to be ready; the player gives it 30 s in all. */
const RESOLVER_WAIT = 25_000;

/** What tests replace: the network, programs and the system (see `tests/`). */
export interface Dependencies {
  ytdlp?: Partial<Pick<Options, "fetch" | "run" | "key" | "platform" | "arch" | "env" | "now">>;
  extract?: typeof extractBilibili;
}

/** A resolver failure in our words, for the window that opened that link. */
interface Failure {
  url: string;
  text: Text;
  detail: string;
}

/** VestraBili: a public resolver for Bilibili site URLs plus one "Enter a link" window that opens them. */
export function vestrabili(dependencies: Dependencies = {}) {
  const extract = dependencies.extract ?? extractBilibili;
  return async function activate(plugin: Plugin) {
    const { text, error: fail } = plugin.i18n;
    const prompt = () => text("Enter a Bilibili video link.");

    let url = "";
    let status: Text | string = prompt();
    let busy = false;
    /** yt-dlp's own words for the shown failure (the status line's tooltip), else empty. */
    let detail = "";
    /** The resolver's last failure in our words, for the window that opened that link. */
    let failure: Failure | undefined;
    let running: AbortController | undefined;
    let osdShownAt = 0;

    const store = plugin.storage.json<State>("ytdlp", { defaults: DEFAULT_STATE, validate: isState });
    const ytdlp = new YtDlp({
      directory: plugin.dataDirectory,
      store,
      error: fail,
      ask: async (asset) => {
        try {
          const answer = await plugin.dialogs.confirm({
            message: "Download yt-dlp to play Bilibili links?",
            detail:
              "VestraBili plays Bilibili links with yt-dlp, a free open-source tool. It downloads it once (about {} MB) from the yt-dlp project's official GitHub releases, checks it against the project's signed checksums, and keeps it up to date. yt-dlp is in the public domain (Unlicense) and is not part of VestraBili.",
            args: [asset.megabytes],
            confirm: "Download",
            cancel: "Cancel",
          });
          return answer.confirmed;
        } catch (error) {
          if ((error as PluginError).code === "busy") throw fail("Another dialog is open. Close it and try again.");
          throw fail("VestraBili can't ask to download yt-dlp here. Install yt-dlp and put it on the PATH.");
        }
      },
      progress: (progress) => showProgress(progress),
      installed: (first) => {
        // Someone who opened a link from the playlist hears that it can be opened now.
        if (first && !running) plugin.osd.show("yt-dlp is ready.").catch(() => {});
      },
      ...dependencies.ytdlp,
    });
    plugin.onDispose(() => ytdlp.cancel());

    /** Download progress: in the window when it is waiting for it, else on the video. */
    function showProgress(progress: Progress | null) {
      if (!progress) return;
      const percent = progress.total ? Math.floor((progress.received / progress.total) * 100) : null;
      const megabytes = Math.round(progress.received / (1024 * 1024));
      if (running) {
        status = percent === null ? text("Downloading yt-dlp… {} MB", [megabytes]) : text("Downloading yt-dlp… {}%", [percent]);
        plugin.update();
        return;
      }
      const now = Date.now();
      if (now - osdShownAt < 1000) return;
      osdShownAt = now;
      const shown = percent === null ? plugin.osd.show("Downloading yt-dlp… {} MB", [megabytes]) : plugin.osd.show("Downloading yt-dlp… {}%", [percent]);
      shown.catch(() => {});
    }

    const media = (result: ResolvedBilibili) => ({
      kind: "media" as const,
      originalUrl: result.originalUrl,
      title: result.title,
      primary: result.media,
      ...(result.audio ? { audio: result.audio } : {}),
    });

    // Any caller (this window, a playlist link, a generic open) gets the same routing.
    plugin.resolvers.add({
      id: "bilibili",
      schemes: ["http", "https"],
      hosts: ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"],
      resolve: async (url, signal) => {
        const link = validateUrl(url, fail); // a wrong link fails before anything is downloaded
        try {
          return await resolveLink(url, signal);
        } catch (error) {
          const why = (error as { reason?: unknown }).reason;
          if (typeof why === "string") console.error(`yt-dlp: ${why}`);
          if (isTextError(error)) failure = { url: link, text: error.text, detail: typeof why === "string" ? why : "" };
          throw error;
        }
      },
    });

    async function resolveLink(url: string, signal: AbortSignal) {
        ytdlp.resolving++;
        try {
          const waiting = AbortSignal.any([signal, AbortSignal.timeout(RESOLVER_WAIT)]);
          let program: string;
          try {
            program = await ytdlp.program({ interactive: false, signal: waiting });
          } catch (error) {
            if (waiting.aborted && !signal.aborted)
              throw fail("VestraBili is still getting yt-dlp ready. Open the link again when it's done.");
            throw error;
          }
          try {
            return media(await extract(url, fail, signal, program));
          } catch (error) {
            // A site change a newer yt-dlp may handle: check for one now and try once more.
            const why = (error as { reason?: unknown }).reason;
            if (signal.aborted || typeof why !== "string" || !looksOutdated(why)) throw error;
            const updated = await ytdlp.update({ force: true, signal }).catch(() => false);
            if (!updated) throw error;
            return media(await extract(url, fail, signal, await ytdlp.program({ interactive: false, signal })));
          }
        } finally {
          ytdlp.resolving--;
        }
    }

    // The managed copy is checked for a newer yt-dlp in the background (at most once a day, never while resolving).
    const check = () => void ytdlp.update().catch((error) => console.error(`yt-dlp update check: ${(error as Error).message}`));
    const first = setTimeout(check, 60_000);
    const hourly = setInterval(check, 60 * 60 * 1000);
    first.unref();
    hourly.unref();
    plugin.onDispose(() => {
      clearTimeout(first);
      clearInterval(hourly);
    });

    const window = plugin.windows.create("dialog.slint");
    window.bind(() => ({ url, status, busy, detail }));

    /** The window's words for a failed play: host refusals in the plugin's words, backend reasons as they are. */
    function describe(error: PluginError, signal: AbortSignal): Text | string {
      if (signal.aborted) return text("Timed out loading the media. Try again.");
      switch (error.code) {
        case "replaced":
          return text("Another source replaced the playback request.");
        case "ended":
          return text("The playback request has ended.");
        case "failed":
        case "backend":
          return oneLine(error.message);
        case "busy":
          return text("The player is busy. Try again later.");
        case "unsupported":
        case "unavailable":
          return text("The player can't open this link.");
        default:
          // Plain errors (URL validation, yt-dlp setup) carry our own words; other refusals are not worded by the host.
          if (error.code) return text("The playback request failed.");
          return isTextError(error) ? error.text : oneLine(error.message);
      }
    }

    window.on("play", async (input: string) => {
      if (running) return;
      const run = (running = new AbortController());
      url = input;
      let signal = run.signal;
      let source = "";
      detail = "";
      failure = undefined;
      try {
        source = validateUrl(input, fail);
        busy = true;
        status = text("Resolving the video and audio…"); // a download shows its progress instead
        // yt-dlp first (asking, downloading): only Cancel ends this wait.
        await ytdlp.program({ interactive: true, signal: run.signal });
        // The loading timeout covers resolution and backend readiness; only Cancel aborts `run`.
        signal = AbortSignal.any([run.signal, AbortSignal.timeout(60_000)]);
        status = text("Resolving the video and audio…");
        const media = await plugin.player.open(source, { signal }); // resolved by the resolver above
        await media.ready({ signal }); // on abort the SDK closes this media if it is still current
        status = text("The video is ready.");
      } catch (error) {
        // A cancelled request leaves the (closed) window alone.
        if (!run.signal.aborted && running === run) {
          const code = (error as PluginError).code;
          const last = failure as Failure | undefined; // set by the resolver meanwhile
          // The resolver's failure in our words (translated), with yt-dlp's own in the tooltip.
          if ((code === "failed" || code === "backend") && last?.url === source && !signal.aborted)
            [status, detail] = [last.text, last.detail];
          else status = describe(error as PluginError, signal);
        }
      } finally {
        if (running === run) {
          running = undefined;
          if (!run.signal.aborted) busy = false;
        }
      }
    });
    window.on("cancel", () => {
      if (running) ytdlp.cancel(); // a download the window waits for stops with it
      running?.abort();
      running = undefined;
      return window.close();
    });

    plugin.commands.add({
      id: "bilibili.open",
      path: ["@open", "VestraBili…"],
      order: 112,
      group: "open",
      run: () => {
        // A fresh window starts empty; an open one keeps what it shows.
        if (!window.opened) [url, status, busy, detail] = ["", prompt(), false, ""];
        return window.show();
      },
    });
  };
}

export default vestrabili();
