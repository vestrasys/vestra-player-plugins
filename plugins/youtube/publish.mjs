import { readdir, readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const source = new URL('.', import.meta.url).pathname;
const destination = process.argv[2];
if (!destination || !destination.endsWith('/src/plugins/youtube')) throw new Error('Pass the exact repo src/plugins/youtube destination.');
const paths = [];
async function list(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) await list(join(dir, entry.name), path + '/');
    else if (path !== 'freeze-ready.json' && !path.endsWith('.mkv') && !path.endsWith('.typecheck.ts')) paths.push(path);
  }
}
await list(source);
const files = [];
for (const path of paths.sort()) {
  const bytes = await readFile(join(source, path));
  if (!bytes.length) throw new Error(`Refusing empty file ${path}`);
  files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  await mkdir(join(destination, path, '..'), { recursive: true });
  const temporary = join(destination, path + '.stage');
  await writeFile(temporary, bytes); await rename(temporary, join(destination, path));
}
const freeze = JSON.stringify({ schema: 1, package: 'youtube', version: '0.1.1', candidate: 'public-source-resolver-playback', readyForCompiler: true, site01Integrated: true, realMpvPlaybackVerified: false, nativeVerified: false, files }, null, 2) + '\n';
await writeFile(join(source, 'freeze-ready.json'), freeze);
await writeFile(join(destination, 'freeze-ready.json.stage'), freeze);
await rename(join(destination, 'freeze-ready.json.stage'), join(destination, 'freeze-ready.json'));
console.log(JSON.stringify({ files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0), freezeSHA256: createHash('sha256').update(freeze).digest('hex') }));
