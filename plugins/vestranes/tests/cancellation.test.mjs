import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, roms, running, start, until } from './harness.mjs';

// Where a start can be held: the stream's producer is being prepared (the
// first buffers), or the prepared stream is being made the player's source.
const pending = {
  prepare: method => method === 'producer.prepare',
  activation: (method, params) => method === 'source.submit' && params.intent?.kind === 'openProvider',
};

/** Start the plugin with the first request matching `matches` held until `blocked.open()`. */
async function held(matches) {
  const blocked = gate();
  let reached = false;
  const started = await start(async (method, params, next) => {
    if (!reached && matches(method, params)) {
      reached = true;
      await blocked.promise;
    }
    return next();
  });
  return { ...started, blocked, reached: () => reached };
}

const released = host => [...host.producers.values()].every(p => p.released);

for (const [boundary, matches] of Object.entries(pending)) {
  test(`Stop while the ${boundary} is pending: the game never starts and its producer is released`, async () => {
    const files = await roms();
    const { host, stop, window, status, blocked, reached } = await held(matches);
    try {
      host.dialogAnswers.push([files.blue]);
      await host.command('nes.load').run();
      await until(reached, boundary);
      await host.command('nes.stop').run();
      // The props reach the host after the command's reply: wait for them.
      await until(() => status() === 'Stopped.', 'stopped');
      blocked.open();
      await until(() => host.producers.size === 1 && released(host), 'release');
      await host.settle(50);
      assert.equal(status(), 'Stopped.', 'the cancelled start words nothing');
      assert.equal(window().props.running, false);
      assert.notEqual(host.source.kind === 'producer' && host.source.phase === 'ready', true, 'nothing plays');
    } finally {
      blocked.open();
      await stop();
      await files.remove();
    }
  });

  test(`a newer ROM while the ${boundary} is pending wins; the old one never starts`, async () => {
    const files = await roms();
    const { host, stop, window, status, blocked, reached } = await held(matches);
    try {
      host.dialogAnswers.push([files.blue]);
      await host.command('nes.load').run();
      await until(reached, boundary);
      host.dialogAnswers.push([files.red]);
      window().emit('load-rom');
      blocked.open();
      await until(() => status() === running('red.nes') && window().props.running === true, 'newer ROM');
      const live = () => [...host.producers.values()].filter(p => !p.released);
      await until(() => host.producers.size === 2 && live().length === 1, 'old producer released');
      await host.settle(50);
      assert.equal(status(), running('red.nes'));
      assert.equal(host.source.kind, 'producer');
      assert.equal(host.source.phase, 'ready');
    } finally {
      blocked.open();
      await stop();
      await files.remove();
    }
  });
}

test('deactivation while a start is pending releases its producer', async () => {
  const files = await roms();
  const { host, stop, blocked, reached } = await held(pending.prepare);
  try {
    host.dialogAnswers.push([files.blue]);
    await host.command('nes.load').run();
    await until(reached, 'prepare');
    const stopping = stop();
    blocked.open();
    await stopping;
    await until(() => released(host), 'release');
  } finally {
    blocked.open();
    await files.remove();
  }
});

test('a second picker while one is open is ignored', async () => {
  const files = await roms();
  const answer = gate();
  let asked = 0;
  const { host, stop, window } = await start(async (method, params, next) => {
    if (method === 'dialogs.open') {
      asked++;
      await answer.promise;
    }
    return next();
  });
  try {
    host.dialogAnswers.push([files.blue]);
    void host.command('nes.load').run();
    await until(() => asked === 1, 'picker');
    window().emit('load-rom'); // would need a second dialog answer if it were not ignored
    void host.command('nes.load').run();
    await host.settle(30);
    answer.open();
    await until(() => window().props.running === true, 'ROM');
    assert.equal(asked, 1);
    assert.equal(host.sent('producer.prepare').length, 1);
  } finally {
    answer.open();
    await stop();
    await files.remove();
  }
});

test('a picker failure (another dialog open) is shown, and the next Load works', async () => {
  const files = await roms();
  const { HostError } = await import('@vestra-player/sdk/testing');
  let busy = true;
  const { host, stop, window, status } = await start(async (method, params, next) => {
    if (method === 'dialogs.open' && busy) {
      busy = false;
      throw new HostError('busy', 'Another dialog is open.');
    }
    return next();
  });
  try {
    await host.command('nes.load').run();
    await until(() => status().startsWith('Error: '), 'busy');
    host.dialogAnswers.push([files.blue]);
    await host.command('nes.load').run();
    await until(() => status() === running('blue.nes') && window().props.running === true, 'ROM');
  } finally {
    await stop();
    await files.remove();
  }
});
