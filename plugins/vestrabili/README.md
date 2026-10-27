# VestraBili

Plays a single Bilibili video in Vestra Player.

## Usage

Right-click menu **Open → VestraBili…**, paste a link, then press Enter or **Play**.

Typing a Bilibili link into the playlist or **Open** also plays it. Supported links: video pages by BV or av number, and b23.tv short links.

The plugin follows the player's interface language (English and Simplified Chinese).

## yt-dlp

VestraBili reads Bilibili pages with [yt-dlp](https://github.com/yt-dlp/yt-dlp). You don't need to install it:

- The first time you play a link, VestraBili asks whether to download yt-dlp (about 20–40 MB, depending on the system). Nothing is downloaded before you agree. If you decline, links fail with a note; pressing **Play** in the VestraBili window asks again.
- yt-dlp comes only from the official GitHub releases of the yt-dlp project (`github.com/yt-dlp/yt-dlp/releases`), the standalone build for your system. VestraBili checks the release's `SHA2-256SUMS` against the yt-dlp project's OpenPGP signing key (fingerprint `AC0C BBE6 848D 6A87 3464 AF4E 57CF 6593 3B5A 7581`, pinned in the plugin) and the file against that checksum. A file that fails either check is discarded and never run.
- It is kept in VestraBili's data directory and checked for a newer release at most once a day in the background, and when a link fails in a way a newer yt-dlp may fix (then the link is tried once more). Updates go through the same checks.
- Your own yt-dlp is used instead when the environment variable `VESTRA_YTDLP` names it, or when `yt-dlp` is on the PATH and VestraBili has not downloaded its own copy. VestraBili never updates a yt-dlp it did not download.
- Downloads honour `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`; yt-dlp itself does too.

yt-dlp is released into the public domain ([Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE)). It is not part of VestraBili and is not redistributed with it; each user's player downloads it from the yt-dlp project.

## Requirements

- Vestra Player 0.4.3 or later.
- An internet connection to GitHub for the first download (or your own yt-dlp, see above).

## Limits

Videos that need a sign-in or a premium membership, bangumi (anime and series), live streams and collections are not supported.
