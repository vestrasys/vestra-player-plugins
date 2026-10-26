# Changelog

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
