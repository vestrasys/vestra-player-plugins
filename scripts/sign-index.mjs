#!/usr/bin/env node
/**
 * Signs <dir>/index.json: writes <dir>/index.json.sig, the base64 Ed25519
 * signature over the exact bytes of index.json (no line break).
 *
 *   VESTRA_INDEX_SIGNING_KEY=<PKCS8 PEM> node scripts/sign-index.mjs <dir> [--public-key <pem file>]
 *
 * With --public-key, refuses to sign unless the private key belongs to that
 * public key (CI passes keys/index-signing.pub.pem, the key the player and
 * the store embed). The private key is read only from the environment and is
 * never printed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { indexProblems } from "./lib/publishing.mjs";
import {
  privateKeyFromPem,
  publicKeyFromPem,
  publicPem,
  signIndex,
} from "./lib/signing.mjs";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "public-key": { type: "string" } },
  });
  if (positionals.length !== 1)
    throw new Error(
      "usage: node scripts/sign-index.mjs <dir> [--public-key <pem file>]",
    );
  const pem = process.env.VESTRA_INDEX_SIGNING_KEY;
  if (!pem) throw new Error("VESTRA_INDEX_SIGNING_KEY is not set");
  const privateKey = privateKeyFromPem(pem);
  if (values["public-key"]) {
    const expected = publicKeyFromPem(
      await readFile(values["public-key"], "utf8"),
    );
    if (publicPem(privateKey) !== publicPem(expected))
      throw new Error(`the signing key does not match ${values["public-key"]}`);
  }
  const file = join(positionals[0], "index.json");
  const bytes = await readFile(file);
  const problems = indexProblems(JSON.parse(bytes.toString("utf8")));
  if (problems.length)
    throw new Error(`${file} is invalid:\n  ${problems.join("\n  ")}`);
  await writeFile(`${file}.sig`, signIndex(bytes, privateKey));
  console.log(`signed ${file} → ${file}.sig`);
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
