/**
 * index.json signatures: Ed25519 over the exact bytes of index.json. The
 * signature file index.json.sig next to it holds one or more base64
 * signatures (64 bytes each), one per line, no final line break. It is
 * accepted when any signature verifies with any trusted public key; during a
 * key rotation the index carries one signature per key (CONTRIBUTING.md, "Key
 * rotation"). Node's built-in crypto only.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** The store reads at most this many bytes of index.json.sig. */
export const SIGNATURE_FILE_LIMIT = 1024;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The Ed25519 private key from a PKCS8 PEM string; throws for any other key. */
export function privateKeyFromPem(pem) {
  let key;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    // Never echo the input: it is a secret.
    throw new Error("the signing key is not a readable PKCS8 PEM private key");
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error(`the signing key is ${key.asymmetricKeyType}, not Ed25519`);
  return key;
}

/** The Ed25519 public key from an SPKI PEM string. */
export function publicKeyFromPem(pem) {
  const key = createPublicKey({ key: pem, format: "pem" });
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error(`the public key is ${key.asymmetricKeyType}, not Ed25519`);
  return key;
}

/** SPKI PEM of a key's public half, for comparing keys. */
export function publicPem(key) {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

/**
 * The trusted public keys: every `*.pub.pem` in `directory` (keys/), sorted
 * by file name, as `[{ file, key }]`. Throws when there is none.
 */
export async function readTrustedKeys(directory) {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".pub.pem"))
    .sort();
  if (!names.length) throw new Error(`${directory}: no *.pub.pem key`);
  return Promise.all(
    names.map(async (name) => ({
      file: join(directory, name),
      key: publicKeyFromPem(await readFile(join(directory, name), "utf8")),
    })),
  );
}

/** One base64 signature over these index.json bytes. */
export function signIndex(bytes, privateKey) {
  return sign(null, bytes, privateKey).toString("base64");
}

/** The signatures in the text of index.json.sig (split at white space). */
export const splitSignatures = (text) =>
  String(text).trim().split(/\s+/).filter(Boolean);

/** The text of index.json.sig for these signatures: one per line. */
export const joinSignatures = (signatures) => signatures.join("\n");

const keyList = (keys) => (Array.isArray(keys) ? keys : [keys]);

/** Whether one base64 signature signs `bytes` with one of `keys`. */
export function verifySignature(bytes, signature, keys) {
  if (!BASE64.test(signature)) return false;
  const raw = Buffer.from(signature, "base64");
  if (raw.length !== 64) return false;
  return keyList(keys).some((key) => verify(null, bytes, key, raw));
}

/**
 * Whether `text` (the contents of index.json.sig) signs `bytes`: true when
 * any of its signatures verifies with any of `keys` (one key or an array).
 * Matches the store's `verifyIndex` (src/plugins/store/signing.ts).
 */
export function verifyIndex(bytes, text, keys) {
  return splitSignatures(text).some((signature) =>
    verifySignature(bytes, signature, keys),
  );
}
