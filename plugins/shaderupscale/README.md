# Shader Upscale for Vestra Player

Real-time upscaling of the video with neural-network shaders for mpv, bundled in the plugin: **Anime4K** and **ArtCNN**. The GPU restores lines, removes blur and noise and enlarges the picture while it plays. Both models were trained on anime and work best on animation and cartoons.

## Usage

Right-click menu **Video ▸ Shader Upscaling…** opens a small window:

- **Model**: Anime4K or ArtCNN.
- The model's two parameters (below).
- What the chosen preset does and what it suits.
- **Turn On** / **Turn Off**, and a status line: what is applied ("On: Anime4K mode A (Fast)"), that it applies when a video plays, or why it cannot work.

A new model or parameter applies at once while upscaling is on. The model, each model's parameters and on/off are remembered; after a restart the shaders are applied again by themselves.

## The models

### Anime4K

Anime4K's six modes, exactly as its own mpv templates define them. Each runs up to seven shaders: a highlight clamp, restore and upscale networks, and two passes that keep the result from overshooting the window.

| Mode | For | Effect |
| --- | --- | --- |
| A | most 1080p anime; blurry older or SD anime | restores lines, removes blur, noise and compression smear; can strengthen ringing or banding already there |
| B | most 720p anime; anime downscaled from 1080p | a softer restore that also reduces ringing and aliasing |
| C | clean sources with little blur | upscales with denoising; closest to the source |
| A+A, B+B, C+A | the same as A, B, C | a second restore pass: sharper, but more artefacts; only when the video is enlarged 2× or more |

**Quality**: **Fast** runs the smaller networks (M and S) and suits most GPUs; **HQ** runs the large ones (VL and M), about four times the work, for fast GPUs.

### ArtCNN

A small neural network that doubles the brightness (luma) detail once; the player scales the colour.

- **Size**: **C4F16** (light) or **C4F32** (more detail, needs a faster GPU).
- **Variant**: **Neutral**, **Denoise and sharpen**, or **Denoise and soften**.

## Requirements

- Vestra Player 0.6.0 or later.
- **GPU rendering.** Shaders run only where the player draws the picture on the GPU: on macOS always, on Windows after **Video ▸ GPU Rendering (Experimental)** and a restart. With software rendering (the Windows default, and Linux) the window greys the button out and says what to do.
- **ArtCNN needs Windows.** Its shaders are compute shaders, which macOS's OpenGL does not have; on macOS ArtCNN is greyed out. Anime4K runs on both.
- A capable GPU: the presets marked **demanding** (HQ, modes A+A, B+B and C+A, and ArtCNN C4F32) cost several times what Fast and C4F16 do. If playback stutters, choose a preset that is not marked demanding.

## If the player does not close normally

While shaders are applied, the plugin notes so in its data directory and clears the note when it stops normally. If the player crashes or is ended while shader upscaling is on, the next start begins with it **off**: the OSD says "Shader Upscaling turned off: the player did not close normally" and the window says why. Your model and parameters are kept; turn it on again, or first choose a lighter preset. A restart of the plugin alone (a reload, an upgrade) leaves upscaling on.

## Limits

- Shaders act while the picture is drawn: exported videos and pictures do not contain them.
- The player runs at most 16 shaders from all plugins together; Anime4K uses up to seven. When other plugins leave no room, the status says so.
- When a shader does not compile, the player cannot tell whose it was while other plugins add shaders too; the status shows the compiler's message.
- Turned off, the plugin holds nothing and the player may stop it while idle; on, its shaders keep it running.

The plugin follows the player's interface language (English and Simplified Chinese).

## Credits and licences

The plugin's code is Apache-2.0. The shaders are redistributed unchanged under their own MIT licences, included in the package (`shaders/anime4k/LICENSE`, `shaders/artcnn/LICENSE`, and `shaders/SOURCES.txt` with versions):

- [Anime4K](https://github.com/bloc97/Anime4K) v4.0.1, © 2019–2021 bloc97, MIT.
- [ArtCNN](https://github.com/Artoriuz/ArtCNN), © 2024 João Chrisóstomo and Kacper Michajłow, MIT.

FSRCNNX, NNEDI3 and RAVU are not included: their licences (GPL-3.0 and LGPL-3.0) are not ones this repository ships.
