# Changelog

## 0.4.0

- **VestraNES, a third-party plugin.** The NES emulator that was built into the player (`vestra.nes`, "NES Emulator", up to 0.3.2) is now VestraNES, id `zysilm.vestranes`, author zysilm, installed from the Plugin Store. It is a new plugin to the store: nothing carries over from the built-in one.
- **Keyboard control.** While the VestraNES window is in front, the keyboard is the controller: arrow keys = D-pad, X = A, Z = B, A = Select, S = Start (fixed). The player's own shortcuts are not affected: they act in the main window only. Keys with Ctrl, Alt or ⌘/Windows stay the window's; a held key is one press; every button is let go when the window goes to the back or the game stops.
- **Its own menu:** **Games ▸ VestraNES ▸ Load ROM… / Stop / VestraNES Window…** (was **Emulator ▸ Open NES ROM… / Stop NES / NES Tools…**).
- **Only VestraNES loads `.nes` files.** Open File, a drop on the video and the playlist no longer run them; load a ROM from the menu or the window's **Load ROM…**. A ROM that fails to load no longer stops the game that is running.
- The window shows the key table and a line saying when the keys reach the game. The status line wraps to two lines instead of a tooltip (a tooltip took the keyboard from the game while it showed).
- A damaged ROM that makes the emulator crawl (several frames in a row over 100 ms) is stopped with "This ROM is too slow to emulate (it may be damaged)" instead of freezing the plugin.
- English and Simplified Chinese. Needs Vestra Player 0.5.8 or later.
