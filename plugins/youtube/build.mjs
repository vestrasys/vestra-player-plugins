import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const tsc = process.env.VESTRA_TSC ?? '/tmp/vestra-rebuild-toolchain-20261018/node_modules/typescript/lib/_tsc.js';
const typeRoots = process.env.VESTRA_TYPE_ROOTS ?? '/tmp/vestra-rebuild-toolchain-20261018/node_modules/@types';
const sdk = process.env.VESTRA_SDK ?? (existsSync(new URL('../../sdk/index.ts', import.meta.url)) ? new URL('../../sdk/index.ts', import.meta.url).pathname : '/tmp/vestra-current-runtime-cache/sdk/index.ts');
const checked = new URL('main.typecheck.ts', import.meta.url);
writeFileSync(checked, readFileSync(new URL('main.ts', import.meta.url), 'utf8').replace('../../sdk/index.ts', sdk));
const checkedPlayback = new URL('playback.typecheck.ts', import.meta.url);
writeFileSync(checkedPlayback, readFileSync(new URL('playback.ts', import.meta.url), 'utf8').replaceAll('../../sdk/index.ts', sdk).replaceAll('../../sdk/source.ts', join(dirname(sdk), 'source.ts')));
writeFileSync(checked, readFileSync(checked, 'utf8').replace('./playback.js', './playback.typecheck.js'));
const result = spawnSync(process.execPath, [tsc, '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--types', 'node', '--typeRoots', typeRoots, '--allowImportingTsExtensions', '--noEmit', 'main.typecheck.ts', 'service.ts', 'playback.typecheck.ts'], { cwd: new URL('.', import.meta.url), stdio: 'inherit' });
unlinkSync(checked); unlinkSync(checkedPlayback);
if (result.status !== 0) process.exit(result.status ?? 1);
const ts = require(join(dirname(tsc), 'typescript.js'));
mkdirSync(new URL('dist', import.meta.url), { recursive: true });
for (const name of ['main', 'service', 'playback']) {
  const result = ts.transpileModule(readFileSync(new URL(`${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, fileName: `${name}.ts` });
  writeFileSync(new URL(`dist/${name}.js`, import.meta.url), result.outputText);
}
copyFileSync(new URL('youtube.slint', import.meta.url), new URL('dist/youtube.slint', import.meta.url));
copyFileSync(new URL('manifest.production.json', import.meta.url), new URL('dist/manifest.json', import.meta.url));
writeFileSync(new URL('dist/package.json', import.meta.url), '{"type":"module"}\n');
