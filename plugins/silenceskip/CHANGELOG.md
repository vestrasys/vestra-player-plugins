# Changelog

## 0.2.0

- Needs Vestra Player 0.10.0. The plugin no longer follows playback ten times a second: it scans a file when the player says it is ready, and hands the silences to the player, which draws them on the seek bar and starts the plugin 2 s (in media time) before each one. Between silences that are far apart the plugin is stopped and uses no memory.
- A skip waits for the silence's start with one timer and then jumps to its end; a speed change during those 2 s lets that one silence play (the user's action wins), a pause there does not (the resume arms it again). A silence is skipped each time playback enters it, also after the user moved the playhead into it.
- The seek bar shows up to 1000 silences (was 100), the same ones that are skipped; a file with more skips its 1000 longest.
- What a scan found, the time saved and the "ffmpeg not found" note are kept while the player runs, so a restart of the plugin does not read the file again.
- Picking another audio track scans the file again for that track's silences; going back to a track scanned before reads nothing again.
- The time saved starts again from 0:00 when playback skips a silence at or before the last one skipped: a replay, as before, and now also going back in the file. The end of a file no longer starts the plugin.

## 0.1.1

- The description ends with the store's "how to open" line, `→ Menu: Playback ▸ Skip Silence`, translated: the store shows it on the card and under "Where to find it".
- A store icon (`assets/icon.png`, 256 × 256): a jump arrow over the silence between two waveforms.

## 0.1.0

- First release: **Playback ▸ Skip Silence** skips the silent stretches of a local video or audio file while it plays (off by default, remembered).
- Silences are found with the player's FFmpeg (`silencedetect`), two minutes at a time from the playhead, and skipped with a seek; the playback speed is left alone. 0.15 s of each pause is kept at either end, a pause at the very end of the file is played.
- The silences show on the seek bar as ranges (the 100 longest), and each skip shows on the video the time saved in this playthrough (a replay counts from 0:00).
- **Options ▸ Playback ▸ Silence Skipper**: the level under which sound is silence (−60 to −20 dB, default −35 dB) and the shortest pause skipped (0.5 to 5 s, default 1 s).
- English, German, Spanish, French, Japanese, Korean and Simplified Chinese.
