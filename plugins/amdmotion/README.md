# AMD Motion Smoothing

Makes motion smoother by doubling the video's frame rate while it plays. The in-between frames are made by the motion estimation of AMD's frame-rate converter (AMF) on your **AMD Radeon GPU**: real intermediate pictures, not two frames blended.

## Usage

Right-click menu **Video ▸ AMD Motion Smoothing…** opens a small window:

- **Mode**: *Off* (the default), *Double Frame Rate* (twice the frames, shown as they come) or *Match Display* (the doubled frames also paced to the display's refresh rate; needs GPU rendering).
- A status line: what runs ("On: 24 → 48 fps on AMD Radeon 780M Graphics"), that it applies when a video plays, why it waits, or why it is not available here, with the player's reason.

Your choice is remembered and applied again at the next start.

## Requirements

- Windows with an **AMD Radeon GPU** and the AMD graphics driver (it brings AMD's AMF runtime). On a laptop with two GPUs the AMD one converts, whichever draws the picture. On other GPUs and systems the window says it is not available and nothing changes.
- Vestra Player 0.9.0 or later.
- *Match Display* needs GPU rendering. With software rendering, *Double Frame Rate* works only where twice the video's rate is the display's (30 fps on a 60 Hz screen).

## Limits

- The player offers a mode only where it measured that the GPU and the renderer keep up: videos of 10 to 30 fps in 8-bit SDR (not 10-bit or HDR); with software rendering up to 1080p at 30 fps, with GPU rendering up to 4K at 24 fps (Double) and 1080p on a 60 Hz display (Match Display). If the GPU still falls behind, the player first uses a faster motion search, then turns smoothing off for that video and says why.
- It does not run together with the player's AI Upscaling (one needs the frames on the GPU, the other in memory) or with Frame Doubling (the frame rate would be doubled twice): while either is on, smoothing waits and says so.
- Doubling makes film look like video (the "soap-opera effect"); that is why it is off by default.
