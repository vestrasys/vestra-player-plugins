# VestraTube

Search YouTube in Vestra Player's sidebar and play videos right away, or download them as MKV files. No sign-in, nothing to install.

## Usage

**Open → VestraTube** shows the VestraTube tab in the sidebar.

- Type in the search box and press Enter. The results show a thumbnail, the title, the duration (or LIVE) and the channel; scrolling down near the end loads the next page.
- **Double-click** a video (or select it and press Enter) to play it. The playing video is highlighted; one that cannot play gets a mark and the reason appears on the video.
- **Download…** in the bottom bar (or right-click → **Download…**) saves the selected video as an `.mkv` file; a line above the bottom bar shows the progress, and **Cancel Download** stops it.
- **Open URL…** in the bottom bar, or **Open → YouTube Link…**, opens the link window: paste a link, then **Play**, or **Download Video…**.

Typing a YouTube link into the playlist or the player's Open also plays it. Supported links: watch, shorts, live, embed and youtu.be; a playlist parameter in the link is ignored.

The plugin follows the player's interface language (English and Simplified Chinese).

## Requirements

- Vestra Player 0.5.1 or later;
- a network connection.

Nothing else: the YouTube part is the open-source library [youtubei.js](https://github.com/LuanRT/YouTube.js) (MIT), bundled in the plugin; downloads use the ffmpeg that comes with the player. yt-dlp is no longer used.

## Limits

- Videos are played and downloaded at up to 1080p (H.264 preferred), with the original audio track.
- Videos that need a sign-in, membership or payment, age-restricted, private, region-locked and DRM videos are not supported; YouTube's reason is shown. Live videos play but cannot be downloaded.
- On some networks (VPNs, data centres) YouTube asks to confirm that you are not a bot; the plugin cannot answer that without a sign-in, so try another network.
- YouTube changes often. When playback or search stops working, an update of the plugin (following youtubei.js) usually fixes it.
- A stream link lasts about six hours: a video paused longer than that stops; play it again from the list.
- Whole playlists and channels are not supported.

## Third-party licenses

The package includes youtubei.js (MIT) and its dependencies: meriyah (ISC), fflate (MIT) and @bufbuild/protobuf (Apache-2.0 AND BSD-3-Clause). Their license texts are in `licenses/`.
