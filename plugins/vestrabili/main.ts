import type { Plugin, PluginError, Text, TextError } from "@vestra-player/sdk";
import { extractBilibili, validateUrl } from "./extractor.ts";

/** Status text is one line (UI-TOOL-05): collapse whitespace and cut long backend reasons. */
const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
};

/** Our own failures (`plugin.i18n.error`) carry their translatable text. */
const isTextError = (error: unknown): error is TextError => error instanceof Error && "text" in error;

/** VestraBili: a public resolver for Bilibili site URLs plus one "Enter a link" window that opens them. */
export default async function activate(plugin: Plugin) {
  const { text, error: fail } = plugin.i18n;
  const prompt = () => text("Enter a Bilibili video link.");

  // Any caller (this window, a playlist link, a generic open) gets the same routing.
  plugin.resolvers.add({
    id: "bilibili",
    schemes: ["http", "https"],
    hosts: ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"],
    resolve: async (url, signal) => {
      const result = await extractBilibili(url, fail, signal);
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
  let status: Text | string = prompt();
  let busy = false;
  let running: AbortController | undefined;
  const window = plugin.windows.create("dialog.slint");
  window.bind(() => ({ url, status, busy }));

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
        // Plain errors (URL validation) carry our own words; other refusals are not worded by the host.
        if (error.code) return text("The playback request failed.");
        return isTextError(error) ? error.text : oneLine(error.message);
    }
  }

  window.on("play", async (input: string) => {
    if (running) return;
    const run = (running = new AbortController());
    url = input;
    // The loading timeout covers resolution and backend readiness; only Cancel aborts `run`.
    const signal = AbortSignal.any([run.signal, AbortSignal.timeout(60_000)]);
    try {
      const source = validateUrl(input, fail);
      busy = true;
      status = text("Resolving the video and audio…"); // shown when the handler first awaits
      const media = await plugin.player.open(source, { signal }); // resolved by the resolver above
      await media.ready({ signal }); // on abort the SDK closes this media if it is still current
      status = text("The video is ready.");
    } catch (error) {
      // A cancelled request leaves the (closed) window alone.
      if (!run.signal.aborted && running === run) status = describe(error as PluginError, signal);
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
    path: ["@open", "VestraBili…"],
    order: 112,
    group: "open",
    run: () => {
      // A fresh window starts empty; an open one keeps what it shows.
      if (!window.opened) [url, status, busy] = ["", prompt(), false];
      return window.show();
    },
  });
}
