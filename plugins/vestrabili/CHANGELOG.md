# Changelog

## 0.5.0

- yt-dlp no longer has to be installed by hand. On first use VestraBili asks whether to download it; with your consent it fetches the standalone build from the yt-dlp project's official GitHub releases, verifies the release's signed checksums (yt-dlp's OpenPGP key is pinned in the plugin) and the file's SHA-256, and refuses anything that does not verify. It is kept in the plugin's data directory and updated at most once a day, or when a link fails in a way a newer yt-dlp may fix.
- Download progress shows in the VestraBili window, or on the video for links opened from the playlist. Offline, GitHub rate limits, a full disk, a blocked or removed yt-dlp and a cancelled download each get their own message.
- A yt-dlp of your own is still used: `VESTRA_YTDLP`, or `yt-dlp` on the PATH when VestraBili has not downloaded one.
- A video Bilibili refuses in your region (or removed), Bilibili's request limit and sign-in-only videos now get a short sentence of our own; yt-dlp's full words are in the status line's tooltip and the plugin log. A long status no longer runs past the window: it ends with an ellipsis, and the tooltip has the whole text.
- New capabilities: confirmation dialogs (the download question) and messages on the video (download progress).
- New plugin icon.
- yt-dlp is in the public domain (Unlicense) and is not redistributed with VestraBili.

## 0.4.0

- The id is now `zysilm.vestrabili`, matching the plugin name. The store lists it as a new plugin; uninstall the old VestraBili (`zysilm.bilibili`) and install this one. Features are unchanged.

## 0.3.1

- Renamed to **VestraBili** (menu **Open → VestraBili…**, window title, store listing). The id stays `zysilm.bilibili`, so this is an update of the same plugin. Features are unchanged.
- English is now the source language: menus, the window, messages and the store texts are in English, with a Simplified Chinese translation (`locales/zh-Hans.po`) that shows the same Chinese texts as before; the player picks the interface language.
- Needs Vestra Player 0.4.3 or later (translated plugin texts).

## 0.3.0

- The plugin id is now `zysilm.bilibili`, author zysilm. It is a third-party plugin hosted in the Vestra Player plugin repository, not an official plugin; features are unchanged.
- The old id `vestra.bilibili` is no longer published; an installed old version must be uninstalled and the new one installed.

## 0.2.0

- The plugin id is now `vestra.bilibili`, installed from the Vestra Player plugin repository.
- Needs Vestra Player 0.2.0 or later.

## 0.1.0

- First release: paste a link to play a single Bilibili video.
