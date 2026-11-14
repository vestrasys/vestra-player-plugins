# Changelog

## 0.1.0

- First release: **Playback ▸ Skip Silence** skips the silent stretches of a local video or audio file while it plays (off by default, remembered).
- Silences are found with the player's FFmpeg (`silencedetect`), two minutes at a time from the playhead, and skipped with a seek; the playback speed is left alone. 0.15 s of each pause is kept at either end, a pause at the very end of the file is played.
- The silences show on the seek bar as ranges (the 100 longest), and each skip shows on the video the time saved in this playthrough (a replay counts from 0:00).
- **Options ▸ Playback ▸ Silence Skipper**: the level under which sound is silence (−60 to −20 dB, default −35 dB) and the shortest pause skipped (0.5 to 5 s, default 1 s).
- English, German, Spanish, French, Japanese, Korean and Simplified Chinese.
