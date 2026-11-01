# Shader Upscale for Vestra Player

Real-time upscaling of the video with **Anime4K**, neural-network shaders for mpv bundled in the plugin. The GPU restores lines, removes blur and noise and enlarges the picture while it plays. Anime4K was trained on anime and works best on animation and cartoons.

## Usage

Right-click menu **Video ▸ Shader Upscaling…** opens a small window:

- Anime4K's **Mode** and **Quality** (below).
- What the chosen preset does and what it suits.
- **Turn On** / **Turn Off**, and a status line: what is applied ("On: Anime4K mode A (Fast)"), that it applies when a video plays, or why it cannot work.

A new mode or quality applies at once while upscaling is on. The mode, the quality and on/off are remembered; after a restart the shaders are applied again by themselves.

## Anime4K

Anime4K's six modes, exactly as its own mpv templates define them. Each runs up to seven shaders: a highlight clamp, restore and upscale networks, and two passes that keep the result from overshooting the window.

| Mode | For | Effect |
| --- | --- | --- |
| A | most 1080p anime; blurry older or SD anime | restores lines, removes blur, noise and compression smear; can strengthen ringing or banding already there |
| B | most 720p anime; anime downscaled from 1080p | a softer restore that also reduces ringing and aliasing |
| C | clean sources with little blur | upscales with denoising; closest to the source |
| A+A, B+B, C+A | the same as A, B, C | a second restore pass: sharper, but more artefacts; only when the video is enlarged 2× or more |

**Quality**: **Fast** runs the smaller networks (M and S) and suits most GPUs; **HQ** runs the large ones (VL and M), about four times the work, for fast GPUs.

ArtCNN is not offered: its shaders need mpv's gpu-next renderer, which the player does not use yet. With the player's renderer they cost GPU time without taking effect.

## Requirements

- Vestra Player 0.6.3 or later (its crash guard for shaders, below).
- **GPU rendering.** Shaders run only where the player draws the picture on the GPU: on macOS always, on Windows after **Video ▸ GPU Rendering (Experimental)** and a restart. With software rendering (the Windows default, and Linux) the window greys the button out and says what to do.
- A capable GPU: the presets marked **demanding** (HQ, and modes A+A, B+B and C+A) cost several times what Fast and modes A, B and C do. If playback stutters, choose a preset that is not marked demanding.

## If the player crashes while shaders run

The player itself guards against shaders that crash it or lose the GPU (Vestra Player 0.6.3 and later). After a run that ended abnormally while plugin shaders were drawing, it does not run plugin shaders at the next start and shows one OSD line; after two such runs within a day it keeps them off until the GPU, the driver or the player changes, or for 7 days. A normal quit never counts.

While the player refuses, shader upscaling keeps your choice (on, with your mode and quality) and the window says "Not running: the player ended abnormally while shaders were drawing", with the player's own message, which says for how long. Your choice applies when the player allows shaders again; consider a preset that is not marked demanding. The plugin does not try again by itself during that player run, also not for a new video or preset. **Turn Off** saves off, so the next start runs no shaders; Turn On tries once more, which the player refuses for the rest of that run.

## Limits

- Shaders act while the picture is drawn: exported videos and pictures do not contain them.
- The player runs at most 16 shaders from all plugins together; Anime4K uses up to seven. When other plugins leave no room, the status says so.
- When a shader does not compile, the player cannot tell whose it was while other plugins add shaders too; the status shows the compiler's message.
- Turned off, the plugin holds nothing and the player may stop it while idle; on, its shaders keep it running.

The plugin follows the player's interface language (English and Simplified Chinese).

## Credits and licences

The plugin's code is Apache-2.0. The shaders are redistributed unchanged under their own licences (MIT; the Unlicense for two of Anime4K's), included in the package (`shaders/anime4k/LICENSE`, and `shaders/SOURCES.txt` with versions):

- [Anime4K](https://github.com/bloc97/Anime4K) v4.0.1, © 2019–2021 bloc97, MIT; `Anime4K_AutoDownscalePre_x2.glsl` and `_x4.glsl` are under the Unlicense (public domain). The mode presets follow Anime4K's mpv templates from its master branch (the v4.0.1 tag does not contain them).

FSRCNNX, NNEDI3 and RAVU are not included: their licences (GPL-3.0 and LGPL-3.0) are not ones this repository ships.
