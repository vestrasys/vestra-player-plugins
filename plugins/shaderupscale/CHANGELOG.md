# Changelog

## 0.3.0

- Two upscalers for live action next to AMD FSR 1: **Live action · Light: RAVU** (RAVU-lite-AR r3, bjin's mpv-prescalers) and **Live action · High: FSRCNNX** (igv's FSRCNNX x2), whose new **Network** row chooses x2 16 (the default, marked demanding) or the lighter x2 8. Like FSR they enlarge the brightness plane 2×, so only one of the three runs; the chroma add-on stays CfL Lite and predicts the colour from their result.
- Anime4K's **Quality** gains **Ultra** (demanding): the UL networks for the first steps, M for the last (the High-end template with UL in place of VL), about twice HQ's work.
- A third add-on, **Downscale** (igv's SSimDownscaler), off by default: keeps detail and contrast when the video is larger than the window. At most ten shaders run (Anime4K's longest chain with the three add-ons).
- RAVU's file depends on the system: on Windows the `rgba16hf` branch's (mpv's Direct3D 11 renderer has no `rgba16f`), elsewhere the master branch's. All new shaders are fragment shaders, without `COMPUTE` headers or `PARAM` headers, for macOS's OpenGL 4.1.
- RAVU, FSRCNNX and SSimDownscaler are LGPL-3.0-or-later. They ship unchanged as separate files, each directory with the full LGPL-3.0 (`COPYING.LESSER`) and GPL-3.0 (`COPYING`) texts; `shaders/SOURCES.txt` now has a record per shader (repository, commit, path or release asset, SHA-256, licence), except the modified CfL, documented in SOURCES.txt.
- In Simplified Chinese the preset name joins the add-ons with "＋" without spaces ("AMD FSR 1＋色度＋锐化"), so the longest one still fits the OSD line.
- Settings saved by 0.2.x and earlier are kept, with FSRCNNX x2 16 for when it is chosen and the downscale add-on off.

## 0.2.1

- The window's status line wraps instead of being cut off: with Anime4K and both add-ons it read "On: Anime4K mode A (Fast) + chroma + sh…" at the window's width. The whole state now shows on two lines (the longest, "On: Anime4K mode A+A (HQ) + chroma + sharpen", in English and Simplified Chinese), and so does the longer "Not running" reason; the window grows with it. The OSD line is unchanged.

## 0.2.0

- A second upscaler, **General: AMD FSR 1** (FidelityFX Super Resolution 1.0.2, EASU + RCAS, agyild's mpv port, MIT): for live action, games and anything that is not anime; light on the GPU. The window's first drop-down, **Upscaler**, now chooses between it and **Anime: Anime4K**; FSR has no Mode or Quality rows.
- Two add-ons, **Chroma** and **Sharpen**, each a check box that works with either upscaler: chroma from luma prediction (Artoriuz's CfL Lite, MIT, with the 2026-08 fix for blue artefacts) rebuilds the half-size colour planes (before Anime4K; with FSR, from FSR's enlarged luma); adaptive sharpen (bacondither, igv's mpv port, BSD-2-Clause) sharpens the final picture. The status and the OSD name them ("On: AMD FSR 1 + chroma + sharpen"). At most nine shaders run (Anime4K's longest chain with both add-ons).
- CfL Lite is changed in syntax only so that it compiles with macOS's OpenGL 4.1 (no initializer lists, no arrays of arrays); the file and `shaders/SOURCES.txt` say so. The other shaders are unchanged. None uses compute shaders or `PARAM` headers.
- Anime4K's description says that its restore steps can also remove fine detail and texture; the README says when to prefer mode C or FSR. Anime4K mode A, Fast, stays the default.
- Settings saved by 0.1.x are kept, with both add-ons off.
- The README lists what each choice is for, how the add-ons combine with the upscalers, the licences, and the shaders not included yet (ArtCNN, NIS, SGSR).

## 0.1.1

- Anime4K only: ArtCNN is removed. Its shaders need mpv's gpu-next renderer, which the player does not use yet; with the player's renderer they cost GPU time without taking effect, and took about a minute to compile. A saved ArtCNN choice becomes Anime4K mode A (Fast), with on/off kept. The Model drop-down is hidden while Anime4K is the only model.
- Crash safety is the player's (0.6.3): after a run that ended abnormally while shaders were drawing, the player refuses them (for the next start; after a second such run within a day, for days) and shows its own OSD line. The window then says "Not running" with the player's message, keeps the choice (still on), says it applies when the player allows shaders again and suggests a preset that is not marked demanding. The plugin does not retry by itself for the rest of the player run, also after its own stop and wake; Turn Off saves off, and Turn On tries once.
- Needs Vestra Player 0.6.3 or later, for that crash guard.
- The heavy presets are marked "demanding" in the drop-downs and the description: Anime4K HQ, and modes A+A, B+B and C+A.
- The window's height follows its content, so the Close button no longer stretches when the status text fills in after the window opens.

## 0.1.0

- First release: Video ▸ Shader Upscaling… opens a window to choose the model and its parameters, turn shader upscaling on and off, and see what is applied. No other menu items.
- Anime4K 4.0.1 (MIT; its two AutoDownscalePre passes under the Unlicense): modes A, B, C, A+A, B+B and C+A, each Fast or HQ, as Anime4K's own mpv templates define them.
- ArtCNN (MIT): C4F16 or C4F32, Neutral, Denoise and sharpen, or Denoise and soften.
- The shaders ship in the package with their licence texts; nothing is downloaded.
- Remembers the model, each model's parameters and on/off; applied again at every start.
- Needs GPU rendering: with software rendering the button is greyed out with what to do (turn on Video ▸ GPU Rendering (Experimental) and restart, just restart, or that GPU rendering cannot be turned on here). ArtCNN uses compute shaders and is greyed out on macOS.
- The status line says when other plugins leave no room for the shaders (16 at most) and when a shader does not compile.
- English and Simplified Chinese.
- Needs Vestra Player 0.6.0 or later.
