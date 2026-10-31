# Changelog

## 0.1.1

- When the player refuses AI upscaling without a reason the plugin knows (for example a remembered "on" at start), the message now says "AI upscaling is not available on this computer" instead of pointing to details in the Video menu, which are not shown while the item stays enabled.
- Clearer English message when GPU rendering cannot be turned on: "AI upscaling needs GPU rendering, which is unavailable here".
- Simplified Chinese: the message about choosing the NVIDIA GPU names the Windows settings page “显示卡”, as the menu reason does.

## 0.1.0

- First release: Video ▸ AI Upscaling (RTX Video Super Resolution) turns NVIDIA RTX Video Super Resolution on and off, and remembers the choice across restarts (re-applied on the first video; not for audio files or their PNG, BMP, WebP, TIFF or GIF cover pictures).
- On macOS and Linux the item is greyed out from the start. On Windows it is greyed out with the reason once the player has checked the GPU: no NVIDIA RTX GPU, a driver older than 530, the player on the other GPU of a laptop (Windows Settings ▸ System ▸ Display ▸ Graphics), or software rendering, with advice that matches why (turn on Video ▸ GPU Rendering (Experimental) and restart; restart; or GPU rendering cannot be turned on here). Never greyed while GPU rendering is still starting.
- A one-time note that Super Resolution must also be on in the NVIDIA app.
- Needs Vestra Player 0.5.16 or later.
