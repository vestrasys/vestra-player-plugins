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
 * extract  writes the code files (tests/ included: esbuild bundles whatever
 *          the entry imports) of every plugin changed between the merge base
 *          of <base> and <head> (or of every plugin with --all) as they are
 *          at <head> to <dir>/head/plugins/<name>/ and at <base> to
 *          <dir>/base/plugins/<name>/, plus <dir>/scan.json: the plugins, the
 *          code files, the files changed by the pull request, and the
 *          problems: every file the scan cannot vouch for (symbolic links,
 *          submodules, tracked node_modules, files too large to read, and
 *          every file that is neither code nor a known data type). Each tree
 *          gets its own .semgrepignore (with nothing in it), so semgrep's
 *          default ignores (tests/, *.min.js, dist/, …) do not apply (with
 *          `--project-root .`); a pull request's own ignore files are never
 *          extracted.
 * report   reads <dir>/head.json and <dir>/base.json (`semgrep scan --json`
 *          run in <dir>/head and <dir>/base on `plugins`) and reports
 *          - the findings at <head> that are not at <base> (same rule, file
 *            and matched code; line numbers may move);
 *          - the findings already at <base> in files the pull request
 *            changes (a changed argument of an existing `spawn(bin, args)`
 *            is not a new finding, but it needs the same review);
 *          - the problems that are new or changed at <head>, every file
 *            semgrep did not scan and every semgrep error.
 *          Writes <dir>/report.md (the pull request comment) and
 *          <dir>/report.json, appends to GITHUB_STEP_SUMMARY and writes
 *          `findings=<count>` to GITHUB_OUTPUT when set. Exit code 0 either
 *          way: findings are for a reviewer, not a failure. Exit code 2 when
 *          the scan itself is missing or malformed (the workflow then labels
 *          the pull request as well: it fails closed).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Files semgrep reads as JavaScript or TypeScript. */
export const CODE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/i;
/**
 * Data files a plugin may carry that cannot run on their own: text, the
 * player's UI and shader formats, translations and images. Everything else
 * (other languages, HTML, binaries, archives, files without an extension
 * other than license texts) is listed for a reviewer.
 */
export const DATA =
  /\.(json|md|txt|po|pot|slint|glsl|hook|png|jpe?g|gif|webp|svg|ico|toml|csv)$/i;
/** License and notice files, often without an extension. */
const NOTICE =
  /(^|\/)(LICEN[CS]E|COPYING|NOTICE|AUTHORS|COPYRIGHT)([-._][A-Za-z0-9.+_-]*)?$/;
/** git cat-file reads blobs up to this size (packages are at most 16 MiB unpacked). */
export const MAX_BLOB = 16 * 1024 * 1024;
/** Paths shown in the report: plain characters only (the rest is escaped away). */
const SAFE_PATH = /^plugins\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._@+-]+)*$/;
const RULE = /(vestra-[a-z0-9-]+)$/;
/** At most this many entries are listed per section of the comment (all are counted). */
const LISTED = 50;
export const MARKER = "<!-- vestra-plugin-security-scan -->";

function git(cwd, args, encoding = "utf8") {
  const result = spawnSync("git", args, {
    cwd,
    encoding,
    maxBuffer: MAX_BLOB + 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** `{ mode, type, sha, size, path }` of every entry under plugins/<name>/ at `rev`. */
function tree(cwd, rev, name) {
  const out = git(cwd, [
    "ls-tree",
    "-r",
    "-l",
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
      const [, mode, type, sha, size, path] =
        /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t(.*)$/s.exec(line) ?? [];
      if (!path) throw new Error(`git ls-tree: unexpected line ${line}`);
      return { mode, type, sha, size: size === "-" ? 0 : Number(size), path };
    });
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

/** Files changed between the merge base of `base` and `head`. */
function changedFiles(cwd, base, head) {
  return git(cwd, ["diff", "--name-only", "-z", `${base}...${head}`, "--"])
    .split("\0")
    .filter(Boolean);
}

/**
 * What the scan does with one tree entry: "code" (semgrep reads it),
 * "data" (a known data type), or the reason a reviewer must look at it.
 */
export function classify(entry) {
  const parts = entry.path.split("/");
  if (entry.mode === "120000")
    return "symbolic link: esbuild follows it to files the scan does not read";
  if (entry.type === "commit" || entry.mode === "160000")
    return "git submodule";
  if (parts.includes("node_modules"))
    return "tracked node_modules: dependencies are installed from the lockfile, never committed";
  if (entry.size > MAX_BLOB) return "larger than 16 MiB: not read";
  if (CODE.test(entry.path)) return "code";
  if (DATA.test(entry.path) || NOTICE.test(entry.path)) return "data";
  return "not code the scan reads and not a known data type";
}

async function writeTree(cwd, rev, names, out) {
  const files = [];
  const problems = [];
  for (const name of names) {
    for (const entry of tree(cwd, rev, name)) {
      const kind = classify(entry);
      if (kind === "data") continue;
      if (kind !== "code") {
        problems.push({ path: entry.path, sha: entry.sha, reason: kind });
        continue;
      }
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
  return { files, problems };
}

export async function extract({ cwd, base, head, all, out }) {
  if (!head) throw new Error("--head is required");
  if (!all && !base) throw new Error("--base or --all is required");
  const changed = all ? [] : changedFiles(cwd, base, head);
  const present = pluginsAt(cwd, head);
  const names = all
    ? present
    : present.filter((name) =>
        changed.some((file) => file.startsWith(`plugins/${name}/`)),
      );
  const headTree = await writeTree(cwd, head, names, join(out, "head"));
  const atBase = all ? [] : pluginsAt(cwd, base);
  const baseTree = await writeTree(
    cwd,
    all ? head : base,
    names.filter((name) => atBase.includes(name)),
    join(out, "base"),
  );
  const baseProblems = new Set(
    baseTree.problems.map((p) => `${p.path}\0${p.sha}`),
  );
  const scan = {
    plugins: names,
    files: headTree.files,
    baseFiles: baseTree.files,
    changed: changed.filter((file) => file.startsWith("plugins/")),
    // New or changed since the base: an unchanged, already reviewed file is
    // not listed again.
    problems: headTree.problems
      .filter((p) => !baseProblems.has(`${p.path}\0${p.sha}`))
      .map(({ path, reason }) => ({ path, reason })),
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
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function render({
  added,
  touched,
  known,
  problems,
  plugins,
  repo,
  sha,
}) {
  const link = (path, line) =>
    repo && sha && SAFE_PATH.test(path)
      ? `[\`${path}:${line}\`](https://github.com/${repo}/blob/${sha}/${path}#L${line})`
      : `\`${shownPath(path)}:${line}\``;
  const table = (list) => {
    const rows = [
      "| Rule | Severity | Where | Why |",
      "| --- | --- | --- | --- |",
      ...list
        .slice(0, LISTED)
        .map(
          (f) =>
            `| \`${RULE.test(f.rule) ? f.rule : "unknown"}\` | ${escape(f.severity)} | ${link(f.path, f.line)} | ${escape(f.message)} |`,
        ),
    ];
    if (list.length > LISTED)
      rows.push(
        "",
        `… and ${list.length - LISTED} more (see the job summary).`,
      );
    return rows;
  };
  const lines = [MARKER, "## Plugin security scan", ""];
  lines.push(
    `Scanned ${plugins.length ? plugins.map((p) => `\`${shownPath(`plugins/${p}`)}\``).join(", ") : "no plugin"} with \`.semgrep/plugin-risk.yml\` from the base branch.`,
    "",
  );
  if (!added.length && !touched.length && !problems.length) {
    lines.push(
      `Nothing to review (${known} unchanged findings in files this pull request does not change).`,
    );
    return lines.join("\n") + "\n";
  }
  const parts = [];
  if (added.length) parts.push(`**${plural(added.length, "new finding")}**`);
  if (touched.length)
    parts.push(
      `**${plural(touched.length, "known finding")} in changed files**`,
    );
  if (problems.length)
    parts.push(
      `**${plural(problems.length, "file")} the scan cannot vouch for**`,
    );
  lines.push(
    `${parts.join(", ")}. This pull request is labelled \`security-review\`: a maintainer reads the code below and removes the label when it is acceptable (CONTRIBUTING.md, "Security review"). A finding is a place to read, not a verdict.`,
    "",
  );
  if (added.length) lines.push("### New findings", "", ...table(added), "");
  if (problems.length) {
    lines.push("### Files to read by hand", "");
    for (const p of problems.slice(0, LISTED))
      lines.push(`- \`${shownPath(p.path)}\`: ${escape(p.reason)}`);
    if (problems.length > LISTED)
      lines.push(
        `- … and ${problems.length - LISTED} more (see the job summary)`,
      );
    lines.push("");
  }
  if (touched.length)
    lines.push(
      "<details>",
      `<summary>Known findings in files this pull request changes (${touched.length}): check that the change does not alter what they do</summary>`,
      "",
      ...table(touched),
      "",
      "</details>",
      "",
    );
  return lines.join("\n") + "\n";
}

export async function report({ dir, repo, sha }) {
  const scan = JSON.parse(await readFile(join(dir, "scan.json"), "utf8"));
  const read = async (name, required) => {
    const path = join(dir, name);
    if (!existsSync(path)) {
      if (required)
        throw new Error(`${name} is missing: the semgrep scan did not run`);
      return { results: [], errors: [], paths: { scanned: [] } };
    }
    const json = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(json.results))
      throw new Error(`${name} has no results: the semgrep scan did not run`);
    return json;
  };
  const headScan = await read("head.json", scan.files.length > 0);
  const baseScan = await read("base.json", scan.baseFiles.length > 0);
  const head = await findings(join(dir, "head"), headScan);
  const base = await findings(join(dir, "base"), baseScan);
  const added = newFindings(head, base);
  const addedSet = new Set(added);
  const changed = new Set(scan.changed ?? []);
  const touched = head.filter((f) => !addedSet.has(f) && changed.has(f.path));
  const problems = [...scan.problems];
  const scannedPaths = new Set((headScan.paths?.scanned ?? []).map(posix));
  for (const path of scan.files)
    if (!scannedPaths.has(path))
      problems.push({ path, reason: "semgrep skipped this file" });
  for (const error of headScan.errors ?? [])
    problems.push({
      path: posix(error.path ?? error.spans?.[0]?.file ?? "?"),
      reason: `semgrep: ${String(error.type ?? "error")}`.slice(0, 120),
    });
  const unique = new Map(problems.map((p) => [`${p.path}\0${p.reason}`, p]));
  const result = {
    plugins: scan.plugins,
    added,
    touched,
    known: head.length - added.length - touched.length,
    problems: [...unique.values()],
  };
  const markdown = render({ ...result, repo, sha });
  await writeFile(join(dir, "report.md"), markdown);
  await writeFile(join(dir, "report.json"), JSON.stringify(result, null, 2));
  const count =
    result.added.length + result.touched.length + result.problems.length;
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
        `plugins: ${JSON.stringify(scan.plugins)}; ${scan.files.length} code files at head, ${scan.baseFiles.length} at base; ${scan.problems.length} files to read by hand`,
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
      for (const f of result.touched)
        console.log(
          `known, file changed: ${f.rule} ${f.path}:${f.line}  ${f.code.slice(0, 120)}`,
        );
      for (const p of result.problems)
        console.log(`read by hand: ${p.path}: ${p.reason}`);
      console.log(
        `${result.added.length} new findings, ${result.touched.length} known findings in changed files, ${result.known} unchanged, ${result.problems.length} files to read by hand`,
      );
    } else {
      throw new Error("usage: security-scan.mjs extract|report …");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
