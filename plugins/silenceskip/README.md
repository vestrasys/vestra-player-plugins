# Silence Skipper

Skips the silent stretches of a video or audio file while it plays, like
Trim Silence in podcast players. Lectures, talks, screen recordings and
interviews play without the dead air.

## Use it

- **Playback ▸ Skip Silence** turns it on and off. It is off until you turn
  it on, and the player remembers your choice.
- While it is on, each pause that is long enough is skipped with a jump.
  A short note on the video says how much time skipping has saved since
  the file started playing ("Silence skipped · 1:15 saved"); a replay counts
  from 0:00 again.
- The seek bar shows the silences it found as shaded ranges (the 100
  longest, when a file has more).
- **Options ▸ Playback ▸ Silence Skipper**:
  - **Silence below** (−60 to −20 dB, default −35 dB): sound quieter than
    this counts as silence. Raise it when room noise or background music
    keeps pauses from being found; lower it when quiet speech is skipped.
  - **Shortest silence** (0.5 to 5 s, default 1 s): shorter pauses play
    as they are.

A little of each pause (0.15 s at either end) is kept so that words are
not clipped. A pause that runs into the end of the file is kept. Paused
playback is never moved, and when you seek back over a silence, it is
skipped again.

## How it works

When a file on this computer starts playing, the player's FFmpeg reads its
sound two minutes at a time, starting where you are, then the rest of the
file. Skipping starts as soon as the first two minutes are read (usually
under a second). Nothing leaves your computer. The result is kept while
the player runs; a new threshold reads the file again.

The silence is skipped with a seek, never by changing the speed, so your
playback speed stays as you set it.

## Requirements and limits

- Vestra Player 0.9.0 or later.
- Only files on this computer: streams and web addresses are not read.
- The selected audio track of the file is read; an external audio track
  you loaded is not, the file's first track is read instead.
- Each skip is a seek: on a video with keyframes far apart the jump can
  take a moment.
