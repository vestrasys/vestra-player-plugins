# VestraTube

Plays or downloads a single public YouTube video in Vestra Player.

## Usage

Right-click menu **Open → VestraTube…**, then paste a link:

- press Enter or **Play** to play it directly;
- **Download Video…** asks where to save it and downloads it as an `.mkv` file.

Typing a YouTube link into the playlist or **Open** also plays it. Supported links: watch, shorts, live, embed and youtu.be; a playlist parameter in the link is ignored.

The plugin follows the player's interface language (English and Simplified Chinese).

## Requirements

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) `2026.08.19` on the PATH (or set the environment variable `VESTRA_YT_DLP` to it);
- downloads also need [ffmpeg](https://ffmpeg.org/) on the PATH;
- Vestra Player 0.4.3 or later.

The plugin does not install or update either program.

## Limits

- Videos that need a sign-in, membership or payment, region-locked videos and DRM videos are not supported, and browser cookies are never read; in these cases the window shows the reason yt-dlp gives.
- Whole playlists are not supported.
