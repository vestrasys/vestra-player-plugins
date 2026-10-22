#!/usr/bin/env node
/**
 * Generates an Ed25519 key pair for signing index.json.
 *
 *   node scripts/generate-signing-key.mjs <private key file> <public key file>
 *
 * The private key (PKCS8 PEM) is written with mode 600 and never printed;
 * its directory must already exist and must not be inside this repository.
 * Existing files are not overwritten. The public key (SPKI PEM) goes to
 * keys/index-signing.pub.pem; the private key becomes the
 * VESTRA_INDEX_SIGNING_KEY secret of the `plugins-index` environment. For a
 * key rotation (README.md, "Key rotation") the new pair goes to
 * keys/index-signing-next.pub.pem and VESTRA_INDEX_SIGNING_KEY_NEXT.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

try {
  const [privateFile, publicFile] = process.argv
    .slice(2)
    .map((path) => resolve(path));
  if (!privateFile || !publicFile)
    throw new Error(
      "usage: node scripts/generate-signing-key.mjs <private key file> <public key file>",
    );
  const inside = relative(resolve(import.meta.dirname, ".."), privateFile);
  if (!inside.startsWith("..") && !isAbsolute(inside))
    throw new Error(
      "the private key must not be written inside the repository",
    );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  await writeFile(
    privateFile,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    {
      mode: 0o600,
      flag: "wx",
    },
  );
  await writeFile(publicFile, publicPem, { flag: "wx" });
  const fingerprint = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  console.log(`private key: ${privateFile} (mode 600)`);
  console.log(`public key:  ${publicFile}`);
  console.log(`public key sha256 (SPKI DER): ${fingerprint}`);
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
