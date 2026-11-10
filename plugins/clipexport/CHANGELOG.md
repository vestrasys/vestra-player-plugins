# Changelog

## 0.2.1

**Who must change: nobody.** Two fixes of 0.2.0; still Vestra Player 0.7.7 or later.

- **Start and End belong to the file they were set on.** A new file (opened, from the playlist, or a part's double-click) no longer shows the last file's range (for example the same 0:20–0:29 on every video): its fields are empty until you set marks, as cut points are per file in LosslessCut. A part's double-click marks that part. Export Clip… fills the new file's position → +10 s; Add Range to Collection and Export Clip Range by key refuse with the reason when this file has no marks.
- **End is visible again** beside the time fields on the Collection page: the fields no longer ask for the std field's 160 px each (two of them pushed End out of the 317 px tab). The Clip page's Now buttons fit at the narrowest tab too.

## 0.2.0

**Who must change: nobody.** Needs Vestra Player 0.7.6 or later (remembered files and exports of several parts, SDK 1.7.8); the install asks for two more permissions, `media.sources` (remember the videos you add) and `playback.control` (play a part on double-click).

- **Collection page** (Clip · Collection · Results · Settings): collect ranges from several local files and export them as one merged video. **Add to Collection** takes the Clip page's Start and End of the file playing; the **Collection** button on the Clip page does the same. Rows with number, thumbnail (captured at the part's start while its file plays), file and range; drag a row to reorder, ✕ or Delete to remove, double-click to play the part, **Clear** with Undo on the message.
- **Export Merged** / **Export As…**: Fast copies the parts when the files match, otherwise one line says what differs ("Fast: part 2 is 1920×818, part 1 is 3840×1714") and Precise re-encodes to the first part's size and frame rate with the Clip page's quality settings. The same queue, progress card (with the part being written and ticks at the joins), Results row and "Clip exported" message as a clip.
- A part whose file was moved or changed says so on its row with **Locate…** (the player's file dialog); a red line says which part stops the export, and Export stays greyed until it is located or removed. The list is kept across restarts.
- Commands (Export): Add Range to Collection, Show Collection, Export Collection, Clear Collection, Undo Clear Collection, Remove from Collection (Delete in the list). No new default keys.
- The Now buttons show the keys of Set Clip Start / End when you bind them. Settings has a second file-name template, **Collection** (`{name}_collection_{date}`).
- Export As… (Clip page and Collection): the file name gets the extension of what is written; Precise is always `.mp4`, even when `.mkv` was typed (before, a Precise clip could be an MP4 named `.mkv`).
- The page shown last is kept by name; the one from 0.1.x is kept.

## 0.1.1

- Store icon.

## 0.1.0

- First release. Clip export moves out of the player's built-in Snapshot plugin into this store plugin; snapshots and bursts stay in the player. Nothing to migrate: the player with the old Capture tab was never released.
- One sidebar tab, **Clip Export**, with Clip, Results and Settings pages. **Video ▸ Export Clip…** opens it.
- **Fast** (stream copy from the keyframe at or before the start, MP4 or MKV) and **Precise** (re-encoded H.264 + AAC MP4 from the exact frame) exports, with a keyframe preview on a small timeline and size and time estimates.
- Range by typing, **Now**, **Use A-B range**, or **Last N s** (10, 30, 60 or 120 seconds, Ctrl+Shift+R); Export Clip Range is Ctrl+Shift+E.
- **Advanced**: audio track, quality presets (Same as source, High quality, Small file) or your own resolution, frame rate, quality number, speed and audio bitrate; video effects and burned-in subtitles (Precise).
- The clip's range on the seek bar while the tab is in front; the running export's progress and time left; one running and four queued exports; Retry keeps a failed export's input for five minutes.
- **Results**: the last twenty clips, kept across restarts, with thumbnails, Open, Show in Folder and Remove. The "Clip exported" message has Show in Folder and Show in Tab buttons.
- **Settings**: the clip folder (Videos by default) or beside the video, the file-name template, the Last N s length.
- English, Simplified Chinese, German, Spanish, French, Japanese and Korean.
- Needs Vestra Player 0.7.6 or later.
