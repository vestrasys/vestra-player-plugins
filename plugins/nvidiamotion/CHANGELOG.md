# Changelog

## 0.1.0

- First version: motion smoothing with NVIDIA's frame-rate converter through the player (`plugin.video.motion("nvidia")`, capability `video.motion`): FFmpeg's `fruc_vulkan` on the optical flow hardware of GeForce RTX 30 series and newer GPUs. Video ▸ NVIDIA Motion Smoothing… opens a window with the mode (Off, Double Frame Rate, Match Display), what it does and needs, and a status line with the player's reason when a mode waits or cannot work here. Off by default; the chosen mode is saved and asked for again at each start. Needs Windows with an RTX 30 series or newer GPU and NVIDIA driver 573.38 or newer. A store icon (`assets/icon.png`, 256 × 256): the same ghost trail as AMD Motion Smoothing's, with forward-pointing diamonds in a teal-to-lime gradient. Translations: Simplified Chinese.
