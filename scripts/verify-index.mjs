#!/usr/bin/env node
/**
 * Verifies <dir>/index.json against <dir>/index.json.sig.
 *
 *   node scripts/verify-index.mjs <public key PEM file> <dir>
 *
 * Exit 0 when the signature is valid, 1 otherwise. <dir> may also be an
 * https: base URL (for example the Pages site).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { publicKeyFromPem, verifyIndex } from "./lib/signing.mjs";

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
  const [keyFile, source] = process.argv.slice(2);
  if (!keyFile || !source)
    throw new Error(
      "usage: node scripts/verify-index.mjs <public key PEM file> <dir>",
    );
  const publicKey = publicKeyFromPem(await readFile(keyFile, "utf8"));
  const bytes = await read(source, "index.json");
  const signature = (await read(source, "index.json.sig")).toString("utf8");
  if (!verifyIndex(bytes, signature, publicKey)) {
    console.error(`✖ ${source}: index.json.sig does not match index.json`);
    process.exit(1);
  }
  console.log(`${source}: signature OK`);
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
