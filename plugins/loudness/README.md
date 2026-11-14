# Loudness

A live loudness meter for what you play, measured the way broadcasters and streaming services do it (EBU R128, ITU-R BS.1770).

## Usage

**Tools ▸ Loudness Meter…** opens a small window:

- **Momentary** (the last 0.4 s) and **Short-term** (the last 3 s): bars and values in LUFS. The bars span −59 to −5 LUFS, the EBU's "+18" meter scale.
- **Integrated**: the gated average loudness of what has played since the measurement started, in LUFS. Broadcast aims at −23 LUFS (EBU R128) or −24 (ATSC A/85); streaming services play at about −14 to −16.
- **Range**: the loudness range (LRA) in LU. A large range (above about 15 LU) means quiet dialogue and loud scenes far apart.
- **True peak**: the highest peak so far, in dBTP. Above −1 dBTP, R128's limit, it turns red.
- **Restart** starts the measurement over. Opening another file or seeking does that too.

The values update ten times a second while sound plays and hold while paused. The meter only measures: what you hear is unchanged. It runs only while its window is open.

To make quiet dialogue and loud scenes more even, turn on the player's own **Normalize** (Shift+N). The meter measures the media's own sound, before Normalize and the volume control: its values are the same with Normalize on or off.

## Requirements

- Vestra Player 0.9.0 or later, on macOS or Windows.

## Limits

- The measurement uses FFmpeg's `ebur128` filter in the player's audio chain. Opening the window, closing it and Restart rebuild that chain, which can make a very short gap in the sound.
- The player rebuilds the audio chain after a seek or a reload; the integrated value, the range and the true peak then start over together, so all three always describe the same stretch of sound.
- The meter sees the sound a moment before you hear it (the audio output's buffer).
