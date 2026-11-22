# Changelog

## 0.1.3

**Who must change: nobody.** Needs Vestra Player 0.11.0 or later (SDK 1.11.0). Settings and the per-file cache carry over.

- Learns of a new file from the player's source events (a source opening, a source ready) instead of following every change of the player's state. The events start the plugin again when the player has stopped it while idle.
- The crop chain is made at the first crop. A run that crops nothing (no file with a border, Auto-Frame Videos off, the full picture shown) holds nothing, so the player may stop it while idle. Started again in the same player run on the file it already framed, it carries on without reading the file again, and "Auto Frame needs ffmpeg, which was not found" is still said once per player run.
- What is cropped, when, the menu and the messages are unchanged.

## 0.1.2

- The description ends with the store's "how to open" line, `→ Automatic; Menu: Video ▸ Auto Frame`, translated: the store shows it on the card and under "Where to find it".

## 0.1.1

- Needs Vestra Player 0.9.0 or later (SDK 1.9.0): the manifest no longer lists `capabilities`; `activate` starts with `plugin.player.subscribe()` and `await plugin.player.read()`, which the declarations used to imply. Nothing else changes.

## 0.1.0

- First release: when a local video's picture sits in a solid-colour border (any colour), Auto Frame finds the picture in eight sampled keyframes and crops the video to it with the player's crop, exactly to the pixel. The answer is cached per file (path, size and modification time).
- Crops only when the border is on both axes (the picture is under 95 % of the video's width and of its height); a letterboxed (bars above and below) or pillarboxed (bars at the sides) film is left as it is, and Detect Again says so.
- Not cropped either when the picture moves between the sampled frames (slides, screen recordings or animations on a plain background): each edge of the box must be reached by at least half of the frames. A size near a usual one grows by up to 1 % but shrinks by at most 4 pixels, so no real picture is cut.
- While a crop is on, the size the player shows is checked every second; when Crop/Stretch or a rotation changes the picture later, the crop is undone with a note.
- Video ▸ Auto Frame: **Auto-Frame Videos** (on by default, remembered), **Detect Again**, **Show Full Picture for This File** (remembered per file).
- A note on the video when it crops ("Auto-framed to 2560×1440"), when the picture's shape cannot be cropped to, and when Crop/Stretch or a rotation changes the picture (no crop, or the crop is undone).
- English and Simplified Chinese.
- Needs Vestra Player 0.4.3 or later.
