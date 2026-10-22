#!/usr/bin/env node
/**
 * Verifies <dir>/index.json against <dir>/index.json.sig.
 *
 *   node scripts/verify-index.mjs [--public-key <pem file>]... [<pem file>...] <dir>
 *
 * The public keys come from --public-key (repeatable) and from every
 * positional argument but the last; at least one is needed. index.json.sig
 * may hold several signatures (one per line): the index is accepted when any
 * of them verifies with any of the keys, as the store does. Exit 0 when it
 * does, 1 otherwise. <dir> may also be an https: base URL (for example the
 * Pages site).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  publicKeyFromPem,
  splitSignatures,
  verifySignature,
} from "./lib/signing.mjs";

async function read(source, name) {
  if (!/^https:\/\//.test(source)) return readFile(join(source, name));
  const url = new URL(name, source.endsWith("/") ? source : `${source}/`);
  const response = await fetch(url, {
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "public-key": { type: "string", multiple: true, default: [] },
    },
  });
  const source = positionals.at(-1);
  const keyFiles = [...values["public-key"], ...positionals.slice(0, -1)];
  if (!source || !keyFiles.length)
    throw new Error(
      "usage: node scripts/verify-index.mjs [--public-key <pem file>]... [<pem file>...] <dir>",
    );
  const keys = await Promise.all(
    keyFiles.map(async (file) => ({
      file,
      key: publicKeyFromPem(await readFile(file, "utf8")),
    })),
  );
  const bytes = await read(source, "index.json");
  const signatures = splitSignatures(
    (await read(source, "index.json.sig")).toString("utf8"),
  );
  const verifiedBy = keys
    .filter(({ key }) =>
      signatures.some((signature) => verifySignature(bytes, signature, key)),
    )
    .map(({ file }) => file);
  if (!verifiedBy.length) {
    console.error(
      `✖ ${source}: no signature in index.json.sig matches index.json with ${keyFiles.join(", ")}`,
    );
    process.exit(1);
  }
  console.log(
    `${source}: signature OK (${signatures.length} signature(s); verified with ${verifiedBy.join(", ")})`,
  );
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
