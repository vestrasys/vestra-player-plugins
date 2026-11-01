# Changelog

## 0.1.1

- Crash safety is the player's (0.6.3): after a run that ended abnormally while shaders were drawing, the player refuses them (for the next start; after a second such run within a day, for days) and shows its own OSD line. The window then says "Not running" with the player's message, keeps the choice (still on), says it applies when the player allows shaders again and suggests a preset that is not marked demanding. The plugin does not retry by itself for the rest of the player run, also after its own stop and wake; Turn Off saves off, and Turn On tries once.
- Needs Vestra Player 0.6.3 or later, for that crash guard.
- The heavy presets are marked "demanding" in the drop-downs and the description: Anime4K HQ, modes A+A, B+B and C+A, and ArtCNN C4F32.
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
