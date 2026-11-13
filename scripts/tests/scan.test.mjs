import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { buildIndex } from "../lib/build.mjs";
import { indexProblems, releases, serializeIndex } from "../lib/publishing.mjs";
import { checkArtifact } from "../lib/release.mjs";
import {
  SCAN_CATEGORIES,
  SCAN_SDK,
  scanEntry,
  scanProblems,
  scanRequired,
  sdkScanner,
} from "../lib/scan.mjs";
import { signIndex, verifyIndex } from "../lib/signing.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const repo = "vestrasys/vestra-player-plugins";
const pagesUrl = "https://vestrasys.github.io/vestra-player-plugins/";
const NOW = "2026-11-13T12:00:00.000Z";
const SCAN = { uses: ["player", "clipboard"], method: "types", sdk: "1.8.0" };
let work;
let count = 0;

before(async () => {
  work = await mkdtemp(join(tmpdir(), "vestra-scan-"));
});
after(() => rm(work, { recursive: true, force: true }));

/** A repository root with one plugin, plugins/demo (owner someone), at `version`. */
async function repository(version = "1.0.0") {
  const root = join(work, `repo-${++count}`);
  const plugin = join(root, "plugins/demo");
  await mkdir(plugin, { recursive: true });
  await writeFile(
    join(plugin, "manifest.json"),
    JSON.stringify({
      id: "someone.demo",
      version,
      apiVersion: "vestra/1",
      entry: "main.ts",
      name: "Demo",
    }),
  );
  await writeFile(join(root, "plugins/owners.toml"), 'demo = "someone"\n');
  await writeFile(join(root, "revoked.json"), "[]");
  await mkdir(join(root, "registry"));
  return root;
}

const fakePack = async (directory, id, version, out) => {
  const file = join(out, `${id}-${version}.vxp`);
  await writeFile(file, `package ${id}@${version}`);
  return file;
};

async function build(root, options = {}) {
  const out = join(work, `out-${++count}`);
  const result = await buildIndex({
    root,
    out,
    repo,
    pagesUrl,
    previous: null,
    releases: releases.fixture({}),
    now: NOW,
    pack: fakePack,
    log: () => {},
    ...options,
  });
  return { out, ...result };
}

const check = (out, index, options = {}) =>
  checkArtifact({
    artifact: out,
    index,
    revoked: [],
    previous: null,
    repo,
    pagesUrl,
    releases: releases.fixture({}),
    ...options,
  });

test("scan: a new version entry carries what the scanner found, last in the entry", async () => {
  const calls = [];
  const lines = [];
  const root = await repository();
  const { out, index } = await build(root, {
    scan: async (directory, label) => {
      calls.push([directory, label]);
      return structuredClone(SCAN);
    },
    log: (line) => lines.push(line),
  });
  const [entry] = index.plugins[0].versions;
  assert.deepEqual(entry.scan, SCAN);
  assert.equal(Object.keys(entry).at(-1), "scan");
  assert.deepEqual(calls, [[join(root, "plugins", "demo"), "plugins/demo"]]);
  assert.ok(
    lines.includes(
      "someone.demo 1.0.0: scan uses [player, clipboard] (types, SDK 1.8.0)",
    ),
  );
  assert.ok(!("scan" in index.plugins[0]));
  assert.deepEqual(indexProblems(index), []);
  const { problems, create } = await check(out, index);
  assert.deepEqual(problems, []);
  assert.equal(create.length, 1);
});

test("scan: no scanner, no field", async () => {
  const { index } = await build(await repository());
  assert.ok(!("scan" in index.plugins[0].versions[0]));
  assert.ok(!serializeIndex(index).toString().includes('"scan"'));
});

test("scan: a version of the published index is never scanned and stays as signed", async () => {
  const { index: first } = await build(await repository("1.0.0"));
  const scanned = [];
  const scan = async (directory, label) => {
    scanned.push(label);
    return { uses: [], method: "types", sdk: "1.8.0" };
  };
  // The same version again: kept, not scanned.
  const kept = await build(await repository("1.0.0"), {
    previous: first,
    scan,
  });
  assert.deepEqual(scanned, []);
  assert.deepEqual(kept.index.plugins[0].versions, first.plugins[0].versions);
  // A new version: scanned; the earlier entry is unchanged, without `scan`.
  const next = await build(await repository("1.1.0"), {
    previous: first,
    scan,
  });
  assert.deepEqual(scanned, ["plugins/demo"]);
  const [newest, earlier] = next.index.plugins[0].versions;
  assert.deepEqual(newest.scan, { uses: [], method: "types", sdk: "1.8.0" });
  assert.deepEqual(earlier, first.plugins[0].versions[0]);
  assert.deepEqual(
    (await check(next.out, next.index, { previous: first })).problems,
    [],
  );
  // And an earlier entry with a scan is kept with it.
  const later = await build(await repository("1.2.0"), {
    previous: next.index,
    scan: async () => structuredClone(SCAN),
  });
  assert.deepEqual(
    later.index.plugins[0].versions.map((entry) => entry.scan),
    [SCAN, { uses: [], method: "types", sdk: "1.8.0" }, undefined],
  );
});

test("scan: a version recovered from its release is scanned", async () => {
  const { index } = await build(await repository(), {
    releases: releases.fixture({
      "someone.demo-v1.0.0": {
        published: NOW,
        size: 10,
        sha256: "a".repeat(64),
      },
    }),
    scan: async () => structuredClone(SCAN),
  });
  assert.deepEqual(index.plugins[0].versions[0].scan, SCAN);
});

test("scan: a scanner that fails, or returns a malformed scan, stops the build", async () => {
  await assert.rejects(
    build(await repository(), {
      scan: async () => {
        throw new Error("plugins/demo: vestra-plugin scan failed");
      },
    }),
    /vestra-plugin scan failed/,
  );
  await assert.rejects(
    build(await repository(), {
      scan: async () => ({ uses: ["files"], method: "types", sdk: "1.8.0" }),
    }),
    /generated index is invalid:\n.*scan: uses must be an array of player, plugins/,
  );
});

test("scan: the index check and the signing job reject a malformed field", async () => {
  const { index, out } = await build(await repository(), {
    scan: async () => structuredClone(SCAN),
  });
  const cases = [
    [null, /versions\[0\]\.scan must be an object/],
    [[], /scan must be an object/],
    ["player", /scan must be an object/],
    [{}, /uses must be an array of/],
    [{ ...SCAN, uses: "player" }, /uses must be an array of/],
    [{ ...SCAN, uses: ["network"] }, /uses must be an array of/],
    [{ ...SCAN, uses: [1] }, /uses must be an array of/],
    [
      { ...SCAN, uses: ["clipboard", "player"] },
      /each category once, in the order/,
    ],
    [
      { ...SCAN, uses: ["player", "player"] },
      /each category once, in the order/,
    ],
    [{ ...SCAN, method: "none" }, /method must be types, names, mixed/],
    [{ uses: [], sdk: "1.8.0" }, /method must be/],
    [{ ...SCAN, sdk: "1.8" }, /sdk must be MAJOR\.MINOR\.PATCH/],
    [{ ...SCAN, sdk: 1 }, /sdk must be MAJOR\.MINOR\.PATCH/],
    [{ ...SCAN, evidence: {} }, /scan: unknown key "evidence"/],
  ];
  for (const [scan, pattern] of cases) {
    const bad = structuredClone(index);
    bad.plugins[0].versions[0].scan = scan;
    assert.match(indexProblems(bad).join("\n"), pattern);
    assert.match((await check(out, bad)).problems.join("\n"), pattern);
  }
  for (const scan of [
    { uses: [], method: "names", sdk: "1.8.0" },
    { uses: [...SCAN_CATEGORIES], method: "mixed", sdk: "2.10.3" },
  ]) {
    const good = structuredClone(index);
    good.plugins[0].versions[0].scan = scan;
    assert.deepEqual(indexProblems(good), []);
  }
  // Only a version entry has one.
  const misplaced = structuredClone(index);
  misplaced.plugins[0].scan = SCAN;
  assert.match(indexProblems(misplaced).join("\n"), /unknown key "scan"/);
  assert.deepEqual(scanProblems(undefined, "x"), []);
});

test("scan: the signing job refuses a scan added to, or changed in, a signed version", async () => {
  const { index: first } = await build(await repository("1.0.0"));
  const next = await build(await repository("1.1.0"), {
    previous: first,
    scan: async () => structuredClone(SCAN),
  });
  const added = structuredClone(next.index);
  added.plugins[0].versions[1].scan = SCAN;
  assert.match(
    (await check(next.out, added, { previous: first })).problems.join("\n"),
    /someone\.demo 1\.0\.0: differs from the signed index/,
  );
  const later = await build(await repository("1.1.0"), {
    previous: next.index,
  });
  const changed = structuredClone(later.index);
  changed.plugins[0].versions[0].scan.uses = [];
  assert.match(
    (await check(later.out, changed, { previous: next.index })).problems.join(
      "\n",
    ),
    /someone\.demo 1\.1\.0: differs from the signed index/,
  );
});

test("scan is covered by the signature", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { index } = await build(await repository(), {
    scan: async () => structuredClone(SCAN),
  });
  const bytes = serializeIndex(index);
  const signature = signIndex(bytes, privateKey);
  assert.ok(verifyIndex(bytes, signature, publicKey));
  const changed = structuredClone(index);
  changed.plugins[0].versions[0].scan.uses = [];
  assert.ok(!verifyIndex(serializeIndex(changed), signature, publicKey));
});

test("scanEntry keeps uses, method and sdk of the SDK's output, nothing else", () => {
  const output = {
    scan: 1,
    sdk: "1.8.0",
    plugin: "someone.demo",
    version: "1.0.0",
    uses: ["clipboard"],
    method: "mixed",
    files: { types: 1, names: 1 },
    evidence: {
      clipboard: [
        { member: "Clipboard.readText", file: "main.ts", line: 2, by: "types" },
      ],
    },
    unchecked: [],
    notes: ["…"],
  };
  assert.deepEqual(scanEntry(output, "plugins/demo"), {
    uses: ["clipboard"],
    method: "mixed",
    sdk: "1.8.0",
  });
  assert.throws(
    () => scanEntry({ ...output, scan: 2 }, "plugins/demo"),
    /plugins\/demo: vestra-plugin scan printed format 2, not 1/,
  );
  assert.throws(() => scanEntry(undefined, "plugins/demo"), /printed format/);
  assert.throws(
    () => scanEntry({ ...output, method: "none", uses: [] }, "plugins/demo"),
    /plugins\/demo: vestra-plugin scan found no source files/,
  );
  assert.throws(
    () => scanEntry({ ...output, uses: ["files"] }, "plugins/demo"),
    /plugins\/demo\.scan: uses must be an array of/,
  );
});

test("scanRequired: from the lowest version of package.json's SDK range", () => {
  assert.equal(SCAN_SDK, "1.8.0");
  for (const range of ["^1.7.19", "~1.7.0", "1.7.19", ">=1.7.9 <2.0.0"])
    assert.equal(scanRequired(range), false, range);
  for (const range of ["^1.8.0", "1.8.0", "~1.8.3", "^1.10.0", "^2.0.0"])
    assert.equal(scanRequired(range), true, range);
  for (const range of [undefined, "", "latest", "*", "file:../sdk"])
    assert.equal(scanRequired(range), false, String(range));
});

// The installed SDK: 1.8.0 and later has the scan, an earlier one does not.
const sdkPackage = createRequire(join(repositoryRoot, "package.json")).resolve(
  "@vestra-player/sdk/package.json",
);
const table = join(dirname(sdkPackage), "capability-scan.json");
const installed = existsSync(table);
const withScan = {
  skip: installed ? false : "the installed @vestra-player/sdk has no scan",
};

test("sdkScanner: an SDK without the scan gives none while package.json does not ask for one", async (t) => {
  if (installed) return t.skip("the installed @vestra-player/sdk has the scan");
  const { version } = JSON.parse(await readFile(sdkPackage, "utf8"));
  assert.deepEqual(await sdkScanner(repositoryRoot), {
    scan: null,
    sdk: version,
  });
});

test(
  "the categories are the installed SDK's, in its order",
  withScan,
  async () => {
    const { categories } = JSON.parse(await readFile(table, "utf8"));
    assert.deepEqual(Object.keys(categories), SCAN_CATEGORIES);
  },
);

test(
  "sdkScanner: scans a plugin's TypeScript by type with the installed SDK",
  withScan,
  async () => {
    const plugin = join(work, "typed");
    await mkdir(plugin);
    await writeFile(
      join(plugin, "manifest.json"),
      JSON.stringify({ id: "someone.typed", version: "1.0.0" }),
    );
    await writeFile(
      join(plugin, "main.ts"),
      [
        'import type { Plugin } from "@vestra-player/sdk";',
        "export default async function activate(plugin: Plugin) {",
        "  const board = plugin.clipboard;",
        "  await board.readText();",
        '  await plugin.secrets.set("token", "x");',
        "}",
        "",
      ].join("\n"),
    );
    const lines = [];
    const scanner = await sdkScanner(repositoryRoot, {
      log: (line) => lines.push(line),
    });
    const { version } = JSON.parse(await readFile(sdkPackage, "utf8"));
    assert.equal(scanner.sdk, version);
    assert.deepEqual(await scanner.scan(plugin, "plugins/typed"), {
      uses: ["clipboard", "credentials"],
      method: "types",
      sdk: version,
    });
    assert.deepEqual(lines, []);
    await assert.rejects(
      scanner.scan(join(work, "missing"), "plugins/missing"),
      /plugins\/missing: vestra-plugin scan failed/,
    );
  },
);
