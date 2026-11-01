# Changelog

## 0.1.0

- First release: when a local video's picture sits in a solid-colour border (any colour), Auto Frame finds the picture in eight sampled keyframes and crops the video to it with the player's crop, exactly to the pixel. The answer is cached per file (path, size and modification time).
- Video ▸ Auto Frame: **Auto-Frame Videos** (on by default, remembered), **Detect Again**, **Show Full Picture for This File** (remembered per file).
- A note on the video when it crops ("Auto-framed to 2560×1440"), when the picture's shape cannot be cropped to, and when Crop/Stretch or a rotation changes the picture (no crop, or the crop is undone).
- English and Simplified Chinese.
- Needs Vestra Player 0.4.3 or later.
