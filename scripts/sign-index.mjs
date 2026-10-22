#!/usr/bin/env node
/**
 * Signs <dir>/index.json: writes <dir>/index.json.sig, one base64 Ed25519
 * signature over the exact bytes of index.json per signing key, one per
 * line (no final line break).
 *
 *   VESTRA_INDEX_SIGNING_KEY=<PKCS8 PEM> [VESTRA_INDEX_SIGNING_KEY_NEXT=<PKCS8 PEM>] \
 *     node scripts/sign-index.mjs <dir> [--public-key <pem file>]... [--append]
 *
 * VESTRA_INDEX_SIGNING_KEY is required; VESTRA_INDEX_SIGNING_KEY_NEXT is the
 * second key during a key rotation (CONTRIBUTING.md, "Key rotation"; empty counts
 * as unset). With --public-key (repeatable), refuses to sign unless every
 * signing key belongs to one of those public keys (CI passes keys/*.pub.pem,
 * the keys the player and the store embed). --append keeps the signatures
 * already in index.json.sig, each of which must verify the current
 * index.json with one of the --public-key keys; without it the file is
 * replaced. Private keys are read only from the environment and never
 * printed.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { indexProblems } from "./lib/publishing.mjs";
import {
  joinSignatures,
  privateKeyFromPem,
  publicKeyFromPem,
  publicPem,
  SIGNATURE_FILE_LIMIT,
  signIndex,
  splitSignatures,
  verifySignature,
} from "./lib/signing.mjs";

const SECRETS = ["VESTRA_INDEX_SIGNING_KEY", "VESTRA_INDEX_SIGNING_KEY_NEXT"];

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "public-key": { type: "string", multiple: true, default: [] },
      append: { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1)
    throw new Error(
      "usage: node scripts/sign-index.mjs <dir> [--public-key <pem file>]... [--append]",
    );
  if (!process.env.VESTRA_INDEX_SIGNING_KEY)
    throw new Error("VESTRA_INDEX_SIGNING_KEY is not set");
  const privateKeys = SECRETS.filter((name) => process.env[name]).map(
    (name) => {
      try {
        return { name, key: privateKeyFromPem(process.env[name]) };
      } catch (error) {
        throw new Error(`${name}: ${error.message}`);
      }
    },
  );
  const publicKeys = await Promise.all(
    values["public-key"].map(async (file) => ({
      file,
      key: publicKeyFromPem(await readFile(file, "utf8")),
    })),
  );
  if (publicKeys.length) {
    const allowed = new Set(publicKeys.map(({ key }) => publicPem(key)));
    for (const { name, key } of privateKeys)
      if (!allowed.has(publicPem(key)))
        throw new Error(
          `${name} does not match ${values["public-key"].join(" or ")}`,
        );
  }
  if (
    privateKeys.length === 2 &&
    publicPem(privateKeys[0].key) === publicPem(privateKeys[1].key)
  )
    throw new Error(
      "VESTRA_INDEX_SIGNING_KEY_NEXT is the same key as VESTRA_INDEX_SIGNING_KEY",
    );

  const file = join(positionals[0], "index.json");
  const bytes = await readFile(file);
  const problems = indexProblems(JSON.parse(bytes.toString("utf8")));
  if (problems.length)
    throw new Error(`${file} is invalid:\n  ${problems.join("\n  ")}`);

  const signatures = [];
  if (values.append && existsSync(`${file}.sig`)) {
    if (!publicKeys.length)
      throw new Error(
        "--append needs --public-key to check the existing signatures",
      );
    for (const signature of splitSignatures(
      await readFile(`${file}.sig`, "utf8"),
    )) {
      if (
        !verifySignature(
          bytes,
          signature,
          publicKeys.map(({ key }) => key),
        )
      )
        throw new Error(
          `${file}.sig holds a signature that does not verify index.json with the given public keys; refusing to append`,
        );
      signatures.push(signature);
    }
  }
  for (const { key } of privateKeys) {
    // Ed25519 is deterministic: the same key gives the same signature.
    const signature = signIndex(bytes, key);
    if (!signatures.includes(signature)) signatures.push(signature);
  }
  const text = joinSignatures(signatures);
  if (Buffer.byteLength(text) > SIGNATURE_FILE_LIMIT)
    throw new Error(
      `${signatures.length} signatures exceed the ${SIGNATURE_FILE_LIMIT} bytes the store reads`,
    );
  await writeFile(`${file}.sig`, text);
  console.log(
    `signed ${file} → ${file}.sig (${signatures.length} signature(s); keys: ${privateKeys.map(({ name }) => name).join(", ")})`,
  );
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
