# Clip Export

Cuts part of the local video you are playing into a new file. Everything lives in one sidebar tab, **Clip Export**, with three pages: Clip, Results and Settings. The tab remembers the page shown last.

## Features

- **Clip page**, top to bottom:
  - **Output**: **Fast** | **Precise**, for the clip and for the merged Collection. Fast copies the streams (lossless, about as fast as the disk, from the keyframe at or before the start: the small timeline marks it with its time); Precise re-encodes an MP4 from the exact frame. The ⓘ beside them explains both. **Advanced** (closed until opened) holds the audio track, the quality (Same as source, High quality, Small file, Animated GIF, Animated WebP, or resolution, frame rate, quality number, speed and audio bitrate), video effects and burned-in subtitles.
  - **Range**: the file playing, Start and End (typed as `1:02:03.450` or seconds, or set with **Now**), **Use A-B range**, **Last N s**, **Export Clip** and **Export As…**. While a clip exports, its progress (percentage, time left) shows at the top of the page; the clip's range shows on the seek bar while the tab is in front.
  - **Collection**: below the Range, see the next point. While it has parts, a footer under the page holds its sum, **Export Merged** and **Export As…**. The highlighted button is the output you are building: Export Clip while the Collection is empty, Export Merged once it has parts.
- **Collection**: gathers ranges from several local files into one list and exports them as **one merged video**. Mark Start and End in any local video and press **+ Add** in the Collection's header; open the next file and add again. Each row shows its number, a thumbnail, the file and the range; drag a row to reorder, ✕ or Delete to remove, double-click to play the part from its start, **Clear** to empty the list (Undo on the message). **Export Merged** saves into the clip folder, **Export As…** where you choose. **Fast** copies the parts when every file has the same codecs, size, frame rate and audio (one line in the footer says what differs otherwise, and the merge uses Precise); **Precise** re-encodes every part to the first part's size and frame rate, with black bars for other sizes and the sound at 48 kHz stereo, using the quality settings under Advanced. A part whose file was moved or changed says so, with **Locate…**; Export stays greyed until it is located or removed. The list is kept across restarts; an export works on the list as it was when it started.
- **Transitions** (Collection): each junction between two parts has a chip, Cut by default. Click it to pick Cut, Crossfade, Fade through black, Fade through white, Wipe or Slide (with a direction), and a length of 0.5–2 s or typed (at most half of the shorter part); **Apply to All** uses it for every junction and for new parts (Undo on the message). The parts overlap by each transition, so the video gets shorter by it; the sound follows the picture. Transitions need **Precise**: picking one while Fast would join the parts switches to Precise, and the footer says so (picking Cut keeps Fast). Choosing Fast again keeps the transitions, greyed, and the export joins with cuts. A Precise export with transitions first merges the parts, then writes the transitions with the player's FFmpeg; it takes a little longer than a plain merge.
- **Animated GIF and WebP** (Precise, the Quality choice under Advanced): the clip or the merged Collection as a looping image without sound. GIF is at most 480 px on its longer side at 15 fps, with one 256-colour palette made from the clip and ordered dithering; WebP is at most 640 px at 20 fps (libwebp, quality 75), about a third of the GIF's size. While one of them is chosen, a line under Quality says what it writes (`GIF · 480 px long edge · 15 fps · up to 60 s`). Smaller videos are not enlarged. Video effects, burned-in subtitles and the Collection's transitions are in the image as in a Precise MP4. An image is at most 60 seconds long: a longer range is refused before anything starts. The player writes an MP4 into the plugin's data folder first; then the player's FFmpeg writes the image beside the destination. If that FFmpeg has no WebP encoder, Animated WebP says so and Animated GIF still works.
- **Results page**: running and queued exports with Cancel, failed ones with Retry, and the last twenty finished clips (kept across restarts) with Open, Show in Folder and Remove. What finishes while another page is in front is counted on the Results sub-tab.
- **Settings page**: the clip folder (your Videos folder at first), or beside the video when possible; the file-name templates (`{name}`, `{start}`, `{end}`, `{date}`, `{time}`, `{n}`; a clip by default `{name}_{start}-{end}`, a merged Collection `{name}_collection_{date}`, where `{name}` is the first part's file); the Last N s length (10, 30, 60 or 120 seconds).
- The "Clip exported" message has two buttons: Show in Folder and Show in Tab. Existing files are never overwritten: a number is added.

## Commands

Right-click menu: **Video ▸ Export Clip…** opens the tab at its Clip page (with the position and the next 10 seconds when you have not typed a range) and never exports by itself.

In the command palette (Ctrl+Shift+P), all under Export: Export Clip Range (Ctrl+Shift+E, the Export button), Export Last N Seconds (Ctrl+Shift+R), Set Clip Start, Set Clip End, Clip Export Tab (shows or hides the tab; no key by default, set one in the key settings), Export Tasks…, Clip Export Settings…, Clip Folder…, Open Clip Folder, Show Last Clip in Folder, Add Range to Collection, Show Collection (the Clip page, with the list in view), Export Collection, Clear Collection, Undo Clear Collection, Remove from Collection (Delete while the list has the focus). Set Clip Start, Set Clip End and Add Range to Collection have no keys by default; set them in the key settings and their buttons show them.

## Limits

- Clips need a local video file with a known duration; links, streams and pictures made by plugins cannot be cut.
- A Fast cut starts on a keyframe and copies the video and one audio track, no subtitles; files whose codecs cannot be copied need Precise. The player writes MP4 when the streams fit in it, MKV otherwise.
- Precise clips are H.264 + AAC in MP4, encoded on the cores the player can spare (at most half, at below-normal priority), or an animated GIF or WebP (no sound, at most 60 s, fixed size and frame rate).
- Use A-B range needs the A-B loop switched on.
- One export runs at a time; four more can wait in the queue.
- Transitions are six kinds; no fade-in or fade-out of the whole video. A Precise export with transitions encodes the joined video once more at the end (the merge before it is written at the best quality), and its work file in the plugin's data folder needs about as much space as the result.
- The Collection takes local files only (not links, streams or pictures made by plugins), at most 100 parts; each part uses its file's default audio track, without video effects or subtitles.

## Requirements

Vestra Player 0.7.6 or later (it remembers the files you add and joins their parts), with its FFmpeg (or `ffmpeg` and `ffprobe` on the `PATH`) for the keyframe preview, the thumbnails in Results, the transitions and the animated GIF and WebP (WebP needs an FFmpeg built with libwebp, as the player's is).

## Translations

Texts are English in the source; `locales/` has Simplified Chinese, German, Spanish, French, Japanese and Korean (`vestra-plugin i18n extract`, `i18n check`).
