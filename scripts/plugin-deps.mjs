#!/usr/bin/env node
/**
 * npm dependencies of hosted plugins (rules: scripts/lib/dependencies.mjs and
 * CONTRIBUTING.md, "npm dependencies"):
 *
 *   node scripts/plugin-deps.mjs install <name...|--all>
 *   node scripts/plugin-deps.mjs licenses <name...|--all> [--write]
 *
 * install    for each plugin with dependencies: the lockfile rules, `npm ci
 *            --ignore-scripts` in the plugin directory (skipped when it is
 *            already installed from the same package.json and lockfile),
 *            then the installed rules. A plugin without dependencies only
 *            gets the static check. CI runs this before `tsc` over the
 *            repository; `scripts/plugin.mjs` does the same before every
 *            command.
 * licenses   installs, then with --write writes dependency-inventory.json and
 *            copies each package's license files into licenses/<name>/ (a
 *            license text you put there for a package that ships none is
 *            kept); without --write it only checks them.
 *
 * A name is a directory under plugins/, or a path with a slash relative to
 * the repository root. Exit status 1 with every problem listed.
 */
import { resolve } from "node:path";
import {
  allDependencyProblems,
  hasDependencies,
  prepareDependencies,
  writeLicenses,
} from "./lib/dependencies.mjs";
import { labelOf, pluginDirectories } from "./plugins.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const command = args.shift();
const write = args.includes("--write");
const names = args.filter((arg) => arg !== "--write");
if (!["install", "licenses"].includes(command) || !names.length) {
  console.error(
    "usage: node scripts/plugin-deps.mjs <install|licenses> <name...|--all> [--write]",
  );
  process.exit(2);
}

let failed = false;
try {
  for (const directory of await pluginDirectories(root, names)) {
    const label = labelOf(root, directory);
    let problems = await prepareDependencies(directory, label);
    if (!problems.length && write && (await hasDependencies(directory))) {
      await writeLicenses(directory, label);
      console.log(`${label}: wrote dependency-inventory.json and licenses/`);
    }
    if (!problems.length)
      problems = await allDependencyProblems(directory, label);
    for (const problem of problems) console.error(`✖ ${problem}`);
    if (problems.length) failed = true;
    else
      console.log(
        `${label}: ${(await hasDependencies(directory)) ? "npm dependencies OK" : "no npm dependencies"}`,
      );
  }
} catch (error) {
  console.error(`✖ ${error.message}`);
  failed = true;
}
process.exit(failed ? 1 : 0);
