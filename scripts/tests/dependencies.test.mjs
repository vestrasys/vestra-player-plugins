// npm dependencies of hosted plugins (scripts/lib/dependencies.mjs): the
// static rules on synthetic plugins, and the whole path (install, build,
// pack, package check, index build and the signing job's artifact check) on
// the fixtures in fixtures/npm-deps/, each a repository root with one plugin:
//
//   allowed/   someone.tiny      escape-string-regexp (MIT): accepted
//   copyleft/  someone.copyleft  chessground (GPL-3.0-or-later): refused
//   native/    someone.native    bufferutil (binding.gyp, prebuilt .node): refused
//
// The accepted fixture and the native-code scan install from the npm
// registry (`npm ci --ignore-scripts`), so these tests need the network.
// The fixtures stay inside the repository so that the bundler resolves
// esbuild from the repository root, as for the plugins in plugins/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { after, before, test } from "node:test";
import { buildIndex } from "../lib/build.mjs";
import {
  dependencyProblems,
  installedProblems,
  PACKAGE_LIMIT,
  prepareDependencies,
  sizeProblems,
  spdxAllowed,
  UNPACKED_LIMIT,
} from "../lib/dependencies.mjs";
import { releases } from "../lib/publishing.mjs";
import { checkArtifact } from "../lib/release.mjs";

const repository = resolve(import.meta.dirname, "../..");
const fixtures = join(import.meta.dirname, "fixtures/npm-deps");
const plugin = {
  allowed: join(fixtures, "allowed/plugins/tiny"),
  copyleft: join(fixtures, "copyleft/plugins/copyleft"),
  native: join(fixtures, "native/plugins/native"),
};
const repo = "vestrasys/vestra-player-plugins";
const pagesUrl = "https://vestrasys.github.io/vestra-player-plugins/";
let work;

before(async () => {
  work = await mkdtemp(join(tmpdir(), "vestra-npm-deps-"));
});
after(async () => {
  await rm(work, { recursive: true, force: true });
  for (const directory of Object.values(plugin))
    await rm(join(directory, "dist"), { recursive: true, force: true });
});

const node = (...args) =>
  spawnSync(process.execPath, args, { cwd: repository, encoding: "utf8" });

/** Names in a zip and their contents (stored and deflate). */
function unzip(bytes) {
  let end = bytes.length - 22;
  while (bytes.readUInt32LE(end) !== 0x06054b50) end--;
  const files = new Map();
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    const start =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    offset +=
      46 +
      nameLength +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
  }
  return files;
}

// ------------------------------------------------------------ static rules

test("SPDX expressions: OR needs one side, AND both", () => {
  assert.equal(spdxAllowed("MIT"), true);
  assert.equal(spdxAllowed("(Apache-2.0 AND BSD-3-Clause)"), true);
  assert.equal(spdxAllowed("(MIT OR GPL-3.0-or-later)"), true);
  assert.equal(spdxAllowed("GPL-3.0-or-later"), false);
  assert.equal(spdxAllowed("AGPL-3.0-only"), false);
  assert.equal(spdxAllowed("LGPL-2.1-or-later"), false);
  assert.equal(spdxAllowed("MIT AND GPL-2.0-only"), false);
  assert.throws(() => spdxAllowed("SEE LICENSE IN LICENSE.txt"));
});

/** A synthetic plugin directory with this package.json and lockfile. */
async function synthetic(name, json, lock) {
  const directory = join(work, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify(json));
  if (lock)
    await writeFile(join(directory, "package-lock.json"), JSON.stringify(lock));
  return directory;
}

const good = {
  name: "x",
  private: true,
  type: "module",
  dependencies: { a: "1.0.0" },
  vestra: { bundle: true, assets: ["licenses"] },
};
const lockOf = (entry = {}, root = {}) => ({
  lockfileVersion: 3,
  packages: {
    "": { dependencies: { a: "1.0.0" }, ...root },
    "node_modules/a": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
      integrity: "sha512-AAAA",
      license: "MIT",
      ...entry,
    },
  },
});
const problemsOf = async (name, json, lock) =>
  (
    await dependencyProblems(await synthetic(name, json, lock), name, {
      inventory: false,
    })
  ).join("\n");

test("a well-formed lockfile passes the static rules", async () => {
  assert.equal(await problemsOf("ok", good, lockOf()), "");
});

test("the lockfile is required and must match package.json", async () => {
  assert.match(
    await problemsOf("nolock", good),
    /package-lock.json is required/,
  );
  assert.match(
    await problemsOf(
      "stale",
      { ...good, dependencies: { a: "2.0.0" } },
      lockOf(),
    ),
    /does not match package.json/,
  );
});

test("package.json: no devDependencies, install scripts or unbundled dependencies", async () => {
  assert.match(
    await problemsOf(
      "dev",
      { ...good, devDependencies: { esbuild: "1" } },
      lockOf(),
    ),
    /no devDependencies/,
  );
  assert.match(
    await problemsOf(
      "script",
      { ...good, scripts: { postinstall: "x" } },
      lockOf(),
    ),
    /no "postinstall" script/,
  );
  assert.match(
    await problemsOf(
      "external",
      { ...good, vestra: { bundle: { external: ["a"] } } },
      lockOf(),
    ),
    /"bundle": true/,
  );
  assert.match(
    await problemsOf(
      "assets",
      {
        ...good,
        vestra: { bundle: true, assets: ["licenses", "node_modules/a"] },
      },
      lockOf(),
    ),
    /must not ship node_modules/,
  );
  // The SDK leaves LICENSE.md out unless licenses/ is an asset.
  assert.match(
    await problemsOf(
      "no-assets",
      { ...good, vestra: { bundle: true } },
      lockOf(),
    ),
    /needs "licenses" in vestra.assets/,
  );
});

test("locked packages: registry sources, no scripts, no native builds, allowed licenses", async () => {
  const cases = [
    [{ resolved: "git+https://github.com/a/a.git" }, /registry.npmjs.org/],
    [{ resolved: "file:../a" }, /registry.npmjs.org/],
    [{ integrity: "sha1-AAAA" }, /sha512 integrity/],
    [{ hasInstallScript: true }, /install script/],
    [{ os: ["win32"] }, /prebuilt native binary/],
    [{ cpu: ["x64"] }, /prebuilt native binary/],
    [{ optional: true }, /only runtime dependencies/],
    [{ link: true }, /links are not allowed/],
    [{ license: "GPL-3.0-only" }, /GPL-3.0-only is not allowed/],
    [{ license: "AGPL-3.0-or-later" }, /not allowed/],
    [{ license: undefined }, /no license/],
  ];
  let n = 0;
  for (const [entry, expected] of cases)
    assert.match(
      await problemsOf(`entry-${++n}`, good, lockOf(entry)),
      expected,
      JSON.stringify(entry),
    );
});

test("the inventory must list the locked packages and their license files", async () => {
  const directory = await synthetic("inventory", good, lockOf());
  const all = async () =>
    (await dependencyProblems(directory, "inventory")).join("\n");
  assert.match(await all(), /dependency-inventory.json is required/);
  await writeFile(
    join(directory, "dependency-inventory.json"),
    JSON.stringify([
      {
        name: "a",
        version: "1.0.0",
        license: "MIT",
        licenseFiles: ["LICENSE"],
      },
    ]),
  );
  assert.match(await all(), /licenses\/a\/LICENSE is missing/);
  await mkdir(join(directory, "licenses/a"), { recursive: true });
  await writeFile(join(directory, "licenses/a/LICENSE"), "MIT License\n");
  assert.equal(await all(), "");
  await mkdir(join(directory, "licenses/stale"));
  assert.match(await all(), /licenses\/stale belongs to no locked package/);
});

test("size limits", () => {
  assert.deepEqual(sizeProblems("p", PACKAGE_LIMIT, UNPACKED_LIMIT), []);
  assert.match(sizeProblems("p", PACKAGE_LIMIT + 1)[0], /the package is/);
  assert.match(
    sizeProblems("p", undefined, UNPACKED_LIMIT + 1)[0],
    /unpacks to/,
  );
});

// ------------------------------------------------------------ the fixtures

test("allowed: build, pack and the package check bundle the dependency with its license", async () => {
  const build = node("scripts/plugin.mjs", "build", plugin.allowed);
  assert.equal(build.status, 0, build.stderr);
  const bundle = await readFile(join(plugin.allowed, "dist/main.js"), "utf8");
  assert.match(bundle, /function escapeStringRegexp/);
  assert.doesNotMatch(bundle, /from "escape-string-regexp"/);

  const out = join(work, "pack-allowed");
  const pack = node("scripts/plugin.mjs", "pack", plugin.allowed, "--out", out);
  assert.equal(pack.status, 0, pack.stderr);
  const checked = node("scripts/check-package.mjs", plugin.allowed, out);
  assert.equal(checked.status, 0, checked.stderr);

  const files = unzip(await readFile(join(out, "someone.tiny-1.0.0.vxp")));
  assert.ok(files.has("dependency-inventory.json"));
  assert.ok(files.has("licenses/escape-string-regexp/license"));
  assert.ok(![...files.keys()].some((name) => name.includes("node_modules")));
  assert.ok(!files.has("package-lock.json"));
});

test("allowed: the index dry run packs it and the signing job's check accepts it", async () => {
  const out = join(work, "index-allowed");
  const { index, packed } = await buildIndex({
    root: join(fixtures, "allowed"),
    out,
    repo,
    pagesUrl,
    previous: null,
    releases: releases.fixture({}),
    log: () => {},
  });
  assert.deepEqual(
    packed.map(({ id, version }) => `${id}@${version}`),
    ["someone.tiny@1.0.0"],
  );
  assert.equal(index.plugins[0].id, "someone.tiny");
  const { problems, create } = await checkArtifact({
    artifact: out,
    index,
    revoked: [],
    previous: null,
    repo,
    pagesUrl,
    releases: releases.fixture({}),
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(
    create.map((item) => item.tag),
    ["someone.tiny-v1.0.0"],
  );
});

for (const [kind, expected] of [
  ["copyleft", /chessground: license GPL-3.0-or-later is not allowed/],
  ["native", /bufferutil: has an install script/],
]) {
  test(`${kind}: refused by the registry rules, build, pack and the index build`, async () => {
    const directory = plugin[kind];
    assert.match(
      (await dependencyProblems(directory, kind)).join("\n"),
      expected,
    );
    for (const command of ["build", "pack"]) {
      const result = node(
        "scripts/plugin.mjs",
        command,
        directory,
        "--out",
        join(work, `refused-${kind}`),
      );
      assert.equal(result.status, 1, `${command} must fail`);
      assert.match(result.stderr, expected);
    }
    await assert.rejects(
      buildIndex({
        root: join(fixtures, kind),
        out: join(work, `index-${kind}`),
        repo,
        pagesUrl,
        previous: null,
        releases: releases.fixture({}),
        log: () => {},
      }),
      expected,
    );
  });
}

test("native: a lockfile that hides the install script is still refused once installed", async () => {
  // The lockfile is the author's file: drop npm's hasInstallScript marker.
  const directory = join(work, "native-hidden");
  await cp(plugin.native, directory, {
    recursive: true,
    filter: (path) => !/node_modules|dist/.test(path),
  });
  const lockFile = join(directory, "package-lock.json");
  const lock = JSON.parse(await readFile(lockFile, "utf8"));
  delete lock.packages["node_modules/bufferutil"].hasInstallScript;
  await writeFile(lockFile, JSON.stringify(lock, null, 2));

  assert.deepEqual(await prepareDependencies(directory, "hidden"), []);
  const { problems } = await installedProblems(directory, "hidden");
  const text = problems.join("\n");
  assert.match(text, /bufferutil: has an install script "install"/);
  assert.match(text, /bufferutil\/binding\.gyp: native code/);
  assert.match(text, /bufferutil\/prebuilds\/.+\.node: native code/);
});
