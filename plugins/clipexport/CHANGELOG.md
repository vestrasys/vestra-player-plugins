# Changelog

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
