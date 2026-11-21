# Silence Skipper

Skips the silent stretches of a video or audio file while it plays, like
Trim Silence in podcast players. Lectures, talks, screen recordings and
interviews play without the dead air.

## Use it

- **Playback ▸ Skip Silence** turns it on and off. It is off until you turn
  it on, and the player remembers your choice.
- While it is on, each pause that is long enough is skipped with a jump.
  A short note on the video says how much time skipping has saved since
  the file started playing ("Silence skipped · 1:15 saved"); a replay, or
  going back before a silence already skipped, counts from 0:00 again.
- The seek bar shows the silences it found as shaded ranges: the ones
  that are skipped (the 1000 longest, when a file has more).
- **Options ▸ Playback ▸ Silence Skipper**:
  - **Silence below** (−60 to −20 dB, default −35 dB): sound quieter than
    this counts as silence. Raise it when room noise or background music
    keeps pauses from being found; lower it when quiet speech is skipped.
  - **Shortest silence** (0.5 to 5 s, default 1 s): shorter pauses play
    as they are.

A little of each pause (0.15 s at either end) is kept so that words are
not clipped. A pause that runs into the end of the file is kept. Paused
playback is never moved. A silence is skipped each time playback enters
it, also when you seek back before it or drag into it.

## How it works

When a file on this computer is ready to play, the player's FFmpeg reads
its sound two minutes at a time, starting where you are, then the rest of
the file. Skipping starts as soon as the first two minutes are read
(usually under a second). Nothing leaves your computer. The result is kept
while the player runs; a new threshold reads the file again.

The plugin hands the silences to the player, which draws them and watches
the position by itself. Between silences far apart the plugin does not
run: the player starts it 2 seconds (of media time) before the next
silence, and the plugin waits for the silence to start and jumps to its
end. Changing the speed in those 2 seconds lets that one silence play.

The silence is skipped with a seek, never by changing the speed, so your
playback speed stays as you set it.

## Requirements and limits

- Vestra Player 0.10.0 or later.
- Only files on this computer: streams and web addresses are not read.
- The selected audio track of the file is read; an external audio track
  you loaded is not, the file's first track is read instead. Picking
  another track while it plays reads that track.
- Each skip is a seek: on a video with keyframes far apart the jump can
  take a moment.
