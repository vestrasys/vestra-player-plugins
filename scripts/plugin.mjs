#!/usr/bin/env node
/**
 * Repository shortcut for the SDK's `vestra-plugin` CLI:
 *
 *   node scripts/plugin.mjs <check|build|test|pack> <name...|--all> [--version x.y.z] [--out dir]
 *
 * A name is a directory under plugins/; a name with a slash is a path relative
 * to the repository root (for example `plugins/marks`). `--all` covers every
 * directory under plugins/ that has a manifest.json. Everything else,
 * including the options, is the CLI's (see its header in
 * @vestra-player/sdk/bin/vestra-plugin.mjs).
 *
 * Before the CLI runs, a plugin with npm dependencies is checked and
 * installed (scripts/lib/dependencies.mjs): the lockfile rules, `npm ci
 * --ignore-scripts` in the plugin directory, then the installed rules (no
 * native code, license files). The CLI itself runs with install scripts
 * disabled. After `build` and `pack`, the package must stay within the size
 * limits.
 */
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  allDependencyProblems,
  directorySize,
  prepareDependencies,
  sizeProblems,
} from "./lib/dependencies.mjs";
import { labelOf, pluginDirectories } from "./plugins.mjs";

const root = resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const command = args.shift();
const options = [];
const values = {};
for (const name of ["--version", "--out"]) {
  const index = args.indexOf(name);
  if (index >= 0) {
    values[name] = args[index + 1];
    options.push(...args.splice(index, 2));
  }
}
if (!command || !args.length) {
  console.error(
    "usage: node scripts/plugin.mjs <check|build|test|pack> <name...|--all> [--version x.y.z] [--out dir]",
  );
  process.exit(2);
}
let directories;
try {
  directories = await pluginDirectories(root, args);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

/** Prints the problems and exits 1 when there are any. */
function stop(problems) {
  if (!problems.length) return;
  for (const problem of problems) console.error(`✖ ${problem}`);
  process.exit(1);
}

// npm dependencies: checked, installed without scripts, checked again.
for (const directory of directories) {
  const label = labelOf(root, directory);
  stop(await prepareDependencies(directory, label));
  stop(await allDependencyProblems(directory, label));
}

// The CLI from the installed SDK package (node_modules/@vestra-player/sdk).
const sdkPackage = createRequire(join(root, "package.json")).resolve(
  "@vestra-player/sdk/package.json",
);
const { bin } = JSON.parse(await readFile(sdkPackage, "utf8"));
const cli = join(dirname(sdkPackage), bin["vestra-plugin"]);
const result = spawnSync(
  process.execPath,
  [cli, command, ...directories, ...options],
  {
    stdio: "inherit",
    cwd: root,
    // The CLI runs `npm ci` itself when node_modules is missing: never scripts.
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);

if (command === "build" || command === "pack")
  for (const directory of directories) {
    const label = labelOf(root, directory);
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    const version = values["--version"] ?? manifest.version;
    const packed =
      command === "pack"
        ? (
            await stat(
              join(
                resolve(root, values["--out"] ?? "."),
                `${manifest.id}-${version}.vxp`,
              ),
            )
          ).size
        : undefined;
    stop(
      sizeProblems(label, packed, await directorySize(join(directory, "dist"))),
    );
  }
