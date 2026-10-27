import { fileURLToPath } from "node:url";
import type { ImageRef, Plugin, Scope, TextValue } from "@vestra-player/sdk";
import type { Page, Video, YouTube } from "./youtube.ts";
import { formatDuration, isOffline, isTextError, oneLine, thumbnailUrl, videoIdOf } from "./youtube.ts";

/** 10 pages; at 192×108 a decoded thumbnail is ~83 KB, so 200 rows stay well inside the player's 32 MB per view. */
export const MAX_ROWS = 200;
/** About twice the drawn width (96 px). */
export const THUMB_SIDE = 192;
/** A transparent image shown (over a grey box) until a row's thumbnail arrives. */
export const PLACEHOLDER = fileURLToPath(new URL("./placeholder.png", import.meta.url));

/** What the panel needs from the rest of the plugin. */
export type PanelActions = {
  /** Open the video and wait until it plays; throws the reason it did not. */
  play(video: Video, signal: AbortSignal): Promise<void>;
  /** Save dialog, then download (a no-op while one runs). */
  download(video: Video): void;
  cancelDownload(): void;
  /** The "Enter a link" window. */
  openLink(): void;
  /** The plugin's one download, from the panel or the link window. */
  readonly downloading: { running: boolean; fraction: number | null; message: TextValue };
};

type Entry = { video: Video; thumb: ImageRef };
type Phase = "start" | "searching" | "results" | "empty" | "failed";

/**
 * Continuation pages that add no row (every video known, or only shorts, channel and
 * playlist cards) are followed this many times in a row before the search is treated as
 * ended. Without a limit the view, seeing the row count unchanged, asks again at once:
 * a request loop with nothing on screen while YouTube keeps answering such pages.
 */
export const MAX_EMPTY_PAGES = 3;
/** A hidden row past the results (`rows` always has MAX_ROWS entries). */
const BLANK_ROW = { key: "", title: "", channel: "", duration: "", live: false, failed: false };

/** The sidebar panel: search, rows with thumbnails (more as the list nears its end), and the bottom bar. */
export function mountPanel(plugin: Plugin, youtube: YouTube, actions: PanelActions) {
  const { text } = plugin.i18n;
  const placeholder = plugin.ui.image(PLACEHOLDER);
  let query = "";
  let searched = "";
  let phase: Phase = "start";
  let failure: TextValue = "";

  let entries: Entry[] = [];
  let selected: string | null = null;
  const failed = new Set<string>();
  let more: Page["more"] = null;
  /** Consecutive continuation pages that added no row (reset by a page that did). */
  let emptyPages = 0;
  let loadingMore = false;
  /** Why the last page failed to load; automatic loading waits for Retry meanwhile. */
  let moreError: TextValue | null = null;
  let scrollTop = 0;
  /** How far the list is scrolled (logical px): a newly made list starts there (`show-y`). */
  let scrollY = 0;
  /** A newer search makes older answers stale (youtubei.js cannot abort a request). */
  let generation = 0;
  /** The thumbnails of the current search; replaced (and released) by the next one. */
  let images: Scope | null = null;
  let playing: AbortController | undefined;

  const panel = plugin.panels.mount("sidebar", "sidebar.slint", { title: "VestraTube" });

  const selectedVideo = () => entries.find((entry) => entry.video.id === selected)?.video ?? null;
  const show = (value: TextValue) => {
    // i18n-ignore: already a translated Text (or the library's own message)
    void plugin.osd.show(value).catch(() => {});
  };
  const reason = (error: unknown): TextValue =>
    isTextError(error) ? error.text : oneLine(error instanceof Error ? error.message : String(error));

  function message(): TextValue {
    switch (phase) {
      case "start":
        // No feed before a search: logged out, YouTube's home feed is empty ("history is off")
        // and its trending and explore pages are gone (DESIGN.md §1, non-goals).
        return text("Search and press Enter");
      case "searching":
        return text("Searching…");
      case "empty":
        return text("No videos found.");
      case "failed":
        return failure;
      default:
        return "";
    }
  }

  panel.bind(() => {
    const current = videoIdOf(plugin.player.state.source);
    const job = actions.downloading;
    return {
      // Plain values only, and always MAX_ROWS of them, so the player updates a changed row in
      // place and never rebuilds the row elements under the pointer (a rebuilt row loses a
      // double-click in progress): it replaces a model that holds images or changes length.
      // A new page fills blank rows. The thumbnails, the selection and the playing video live
      // in properties of their own.
      rows: Array.from({ length: MAX_ROWS }, (_, index) => {
        const video = entries[index]?.video;
        if (!video) return BLANK_ROW;
        return {
          key: video.id,
          title: video.title,
          channel: video.channel,
          duration: formatDuration(video.seconds),
          live: video.live,
          failed: failed.has(video.id),
        };
      }),
      count: entries.length,
      thumbs: entries.map(({ thumb }) => thumb),
      selectedIndex: entries.findIndex((entry) => entry.video.id === selected),
      playingKey: current ?? "",
      query,
      message: message(),
      canRetry: phase === "failed",
      canMore: more !== null && !loadingMore && moreError === null,
      loadingMore,
      moreError: moreError ?? "",
      canDownload: selected !== null && !job.running,
      downloading: job.running,
      progress: job.fraction ?? -1,
      progressText: job.message,
      scrollTop,
      showY: scrollY,
    };
  });

  /** Swap in a fresh image scope; the old one is released after the rows that used it are gone. */
  function freshImages(): Scope {
    const previous = images;
    const scope = (images = plugin.scope());
    // Disposed with the plugin (before the panel and the placeholder): drop the rows, so no later
    // update pass sends a released image, and thumbnails still on their way are ignored.
    scope.onDispose(() => {
      if (images !== scope) return;
      images = null;
      entries = [];
    });
    previous?.dispose();
    return scope;
  }

  function addPage(page: Page, scope: Scope) {
    const known = new Set(entries.map((entry) => entry.video.id));
    const before = entries.length;
    for (const video of page.videos) {
      if (entries.length >= MAX_ROWS) break;
      if (known.has(video.id)) continue;
      known.add(video.id);
      entries.push({ video, thumb: placeholder });
      scope.ui
        .remoteImage(thumbnailUrl(video.id), { maxSide: THUMB_SIDE })
        .then(
          (thumb) => {
            if (scope !== images) return; // a newer search replaced these rows
            const entry = entries.find((item) => item.video.id === video.id);
            if (!entry) return;
            entry.thumb = thumb;
            plugin.update();
          },
          () => {}, // the placeholder stays
        );
    }
    emptyPages = entries.length > before ? 0 : emptyPages + 1;
    more = entries.length < MAX_ROWS && emptyPages < MAX_EMPTY_PAGES ? page.more : null;
  }

  async function search(input: string) {
    query = input;
    const term = input.trim();
    const mine = ++generation;
    entries = [];
    selected = null;
    more = null;
    emptyPages = 0;
    loadingMore = false;
    moreError = null;
    scrollTop++;
    // Also while the panel is hidden: the next list it makes starts at the top.
    scrollY = 0;
    const scope = freshImages();
    if (!term) {
      phase = "start";
      searched = "";
      return;
    }
    searched = term;
    phase = "searching";
    plugin.update();
    try {
      const page = await youtube.search(term);
      if (mine !== generation) return;
      addPage(page, scope);
      phase = entries.length ? "results" : "empty";
    } catch (error) {
      if (mine !== generation) return;
      const offline = isOffline(error);
      phase = "failed";
      failure = offline ? text("No network connection.") : reason(error);
    }
  }

  /**
   * The next page, once: `seen` is the number of rows the view had when it asked (scrolling
   * near the end, ↓ on the last row), so a request for a page already added is ignored, and
   * one already loading is not asked for again.
   */
  async function loadMore(seen = entries.length) {
    const next = more;
    const scope = images;
    if (!next || !scope || loadingMore || seen !== entries.length) return;
    const mine = generation;
    loadingMore = true;
    moreError = null;
    plugin.update();
    try {
      const page = await next();
      if (mine !== generation) return;
      addPage(page, scope);
    } catch (error) {
      if (mine !== generation) return;
      moreError = isOffline(error) ? text("No network connection.") : reason(error);
    } finally {
      if (mine === generation) loadingMore = false;
    }
  }

  async function play(key: string) {
    const video = entries.find((entry) => entry.video.id === key)?.video;
    if (!video) return;
    selected = key;
    failed.delete(key);
    playing?.abort();
    const controller = (playing = new AbortController());
    plugin.update();
    try {
      await actions.play(video, controller.signal);
    } catch (error) {
      // A newer play from the panel replaced this one: that is what the user asked for.
      if (controller.signal.aborted) return;
      failed.add(key);
      show(reason(error));
    } finally {
      if (playing === controller) playing = undefined;
    }
  }

  function step(by: number): Promise<void> | undefined {
    if (!entries.length) return undefined;
    const at = entries.findIndex((entry) => entry.video.id === selected);
    const next = at < 0 ? (by > 0 ? 0 : entries.length - 1) : Math.max(0, Math.min(entries.length - 1, at + by));
    selected = entries[next]!.video.id;
    // ↓ onto the last row loads the next page, as scrolling there does.
    if (by > 0 && next === entries.length - 1 && moreError === null) return loadMore();
    return undefined;
  }

  panel.on("query-changed", (value: string) => {
    query = value;
    // Clearing the box (Esc, or deleting the text) goes back to the start.
    if (!value.trim() && phase !== "start") void search("");
  });
  panel.on("search", (value: string) => search(value));
  panel.on("retry", () => search(searched));
  panel.on("more", (seen: number) => loadMore(seen));
  // Kept for the next list the player makes (the view reports every scroll, also the reset of
  // a new search, and its own clamping).
  panel.on("scrolled", (y: number) => {
    if (Number.isFinite(y)) scrollY = Math.max(0, y);
  });
  panel.on("retry-more", () => {
    moreError = null;
    return loadMore();
  });
  panel.on("select", (key: string) => {
    if (entries.some((entry) => entry.video.id === key)) selected = key;
  });
  panel.on("select-step", (by: number) => step(by));
  panel.on("play", (key: string) => play(key));
  panel.on("open-url", () => actions.openLink());
  panel.on("download", () => {
    const video = selectedVideo();
    if (video) actions.download(video);
  });
  panel.on("cancel-download", () => actions.cancelDownload());
  panel.on("focus-changed", (focused: boolean) => panel.setInteraction({ focused }));

  // Commands of the panel's right-click menu and keys (no main menu path).
  const playSelected = plugin.commands.add({
    id: "youtube.play-selected",
    title: "Play",
    bindings: ["Enter"],
    focus: "panel",
    enabled: () => selected !== null,
    run: () => (selected ? play(selected) : undefined),
  });
  const downloadSelected = plugin.commands.add({
    id: "youtube.download-selected",
    title: "Download…",
    enabled: () => selected !== null && !actions.downloading.running,
    run: () => {
      const video = selectedVideo();
      if (video) actions.download(video);
    },
  });
  const cancelDownload = plugin.commands.add({
    id: "youtube.cancel-download",
    title: "Cancel Download",
    enabled: () => actions.downloading.running,
    run: () => actions.cancelDownload(),
  });
  panel.on("context-menu", (key: string, x: number, y: number) => {
    if (!entries.some((entry) => entry.video.id === key)) return;
    selected = key;
    return panel.showMenu([playSelected, actions.downloading.running ? cancelDownload : downloadSelected], { x, y });
  });

  plugin.onDispose(() => playing?.abort());
  return panel;
}
