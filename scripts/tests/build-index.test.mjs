import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildIndex } from "../lib/build.mjs";
import {
  loadPrevious,
  releases,
  serializeIndex,
  sha256,
} from "../lib/publishing.mjs";
import { checkArtifact } from "../lib/release.mjs";
import { signIndex } from "../lib/signing.mjs";

const repo = "vestrasys/vestra-player-plugins";
const pagesUrl = "https://vestrasys.github.io/vestra-player-plugins/";
const NOW = "2026-10-21T12:00:00.000Z";
let work;
let count = 0;

before(async () => {
  work = await mkdtemp(join(tmpdir(), "vestra-build-index-"));
});
after(() => rm(work, { recursive: true, force: true }));

/** A repository root with one official plugin at `version`. */
async function repository({
  version = "1.1.0",
  id = "vestra.demo",
  revoked = [],
  registry = {},
} = {}) {
  const root = join(work, `repo-${++count}`);
  const plugin = join(root, "plugins/demo");
  await mkdir(join(plugin, "assets"), { recursive: true });
  await writeFile(
    join(plugin, "manifest.json"),
    JSON.stringify({
      id,
      version,
      apiVersion: "vestra/1",
      entry: "main.ts",
      capabilities: ["commands"],
      name: "演示",
      author: "Vestra Player",
      punchline: "一句话",
      tags: ["演示"],
      icon: "assets/logo.PNG",
      license: "Apache-2.0",
      minPlayerVersion: "0.2.0",
    }),
  );
  await writeFile(join(plugin, "README.md"), "# 演示\n");
  await writeFile(join(plugin, "CHANGELOG.md"), "# 更新日志\n");
  await writeFile(join(plugin, "assets/logo.PNG"), "png");
  await writeFile(join(root, "revoked.json"), JSON.stringify(revoked));
  await mkdir(join(root, "registry"));
  for (const [name, text] of Object.entries(registry))
    await writeFile(join(root, "registry", name), text);
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

test("first publish: packs the plugin and describes it", async () => {
  const { out, index, packed } = await build(await repository());
  const bytes = Buffer.from("package vestra.demo@1.1.0");
  assert.deepEqual(index, {
    schema: 1,
    name: "Vestra Player 官方仓库",
    official: true,
    plugins: [
      {
        id: "vestra.demo",
        name: "演示",
        author: "Vestra Player",
        punchline: "一句话",
        description: null,
        tags: ["演示"],
        license: "Apache-2.0",
        iconUrl: `${pagesUrl}assets/vestra.demo/1.1.0/icon.png`,
        readmeUrl: `${pagesUrl}assets/vestra.demo/1.1.0/README.md`,
        changelogUrl: `${pagesUrl}assets/vestra.demo/1.1.0/CHANGELOG.md`,
        sourceUrl: `https://github.com/${repo}/tree/main/plugins/demo`,
        versions: [
          {
            version: "1.1.0",
            apiVersion: "vestra/1",
            minPlayerVersion: "0.2.0",
            capabilities: ["commands"],
            downloadUrl: `https://github.com/${repo}/releases/download/vestra.demo-v1.1.0/vestra.demo-1.1.0.vxp`,
            sha256: sha256(bytes),
            size: bytes.length,
            published: NOW,
          },
        ],
      },
    ],
    revoked: [],
    extensions: {},
  });
  assert.equal(packed.length, 1);
  assert.equal(
    await readFile(join(out, "releases/vestra.demo-1.1.0.vxp"), "utf8"),
    bytes.toString(),
  );
  assert.equal(
    await readFile(
      join(out, "site/assets/vestra.demo/1.1.0/README.md"),
      "utf8",
    ),
    "# 演示\n",
  );
  assert.equal(
    await readFile(join(out, "site/assets/vestra.demo/1.1.0/icon.png"), "utf8"),
    "png",
  );
  assert.ok(
    !JSON.stringify(index).includes("channel") &&
      !JSON.stringify(index).includes("downloadCount"),
  );

  const { problems, create } = await check(out, index);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    create.map((item) => item.tag),
    ["vestra.demo-v1.1.0"],
  );
});

test("a new version keeps the earlier versions from the signed index", async () => {
  const first = await build(await repository({ version: "1.0.0" }));
  const second = await build(await repository({ version: "1.1.0" }), {
    previous: first.index,
  });
  assert.deepEqual(
    second.index.plugins[0].versions.map((entry) => entry.version),
    ["1.1.0", "1.0.0"],
  );
  assert.deepEqual(
    second.index.plugins[0].versions[1],
    first.index.plugins[0].versions[0],
  );
  const { problems, create } = await check(second.out, second.index, {
    previous: first.index,
    releases: releases.fixture({ "vestra.demo-v1.0.0": { published: NOW } }),
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(
    create.map((item) => item.version),
    ["1.1.0"],
  );
});

test("a released version is not rebuilt", async () => {
  const first = await build(await repository());
  const again = await build(await repository(), { previous: first.index });
  assert.equal(again.packed.length, 0);
  assert.deepEqual(again.index, first.index);
  const result = await check(again.out, again.index, { previous: first.index });
  assert.deepEqual(result, { problems: [], create: [] });
});

test("a release missing from the index (signing failed) is recovered, not rebuilt", async () => {
  const released = {
    "vestra.demo-v1.1.0": {
      published: "2026-10-20T08:00:00Z",
      size: 7,
      sha256: "a".repeat(64),
    },
  };
  const { index, packed, out } = await build(await repository(), {
    releases: releases.fixture(released),
  });
  assert.equal(packed.length, 0);
  const [entry] = index.plugins[0].versions;
  assert.deepEqual(
    [entry.sha256, entry.size, entry.published],
    ["a".repeat(64), 7, "2026-10-20T08:00:00Z"],
  );
  const result = await check(out, index, {
    releases: releases.fixture(released),
  });
  assert.deepEqual(result, { problems: [], create: [] });
  const wrong = {
    "vestra.demo-v1.1.0": {
      ...released["vestra.demo-v1.1.0"],
      sha256: "b".repeat(64),
    },
  };
  assert.match(
    (
      await check(out, index, { releases: releases.fixture(wrong) })
    ).problems.join(),
    /does not match the released/,
  );
});

test("revoked.json is copied unchanged; an invalid one stops the build", async () => {
  const revoked = [{ id: "vestra.demo", versions: "<1.1.0", reason: "崩溃" }];
  const { index, out } = await build(await repository({ revoked }));
  assert.deepEqual(index.revoked, revoked);
  assert.deepEqual((await check(out, index, { revoked })).problems, []);
  assert.match(
    (await check(out, index, { revoked: [] })).problems.join(),
    /revoked differs/,
  );
  await assert.rejects(
    build(
      await repository({
        revoked: [{ id: "x", versions: "^1.0.0", reason: "r" }],
      }),
    ),
    /versions/,
  );
});

test("official ids need the vestra. prefix; registry entries are not built yet", async () => {
  await assert.rejects(
    build(await repository({ id: "demo" })),
    /vestra\.<name>/,
  );
  await assert.rejects(
    build(await repository({ id: "someone.demo" })),
    /vestra\.<name>/,
  );
  const registration = `repository = "https://github.com/someone/x"\ncommit = "${"a".repeat(40)}"\nowners = ["someone"]\n`;
  await assert.rejects(
    build(await repository({ registry: { "someone.x.toml": registration } })),
    /third-party builds are not implemented yet; cannot publish someone\.x/,
  );
  await assert.rejects(
    build(await repository({ registry: { "vestra.x.toml": registration } })),
    /reserved/,
  );
});

test("the signing job rejects a tampered artifact", async () => {
  const first = await build(await repository({ version: "1.0.0" }));
  const fresh = async () => {
    const second = await build(await repository({ version: "1.1.0" }), {
      previous: first.index,
    });
    return { ...second, index: structuredClone(second.index) };
  };
  const previous = first.index;
  const released = releases.fixture({
    "vestra.demo-v1.0.0": { published: NOW },
  });
  const expectProblem = async ({ out, index }, pattern) => {
    const { problems } = await check(out, index, {
      previous,
      releases: released,
    });
    assert.match(problems.join("\n"), pattern);
  };

  let built = await fresh();
  await writeFile(join(built.out, "releases/vestra.demo-1.1.0.vxp"), "evil");
  await expectProblem(built, /does not match the index sha256/);

  built = await fresh();
  built.index.plugins[0].versions[1].sha256 = "c".repeat(64);
  await expectProblem(built, /1\.0\.0: differs from the signed index/);

  built = await fresh();
  built.index.plugins[0].versions.pop();
  await expectProblem(built, /1\.0\.0: dropped/);

  built = await fresh();
  built.index.plugins[0].versions[0].downloadUrl = "https://example.com/x.vxp";
  await expectProblem(built, /downloadUrl must be/);

  built = await fresh();
  await writeFile(join(built.out, "releases/other.vxp"), "x");
  await expectProblem(built, /releases\/other\.vxp: not referenced/);

  built = await fresh();
  built.index.plugins[0].iconUrl = "https://example.com/icon.png";
  await expectProblem(built, /iconUrl must be under/);

  built = await fresh();
  await writeFile(join(built.out, "site/index.json.sig"), "x");
  await expectProblem(built, /unexpected file/);

  built = await fresh();
  built.index.plugins[0].versions[0].channel = "testing";
  await expectProblem(built, /unknown key "channel"/);
});

test("the previous index must be signed; it may be missing only before any release", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { index } = await build(await repository());
  const site = join(work, "published");
  await mkdir(site);
  const bytes = serializeIndex(index);
  await writeFile(join(site, "index.json"), bytes);
  await writeFile(join(site, "index.json.sig"), signIndex(bytes, privateKey));
  const no = async () => false;
  const yes = async () => true;
  assert.deepEqual(await loadPrevious(site, publicKey, no), index);

  const other = generateKeyPairSync("ed25519");
  await assert.rejects(
    loadPrevious(site, other.publicKey, no),
    /does not verify/,
  );

  const tampered = join(work, "tampered");
  await cp(site, tampered, { recursive: true });
  await writeFile(
    join(tampered, "index.json"),
    bytes.toString().replace("演示", "假的"),
  );
  await assert.rejects(
    loadPrevious(tampered, publicKey, no),
    /does not verify/,
  );

  const unsigned = join(work, "unsigned");
  await mkdir(unsigned);
  await writeFile(join(unsigned, "index.json"), bytes);
  await assert.rejects(
    loadPrevious(unsigned, publicKey, no),
    /no index\.json\.sig/,
  );

  const empty = join(work, "empty");
  await mkdir(empty);
  assert.equal(await loadPrevious(empty, publicKey, no), null);
  await assert.rejects(loadPrevious(empty, publicKey, yes), /releases exist/);
});
