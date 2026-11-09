# Clip Export

Cuts part of the local video you are playing into a new file. Everything lives in one sidebar tab, **Clip Export**, with three pages: Clip, Results and Settings. The tab remembers the page shown last.

## Features

- **Clip page**: **Fast** copies the streams (lossless, about as fast as the disk, from the keyframe at or before the start: the small timeline marks it with its time) or **Precise** re-encodes an MP4 from the exact frame; the ⓘ beside them explains both. Start and End (typed as `1:02:03.450` or seconds, or set with **Now**), **Use A-B range**, **Last N s**, **Export** and **Export As…**. **Advanced** (closed until opened) holds the audio track, the quality (Same as source, High quality, Small file, or resolution, frame rate, quality number, speed and audio bitrate), video effects and burned-in subtitles. While a clip exports, its progress (percentage, time left) shows at the top of the page; the clip's range shows on the seek bar while the tab is in front.
- **Results page**: running and queued exports with Cancel, failed ones with Retry, and the last twenty finished clips (kept across restarts) with Open, Show in Folder and Remove. What finishes while another page is in front is counted on the Results sub-tab.
- **Settings page**: the clip folder (your Videos folder at first), or beside the video when possible; the file-name template (`{name}`, `{start}`, `{end}`, `{date}`, `{time}`, `{n}`; by default `{name}_{start}-{end}`); the Last N s length (10, 30, 60 or 120 seconds).
- The "Clip exported" message has two buttons: Show in Folder and Show in Tab. Existing files are never overwritten: a number is added.

## Commands

Right-click menu: **Video ▸ Export Clip…** opens the tab at its Clip page (with the position and the next 10 seconds when you have not typed a range) and never exports by itself.

In the command palette (Ctrl+Shift+P), all under Export: Export Clip Range (Ctrl+Shift+E, the Export button), Export Last N Seconds (Ctrl+Shift+R), Set Clip Start, Set Clip End, Clip Export Tab (shows or hides the tab; no key by default, set one in the key settings), Export Tasks…, Clip Export Settings…, Clip Folder…, Open Clip Folder, Show Last Clip in Folder.

## Limits

- Clips need a local video file with a known duration; links, streams and pictures made by plugins cannot be cut.
- A Fast cut starts on a keyframe and copies the video and one audio track, no subtitles; files whose codecs cannot be copied need Precise. The player writes MP4 when the streams fit in it, MKV otherwise.
- Precise clips are H.264 + AAC in MP4, encoded on the cores the player can spare (at most half, at below-normal priority).
- Use A-B range needs the A-B loop switched on.
- One export runs at a time; four more can wait in the queue.

## Requirements

Vestra Player 0.7.6 or later, with its FFmpeg (or `ffmpeg` and `ffprobe` on the `PATH`) for the keyframe preview and the thumbnails in Results.

## Translations

Texts are English in the source; `locales/` has Simplified Chinese, German, Spanish, French, Japanese and Korean (`vestra-plugin i18n extract`, `i18n check`).
