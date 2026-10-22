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
 */
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { inflateRawSync } from "node:zlib";

/** Entries of a zip archive: Map<name, () => Buffer>. Stored and deflate only. */
function readZip(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0)
    throw new Error("not a zip archive (no end of central directory)");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("broken central directory");
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
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
  const entries = readZip(await readFile(join(packageDirectory, asset)));
  const problems = [];
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
  if (problems.length) {
    for (const problem of problems) console.error(`✖ ${asset}: ${problem}`);
    process.exit(1);
  }
  console.log(`✔ ${asset}: ${entries.size} files, manifest matches the source`);
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
