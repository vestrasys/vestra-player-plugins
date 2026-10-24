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

/** A repository root with one plugin, plugins/demo (owner someone), at `version`. */
async function repository({
  version = "1.1.0",
  id = "someone.demo",
  owners = 'demo = "someone"\n',
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
      author: "someone",
      punchline: "一句话",
      tags: ["演示"],
      icon: "assets/logo.PNG",
      license: "Apache-2.0",
      minPlayerVersion: "0.2.0",
    }),
  );
  await writeFile(join(root, "plugins/owners.toml"), owners);
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
  const bytes = Buffer.from("package someone.demo@1.1.0");
  const asset = (text) => [sha256(Buffer.from(text)), Buffer.byteLength(text)];
  const [iconSha256, iconSize] = asset("png");
  const [readmeSha256, readmeSize] = asset("# 演示\n");
  const [changelogSha256, changelogSize] = asset("# 更新日志\n");
  assert.deepEqual(index, {
    schema: 1,
    generated: 1,
    name: "Vestra Player 官方仓库",
    official: true,
    plugins: [
      {
        id: "someone.demo",
        name: "演示",
        author: "someone",
        punchline: "一句话",
        description: null,
        tags: ["演示"],
        license: "Apache-2.0",
        iconUrl: `${pagesUrl}assets/someone.demo/1.1.0/icon.png`,
        iconSha256,
        iconSize,
        readmeUrl: `${pagesUrl}assets/someone.demo/1.1.0/README.md`,
        readmeSha256,
        readmeSize,
        changelogUrl: `${pagesUrl}assets/someone.demo/1.1.0/CHANGELOG.md`,
        changelogSha256,
        changelogSize,
        sourceUrl: `https://github.com/${repo}/tree/main/plugins/demo`,
        versions: [
          {
            version: "1.1.0",
            apiVersion: "vestra/1",
            minPlayerVersion: "0.2.0",
            capabilities: ["commands"],
            downloadUrl: `https://github.com/${repo}/releases/download/someone.demo-v1.1.0/someone.demo-1.1.0.vxp`,
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
    await readFile(join(out, "releases/someone.demo-1.1.0.vxp"), "utf8"),
    bytes.toString(),
  );
  assert.equal(
    await readFile(
      join(out, "site/assets/someone.demo/1.1.0/README.md"),
      "utf8",
    ),
    "# 演示\n",
  );
  assert.equal(
    await readFile(
      join(out, "site/assets/someone.demo/1.1.0/icon.png"),
      "utf8",
    ),
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
    ["someone.demo-v1.1.0"],
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
    releases: releases.fixture({ "someone.demo-v1.0.0": { published: NOW } }),
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
  assert.equal(again.index.generated, 2);
  assert.deepEqual({ ...again.index, generated: 1 }, first.index);
  const result = await check(again.out, again.index, { previous: first.index });
  assert.deepEqual(result, { problems: [], create: [] });
});

test("a release missing from the index (signing failed) is recovered, not rebuilt", async () => {
  const released = {
    "someone.demo-v1.1.0": {
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
    "someone.demo-v1.1.0": {
      ...released["someone.demo-v1.1.0"],
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
  const revoked = [{ id: "someone.demo", versions: "<1.1.0", reason: "崩溃" }];
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

test("plugins/ ids are <owner>.<name>, never vestra.; registry entries are not built yet", async () => {
  await assert.rejects(
    build(await repository({ id: "demo" })),
    /id must be <owner>\.<directory>, here someone\.demo/,
  );
  await assert.rejects(
    build(await repository({ id: "vestra.demo" })),
    /reserved for the player's built-in plugins/,
  );
  await assert.rejects(
    build(await repository({ id: "vestra.demo", owners: 'demo = "vestra"\n' })),
    /"vestra" is reserved/,
  );
  await assert.rejects(
    build(await repository({ owners: "" })),
    /plugins\/demo: no owner/,
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
    "someone.demo-v1.0.0": { published: NOW },
  });
  const expectProblem = async ({ out, index }, pattern) => {
    const { problems } = await check(out, index, {
      previous,
      releases: released,
    });
    assert.match(problems.join("\n"), pattern);
  };

  let built = await fresh();
  await writeFile(join(built.out, "releases/someone.demo-1.1.0.vxp"), "evil");
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
  const next = generateKeyPairSync("ed25519");
  assert.deepEqual(
    await loadPrevious(site, [next.publicKey, publicKey], no),
    index,
    "any trusted key will do",
  );
  const both = join(work, "published-both");
  await mkdir(both);
  await writeFile(join(both, "index.json"), bytes);
  await writeFile(
    join(both, "index.json.sig"),
    `${signIndex(bytes, next.privateKey)}\n${signIndex(bytes, privateKey)}`,
  );
  assert.deepEqual(await loadPrevious(both, publicKey, no), index);
  assert.deepEqual(await loadPrevious(both, next.publicKey, no), index);

  const legacy = join(work, "published-legacy");
  await mkdir(legacy);
  const legacyBytes = await readFile(
    join(import.meta.dirname, "fixtures/index-legacy.json"),
  );
  await writeFile(join(legacy, "index.json"), legacyBytes);
  await writeFile(
    join(legacy, "index.json.sig"),
    signIndex(legacyBytes, privateKey),
  );
  assert.equal(
    (await loadPrevious(legacy, publicKey, no)).generated,
    undefined,
    "an index from before generated and the asset hashes is still read",
  );

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

test("generated: 1 on the first publish, previous + 1 after, 1 after a legacy index", async () => {
  const first = await build(await repository({ version: "1.0.0" }));
  assert.equal(first.index.generated, 1);
  const second = await build(await repository({ version: "1.1.0" }), {
    previous: first.index,
  });
  assert.equal(second.index.generated, 2);
  const third = await build(await repository({ version: "1.1.0" }), {
    previous: second.index,
  });
  assert.equal(third.index.generated, 3);

  // An index published before `generated` existed (fixture: the shape of
  // the index on main before this change).
  const legacy = JSON.parse(
    await readFile(
      join(import.meta.dirname, "fixtures/index-legacy.json"),
      "utf8",
    ),
  );
  const after = await build(await repository({ version: "1.1.0" }), {
    previous: legacy,
  });
  assert.equal(after.index.generated, 1);
  assert.deepEqual(
    after.index.plugins[0].versions.map((entry) => entry.version),
    ["1.1.0", "1.0.0"],
  );
  const { problems } = await check(after.out, after.index, {
    previous: legacy,
    revoked: legacy.revoked,
    releases: releases.fixture({ "someone.demo-v1.0.0": { published: NOW } }),
  });
  assert.deepEqual(problems, []);
});

test("a renamed plugin: the old id leaves the index, the new id starts a fresh history", async () => {
  // The previously signed index has the plugin under its old id (as
  // vestra.youtube became zysilm.youtube); the repository now has only the
  // new id.
  const old = await build(await repository({ version: "1.0.0" }));
  const previous = structuredClone(old.index);
  previous.plugins[0].id = "vestra.demo";
  for (const entry of previous.plugins[0].versions)
    entry.downloadUrl = entry.downloadUrl.replaceAll(
      "someone.demo",
      "vestra.demo",
    );
  const logged = [];
  const renamed = await build(await repository({ version: "1.1.0" }), {
    previous,
    log: (line) => logged.push(line),
  });
  assert.deepEqual(
    renamed.index.plugins.map(({ id, versions }) => [
      id,
      versions.map((entry) => entry.version),
    ]),
    [["someone.demo", ["1.1.0"]]],
  );
  assert.equal(renamed.index.generated, previous.generated + 1);
  assert.ok(
    logged.includes(
      "vestra.demo: no longer in the repository, dropped from the index",
    ),
  );
  const { problems, create } = await check(renamed.out, renamed.index, {
    previous,
    releases: releases.fixture({ "vestra.demo-v1.0.0": { published: NOW } }),
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(
    create.map((item) => item.tag),
    ["someone.demo-v1.1.0"],
  );
});

test("revoked.json is append-only: the build stops when it drops or changes a published entry", async () => {
  const one = { id: "someone.demo", versions: "1.0.0", reason: "崩溃" };
  const two = { id: "someone.demo", versions: "1.0.1", reason: "也崩溃" };
  const first = await build(await repository({ revoked: [one] }));
  const appended = await build(await repository({ revoked: [one, two] }), {
    previous: first.index,
  });
  assert.deepEqual(appended.index.revoked, [one, two]);
  await assert.rejects(
    build(await repository({ revoked: [] }), { previous: appended.index }),
    /revoked\[0\] \(someone\.demo 1\.0\.0\) from the published index was removed/,
  );
  await assert.rejects(
    build(await repository({ revoked: [{ ...one, reason: "改了" }, two] }), {
      previous: appended.index,
    }),
    /revoked\[0\] .* differs from the published index/,
  );
  await assert.rejects(
    build(await repository({ revoked: [two, one] }), {
      previous: appended.index,
    }),
    /differs/,
    "reordering counts as a change",
  );
});

test("a store asset over the store's limit stops the build", async () => {
  const root = await repository();
  await writeFile(
    join(root, "plugins/demo/README.md"),
    "x".repeat(256 * 1024 + 1),
  );
  await assert.rejects(build(root), /README\.md: 262145 bytes/);
});

test("the signing job checks generated, revoked and the store assets", async () => {
  const one = { id: "someone.demo", versions: "1.0.0", reason: "崩溃" };
  const first = await build(
    await repository({ version: "1.0.0", revoked: [one] }),
  );
  const previous = first.index;
  const released = releases.fixture({
    "someone.demo-v1.0.0": { published: NOW },
  });
  const fresh = async () => {
    const second = await build(
      await repository({ version: "1.1.0", revoked: [one] }),
      { previous },
    );
    return { ...second, index: structuredClone(second.index) };
  };
  const problemsOf = async ({ out, index }, revoked = [one]) =>
    (await check(out, index, { previous, revoked, releases: released }))
      .problems;
  const expectProblem = async (built, pattern, revoked) =>
    assert.match((await problemsOf(built, revoked)).join("\n"), pattern);

  let built = await fresh();
  assert.deepEqual(await problemsOf(built), []);

  // generated must be exactly previous + 1.
  for (const generated of [1, 3, 0]) {
    built = await fresh();
    built.index.generated = generated;
    await expectProblem(built, /generated/);
  }
  built = await fresh();
  delete built.index.generated;
  await expectProblem(built, /generated must be a positive integer/);

  // revoked: an entry of the signed index removed or changed, even when
  // revoked.json says the same (a merged change to revoked.json).
  built = await fresh();
  built.index.revoked = [];
  await expectProblem(built, /revoked\[0\] .* was removed/, []);
  built = await fresh();
  built.index.revoked = [{ ...one, versions: "*" }];
  await expectProblem(
    built,
    /revoked\[0\] .* differs from the previously signed index/,
    built.index.revoked,
  );

  // Store assets: the site file and the index must agree.
  built = await fresh();
  await writeFile(
    join(built.out, "site/assets/someone.demo/1.1.0/README.md"),
    "# 被换掉的说明\n",
  );
  await expectProblem(
    built,
    /site\/assets\/someone\.demo\/1\.1\.0\/README\.md does not match readmeSha256\/readmeSize/,
  );
  built = await fresh();
  built.index.plugins[0].iconSha256 = "d".repeat(64);
  await expectProblem(built, /does not match iconSha256\/iconSize/);
  built = await fresh();
  built.index.plugins[0].changelogSize += 1;
  await expectProblem(built, /does not match changelogSha256\/changelogSize/);
  built = await fresh();
  delete built.index.plugins[0].readmeSha256;
  await expectProblem(built, /readmeSha256 must be 64 lowercase hex digits/);
  built = await fresh();
  built.index.plugins[0].iconUrl = null;
  await expectProblem(
    built,
    /iconSha256 and iconSize must be null without iconUrl/,
  );
  built = await fresh();
  built.index.plugins[0].readmeUrl = `${pagesUrl}assets/someone.demo/1.1.0/./README.md`;
  await expectProblem(built, /readmeUrl must be under/);

  // Nothing on Pages but index.json and the referenced assets.
  built = await fresh();
  await writeFile(
    join(built.out, "site/assets/someone.demo/1.1.0/login.html"),
    "<form>",
  );
  await expectProblem(
    built,
    /site\/assets\/someone\.demo\/1\.1\.0\/login\.html: unexpected file/,
  );
  built = await fresh();
  await mkdir(join(built.out, "site/assets/someone.demo/0.9.0"));
  await writeFile(
    join(built.out, "site/assets/someone.demo/0.9.0/README.md"),
    "old",
  );
  await expectProblem(built, /0\.9\.0\/README\.md: unexpected file/);
});
