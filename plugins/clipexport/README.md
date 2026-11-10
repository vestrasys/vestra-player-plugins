# Clip Export

Cuts part of the local video you are playing into a new file. Everything lives in one sidebar tab, **Clip Export**, with four pages: Clip, Collection, Results and Settings. The tab remembers the page shown last.

## Features

- **Clip page**: **Fast** copies the streams (lossless, about as fast as the disk, from the keyframe at or before the start: the small timeline marks it with its time) or **Precise** re-encodes an MP4 from the exact frame; the ⓘ beside them explains both. Start and End (typed as `1:02:03.450` or seconds, or set with **Now**), **Use A-B range**, **Last N s**, **Export** and **Export As…**. **Advanced** (closed until opened) holds the audio track, the quality (Same as source, High quality, Small file, or resolution, frame rate, quality number, speed and audio bitrate), video effects and burned-in subtitles. While a clip exports, its progress (percentage, time left) shows at the top of the page; the clip's range shows on the seek bar while the tab is in front.
- **Collection page**: gathers ranges from several local files into one list and exports them as **one merged video**. Mark Start and End in any local video (the same marks as the Clip page) and press **Add to Collection** (or **Collection** on the Clip page); open the next file and add again. Each row shows its number, a thumbnail, the file and the range; drag a row to reorder, ✕ or Delete to remove, double-click to play the part from its start, **Clear** to empty the list (Undo on the message). **Export Merged** saves into the clip folder, **Export As…** where you choose. **Fast** copies the parts when every file has the same codecs, size, frame rate and audio (one line says what differs otherwise); **Precise** re-encodes every part to the first part's size and frame rate, with black bars for other sizes and the sound at 48 kHz stereo, using the Clip page's quality settings. A part whose file was moved or changed says so, with **Locate…**; Export stays greyed until it is located or removed. The list is kept across restarts; an export works on the list as it was when it started.
- **Results page**: running and queued exports with Cancel, failed ones with Retry, and the last twenty finished clips (kept across restarts) with Open, Show in Folder and Remove. What finishes while another page is in front is counted on the Results sub-tab.
- **Settings page**: the clip folder (your Videos folder at first), or beside the video when possible; the file-name templates (`{name}`, `{start}`, `{end}`, `{date}`, `{time}`, `{n}`; a clip by default `{name}_{start}-{end}`, a merged Collection `{name}_collection_{date}`, where `{name}` is the first part's file); the Last N s length (10, 30, 60 or 120 seconds).
- The "Clip exported" message has two buttons: Show in Folder and Show in Tab. Existing files are never overwritten: a number is added.

## Commands

Right-click menu: **Video ▸ Export Clip…** opens the tab at its Clip page (with the position and the next 10 seconds when you have not typed a range) and never exports by itself.

In the command palette (Ctrl+Shift+P), all under Export: Export Clip Range (Ctrl+Shift+E, the Export button), Export Last N Seconds (Ctrl+Shift+R), Set Clip Start, Set Clip End, Clip Export Tab (shows or hides the tab; no key by default, set one in the key settings), Export Tasks…, Clip Export Settings…, Clip Folder…, Open Clip Folder, Show Last Clip in Folder, Add Range to Collection, Show Collection, Export Collection, Clear Collection, Undo Clear Collection, Remove from Collection (Delete while the list has the focus). Set Clip Start, Set Clip End and Add Range to Collection have no keys by default; set them in the key settings and their buttons show them.

## Limits

- Clips need a local video file with a known duration; links, streams and pictures made by plugins cannot be cut.
- A Fast cut starts on a keyframe and copies the video and one audio track, no subtitles; files whose codecs cannot be copied need Precise. The player writes MP4 when the streams fit in it, MKV otherwise.
- Precise clips are H.264 + AAC in MP4, encoded on the cores the player can spare (at most half, at below-normal priority).
- Use A-B range needs the A-B loop switched on.
- One export runs at a time; four more can wait in the queue.
- The Collection takes local files only (not links, streams or pictures made by plugins), at most 100 parts; each part uses its file's default audio track, without video effects or subtitles.

## Requirements

Vestra Player 0.7.6 or later (it remembers the files you add and joins their parts), with its FFmpeg (or `ffmpeg` and `ffprobe` on the `PATH`) for the keyframe preview and the thumbnails in Results.

## Translations

Texts are English in the source; `locales/` has Simplified Chinese, German, Spanish, French, Japanese and Korean (`vestra-plugin i18n extract`, `i18n check`).
