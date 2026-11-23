# Changelog

## 0.2.0

- Three commands choose a mode in one step from the command palette and Ask Vestra: *AMD Motion Smoothing: Off*, *Double Frame Rate (Smoother Video)* and *Match Display (Smoothest Motion)*. They are radio items checked on the saved mode (the window's choice moves the mark too), in the category AMD Motion Smoothing with the window as their place, and outside the menus: Video ▸ AMD Motion Smoothing… stays the only menu item. A mode that cannot work on this computer for the whole run (without an AMD Radeon GPU, a missing driver runtime, or Match Display with software rendering) is greyed out with the player's reason, so on a computer with NVIDIA's GPU Ask Vestra sees that this plugin's modes do not work there. The state is read at start, after a choice and while the window is open; nothing listens while it is closed, so the plugin still holds nothing while off. Translated (Simplified Chinese). The description says the palette and Ask Vestra can choose a mode.

## 0.1.3

- While the window is open and the converter runs, the plugin reads the player's dropped frames every 2 s (`player.stats()`, only then) and, when frames are dropped steadily (one a second or more over 6 s, and in at least two readings in a row; the first 6 s after the converter starts, restarts (mode change, fallback step) or a new video are not judged, so its start-up burst and one burst from a seek or a resize do not count), says so under the status with what helps: with software rendering, that rendering on the CPU cannot keep up and GPU Rendering or a lower resolution helps; with GPU rendering a lower resolution, and Double Frame Rate instead of Match Display when Match Display is the mode. It clears after 6 s without drops. Translated (Simplified Chinese).

## 0.1.2

- The description ends with the store's "how to open" line, `→ Menu: Video ▸ AMD Motion Smoothing`, translated: the store shows it on the card and under "Where to find it".
- A store icon (`assets/icon.png`, 256 × 256): smoother motion as a ghost trail of discs, in a red-to-orange gradient.

## 0.1.1

- Needs Vestra Player 0.9.0 or later (SDK 1.9.0): the manifest no longer lists `capabilities`; the plugin needed no call in its place. Nothing else changes.

## 0.1.0

- First version: motion smoothing with AMD AMF's frame-rate converter through the player (`plugin.video.motion("amd")`, capability `video.motion`, player 0.8.1, SDK 1.7.19). Video ▸ AMD Motion Smoothing… opens a window with the mode (Off, Double Frame Rate, Match Display), what it does and needs, and a status line with the player's reason when a mode waits or cannot work here. Off by default; the chosen mode is saved and asked for again at each start. Needs Windows with an AMD Radeon GPU. Translations: Simplified Chinese.
