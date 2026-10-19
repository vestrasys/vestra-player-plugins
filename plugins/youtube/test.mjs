import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeYouTubeUrl, descriptorFromInfo, YouTubeService } from './dist/service.js';
test('normalizes video forms and rejects lookalike domains, credentials, playlists and shell text', () => {
  for (const value of ['https://youtu.be/BaW_jenozKc?t=2', 'https://www.youtube.com/shorts/BaW_jenozKc', 'https://music.youtube.com/watch?v=BaW_jenozKc&list=abc']) assert.equal(normalizeYouTubeUrl(value), 'https://www.youtube.com/watch?v=BaW_jenozKc');
  for (const value of ['https://youtube.com.evil/watch?v=BaW_jenozKc', 'https://u:p@youtube.com/watch?v=BaW_jenozKc', 'https://youtube.com/playlist?list=abc', '$(touch /tmp/oops)', 'http://youtu.be/BaW_jenozKc']) assert.throws(() => normalizeYouTubeUrl(value));
});
test('split tracks and per-stream headers survive; silent video is rejected', () => {
  const raw = { title: 'Test', http_headers: { Referer: 'https://youtube.com/', Bad: 'a\nb' }, requested_formats: [{ url: 'https://cdn.test/video', vcodec: 'vp9', acodec: 'none' }, { url: 'https://cdn.test/audio', vcodec: 'none', acodec: 'opus', http_headers: { 'User-Agent': 'test' } }] };
  const media = descriptorFromInfo('https://youtu.be/BaW_jenozKc', raw);
  assert.equal(media.primary.url, 'https://cdn.test/video'); assert.equal(media.audio.url, 'https://cdn.test/audio'); assert.equal(media.audio.headers['User-Agent'], 'test'); assert.equal(media.primary.headers.Bad, undefined);
  assert.throws(() => descriptorFromInfo('original', { requested_formats: [raw.requested_formats[0]] }), /complete video and audio/);
});
test('failed download cleans staging and preserves existing destination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vestra-yt-test-')); const path = join(dir, 'saved.mkv');
  await writeFile(path, 'original');
  const service = new YouTubeService(async args => { if (args.includes('--version')) return '2026.08.19'; throw new Error('network failed'); });
  try { await assert.rejects(service.download('https://youtu.be/BaW_jenozKc', path), /network failed/); assert.equal(await readFile(path, 'utf8'), 'original'); assert.deepEqual(await readdir(dir), ['saved.mkv']); } finally { await rm(dir, { recursive: true }); }
});
test('success commits complete output and progress is parsed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vestra-yt-test-')); const path = join(dir, 'saved.mkv'); const progress = [];
  const service = new YouTubeService(async (args, options) => {
    if (args.includes('--version')) return '2026.08.19';
    const template = args[args.indexOf('-o') + 1]; await writeFile(template.replace('%(ext)s', 'mkv'), 'complete');
    options.onLine('VESTRA_PROGRESS: 50.0%'); return '';
  });
  try { await service.download('https://youtu.be/BaW_jenozKc', path, undefined, value => progress.push(value)); assert.equal(await readFile(path, 'utf8'), 'complete'); assert.equal(progress.at(-1).percent, 50); } finally { await rm(dir, { recursive: true }); }
});
test('pre-aborted download never invokes download runner', async () => {
  let calls = 0; const service = new YouTubeService(async () => { calls++; return '2026.08.19'; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.download('https://youtu.be/BaW_jenozKc', '/tmp/no-write.mkv', controller.signal), /Cancelled/); assert.equal(calls, 1);
});

const { YouTubePlayback } = await import('./dist/playback.js');
const ticket = { stamp: { generation: 1, intentVersion: 1 }, cycle: 1, owner: 7 };
const readyState = { stamp: ticket.stamp, cycle: 1, source: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', phase: 'ready' };
test('play uses original URL and waits for public ready state', async () => {
  const submitted = [], states = ['loading', 'ready'], messages = [];
  const source = { submit: async (intent, id) => { submitted.push({ intent, id }); return { status: 'pending', ticket }; }, state: async () => ({ ...readyState, phase: states.shift() }), operation: async () => ({ status: 'pending', ticket }) };
  await new YouTubePlayback(source, async () => {}).open(readyState.source, new AbortController().signal, async m => messages.push(m));
  assert.equal(submitted.length, 1); assert.equal(submitted[0].intent.source, readyState.source); assert.match(messages.at(-1), /就绪/);
});
test('uncertain submission is queried by same operation ID without re-opening', async () => {
  let submitted = 0; const queried = [];
  const source = { submit: async () => { submitted++; throw new Error('timeout'); }, operation: async id => { queried.push(id); return { status: 'pending', ticket }; }, state: async () => readyState };
  await new YouTubePlayback(source, async () => {}).open(readyState.source, new AbortController().signal, async () => {});
  assert.equal(submitted, 1); assert.deepEqual(queried, [1]);
});
test('cancel closes only its ticket using CAS and a new operation ID', async () => {
  const controller = new AbortController(), submissions = [];
  const source = { submit: async (intent, id) => { submissions.push({ intent, id }); if (intent.kind === 'open') controller.abort(); return { status: 'pending', ticket }; }, operation: async () => ({ status: 'pending', ticket }), state: async () => readyState };
  await assert.rejects(new YouTubePlayback(source, async () => {}).open(readyState.source, controller.signal, async () => {}), /Cancelled/);
  assert.deepEqual(submissions[1], { intent: { kind: 'close', expected: ticket.stamp }, id: 2 });
});
test('backend failure and replacement cannot be reported as ready', async () => {
  for (const state of [{ ...readyState, phase: 'error', terminalReason: { failed: 'bot sign-in required' } }, { ...readyState, stamp: { generation: 1, intentVersion: 2 } }]) {
    const messages = [];
    const source = { submit: async () => ({ status: 'pending', ticket }), operation: async () => ({ status: 'pending', ticket }), state: async () => state };
    await assert.rejects(new YouTubePlayback(source, async () => {}).open(readyState.source, new AbortController().signal, async m => messages.push(m)), /bot sign-in|required|替换/);
    assert.equal(messages.length, 0);
  }
});
test('activation registers only public resolver and unload disposes its lease', async () => {
  const { activate } = await import('./dist/main.js'); let declaration, disposed = false;
  const host = { source: {}, sourceResolvers: { register: async d => { declaration = d; return { dispose: async () => { disposed = true; } }; } }, commands: { register: async () => {}, onExecute: () => () => {} }, ui: { onCallback: () => () => {} } };
  const stop = await activate(host); assert.equal(declaration.id, 'youtube'); assert.deepEqual(declaration.schemes, ['https']); assert.ok(declaration.hosts.includes('youtu.be')); await stop(); assert.equal(disposed, true);
});
