import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// The pull request form of check-registry.mjs, in a scratch git repository
// with a copy of scripts/.
let root;
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const registration = (owner, owners) =>
  `repository = "https://github.com/${owner}/plugin"\ncommit = "${"a".repeat(40)}"\nowners = ${JSON.stringify(owners)}\n`;
const check = (base, head, author) =>
  spawnSync(
    process.execPath,
    [
      join(root, "scripts/check-registry.mjs"),
      "--base",
      base,
      "--head",
      head,
      "--author",
      author,
    ],
    { cwd: root, encoding: "utf8" },
  );
const commit = async (files, message) => {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) git("rm", "-q", path);
    else {
      await mkdir(join(root, "registry"), { recursive: true });
      await writeFile(join(root, path), text);
      git("add", path);
    }
  }
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    message,
  );
  return git("rev-parse", "HEAD");
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), "vestra-registry-pr-"));
  await cp(join(import.meta.dirname, ".."), join(root, "scripts"), {
    recursive: true,
    filter: (path) => !path.includes(`${join("scripts", "tests")}`),
  });
  await mkdir(join(root, "registry"));
  git("init", "-q");
});
after(() => rm(root, { recursive: true, force: true }));

test("owner rule in pull requests", async () => {
  const base = await commit(
    {
      "registry/alice.viz.toml": registration("alice", ["alice", "carol"]),
      "revoked.json": "[]\n",
    },
    "base",
  );

  const changed = await commit(
    {
      "registry/alice.viz.toml": registration("alice", [
        "alice",
        "carol",
        "bob",
      ]),
    },
    "add bob",
  );
  assert.equal(check(base, changed, "carol").status, 0);
  const denied = check(base, changed, "bob");
  assert.equal(denied.status, 1);
  assert.match(
    denied.stderr,
    /only its owners \(alice, carol\) can change or remove it/,
  );

  const removed = await commit({ "registry/alice.viz.toml": null }, "remove");
  assert.equal(check(changed, removed, "mallory").status, 1);
  assert.equal(check(changed, removed, "Bob").status, 0);

  const added = await commit(
    { "registry/dave.tool.toml": registration("dave", ["dave"]) },
    "new",
  );
  assert.equal(check(removed, added, "dave").status, 0);
  const stranger = check(removed, added, "erin");
  assert.equal(stranger.status, 1);
  assert.match(
    stranger.stderr,
    /must be one of the owners of a new registration/,
  );

  const invalid = await commit(
    { "registry/erin.x.toml": registration("someone", ["erin"]) },
    "bad prefix",
  );
  const result = check(added, invalid, "erin");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be the repository owner "someone"/);

  const badRevoked = await commit(
    { "revoked.json": '[{"id":"a.b","versions":"^1.0.0","reason":"x"}]' },
    "revoke",
  );
  assert.match(check(invalid, badRevoked, "erin").stderr, /versions/);
});
