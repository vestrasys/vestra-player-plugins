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
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { plugins } from "./plugins.mjs";

const root = resolve(import.meta.dirname, "..");
const pluginsRoot = join(root, "plugins");

const args = process.argv.slice(2);
const command = args.shift();
const options = [];
for (const name of ["--version", "--out"]) {
  const index = args.indexOf(name);
  if (index >= 0) options.push(...args.splice(index, 2));
}
if (!command || !args.length) {
  console.error(
    "usage: node scripts/plugin.mjs <check|build|test|pack> <name...|--all> [--version x.y.z] [--out dir]",
  );
  process.exit(2);
}
const names = args.includes("--all") ? await plugins(pluginsRoot) : args;
const directories = names.map((name) =>
  name.includes("/") || name.includes("\\")
    ? resolve(root, name)
    : join(pluginsRoot, name),
);
for (const directory of directories)
  if (!existsSync(join(directory, "manifest.json"))) {
    console.error(`${directory}: no manifest.json (not a plugin directory)`);
    process.exit(2);
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
  { stdio: "inherit", cwd: root },
);
process.exit(result.status ?? 1);
