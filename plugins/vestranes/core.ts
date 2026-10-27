import type { I18n } from '@vestra-player/sdk';
import * as jsnes from 'jsnes';

/**
 * The part of JSNES 2.1.0 this plugin uses. Its `index.d.ts` re-exports
 * `./src/nes` without a file extension, which NodeNext resolution (this
 * repository's) cannot follow, so the types are written out here.
 */
interface NES {
  frame(): void;
  loadROM(data: Uint8Array): void;
  buttonDown(controller: 1 | 2, button: number): void;
  buttonUp(controller: 1 | 2, button: number): void;
}
const { NES, Controller } = jsnes as unknown as {
  NES: new (options: {
    sampleRate: number;
    emulateSound: boolean;
    onFrame: (pixels: Uint32Array) => void;
    onAudioSample: (left: number, right: number) => void;
  }) => NES;
  Controller: Record<'BUTTON_A' | 'BUTTON_B' | 'BUTTON_SELECT' | 'BUTTON_START' | 'BUTTON_UP' | 'BUTTON_DOWN' | 'BUTTON_LEFT' | 'BUTTON_RIGHT', number>;
};

/** `plugin.i18n.error`: the player shows these failures translated (the window, the log). */
export type Fail = I18n['error'];

/** The NES controller's buttons. */
export const BUTTONS = {
  up: Controller.BUTTON_UP,
  down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT,
  right: Controller.BUTTON_RIGHT,
  a: Controller.BUTTON_A,
  b: Controller.BUTTON_B,
  select: Controller.BUTTON_SELECT,
  start: Controller.BUTTON_START,
} as const;
export type Button = keyof typeof BUTTONS;
export const isButton = (name: unknown): name is Button => typeof name === 'string' && Object.hasOwn(BUTTONS, name);

/** Slint's key texts for the arrow keys (`Key.UpArrow` …): the same in every layout. */
const ARROWS: Record<string, Button> = { '\uF700': 'up', '\uF701': 'down', '\uF702': 'left', '\uF703': 'right' };
/**
 * The fixed key map. A key is named by the character it types in the current
 * layout (Slint 1.18 reports no physical key), so the letters are the ones
 * printed on the keys, in either case.
 */
const LETTERS: Record<string, Button> = { x: 'a', z: 'b', a: 'select', s: 'start' };
/** Slint's texts of the modifier keys themselves (Shift … MetaR, U+0010–U+0018). */
const MODIFIER = /^[\u0010-\u0018]$/;

/** A key's text as `NesCore.key` keeps it: letters in lower case. */
const keyOf = (text: string) => (Object.hasOwn(ARROWS, text) ? text : text.toLowerCase());
/** The button a key text stands for, if any. */
export const keyButton = (text: string): Button | undefined =>
  Object.hasOwn(ARROWS, text) ? ARROWS[text] : Object.hasOwn(LETTERS, keyOf(text)) ? LETTERS[keyOf(text)] : undefined;

/** A frame slower than this counts towards the watchdog. */
export const SLOW_FRAME_MS = 100;
/** This many slow frames in a row stop the game. */
export const SLOW_FRAMES = 3;
/** The clock of the watchdog; the tests replace `now`. */
export const timing = { now: () => performance.now() };

/** JSNES returns 0x00BBGGRR pixels; the public producer uses byte-order RGBA. */
export function rgbaFrame(pixels: Uint32Array, error: Fail): Uint8Array {
  if (pixels.length !== 256 * 240) throw error('The emulator frame has an invalid size.');
  const rgba = new Uint8Array(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const pixel = pixels[i]!;
    rgba[i * 4] = pixel & 255;
    rgba[i * 4 + 1] = (pixel >>> 8) & 255;
    rgba[i * 4 + 2] = (pixel >>> 16) & 255;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

export class NesCore {
  private video: Uint8Array = new Uint8Array(256 * 240 * 4);
  private samples: number[] = [];
  /** Controller 1's buttons held down now. */
  private readonly held = new Set<Button>();
  /** The keys down now (their texts, `keyOf`), each with the button it pressed. */
  private readonly keys = new Map<string, Button | undefined>();
  /** Slow frames in a row (the watchdog). */
  private slow = 0;
  readonly nes: NES;
  private readonly error: Fail;
  constructor(rom: Uint8Array, error: Fail) {
    this.error = error;
    if (rom.length < 16 || rom[0] !== 78 || rom[1] !== 69 || rom[2] !== 83 || rom[3] !== 26)
      throw error('This is not an NES ROM in iNES format.');
    // Header: PRG banks × 16 KiB, CHR banks × 8 KiB, an optional 512-byte trainer.
    if (rom.length < 16 + (rom[6]! & 4 ? 512 : 0) + rom[4]! * 16384 + rom[5]! * 8192)
      throw error('The ROM file is incomplete: shorter than its header says.');
    this.nes = new NES({ sampleRate: 48000, emulateSound: true,
      onFrame: pixels => { this.video = rgbaFrame(pixels, error); },
      onAudioSample: (left, right) => {
        this.samples.push(Math.max(-1, Math.min(1, left)), Math.max(-1, Math.min(1, right)));
      },
    });
    try {
      this.nes.loadROM(rom);
    } catch (cause) {
      const message = String((cause as Error)?.message ?? cause);
      const mapper = /mapper:?\s*(\d+)/i.exec(message)?.[1];
      // JSNES's own reason is data (English).
      throw mapper ? error('JSNES does not support mapper {} of this ROM.', [mapper]) : error('JSNES could not load this ROM: {}', [message]);
    }
  }
  frame() {
    this.samples = [];
    const started = timing.now();
    this.nes.frame();
    // A damaged ROM (random bank writes, say) can make one frame take a second
    // and more; every such frame blocks the plugin (Stop, the keys).
    this.slow = timing.now() - started > SLOW_FRAME_MS ? this.slow + 1 : 0;
    if (this.slow >= SLOW_FRAMES) throw this.error('This ROM is too slow to emulate (it may be damaged).');
    const audio = Float32Array.from(this.samples);
    if (audio.length === 0 || audio.some(value => !Number.isFinite(value)))
      throw this.error('The emulator produced invalid audio data.');
    return { video: this.video, audio };
  }
  /**
   * A button goes down or up. Idempotent: a second press of a held button
   * (a key's auto-repeat, or two keys for one button) changes nothing, nor
   * does releasing a button that is not held.
   */
  button(name: Button, down: boolean) {
    if (down === this.held.has(name)) return;
    if (down) {
      this.held.add(name);
      this.nes.buttonDown(1, BUTTONS[name]);
    } else {
      this.held.delete(name);
      this.nes.buttonUp(1, BUTTONS[name]);
    }
  }
  /**
   * A key of the VestraNES window went down or up (`text` as Slint reports
   * it). `modified`: pressed with Ctrl, Alt or ⌘/Win, so not a game key, but
   * remembered as down. Auto-repeats and the modifier keys themselves change
   * nothing.
   *
   * A key is released by its own text. When a release arrives for a text that
   * is not down, the keyboard layout changed while a key was held (its release
   * types another character): every button pressed by a letter key is let go,
   * since the letters are what a layout changes. The arrow keys stay held.
   */
  key(text: string, down: boolean, modified = false) {
    if (text === '' || MODIFIER.test(text)) return;
    const key = keyOf(text);
    if (down) {
      if (this.keys.has(key)) return; // an auto-repeat
      const button = modified ? undefined : keyButton(key);
      this.keys.set(key, button);
      if (button) this.button(button, true);
    } else if (this.keys.has(key)) {
      const button = this.keys.get(key);
      this.keys.delete(key);
      if (button && ![...this.keys.values()].includes(button)) this.button(button, false);
    } else {
      for (const [other, button] of [...this.keys]) {
        if (Object.hasOwn(ARROWS, other)) continue;
        this.keys.delete(other);
        if (button) this.button(button, false);
      }
    }
  }
  /** Release every held button (the window lost focus, the game stopped). */
  releaseAll() {
    this.keys.clear();
    for (const name of [...this.held]) this.button(name, false);
  }
  /** The buttons held now, for the tests. */
  get pressed(): Button[] {
    return [...this.held];
  }
}
