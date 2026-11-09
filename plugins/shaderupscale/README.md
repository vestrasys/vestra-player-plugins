# Shader Upscale for Vestra Player

Real-time upscaling of the video on the GPU with mpv shaders bundled in the plugin: **Anime4K** for anime and cartoons, **AMD FSR 1** for everything else, **RAVU** and **FSRCNNX** for live action, and three add-ons, **chroma upscaling**, **SSIM downscaling** and **adaptive sharpening**. The shaders restore, enlarge and sharpen the picture while it plays.

## Usage

Right-click menu **Video ▸ Shader Upscaling…** opens a small window:

- **Upscaler**: *Anime: Anime4K*, *General: AMD FSR 1*, *Live action · Light: RAVU* or *Live action · High: FSRCNNX*. With Anime4K, its **Mode** and **Quality** (below); with FSRCNNX, its **Network** (x2 16 or the lighter x2 8); FSR and RAVU have no settings.
- **Add-ons**: *Chroma*, *Downscale* and *Sharpen*, each on or off, with any upscaler.
- What the chosen preset does and what it suits.
- **Turn On** / **Turn Off**, and a status line: what is applied ("On: AMD FSR 1 + chroma"), that it applies when a video plays, or why it cannot work.

A new choice applies at once while upscaling is on. Everything is remembered; after a restart the shaders are applied again by themselves. The default is Anime4K mode A in its Fast set, with no add-ons.

## Which to choose

| Choice | For | What it does | Cost |
| --- | --- | --- | --- |
| Anime: Anime4K | anime, cartoons, line art | neural networks that restore lines, remove blur and noise, and enlarge the picture | Fast: moderate; HQ, Ultra and the double modes: demanding |
| General: AMD FSR 1 | games, mixed content, anything that is not anime | edge-aware upscaling of the brightness (luma) detail with light sharpening (EASU + RCAS), up to 2× the width and height; mpv's own scaler does the rest | light |
| Live action · Light: RAVU | live action (films, series, camera footage) | RAVU-lite-AR r3: a 2× enlargement of the brightness detail with filters learned from video, and anti-ringing that keeps sharp edges clean; runs when the video is enlarged more than about 1.4× | light |
| Live action · High: FSRCNNX | live action, when the GPU has room | FSRCNNX x2: a small neural network that enlarges the brightness detail 2× and recovers fine detail; runs when the video is enlarged more than 1.3× | x2 8: moderate; x2 16: demanding |
| Add-on: Chroma | most videos (4:2:0 colour, as almost every film, stream and broadcast) | rebuilds the colour planes, stored at half size, from the brightness detail: sharper colour edges, less colour bleeding | light |
| Add-on: Downscale | videos larger than the window (4K in a smaller window) | SSimDownscaler: keeps detail and contrast when mpv makes the picture smaller; does nothing when the video is enlarged | light to moderate |
| Add-on: Sharpen | soft-looking pictures | sharpens the final picture at window size while limiting halos (adaptive-sharpen) | light to moderate (window size) |

FSR, RAVU and FSRCNNX all enlarge the brightness plane 2×: they are one choice, so only one of them runs.

### Anime4K

Anime4K's six modes, exactly as its own mpv templates define them. Each runs up to seven shaders: a highlight clamp, restore and upscale networks, and two passes that keep the result from overshooting the window.

| Mode | For | Effect |
| --- | --- | --- |
| A | most 1080p anime; blurry older or SD anime | restores lines, removes blur, noise and compression smear; can strengthen ringing or banding already there |
| B | most 720p anime; anime downscaled from 1080p | a softer restore that also reduces ringing and aliasing |
| C | clean sources with little blur | upscales with denoising; closest to the source |
| A+A, B+B, C+A | the same as A, B, C | a second restore pass: sharper, but more artefacts; only when the video is enlarged 2× or more |

**Quality**: **Fast** (the default) runs the smaller networks (M and S) and suits most GPUs; **HQ** runs the large ones (VL and M), about four times the work, for fast GPUs; **Ultra** runs the largest (UL and M), about twice the work of HQ, for the fastest GPUs. Upstream has no template of its own for the UL networks: Ultra is the High-end template with UL in place of VL, as Anime4K's instructions allow.

**The Restore steps can lose detail.** Modes A and B (and the double modes) run Anime4K's restore networks, which are trained to remove blur and noise from line art. They can also flatten fine texture, film grain and small background detail, and can make live action look painted. Mode C, without a restore step, stays closest to the source; for live action, choose RAVU or FSRCNNX.

### How the add-ons combine

- **Chroma** works on the colour planes. With Anime4K it runs first, and Anime4K then works on the picture with the improved colour. With FSR, RAVU and FSRCNNX, which enlarge only the brightness plane, the colour is predicted at their enlarged size from their result. It does nothing for 4:4:4 and RGB video, whose colour is already at full size.
- **Downscale** runs after mpv's scaler, only when the picture ends up smaller than the video. It is off by default; it is tuned for mpv's `linear-downscaling=no`.
- **Sharpen** runs last, on the final picture at window size. FSR already sharpens a little (RCAS) and Anime4K's restore modes sharpen lines, so with them Sharpen adds to that: on clean sources it can bring out halos or noise. It is most useful with FSR on soft live action, or to taste.

## Requirements

- Vestra Player 0.6.3 or later (its crash guard for shaders, below).
- **GPU rendering only.** Shaders run only where the player draws the picture on the GPU: on macOS always, on Windows after **Video ▸ GPU Rendering (Experimental)** and a restart. The player's CPU (software) rendering cannot run shaders at all: with it (the Windows default, and Linux) the window greys the button out and says what to do.
- A capable GPU for the presets marked **demanding** (Anime4K HQ and Ultra, modes A+A, B+B and C+A, and FSRCNNX x2 16): they cost several times what the others do. If playback stutters, choose a preset that is not marked demanding, FSR or RAVU.

## If the player crashes while shaders run

The player itself guards against shaders that crash it or lose the GPU (Vestra Player 0.6.3 and later). After a run that ended abnormally while plugin shaders were drawing, it does not run plugin shaders at the next start and shows one OSD line; after two such runs within a day it keeps them off until the GPU, the driver or the player changes, or for 7 days. A normal quit never counts.

While the player refuses, shader upscaling keeps your choice and the window says "Not running: the player ended abnormally while shaders were drawing", with the player's own message, which says for how long. Your choice applies when the player allows shaders again; consider a preset that is not marked demanding. The plugin does not try again by itself during that player run, also not for a new video or preset. **Turn Off** saves off, so the next start runs no shaders; Turn On tries once more, which the player refuses for the rest of that run.

## Limits

- Shaders act while the picture is drawn: exported videos and pictures do not contain them.
- The player runs at most 16 shaders from all plugins together. Anime4K uses up to seven, FSR, RAVU and FSRCNNX one each, and each add-on one (at most ten). When other plugins leave no room, the status says so.
- When a shader does not compile, the player cannot tell whose it was while other plugins add shaders too; the status shows the compiler's message.
- Turned off, the plugin holds nothing and the player may stop it while idle; on, its shaders keep it running.
- RAVU ships in two upstream variants: on Windows the one whose lookup texture is `rgba16hf` (mpv's Direct3D 11 renderer has no `rgba16f`), elsewhere the master branch's. The plugin picks the one for the system it runs on.

The plugin follows the player's interface language (English and Simplified Chinese).

## Not included (yet)

- **ArtCNN**, **NVIDIA Image Scaling (NIS)** and **Snapdragon Game Super Resolution (SGSR)**: their mpv ports use compute shaders, shader parameters (`//!PARAM`) or mpv's gpu-next renderer. The player draws with mpv's vo_gpu, and macOS has OpenGL 4.1, which has no compute shaders. They are candidates for a later version.
- **KrigBilateral** chroma upscaling and **NNEDI3**: not offered; chroma stays CfL Lite.
- Your own shader files: the plugin runs only the shaders bundled with it.

## Shaders and licences

The plugin's code is Apache-2.0. The shaders are third-party files under their own licences, shipped as separate files exactly as upstream published them (except CfL, below). Each keeps its copyright and licence notice in its header. The package includes the licence texts: `shaders/<name>/LICENSE` for the permissive ones, and, next to every LGPL-3.0 shader, the full GNU Lesser General Public License v3 (`COPYING.LESSER`) and the GNU General Public License v3 it supplements (`COPYING`). `shaders/SOURCES.txt` names, for every shader, the upstream repository, commit, path (or release asset) and SHA-256.

- [Anime4K](https://github.com/bloc97/Anime4K) v4.0.1, © 2019–2021 bloc97, MIT; `Anime4K_AutoDownscalePre_x2.glsl` and `_x4.glsl` are under the Unlicense (public domain). Unchanged, including the UL networks for Ultra. The mode presets follow Anime4K's mpv templates from its master branch (the v4.0.1 tag does not contain them).
- AMD FidelityFX Super Resolution 1.0.2 ([FidelityFX-FSR](https://github.com/GPUOpen-Effects/FidelityFX-FSR)), © 2021 Advanced Micro Devices, Inc., MIT; the [mpv port by agyild](https://gist.github.com/agyild/82219c545228d70c5604f865ce0b0ce5). Unchanged.
- [RAVU](https://github.com/bjin/mpv-prescalers) (RAVU-lite-AR r3, the `gather/` variants of the `rgba16hf` and `master` branches) by bjin, LGPL-3.0-or-later. Unchanged.
- [FSRCNNX](https://github.com/igv/FSRCNN-TensorFlow) x2 16 and x2 8 (release 1.1), © 2017–2021 igv, LGPL-3.0-or-later. Unchanged.
- [SSimDownscaler](https://gist.github.com/igv/36508af3ffc84410fe39761d6969be10) by igv, LGPL-3.0-or-later. Unchanged.
- [Chroma from Luma Prediction](https://github.com/Artoriuz/glsl-chroma-from-luma-prediction) (Lite), © 2023 João Chrisóstomo (Artoriuz), MIT, including the 2026-08 fix for blue artefacts. **Modified**, syntax only, so that it compiles on macOS's OpenGL 4.1; the computation is unchanged (the file and `SOURCES.txt` say what changed).
- Adaptive sharpen by bacondither, © 2015–2021, BSD-2-Clause; the [mpv port by igv](https://gist.github.com/igv/8a77e4eb8276753b54bb94c1c50c317e). Unchanged.
