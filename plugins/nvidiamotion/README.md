# NVIDIA Motion Smoothing

Makes motion smoother by doubling the video's frame rate while it plays. The in-between frames are made from the optical flow that the hardware of your **NVIDIA GeForce RTX 30 series or newer GPU** measures between two frames (FFmpeg's `fruc_vulkan`, through Vulkan): real intermediate pictures, not two frames blended. The twin of [AMD Motion Smoothing](../amdmotion/README.md) for NVIDIA GPUs.

## Usage

Right-click menu **Video ▸ NVIDIA Motion Smoothing…** opens a small window:

- **Mode**: *Off* (the default), *Double Frame Rate* (twice the frames, shown as they come) or *Match Display* (the doubled frames also paced to the display's refresh rate; needs GPU rendering).
- A status line: what runs ("On: 24 → 48 fps on NVIDIA GeForce RTX 4070 Laptop GPU"), that it applies when a video plays, why it waits, or why it is not available here, with the player's reason.

Your choice is remembered and applied again at the next start.

## Requirements

- Windows with an **NVIDIA GeForce RTX 30 series or newer GPU** (RTX 30, 40, 50) and **NVIDIA driver 573.38 or newer**. On a laptop with two GPUs the NVIDIA one converts, whichever draws the picture. On older NVIDIA GPUs (RTX 20, GTX), other GPUs and other systems the window says it is not available and nothing changes.
- Vestra Player 0.11.1 or newer, the release that ships the NVIDIA engine.
- *Match Display* needs GPU rendering. With software rendering, *Double Frame Rate* works only where twice the video's rate is the display's (30 fps on a 60 Hz screen).

## Limits

- If frames are being dropped while the window is open, it says so under the status, with what helps (GPU rendering, a lower resolution, or Double Frame Rate instead of Match Display when that is the mode). A single burst, such as when the converter starts or after a seek, does not count.
- The player chooses the converter's settings: the finest quality that keeps up (slow optical flow on a 4-pixel grid), the faster setting for videos above 1440p. It offers a mode only where it measured that the GPU and the renderer keep up: videos of 10 to 30 fps in 8-bit SDR (not 10-bit or HDR), up to 4K at 30 fps; with software rendering a slower computer may drop frames at 4K, and the window says so. If the GPU still falls behind, the player first uses the faster setting, then turns smoothing off for that video and says why.
- It does not run together with the player's AI Upscaling, with Frame Doubling, or with AMD Motion Smoothing while that one is on (one converter at a time): smoothing waits and says why.
- Thin structures (railings, grass, leaves) and things that cover each other can show thin lines or torn edges in the made frames, more in very fast motion. Doubling also makes film look like video (the "soap-opera effect"); that is why it is off by default.
