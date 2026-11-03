#!/usr/bin/env node
/**
 * The plugin security scan of a pull request (.github/workflows/
 * security-scan.yml; CONTRIBUTING.md "Security review"). Node built-ins
 * only: it runs from the base branch and reads the pull request's files as
 * data (git), never runs them.
 *
 *   node scripts/security-scan.mjs extract --base <rev> --head <rev> --out <dir>
 *   node scripts/security-scan.mjs extract --all --head <rev> --out <dir>
 *   node scripts/security-scan.mjs report --dir <dir> [--repo <owner/name>] [--sha <commit>]
 *
 * extract  writes the code files of every plugin changed between the merge
 *          base of <base> and <head> (or of every plugin with --all) as they
 *          are at <head> to <dir>/head/plugins/<name>/ and at <base> to
 *          <dir>/base/plugins/<name>/, plus <dir>/scan.json (the plugins,
 *          the files, and files the scan cannot read: binaries and scripts
 *          for other interpreters). A plugin's tests/ are left out: they are
 *          not packaged. Each tree gets its own .semgrepignore (with nothing
 *          in it), so semgrep's default ignores (tests/, *.min.js, dist/, …)
 *          do not apply and a pull request cannot add ignore files: only
 *          code files are extracted.
 * report   reads <dir>/head.json and <dir>/base.json (`semgrep scan --json`
 *          run in <dir>/head and <dir>/base on `plugins`) and reports the
 *          findings at <head> that are not at <base> (same rule, file and
 *          matched code; line numbers may move), every file semgrep could
 *          not scan, and every unreadable file. Writes <dir>/report.md (the
 *          pull request comment) and <dir>/report.json, appends to
 *          GITHUB_STEP_SUMMARY and writes `findings=<count>` to
 *          GITHUB_OUTPUT when set. Exit code 0 either way: findings are for
 *          a reviewer, not a failure. Exit code 2 when the scan itself is
 *          missing or malformed.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Files semgrep reads as JavaScript or TypeScript. */
export const CODE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/i;
/**
 * Files a plugin could run or load that semgrep cannot read: native code,
 * WebAssembly, archives and scripts for other interpreters.
 */
export const OPAQUE =
  /\.(node|wasm|exe|dll|so|dylib|a|lib|o|obj|bin|jar|class|zip|7z|rar|gz|tgz|tar|xz|bz2|vxp|sh|bash|zsh|ps1|psm1|bat|cmd|vbs|vbe|wsf|py|pyc|rb|pl|php|lua|asar)$/i;
/** Paths shown in the report: plain characters only (the rest is escaped away). */
const SAFE_PATH = /^plugins\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._@+-]+)*$/;
const RULE = /(vestra-[a-z0-9-]+)$/;
/** At most this many findings are listed in the comment (all are counted). */
const LISTED = 50;
export const MARKER = "<!-- vestra-plugin-security-scan -->";

function git(cwd, args, encoding = "utf8") {
  const result = spawnSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** `{ path, sha, mode }` of every blob under plugins/<name>/ at `rev`. */
function tree(cwd, rev, name) {
  const out = git(cwd, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    rev,
    "--",
    `plugins/${name}/`,
  ]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, type, sha] = meta.split(" ");
      return { mode, type, sha, path };
    })
    .filter((entry) => entry.type === "blob");
}

/** Plugin directory names (with a manifest.json) at `rev`. */
function pluginsAt(cwd, rev) {
  return git(cwd, ["ls-tree", "-z", "--name-only", rev, "plugins/"])
    .split("\0")
    .filter(Boolean)
    .map((path) => path.slice("plugins/".length))
    .filter(
      (name) =>
        spawnSync(
          "git",
          ["cat-file", "-e", `${rev}:plugins/${name}/manifest.json`],
          { cwd },
        ).status === 0,
    )
    .sort();
}

/** Plugins with a changed file between the merge base of `base` and `head`, present at `head`. */
function changedPlugins(cwd, base, head) {
  const files = git(cwd, [
    "diff",
    "--name-only",
    "-z",
    `${base}...${head}`,
    "--",
  ])
    .split("\0")
    .filter(Boolean);
  const names = new Set(
    files.map((file) => /^plugins\/([^/]+)\//.exec(file)?.[1]).filter(Boolean),
  );
  const present = new Set(pluginsAt(cwd, head));
  return [...names].filter((name) => present.has(name)).sort();
}

/** Whether a path inside a plugin is packaged code to scan (not its tests). */
export function scanned(path) {
  const [, , top] = path.split("/");
  return (
    CODE.test(path) &&
    top !== "tests" &&
    !path.split("/").includes("node_modules")
  );
}

async function writeTree(cwd, rev, names, out) {
  const files = [];
  const opaque = [];
  for (const name of names) {
    for (const entry of tree(cwd, rev, name)) {
      if (entry.path.split("/").includes("node_modules")) continue;
      if (OPAQUE.test(entry.path) || entry.mode === "160000") {
        opaque.push(entry.path);
        continue;
      }
      if (!scanned(entry.path)) continue;
      // A symbolic link is written as a file holding its target: data.
      const bytes = git(cwd, ["cat-file", "blob", entry.sha], "buffer");
      const target = join(out, ...entry.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      files.push(entry.path);
    }
  }
  // semgrep's target, present even when no code file changed.
  await mkdir(join(out, "plugins"), { recursive: true });
  // Present (and empty) so that semgrep's default ignore list is not used.
  await writeFile(
    join(out, ".semgrepignore"),
    "# Written by scripts/security-scan.mjs: scan every extracted file.\n",
  );
  return { files, opaque };
}

export async function extract({ cwd, base, head, all, out }) {
  if (!head) throw new Error("--head is required");
  if (!all && !base) throw new Error("--base or --all is required");
  const names = all ? pluginsAt(cwd, head) : changedPlugins(cwd, base, head);
  const headTree = await writeTree(cwd, head, names, join(out, "head"));
  const baseNames =
    all || !base
      ? []
      : names.filter((name) => pluginsAt(cwd, base).includes(name));
  const baseTree = await writeTree(
    cwd,
    base ?? head,
    baseNames,
    join(out, "base"),
  );
  const scan = {
    plugins: names,
    files: headTree.files,
    opaque: headTree.opaque,
    baseFiles: baseTree.files,
    baseOpaque: baseTree.opaque,
  };
  await writeFile(join(out, "scan.json"), JSON.stringify(scan, null, 2));
  return scan;
}

const posix = (path) => path.split("\\").join("/");

/** The matched code, whitespace collapsed: what identifies a finding across line moves. */
function snippet(source, result) {
  if (!source) return "";
  return source
    .subarray(result.start.offset, result.end.offset)
    .toString("utf8")
    .replace(/\s+/g, " ")
    .trim();
}

async function findings(root, semgrep) {
  const cache = new Map();
  const list = [];
  for (const result of semgrep.results ?? []) {
    const path = posix(result.path);
    if (!cache.has(path))
      cache.set(path, await readFile(join(root, path)).catch(() => null));
    list.push({
      rule: RULE.exec(result.check_id)?.[1] ?? result.check_id,
      severity: result.extra?.severity ?? "INFO",
      message: result.extra?.message ?? "",
      path,
      line: result.start?.line ?? 0,
      code: snippet(cache.get(path), result),
    });
  }
  return list;
}

/** Head findings not in base, compared as a multiset of (rule, path, code). */
export function newFindings(head, base) {
  const key = (f) => `${f.rule}\0${f.path}\0${f.code}`;
  const counts = new Map();
  for (const f of base) counts.set(key(f), (counts.get(key(f)) ?? 0) + 1);
  return head.filter((f) => {
    const left = counts.get(key(f)) ?? 0;
    if (left > 0) {
      counts.set(key(f), left - 1);
      return false;
    }
    return true;
  });
}

const escape = (text) =>
  String(text)
    .replace(/\s+/g, " ")
    .replace(/[\\`*_[\]<>|@&]/g, (c) => `&#${c.charCodeAt(0)};`);
const shownPath = (path) =>
  SAFE_PATH.test(path) ? path : "(a path with unusual characters)";

export function render({ added, known, problems, plugins, repo, sha }) {
  const link = (path, line) =>
    repo && sha && SAFE_PATH.test(path)
      ? `[\`${path}:${line}\`](https://github.com/${repo}/blob/${sha}/${path}#L${line})`
      : `\`${shownPath(path)}:${line}\``;
  const lines = [MARKER, "## Plugin security scan", ""];
  lines.push(
    `Scanned ${plugins.length ? plugins.map((p) => `\`${shownPath(`plugins/${p}`)}\``).join(", ") : "no plugin"} with \`.semgrep/plugin-risk.yml\` from the base branch.`,
    "",
  );
  if (!added.length && !problems.length) {
    lines.push(`No new findings (${known} unchanged from the base branch).`);
    return lines.join("\n") + "\n";
  }
  lines.push(
    `**${added.length} new finding${added.length === 1 ? "" : "s"}**${problems.length ? ` and **${problems.length} file${problems.length === 1 ? "" : "s"} the scan could not read**` : ""} (${known} unchanged from the base branch). This pull request is labelled \`security-review\`: a maintainer reads the code below and removes the label when it is acceptable (CONTRIBUTING.md, "Security review"). A finding is a place to read, not a verdict.`,
    "",
  );
  if (added.length) {
    lines.push(
      "| Rule | Severity | Where | Why |",
      "| --- | --- | --- | --- |",
    );
    for (const f of added.slice(0, LISTED))
      lines.push(
        `| \`${RULE.test(f.rule) ? f.rule : "unknown"}\` | ${escape(f.severity)} | ${link(f.path, f.line)} | ${escape(f.message)} |`,
      );
    if (added.length > LISTED)
      lines.push(
        "",
        `… and ${added.length - LISTED} more (see the job summary).`,
      );
    lines.push("");
  }
  if (problems.length) {
    lines.push("Not scanned (read these by hand):", "");
    for (const p of problems.slice(0, LISTED))
      lines.push(`- \`${shownPath(p.path)}\`: ${escape(p.reason)}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

export async function report({ dir, repo, sha }) {
  const scan = JSON.parse(await readFile(join(dir, "scan.json"), "utf8"));
  const read = async (name) => {
    const path = join(dir, name);
    if (!existsSync(path))
      return { results: [], errors: [], paths: { scanned: [] } };
    return JSON.parse(await readFile(path, "utf8"));
  };
  const headScan = await read("head.json");
  const baseScan = await read("base.json");
  if (scan.files.length && !Array.isArray(headScan.results))
    throw new Error("head.json has no results: the semgrep scan did not run");
  const head = await findings(join(dir, "head"), headScan);
  const base = await findings(join(dir, "base"), baseScan);
  const added = newFindings(head, base);
  const problems = [];
  const scannedPaths = new Set((headScan.paths?.scanned ?? []).map(posix));
  for (const path of scan.files)
    if (!scannedPaths.has(path))
      problems.push({ path, reason: "semgrep skipped this file" });
  for (const error of headScan.errors ?? [])
    problems.push({
      path: posix(error.path ?? error.spans?.[0]?.file ?? "?"),
      reason: `semgrep: ${String(error.type ?? "error")}`.slice(0, 120),
    });
  const baseOpaque = new Set(scan.baseOpaque ?? []);
  for (const path of scan.opaque)
    if (!baseOpaque.has(path))
      problems.push({
        path,
        reason: "binary, archive or script semgrep cannot read",
      });
  const unique = new Map(problems.map((p) => [`${p.path}\0${p.reason}`, p]));
  const result = {
    plugins: scan.plugins,
    added,
    known: head.length - added.length,
    problems: [...unique.values()],
  };
  const markdown = render({ ...result, repo, sha });
  await writeFile(join(dir, "report.md"), markdown);
  await writeFile(join(dir, "report.json"), JSON.stringify(result, null, 2));
  const count = result.added.length + result.problems.length;
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `findings=${count}\n`);
  return result;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      base: { type: "string" },
      head: { type: "string" },
      all: { type: "boolean", default: false },
      out: { type: "string" },
      dir: { type: "string" },
      repo: { type: "string" },
      sha: { type: "string" },
    },
  });
  try {
    if (command === "extract") {
      if (!values.out) throw new Error("--out is required");
      const scan = await extract({
        cwd: process.cwd(),
        base: values.base,
        head: values.head,
        all: values.all,
        out: resolve(values.out),
      });
      console.log(
        `plugins: ${JSON.stringify(scan.plugins)}; ${scan.files.length} code files at head, ${scan.baseFiles.length} at base; ${scan.opaque.length} unreadable`,
      );
    } else if (command === "report") {
      if (!values.dir) throw new Error("--dir is required");
      const repo = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(values.repo ?? "")
        ? values.repo
        : undefined;
      const sha = /^[0-9a-f]{40}$/.test(values.sha ?? "")
        ? values.sha
        : undefined;
      const result = await report({ dir: resolve(values.dir), repo, sha });
      for (const f of result.added)
        console.log(
          `new: ${f.rule} ${f.path}:${f.line}  ${f.code.slice(0, 120)}`,
        );
      for (const p of result.problems)
        console.log(`not scanned: ${p.path}: ${p.reason}`);
      console.log(
        `${result.added.length} new findings, ${result.known} unchanged, ${result.problems.length} files not scanned`,
      );
    } else {
      throw new Error("usage: security-scan.mjs extract|report …");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
