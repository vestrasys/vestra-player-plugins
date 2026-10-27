# Changelog

## 0.4.2

- **The results keep their scroll position.** Switching to another sidebar tab and back, hiding and showing the sidebar, detaching it, or the player rebuilding its main window (when any plugin adds or removes a panel, for example a built-in plugin restarting) used to put the list back at the top. The list now opens where you left it, with the same row selected. A new search still starts at the top.

## 0.4.1

- **Double-click plays at once, anywhere on a row.** In 0.4.0 a double-click on the title or channel of a row that was not yet selected often only selected it. Two causes: every click and every arriving thumbnail made the player rebuild all the rows, which lost the double-click in progress, and the title tooltip, once shown, swallowed the next click. The rows are now updated in place, and they no longer have a title tooltip. Click still selects; right-click, ↑/↓ and Enter work as before.
- **Infinite scroll.** Scrolling the results down (or ↓ onto the last row) loads the next page by itself, with "Loading…" at the end of the list; if a page fails, the reason and **Retry** show there. The **More results** button is gone. A search whose next pages bring nothing new ends after three such pages instead of asking YouTube again and again. New pages and clicks no longer rebuild the rows already shown.
- **Readable text selection in the search box** in the dark palette: it uses the player's standard selection colours, as other search fields do.
- **Larger search box text**, the same size as the result titles.
- Before the first search the panel says "Search and press Enter" and asks YouTube nothing. There is no recommended feed: logged out, YouTube's home feed is empty and its trending page is gone.

## 0.4.0

- **A YouTube sidebar.** **Open → VestraTube** shows a sidebar tab with a search box and the results: thumbnail, title, duration and channel. Double-click (or Enter) plays a video; **More results** loads the next page; right-click offers Play and Download….
- **No more yt-dlp.** Playback and downloads use the open-source library youtubei.js (MIT), bundled in the plugin: the VISIONOS client first (direct stream links, 1080p H.264 with separate audio), other clients as fallbacks. Downloads fetch the video and audio and merge them with the player's own ffmpeg into MKV. Nothing to install.
- The link window stays: **Open URL…** in the sidebar's bottom bar, or **Open → YouTube Link…** (it was **Open → VestraTube…**). Download… in the bottom bar saves the selected video; Cancel Download stops it.
- Clear messages for no network, YouTube's bot check, videos YouTube will not play (with its reason), and library errors.
- Needs Vestra Player 0.5.1 or later (images in list rows). New capabilities: `ui.mount` (the sidebar) and `ui.osd` (messages).

## 0.3.1

- Renamed to **VestraTube** (menu **Open → VestraTube…**, window title, store listing). The id stays `zysilm.youtube`, so this is an update of the same plugin. Features are unchanged.
- English is now the source language: menus, the window, messages and the store texts are in English, with a Simplified Chinese translation (`locales/zh-Hans.po`) that shows the same Chinese texts as before; the player picks the interface language.
- Needs Vestra Player 0.4.3 or later (translated plugin texts).

## 0.3.0

- The plugin id is now `zysilm.youtube`, author zysilm. It is a third-party plugin hosted in the Vestra Player plugin repository, not an official plugin; features are unchanged.
- The old id `vestra.youtube` is no longer published; an installed old version must be uninstalled and the new one installed.

## 0.2.0

- The plugin id is now `vestra.youtube`, installed from the Vestra Player plugin repository.
- Needs Vestra Player 0.2.0 or later.

## 0.1.1

- First release: paste a link to play or download a single public YouTube video.
