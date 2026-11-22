# Changelog

## 0.1.3

- While the window is open and the converter runs, the plugin reads the player's dropped frames every 2 s (`player.stats()`, only then) and, when frames are dropped steadily (one a second or more over 6 s), says so under the status with what helps: GPU rendering or a lower resolution with software rendering; a lower resolution or Double Frame Rate instead of Match Display with GPU rendering. It clears after 6 s without drops. Translated (Simplified Chinese).

## 0.1.2

- The description ends with the store's "how to open" line, `→ Menu: Video ▸ AMD Motion Smoothing`, translated: the store shows it on the card and under "Where to find it".
- A store icon (`assets/icon.png`, 256 × 256): smoother motion as a ghost trail of discs, in a red-to-orange gradient.

## 0.1.1

- Needs Vestra Player 0.9.0 or later (SDK 1.9.0): the manifest no longer lists `capabilities`; the plugin needed no call in its place. Nothing else changes.

## 0.1.0

- First version: motion smoothing with AMD AMF's frame-rate converter through the player (`plugin.video.motion("amd")`, capability `video.motion`, player 0.8.1, SDK 1.7.19). Video ▸ AMD Motion Smoothing… opens a window with the mode (Off, Double Frame Rate, Match Display), what it does and needs, and a status line with the player's reason when a mode waits or cannot work here. Off by default; the chosen mode is saved and asked for again at each start. Needs Windows with an AMD Radeon GPU. Translations: Simplified Chinese.
