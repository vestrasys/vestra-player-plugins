import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startPlugin } from '@vestra-player/sdk/testing';
import { BUTTONS, isButton, keyButton, NesCore as Core, rgbaFrame as rgba, timing } from '../core.ts';

import { controllerRom, homebrew } from './homebrew.mjs';

// The failures are `plugin.i18n.error`s: English messages, shown translated by the player.
const { host, plugin, stop } = await startPlugin(() => {}, { directory: new URL('..', import.meta.url), capabilities: [], locale: 'zh-Hans' });
after(stop);
const NesCore = class extends Core { constructor(rom) { super(rom, plugin.i18n.error); } };
const rgbaFrame = pixels => rgba(pixels, plugin.i18n.error);

test('JSNES runs original 6502 ROM and yields distinct PPU frames plus audible PCM', () => {
  const hashes = [];
  for (const color of [0x21, 0x16]) {
    const core = new NesCore(homebrew(color));
    let samples = 0, energy = 0, frame;
    for (let index = 0; index < 120; index++) {
      frame = core.frame();
      assert.equal(frame.video.length, 256 * 240 * 4);
      assert.equal(frame.audio.length % 2, 0);
      for (const sample of frame.audio) {
        assert.ok(Number.isFinite(sample) && Math.abs(sample) <= 1);
        energy += sample * sample;
      }
      samples += frame.audio.length / 2;
    }
    assert.ok(samples > 95000 && samples < 97000, `48 kHz sample count: ${samples}`);
    assert.ok(energy > 1, `APU signal energy: ${energy}`);
    assert.ok(frame.video.every((value, i) => i % 4 !== 3 || value === 255));
    hashes.push(createHash('sha256').update(frame.video).digest('hex'));
    console.log(JSON.stringify({ color, frames: 120, stereoFrames: samples, energy, videoSha256: hashes.at(-1) }));
  }
  assert.notEqual(hashes[0], hashes[1], '6502-selected PPU colors must change the rendered frame');
});

test('pixel channel conversion and malformed ROM errors', () => {
  const pixels = new Uint32Array(256 * 240);
  pixels[0] = 0x00563412;
  assert.deepEqual([...rgbaFrame(pixels).slice(0, 4)], [0x12, 0x34, 0x56, 255]);
  assert.throws(() => rgbaFrame(new Uint32Array(1)), /invalid size/);
  assert.throws(() => new NesCore(new Uint8Array(100)), /iNES/);
  const unsupported = homebrew();
  unsupported[6] = 0xf0;
  unsupported[7] = 0xf0;
  assert.throws(() => new NesCore(unsupported), { message: 'JSNES does not support mapper 255 of this ROM.' });
  assert.throws(() => new NesCore(unsupported), error => host.translate(error.text) === 'JSNES 不支持这个 ROM 的 mapper 255。');
  assert.throws(() => new NesCore(new Uint8Array(100)), error => host.translate(error.text) === '这不是 iNES 格式的 NES ROM 文件。');
  assert.throws(() => new NesCore(homebrew().subarray(0, 16 + 16384)), /incomplete/); // CHR bank missing
  const trainer = new Uint8Array(512 + homebrew().length);
  trainer.set(homebrew().subarray(0, 16));
  trainer[6] |= 4; // a trainer precedes PRG: 512 bytes more are needed
  assert.doesNotThrow(() => new NesCore(trainer.subarray(0, 512 + homebrew().length)));
  assert.throws(() => new NesCore(trainer.subarray(0, homebrew().length)), /incomplete/);
});

/** The RGBA of the frame's centre pixel after `frames` more frames. */
const centre = (core, frames = 3) => {
  let video;
  for (let i = 0; i < frames; i++) video = core.frame().video;
  const at = (120 * 256 + 128) * 4;
  return [...video.slice(at, at + 4)].join(',');
};

test('a held button reaches the 6502: the controller ROM paints its colour while A is down', () => {
  const core = new NesCore(controllerRom({ button: 0 }));
  const idle = centre(core, 10);
  core.button('a', true);
  const pressed = centre(core);
  assert.notEqual(pressed, idle, 'A down changes the picture');
  core.button('a', true); // an auto-repeat or a second key: still one press
  assert.deepEqual(core.pressed, ['a']);
  core.button('a', false);
  assert.equal(centre(core), idle, 'A up restores it');
  core.button('a', false); // releasing a button that is up changes nothing
  assert.deepEqual(core.pressed, []);
});

test('every button maps to its NES bit; releaseAll lets go of all of them', () => {
  const order = ['a', 'b', 'select', 'start', 'up', 'down', 'left', 'right'];
  order.forEach((name, bit) => {
    const core = new NesCore(controllerRom({ button: bit }));
    const idle = centre(core, 10);
    for (const other of order.filter(n => n !== name)) core.button(other, true);
    assert.equal(centre(core), idle, `the other buttons are not ${name}`);
    core.button(name, true);
    assert.notEqual(centre(core), idle, `${name} is bit ${bit}`);
    core.releaseAll();
    assert.deepEqual(core.pressed, []);
    assert.equal(centre(core), idle, `${name} released`);
  });
  assert.deepEqual(Object.keys(BUTTONS).sort(), [...order].sort());
  assert.equal(isButton('start'), true);
  assert.equal(isButton('turbo'), false);
  assert.equal(isButton('toString'), false);
  assert.equal(isButton(3), false);
});

test('keys: the map, either case, modifiers, repeats, and a layout switch under a held key', () => {
  const core = new NesCore(controllerRom());
  const right = String.fromCharCode(0xf703);
  assert.deepEqual(['x', 'X', 'z', 'a', 'S', right, 'y', 'q', ''].map(keyButton), ['a', 'a', 'b', 'select', 'start', 'right', undefined, undefined, undefined]);
  core.key('z', true);
  core.key('Z', true); // the auto-repeat of the same key with Shift: still one press
  core.key('Z', false); // released with Shift held: the same key
  assert.deepEqual(core.pressed, []);
  core.key('x', true, true); // Ctrl+X: not a game key
  core.key('x', false);
  assert.deepEqual(core.pressed, []);
  // Z held, then the layout changes (QWERTZ → QWERTY: the key now types y).
  core.key('z', true);
  core.key(right, true);
  core.key('s', true);
  core.key(String.fromCharCode(0x10), true); // Shift and Alt (switching layouts): ignored
  core.key(String.fromCharCode(0x12), false);
  core.key(' ', true);
  core.key(' ', false); // a key that was down: nothing
  assert.deepEqual(core.pressed.sort(), ['b', 'right', 'start']);
  core.key('y', false); // a release for a key that was never down: the layout changed
  assert.deepEqual(core.pressed, ['right'], 'letter buttons let go, the arrows stay');
  core.key(right, false);
  assert.deepEqual(core.pressed, []);
  core.key('z', true);
  core.releaseAll();
  core.key('z', true); // a fresh press after releaseAll works
  assert.deepEqual(core.pressed, ['b']);
});

test('the watchdog: three frames in a row over 100 ms stop the game; a fast frame resets the count', () => {
  const core = new NesCore(homebrew());
  const now = timing.now;
  let clock = 0;
  let step = 150;
  timing.now = () => (clock += step);
  try {
    core.frame();
    core.frame();
    step = 1; // a fast frame
    core.frame();
    step = 150;
    core.frame();
    core.frame();
    assert.throws(() => core.frame(), error => host.translate(error.text) === '这个 ROM 模拟起来太慢（文件可能已损坏）。');
  } finally {
    timing.now = now;
  }
});
