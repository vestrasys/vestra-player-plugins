import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/** Names of the plugin directories (those with a manifest.json), sorted. */
export async function plugins(pluginsRoot) {
  return (await readdir(pluginsRoot, { withFileTypes: true }))
    .filter(
      (item) =>
        item.isDirectory() &&
        existsSync(join(pluginsRoot, item.name, "manifest.json")),
    )
    .map((item) => item.name)
    .sort();
}

/**
 * Plugin directories from command-line names: a name is a directory under
 * plugins/, a name with a slash a path relative to `root`, and `--all`
 * every plugin directory. Throws when one has no manifest.json.
 */
export async function pluginDirectories(root, names) {
  const pluginsRoot = join(root, "plugins");
  const list = names.includes("--all") ? await plugins(pluginsRoot) : names;
  const directories = list.map((name) =>
    name.includes("/") || name.includes("\\")
      ? resolve(root, name)
      : join(pluginsRoot, name),
  );
  for (const directory of directories)
    if (!existsSync(join(directory, "manifest.json")))
      throw new Error(
        `${directory}: no manifest.json (not a plugin directory)`,
      );
  return directories;
}

/** `plugins/<name>` for a directory in the repository, else the path. */
export function labelOf(root, directory) {
  const path = relative(root, directory).split("\\").join("/");
  return path.startsWith("..") ? directory : path;
}
