import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { NesCore, timing } from '../core.ts';
import { roms, running, start, statusText, until } from './harness.mjs';

/** The real player retires a replaced stream's producer; the TestHost alone keeps it. */
const mode = retire => (retire ? 'producer retired like the player' : 'TestHost producer kept');

/** The plugin's stream is the player's source. */
const playing = host => host.source.kind === 'producer' && host.source.phase === 'ready';

/** Load `path` through Games ▸ VestraNES ▸ Load ROM… and wait until it runs. */
async function load(host, window, path) {
  host.dialogAnswers.push([path]);
  await host.command('nes.load').run();
  await until(() => window().props.running === true && playing(host), `running ${path}`);
}

test('menu entries and window are registered; no file resolver, no drop provider, minimal capabilities', async () => {
  const { host, stop, window, status } = await start();
  assert.deepEqual([...host.commands].map(([id, c]) => [id, c.declaration.path, c.declaration.order, c.declaration.group]), [
    ['nes.load', ['Games', 'VestraNES', 'Load ROM…'], 601, 'domain'],
    ['nes.stop', ['Games', 'VestraNES', 'Stop'], 602, 'domain'],
    ['nes.window', ['Games', 'VestraNES', 'VestraNES Window…'], 603, 'domain'],
  ]);
  assert.ok([...host.commands.values()].every(c => c.state.enabled));
  assert.equal(host.resolvers.size, 0, 'only VestraNES loads .nes: Open File, a drop and the playlist do not');
  assert.equal(host.dropProviders.length, 0);
  const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.capabilities.sort(), ['commands', 'playback.control', 'playback.read', 'producer.av', 'ui.dialog', 'ui.window']);
  assert.equal(manifest.id, 'zysilm.vestranes');
  assert.equal(window().file, 'nes.slint');
  assert.deepEqual(window().props, { state: 'idle', rom: '', detail: '', running: false });
  assert.equal(status(), 'Load an iNES ROM file.');
  assert.deepEqual(window().callbacks.sort(), ['key', 'load-rom', 'release-all', 'stop']);
  await stop();
});

test('in Simplified Chinese: 游戏 ▸ VestraNES, the picker and the window', async () => {
  const files = await roms();
  const { host, plugin, stop, window, status } = await start(undefined, undefined, { locale: 'zh-Hans' });
  try {
    assert.equal(plugin.i18n.locale, 'zh-Hans');
    assert.deepEqual([...host.commands.values()].map(c => c.display.path), [
      ['游戏', 'VestraNES', '加载 ROM…'],
      ['游戏', 'VestraNES', '停止'],
      ['游戏', 'VestraNES', 'VestraNES 窗口…'],
    ]);
    assert.equal(status(), '请加载 iNES ROM 文件。');
    // Every state the window words (nes.slint).
    const zh = (state, extra = {}) => statusText(host, { state, rom: '', detail: '', ...extra });
    assert.deepEqual(
      ['running', 'stopped', 'replaced', 'halted', 'ended', 'error', 'prefillTimeout', 'activationTimeout', 'timeout', 'device', 'idle']
        .map(state => zh(state, { rom: 'blue.nes', detail: 'X' })),
      [
        '正在运行 blue.nes · 256×240 · 48 kHz 立体声',
        '已停止。',
        '已被其他媒体源替换。',
        '模拟器已停止：X',
        '模拟器已停止：媒体源已结束。',
        '错误：X',
        '错误：准备首批音视频缓冲超时。',
        '错误：等待模拟器媒体源启动超时。',
        '错误：启动超时。',
        '错误：音频设备未就绪。',
        '请加载 iNES ROM 文件。',
      ],
    );
    assert.equal(host.translate("While this window is in front, these keys control the game. The player's shortcuts are not affected."),
      '本窗口在前台时，以下按键操作游戏；播放器的快捷键不受影响。');

    await load(host, window, files.blue);
    assert.equal(status(), '正在运行 blue.nes · 256×240 · 48 kHz 立体声');
    const { title } = host.sent('dialogs.open')[0];
    assert.equal(title, 'Load NES ROM', 'the declared English; the player translates it');
    assert.equal(host.translate(title), '加载 NES ROM');
    await host.press('F4');
    await until(() => status() === '已停止。', 'stopped by F4');

    host.dialogAnswers.push([files.missing]);
    await host.command('nes.load').run();
    await until(() => status() === '错误：找不到 ROM 文件。', 'missing ROM');
    assert.equal(window().props.running, false);
  } finally {
    await stop();
    await files.remove();
  }
});

test('the menu entry and the window button pick a ROM and play it as a generated stream', async () => {
  const files = await roms();
  const statuses = [];
  const { host, stop, window, status } = await start();
  try {
    await load(host, window, files.blue);
    assert.equal(status(), running('blue.nes'));
    assert.equal(host.sent('dialogs.open')[0].title, 'Load NES ROM');
    assert.deepEqual(host.sent('source.submit').map(p => p.intent.kind), ['openProvider']);
    const producer = host.producers.get(1);
    const before = producer.receivedFrames;
    await until(() => producer.receivedFrames > before + 4800, 'paced frames');
    assert.ok(producer.videoFrames > 0);

    host.dialogAnswers.push(null); // a cancelled picker changes nothing
    window().emit('load-rom');
    await until(() => host.sent('dialogs.open').length === 2, 'second picker');
    await host.settle(30);
    assert.equal(status(), running('blue.nes'));
    assert.equal(producer.released, false);

    // A ROM after a ROM: the first stream goes, the window never says "Replaced".
    const watch = setInterval(() => statuses.push(status()), 1);
    host.dialogAnswers.push([files.upper]);
    window().emit('load-rom');
    await until(() => status() === running('GAME.NES') && window().props.running === true, 'button ROM');
    await until(() => producer.released, 'the first stream released');
    await host.settle(30);
    clearInterval(watch);
    assert.equal(status(), running('GAME.NES'));
    assert.ok(!statuses.includes('Replaced by another source.'), statuses.join(' | '));
    assert.equal(playing(host), true);
    assert.equal(host.producers.get(2).released, false);
  } finally {
    await stop();
    await files.remove();
  }
  assert.ok([...host.producers.values()].every(p => p.released), 'deactivation releases the streams');
});

test('a .nes opened elsewhere (Open File, playlist) or dropped on the video is not ours', async () => {
  const files = await roms();
  const { host, stop, window, status } = await start();
  try {
    host.openElsewhere(files.blue);
    await host.settle(30);
    assert.equal(host.source.kind, 'media', 'the player opens it as a plain file');
    await host.drop([files.red], { target: 'video' });
    await host.settle(30);
    assert.equal(host.producers.size, 0);
    assert.deepEqual(host.sent('dialogs.open'), []);
    assert.equal(status(), 'Load an iNES ROM file.');
    assert.equal(window().props.running, false);
  } finally {
    await stop();
    await files.remove();
  }
});

for (const retire of [true, false]) {
  test(`replacement by another source says so; a ROM loaded next runs (${mode(retire)})`, async () => {
    const files = await roms();
    const { host, stop, window, status } = await start(undefined, undefined, { retire });
    try {
      await load(host, window, files.blue);
      host.openElsewhere('/media/movie.mp4');
      await until(() => status() === 'Replaced by another source.', 'replacement');
      await until(() => host.producers.get(1).released, 'first stream released');
      await until(() => window().props.running === false, 'running false'); // props are written one by one
      assert.equal(host.sent('source.submit').some(p => p.intent.kind === 'close'), false, 'never closes a source it no longer owns');
      assert.equal(host.source.source, '/media/movie.mp4');

      await load(host, window, files.red);
      assert.equal(status(), running('red.nes'));
      await host.settle(30);
      assert.equal(host.producers.get(2).released, false);
    } finally {
      await stop();
      await files.remove();
    }
  });

  test(`closing the source (F4) stops the game and says Stopped. (${mode(retire)})`, async () => {
    const files = await roms();
    const { host, stop, window, status } = await start(undefined, undefined, { retire });
    try {
      await load(host, window, files.blue);
      await host.press('F4');
      await until(() => status() === 'Stopped.', 'stopped by F4');
      await until(() => window().props.running === false, 'running false'); // props are written one by one
      await until(() => host.producers.get(1).released, 'released');
      assert.equal(host.source.phase, 'empty');
    } finally {
      await stop();
      await files.remove();
    }
  });
}

test('a bad ROM fails with the plugin wording and leaves the running game alone', async () => {
  const files = await roms();
  const { host, stop, window, status } = await start();
  const cases = [
    [files.bad, 'This is not an NES ROM in iNES format.'],
    [files.truncated, 'The ROM file is incomplete: shorter than its header says.'],
    [files.large, 'The ROM file is larger than the 16 MiB limit.'],
    [files.missing, 'The ROM file was not found.'],
    [files.folder, 'This is a folder, not a ROM file.'],
  ];
  try {
    await load(host, window, files.blue);
    for (const [path, message] of cases) {
      host.dialogAnswers.push([path]);
      await host.command('nes.load').run();
      await until(() => status() === `Error: ${message}`, `status for ${path}`);
    }
    assert.equal(host.producers.size, 1, 'a bad ROM never prepares a stream');
    assert.equal(host.producers.get(1).released, false, 'the game that runs keeps running');
    assert.equal(window().props.running, true, 'Stop stays enabled');
    assert.equal(playing(host), true);
  } finally {
    await stop();
    await files.remove();
  }
});

// The real host fails a selected producer source whose transport closes
// ("producer transport closed"): the source must already be closed when the
// plugin drops the connection.
test('Stop (window button, menu) closes the source before the producer transport', async () => {
  const files = await roms();
  const closedUnder = [];
  const { host, stop, window, status } = await start(async (method, params, next) => {
    const result = await next();
    if (method === 'producer.prepare') {
      host.producers.get(result.producerId).server.on('connection', socket =>
        socket.on('close', () => closedUnder.push(`${host.source.source} ${host.source.phase}`)));
    }
    return result;
  });
  try {
    await load(host, window, files.blue);
    window().emit('stop');
    await until(() => status() === 'Stopped.', 'stopped');
    await until(() => closedUnder.length === 1, 'transport closed');
    assert.equal(closedUnder[0], 'null empty', 'closed before its transport');
    assert.equal(host.producers.get(1).droppedWhileSelected, false);
    assert.equal(host.producers.get(1).released, true);

    await load(host, window, files.red);
    await host.command('nes.stop').run();
    assert.equal(status(), 'Stopped.');
    await until(() => window().props.running === false, 'running false'); // props are written one by one
    await until(() => closedUnder.length === 2, 'second transport closed');
    assert.equal(closedUnder[1], 'null empty');
    assert.equal(host.source.phase, 'empty');

    const submits = host.sent('source.submit').length;
    window().emit('stop'); // nothing running: still reports Stopped. and submits nothing
    await host.settle(30);
    assert.equal(status(), 'Stopped.');
    assert.equal(host.sent('source.submit').length, submits);
  } finally {
    await stop();
    await files.remove();
  }
});

test('stream failures keep the plugin wording', async () => {
  const files = await roms();
  let health = 'deviceLost';
  let lost = null;
  const { host, stop, window, status } = await start(async (method, params, next) => {
    const result = await next();
    if (method !== 'producer.state') return result;
    return { ...result, health: result.active ? result.health : health, error: lost };
  });
  try {
    // The audio device is not ready: the start fails, nothing plays.
    host.dialogAnswers.push([files.blue]);
    await host.command('nes.load').run();
    await until(() => status() === 'Error: the audio device is not ready.', 'device status');
    await until(() => host.producers.get(1).released, 'released');
    assert.equal(window().props.running, false);

    health = 'ok';
    await load(host, window, files.blue);
    lost = 'audio output lost';
    await until(() => status() === 'Emulator stopped: audio output lost', 'stream error');
    await until(() => window().props.running === false, 'running false'); // props are written one by one
    await until(() => host.producers.get(2).released, 'released');
  } finally {
    await stop();
    await files.remove();
  }
});

test('a running game whose frame fails shows the plugin reason in the window, translated', async () => {
  const files = await roms();
  const { host, stop, window, status } = await start(undefined, undefined, { locale: 'zh-Hans' });
  const frame = NesCore.prototype.frame;
  try {
    await load(host, window, files.blue);
    NesCore.prototype.frame = function () {
      throw this.error('The emulator produced invalid audio data.');
    };
    await until(() => status() === '模拟器已停止：模拟器音频数据无效。', 'halted');
    assert.equal(window().props.running, false);
  } finally {
    NesCore.prototype.frame = frame;
    await stop();
    await files.remove();
  }
});

/** Slint's key text of → (`Key.RightArrow`). */
const RIGHT = String.fromCharCode(0xf703);

test('window keys reach the running game only; focus loss, Stop, closing the window and a replacement release every button', async () => {
  const files = await roms();
  const calls = [];
  const { button, releaseAll } = NesCore.prototype;
  NesCore.prototype.button = function (name, down) {
    calls.push(`${name} ${down ? 'down' : 'up'}`);
    return button.call(this, name, down);
  };
  NesCore.prototype.releaseAll = function () {
    calls.push(`release all [${this.pressed.join(' ')}]`);
    return releaseAll.call(this);
  };
  const { host, stop, window } = await start();
  /** Send callbacks from the window, then wait until the plugin has seen `count` calls. */
  const keys = async (count, ...events) => {
    for (const [name, ...args] of events) window().emit(name, ...args);
    await host.settle(30);
    await until(() => calls.length >= count, `${count} calls`);
    assert.equal(calls.length, count, calls.join(' | '));
  };
  try {
    await keys(0, ['key', 'x', true, false], ['release-all']); // no game: nothing
    await load(host, window, files.pad);
    await keys(3, ['key', RIGHT, true, false], ['key', 'x', true, false], ['key', RIGHT, false, false]);
    await keys(3, ['key', 'q', true, false], ['key', 'q', false, false], ['key', 'X', true, false]); // not a game key; a repeat
    await keys(5, ['release-all']); // the window lost the focus

    await keys(6, ['key', 's', true, false]);
    window().emit('stop');
    await until(() => calls.length === 8, 'released on Stop');
    await until(() => window().props.running === false, 'stopped');
    await keys(8, ['key', 's', true, false]); // stopped: ignored

    await load(host, window, files.pad);
    await keys(9, ['key', 'z', true, false]);
    await host.window('nes').userClose(); // Ctrl+W, Ctrl+F4 or the title bar, with Z down
    await until(() => calls.length === 11, 'released on close');
    await host.command('nes.window').run();
    await keys(12, ['key', 'z', true, false]);
    host.openElsewhere('/media/movie.mp4');
    await until(() => calls.length === 14, 'released on replacement');
    await keys(14, ['key', 'z', false, false]); // no game: ignored
    assert.deepEqual(calls, [
      'right down', 'a down', 'right up',
      'release all [a]', 'a up',
      'start down', 'release all [start]', 'start up',
      'b down', 'release all [b]', 'b up',
      'b down', 'release all [b]', 'b up',
    ]);
  } finally {
    NesCore.prototype.button = button;
    NesCore.prototype.releaseAll = releaseAll;
    await stop();
    await files.remove();
  }
});

test('a ROM too slow to emulate is stopped with its reason (the watchdog), in both languages', async () => {
  for (const locale of ['en', 'zh-Hans']) {
    const files = await roms();
    const { host, stop, window, status } = await start(undefined, undefined, locale === 'en' ? {} : { locale });
    const now = timing.now;
    try {
      await load(host, window, files.blue);
      let clock = 0;
      timing.now = () => (clock += 150); // every frame now takes 150 ms
      const expected = locale === 'en'
        ? 'Emulator stopped: This ROM is too slow to emulate (it may be damaged).'
        : '模拟器已停止：这个 ROM 模拟起来太慢（文件可能已损坏）。';
      await until(() => status() === expected, 'watchdog');
      await until(() => window().props.running === false, 'running false');
      await until(() => host.producers.get(1).released, 'released');
    } finally {
      timing.now = now;
      await stop();
      await files.remove();
    }
  }
});
