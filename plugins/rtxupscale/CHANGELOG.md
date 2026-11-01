# Changelog

## 0.3.0

- **New plugin id `zysilm.rtxupscale`** (was `zysilm.vestraupscale`), with the folder `plugins/rtxupscale`. The store treats it as a new plugin: uninstall the old `zysilm.vestraupscale` and install this one. The saved choice (upscaling on or off, the one-time NVIDIA app note) is not carried over.
- New name: **RTX Upscale for Vestra Player** (was VestraUpscale), in the store and in every language.
- New icon: "RTX" with four arrows expanding to the corners. "RTX" names the NVIDIA technology the plugin uses; the plugin is not made or endorsed by NVIDIA.

## 0.2.0

- New window, **Video ▸ AI Upscaling…**: one button turns upscaling on and off, and the window shows live how it runs: on or off, whether the player asked the GPU to upscale, waits or cannot work here, and why; the video's size, the size it is upscaled to and the scale factor, the video area, the GPU, the decoder and whether the upscaler is in the filter chain. A note says that the driver gives no sign that it upscales and that Super Resolution (and its quality level) is set in the NVIDIA app. The window listens to the player only while it is open, so the plugin is not kept running otherwise. The player reports changes only while upscaling is on; while it is off, the window shows what it read when it opened, says so, and words a decoding reason as what would happen once upscaling is on.
- When other plugins' video filters hold upscaling back (copy-back decoding), the window names those plugins as the player reports them and says to turn their filters off or reset them there; for the built-in Picture Adjustments it adds Video ▸ Reset (key Q). The plugin never changes another plugin's settings.
- Corrected: every wait for decoding was described as "another video filter is on". The menu reason, the OSD and the window now say why by the player's cause: another plugin's video filter (copy-back), hardware decoding off, a video decoded in software (a cover picture, a format the GPU cannot decode), or another hardware decoder. Copy-back set by the player's own hardware decoding setting (no plugin's filter) gets its own words. With a cause the plugin does not know, the player's own message is shown.
- Needs Vestra Player 0.6.0 or later (the decoding cause, the plugin names and the monitoring fields; SDK 1.5.43 documents them as player 0.5.25, a version that was never released). Without them the window shows the player's message and "—".

## 0.1.1

- When the player refuses AI upscaling without a reason the plugin knows (for example a remembered "on" at start), the message now says "AI upscaling is not available on this computer" instead of pointing to details in the Video menu, which are not shown while the item stays enabled.
- Clearer English message when GPU rendering cannot be turned on: "AI upscaling needs GPU rendering, which is unavailable here".
- Simplified Chinese: the message about choosing the NVIDIA GPU names the Windows settings page “显示卡”, as the menu reason does.

## 0.1.0

- First release: Video ▸ AI Upscaling (RTX Video Super Resolution) turns NVIDIA RTX Video Super Resolution on and off, and remembers the choice across restarts (re-applied on the first video; not for audio files or their PNG, BMP, WebP, TIFF or GIF cover pictures).
- On macOS and Linux the item is greyed out from the start. On Windows it is greyed out with the reason once the player has checked the GPU: no NVIDIA RTX GPU, a driver older than 530, the player on the other GPU of a laptop (Windows Settings ▸ System ▸ Display ▸ Graphics), or software rendering, with advice that matches why (turn on Video ▸ GPU Rendering (Experimental) and restart; restart; or GPU rendering cannot be turned on here). Never greyed while GPU rendering is still starting.
- A one-time note that Super Resolution must also be on in the NVIDIA app.
- Needs Vestra Player 0.5.16 or later.
