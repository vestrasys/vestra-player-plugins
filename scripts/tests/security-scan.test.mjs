import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  MARKER,
  extract,
  newFindings,
  render,
  report,
  scanned,
} from "../security-scan.mjs";

// scripts/security-scan.mjs without semgrep: extraction from a scratch git
// repository, and the report from hand-written semgrep output. The rules
// themselves are tested with semgrep in _static.yml (.semgrep/tests/).
let root;
let out;
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
async function put(path, text) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "security-scan-"));
  out = await mkdtemp(join(tmpdir(), "security-scan-out-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "core.autocrlf", "false");
  for (const name of ["one", "two"]) {
    await put(`plugins/${name}/manifest.json`, "{}");
    await put(`plugins/${name}/main.ts`, `export const name = "${name}";\n`);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("tag", "base");
  await put(
    "plugins/one/main.ts",
    'import { exec } from "node:child_process";\nexport const name = "one";\n',
  );
  await put("plugins/one/tests/main.test.ts", "eval('1');\n");
  await put("plugins/one/lib/helper.mjs", "export {};\n");
  await put("plugins/one/README.md", "# One\n");
  await put("plugins/one/bin/tool.exe", "MZ");
  await put("plugins/one/.semgrepignore", "*\n");
  await put("plugins/three/manifest.json", "{}");
  await put("plugins/three/index.js", "module.exports = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "head");
  git("tag", "head");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

test("only packaged code files are scanned", () => {
  assert.equal(scanned("plugins/a/main.ts"), true);
  assert.equal(scanned("plugins/a/lib/x.cjs"), true);
  assert.equal(scanned("plugins/a/tests/x.test.ts"), false);
  assert.equal(
    scanned("plugins/a/lib/tests/x.ts"),
    true,
    "only the top-level tests/ is left out",
  );
  assert.equal(scanned("plugins/a/node_modules/x/index.js"), false);
  assert.equal(scanned("plugins/a/README.md"), false);
});

test("extract writes the changed plugins at head and base, without ignore files or tests", async () => {
  const dir = join(out, "pr");
  const scan = await extract({
    cwd: root,
    base: "base",
    head: "head",
    out: dir,
  });
  assert.deepEqual(scan.plugins, ["one", "three"]);
  assert.deepEqual(scan.files.sort(), [
    "plugins/one/lib/helper.mjs",
    "plugins/one/main.ts",
    "plugins/three/index.js",
  ]);
  assert.deepEqual(scan.opaque, ["plugins/one/bin/tool.exe"]);
  assert.deepEqual(
    scan.baseFiles,
    ["plugins/one/main.ts"],
    "three is new: nothing at base",
  );
  assert.match(
    await readFile(join(dir, "head/plugins/one/main.ts"), "utf8"),
    /child_process/,
  );
  assert.doesNotMatch(
    await readFile(join(dir, "base/plugins/one/main.ts"), "utf8"),
    /child_process/,
  );
  // Our own (empty) ignore file at the root; the plugin's is not extracted.
  assert.match(await readFile(join(dir, "head/.semgrepignore"), "utf8"), /^#/);
  await assert.rejects(readFile(join(dir, "head/plugins/one/.semgrepignore")));
  await assert.rejects(
    readFile(join(dir, "head/plugins/one/tests/main.test.ts")),
  );
});

test("extract --all takes every plugin at head", async () => {
  const scan = await extract({
    cwd: root,
    head: "head",
    all: true,
    out: join(out, "all"),
  });
  assert.deepEqual(scan.plugins, ["one", "three", "two"]);
  assert.deepEqual(scan.baseFiles, []);
});

const finding = (rule, path, code, line = 1) => ({
  rule,
  severity: "WARNING",
  message: "m",
  path,
  line,
  code,
});

test("new findings: same rule, file and code at another line is not new; a second copy is", () => {
  const base = [
    finding(
      "vestra-child-process",
      "plugins/a/x.ts",
      "import 'child_process'",
      1,
    ),
  ];
  const head = [
    finding(
      "vestra-child-process",
      "plugins/a/x.ts",
      "import 'child_process'",
      9,
    ),
    finding(
      "vestra-child-process",
      "plugins/a/x.ts",
      "import 'child_process'",
      12,
    ),
    finding("vestra-dynamic-code", "plugins/a/x.ts", "eval(x)", 3),
  ];
  assert.deepEqual(
    newFindings(head, base).map((f) => [f.rule, f.line]),
    [
      ["vestra-child-process", 12],
      ["vestra-dynamic-code", 3],
    ],
  );
});

test("report: new findings, skipped files and unreadable files; untrusted text is escaped", async () => {
  const dir = join(out, "pr");
  const source = await readFile(join(dir, "head/plugins/one/main.ts"));
  const start = source.indexOf("import");
  const end = source.indexOf(";");
  const result = (path, offsets, rule = "semgrep.vestra-child-process") => ({
    check_id: rule,
    path,
    start: { line: 1, col: 1, offset: offsets[0] },
    end: { line: 1, col: 1, offset: offsets[1] },
    extra: { severity: "WARNING", message: "Runs <b>programs</b> @someone" },
  });
  await writeFile(
    join(dir, "head.json"),
    JSON.stringify({
      results: [result("plugins\\one\\main.ts", [start, end])],
      errors: [{ type: "Timeout", path: "plugins/three/index.js" }],
      // helper.mjs missing: semgrep skipped it.
      paths: { scanned: ["plugins/one/main.ts", "plugins/three/index.js"] },
    }),
  );
  await writeFile(
    join(dir, "base.json"),
    JSON.stringify({ results: [], errors: [], paths: { scanned: [] } }),
  );
  const summary = await report({ dir, repo: "o/r", sha: "a".repeat(40) });
  assert.equal(summary.added.length, 1);
  assert.equal(
    summary.added[0].code,
    'import { exec } from "node:child_process"',
  );
  assert.deepEqual(summary.problems.map((p) => p.path).sort(), [
    "plugins/one/bin/tool.exe",
    "plugins/one/lib/helper.mjs",
    "plugins/three/index.js",
  ]);
  const markdown = await readFile(join(dir, "report.md"), "utf8");
  assert.ok(markdown.startsWith(MARKER));
  assert.match(markdown, /security-review/);
  assert.match(
    markdown,
    /https:\/\/github\.com\/o\/r\/blob\/a{40}\/plugins\/one\/main\.ts#L1/,
  );
  assert.doesNotMatch(
    markdown,
    /<b>|@someone/,
    "no HTML or mentions from scan output",
  );
});

test("render: an unusual path is not shown", () => {
  const text = render({
    added: [finding("vestra-dynamic-code", "plugins/a/](https://evil)", "x")],
    known: 0,
    problems: [],
    plugins: ["a"],
  });
  assert.doesNotMatch(text, /evil/);
  assert.match(text, /unusual characters/);
});

test("render: nothing new", () => {
  const text = render({ added: [], known: 3, problems: [], plugins: ["a"] });
  assert.match(text, /No new findings \(3 unchanged/);
  assert.doesNotMatch(text, /security-review/);
});
