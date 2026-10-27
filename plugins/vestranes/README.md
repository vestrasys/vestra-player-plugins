# VestraNES

Play NES (Famicom) games in Vestra Player, with the keyboard as the controller.

## Usage

Right-click menu **Games ▸ VestraNES ▸ Load ROM…**, choose an iNES ROM file (`.nes`): the game plays in the player like any other source, picture and sound.

The small **VestraNES** window opens with it (**Games ▸ VestraNES ▸ VestraNES Window…** brings it back). It shows what is running, has **Load ROM…** and **Stop**, and is the controller: **while the VestraNES window is in front, these keys control the game**:

| NES controller | Key |
| --- | --- |
| D-pad | arrow keys |
| A | X |
| B | Z |
| Select | A |
| Start | S |

- Click the main window and the keys are the player's again (Space, arrows, F4…); click the VestraNES window and they are the game's. The player's shortcuts never change.
- Keys with Ctrl, Alt or ⌘/Windows are not game keys, so the window's own shortcuts (closing it) still work.
- Holding a key holds the button. When the window goes to the back, is minimized or closed, or the game stops, every button is let go. A key already held when the window comes to the front counts once it is pressed again.
- **Stop** (or **Games ▸ VestraNES ▸ Stop**, or the player's Close, F4) stops the game. Opening any other media replaces it.

`.nes` files open only through VestraNES: Open File, a drop on the video and the playlist do not run them.

The plugin follows the player's interface language (English and Simplified Chinese).

## Requirements

- Vestra Player 0.5.8 or later.
- Your own game ROMs. None are included.

## Limits

- The keys are fixed. They are the letters printed on the keys: on a German keyboard B is the Z key (next to T), on a French one Select is the A key (where Q is on an English keyboard). With a layout that types no Latin letters (Cyrillic, Greek…), only the arrow keys work; switch the keyboard layout to English while playing.
- One controller; no gamepads, no save states, no settings.
- ROMs up to 16 MiB. A damaged ROM that the emulator cannot run at speed is stopped with "This ROM is too slow to emulate". Compatibility is that of [JSNES](https://github.com/bfirsh/jsnes): NTSC games, a limited set of mappers; an unsupported mapper is named in the window.
- Like every generated source, the game cannot seek or change speed, and the player's video and audio filters do not apply to it.

## Third-party licenses

The package includes JSNES 2.1.0 (Apache-2.0). Its license text is in `licenses/`.
