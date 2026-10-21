import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  ownerProblems,
  readRegistry,
  validateRegistration,
} from "../lib/registry.mjs";
import { revokedProblems } from "../lib/revoked.mjs";
import { compareVersions, parseRange, satisfies } from "../lib/semver.mjs";
import { parseToml } from "../lib/toml.mjs";

const fixtures = join(import.meta.dirname, "fixtures");

test("TOML subset: strings, arrays over lines, comments", () => {
  assert.deepEqual(
    parseToml(
      '# c\na = "x\\"y\\u00e9" # c\nb = \'lit\\eral\'\nc = [\n  "1", # one\n  \'2\',\n]\n',
    ),
    { a: 'x"yé', b: "lit\\eral", c: ["1", "2"] },
  );
  for (const [text, message] of [
    ["[t]\n", /tables/],
    ["a = 1\n", /string or an array/],
    ['a = "x"\na = "y"\n', /duplicate key/],
    ['a.b = "x"\n', /bare key/],
    ['a = "x" b\n', /unexpected text/],
    ['a = ["x"\n', /unterminated array/],
    ['a = """x"""\n', /multi-line/],
    ['a = "x\n', /unterminated string/],
  ])
    assert.throws(() => parseToml(text), message, text);
});

test("valid registrations parse and keep path and owners", async () => {
  const { entries, problems } = await readRegistry(
    join(fixtures, "registry-valid"),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(entries, [
    {
      id: "Some-Org.tools",
      repository: "https://github.com/some-org/vestra-tools",
      commit: "0123456789abcdef0123456789abcdef01234567",
      path: "plugins/tools",
      owners: ["alice", "bob-2"],
    },
    {
      id: "someone.cool-visualizer",
      repository: "https://github.com/someone/cool-visualizer",
      commit: "3f2a9c1d4b5e6f708192a3b4c5d6e7f8091a2b3c",
      path: ".",
      owners: ["someone"],
    },
  ]);
});

test("invalid registrations name the broken rule", async () => {
  const expected = {
    "someone.wrong-owner":
      /prefix "someone" must be the repository owner "someoneelse"/,
    "vestra.fake": /reserved for the official plugins/,
    noprefix: /<GitHub owner>\.<plugin name>/,
    "someone.channel": /channel is not used/,
    "someone.short-commit": /40-digit/,
    "someone.bad-path": /path must be/,
    "someone.no-owners": /owners must be a non-empty array/,
    "someone.dot-git": /\.git/,
    "someone.table": /tables are not supported/,
    "someone.number": /string or an array/,
  };
  const { entries, problems } = await readRegistry(
    join(fixtures, "registry-invalid"),
  );
  assert.deepEqual(entries, []);
  for (const [id, pattern] of Object.entries(expected)) {
    const own = problems.filter((problem) =>
      problem.startsWith(`registry/${id}.toml:`),
    );
    assert.ok(
      own.some((problem) => pattern.test(problem)),
      `${id}: ${own.join(" | ")}`,
    );
  }
  assert.equal(
    new Set(problems.map((p) => p.split(":")[0])).size,
    Object.keys(expected).length,
  );
});

test("id characters and other files in registry/", () => {
  const text =
    'repository = "https://github.com/someone/x"\ncommit = "' +
    "a".repeat(40) +
    '"\nowners = ["someone"]\n';
  assert.deepEqual(validateRegistration("someone.x", text).problems, []);
  assert.match(
    validateRegistration("someone.x y", text).problems.join(),
    /ASCII letters/,
  );
  assert.match(
    validateRegistration("someone.", text).problems.join(),
    /<GitHub owner>\.<plugin name>/,
  );
  assert.match(
    validateRegistration(
      "someone.x",
      text.replace('["someone"]', '["someone", "Someone"]'),
    ).problems.join(),
    /duplicates/,
  );
});

test("owner rule: new files need the author as owner; changes need an existing owner", () => {
  const entry = { owners: ["alice", "bob"] };
  assert.deepEqual(ownerProblems("a.x", null, entry, "Alice"), []);
  assert.match(
    ownerProblems("a.x", null, entry, "mallory").join(),
    /must be one of the owners/,
  );
  assert.deepEqual(
    ownerProblems("a.x", entry, { owners: ["mallory"] }, "bob"),
    [],
  );
  assert.match(
    ownerProblems("a.x", entry, { owners: ["mallory"] }, "mallory").join(),
    /only its owners/,
  );
  assert.match(
    ownerProblems("a.x", entry, null, "mallory").join(),
    /only its owners/,
  );
  assert.deepEqual(ownerProblems("a.x", entry, null, "alice"), []);
});

test("version ranges", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(satisfies("1.2.0", "1.2.0"));
  assert.ok(!satisfies("1.2.1", "1.2.0"));
  assert.ok(satisfies("1.1.5", ">=1.0.0 <1.2.0"));
  assert.ok(!satisfies("1.2.0", ">=1.0.0 <1.2.0"));
  assert.ok(satisfies("2.0.0", ">=1.0.0 <1.2.0 || 2.0.0"));
  assert.ok(satisfies("9.9.9", "*"));
  assert.ok(
    satisfies("0.9.0", "<=0.9.0") &&
      satisfies("1.0.1", ">1.0.0") &&
      satisfies("1.0.0", "=1.0.0"),
  );
  for (const bad of [
    "",
    "^1.0.0",
    "~1.2.0",
    "1.x",
    "1.0",
    "01.0.0",
    "1.0.0 - 2.0.0",
    ">= 1.0.0",
    "1.0.0-beta",
    "||",
  ])
    assert.throws(() => parseRange(bad), undefined, bad);
});

test("revoked.json format", async () => {
  const list = JSON.parse(
    await readFile(join(fixtures, "revoked-valid.json"), "utf8"),
  );
  assert.deepEqual(revokedProblems(list), []);
  assert.deepEqual(revokedProblems([]), []);
  assert.match(revokedProblems({}).join(), /JSON array/);
  const problems = revokedProblems([
    { id: "a b", versions: "^1.0.0", reason: "" },
    { id: "x.y", versions: "1.0.0", reason: "ok", extra: 1 },
    "x",
  ]);
  assert.match(problems.join("\n"), /\[0\]: id must be/);
  assert.match(problems.join("\n"), /\[0\]: versions: "\^1\.0\.0"/);
  assert.match(problems.join("\n"), /\[0\]: reason must be/);
  assert.match(problems.join("\n"), /\[1\]: unknown key "extra"/);
  assert.match(problems.join("\n"), /\[2\] must be an object/);
});
