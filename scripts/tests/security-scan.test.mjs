import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  MARKER,
  classify,
  extract,
  newFindings,
  render,
  report,
} from "../security-scan.mjs";

// scripts/security-scan.mjs without semgrep: extraction from a scratch git
// repository, and the report from hand-written semgrep output. The rules
// themselves are tested with semgrep in _static.yml (.semgrep/tests/).
let root;
let out;
const git = (args, input) => {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
async function put(path, text) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
}
/** Adds a symbolic link to the index, whatever the file system supports. */
function symlink(path, target) {
  const sha = git(["hash-object", "-w", "--stdin"], target);
  git(["update-index", "--add", "--cacheinfo", `120000,${sha},${path}`]);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "security-scan-"));
  out = await mkdtemp(join(tmpdir(), "security-scan-out-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "test"]);
  git(["config", "core.autocrlf", "false"]);
  for (const name of ["one", "two"]) {
    await put(`plugins/${name}/manifest.json`, "{}");
    await put(`plugins/${name}/main.ts`, `export const name = "${name}";\n`);
    await put(`plugins/${name}/LICENSE`, "MIT\n");
  }
  await put(
    "plugins/one/run.ts",
    'import { spawn } from "node:child_process";\nconst bin = "yt-dlp";\nspawn(bin, []);\n',
  );
  await put("plugins/one/old.wasm", "\0asm");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  git(["tag", "base"]);
  await put(
    "plugins/one/main.ts",
    'import { exec } from "node:child_process";\nimport "./tests/util.ts";\nexport const name = "one";\n',
  );
  await put(
    "plugins/one/run.ts",
    'import { spawn } from "node:child_process";\nconst bin = process.argv[2];\nspawn(bin, []);\n',
  );
  await put("plugins/one/tests/util.ts", "eval('1');\n");
  await put("plugins/one/lib/helper.mjs", "export {};\n");
  await put("plugins/one/README.md", "# One\n");
  await put("plugins/one/page.html", "<script>1</script>\n");
  await put("plugins/one/payload", "#!/bin/sh\n");
  await put("plugins/one/bin/tool.exe", "MZ");
  await put("plugins/one/.semgrepignore", "*\n");
  await put("plugins/one/node_modules/.vestra-installed", "0\n");
  await put("plugins/one/node_modules/dep/index.js", "module.exports = 1;\n");
  await put("plugins/three/manifest.json", "{}");
  await put("plugins/three/index.js", "module.exports = 1;\n");
  git(["add", "-A", "-f"]);
  symlink("plugins/one/lib/outside", "../../../scripts");
  git(["commit", "-q", "-m", "head"]);
  git(["tag", "head"]);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

test("classify: code, data, and everything a reviewer must read", () => {
  const blob = (path, extra = {}) =>
    classify({ mode: "100644", type: "blob", size: 10, path, ...extra });
  assert.equal(blob("plugins/a/main.ts"), "code");
  assert.equal(blob("plugins/a/tests/x.test.ts"), "code", "tests/ is scanned");
  assert.equal(blob("plugins/a/lib/x.cjs"), "code");
  for (const data of [
    "plugins/a/README.md",
    "plugins/a/manifest.json",
    "plugins/a/ui.slint",
    "plugins/a/shaders/x.glsl",
    "plugins/a/locales/de.po",
    "plugins/a/assets/icon.png",
    "plugins/a/licenses/x/LICENSE",
    "plugins/a/shaders/y/LICENSE-BSD-3-Clause",
  ])
    assert.equal(blob(data), "data", data);
  for (const other of [
    "plugins/a/page.html",
    "plugins/a/x.vue",
    "plugins/a/x.svelte",
    "plugins/a/payload",
    "plugins/a/x.wasm",
    "plugins/a/.semgrepignore",
  ])
    assert.match(blob(other), /not code/, other);
  for (const config of [
    "plugins/a/tsconfig.json",
    "plugins/a/tsconfig.build.json",
    "plugins/a/lib/jsconfig.json",
  ])
    assert.match(blob(config), /compiler configuration/, config);
  assert.match(blob("plugins/a/node_modules/x/index.js"), /node_modules/);
  assert.match(blob("plugins/a/lib", { mode: "120000" }), /symbolic link/);
  assert.match(
    classify({ mode: "160000", type: "commit", size: 0, path: "plugins/a/s" }),
    /submodule/,
  );
  assert.match(blob("plugins/a/big.ts", { size: 17 * 1024 * 1024 }), /16 MiB/);
});

test("extract: changed plugins at head and base, tests/ included, problems new since base", async () => {
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
    "plugins/one/run.ts",
    "plugins/one/tests/util.ts",
    "plugins/three/index.js",
  ]);
  assert.deepEqual(scan.baseFiles.sort(), [
    "plugins/one/main.ts",
    "plugins/one/run.ts",
  ]);
  assert.deepEqual(
    scan.problems.map((p) => p.path).sort(),
    [
      "plugins/one/.semgrepignore",
      "plugins/one/bin/tool.exe",
      "plugins/one/lib/outside",
      "plugins/one/node_modules/.vestra-installed",
      "plugins/one/node_modules/dep/index.js",
      "plugins/one/page.html",
      "plugins/one/payload",
    ],
    "old.wasm is unchanged since base: not listed again",
  );
  assert.ok(scan.changed.includes("plugins/one/run.ts"));
  assert.match(
    await readFile(join(dir, "head/plugins/one/tests/util.ts"), "utf8"),
    /eval/,
  );
  // Our own (empty) ignore file at the root; the plugin's is not extracted,
  // nor are node_modules or the symbolic link.
  assert.match(await readFile(join(dir, "head/.semgrepignore"), "utf8"), /^#/);
  for (const absent of [
    ".semgrepignore",
    "node_modules/dep/index.js",
    "lib/outside",
  ])
    await assert.rejects(readFile(join(dir, "head/plugins/one", absent)));
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
  assert.ok(scan.problems.some((p) => p.path === "plugins/one/old.wasm"));
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
  const code = "import 'child_process'";
  const base = [finding("vestra-child-process", "plugins/a/x.ts", code, 1)];
  const head = [
    finding("vestra-child-process", "plugins/a/x.ts", code, 9),
    finding("vestra-child-process", "plugins/a/x.ts", code, 12),
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

test("report: new findings, known findings in changed files, problems; untrusted text is escaped", async () => {
  const dir = join(out, "pr");
  const result = async (tree, path, needle) => {
    const source = await readFile(join(dir, tree, path));
    const start = source.indexOf(needle);
    assert.ok(start >= 0, needle);
    return {
      check_id: "semgrep.vestra-child-process",
      path: path.split("/").join("\\"),
      start: { line: 1, col: 1, offset: start },
      end: { line: 1, col: 1, offset: start + needle.length },
      extra: { severity: "WARNING", message: "Runs <b>programs</b> @someone" },
    };
  };
  const spawnImport = 'import { spawn } from "node:child_process"';
  await writeFile(
    join(dir, "head.json"),
    JSON.stringify({
      results: [
        await result(
          "head",
          "plugins/one/main.ts",
          'import { exec } from "node:child_process"',
        ),
        await result("head", "plugins/one/run.ts", spawnImport),
      ],
      errors: [{ type: "Timeout", path: "plugins/three/index.js" }],
      // helper.mjs missing: semgrep skipped it.
      paths: {
        scanned: [
          "plugins/one/main.ts",
          "plugins/one/run.ts",
          "plugins/one/tests/util.ts",
          "plugins/three/index.js",
        ],
      },
    }),
  );
  await writeFile(
    join(dir, "base.json"),
    JSON.stringify({
      results: [await result("base", "plugins/one/run.ts", spawnImport)],
      errors: [],
      paths: { scanned: ["plugins/one/main.ts", "plugins/one/run.ts"] },
    }),
  );
  const summary = await report({ dir, repo: "o/r", sha: "a".repeat(40) });
  assert.deepEqual(
    summary.added.map((f) => f.path),
    ["plugins/one/main.ts"],
  );
  assert.deepEqual(
    summary.touched.map((f) => f.path),
    ["plugins/one/run.ts"],
    "spawn(bin) whose bin changed: known, but its file changed",
  );
  for (const path of [
    "plugins/one/lib/helper.mjs",
    "plugins/three/index.js",
    "plugins/one/lib/outside",
    "plugins/one/node_modules/dep/index.js",
  ])
    assert.ok(
      summary.problems.some((p) => p.path === path),
      path,
    );
  const markdown = await readFile(join(dir, "report.md"), "utf8");
  assert.ok(markdown.startsWith(MARKER));
  assert.match(markdown, /security-review/);
  assert.match(markdown, /<details>[\s\S]*plugins\/one\/run\.ts/);
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

test("report fails when semgrep output is missing", async () => {
  const dir = join(out, "missing");
  await extract({ cwd: root, base: "base", head: "head", out: dir });
  await assert.rejects(report({ dir }), /did not run/);
});

test("render: an unusual path is not shown", () => {
  const text = render({
    added: [finding("vestra-dynamic-code", "plugins/a/](https://evil)", "x")],
    touched: [],
    known: 0,
    problems: [],
    plugins: ["a"],
  });
  assert.doesNotMatch(text, /evil/);
  assert.match(text, /unusual characters/);
});

test("render: nothing to review", () => {
  const text = render({
    added: [],
    touched: [],
    known: 3,
    problems: [],
    plugins: ["a"],
  });
  assert.match(text, /Nothing to review \(3 unchanged/);
  assert.doesNotMatch(text, /security-review/);
});
