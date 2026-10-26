#!/usr/bin/env node
/**
 * Checks a packed plugin (CI, after `vestra-plugin pack`):
 *
 *   node scripts/check-package.mjs <plugin dir> <package dir>
 *
 * <package dir> must hold exactly one <id>-<version>.vxp for the plugin's
 * manifest.json. The package is read as a zip: its manifest.json must have
 * the source manifest's id, version, apiVersion and capabilities, its entry
 * must be a .js file inside the package, and no entry may be a .ts file, a
 * test, an absolute path or leave the package.
 *
 * Every package also stays within the size limits (the .vxp and its files
 * unpacked) and holds no node_modules/ and no native code. A plugin with npm
 * dependencies ships its dependency-inventory.json and every license file it
 * lists under licenses/, byte for byte as in the plugin directory
 * (scripts/lib/dependencies.mjs).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  hasDependencies,
  INVENTORY,
  LICENSES,
  licenseDirectory,
  NATIVE_FILE,
  sizeProblems,
} from "./lib/dependencies.mjs";

/**
 * Entries of a zip archive: Map<name, () => Buffer>, with `unpacked` (the sum
 * of the declared uncompressed sizes). Stored and deflate only.
 */
function readZip(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0)
    throw new Error("not a zip archive (no end of central directory)");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  let unpacked = 0;
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("broken central directory");
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    unpacked += bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.set(name, () => {
      const start =
        local +
        30 +
        bytes.readUInt16LE(local + 26) +
        bytes.readUInt16LE(local + 28);
      const data = bytes.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`${name}: unsupported compression method ${method}`);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  entries.unpacked = unpacked;
  return entries;
}

try {
  const [pluginDirectory, packageDirectory] = process.argv.slice(2);
  if (!pluginDirectory || !packageDirectory)
    throw new Error(
      "usage: node scripts/check-package.mjs <plugin dir> <package dir>",
    );
  const source = JSON.parse(
    await readFile(join(pluginDirectory, "manifest.json"), "utf8"),
  );
  const asset = `${source.id}-${source.version}.vxp`;
  const found = (await readdir(packageDirectory)).filter((name) =>
    name.endsWith(".vxp"),
  );
  if (found.length !== 1 || found[0] !== asset)
    throw new Error(
      `${packageDirectory}: expected only ${asset}, found ${JSON.stringify(found)}`,
    );
  const bytes = await readFile(join(packageDirectory, asset));
  const entries = readZip(bytes);
  const problems = sizeProblems("size", bytes.length, entries.unpacked);
  for (const name of entries.keys()) {
    const normal = posix.normalize(name);
    if (
      name.startsWith("/") ||
      /^[a-zA-Z]:/.test(name) ||
      normal.startsWith("..")
    )
      problems.push(`${name}: path outside the package`);
    if (name.includes("\\")) problems.push(`${name}: backslash in path`);
    if (name.endsWith(".ts")) problems.push(`${name}: TypeScript source`);
    if (/^tests\//.test(name)) problems.push(`${name}: test file`);
    if (name.split("/").includes("node_modules"))
      problems.push(`${name}: node_modules in the package (bundle instead)`);
    if (NATIVE_FILE.test(name.slice(name.lastIndexOf("/") + 1)))
      problems.push(`${name}: native code`);
  }
  if (!entries.has("manifest.json"))
    throw new Error(`${asset}: no manifest.json`);
  const packed = JSON.parse(entries.get("manifest.json")().toString("utf8"));
  for (const field of ["id", "version", "apiVersion"])
    if (packed[field] !== source[field])
      problems.push(
        `manifest.json ${field}: ${JSON.stringify(packed[field])}, source has ${JSON.stringify(source[field])}`,
      );
  if (
    JSON.stringify(packed.capabilities ?? []) !==
    JSON.stringify(source.capabilities ?? [])
  )
    problems.push("manifest.json capabilities differ from the source manifest");
  if (typeof packed.entry !== "string" || !packed.entry.endsWith(".js"))
    problems.push(
      `manifest.json entry ${JSON.stringify(packed.entry)} is not a .js file`,
    );
  else if (!entries.has(packed.entry))
    problems.push(`entry ${packed.entry} is not in the package`);
  // npm dependencies: the inventory and the license texts travel along.
  if (await hasDependencies(pluginDirectory)) {
    const source = await readFile(join(pluginDirectory, INVENTORY)).catch(
      () => undefined,
    );
    if (!source) problems.push(`the plugin has no ${INVENTORY}`);
    else if (!entries.has(INVENTORY))
      problems.push(`${INVENTORY} is not in the package`);
    else if (!entries.get(INVENTORY)().equals(source))
      problems.push(`${INVENTORY} differs from the plugin's`);
    for (const item of source ? JSON.parse(source.toString("utf8")) : [])
      for (const file of item.licenseFiles ?? []) {
        const path = `${LICENSES}/${licenseDirectory(item.name)}/${file}`;
        if (!entries.has(path))
          problems.push(`${path} (${item.name}) is not in the package`);
        else if (
          !entries
            .get(path)()
            .equals(await readFile(join(pluginDirectory, ...path.split("/"))))
        )
          problems.push(`${path} differs from the plugin's`);
      }
  }

  if (problems.length) {
    for (const problem of problems) console.error(`✖ ${asset}: ${problem}`);
    process.exit(1);
  }
  console.log(`✔ ${asset}: ${entries.size} files, manifest matches the source`);
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
