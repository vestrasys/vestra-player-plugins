# VestraTube 0.4.0: a YouTube sidebar without yt-dlp (proposal)

Plugin proposal in the format of the community workflow §2.1. Author: the
`zysilm.youtube` plugin author, 2026-10-26. Inputs: the research report
`doc/process/rounds/2026-10-online-video-research.md` in the player
repository and the user's ruling at its end. Status: implemented as the
first vertical slice in 0.4.0; the GUI acceptance (§6) is the coordinator's.

## 1. Purpose and scenarios

**What the user wants.** Find a YouTube video from inside the player and
watch it right away: type a search, see a list with thumbnails, titles,
durations and channels, double-click one and it plays. No sign-in, nothing
to install.

**What the plugin does.**

- A sidebar panel: search YouTube, list the results, play a result, download
  a result as MKV.
- The link flows of 0.3 stay: play or download one video from its link, in
  the existing "Enter a link" window, opened from the panel's bottom bar.
- A web resolver for YouTube page URLs, so a link opened anywhere (the
  playlist, Open URL, a drop, another plugin) plays through the same code.

**How, without yt-dlp.** The plugin bundles
[youtubei.js](https://github.com/LuanRT/YouTube.js) 18.3.0 (MIT; its
dependencies are MIT, ISC and Apache-2.0 AND BSD-3-Clause), packed by the
SDK's esbuild into the plugin's `main.js`. Users install nothing: the player
ships Node and ffmpeg.

**Non-goals.** Signing in, cookies, comments, subscriptions, a home feed or
trending (YouTube retired trending in 2025, and the logged-out home feed is
not reliable), playlists and channels as lists, subtitles from YouTube,
qualities above 1080p, and an extractor of our own: if YouTube breaks the
library, we wait for the library's fix and ship it (user ruling).

**Preconditions, independent of other plugins.** Vestra Player 0.5.1 or
later (images in list rows), a network connection, and for downloads the
player's bundled ffmpeg (`plugin.tools`). The panel works whether or not the
playlist or any other plugin is loaded; it shares the sidebar as a tab.

## 2. Entries

| Feature | Main menu path | Other entries | Runs directly or opens an interface | Enabling condition | State source |
| --- | --- | --- | --- | --- | --- |
| Show the VestraTube panel | **Open ▸ VestraTube** | the sidebar's tab strip (when there are several tabs) | shows the sidebar and makes its tab current | always | `panel.state` |
| Search | — | the panel's search box, Enter | runs | text not empty | the plugin's search state |
| More results | — | **More results** under the list | runs | the search has a continuation | the search's continuation |
| Play a result | — | double-click a row; Enter on the selected row (panel key); right-click ▸ **Play** | runs (`player.open` of the watch URL) | a row is selected | `player.state` |
| Download a result | — | right-click ▸ **Download…**; the bottom bar's **Download…** | opens the save dialog, then runs | a row is selected and no download runs | the plugin's download state |
| Cancel the download | — | the bottom bar's **Cancel Download**; right-click ▸ **Cancel Download** | runs | a download runs | the plugin's download state |
| Play or download a link | **Open ▸ YouTube Link…** | the bottom bar's **Open URL…** | opens the "Enter a link" window (as in 0.3) | always | the window's state |
| Open a YouTube link elsewhere | — | the playlist, the player's Open URL, a drop, any plugin's `player.open` | the resolver turns it into streams | the link is a single video | the open's `Media` |

The panel's commands without a main menu path (Play, Download…, Cancel
Download) exist only for its right-click menu and its keys, per the menu
guidelines. Changing **Open ▸ VestraTube…** (0.3: the link window) into
**Open ▸ VestraTube** (the panel) plus **Open ▸ YouTube Link…** stays inside
the Open menu and needs the interaction lead's review, not a global menu
change.

## 3. Interface

A sidebar panel (`plugin.panels.mount("sidebar", "sidebar.slint", { title:
"VestraTube" })`), mounted at activation like the playlist; the player
shows it as a tab when several panels share the sidebar. It is not forced
onto the screen: the user shows it with **Open ▸ VestraTube** or its tab,
and the player remembers the sidebar's visibility.

```text
┌─────────────────────────────────────┐  (the player's tab strip: Playlist | VestraTube)
│ [⌕ Search YouTube                 ] │  search box; Enter searches, Esc clears
├─────────────────────────────────────┤
│ ┌─────────┐ Title of the video,     │  62 px row: 96×54 thumbnail (16:9), the
│ │  thumb  │ two lines at most…      │  duration (or LIVE) drawn on its bottom
│ │    12:34│ Channel name            │  right; title (2 lines, elided), channel
│ └─────────┘                         │  (1 line, dim). Selection: Theme.selected-bg;
│ …                                   │  the playing video: Theme.playing + 2px bar;
│                                     │  a failed one: the `failed` icon.
│            More results             │  while the search has a continuation
├─────────────────────────────────────┤
│ ════════════════════                │  2 px progress line while downloading
│ [Open URL…]           [Download…]   │  bottom bar, 35 px
└─────────────────────────────────────┘
```

- **Control order (Tab):** search box, list, More results, Open URL…,
  Download….
- **Keys:** in the search box Enter searches and Esc clears it; in the list
  ↑/↓ move the selection and Enter plays (a `focus: "panel"` binding, as the
  playlist's).
- **Mouse:** click selects; double-click plays; right-click selects and
  opens the menu (Play, Download… or Cancel Download).
- **Focus:** while the search box has focus the panel asks the player to
  keep it up (`setInteraction({ focused: true })`), so it does not hide in
  fullscreen while the user types.
- **Messages.** The list area itself says what state the list is in (one
  centred line, dim; with **Retry** where retrying helps): "Search YouTube
  to find videos.", "Searching…", "No videos found.", the offline and error
  texts of §4. Outcomes of an action (a video that cannot play, a saved
  download) are OSD messages, as the panel guidelines ask; the panel has no
  status line.
- **Deviation from the panel guidelines, by the user's ruling:** the rows
  are two-line rows with a thumbnail, not single-line text rows.
- **The link window** (`youtube.slint`) is unchanged from 0.3: link field,
  status line, Download Video…, Play, Cancel.

Thumbnails are `https://i.ytimg.com/vi/<id>/mqdefault.jpg` (320×180 JPEG,
no API needed), fetched with `ui.remoteImage(url, { maxSide: 192 })` (twice
the drawn width) and set as the `thumb` field of each row. Until a
thumbnail arrives the row shows a transparent placeholder image over a grey
box. Each search gets its own child scope for its images; a new search
replaces the rows and then disposes the old scope, so old images are
released and never sent again. At 192×108 a decoded thumbnail is about
83 KB, so the list is capped at 200 rows (10 pages, about 17 MB), within
the player's 32 MB per-view image budget.

## 4. State and failure

**List states** (the `message` of the panel; rows win when there are any):

| State | Detection | Shown |
| --- | --- | --- |
| Nothing searched yet | start | "Search YouTube to find videos." |
| Searching | a search is running | "Searching…" (the old rows are cleared at once) |
| Results | ≥ 1 video | the rows |
| Empty | 0 videos | "No videos found." |
| Offline | `fetch` fails (`TypeError`, `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`) | "No network connection." + Retry |
| Library error | anything else the library throws | "YouTube search failed: {reason}" + Retry |
| More results fails | the continuation throws | the rows stay; OSD with the reason |

**A search** cancels the previous one: a newer search number discards the
older answer (youtubei.js takes no `AbortSignal`). Searching again with the
same text is allowed (a refresh). An empty search box clears the list back
to the start state.

**Playing a row** (`player.open("https://www.youtube.com/watch?v=<id>")`):

- The resolver (§5) does the work; the panel marks the row with the player's
  state: `Theme.playing` while `player.state.source` is that video.
- Failure: the open's error (the resolver's words) as an OSD message, and
  the row gets the `failed` icon until it plays once.
- Repeated double-clicks open the same video again (a fresh resolve, so a
  fresh stream URL); a newer open replaces an older one as for any source.

**The resolver** (any open of a YouTube video URL):

1. Normalize the link (watch, shorts, live, embed, youtu.be; anything else is
   refused with the 0.3 message).
2. Ask YouTube with the **VISIONOS** client on a session fetched from
   YouTube (`generate_session_locally: false`): its formats are direct URLs,
   no cipher, no `n` parameter, no PO token (measured 2026-10-26: 1080p60
   H.264 + AAC/Opus, `ffprobe` opens them with no headers).
3. **Fallbacks**, only when VISIONOS returns no usable format (for example
   made-for-kids videos): `TV_SIMPLY`, `WEB_EMBEDDED`, `IOS`, `ANDROID_VR`, on
   a second session that loads YouTube's player script. Their `n` and
   signature transforms run through youtubei.js with our evaluator: the
   player script runs in a `worker_threads` worker with a 5 s timeout and a
   128 MB heap, never in the plugin's own context (pure Node, no OS
   command). Measured today they all answer 403 for an open-ended range
   (PO tokens), so every candidate URL is **probed** with one `Range:
   bytes=0-` request before mpv gets it; a 403 moves on to the next client.
   (The same URLs answer 206 to a bounded range such as `bytes=0-999`, so
   they could serve downloads, which fetch in bounded ranges; 0.4.0 does
   not use that.)
4. **Choice:** the best video-only format up to 1080p (H.264 before VP9
   before AV1 at the same height, then frame rate, then bitrate) plus the
   best audio-only format of the default track, without DRC. They go to
   the host as `primary` and `audio`, which builds the EDL. A muxed format
   (itag 18) is the last resort; a live video plays its HLS manifest.
5. **Failure texts** (thrown as `plugin.i18n.error`, shown by the player and
   the panel): offline, "YouTube asked to confirm you're not a bot. This
   network is flagged; try another network.", "YouTube: {reason}" for the
   site's own playability reason (age, region, members, private, removed),
   "This video has no stream the player can play.", and "VestraTube could
   not read this video: {reason}. A newer version of the plugin may fix
   it." for library errors.
6. The resolver's `signal` (the open replaced, closed, or past 30 s) aborts
   the probe; the library's calls cannot be aborted, so a late answer is
   discarded by the SDK.

**Downloading** (a row, or a link from the window): one download at a time
for the whole plugin.

1. The save dialog first (`<title>.mkv`, or `YouTube.mkv` for a link);
   cancelling it changes nothing.
2. Resolve as above (no live videos: "Live videos can't be downloaded.").
3. Fetch video and audio with Node `fetch` in 10 MB ranges into a private
   staging directory next to the target (`.vestra-youtube-*`), each range
   retried twice; progress = bytes / `content_length`.
4. Mux with the bundled ffmpeg: `tools.run("ffmpeg", ["-i", video, "-i",
   audio, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", out.mkv])`.
5. Rename the finished file onto the target (the system dialog already
   asked about replacing). The staging directory is removed on success,
   failure, cancel and unload; an existing file is never touched before the
   rename.
6. Progress: the panel's 2 px line and the window's line and status; the
   end is an OSD message ("Saved: name.mkv") and the window's status.
   Cancel: the panel's Cancel Download, the window's Cancel, or unloading
   the plugin.

**Expired stream URLs.** YouTube's URLs carry `expire` (about 6 hours).
Opening again always resolves again. A video paused past the expiry fails
with mpv's HTTP error; the plugin cannot re-resolve on its own today. See
the API request R1 below.

## 5. API usage

All "existing" as of SDK 1.5.20 / player 0.5.1, checked against the SDK
reference (`llms-full.txt` 1.5.20):

```ts
const panel = plugin.panels.mount("sidebar", "sidebar.slint", { title: "VestraTube" }); // existing
panel.bind(() => ({ rows, message, canMore, downloading, progress }));             // existing
panel.on("search", (text: string) => search(text));                               // existing
panel.on("focus-changed", (on: boolean) => panel.setInteraction({ focused: on })); // existing

// Images at any depth (SDK 1.5.19, player 0.5.1): one image per row.
const thumb = await scope.ui.remoteImage(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, { maxSide: 192 });
rows[i] = { ...rows[i], thumb };                                                    // existing (1.5.19)

plugin.resolvers.add({ id: "youtube", schemes: ["https"], hosts, resolve: async (url, signal) => ({
  kind: "media", originalUrl: url, title,
  primary: { url: video.url, headers: {} }, audio: { url: audio.url, headers: {} },  // existing: host builds the EDL
}) });

await plugin.tools.run("ffmpeg", ["-i", v, "-i", a, "-c", "copy", out], { timeoutMs, signal }); // existing
await plugin.osd.show(plugin.i18n.text("Saved: {}", [name]));                        // existing
```

```slint
export struct VideoRow { key: string, title: string, channel: string, duration: string,
                         live: bool, thumb: image, selected: bool, playing: bool, failed: bool }
export global TubeBridge { in property <[VideoRow]> rows; in-out property <string> query; callback search(string); … }
```

Capabilities: `commands`, `events`, `ui.window`, `ui.dialog`, `ui.mount`,
`ui.osd`, `playback.read`, `playback.control`, `source.resolve` (0.3 plus
`ui.mount` and `ui.osd`). `minPlayerVersion` 0.5.1.

**SDK version.** The code runs on the player's SDK, so a plugin needs no
SDK upgrade to *run* on player 0.5.1. Its *tests and types* need SDK
1.5.19 or later: 1.5.18 has no `ui.remoteImage` and no `maxSide`, and its
TestHost refuses an image nested in a row (`invalid`). The repository's root
`package.json` was bumped to `^1.5.20` by the infrastructure maintainer on
2026-10-26, so the plugin uses `plugin.ui.image`, `scope.ui.remoteImage`
and nested `ImageRef` values directly, with no local type bridge.

### API request R1 (§4.1): re-resolve an expired stream

```text
Requesting plugin / code location
  zysilm.youtube 0.4.0, plugins/youtube/main.ts (the resolver). The same
  applies to zysilm.bilibili (Bilibili's URLs expire after 2 hours).

User action and expected result
  The user plays a YouTube video, pauses it for longer than the stream URL
  lives (YouTube: `expire` ≈ 6 h after resolving; Bilibili: 2 h), or plays a
  very long video, and then resumes or seeks. Expected: playback continues
  at the same position.

Why the existing API cannot do it
  The resolver runs only when a source is opened (SDK "Resolvers": "the
  player opens the result under the original open"). When mpv's next range
  request gets HTTP 403, the source goes to `phase: "error"` and the user
  has to open the video again and find the position. A plugin cannot fix
  this cleanly from outside: it would have to watch `player.state` for an
  error on a source it resolved, call `player.open` again (a new source:
  new sourceId, the playlist sees a new open, `ready()` of the original
  opener rejects with `replaced`) and seek, racing the user. It also cannot
  tell an expired URL from any other network error.
  Minimal reproduction: resolve a video, wait past `expire` (or rewrite the
  URL's `expire` parameter in a test resolver so the CDN answers 403), then
  `player.seek(60)`: the source ends in `phase: "error"`.

Desired usage
  No new plugin code in the simple form: when a source that a web resolver
  produced fails with an HTTP 403/404/410 from the stream host, the host
  calls the same resolver again for the same `originalUrl` (at most once per
  failure and once per minute) and reopens the new streams at the current
  position, keeping the sourceId, the Media and the pause state. Optional:
  `ResolvedMedia.expires?: number` (epoch ms) so the host can re-resolve
  before resuming instead of after a failure.

Who owns the state and resources; failure, cancellation, missing capability
  The host owns the source and the position; the resolver stays stateless.
  If the second resolve throws or also fails, the source goes to
  `phase: "error"` with the resolver's message, as today. A plugin that is
  gone (stopped, deactivated) means no re-resolve. Players without the
  feature behave as today.

Whether it breaks an existing contract, and which plugins it affects
  Additive (a new behaviour for a failure that today ends playback; an
  optional field). It changes what happens after a stream error, so the
  maintainer should decide whether it counts as "a change to existing
  behaviour" (§1.6 rule 2). Affected: zysilm.youtube, zysilm.bilibili; no
  built-in plugin uses web resolvers.

Minimal acceptance scenario
  A test resolver returns a URL that answers 403 after the first N bytes;
  playback seeks past N; the host resolves again and playback continues at
  that position with the same sourceId. Real: Bilibili, pause 2 h 5 min,
  resume.
```

Status: filed here for the maintainer; nothing in 0.4.0 depends on it.
Workaround meanwhile: opening the video again (double-click the row)
resolves new URLs.

## 6. Acceptance scenarios

| User action | Observable result | Evidence |
| --- | --- | --- |
| Open ▸ VestraTube | the sidebar shows the VestraTube tab with the empty-state line | GUI screenshot (coordinator); test: `panel.show` |
| Type "big buck bunny", Enter | "Searching…", then rows with thumbnails, titles, durations, channels | GUI; test: mocked youtubei.js → rows, `host.images` |
| More results | more rows appended; the list keeps its scroll | GUI; test: continuation |
| Double-click a row | the video plays (1080p H.264 + audio), the row turns to the playing colour | GUI; test: `source.submit` of the watch URL, resolver output |
| Pull the network, search | "No network connection." + Retry; Retry after reconnecting works | test (fetch failure), GUI |
| A video that cannot play (age-restricted, private) | OSD with YouTube's reason; the row shows the failed icon | test (playability), GUI |
| Download… on a row, choose a file | progress line, then "Saved: …" on the OSD; the MKV has video and audio | test (fetch + ffmpeg fake); GUI with ffprobe of the file |
| Cancel Download | the line disappears, nothing is left next to the target | test |
| Open URL…, paste a link, Play / Download Video… | as in 0.3, without yt-dlp | tests (0.3's window tests) |
| Paste a YouTube link into the playlist | it plays through the resolver | GUI |
| `VESTRA_LIVE=1` live test | a real search and a VISIONOS resolve, the URL opens in ffprobe | `tests/live.test.ts` (skipped otherwise) |
