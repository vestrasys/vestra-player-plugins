import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Plugin, PluginError, Stream, StreamStartError, Text, TextError } from "@vestra-player/sdk";
import { type Fail, NesCore } from "./core.ts";

const MAX_ROM = 16 * 1024 * 1024;

/**
 * VestraNES: a ROM is loaded from Games ▸ VestraNES ▸ Load ROM… or the
 * window's button and plays as a generated stream (`player.openStream`).
 * The VestraNES window is the controller: while it has the keyboard focus,
 * its keys (nes.slint) go to the game; the player's own shortcuts are the
 * main window's and are not touched.
 */
export default async function activate(plugin: Plugin) {
  const window = plugin.windows.create("nes.slint");
  let stream: Stream | undefined;
  /** The emulator of the running stream: the keys go to it. */
  let core: NesCore | undefined;
  /** The current Load attempt (picker, read, start): Stop and a newer Load abort it. */
  let loading: AbortController | undefined;
  /** The picker is up: a second one is ignored. */
  let picking = false;
  /** What the window says (worded in nes.slint): a state, the ROM's name, a reason. */
  let status: Status = { state: "idle" };
  window.bind(() => ({ state: status.state, rom: status.rom ?? "", detail: status.detail ?? "", running: !!stream?.running }));

  /** The stream stops being ours: no key handling, nothing held. */
  function forget() {
    core?.releaseAll();
    core = undefined;
    stream = undefined;
  }

  async function load() {
    if (picking) return; // one picker at a time
    picking = true;
    let path: string | null;
    try {
      // The window is the controller: bring it up with the picker.
      await window.show();
      path = await plugin.dialogs.openFile({ title: "Load NES ROM" });
    } catch (error) {
      status = failureText(error);
      return;
    } finally {
      picking = false;
    }
    if (path) await start(path);
  }

  async function start(path: string) {
    loading?.abort(); // a newer ROM wins over one still starting
    const attempt = (loading = new AbortController());
    const { signal } = attempt;
    try {
      const next = new NesCore(await readRom(path, signal, plugin.i18n.error), plugin.i18n.error);
      signal.throwIfAborted();
      const opened = await plugin.player.openStream({ width: 256, height: 240, frame: () => next.frame(), signal });
      if (signal.aborted) return void (await opened.stop()); // Stop came during the start
      // The previous game (if any) was replaced by this one: its onStop is ignored.
      forget();
      stream = opened;
      core = next;
      status = { state: "running", rom: basename(path) };
      // The controller again, after the file dialog: raise it if the system lets us.
      void window.show().catch(() => {});
      opened.onStop(async (error) => {
        if (stream !== opened) return; // stopped by this plugin, or replaced by a newer ROM
        forget();
        // The game failed: the player's reason (or this plugin's, for a frame failure).
        if (error) return void (status = stopText(error));
        if (loading) return; // replaced by the ROM now starting, which words its own state
        // Closed or replaced: the player's state says which.
        const state = await plugin.player.refresh().catch(() => plugin.player.state);
        if (stream || loading) return; // a newer ROM is starting and words its own state
        status = state.phase === "empty" ? { state: "stopped" } : { state: "replaced" };
      });
    } catch (error) {
      if (signal.aborted) return; // Stop or a newer ROM: they word the state
      status = failureText(error);
    } finally {
      if (loading === attempt) loading = undefined;
    }
  }

  async function stop() {
    loading?.abort();
    loading = undefined;
    const current = stream;
    forget();
    await current?.stop(); // closes the source only if it is still ours
    status = { state: "stopped" };
  }

  window.on("loadRom", load);
  window.on("stop", stop);
  // The keys of the focused window, while a game runs (nes.slint drops
  // auto-repeats); NesCore maps them and tracks which key pressed which button.
  window.on("key", (text: string, down: boolean, modified: boolean) => {
    if (typeof text === "string") core?.key(text, down === true, modified === true);
  });
  window.on("releaseAll", () => core?.releaseAll());
  // Closed with a key down (Ctrl+W, Ctrl+F4, the title bar): the window may
  // go without a focus change, and nothing must stay held.
  window.onClose(() => core?.releaseAll());
  plugin.onError((error) => (status = failureText(error)));
  plugin.onDispose(() => {
    loading?.abort();
    forget(); // the SDK stops the stream itself
  });
  // Games ▸ VestraNES ▸ (a domain of its own, top-level orders 200–699).
  plugin.commands.add({ id: "nes.load", path: ["Games", "VestraNES", "Load ROM…"], order: 601, run: load });
  plugin.commands.add({ id: "nes.stop", path: ["Games", "VestraNES", "Stop"], order: 602, run: stop });
  plugin.commands.add({ id: "nes.window", path: ["Games", "VestraNES", "VestraNES Window…"], order: 603, run: () => window.show() });
}

/** The ROM's bytes; file system failures in the plugin's words. */
async function readRom(path: string, signal: AbortSignal, error: Fail) {
  const tooLarge = () => error("The ROM file is larger than the 16 MiB limit.");
  try {
    const info = await stat(path);
    if (info.isDirectory()) throw error("This is a folder, not a ROM file.");
    // A FIFO or a device reports size 0 and may never end: only regular files.
    if (!info.isFile()) throw error("This is not an NES ROM in iNES format.");
    if (info.size > MAX_ROM) throw tooLarge();
    // Read at most MAX_ROM + 1 bytes, whatever the size said: the file may grow.
    const file = await open(path, "r");
    try {
      const bytes = new Uint8Array(MAX_ROM + 1);
      let length = 0;
      while (length < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_ROM) throw tooLarge();
      return bytes.subarray(0, length);
    } finally {
      await file.close();
    }
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw error("The ROM file was not found.");
    if (code === "EACCES" || code === "EPERM") throw error("No permission to read the ROM file.");
    if (code === "EISDIR") throw error("This is a folder, not a ROM file.");
    throw failure; // the size limit, or the load was cancelled (AbortError)
  }
}

/**
 * The window's status line, worded in nes.slint. `detail` is a reason in the
 * player's (or the SDK's) words, shown in one line, or this plugin's own
 * (a text the player translates).
 */
type Status = {
  state:
    | "idle"
    | "running"
    | "stopped"
    | "replaced"
    | "halted"
    | "ended"
    | "error"
    | "timeout"
    | "prefillTimeout"
    | "activationTimeout"
    | "device";
  rom?: string;
  detail?: string | Text;
};

/** Status text is one line (UI-TOOL-05). */
const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
};

/** Why something failed: this plugin's own words (`plugin.i18n.error`), else the error's message in one line. */
const reasonOf = (error: unknown): string | Text =>
  (error as Partial<TextError>)?.text ?? oneLine(error instanceof Error ? error.message : String(error));

/** The running game failed: the player's (or SDK's, or this plugin's) own reason. */
function stopText(error: PluginError | null): Status {
  return error == null ? { state: "ended" } : { state: "halted", detail: reasonOf(error) };
}

/** Start-up failures the SDK words generically get the plugin's own words. */
const timeouts: Record<StreamStartError["stage"], Status["state"]> = {
  prefill: "prefillTimeout",
  activation: "activationTimeout",
};

function failureText(error: unknown): Status {
  const { code } = error as PluginError;
  if (code === "timeout") return { state: timeouts[(error as StreamStartError).stage] ?? "timeout" };
  if (code === "device") return { state: "device" };
  return { state: "error", detail: reasonOf(error) };
}
