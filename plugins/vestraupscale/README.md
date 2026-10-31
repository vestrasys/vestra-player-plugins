# VestraUpscale

AI upscaling for Vestra Player with NVIDIA RTX Video Super Resolution: the NVIDIA GPU sharpens and enlarges the video to the size it is shown at.

## Usage

Right-click menu **Video ▸ AI Upscaling (RTX Video Super Resolution)**: pick it to turn upscaling on (checked) or off.

- The first time you turn it on, a note on the video reminds you of the NVIDIA app switch (below).
- Your choice is remembered: after a restart, upscaling is turned on again when the first video plays (audio files, also with cover art, do not count).
- A video already shown at its own size or smaller is not upscaled; the player follows window and video size changes by itself.
- While another video filter needs the picture in memory (for example a picture adjustment such as brightness), upscaling pauses and comes back when that filter is off.

The plugin follows the player's interface language (English and Simplified Chinese).

## Turn on Super Resolution in the NVIDIA app

Upscaling only happens when **NVIDIA app ▸ System ▸ Video ▸ RTX Video Enhancement ▸ Super Resolution** is on (it is off by default). No program can read that switch, so the player cannot tell you whether it is on. Turning on the NVIDIA app's status indicator there shows "RTX VSR" on the picture while it works.

## Requirements

- Vestra Player 0.5.16 or later.
- Windows with an NVIDIA RTX GPU and NVIDIA driver 530 or newer.
- **GPU rendering**: Video ▸ GPU Rendering (Experimental), then restart the player.
- On a laptop with two GPUs, the player must run on the NVIDIA GPU: in **Windows Settings ▸ System ▸ Display ▸ Graphics**, choose the high-performance GPU for Vestra Player, then restart it.

## When the item is greyed out

- **macOS and Linux**: greyed out from the start; the player has no video upscaler there.
- **Windows**: greyed out with the reason once the player has checked the GPU (the first time you pick the item): no NVIDIA RTX GPU, an old driver, software rendering, or the player running on the other GPU. For software rendering the reason says what to do: turn on GPU Rendering and restart; just restart when GPU rendering is already chosen or stopped during this run; or that GPU rendering cannot be turned on on this computer (with the player's explanation). While GPU rendering is still starting, the item stays usable.
- If you turned upscaling on earlier and it cannot work at a start, the item stays checked so you can turn it off, and a note on the video says why (once per reason, not at every start).

## Limits

- On Windows, checking whether the GPU can upscale wakes a sleeping NVIDIA GPU, so the plugin asks the player only when you first pick the item, or, once you turned upscaling on, when the first video plays. Nothing is checked while the player starts.
- The driver gives no sign that it upscales; the player only knows that it asked for it.
- Upscaling uses the NVIDIA GPU: power use and heat go up.
