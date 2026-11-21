# Changelog

## 0.1.1

- The description ends with the store's "how to open" line, `→ Menu: Tools ▸ Loudness Meter`, translated: the store shows it on the card and under "Where to find it".
- A store icon (`assets/icon.png`, 256 × 256): a meter dial, its scale from teal (quiet) to amber (loud).

## 0.1.0

- First version: a live EBU R128 loudness meter. Tools ▸ Loudness Meter… opens a window with momentary and short-term loudness (bars, LUFS), integrated loudness, loudness range and the highest true peak, ten updates a second, and Restart. It measures with FFmpeg's `ebur128` filter added to the player's audio chain through the mpv pass-through (`plugin.mpv`, SDK 1.8.0) only while the window is open. Needs Vestra Player 0.9.0 (SDK 1.9.0). Translations: Simplified Chinese, Japanese, Korean, German, French, Spanish.
