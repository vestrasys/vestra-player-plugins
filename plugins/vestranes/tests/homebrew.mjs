// Original mapper-0 homebrew ROMs written for these tests (no commercial ROM,
// no fixture downloaded from a prior implementation).

/** An iNES file: 16-byte header, one 16 KiB PRG bank holding `program` at $8000, one empty 8 KiB CHR bank. */
function romImage(program) {
  const rom = new Uint8Array(16 + 16384 + 8192);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 1, 1]);
  rom.set(program, 16);
  // NMI, reset and IRQ vectors all point to $8000.
  for (const offset of [0x3ffa, 0x3ffc, 0x3ffe]) rom.set([0, 0x80], 16 + offset);
  return rom;
}

/** Reset, wait two vblanks, turn the background on. */
const boot = [0x78, 0xd8, 0xa2, 0xff, 0x9a, 0xe8, // SEI CLD LDX #$FF TXS INX
  0x8e, 0x00, 0x20, 0x8e, 0x01, 0x20, // STX $2000, STX $2001
  0x2c, 0x02, 0x20, 0x10, 0xfb, 0x2c, 0x02, 0x20, 0x10, 0xfb]; // two vblank waits

/** Sets the PPU universal background color and plays an APU pulse. */
export function homebrew(color = 0x21) {
  const program = [...boot,
    0xa9, 0x3f, 0x8d, 0x06, 0x20, 0xa9, 0, 0x8d, 0x06, 0x20,
    0xa9, color, 0x8d, 0x07, 0x20,
    0xa9, 0x0a, 0x8d, 0x01, 0x20,
    0xa9, 1, 0x8d, 0x15, 0x40,
    0xa9, 0xbf, 0x8d, 0, 0x40,
    0xa9, 0xfe, 0x8d, 2, 0x40,
    0xa9, 8, 0x8d, 3, 0x40];
  const loop = 0x8000 + program.length;
  program.push(0x4c, loop & 255, loop >>> 8);
  return romImage(program);
}

/**
 * Reads controller 1 every vblank and paints the background `pressed` while
 * the button with index `button` (0 A, 1 B, 2 Select, 3 Start, 4 Up, 5 Down,
 * 6 Left, 7 Right: the order the NES shifts them out) is down, `idle`
 * otherwise. `pressed` must not be 0.
 */
export function controllerRom({ button = 0, idle = 0x21, pressed = 0x16 } = {}) {
  const program = [...boot, 0xa9, 0x0a, 0x8d, 0x01, 0x20]; // LDA #$0A STA $2001
  const loop = 0x8000 + program.length;
  program.push(
    0x2c, 0x02, 0x20, 0x10, 0xfb, // wait for vblank
    0xa9, 1, 0x8d, 0x16, 0x40, 0xa9, 0, 0x8d, 0x16, 0x40, // strobe $4016
    ...Array(button).fill([0xad, 0x16, 0x40]).flat(), // skip the buttons before it
    0xad, 0x16, 0x40, 0x29, 1, // LDA $4016 AND #1
    0xf0, 4, 0xa9, pressed, 0xd0, 2, // BEQ idle; LDA #pressed; BNE set
    0xa9, idle, // idle: LDA #idle
    0xa2, 0x3f, 0x8e, 0x06, 0x20, 0xa2, 0, 0x8e, 0x06, 0x20, // set: $2006 = $3F00
    0x8d, 0x07, 0x20, // the universal background color
    0x8e, 0x06, 0x20, 0x8e, 0x06, 0x20, // $2006 = $0000 again
    0x4c, loop & 255, loop >>> 8);
  return romImage(program);
}
