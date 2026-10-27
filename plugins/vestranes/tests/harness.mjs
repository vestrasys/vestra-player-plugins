// Shared set-up for the plugin tests: the real SDK against the in-memory TestHost.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HostError, startPlugin, TestHost } from '@vestra-player/sdk/testing';
import activate from '../main.ts';
import { controllerRom, homebrew } from './homebrew.mjs';

const directory = new URL('..', import.meta.url);

/** The window's status while `name` runs (English). */
export const running = name => `Running ${name} · 256×240 · 48 kHz stereo`;

/**
 * nes.slint's status line, read from the file itself: each `state` with its
 * `@tr` template (and the argument it takes), then the fallback.
 */
const slint = await fs.readFile(new URL('nes.slint', directory), 'utf8');
const wording = new Map(
  [...slint.matchAll(/root\.state == "(\w+)" \? @tr\("([^"]+)"(?:, root\.(\w+))?\)/g)].map(([, state, text, arg]) => [state, { text, arg }]),
);
const fallback = { text: /\n\s*: @tr\("([^"]+)"\);/.exec(slint)[1] };

/** The status line the window shows for its props, in the host's language. */
export function statusText(host, props) {
  const { text, arg } = wording.get(props.state) ?? fallback;
  return host.translate(text, arg ? [props[arg]] : undefined);
}

/** Write generated ROMs (and malformed ones) to a scratch directory. */
export async function roms() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nes-plugin-test-'));
  const write = async (name, bytes) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, bytes);
    return file;
  };
  return {
    blue: await write('blue.nes', homebrew(0x21)),
    red: await write('red.nes', homebrew(0x16)),
    upper: await write('GAME.NES', homebrew(0x2a)),
    pad: await write('pad.nes', controllerRom()),
    bad: await write('bad.nes', new Uint8Array(100)),
    truncated: await write('truncated.nes', homebrew().subarray(0, 4096)),
    large: await (async () => {
      const file = await write('large.nes', homebrew());
      await fs.truncate(file, 16 * 1024 * 1024 + 1); // sparse: nothing is written
      return file;
    })(),
    missing: path.join(dir, 'missing.nes'),
    folder: dir,
    movie: path.join(dir, 'movie.mp4'),
    remove: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Start the plugin. `intercept(method, params, next)` may delay or rewrite any
 * host request while keeping the TestHost's own behaviour behind `next()`;
 * `host` may be prepared beforehand; `locale` is the
 * interface language the TestHost plays (English by default).
 *
 * `retire` (default true) acts like the real player, which retires the
 * producer of a stream that was replaced or closed: its `producer.state`
 * then fails with `unavailable: producer absent` (the TestHost keeps it and
 * answers `active: false`).
 */
export async function start(intercept, host = new TestHost(), { retire = true, locale } = {}) {
  const request = host.request.bind(host);
  const ran = new Set();
  host.request = async (method, params = {}) => {
    const result = await (intercept ? intercept(method, params, () => request(method, params)) : request(method, params));
    if (retire && method === 'producer.state') {
      const id = Number(params.producerId);
      if (result.active) ran.add(id);
      else if (ran.has(id)) throw new HostError('unavailable', 'producer absent');
    }
    return result;
  };
  const started = await startPlugin(activate, { directory, host, ...(locale ? { locale } : {}) });
  // The tool window shows the status: open it, as a user watching it would.
  await host.command('nes.window').run();
  const window = () => host.windows.get('nes') ?? assert.fail('window not open');
  /** The status line as the user reads it. */
  const status = () => statusText(host, window().props);
  return { ...started, window, status };
}

/** Poll until `predicate()` holds (stream pacing runs on timers). */
export async function until(predicate, what = 'condition') {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5)); // not settle(): a gated request never settles
  }
}

export const gate = () => {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
};
