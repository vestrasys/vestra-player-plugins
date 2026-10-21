import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

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
