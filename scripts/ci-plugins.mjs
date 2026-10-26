#!/usr/bin/env node
/**
 * The plugins CI tests (ci.yml `changes`, publish.yml, weekly.yml): prints a
 * JSON array of plugin directory names, and with GITHUB_OUTPUT set also
 * writes `plugins=<that array>` to it.
 *
 *   node scripts/ci-plugins.mjs --all
 *   node scripts/ci-plugins.mjs --base <commit>
 *
 * --all     every directory under plugins/ with a manifest.json
 * --base    the plugins with a changed file between <commit> and HEAD, or
 *           every plugin when a shared file changed (package.json, the lock
 *           file, tsconfig.json, the plugin CLI wrapper, the npm
 *           dependency rules, the plugin workflows). A missing, all-zero or unknown base (a new branch,
 *           a force push) means every plugin. Removed plugins are not listed.
 */
import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { plugins } from "./plugins.mjs";

/** A change to any of these can break every plugin. */
const SHARED = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "scripts/plugin.mjs",
  "scripts/plugins.mjs",
  "scripts/plugin-deps.mjs",
  "scripts/lib/dependencies.mjs",
  "scripts/ci-plugins.mjs",
  "scripts/check-package.mjs",
  ".github/workflows/ci.yml",
  ".github/workflows/_plugin.yml",
];

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    all: { type: "boolean", default: false },
    base: { type: "string" },
  },
});

function git(...args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

const all = await plugins(join(root, "plugins"));
let selected = all;
let reason = "--all";
const base = values.base ?? "";
if (!values.all) {
  if (!base || /^0+$/.test(base)) reason = "no base commit";
  else if (git("cat-file", "-e", `${base}^{commit}`).status !== 0)
    reason = `base ${base} is not in this clone`;
  else {
    const diff = git("diff", "--name-only", "-z", base, "HEAD");
    if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
    const files = diff.stdout.split("\0").filter(Boolean);
    const shared = files.find((file) => SHARED.includes(file));
    if (shared) reason = `${shared} changed`;
    else {
      const changed = new Set(
        files
          .map((file) => /^plugins\/([^/]+)\//.exec(file)?.[1])
          .filter(Boolean),
      );
      selected = all.filter((name) => changed.has(name));
      reason = `changed since ${base.slice(0, 12)}`;
    }
  }
}

const json = JSON.stringify(selected);
console.log(`plugins (${reason}): ${json}`);
if (process.env.GITHUB_OUTPUT)
  await appendFile(process.env.GITHUB_OUTPUT, `plugins=${json}\n`);
