# Changelog

## 0.1.0

- First release: when a local video's picture sits in a solid-colour border (any colour), Auto Frame finds the picture in eight sampled keyframes and crops the video to it with the player's crop, exactly to the pixel. The answer is cached per file (path, size and modification time).
- Crops only when the border is on both axes (the picture is under 95 % of the video's width and of its height); a letterboxed (bars above and below) or pillarboxed (bars at the sides) film is left as it is, and Detect Again says so.
- Not cropped either when the picture moves between the sampled frames (slides, screen recordings or animations on a plain background): each edge of the box must be reached by at least half of the frames. A size near a usual one grows by up to 1 % but shrinks by at most 4 pixels, so no real picture is cut.
- While a crop is on, the size the player shows is checked every second; when Crop/Stretch or a rotation changes the picture later, the crop is undone with a note.
- Video ▸ Auto Frame: **Auto-Frame Videos** (on by default, remembered), **Detect Again**, **Show Full Picture for This File** (remembered per file).
- A note on the video when it crops ("Auto-framed to 2560×1440"), when the picture's shape cannot be cropped to, and when Crop/Stretch or a rotation changes the picture (no crop, or the crop is undone).
- English and Simplified Chinese.
- Needs Vestra Player 0.4.3 or later.
