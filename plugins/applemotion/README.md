# Apple Motion Smoothing

Makes motion smoother by doubling the video's frame rate while it plays. The in-between frames are made by **Apple's frame interpolation** (VideoToolbox's frame processor) on your Mac's **Apple silicon**: real intermediate pictures, not two frames blended. The twin of [AMD Motion Smoothing](../amdmotion/README.md) and [NVIDIA Motion Smoothing](../nvidiamotion/README.md) for Macs.

## Usage

Right-click menu **Video ▸ Apple Motion Smoothing…** opens a small window:

- **Mode**: *Off* (the default), *Double Frame Rate* (twice the frames, shown as they come) or *Match Display* (the doubled frames also paced to the display's refresh rate; needs GPU rendering).
- A status line: what runs ("On: 24 → 48 fps on Apple M2"), that it applies when a video plays, why it waits, or why it is not available here, with the player's reason.

Your choice is remembered and applied again at the next start.

The **command palette** (and **Ask Vestra** in it) can also choose a mode in one step: *Apple Motion Smoothing: Off*, *Double Frame Rate (Smoother Video)* or *Match Display (Smoothest Motion)*, with the mode in use marked. On a computer where a mode cannot work, its command is greyed out with the reason, so asking Vestra for "smoother video" picks the motion smoothing that works on your computer.

## Requirements

- A Mac with **Apple silicon** (M1 or newer) and **macOS 15.4 or newer**. On Intel Macs, on Windows and on other systems the window says it is not available and nothing changes.
- A Vestra Player release with the Apple engine (the store shows the minimum version and offers the plugin only to such a player).
- *Match Display* needs GPU rendering, the player's default on macOS. With software rendering, *Double Frame Rate* works only where twice the video's rate is the display's (30 fps on a 60 Hz screen).

## Limits

- If frames are being dropped while the window is open, it says so under the status, with what helps (GPU rendering, a lower resolution, or Double Frame Rate instead of Match Display when that is the mode). A single burst, such as when the converter starts or after a seek, does not count.
- How large a video your Mac keeps up with depends on its chip; 4K can be too much for the smaller ones. A video that is too large falls far behind: the player turns smoothing off for that video only and says why, and the next video is tried again. Once two videos of about that size fell far behind (with GPU rendering), videos of that size or larger wait with the reason until you turn smoothing off and on again (or choose the other mode) or restart the player. Smaller videos are still smoothed.
- Videos of 10 to 30 fps; 10-bit SDR is fine, HDR is not smoothed (the window says why).
- When smoothing starts, the first moment of the video can play undoubled while macOS gets its frame interpolation ready.
- It does not run together with a frame-doubling video filter of another plugin (Frame Doubling): smoothing waits and says why.
- Thin structures (railings, grass, leaves) and things that cover each other can show artefacts in the made frames, more in very fast motion. Doubling also makes film look like video (the "soap-opera effect"); that is why it is off by default.
