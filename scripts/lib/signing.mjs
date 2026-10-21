/**
 * index.json signatures: Ed25519 over the exact bytes of index.json, stored
 * base64-encoded (no line break) in index.json.sig next to it. Node's
 * built-in crypto only.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

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

/** The contents of index.json.sig for these index.json bytes. */
export function signIndex(bytes, privateKey) {
  return sign(null, bytes, privateKey).toString("base64");
}

/** Whether `signature` (the contents of index.json.sig) signs `bytes`. */
export function verifyIndex(bytes, signature, publicKey) {
  const text = String(signature).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false;
  const raw = Buffer.from(text, "base64");
  if (raw.length !== 64) return false;
  return verify(null, bytes, publicKey, raw);
}
