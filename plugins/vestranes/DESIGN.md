# VestraNES 0.4.0: the NES emulator as a third-party plugin, with keyboard control (proposal)

Plugin proposal in the format of the community workflow §2.1. Author: the
`zysilm.vestranes` plugin author, 2026-10-27. Inputs: the user's rulings of
2026-10-27 (the built-in `vestra.nes` leaves the player and becomes
VestraNES in this repository; a Games menu; only VestraNES loads `.nes`;
keyboard control through the plugin's own window, no new API). Status:
implemented in 0.4.0; the GUI acceptance (§6) is the coordinator's.

## 1. Purpose and scenarios

**What the user wants.** Play an NES game from a ROM file they own, in the
player, with the keyboard, without the game and the player fighting over
keys.

**What the plugin does.**

- Loads an iNES ROM (`.nes`) chosen in the system's file dialog and runs it
  with [JSNES](https://github.com/bfirsh/jsnes) 2.1.0 (Apache-2.0, bundled
  by the SDK's esbuild into `main.js`). Picture (256×240 RGBA) and sound
  (48 kHz stereo) go to the player as a generated stream
  (`plugin.player.openStream`), paced by the audio clock at 60 frames per
  second.
- A small tool window: the status, the key table, **Load ROM…** and
  **Stop**. While it has the keyboard focus, it is the controller.

**Non-goals.** Gamepads, a second controller, editable keys, save states,
battery saves, Game Genie, PAL timing, a ROM library, and opening `.nes`
from Open File, a drop or the playlist (user ruling: only VestraNES loads
`.nes`).

**Preconditions, independent of other plugins.** Vestra Player 0.5.8 or
later (below) and a ROM file. Nothing else: no playlist, no other plugin.

### Changes from the built-in `vestra.nes` 0.3.2

| 0.3.2 (built in) | 0.4.0 (VestraNES) | Why |
| --- | --- | --- |
| A file resolver for `.nes` (`plugin.resolvers.add`) and a drop provider: Open File, a drop on the video, the playlist and Previous/Next ran ROMs | No resolver, no drop provider: **Load ROM…** in the menu and the window | User ruling. Also leaves `.nes` free for another emulator plugin |
| Capabilities `producer.av`, `commands`, `events`, `playback.read`, `playback.control`, `ui.window`, `ui.dialog`, `ui.drop`, `source.resolve` | `commands`, `ui.window`, `ui.dialog`, `playback.read`, `playback.control`, `producer.av` | No resolver (`source.resolve`), no drop (`ui.drop`). `events` is gone: the only state read is after a stream stopped, with `player.refresh()` |
| **Emulator ▸ Open NES ROM… / Stop NES / NES Tools…** | **Games ▸ VestraNES ▸ Load ROM… / Stop / VestraNES Window…** | User ruling (§2) |
| No keyboard control | The window is the controller (§3) | User ruling |
| A ROM that failed to open replaced the running game (the open was the player's) | A ROM that fails to load leaves the running game alone and the window says why | The load is the plugin's until `openStream` succeeds |
| Status line elided, full text in a tooltip | Two wrapped lines, no tooltip | A tooltip is a Slint `PopupWindow`; showing it takes the keyboard focus from the `FocusScope` (`FocusReason::PopupActivation`), so resting the pointer on the status line would let go of every button |
| de, es, fr, ja, ko, zh-Hans catalogs | English and zh-Hans | As the other plugins of this repository |

## 2. Entries

| Feature | Main menu path | Other entries | Runs directly or opens an interface | Enabling condition | State source |
| --- | --- | --- | --- | --- | --- |
| Load a ROM | **Games ▸ VestraNES ▸ Load ROM…** | the window's **Load ROM…** | shows the window, then the file dialog; the chosen ROM starts | always (a second dialog while one is open is ignored) | the plugin's load attempt |
| Stop | **Games ▸ VestraNES ▸ Stop** | the window's **Stop**; the player's Close (F4) | runs | the window's button: a game runs; the menu item: always (says "Stopped.") | the plugin's stream |
| Show the window | **Games ▸ VestraNES ▸ VestraNES Window…** | — | opens or raises the window | always | `window.opened` |
| Control the game | — | the keys of §3, while the window has the keyboard focus | runs | a game runs | the held-button set |

**Menu.** "Games" is a new top-level domain (user ruling), in the `domain`
group like Playback, Subtitles, Video and Audio. The menu guidelines put a
plugin's own domain at the top level, named after the domain, with orders
200–699; the items use 601–603, the place of the old **Emulator ▸** (after
Audio at 500, before the screen group at 700), so Games sits where Emulator
was. VestraNES is a submenu of Games so that another game plugin can share
the domain. Paths are English literals; the player merges them by these
words in every language and shows the plugin's translation (游戏 ▸
VestraNES ▸ 加载 ROM… / 停止 / VestraNES 窗口…). This changes the global menu
tree; the interaction lead updates `doc/product/menus.md` and
`menu-tree.md` with the player-side removal.

**File dialog.** The ruling asks for a dialog filtered to `.nes`;
`dialogs.openFile` (SDK 1.5.27) takes only a title, so the dialog shows
every file. The plugin checks the iNES header and the size instead, and a
wrong file is reported in the window ("This is not an NES ROM in iNES
format."). An `extensions` option for `openFile` is requested in the report
of this round (§4.1); it would be a compatible addition.

## 3. Interface

```text
┌ VestraNES ───────────────────────────────┐  tool window, 340 px wide, height from its layout
│ Running pad.nes · 256×240 · 48 kHz       │  status: two lines at most, elided
│ stereo                                   │
│ While this window is in front, these     │  dim, wraps
│ keys control the game. The player's      │
│ shortcuts are not affected.              │
│ D-pad          Arrow keys                │  the key table (fixed)
│ A              X                         │
│ B              Z                         │
│ Select         A                         │
│ Start          S                         │
│                    [Load ROM…]  [Stop]   │  Stop enabled while a game runs
└──────────────────────────────────────────┘
```

Every element is always there; only texts and Stop's `enabled` change (no
`if` under the pointer). The window can be minimized and closed like any
tool window; closing it does not stop the game (Stop or F4 does).

### Keyboard control

**Where the keys come from.** The whole content of the window is one
Slint `FocusScope` (`keys`), and the window forwards its focus to it
(`forward-focus: keys`), so it has the focus whenever the window is active.
While a game runs, its `key-pressed` and `key-released` handlers send every
key to the plugin through the window callback `key(text, down, modified)`
(auto-repeats are dropped there); `focus-changed-event` calls
`release-all()` when it loses the focus. The plugin (`main.ts`) passes them
to the running `NesCore` (`core.ts`), which maps the key text to a button,
remembers which key text pressed which button, keeps the set of held
buttons and calls JSNES `buttonDown(1, …)` / `buttonUp(1, …)`. The mapping
lives in TypeScript so that the tests cover it. The emulator reads the
buttons on its next `frame()`. No new API: windows, callbacks and
`openStream` are what the player has.

**The main window's keys are untouched.** The player's key bindings live in
the main window (and floating panels): its winit hook and Slint
`key-input` callback feed the binding table. A plugin tool window is opened
by `ui::open` (`src/host/src/ui.rs`, called from
`capabilities/ui_window.rs`), whose winit hook only runs
`WindowShortcuts::filter`: the system's standard window shortcuts
(Ctrl+W and Ctrl+F4 on Windows, ⌘W on macOS) close the window and never
reach Slint. Nothing else is forwarded to the binding table: a key the
window's Slint does not accept is dropped. So the game keys reach only the
game, and while the main window is in front Space, the arrows, F4 and the
rest keep their player meaning. (Checked in the player source of
2026-10-27; floating panels, which do forward keys, are not involved.)

**Rules.**

| Case | Behaviour | Where |
| --- | --- | --- |
| Mapping | ↑ ↓ ← → = D-pad, X = A, Z = B, A = Select, S = Start; fixed, not editable; letters in either case | `keyButton` in core.ts |
| Not a game key | remembered as down, no button; accepted while a game runs (Tab does nothing then) | core.ts, nes.slint |
| No game running | nothing is sent; a stray `release-all` is ignored by the plugin (no `NesCore`) | nes.slint, main.ts |
| Auto-repeat | swallowed: a held key is one press | nes.slint (`event.repeat`); `NesCore.key` ignores a key already down |
| Ctrl, Alt or ⌘/Win held | the press is sent as `modified` (remembered, no button) and rejected, so window shortcuts work; AltGr (Ctrl+Alt on Windows) is excluded the same way. Shift is allowed (`Z` and `z` are both B) | nes.slint, core.ts |
| The modifier keys themselves (U+0010–U+0018) | ignored | core.ts |
| A release | releases the button its key pressed, found by the key's text, whatever modifier went down in between | core.ts |
| A release whose text was never down | the keyboard layout changed under a held key (Alt+Shift, Win+Space: the key now types another character); every button pressed by a letter key is let go, the arrows stay held | core.ts |
| A key already held when the window gains the focus or a game starts | not a press: the game sees it only after it is released and pressed again (Slint sends no event for a key that went down elsewhere) | — |
| The window loses the focus (another window in front, minimized, a dialog of this plugin) | every held button is let go (`focus-changed-event` with `has-focus` false → `release-all`); keys work again once it is in front | nes.slint, `NesCore.releaseAll` |
| The window is closed with a key down (Ctrl+W, Ctrl+F4, the title bar) | every held button is let go (`window.onClose`): the host takes the close keys before Slint, and a focus change is not guaranteed while the window goes | main.ts |
| Stop, F4, another source, the game failing, a new ROM, the plugin stopping | every held button is let go and the keys go nowhere until the next game | `forget()` in main.ts |
| A popup in the window | none: no tooltip (a popup takes the focus, see §1) | nes.slint |

**Keyboard layouts: by the typed letter, not the physical key.**
Desktop emulators usually bind keys by physical position (scan codes, as
FCEUX's and Mesen's input layers do), so Z/X stay under the same fingers on
every layout; JSNES's own browser frontend maps `keyCode`, which follows
the layout for letters, as here. Slint 1.18's `KeyEvent` has only `text`, `modifiers` and
`repeat` (`i-slint-common` 1.18.1, `builtin_structs.rs`); the physical key
the player's own bindings use comes from its winit hook on the main
window, which tool windows do not have. So VestraNES maps by the character
the key types in the current layout, in either case, and the window's table
names the letters printed on the keys. Arrow keys are the same everywhere.
Consequences, also in the README: on QWERTZ B is the Z key next to T; on
AZERTY Select is the A key where QWERTY has Q; with a non-Latin layout
only the arrows work. Mapping by position would need the physical key in
plugin windows: either a later Slint `KeyEvent` field or a host-side key
event for plugin windows. Not requested now (the user ruled "no new API");
noted in the round report as a possible §4.1 request.

An input method (Chinese Pinyin, Japanese) should not take the letters:
Slint's winit backend allows IME only when a text input asks for it
(`InputMethodRequest::Enable` from `TextInput`), and the window has none.
To be confirmed in the GUI with the Pinyin input method active.

## 4. State and failure

- **Load.** One file dialog at a time (a second request while one is up is
  ignored). Then: read the file (regular files only, through a handle and
  never more than 16 MiB + 1 bytes, so a FIFO or a device that reports size
  0 cannot make it read without end), check the iNES header,
  build `NesCore`, `openStream({ width: 256, height: 240, frame, signal })`.
  A failure at any step shows in the window in the plugin's words and leaves
  the running game (if any) alone; the start-up timeouts and the audio
  device get their own texts as before.
- **Watchdog.** A damaged ROM (random bank writes on mapper 7, say) can make
  one `frame()` take a second or more, and every such frame blocks the
  plugin (Stop and the keys lag). Three frames in a row slower than 100 ms
  stop the game: "Emulator stopped: This ROM is too slow to emulate (it may
  be damaged)." A normal frame takes a few milliseconds.
- **Focus after loading.** Load shows the window before the file dialog
  and calls `window.show()` again once the game runs, so the controller is
  in front after the dialog closes. Whether the system then gives it the
  keyboard focus (or the main window keeps it) is a GUI check; there is no
  API to activate a tool window.
- **A newer Load or Stop during a start** aborts it (`AbortSignal`, passed
  to the read and to `openStream`): the old start words nothing and its
  producer is released. A start that completes after Stop stops at once.
- **Replacement.** A new ROM replaces the running one directly (the
  window goes from "Running a" to "Running b", never "Replaced"). Another
  source (the user opens a file) shows "Replaced by another source."; F4
  shows "Stopped."; the stream failing shows "Emulator stopped: <reason>".
  The stream's `onStop` tells them apart, reading the player's state with
  `player.refresh()` (no `events` capability).
- **Stop** closes the source before the frame connection (the SDK's
  `Stream.stop()` order), so the player never reports a transport failure.
- **Pausing** is the player's: `frame()` is not called while paused.

## 5. API usage

| What | API | Status |
| --- | --- | --- |
| Menu | `commands.add({ path: ["Games", "VestraNES", "Load ROM…"], order: 601 })` | existing |
| File dialog | `dialogs.openFile({ title: "Load NES ROM" })` | existing; an `extensions` filter would be a request |
| Picture and sound | `player.openStream({ width, height, frame, signal })`, `Stream.onStop`, `Stream.stop` | existing (player 0.3.0) |
| Window and keys | `windows.create("nes.slint")`, `bind`, `on("button" / "releaseAll" / "loadRom" / "stop")`; Slint `FocusScope` | existing |
| Texts | `plugin.i18n.error`, `@tr`, `locales/zh-Hans.po` | existing (player 0.4.3) |

`minPlayerVersion` is 0.5.8: producer audio starts on Windows from player
0.5.7 (fixed 1024-frame buffer, mix layouts beyond stereo), and builds of
0.5.8 on SDK 1.5.27 reach 60 frames per second on Windows (the SDK runtime
that paces `frame()` is the player's). Nothing newer is used.

## 6. Acceptance scenarios

| User action | Observable result | Evidence |
| --- | --- | --- |
| Games ▸ VestraNES ▸ Load ROM…, choose a ROM | the window opens, the dialog asks, the game plays; "Running …" | `lifecycle.test.mjs`; GUI |
| The window's Load ROM… | the same; a cancelled dialog changes nothing | `lifecycle.test.mjs`; GUI |
| Press the mapped keys with the window in front | the game reacts; repeats are one press | `core.test.mjs` (a homebrew ROM that reads the controller and changes the picture), `lifecycle.test.mjs`; GUI |
| Click the main window, press Space / arrows | the player pauses / seeks; the game gets nothing | host source (§3); GUI |
| Hold a key, click the main window | the button is let go | nes.slint; GUI |
| Open File / drop / playlist with a `.nes` | the player opens it as a plain file (it fails); no game starts | `lifecycle.test.mjs`; GUI |
| Stop, F4, another file | the game stops; "Stopped." / "Replaced by another source." | `lifecycle.test.mjs`, `cancellation.test.mjs`; GUI |
| A bad, truncated, too large or missing ROM | its reason in the window; a running game keeps running | `lifecycle.test.mjs` |
| Frame rate | 60 produced and presented per second on Windows (`VESTRA_FRAME_LOG`) | GUI measurement |

The tests use original homebrew ROMs generated in `tests/homebrew.mjs`; no
commercial ROM is used or included.
