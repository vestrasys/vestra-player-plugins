# Auto Frame for Vestra Player

Some videos are larger than their picture: a 3840×2160 video whose picture is only 2560×1440 in a corner, the rest one solid colour (black, white, grey or any other). Auto Frame finds the picture and crops the video to it, so the picture fills the window.

## How it works

When a video file on this computer starts, the plugin reads a few frames of it (eight keyframes between 5 % and 95 % of its length) with the FFmpeg the player ships, and looks for a solid-colour border around the picture:

- the border's colour is the most common colour of the outermost pixels; at least one whole edge must be that colour;
- the picture is every row and column with more than a few pixels of another colour, joined over the frames, so a dark scene does not shrink it; frames of only the border's colour (fades) are skipped, and two sample times that land on the same keyframe count once;
- the picture must stay in place: each edge of the joined box must be reached (within 4 pixels) by at least half of the frames. A picture in a canvas has the same box in every frame; slides, a screen recording or an animation on a plain background move, and are not cropped;
- a size up to 1 % smaller than a usual one (2560×1440, 1920×1080, 1280×720 …) grows to that size, keeping a little of the border; one at most 4 pixels larger (compression blurs the edge) shrinks to it;
- the video is cropped only when the border is on both axes: the picture is narrower **and** lower than the video (less than 95 % of its width and of its height). An ordinary film with bars only above and below (letterbox, such as 2.35:1 in 16:9) or only at the sides (pillarbox, such as 4:3 in 16:9) is left as it is.

The answer is remembered per file (its path, size and modification time), so the file is read only once. When a frame could not be read (a timeout, an error), the answer is used but not remembered. The video is then cropped in the player and a note on the video says so, for example "Auto-framed to 2560×1440".

The plugin follows the player's interface language (English and Simplified Chinese).

## Usage

Right-click menu **Video ▸ Auto Frame**:

- **Auto-Frame Videos** (checked, on by default): turns the plugin on or off. Your choice is remembered.
- **Detect Again**: reads the playing file again, for example after the first answer was wrong.
- **Show Full Picture for This File** (checked): shows the whole video of this file, uncropped; remembered for this file.

## When it does not crop

- The border is on one axis only: the picture covers 95 % or more of the video's width or of its height (a letterboxed or pillarboxed film).
- The picture fills (almost) the whole video: 95 % or more in both directions.
- Fewer than three of the frames show a picture (a very dark or very short video).
- The picture is smaller than a tenth of the video or 160 pixels on a side.
- The picture is narrower than 1:4 or wider than 4:1 (the note on the video says so).
- The border's colour is not the same in the frames, or some frame has no solid edge.
- The picture moves between the frames (slides or a screen recording on a plain background).

Detect Again says on the video why it did not crop.

## Limits

- **Local files only**, for now: links, streams and generated video are not read.
- **While a crop is on, AI Upscaling waits.** A crop is a video filter, and filters need the decoded picture in memory, so the player decodes with a copy back to memory instead of keeping the frames on the GPU. The player's built-in NVIDIA RTX Video Super Resolution (**Picture ▸ Rendering ▸ AI Upscaling**) needs the frames on the GPU, so it waits until the crop is gone. A video that is not cropped keeps zero-copy decoding.
- **Other picture changes.** When the player's own **Video ▸ Crop/Stretch** or a rotation changes the picture, the crop would land in the wrong place: the plugin does not crop then, and says so on the video. While its crop is on, it checks the size the player shows every second and undoes the crop (with a note) when such a change comes later. Turn the other change off and pick **Detect Again**.
- Only eight frames are read. Something that appears in the border area only at other times, such as subtitles burned in below the picture, is cut away if no sampled frame shows it; pick **Show Full Picture for This File** for such a video.
- A video whose picture changes size during playback is cropped to the area the picture covers in the sampled frames, when that area is stable enough (above).
- Reading a 4K file takes a few seconds; until then the video plays uncropped.

## Requirements

- Vestra Player 0.4.3 or later, with its FFmpeg (or `ffmpeg` and `ffprobe` on the `PATH`).
