# RTX Upscale for Vestra Player

AI upscaling for Vestra Player with NVIDIA RTX Video Super Resolution: the NVIDIA GPU sharpens and enlarges the video to the size it is shown at.

## Usage

Right-click menu **Video ▸ AI Upscaling (RTX Video Super Resolution)**: pick it to turn upscaling on (checked) or off.

- The first time you turn it on, a note on the video reminds you of the NVIDIA app switch (below).
- Your choice is remembered: after a restart, upscaling is turned on again when the first video plays. Audio files do not count, nor do their PNG, BMP, WebP, TIFF or GIF cover pictures; JPEG cover art still counts as video, because the player does not yet say which track is cover art.
- A video already shown at its own size or smaller is not upscaled; the player follows window and video size changes by itself.
- Upscaling needs the video decoded on the GPU. While it is not, upscaling waits and starts by itself once it is: when another plugin's video filter needs the picture in memory (for example a picture adjustment such as brightness), when hardware decoding is off, or for a video decoded in software (a cover picture, a format the GPU cannot decode). The message says which.

## The AI Upscaling window

**Video ▸ AI Upscaling…** opens a window with one button that turns upscaling on or off, and what the player reports while it is open, updated live:

- whether upscaling is on, and whether the player asked the GPU to upscale now, waits, or cannot work here, and why;
- the video's size, the size it is upscaled to and the scale factor, the video area, the GPU, the decoder (`d3d11va`, `d3d11va-copy`, software) and whether the upscaler is in the player's filter chain;
- when other plugins' video filters hold upscaling back, their names (as the player reports them) and what to do there. For the built-in Picture Adjustments, that is **Video ▸ Reset** (key **Q**) and turning off its other video effects. The plugin never changes another plugin's settings itself.

The window listens to the player only while it is open, and the player reports changes only while upscaling is on: while it is off, the window shows what it read when it opened. Nothing in it can show whether the driver really upscales (see below).

The plugin follows the player's interface language (English and Simplified Chinese).

## Turn on Super Resolution in the NVIDIA app

Upscaling only happens when **NVIDIA app ▸ System ▸ Video ▸ RTX Video Enhancement ▸ Super Resolution** is on (it is off by default). No program can read that switch, so the player cannot tell you whether it is on. Turning on the NVIDIA app's status indicator there shows "RTX VSR" on the picture while it works.

## Requirements

- Vestra Player 0.6.0 or later.
- Windows with an NVIDIA RTX GPU and NVIDIA driver 530 or newer.
- **GPU rendering**: Video ▸ GPU Rendering (Experimental), then restart the player.
- On a laptop with two GPUs, the player must run on the NVIDIA GPU: in **Windows Settings ▸ System ▸ Display ▸ Graphics**, choose the high-performance GPU for Vestra Player, then restart it.

## When the item is greyed out

- **macOS and Linux**: greyed out from the start; the player has no video upscaler there.
- **Windows**: greyed out with the reason once the player has checked the GPU (the first time you pick the item): no NVIDIA RTX GPU, an old driver, software rendering, or the player running on the other GPU. For software rendering the reason says what to do: turn on GPU Rendering and restart; just restart when GPU rendering is already chosen or stopped during this run; or that GPU rendering cannot be turned on on this computer (with the player's explanation). While GPU rendering is still starting, the item stays usable.
- If you turned upscaling on earlier and it cannot work at a start, the item stays checked so you can turn it off, and a note on the video says why (once per reason, not at every start).

## Limits

- On Windows, checking whether the GPU can upscale wakes a sleeping NVIDIA GPU, so the plugin asks the player only when you first pick the item, or, once you turned upscaling on, when the first video plays. Nothing is checked while the player starts.
- The driver gives no sign that it upscales; the player only knows that it asked for it (the window's "In the filter chain"). The quality level is chosen in the NVIDIA app, not in the player.
- Upscaling uses the NVIDIA GPU: power use and heat go up.

NVIDIA and RTX are trademarks of NVIDIA Corporation. This plugin uses RTX Video Super Resolution through the driver; it is not made or endorsed by NVIDIA.
