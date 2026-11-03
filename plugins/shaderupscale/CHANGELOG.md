# Changelog

## 0.2.0

- A second upscaler, **General: AMD FSR 1** (FidelityFX Super Resolution 1.0.2, EASU + RCAS, agyild's mpv port, MIT): for live action, games and anything that is not anime; light on the GPU. The window's first drop-down, **Upscaler**, now chooses between it and **Anime: Anime4K**; FSR has no Mode or Quality rows.
- Two add-ons, **Chroma** and **Sharpen**, each a check box that works with either upscaler: chroma from luma prediction (Artoriuz's CfL Lite, MIT, with the 2026-08 fix for blue artefacts) rebuilds the half-size colour planes before the upscaler; adaptive sharpen (bacondither, igv's mpv port, BSD-2-Clause) sharpens the final picture. The status and the OSD name them ("On: AMD FSR 1 + chroma + sharpen"). At most nine shaders run (Anime4K's longest chain with both add-ons).
- CfL Lite is changed in syntax only so that it compiles with macOS's OpenGL 4.1 (no initializer lists, no arrays of arrays); the file and `shaders/SOURCES.txt` say so. The other shaders are unchanged. None uses compute shaders or `//!PARAM`.
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
